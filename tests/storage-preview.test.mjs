import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store, decodeFile } from '../core/storage.mjs';
import { Replica } from '../core/replica.mjs';
import { changesBetween } from '../core/document.mjs';
import { encodeJournalRecord } from '../core/journal.mjs';
import { capturePreview, serializePreview, MAX_PREVIEW_BYTES, MAX_PREVIEW_DOCUMENT_BYTES } from '../core/preview-cache.mjs';
import { documentFixture } from './helpers.mjs';

function twoPages() {
  const document = documentFixture();
  document.pages.push('second');
  document.pagesById.second = { ...structuredClone(document.pagesById.page), id: 'second', name: 'Second page' };
  document.pagesById.second.objects.label.text = 'Not loaded in the preview';
  document.styles = { red: { id: 'red', color: '#ff0000' } };
  document.assets = {}; document.components = {}; document.libraries = {};
  return document;
}
async function fixture(t, options = {}, document = twoPages()) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'omc-preview-'));
  const events = [], store = new Store(dir, { ...options, onMetric: event => events.push(event) });
  const record = { id: randomUUID(), title: 'Preview', createdAt: new Date().toISOString(), replica: new Replica({ document }) };
  t.after(async () => { await store.flushPreviews(); record.replica.destroy(); await fs.rm(dir, { recursive: true, force: true }); });
  return { store, record, events };
}
async function filesFor(store, id) { const { manifest } = await store.readManifest(id); return store.generationFiles(id, manifest.generation); }
async function readRecord(t, store, id) { const record = await store.load(id); t.after(() => record.replica.destroy()); return record; }
function rename(record, pid, name) { record.replica.patch([[JSON.stringify(['page', pid, 'name']), name]], 'Rename'); }

test('first-page preview preserves shared definitions and never reads the CRDT checkpoint', async t => {
  const { store, record, events } = await fixture(t);
  await store.save(record); await store.flushPreviews(record.id);
  const before = structuredClone(record.replica.document), read = fs.readFile;
  t.mock.method(fs, 'readFile', async (...args) => {
    assert.equal(String(args[0]).endsWith('.state'), false, 'preview must not decode a full checkpoint');
    return read(...args);
  });
  const preview = await new Store(store.dir).loadPreview(record.id);
  assert.deepEqual(preview.document.pages, ['page']);
  assert.deepEqual(Object.keys(preview.document.pagesById), ['page']);
  assert.deepEqual(preview.document.pagesById.page, before.pagesById.page);
  assert.deepEqual(preview.document.styles, before.styles);
  assert.deepEqual(preview.pages, [{ id: 'page', name: 'Canvas' }, { id: 'second', name: 'Second page' }]);
  assert.deepEqual(record.replica.document, before);
  assert.equal(events.some(event => event.stage === 'replica-validation'), false);
});

test('a cache token matches only the exact hydrated checkpoint and journal cursor', async t => {
  const { store, record } = await fixture(t);
  await store.save(record); await store.flushPreviews();
  const first = await store.loadPreview(record.id);
  const loaded = await readRecord(t, new Store(store.dir), record.id);
  assert.equal(store.previewMatches(loaded, first.token), true);
  for (const field of ['generation', 'checkpointSha256', 'manifestSha256', 'journalSha256', 'source']) {
    assert.equal(store.previewMatches(loaded, { ...first.token, [field]: 'different' }), false);
  }
  assert.equal(store.previewMatches(loaded, { ...first.token, journalSequence: 1 }), false);
  assert.equal(store.previewMatches(loaded, { ...first.token, journalBytes: 1 }), false);
  rename(record, 'page', 'Changed first page'); await store.save(record); await store.flushPreviews();
  const changed = await readRecord(t, new Store(store.dir), record.id);
  assert.equal(store.previewMatches(changed, first.token), false);
  const current = await store.loadPreview(record.id);
  assert.equal(store.previewMatches(changed, current.token), true);
  assert.equal(current.document.pagesById.page.name, 'Changed first page');
  assert.equal(current.token.journalSequence, 1);
  rename(changed, 'page', 'Already changed after hydration');
  assert.equal(store.previewMatches(changed, current.token), false);
});

test('a stale cache falls back while a newer optional refresh is blocked; save ACK does not wait', async t => {
  const { store, record } = await fixture(t);
  await store.save(record); await store.flushPreviews();
  const renameFile = fs.rename; let release, reached;
  const gate = new Promise(resolve => { release = resolve; }), ready = new Promise(resolve => { reached = resolve; });
  t.mock.method(fs, 'rename', async (...args) => {
    if (String(args[1]).endsWith('.preview')) { reached(); await gate; }
    return renameFile(...args);
  });
  rename(record, 'page', 'First saved change'); await store.save(record); await ready;
  assert.equal(await new Store(store.dir).loadPreview(record.id), null);
  rename(record, 'page', 'Latest saved change'); await store.save(record);
  rename(record, 'second', 'New second name'); await store.save(record);
  release(); await store.flushPreviews();
  const current = await store.loadPreview(record.id);
  assert.equal(current.document.pagesById.page.name, 'Latest saved change');
  assert.equal(current.pages[1].name, 'New second name');
  const loaded = await readRecord(t, new Store(store.dir), record.id);
  assert.equal(store.previewMatches(loaded, current.token), true);
});

test('other-page edits reuse first-page bytes, while first-page and shared-definition edits invalidate them', async t => {
  const { store, record } = await fixture(t); await store.save(record); await store.flushPreviews();
  const first = store.previewBodies.get(record.id).serialized.body;
  rename(record, 'second', 'Elsewhere'); await store.save(record); await store.flushPreviews();
  assert.equal(store.previewBodies.get(record.id).serialized.body, first);
  rename(record, 'page', 'Visible page'); await store.save(record); await store.flushPreviews();
  const second = store.previewBodies.get(record.id).serialized.body;
  assert.notEqual(second, first);
  record.replica.patch([[JSON.stringify(['styles', 'red']), { id: 'red', color: '#000000' }]], 'Shared style');
  await store.save(record); await store.flushPreviews();
  assert.notEqual(store.previewBodies.get(record.id).serialized.body, second);
  assert.equal((await store.loadPreview(record.id)).document.styles.red.color, '#000000');
});

test('a torn tail may use its verified prefix, but complete journal corruption is explicit', async t => {
  const { store, record } = await fixture(t);
  await store.save(record); rename(record, 'page', 'Acknowledged'); await store.save(record); await store.flushPreviews();
  const files = await filesFor(store, record.id), valid = await fs.readFile(files.journal);
  const tail = encodeJournalRecord({ version: 1, sequence: 2, metadata: { id: record.id, title: 'Never saved' }, update: null, assetHashes: [] });
  await fs.appendFile(files.journal, tail.subarray(0, tail.length - 1));
  const preview = await new Store(store.dir).loadPreview(record.id);
  assert.equal(preview.recovered, true); assert.equal(preview.document.pagesById.page.name, 'Acknowledged');
  const loaded = await readRecord(t, new Store(store.dir), record.id);
  assert.equal(store.previewMatches(loaded, preview.token), true);
  valid[40] ^= 1; await fs.writeFile(files.journal, valid);
  await assert.rejects(new Store(store.dir).loadPreview(record.id), error => error.code === 'JOURNAL_CORRUPT');
});

test('backup hydration cannot accept a primary preview token', async t => {
  const { store, record } = await fixture(t, { checkpointRecords: 0 });
  await store.save(record); rename(record, 'page', 'New checkpoint'); await store.save(record); await store.flushPreviews();
  const preview = await store.loadPreview(record.id), files = await filesFor(store, record.id);
  const checkpoint = await fs.readFile(files.state); checkpoint[0] ^= 255; await fs.writeFile(files.state, checkpoint);
  const loaded = await readRecord(t, new Store(store.dir), record.id);
  assert.equal(loaded.recovered, true); assert.equal(loaded.loadedPreviewToken.source, 'backup');
  assert.equal(store.previewMatches(loaded, preview.token), false);
});

test('cache corruption, missing caches, oversized caches and legacy files use full loading', async t => {
  const { store, record } = await fixture(t);
  await store.save(record); await store.flushPreviews();
  const files = await filesFor(store, record.id), bytes = await fs.readFile(files.preview);
  bytes[bytes.length - 1] ^= 1; await fs.writeFile(files.preview, bytes);
  assert.equal(await store.loadPreview(record.id), null);
  const full = await readRecord(t, new Store(store.dir), record.id);
  assert.deepEqual(full.replica.document, record.replica.document);
  await fs.truncate(files.preview, MAX_PREVIEW_BYTES + 1);
  assert.equal(await store.loadPreview(record.id), null);
  await fs.rm(files.preview);
  assert.equal(await store.loadPreview(record.id), null);
  await fs.writeFile(store.file(record.id), await store.export(record));
  assert.equal(await store.loadPreview(record.id), null);
});

test('cross-page component dependencies disable preview without altering the document', async t => {
  const document = twoPages(); document.components.other = { id: 'other', mainPageId: 'second', mainId: 'board' };
  const { store, record } = await fixture(t, {}, document);
  assert.equal(capturePreview(record.replica.document), null);
  await store.save(record); await store.flushPreviews();
  assert.equal(await store.loadPreview(record.id), null);
  const loaded = await readRecord(t, new Store(store.dir), record.id);
  assert.deepEqual(loaded.replica.document, record.replica.document);
});

test('preview verifies page asset dependencies without reading unused catalog bitmaps', async t => {
  const { store, record } = await fixture(t);
  const used = await store.assets.put(Buffer.from('page bitmap'), 'image/png');
  const unused = await store.assets.put(Buffer.from('other page bitmap'), 'image/png');
  const before = record.replica.document, document = structuredClone(before);
  document.assets = { used: { id: 'used', src: used.src }, unused: { id: 'unused', src: unused.src } };
  document.pagesById.page.objects.label.fills = [{ type: 'image', image: { assetId: 'used' } }];
  document.pagesById.second.objects.label.fills = [{ type: 'image', image: { assetId: 'unused' } }];
  record.replica.patch(changesBetween(before, document));
  await store.save(record); await store.flushPreviews();
  const reader = new Store(store.dir), get = reader.assets.get.bind(reader.assets), seen = [];
  reader.assets.get = async hash => { seen.push(hash); return get(hash); };
  const preview = await reader.loadPreview(record.id);
  assert.deepEqual(seen, [used.hash]); assert.deepEqual(preview.document.assets, document.assets);
  await fs.writeFile(store.assets.file(used.hash), 'corrupt');
  assert.equal(await reader.loadPreview(record.id), null);
});

test('optional cache write failure does not reject an acknowledged save', async t => {
  const { store, record, events } = await fixture(t), renameFile = fs.rename;
  t.mock.method(fs, 'rename', async (...args) => {
    if (String(args[1]).endsWith('.preview')) throw Error('Injected optional cache failure');
    return renameFile(...args);
  });
  await store.save(record); await store.flushPreviews();
  assert.equal(events.some(event => event.stage === 'store-preview-deferred'), true);
  assert.equal(await store.loadPreview(record.id), null);
  const loaded = await readRecord(t, new Store(store.dir), record.id);
  assert.deepEqual(loaded.replica.document, record.replica.document);
});

test('remove drains an in-flight cache and never recreates the deleted document directory', async t => {
  const { store, record } = await fixture(t), renameFile = fs.rename; let release, reached;
  const gate = new Promise(resolve => { release = resolve; }), ready = new Promise(resolve => { reached = resolve; });
  t.mock.method(fs, 'rename', async (...args) => {
    if (String(args[1]).endsWith('.preview')) { reached(); await gate; }
    return renameFile(...args);
  });
  await store.save(record); await ready;
  const removing = store.remove(record.id); release(); await removing;
  assert.equal(store.previewJobs.size, 0); assert.equal(store.previewBodies.size, 0);
  await assert.rejects(fs.stat(path.join(store.dir, '.omc-data', record.id)), error => error.code === 'ENOENT');
  assert.deepEqual(await store.list(), []);
});

test('preview serialization and retained body caches have independent bounded budgets', async t => {
  const { store } = await fixture(t), projection = capturePreview(twoPages());
  assert.throws(() => serializePreview({ ...projection, document: { ...projection.document, notes: 'x'.repeat(MAX_PREVIEW_DOCUMENT_BYTES + 1) } }), /Preview exceeds/);
  const notes = 'x'.repeat(5 * 1024 * 1024);
  for (let i = 0; i < 9; i++) store.cachePreviewBody(`item-${i}`, { ...projection, document: { ...projection.document, notes } });
  assert.ok(store.previewBodies.size <= 8);
  assert.ok(store.previewBodyBytes <= 32 * 1024 * 1024);
  assert.equal(store.previewBodies.has('item-0'), false);
});

test('partial import progress persists through journal, listing, preview and portable export', async t => {
  const { store, record } = await fixture(t);
  record.importStatus = { kind: 'sketch', state: 'loading', totalPages: 3, loadedPages: 2,
    pages: [{ id: 'page', name: 'Canvas' }, { id: 'second', name: 'Second page' }, { id: 'pending', name: 'Not imported yet' }] };
  await store.save(record); await store.flushPreviews();
  assert.equal(record.importStatus.state, 'loading');
  const manifest = (await store.readManifest(record.id)).manifest;
  assert.equal(manifest.importStatus.state, 'loading');
  const list = await store.list(), preview = await store.loadPreview(record.id), loaded = await readRecord(t, new Store(store.dir), record.id);
  for (const item of [list[0], preview, loaded]) {
    assert.equal(item.importStatus.state, 'interrupted');
    assert.equal(item.importStatus.totalPages, 3); assert.equal(item.importStatus.loadedPages, 2);
    assert.equal(item.importStatus.pages[2].id, 'pending');
  }
  assert.equal(preview.pages.length, 2); assert.deepEqual(preview.document.pages, ['page']);
  const portable = decodeFile(await store.export(record)); t.after(() => portable.replica.destroy());
  assert.equal(portable.importStatus.state, 'interrupted');
  record.importStatus = { ...record.importStatus, state: 'cancelled', error: 'Import cancelled' };
  await store.save(record); await store.flushPreviews();
  const cancelled = await readRecord(t, new Store(store.dir), record.id);
  assert.equal(cancelled.importStatus.state, 'cancelled'); assert.equal(cancelled.importStatus.error, 'Import cancelled');
  assert.equal((await store.loadPreview(record.id)).importStatus.state, 'cancelled');
});

test('malformed or inconsistent import status is rejected before persistence', async t => {
  const { store, record } = await fixture(t); await store.save(record); await store.flushPreviews();
  const valid = { kind: 'fig', state: 'loading', totalPages: 2, loadedPages: 2, pages: [{ id: 'page', name: 'Canvas' }, { id: 'second', name: 'Second page' }] };
  const initial = await fs.readFile(store.file(record.id));
  for (const status of [null, { ...valid, kind: 'other' }, { ...valid, state: 'unknown' }, { ...valid, loadedPages: 1 }, { ...valid, totalPages: 101 },
    { ...valid, state: 'complete', loadedPages: 1 }, { ...valid, pages: [valid.pages[1], valid.pages[0]] }, { ...valid, error: 'x'.repeat(1025) },
    { ...valid, pages: [valid.pages[0], valid.pages[0]] }, { ...valid, extra: 'not bounded metadata' }]) {
    await assert.rejects(store.save({ ...record, importStatus: status }), /Invalid canvas metadata/);
    assert.deepEqual(await fs.readFile(store.file(record.id)), initial);
  }
});

test('queued saves detach mutable import status before their first await', async t => {
  const { store, record } = await fixture(t);
  record.importStatus = { kind: 'fig', state: 'loading', totalPages: 2, loadedPages: 2, pages: [{ id: 'page', name: 'Captured name' }, { id: 'second', name: 'Second page' }] };
  const writing = store.save(record);
  record.importStatus.pages[0].name = 'Changed after save was requested';
  record.importStatus.state = 'cancelled';
  await writing; await store.flushPreviews();
  const manifest = (await store.readManifest(record.id)).manifest;
  assert.equal(manifest.importStatus.state, 'loading');
  assert.equal(manifest.importStatus.pages[0].name, 'Captured name');
});
