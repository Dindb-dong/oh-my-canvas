import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { atomicWrite } from './durable-file.mjs';
import { assetRef, parseAssetRef, collectAssetRefs } from './asset-refs.mjs';

export { assetRef, parseAssetRef, collectAssetRefs } from './asset-refs.mjs';
export const MAX_ASSET_BYTES = 64 * 1024 * 1024;
const TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/bmp', 'image/x-icon', 'image/vnd.microsoft.icon']);
export const hashAsset = bytes => createHash('sha256').update(bytes).digest('hex');

export function decodeBase64(value, label = 'asset') {
  // Repeated-group regular expressions can exhaust the regexp stack on images.
  if (typeof value !== 'string' || value.length % 4 || /[^A-Za-z0-9+/=]/.test(value) || /=/.test(value.slice(0, -2))) throw Error(`Invalid base64 ${label}`);
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value) throw Error(`Non-canonical base64 ${label}`);
  return bytes;
}

export function assertAsset(bytes, mimeType, expectedHash) {
  mimeType = mimeType === 'image/jpg' ? 'image/jpeg' : mimeType;
  if (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) throw Error('Invalid asset bytes');
  if (!bytes.byteLength || bytes.byteLength > MAX_ASSET_BYTES) throw Error('Asset exceeds the 64 MiB limit or is empty');
  if (!TYPES.has(mimeType)) throw Error('Unsupported external asset MIME type');
  const hash = hashAsset(bytes);
  if (expectedHash !== undefined && expectedHash !== hash) throw Error('Asset SHA-256 mismatch');
  return { hash, src: assetRef(hash), mimeType, byteLength: bytes.byteLength };
}

// Copy only paths that actually change. Legacy SVG and font resources remain
// embedded until their dedicated decoders/transport have the same contract.
export function extractInlineAssets(input) {
  const assets = new Map(), sources = new Map(), active = new WeakSet();
  function visit(value, field) {
    if (typeof value === 'string') {
      parseAssetRef(value); // Refuse malformed canonical references early.
      if (field !== 'src' && field !== 'dataUrl') return value;
      if (sources.has(value)) return sources.get(value);
      const match = /^data:(image\/[a-z0-9.+-]+);base64,([\s\S]*)$/i.exec(value);
      const mimeType = match?.[1].toLowerCase().replace(/^image\/jpg$/, 'image/jpeg');
      if (!match || !TYPES.has(mimeType)) return value;
      if (match[2].length > Math.ceil(MAX_ASSET_BYTES / 3) * 4) throw Error('Asset exceeds the 64 MiB limit');
      const bytes = decodeBase64(match[2]);
      const descriptor = assertAsset(bytes, mimeType);
      const existing = assets.get(descriptor.hash);
      if (existing && existing.mimeType !== mimeType) throw Error('Conflicting MIME types for the same asset');
      assets.set(descriptor.hash, { ...descriptor, bytes });
      sources.set(value, descriptor.src);
      return descriptor.src;
    }
    if (!value || typeof value !== 'object') return value;
    if (active.has(value)) throw Error('Cyclic document asset data');
    active.add(value);
    let result = value;
    for (const [key, item] of Object.entries(value)) {
      const next = visit(item, key);
      if (next !== item) {
        if (result === value) result = Array.isArray(value) ? value.slice() : { ...value };
        // defineProperty also keeps untrusted __proto__ keys inert.
        Object.defineProperty(result, key, { value: next, enumerable: true, configurable: true, writable: true });
      }
    }
    active.delete(value);
    return result;
  }
  return { document: visit(input), assets };
}

export class AssetStore {
  constructor(directory, { onMetric } = {}) {
    this.directory = directory;
    this.onMetric = onMetric;
    this.pending = new Map();
  }
  file(hash) {
    assetRef(hash);
    return path.join(this.directory, hash.slice(0, 2), hash);
  }
  async get(hash) {
    const file = this.file(hash);
    const [bytes, descriptor] = await Promise.all([fs.readFile(file), this.describe(hash)]);
    const actual = assertAsset(bytes, descriptor.mimeType, hash);
    if (descriptor.hash !== hash || descriptor.byteLength !== bytes.length) throw Error('Invalid asset metadata');
    return { ...actual, bytes };
  }
  async describe(hash) {
    const file = this.file(hash), metadata = `${file}.json`;
    const [blob, info] = await Promise.all([fs.stat(file), fs.stat(metadata)]);
    if (!blob.isFile() || !info.isFile() || info.size > 4096) throw Error('Invalid asset metadata');
    const descriptor = JSON.parse(await fs.readFile(metadata, 'utf8'));
    if (descriptor?.hash !== hash || !TYPES.has(descriptor.mimeType) || !Number.isSafeInteger(descriptor.byteLength) || descriptor.byteLength <= 0 || descriptor.byteLength > MAX_ASSET_BYTES || descriptor.byteLength !== blob.size) throw Error('Invalid asset metadata');
    return { hash, src: assetRef(hash), mimeType: descriptor.mimeType, byteLength: descriptor.byteLength };
  }
  async has(hash) {
    try { await this.get(hash); return true; }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  }
  async put(input, mimeType, { hash: expectedHash } = {}) {
    // Capture caller-owned byte buffers before any await.
    const bytes = Buffer.from(input), descriptor = assertAsset(bytes, mimeType, expectedHash);
    const { hash } = descriptor, previous = this.pending.get(hash) ?? Promise.resolve();
    const writing = previous.catch(() => {}).then(async () => {
      const started = performance.now(), file = this.file(hash);
      try {
        const existing = await this.get(hash);
        if (existing.mimeType !== descriptor.mimeType) throw Error('Conflicting MIME types for the same asset');
        return descriptor;
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      await atomicWrite(file, bytes, { backup: false });
      await atomicWrite(`${file}.json`, JSON.stringify(descriptor), { backup: false });
      this.onMetric?.({ stage: 'asset-write', durationMs: performance.now() - started, bytes: bytes.length, hash });
      return descriptor;
    });
    this.pending.set(hash, writing);
    try { return await writing; }
    finally { if (this.pending.get(hash) === writing) this.pending.delete(hash); }
  }
  async import(assets) {
    for (const [hash, asset] of assets instanceof Map ? assets : Object.entries(assets ?? {})) {
      await this.put(asset.bytes ?? decodeBase64(asset.data), asset.mimeType, { hash });
    }
  }
  async export(hashes, { maxBytes = Infinity } = {}) {
    if (typeof maxBytes !== 'number' || Number.isNaN(maxBytes) || maxBytes < 0) throw Error('Invalid asset export byte limit');
    const requested = [...hashes]; let total = 0;
    // Resolve every descriptor before allocating any bitmap payload. A valid
    // document can retain far more historical blobs than one portable package.
    for (const hash of requested) {
      total += (await this.describe(hash)).byteLength;
      if (total > maxBytes) throw Error('Portable image assets exceed the storage limit');
    }
    const assets = new Map();
    for (const hash of requested) assets.set(hash, await this.get(hash));
    return assets;
  }
}
