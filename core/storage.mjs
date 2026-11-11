import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { gzipSync, gunzipSync } from 'node:zlib';
import { Replica } from './replica.mjs';
import * as limits from './document.mjs';
import { AssetStore, assertAsset, collectAssetRefs, assetRef, decodeBase64, extractInlineAssets } from './assets.mjs';
import { atomicWrite, syncDirectory } from './durable-file.mjs';
import { encodeJournalRecord, decodeJournal, appendJournal } from './journal.mjs';
import { capturePreview, serializePreview, encodePreview, decodePreview, matchingPreviewTokens, previewSignature, samePreviewSignature, previewSource, restorePreviewSource, MAX_PREVIEW_BYTES, MAX_PREVIEW_JOURNAL_BYTES } from './preview-cache.mjs';

export { atomicWrite } from './durable-file.mjs';
export const validId = id => typeof id === 'string' && /^[a-f0-9-]{36}$/.test(id);
const LOCAL_FORMAT = 'oh-my-canvas-local';
const MAX_PORTABLE_BYTES = limits.MAX_PORTABLE_BYTES ?? 384 * 1024 * 1024;
const MAX_STATE_BYTES = limits.MAX_LARGE_STATE_BYTES ?? limits.MAX_STATE_BYTES;
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
const checksum = data => createHash('sha256').update(data).digest('hex');
const diskWrites = new Map();
const generationReaders = new Map();
const loadedPreviewOwners = new WeakMap();
const tokenOwner = token => token?.replica instanceof WeakRef ? token.replica.deref() : token?.replica;
const saveToken = captured => ({ replica: new WeakRef(captured.replica), revision: captured.revision });
const turn = () => new Promise(resolve => setImmediate(resolve));
const MAX_PREVIEW_BODY_CACHE_BYTES = 32 * 1024 * 1024;

function assertImportStatus(status) {
  if (status === undefined) return;
  const keys = ['kind', 'state', 'totalPages', 'loadedPages', 'pages', 'error'];
  if (!status || typeof status !== 'object' || Array.isArray(status) || Object.keys(status).some(key => !keys.includes(key)) ||
      !['fig', 'sketch', 'json', 'omc'].includes(status.kind) || !['loading', 'complete', 'interrupted', 'failed', 'cancelled'].includes(status.state) ||
      !Number.isSafeInteger(status.totalPages) || status.totalPages < 1 || status.totalPages > 100 ||
      !Number.isSafeInteger(status.loadedPages) || status.loadedPages < 0 || status.loadedPages > status.totalPages ||
      status.state === 'complete' && status.loadedPages !== status.totalPages ||
      !Array.isArray(status.pages) || status.pages.length !== status.totalPages ||
      status.error !== undefined && (typeof status.error !== 'string' || status.error.length > 1024)) throw Error('Invalid canvas metadata: importStatus');
  const ids = new Set();
  for (const page of status.pages) {
    if (!page || typeof page !== 'object' || Object.keys(page).some(key => !['id', 'name'].includes(key)) ||
        typeof page.id !== 'string' || !page.id || page.id.length > 1024 || ['__proto__', 'constructor', 'prototype'].includes(page.id) || ids.has(page.id) ||
        typeof page.name !== 'string' || page.name.length > 1024) throw Error('Invalid canvas metadata: importStatus pages');
    ids.add(page.id);
  }
}

function copyImportStatus(status) {
  return status === undefined ? undefined : { ...status, pages: status.pages.map(page => ({ id: page.id, name: page.name })) };
}
function openedMetadata(metadata) {
  const result = metadataOf(metadata);
  if (result.importStatus?.state === 'loading') result.importStatus.state = 'interrupted';
  return result;
}
function assertImportProgress(record, document) {
  const status = record.importStatus;
  if (status?.state === 'loading' && (document.pages.length !== status.loadedPages || document.pages.some((id, index) => id !== status.pages[index]?.id))) throw Error('Invalid canvas metadata: importStatus does not match loaded pages');
}
function previewToken(details, source = 'primary') {
  return { id: details.manifest.id, generation: details.manifest.generation, checkpointSha256: details.manifest.checkpoint.sha256,
    manifestSha256: checksum(JSON.stringify(details.manifest)), journalSequence: details.sequence, journalBytes: details.journalBytes,
    journalSha256: details.journalHash.copy().digest('hex'), source };
}
function markLoadedPreview(record, token) {
  record.loadedPreviewToken = Object.freeze(token);
  loadedPreviewOwners.set(record, { replica: new WeakRef(record.replica), revision: record.replica.revision });
  return record;
}
function journalRecordUpperBound(captured, metadata) {
  // All captured hashes bound the newly added subset, and the largest safe
  // sequence bounds its eventual queued value. Base64 contains no JSON escapes.
  const envelope = { version: 1, sequence: Number.MAX_SAFE_INTEGER, metadata, update: null, assetHashes: captured.assetHashes };
  return 36 + Buffer.byteLength(JSON.stringify(envelope)) + (captured.update ? 4 * Math.ceil(captured.update.byteLength / 3) + 2 : 0);
}

function assertMetadata(record) {
  if (!record || !validId(record.id) || typeof record.title !== 'string' || !record.title.trim() || record.title.length > 1024) throw Error('Invalid canvas metadata: title or ID');
  for (const field of ['createdAt', 'updatedAt']) if (record[field] !== undefined && (typeof record[field] !== 'string' || record[field].length > 64 || !Number.isFinite(Date.parse(record[field])))) throw Error(`Invalid canvas metadata: ${field}`);
  if (record.thumbnail !== undefined && (typeof record.thumbnail !== 'string' || record.thumbnail.length >= 500000 || !record.thumbnail.startsWith('data:image/'))) throw Error('Invalid canvas metadata: thumbnail');
  assertImportStatus(record.importStatus);
}

function metadataOf(record, updatedAt = record.updatedAt) {
  return { id: record.id, title: record.title, createdAt: record.createdAt, updatedAt, thumbnail: record.thumbnail,
    ...(record.importStatus === undefined ? {} : { importStatus: copyImportStatus(record.importStatus) }) };
}
function metadataKey(record) { return JSON.stringify([record.title, record.createdAt, record.thumbnail, record.importStatus]); }
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
    assertImportProgress(file, replica.document);
    return { ...openedMetadata(file), format: file.format, version: file.version, sha256: file.sha256, replica, ...(assets.size ? { assets, assetHashes: [...assets.keys()] } : {}) };
  } catch (error) { replica?.destroy(); throw error; }
}

async function readBounded(file, maximum, encoding) {
  const stat = await fs.stat(file);
  if (!stat.isFile() || stat.size > maximum) throw Error('Stored file exceeds its size limit');
  const data = await fs.readFile(file, encoding);
  if (Buffer.byteLength(data) > maximum) throw Error('Stored file exceeds its size limit');
  return data;
}

export class Store {
  constructor(directory, { onMetric, checkpointRecords = 128, checkpointBytes = 8 * 1024 * 1024, journalLimitBytes = MAX_PORTABLE_BYTES } = {}) {
    if (!Number.isSafeInteger(journalLimitBytes) || journalLimitBytes < 1 || journalLimitBytes > MAX_PORTABLE_BYTES) throw Error('Invalid journal storage limit');
    this.dir = directory; this.pending = new Map(); this.saved = new Map(); this.requested = new Map();
    this.previewJobs = new Map(); this.previewBodies = new Map(); this.previewBodyBytes = 0; this.previewWriter = Promise.resolve();
    this.journalReservations = new Map(); this.journalLimitBytes = journalLimitBytes;
    this.onMetric = onMetric; this.checkpointRecords = checkpointRecords; this.checkpointBytes = checkpointBytes;
    this.assets = new AssetStore(path.join(directory, 'assets'), { onMetric: event => this.metric(event) });
  }
  metric(event) { try { this.onMetric?.(event); } catch {} }
  file(id) { if (!validId(id)) throw Error('Invalid document ID'); return path.join(this.dir, `${id}.omc`); }
  generationFiles(id, generation) {
    this.file(id); if (!validId(generation)) throw Error('Invalid checkpoint generation');
    const directory = path.join(this.dir, '.omc-data', id);
    return { state: path.join(directory, `${generation}.state`), journal: path.join(directory, `${generation}.journal`), preview: path.join(directory, `${generation}.preview`) };
  }
  previewMatches(record, token) {
    const loaded = loadedPreviewOwners.get(record);
    return !!loaded && loaded.replica.deref() === record.replica && loaded.revision === record.replica.revision && matchingPreviewTokens(record.loadedPreviewToken, token);
  }
  cachePreviewBody(id, projection) {
    let cached = this.previewBodies.get(id);
    if (cached && samePreviewSignature(cached.signature, projection.document)) {
      this.previewBodies.delete(id); this.previewBodies.set(id, cached);
      return cached.serialized;
    }
    const serialized = serializePreview(projection);
    this.dropPreviewBody(id);
    cached = { serialized, signature: previewSignature(projection.document) };
    this.previewBodies.set(id, cached); this.previewBodyBytes += serialized.body.length;
    while (this.previewBodies.size > 8 || this.previewBodyBytes > MAX_PREVIEW_BODY_CACHE_BYTES) this.dropPreviewBody(this.previewBodies.keys().next().value);
    return serialized;
  }
  dropPreviewBody(id) {
    const previous = this.previewBodies.get(id);
    if (previous) { this.previewBodyBytes -= previous.serialized.body.length; this.previewBodies.delete(id); }
  }
  schedulePreview(id, projection, details) {
    // Capture after durability, but never put optional serialization or I/O on
    // the save ACK path. Later saves supersede an unstarted cache refresh.
    const request = { source: previewSource(projection), token: previewToken(details) }, existing = this.previewJobs.get(id);
    if (existing) { existing.request = request; return; }
    if (this.previewJobs.size >= 8) return;
    const job = { request, promise: null };
    this.previewJobs.set(id, job);
    job.promise = this.previewWriter.catch(() => {}).then(async () => {
      await turn();
      while (job.request) {
        const next = job.request; job.request = null;
        const projection = restorePreviewSource(next.source);
        if (projection) {
          const saved = this.saved.get(id);
          if (saved && matchingPreviewTokens(next.token, previewToken(saved))) {
            const files = this.generationFiles(id, next.token.generation), key = files.state;
            generationReaders.set(key, (generationReaders.get(key) ?? 0) + 1);
            try {
              const started = performance.now(), serialized = this.cachePreviewBody(id, projection);
              await atomicWrite(files.preview, encodePreview(projection, next.token, serialized), { backup: false });
              this.metric({ stage: 'store-preview', durationMs: performance.now() - started, bytes: serialized.body.length, pageCount: projection.pages.length });
            } catch (error) {
              this.dropPreviewBody(id);
              this.metric({ stage: 'store-preview-deferred', reason: error.code ?? error.message });
            } finally {
              const remaining = generationReaders.get(key) - 1;
              if (remaining) generationReaders.set(key, remaining); else generationReaders.delete(key);
            }
          }
        } else this.dropPreviewBody(id);
        if (job.request) await turn();
      }
    }).finally(() => { if (this.previewJobs.get(id) === job) this.previewJobs.delete(id); });
    this.previewWriter = job.promise;
  }
  async flushPreviews(id) {
    // Explicit close/test seam. A crash before this completes only loses a cache.
    while (id === undefined ? this.previewJobs.size : this.previewJobs.has(id)) {
      await Promise.all(id === undefined ? [...this.previewJobs.values()].map(job => job.promise) : [this.previewJobs.get(id).promise]);
    }
  }
  async loadPreview(id) {
    await this.pending.get(id);
    const started = performance.now(); let files, readerKey;
    try {
      const { manifest } = await this.readManifest(id);
      if (!manifest) return null; // Legacy portable data takes the full load path.
      files = this.generationFiles(id, manifest.generation); readerKey = files.state;
      generationReaders.set(readerKey, (generationReaders.get(readerKey) ?? 0) + 1);
      const cached = decodePreview(await readBounded(files.preview, MAX_PREVIEW_BYTES));
      const before = await fs.stat(files.journal);
      const details = await this.readGeneration(manifest, { materialize: false, maximumJournalBytes: MAX_PREVIEW_JOURNAL_BYTES });
      const token = previewToken(details);
      if (!matchingPreviewTokens(cached.token, token) || (await fs.stat(files.state)).size !== manifest.checkpoint.bytes) return null;
      for (const hash of cached.assetHashes) {
        if (!details.retainedAssets.has(hash)) return null;
        await this.assets.get(hash);
      }
      const current = await this.readManifest(id), after = await fs.stat(files.journal);
      if (!current.manifest || checksum(JSON.stringify(current.manifest)) !== token.manifestSha256 ||
          before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || before.ino !== after.ino) return null;
      const metadata = openedMetadata(details.metadata);
      this.metric({ stage: 'store-load-preview', durationMs: performance.now() - started, pages: cached.pages.length, assetCount: cached.assetHashes.length });
      return { ...metadata, document: cached.document, pageId: cached.pageId, pages: cached.pages, token, recovered: details.truncatedBytes > 0 };
    } catch (error) {
      // A complete bad journal must never become an apparently healthy older
      // preview. Missing/stale/corrupt optional caches simply use full loading.
      if (error.code === 'JOURNAL_CORRUPT') throw error;
      this.metric({ stage: 'store-preview-miss', reason: error.code ?? error.message });
      return null;
    } finally {
      if (readerKey) {
        const remaining = generationReaders.get(readerKey) - 1;
        if (remaining) generationReaders.set(readerKey, remaining); else generationReaders.delete(readerKey);
      }
    }
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
  async readGeneration(manifest, { materialize = true, maximumJournalBytes = MAX_PORTABLE_BYTES } = {}) {
    const files = this.generationFiles(manifest.id, manifest.generation);
    const raw = await readBounded(files.journal, maximumJournalBytes);
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
    const details = { manifest, metadata, retainedAssets, journalBytes: journal.validBytes, journalRecords: journal.records.length, sequence: journal.sequence, truncatedBytes: journal.truncatedBytes,
      journalHash: createHash('sha256').update(raw.subarray(0, journal.validBytes)) };
    if (!materialize) return details;
    const state = await readBounded(files.state, MAX_STATE_BYTES);
    if (state.length !== manifest.checkpoint.bytes || checksum(state) !== manifest.checkpoint.sha256) throw Error('Damaged canvas checkpoint');
    let replica;
    try {
      try {
        replica = new Replica({ state, updates, onMetric: event => this.metric({ ...event, phase: 'store-load' }) });
      } catch (error) {
        if (updates.length && error.hydrationPhase !== 'checkpoint') throw Object.assign(Error(`Invalid save journal state: ${error.message}`), { code: 'JOURNAL_CORRUPT' });
        throw error;
      }
      for (const hash of replica.retainedAssetRefs) if (!retainedAssets.has(hash)) throw Error('Canvas asset manifest is incomplete');
      for (const hash of retainedAssets) { await this.assets.get(hash); replica.retainedAssetRefs.add(hash); }
      try { assertImportProgress(metadata, replica.document); }
      catch (error) { if (journal.records.length) error.code = 'JOURNAL_CORRUPT'; throw error; }
      return { ...details, replica };
    } catch (error) { replica?.destroy(); throw error; }
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
        markLoadedPreview(record, previewToken(this.saved.get(id)));
        // Retain the recovery notice for the caller even after durable migration.
        record.recovered = recovered;
        this.metric({ stage: 'store-legacy-migration', durationMs: performance.now() - started, stateBytes: record.replica.state.byteLength });
        return record;
      } catch (error) { record.replica.destroy(); throw error; }
    }
    const { replica, metadata } = result;
    const token = saveToken({ replica, revision: replica.revision }), { replica: _, ...details } = result;
    this.saved.set(id, { ...details, token, metadataKey: metadataKey(metadata), repairedTail: result.truncatedBytes > 0 });
    const record = markLoadedPreview({ ...openedMetadata(metadata), replica, assetHashes: [...result.retainedAssets], recovered: recovered || result.truncatedBytes > 0 }, previewToken(result, recovered ? 'backup' : 'primary'));
    this.metric({ stage: 'store-load', durationMs: performance.now() - started, checkpointBytes: result.manifest.checkpoint.bytes, journalBytes: result.journalBytes, journalRecords: result.journalRecords, truncatedBytes: result.truncatedBytes });
    return record;
  }
  async save(record) {
    assertMetadata(record);
    const document = record.replica.document;
    assertImportProgress(record, document);
    let projection;
    try { projection = capturePreview(document); } catch { projection = null; }
    const id = record.id, previous = this.saved.get(id), requested = this.requested.get(id)?.deref();
    const importing = record.importStatus?.state === 'loading', finishedImport = previous?.metadata?.importStatus?.state === 'loading' && !importing;
    const needsCheckpoint = !previous || record.recovered || requested && requested !== record.replica || tokenOwner(previous?.token) !== record.replica || finishedImport ||
      !importing && (previous.journalRecords >= this.checkpointRecords || previous.journalBytes >= this.checkpointBytes);
    let captured = record.replica.captureSince(previous?.token, { full: !!needsCheckpoint });
    const metadata = metadataOf(record, new Date().toISOString()), key = metadataKey(record), assets = record.assets, wasRecovered = !!record.recovered;
    let reservation = captured.full ? 0 : journalRecordUpperBound(captured, metadata);
    // Source import defers ordinary compaction, never the file-size ceiling.
    // Capture any needed full state now, before awaits can admit another edit.
    // Reservations cover earlier queued captures, including overlapping deltas.
    if (!captured.full && (previous.journalBytes + (this.journalReservations.get(id) ?? 0) + reservation > this.journalLimitBytes)) {
      captured = record.replica.captureSince(previous.token, { full: true }); reservation = 0;
    }
    this.requested.set(id, new WeakRef(record.replica));
    const disk = path.resolve(this.file(id));
    if (reservation) this.journalReservations.set(id, (this.journalReservations.get(id) ?? 0) + reservation);
    const writing = (diskWrites.get(disk) ?? Promise.resolve()).catch(() => {}).then(async () => {
      const started = performance.now(), saved = this.saved.get(id);
      if (!wasRecovered && tokenOwner(saved?.token) === captured.replica && saved.token.revision === captured.revision && saved.metadataKey === key) {
        this.schedulePreview(id, projection, saved); return;
      }
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
        next = { manifest, journalBytes: 0, journalRecords: 0, sequence: 0, retainedAssets, journalHash: createHash('sha256') };
        this.metric({ stage: 'store-checkpoint', durationMs: performance.now() - started, stateBytes: state.length, manifestBytes: Buffer.byteLength(bytes), assetCount: retainedAssets.size });
      } else {
        const addedAssets = [...retainedAssets].filter(hash => !saved.retainedAssets.has(hash));
        const sequence = saved.sequence + 1;
        const bytes = encodeJournalRecord({ version: 1, sequence, metadata, update: captured.update ? Buffer.from(captured.update).toString('base64') : null, assetHashes: addedAssets });
        if (saved.journalBytes + bytes.length > Math.min(this.journalLimitBytes, MAX_PORTABLE_BYTES)) throw Object.assign(Error('Save journal reached its storage limit; retry to create a checkpoint'), { code: 'STORE_CHECKPOINT_REQUIRED' });
        const files = this.generationFiles(id, saved.manifest.generation);
        await appendJournal(files.journal, bytes, saved.journalBytes, { repairTail: saved.repairedTail });
        next = { ...saved, journalBytes: saved.journalBytes + bytes.length, journalRecords: saved.journalRecords + 1, sequence, retainedAssets, repairedTail: false,
          journalHash: saved.journalHash.copy().update(bytes) };
        this.metric({ stage: 'store-journal', durationMs: performance.now() - started, bytes: bytes.length, updateBytes: captured.update?.byteLength ?? 0, sequence });
      }
      this.saved.set(id, { ...next, metadata, metadataKey: key, token: saveToken(captured) });
      if (captured.full) await this.pruneCheckpoints(id);
      this.schedulePreview(id, projection, this.saved.get(id));
    });
    diskWrites.set(disk, writing); this.pending.set(id, writing);
    try { await writing; record.recovered = false; if (record.assets === assets) delete record.assets; }
    finally {
      if (reservation) {
        const remaining = this.journalReservations.get(id) - reservation;
        if (remaining) this.journalReservations.set(id, remaining); else this.journalReservations.delete(id);
      }
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
        const match = /^([a-f0-9-]{36})\.(state|journal|preview)$/.exec(name);
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
          items.push({ ...openedMetadata(record), recovered: false }); record.replica.destroy();
        } else {
          const result = await this.readLocal(source.manifest, { materialize: false });
          items.push({ ...openedMetadata(result.metadata), recovered: result.truncatedBytes > 0 });
        }
      } catch { items.push({ id, title: 'Damaged document', damaged: true }); }
    }
    return items.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  }
  async remove(id) {
    await this.pending.get(id);
    const preview = this.previewJobs.get(id); if (preview) preview.request = null;
    await this.flushPreviews(id); this.dropPreviewBody(id);
    this.saved.delete(id); this.requested.delete(id);
    await fs.rm(this.file(id), { force: true }); await fs.rm(`${this.file(id)}.bak`, { force: true });
    await fs.rm(path.join(this.dir, '.omc-data', id), { recursive: true, force: true });
    // Assets remain: safe GC must account for documents, Undo and in-flight work.
  }
}
