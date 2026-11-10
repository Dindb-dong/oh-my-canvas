import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import * as Y from 'yjs';
import { gzipSync, gunzipSync } from 'node:zlib';
import { Replica } from './replica.mjs';
import * as limits from './document.mjs';
import { AssetStore, assertAsset, collectAssetRefs, assetRef, decodeBase64, extractInlineAssets } from './assets.mjs';
import { atomicWrite, syncDirectory } from './durable-file.mjs';
import { encodeJournalRecord, decodeJournal, appendJournal } from './journal.mjs';

export { atomicWrite } from './durable-file.mjs';
export const validId = id => typeof id === 'string' && /^[a-f0-9-]{36}$/.test(id);
const LOCAL_FORMAT = 'oh-my-canvas-local';
const MAX_PORTABLE_BYTES = limits.MAX_PORTABLE_BYTES ?? 384 * 1024 * 1024;
const MAX_STATE_BYTES = limits.MAX_LARGE_STATE_BYTES ?? limits.MAX_STATE_BYTES;
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
const checksum = data => createHash('sha256').update(data).digest('hex');
const diskWrites = new Map();
const generationReaders = new Map();
const tokenOwner = token => token?.replica instanceof WeakRef ? token.replica.deref() : token?.replica;
const saveToken = captured => ({ replica: new WeakRef(captured.replica), revision: captured.revision });

function assertMetadata(record) {
  if (!record || !validId(record.id) || typeof record.title !== 'string' || !record.title.trim() || record.title.length > 1024) throw Error('Invalid canvas metadata: title or ID');
  for (const field of ['createdAt', 'updatedAt']) if (record[field] !== undefined && (typeof record[field] !== 'string' || record[field].length > 64 || !Number.isFinite(Date.parse(record[field])))) throw Error(`Invalid canvas metadata: ${field}`);
  if (record.thumbnail !== undefined && (typeof record.thumbnail !== 'string' || record.thumbnail.length >= 500000 || !record.thumbnail.startsWith('data:image/'))) throw Error('Invalid canvas metadata: thumbnail');
}

function metadataOf(record, updatedAt = record.updatedAt) {
  return { id: record.id, title: record.title, createdAt: record.createdAt, updatedAt, thumbnail: record.thumbnail };
}
function metadataKey(record) { return JSON.stringify([record.title, record.createdAt, record.thumbnail]); }
function assertHashes(hashes) {
  if (!Array.isArray(hashes) || hashes.length > 100000) throw Error('Invalid retained asset manifest');
  for (const hash of hashes) assetRef(hash);
  return hashes;
}
function dependencies(record) {
  const hashes = new Set([...(record.assetHashes ?? []), ...(record.replica.retainedAssetRefs ?? [])]);
  if (!record.replica.retainedAssetRefs && record.replica.document) collectAssetRefs(record.replica.document, hashes);
  return hashes;
}

export function encodeFile(record) {
  assertMetadata(record);
  const hashes = dependencies(record), assets = {};
  const bytes = record.replica.state;
  const version = hashes.size ? 4 : bytes.byteLength > limits.MAX_STATE_BYTES ? 3 : 2;
  const compressed = version === 3 || version === 4 && bytes.byteLength > limits.MAX_STATE_BYTES;
  const state = Buffer.from(compressed ? gzipSync(bytes) : bytes).toString('base64');
  for (const hash of hashes) {
    const asset = record.assets instanceof Map ? record.assets.get(hash) : record.assets?.[hash];
    if (!asset) throw Error('Portable export requires asset bytes; use Store.export(record)');
    const bytes = asset.bytes ?? decodeBase64(asset.data);
    const descriptor = assertAsset(bytes, asset.mimeType, hash);
    assets[hash] = { mimeType: descriptor.mimeType, byteLength: descriptor.byteLength, data: Buffer.from(bytes).toString('base64') };
  }
  const data = JSON.stringify({ format: 'oh-my-canvas', version, ...metadataOf(record, new Date().toISOString()), sha256: checksum(state), state, ...(version === 4 && compressed ? { stateEncoding: 'gzip' } : {}), ...(hashes.size ? { assets } : {}) });
  if (Buffer.byteLength(data) > MAX_PORTABLE_BYTES) throw Error('Portable file exceeds the storage limit');
  return data;
}

export function decodeFile(data) {
  if (Buffer.byteLength(data) > MAX_PORTABLE_BYTES) throw Error('File exceeds the storage limit');
  const file = JSON.parse(data);
  if (!file || file.format !== 'oh-my-canvas' || ![1, 2, 3, 4].includes(file.version) || !validId(file.id) || typeof file.state !== 'string' || checksum(file.state) !== file.sha256) throw Error('Invalid or damaged Oh My Canvas file');
  if (file.stateEncoding !== undefined && (file.version !== 4 || !['raw','gzip'].includes(file.stateEncoding))) throw Error('Invalid portable state encoding');
  assertMetadata(file);
  const encoded = decodeBase64(file.state, 'CRDT state');
  const state = file.version === 3 || file.version === 4 && file.stateEncoding === 'gzip' ? gunzipSync(encoded, { maxOutputLength: MAX_STATE_BYTES }) : encoded;
  if (state.length > MAX_STATE_BYTES) throw Error('CRDT state exceeds the storage limit');
  const assets = new Map();
  if (file.version === 4) {
    if (!file.assets || typeof file.assets !== 'object' || Array.isArray(file.assets)) throw Error('Invalid portable asset manifest');
    for (const [hash, asset] of Object.entries(file.assets)) {
      assetRef(hash);
      if (!asset || typeof asset !== 'object' || typeof asset.data !== 'string') throw Error('Invalid portable asset');
      const bytes = decodeBase64(asset.data), descriptor = assertAsset(bytes, asset.mimeType, hash);
      if (asset.byteLength !== descriptor.byteLength) throw Error('Invalid portable asset length');
      assets.set(hash, { ...descriptor, bytes });
    }
  }
  let replica;
  try {
    replica = new Replica({ state });
    replica.document;
    for (const hash of replica.retainedAssetRefs) if (!assets.has(hash)) throw Error('Portable file is missing a referenced asset');
    for (const hash of assets.keys()) replica.retainedAssetRefs.add(hash);
    return { ...metadataOf(file), format: file.format, version: file.version, sha256: file.sha256, replica, ...(assets.size ? { assets, assetHashes: [...assets.keys()] } : {}) };
  } catch (error) { replica?.destroy(); throw error; }
}

async function readBounded(file, maximum, encoding) {
  const stat = await fs.stat(file);
  if (!stat.isFile() || stat.size > maximum) throw Error('Stored file exceeds its size limit');
  return fs.readFile(file, encoding);
}

export class Store {
  constructor(directory, { onMetric, checkpointRecords = 128, checkpointBytes = 8 * 1024 * 1024 } = {}) {
    this.dir = directory; this.pending = new Map(); this.saved = new Map(); this.requested = new Map();
    this.onMetric = onMetric; this.checkpointRecords = checkpointRecords; this.checkpointBytes = checkpointBytes;
    this.assets = new AssetStore(path.join(directory, 'assets'), { onMetric: event => this.metric(event) });
  }
  metric(event) { try { this.onMetric?.(event); } catch {} }
  file(id) { if (!validId(id)) throw Error('Invalid document ID'); return path.join(this.dir, `${id}.omc`); }
  generationFiles(id, generation) {
    this.file(id); if (!validId(generation)) throw Error('Invalid checkpoint generation');
    const directory = path.join(this.dir, '.omc-data', id);
    return { state: path.join(directory, `${generation}.state`), journal: path.join(directory, `${generation}.journal`) };
  }
  async prepareDocument(document) {
    const result = extractInlineAssets(document);
    await this.assets.import(result.assets);
    for (const hash of collectAssetRefs(result.document)) if (!result.assets.has(hash)) await this.assets.get(hash);
    return result.document;
  }
  async prepareChanges(changes) {
    if (!Array.isArray(changes)) throw Error('Invalid patch');
    const wrappers = [];
    for (const pair of changes) {
      if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== 'string') throw Error('Invalid patch');
      const parts = limits.fieldParts(pair[0]), field = ['src','dataUrl'].includes(parts.at(-1)) ? parts.at(-1) : 'value';
      wrappers.push({ key: pair[0], field, [field]: pair[1] });
    }
    const result = extractInlineAssets(wrappers);
    await this.assets.import(result.assets);
    for (const hash of collectAssetRefs(result.document)) if (!result.assets.has(hash)) await this.assets.get(hash);
    return result.document.map(item => [item.key, item[item.field]]);
  }
  async importAssets(record) {
    const assets = record.assets;
    if (!assets) return;
    await this.assets.import(assets);
    const hashes = assets instanceof Map ? assets.keys() : Object.keys(assets);
    record.assetHashes = [...new Set([...(record.assetHashes ?? []), ...hashes])];
    // Bytes are durable now; retaining the decoded portable package would keep a
    // second full image collection alive beside the blob store and render cache.
    if (record.assets === assets) delete record.assets;
  }
  async prepareRecord(record) {
    await this.importAssets(record);
    // A join candidate has no document until its first validated peer state.
    if (!record.replica.fields.size) return record;
    for (let attempt = 0; attempt < 8; attempt++) {
      const replica = record.replica, before = replica.document;
      const document = await this.prepareDocument(before);
      // Asset I/O can overlap a collaboration edit. Never apply an obsolete
      // whole asset/library entry over a newer live change.
      if (before !== replica.document) continue;
      const changes = new Map(limits.changesBetween(before, document));
      for (const field of ['assets', 'components', 'styles', 'libraries']) {
        const legacy = JSON.stringify(['meta', field]);
        if (replica.fields.get(legacy) == null) continue;
        // Materialization already resolved per-ID overrides and tombstones.
        // Declare every remaining legacy entry, including inline SVG/font data,
        // before retiring the old aggregate register.
        for (const [id, value] of Object.entries(document[field] ?? {})) {
          const key = JSON.stringify([field, id]);
          if (!limits.same(replica.fields.get(key), value)) changes.set(key, value);
        }
        changes.set(legacy, null);
      }
      if (changes.size) replica.patch([...changes], 'Migrate image assets', undefined, { recordHistory: false });
      return record;
    }
    throw Object.assign(Error('Canvas changed repeatedly while preparing image assets; retry the import'), { code: 'STORE_CONFLICT' });
  }
  async export(record) {
    await this.importAssets(record);
    const state = record.replica.state.slice(), assetHashes = [...dependencies(record)], metadata = metadataOf(record);
    const started = performance.now(), assets = await this.assets.export(assetHashes, { maxBytes: Math.floor(MAX_PORTABLE_BYTES * 3 / 4) });
    const bytes = encodeFile({ ...metadata, replica: { state }, assetHashes, assets });
    this.metric({ stage: 'portable-export', durationMs: performance.now() - started, bytes: Buffer.byteLength(bytes), assetCount: assets.size });
    return bytes;
  }
  async readManifest(id, file = this.file(id)) {
    const data = await readBounded(file, MAX_PORTABLE_BYTES, 'utf8'), parsed = JSON.parse(data);
    if (parsed?.format !== LOCAL_FORMAT) return { legacy: data };
    if (Buffer.byteLength(data) > MAX_MANIFEST_BYTES || parsed.version !== 1 || parsed.id !== id || !validId(parsed.generation) || !parsed.checkpoint || !/^[a-f0-9]{64}$/.test(parsed.checkpoint.sha256) || !Number.isSafeInteger(parsed.checkpoint.bytes) || parsed.checkpoint.bytes < 0 || parsed.checkpoint.bytes > MAX_STATE_BYTES) throw Error('Invalid local canvas manifest');
    assertMetadata(parsed); assertHashes(parsed.assetHashes);
    return { manifest: parsed };
  }
  async readLocal(manifest, { materialize = true } = {}) {
    const key = this.generationFiles(manifest.id, manifest.generation).state;
    generationReaders.set(key, (generationReaders.get(key) ?? 0) + 1);
    try { return await this.readGeneration(manifest, { materialize }); }
    finally {
      const remaining = generationReaders.get(key) - 1;
      if (remaining) generationReaders.set(key, remaining); else generationReaders.delete(key);
    }
  }
  async readGeneration(manifest, { materialize = true } = {}) {
    const files = this.generationFiles(manifest.id, manifest.generation);
    const raw = await readBounded(files.journal, MAX_PORTABLE_BYTES);
    const journal = decodeJournal(raw);
    let metadata = metadataOf(manifest);
    const retainedAssets = new Set(manifest.assetHashes), updates = [];
    for (const record of journal.records) {
      try {
        assertMetadata(record.metadata);
        if (record.metadata.id !== manifest.id || (record.update !== null && typeof record.update !== 'string')) throw Error('journal fields');
        assertHashes(record.assetHashes);
        for (const hash of record.assetHashes) retainedAssets.add(hash);
        metadata = metadataOf(record.metadata);
        if (materialize && record.update !== null) updates.push(decodeBase64(record.update, 'journal update'));
      } catch (error) { throw Object.assign(Error(`Invalid save journal record: ${error.message}`), { code: 'JOURNAL_CORRUPT' }); }
    }
    const details = { manifest, metadata, retainedAssets, journalBytes: journal.validBytes, journalRecords: journal.records.length, sequence: journal.sequence, truncatedBytes: journal.truncatedBytes };
    if (!materialize) return details;
    const state = await readBounded(files.state, MAX_STATE_BYTES);
    if (state.length !== manifest.checkpoint.bytes || checksum(state) !== manifest.checkpoint.sha256) throw Error('Damaged canvas checkpoint');
    const doc = new Y.Doc(); let replica;
    try {
      Y.applyUpdate(doc, state, 'checkpoint');
      try {
        for (const update of updates) Y.applyUpdate(doc, update, 'journal');
        replica = new Replica({ state: Y.encodeStateAsUpdate(doc) });
      } catch (error) {
        if (updates.length) throw Object.assign(Error(`Invalid save journal state: ${error.message}`), { code: 'JOURNAL_CORRUPT' });
        throw error;
      }
      for (const hash of replica.retainedAssetRefs) if (!retainedAssets.has(hash)) throw Error('Canvas asset manifest is incomplete');
      for (const hash of retainedAssets) { await this.assets.get(hash); replica.retainedAssetRefs.add(hash); }
      return { ...details, replica };
    } catch (error) { replica?.destroy(); throw error; }
    finally { doc.destroy(); }
  }
  async load(id) {
    await this.pending.get(id);
    const started = performance.now(), file = this.file(id);
    let result, recovered = false;
    try {
      const source = await this.readManifest(id);
      result = source.legacy ? { legacy: decodeFile(source.legacy) } : await this.readLocal(source.manifest);
    } catch (original) {
      if (original.code === 'JOURNAL_CORRUPT') throw original;
      try {
        const source = await this.readManifest(id, `${file}.bak`);
        result = source.legacy ? { legacy: decodeFile(source.legacy) } : await this.readLocal(source.manifest);
        recovered = true;
      } catch { throw original; }
    }
    if (result.legacy) {
      this.saved.delete(id);
      const record = { ...result.legacy, recovered };
      try {
        await this.prepareRecord(record);
        await this.save(record);
        // Retain the recovery notice for the caller even after durable migration.
        record.recovered = recovered;
        this.metric({ stage: 'store-legacy-migration', durationMs: performance.now() - started, stateBytes: record.replica.state.byteLength });
        return record;
      } catch (error) { record.replica.destroy(); throw error; }
    }
    const { replica, metadata } = result;
    const token = saveToken({ replica, revision: replica.revision }), { replica: _, ...details } = result;
    this.saved.set(id, { ...details, token, metadataKey: metadataKey(metadata), repairedTail: result.truncatedBytes > 0 });
    const record = { ...metadata, replica, assetHashes: [...result.retainedAssets], recovered: recovered || result.truncatedBytes > 0 };
    this.metric({ stage: 'store-load', durationMs: performance.now() - started, checkpointBytes: result.manifest.checkpoint.bytes, journalBytes: result.journalBytes, journalRecords: result.journalRecords, truncatedBytes: result.truncatedBytes });
    return record;
  }
  async save(record) {
    assertMetadata(record);
    const id = record.id, previous = this.saved.get(id), requested = this.requested.get(id)?.deref();
    const needsCheckpoint = !previous || record.recovered || requested && requested !== record.replica || tokenOwner(previous?.token) !== record.replica || previous.journalRecords >= this.checkpointRecords || previous.journalBytes >= this.checkpointBytes;
    const captured = record.replica.captureSince(previous?.token, { full: !!needsCheckpoint });
    const metadata = metadataOf(record, new Date().toISOString()), key = metadataKey(record), assets = record.assets, wasRecovered = !!record.recovered;
    this.requested.set(id, new WeakRef(record.replica));
    const disk = path.resolve(this.file(id));
    const writing = (diskWrites.get(disk) ?? Promise.resolve()).catch(() => {}).then(async () => {
      const started = performance.now(), saved = this.saved.get(id);
      if (!wasRecovered && tokenOwner(saved?.token) === captured.replica && saved.token.revision === captured.revision && saved.metadataKey === key) return;
      if (saved && !wasRecovered) {
        const current = await this.readManifest(id);
        if (current.manifest?.generation !== saved.manifest.generation) throw Object.assign(Error('Canvas changed in another store; reload before saving'), { code: 'STORE_CONFLICT' });
        const journal = this.generationFiles(id, saved.manifest.generation).journal;
        if ((await fs.stat(journal)).size !== saved.journalBytes) throw Object.assign(Error('Canvas journal changed in another writer; reload before saving'), { code: 'STORE_CONFLICT' });
      }
      if (assets) await this.assets.import(assets);
      const retainedAssets = new Set([...(saved?.retainedAssets ?? []), ...captured.assetHashes]);
      for (const hash of retainedAssets) if (!saved?.retainedAssets.has(hash)) await this.assets.get(hash);
      let next;
      if (captured.full || !saved || tokenOwner(saved.token) !== captured.replica) {
        if (!captured.full) throw Error('Persistence baseline changed; retry saving the canvas');
        const generation = randomUUID(), files = this.generationFiles(id, generation), state = Buffer.from(captured.update);
        await atomicWrite(files.state, state, { backup: false });
        await atomicWrite(files.journal, Buffer.alloc(0), { backup: false });
        const manifest = { format: LOCAL_FORMAT, version: 1, ...metadata, generation, checkpoint: { bytes: state.length, sha256: checksum(state) }, assetHashes: [...retainedAssets].sort() };
        const bytes = JSON.stringify(manifest);
        if (Buffer.byteLength(bytes) > MAX_MANIFEST_BYTES) throw Error('Asset manifest exceeds storage limit');
        if (!saved && !wasRecovered) {
          try { await fs.access(this.file(id)); }
          catch (error) { if (error.code !== 'ENOENT') throw error; await atomicWrite(`${this.file(id)}.bak`, bytes, { backup: false }); }
        }
        await atomicWrite(this.file(id), bytes, { backup: !wasRecovered });
        next = { manifest, journalBytes: 0, journalRecords: 0, sequence: 0, retainedAssets };
        this.metric({ stage: 'store-checkpoint', durationMs: performance.now() - started, stateBytes: state.length, manifestBytes: Buffer.byteLength(bytes), assetCount: retainedAssets.size });
      } else {
        const addedAssets = [...retainedAssets].filter(hash => !saved.retainedAssets.has(hash));
        const sequence = saved.sequence + 1;
        const bytes = encodeJournalRecord({ version: 1, sequence, metadata, update: captured.update ? Buffer.from(captured.update).toString('base64') : null, assetHashes: addedAssets });
        const files = this.generationFiles(id, saved.manifest.generation);
        await appendJournal(files.journal, bytes, saved.journalBytes, { repairTail: saved.repairedTail });
        next = { ...saved, journalBytes: saved.journalBytes + bytes.length, journalRecords: saved.journalRecords + 1, sequence, retainedAssets, repairedTail: false };
        this.metric({ stage: 'store-journal', durationMs: performance.now() - started, bytes: bytes.length, updateBytes: captured.update?.byteLength ?? 0, sequence });
      }
      this.saved.set(id, { ...next, metadata, metadataKey: key, token: saveToken(captured) });
      if (captured.full) await this.pruneCheckpoints(id);
    });
    diskWrites.set(disk, writing); this.pending.set(id, writing);
    try { await writing; record.recovered = false; if (record.assets === assets) delete record.assets; }
    finally {
      if (this.pending.get(id) === writing) this.pending.delete(id);
      if (diskWrites.get(disk) === writing) diskWrites.delete(disk);
    }
  }
  async pruneCheckpoints(id) {
    // Only immutable state/journal generations are collected. Asset blobs never
    // are: their reachability also depends on other documents and Undo history.
    try {
      const current = await this.readManifest(id), keep = new Set();
      if (!current.manifest) return;
      keep.add(current.manifest.generation);
      try { const previous = await this.readManifest(id, `${this.file(id)}.bak`); if (previous.manifest) keep.add(previous.manifest.generation); }
      catch (error) { if (error.code !== 'ENOENT') return; }
      const directory = path.dirname(this.generationFiles(id, current.manifest.generation).state);
      let removed = false;
      for (const name of await fs.readdir(directory)) {
        const match = /^([a-f0-9-]{36})\.(state|journal)$/.exec(name);
        if (!match || keep.has(match[1]) || generationReaders.has(this.generationFiles(id, match[1]).state)) continue;
        await fs.rm(path.join(directory, name), { force: true }); removed = true;
      }
      if (removed) await syncDirectory(directory);
    } catch (error) { this.metric({ stage: 'checkpoint-cleanup-deferred', reason: error.code ?? error.message }); }
  }
  async list() {
    if(this.listing)return this.listing;
    this.listing=this.readList();
    try{return await this.listing;}finally{this.listing=null;}
  }
  async readList() {
    await fs.mkdir(this.dir, { recursive: true });
    const items = [];
    for (const name of await fs.readdir(this.dir)) {
      if (!name.endsWith('.omc') || !validId(name.slice(0, -4))) continue;
      const id = name.slice(0, -4); await this.pending.get(id);
      try {
        const source = await this.readManifest(id);
        if (source.legacy) {
          const record = decodeFile(source.legacy);
          items.push({ ...metadataOf(record), recovered: false }); record.replica.destroy();
        } else {
          const result = await this.readLocal(source.manifest, { materialize: false });
          items.push({ ...result.metadata, recovered: result.truncatedBytes > 0 });
        }
      } catch { items.push({ id, title: 'Damaged document', damaged: true }); }
    }
    return items.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  }
  async remove(id) {
    await this.pending.get(id); this.saved.delete(id); this.requested.delete(id);
    await fs.rm(this.file(id), { force: true }); await fs.rm(`${this.file(id)}.bak`, { force: true });
    await fs.rm(path.join(this.dir, '.omc-data', id), { recursive: true, force: true });
    // Assets remain: safe GC must account for documents, Undo and in-flight work.
  }
}
