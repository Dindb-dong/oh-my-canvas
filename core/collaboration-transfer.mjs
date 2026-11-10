import { createHash, randomUUID } from 'node:crypto';
import * as Y from 'yjs';
import { WebSocket } from 'ws';
import { assetRef, collectAssetRefs, decodeBase64 } from './assets.mjs';

// Transport budgets intentionally do not import document/storage capacities.
export const COLLAB_FRAME_BYTES = 1024 * 1024;
export const COLLAB_CHUNK_BYTES = 192 * 1024;
export const COLLAB_STATE_BYTES = 256 * 1024 * 1024;
export const COLLAB_ASSET_BYTES = 64 * 1024 * 1024;
export const COLLAB_TRANSFER_BYTES = 384 * 1024 * 1024;
export const COLLAB_BUFFER_BYTES = 8 * 1024 * 1024;
export const COLLAB_ASSET_COUNT = 4096;
export const COLLAB_PROTOCOL_VERSION = 3;
const ID = /^[a-f0-9-]{36}$/;
const HASH = /^[a-f0-9]{64}$/;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const timeoutMs = 60000;

export function assetRefsInUpdate(update) {
  const refs = new Set();
  for (const item of Y.decodeUpdate(update).structs) {
    for (const value of item.content?.getContent?.() ?? []) collectAssetRefs(value, refs);
  }
  return refs;
}

export class CollaborationTransfer {
  constructor({ ws, replica, assets, persist, applyUpdate, onApply, onError, onMetric, budget = { used: 0 } }) {
    Object.assign(this, { ws, replica, assets, persist, applyUpdate, onApply, onError, onMetric, budget });
    this.queue = []; this.queuedBytes = 0; this.queuedReads = 0; this.reading = Promise.resolve(); this.closed = false;
  }
  metric(event) { try { this.onMetric?.(event); } catch {} }
  read(raw, handler) {
    if (this.closed) return;
    const size = raw.byteLength;
    if (size > COLLAB_FRAME_BYTES || (this.queuedReads += size) > COLLAB_BUFFER_BYTES) return this.fail(Error('Collaboration frame/buffer limit exceeded'));
    if (this.queuedReads > COLLAB_FRAME_BYTES * 2) this.ws.pause();
    this.reading = this.reading.then(async () => {
      if (this.closed) return;
      const message = JSON.parse(raw.toString());
      if (!message || typeof message !== 'object' || typeof message.type !== 'string') throw Error('Invalid collaboration message');
      await handler(message);
    }).catch(error => this.fail(error)).finally(() => {
      this.queuedReads -= size;
      if (!this.closed && this.queuedReads < COLLAB_FRAME_BYTES) this.ws.resume();
    });
  }
  async send(message) {
    if (this.closed || this.ws.readyState !== WebSocket.OPEN) throw Error('Collaboration connection closed');
    const text = JSON.stringify(message), bytes = Buffer.byteLength(text);
    if (bytes > COLLAB_FRAME_BYTES || this.ws.bufferedAmount > COLLAB_BUFFER_BYTES) throw Error('Collaboration send buffer limit exceeded');
    this.metric({ stage: 'collaboration-frame', bytes, type: message.type });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('Collaboration send timed out')), timeoutMs);
      this.ws.send(text, error => { clearTimeout(timer); error ? reject(error) : resolve(); });
    });
  }
  sendUpdate(input, metadata = {}) {
    if (this.closed) return Promise.reject(Error('Collaboration connection closed'));
    if (!(input instanceof Uint8Array) || input.byteLength > COLLAB_STATE_BYTES) return Promise.reject(Error('Collaboration state exceeds transfer limit'));
    const update = input.slice();
    return new Promise((resolve, reject) => {
      const last = this.queue.at(-1);
      if (last && !metadata.welcome && !last.metadata.welcome) {
        const merged = Y.mergeUpdates([last.update, update]);
        this.queuedBytes += merged.byteLength - last.update.byteLength; last.update = merged; last.waiters.push({ resolve, reject });
      } else {
        this.queue.push({ update, metadata, waiters: [{ resolve, reject }] }); this.queuedBytes += update.byteLength;
      }
      if (this.queuedBytes > COLLAB_STATE_BYTES || this.queue.reduce((n, job) => n + job.waiters.length, 0) > 1024) this.fail(Error('Collaboration pending update limit exceeded'));
      else this.pump();
    });
  }
  async pump() {
    if (this.sending || this.closed) return;
    this.sending = true;
    try {
      while (this.queue.length && !this.closed) {
        const job = this.queue.shift(); this.queuedBytes -= job.update.byteLength; this.job = job;
        try { await this.transfer(job); for (const waiter of job.waiters) waiter.resolve(); }
        catch (error) { for (const waiter of job.waiters) waiter.reject(error); throw error; }
        finally { this.job = null; }
      }
    } catch (error) { this.fail(error); }
    finally { this.sending = false; }
  }
  waitFor(type, hash = '') {
    const key = type + hash;
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.outgoing?.waits.delete(key); reject(Error('Collaboration transfer timed out')); }, timeoutMs);
      this.outgoing.waits.set(key, { resolve, reject, timer });
    });
    promise.catch(() => {}); // A send can fail before its corresponding await.
    return promise;
  }
  receipt(message, type, hash = '') {
    if (!this.outgoing || message.id !== this.outgoing.id) throw Error('Unexpected transfer receipt');
    const key = type + hash, wait = this.outgoing.waits.get(key);
    if (!wait) throw Error('Unexpected transfer receipt order');
    clearTimeout(wait.timer); this.outgoing.waits.delete(key); wait.resolve(message);
  }
  async transfer(job) {
    const refs = assetRefsInUpdate(job.update), assets = [];
    if (refs.size > COLLAB_ASSET_COUNT) throw Error('Too many collaboration asset dependencies');
    if (refs.size && !this.assets) throw Error('An asset store is required to share this canvas');
    let total = job.update.byteLength;
    for (const hash of refs) {
      const descriptor = await this.assets.describe(hash);
      if ((total += descriptor.byteLength) > COLLAB_TRANSFER_BYTES) throw Error('Collaboration transfer exceeds aggregate byte limit');
      assets.push({ hash, mimeType: descriptor.mimeType, byteLength: descriptor.byteLength });
    }
    const id = randomUUID(); this.outgoing = { id, waits: new Map() };
    await this.send({ type: 'state-start', id, bytes: job.update.byteLength, sha256: digest(job.update), assets, ...job.metadata });
    for (let offset = 0; offset < job.update.byteLength; offset += COLLAB_CHUNK_BYTES) {
      await this.send({ type: 'state-chunk', id, offset, data: Buffer.from(job.update.subarray(offset, offset + COLLAB_CHUNK_BYTES)).toString('base64') });
    }
    const needing = this.waitFor('state-need'); await this.send({ type: 'state-end', id });
    const { hashes } = await needing;
    if (!Array.isArray(hashes) || hashes.length > refs.size || new Set(hashes).size !== hashes.length || hashes.some(hash => !refs.has(hash))) throw Error('Invalid requested asset dependencies');
    for (const hash of hashes) {
      const asset = await this.assets.get(hash);
      await this.send({ type: 'asset-start', id, hash });
      for (let offset = 0; offset < asset.bytes.length; offset += COLLAB_CHUNK_BYTES) {
        await this.send({ type: 'asset-chunk', id, hash, offset, data: asset.bytes.subarray(offset, offset + COLLAB_CHUNK_BYTES).toString('base64') });
      }
      const stored = this.waitFor('asset-stored', hash); await this.send({ type: 'asset-end', id, hash }); await stored;
    }
    const applied = this.waitFor('state-applied'); await this.send({ type: 'state-commit', id }); await applied;
    this.outgoing = null;
    this.metric({ stage: 'collaboration-update', stateBytes: job.update.byteLength, dependencyCount: refs.size, transferredAssets: hashes.length });
  }
  touch() {
    if (!this.incoming) return;
    clearTimeout(this.incoming.timer);
    this.incoming.timer = setTimeout(() => this.fail(Error('Incomplete collaboration transfer timed out')), timeoutMs);
  }
  reserve(bytes) {
    if (this.budget.used + bytes > COLLAB_TRANSFER_BYTES) throw Error('Concurrent collaboration transfer budget exceeded');
    this.budget.used += bytes;
  }
  releaseIncoming() {
    if (!this.incoming) return;
    clearTimeout(this.incoming.timer);
    this.budget.used -= this.incoming.bytes + (this.incoming.asset?.descriptor.byteLength ?? 0);
    this.incoming = null;
  }
  chunk(message, target) {
    if (!Number.isSafeInteger(message.offset) || message.offset !== target.offset || typeof message.data !== 'string' || message.data.length > Math.ceil(COLLAB_CHUNK_BYTES / 3) * 4) throw Error('Invalid collaboration chunk');
    const bytes = decodeBase64(message.data, 'collaboration chunk');
    if (!bytes.length || target.offset + bytes.length > target.bytes.length) throw Error('Collaboration chunk exceeds declared length');
    bytes.copy(target.bytes, target.offset); target.offset += bytes.length;
  }
  async handle(message) {
    if (message.type === 'state-need') { this.receipt(message, 'state-need'); return true; }
    if (message.type === 'asset-stored') { this.receipt(message, 'asset-stored', message.hash); return true; }
    if (message.type === 'state-applied') { this.receipt(message, 'state-applied'); return true; }
    if (message.type === 'state-start') {
      if (this.incoming || !ID.test(message.id) || !Number.isSafeInteger(message.bytes) || message.bytes <= 0 || message.bytes > COLLAB_STATE_BYTES || !HASH.test(message.sha256) || !Array.isArray(message.assets) || message.assets.length > COLLAB_ASSET_COUNT) throw Error('Invalid collaboration transfer declaration');
      let total = message.bytes; const descriptors = new Map();
      for (const asset of message.assets) {
        assetRef(asset?.hash);
        if (descriptors.has(asset.hash) || typeof asset.mimeType !== 'string' || asset.mimeType.length > 100 || !Number.isSafeInteger(asset.byteLength) || asset.byteLength <= 0 || asset.byteLength > COLLAB_ASSET_BYTES || (total += asset.byteLength) > COLLAB_TRANSFER_BYTES) throw Error('Invalid collaboration asset declaration');
        descriptors.set(asset.hash, asset);
      }
      this.reserve(message.bytes);
      this.incoming = { id: message.id, bytes: message.bytes, sha256: message.sha256, descriptors, state: null, phase: 'state', welcome: message.welcome };
      this.touch(); return true;
    }
    if (!['state-chunk', 'state-end', 'asset-start', 'asset-chunk', 'asset-end', 'state-commit'].includes(message.type)) return false;
    const transfer = this.incoming;
    if (!transfer || transfer.id !== message.id) throw Error('Unknown collaboration transfer');
    this.touch();
    if (message.type === 'state-chunk') {
      if (transfer.phase !== 'state') throw Error('Unexpected state chunk');
      transfer.state ??= { bytes: Buffer.allocUnsafe(transfer.bytes), offset: 0 };
      this.chunk(message, transfer.state); return true;
    }
    if (message.type === 'state-end') {
      if (transfer.phase !== 'state' || transfer.state?.offset !== transfer.bytes || digest(transfer.state.bytes) !== transfer.sha256) throw Error('Collaboration state checksum/length mismatch');
      const refs = assetRefsInUpdate(transfer.state.bytes);
      if (refs.size !== transfer.descriptors.size || [...refs].some(hash => !transfer.descriptors.has(hash))) throw Error('Collaboration asset declaration does not match state references');
      if (refs.size && !this.assets) throw Error('An asset store is required to receive this canvas');
      transfer.missing = new Set();
      for (const hash of refs) {
        try {
          const existing = await this.assets.get(hash), descriptor = transfer.descriptors.get(hash);
          if (existing.mimeType !== descriptor.mimeType || existing.byteLength !== descriptor.byteLength) throw Error('Collaboration asset metadata mismatch');
        } catch (error) { if (error.code === 'ENOENT') transfer.missing.add(hash); else throw error; }
      }
      transfer.phase = 'assets'; await this.send({ type: 'state-need', id: transfer.id, hashes: [...transfer.missing] }); return true;
    }
    if (message.type === 'asset-start') {
      if (transfer.phase !== 'assets' || transfer.asset || !transfer.missing.has(message.hash)) throw Error('Unexpected asset transfer');
      const descriptor = transfer.descriptors.get(message.hash); this.reserve(descriptor.byteLength);
      transfer.asset = { descriptor, bytes: Buffer.allocUnsafe(descriptor.byteLength), offset: 0 }; return true;
    }
    if (message.type === 'asset-chunk') {
      if (!transfer.asset || transfer.asset.descriptor.hash !== message.hash) throw Error('Unexpected asset chunk');
      this.chunk(message, transfer.asset); return true;
    }
    if (message.type === 'asset-end') {
      const asset = transfer.asset;
      if (!asset || asset.descriptor.hash !== message.hash || asset.offset !== asset.bytes.length || digest(asset.bytes) !== message.hash) throw Error('Collaboration asset checksum/length mismatch');
      await this.assets.put(asset.bytes, asset.descriptor.mimeType, { hash: message.hash });
      if (this.closed) return true;
      transfer.missing.delete(message.hash); this.budget.used -= asset.descriptor.byteLength; transfer.asset = null;
      await this.send({ type: 'asset-stored', id: transfer.id, hash: message.hash }); return true;
    }
    if (transfer.phase !== 'assets' || transfer.asset || transfer.missing.size) throw Error('Referenced assets have not been durably stored');
    const update = transfer.state.bytes, welcome = transfer.welcome, id = transfer.id;
    if (this.applyUpdate) this.applyUpdate(update); else this.replica.receive(update);
    await this.persist?.();
    if (this.closed) return true;
    this.releaseIncoming();
    await this.send({ type: 'state-applied', id });
    await this.onApply?.({ welcome });
    return true;
  }
  fail(error) {
    if (this.closed) return;
    try { this.onError?.(error); } catch {}
    this.dispose(error); this.ws.close(1008, 'Invalid or incomplete collaboration transfer');
  }
  dispose(error = Error('Collaboration connection closed')) {
    if (this.closed) return;
    this.closed = true; this.releaseIncoming();
    for (const wait of this.outgoing?.waits.values() ?? []) { clearTimeout(wait.timer); wait.reject(error); }
    this.outgoing = null;
    for (const job of this.queue) for (const waiter of job.waiters) waiter.reject(error);
    this.queue = []; this.queuedBytes = 0;
  }
}
