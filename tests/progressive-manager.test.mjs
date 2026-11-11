import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../core/storage.mjs';
import { Replica } from '../core/replica.mjs';
import { DocumentProjection } from '../core/projection.mjs';
import { createDocumentManager } from '../electron/document-manager.mjs';
import { commitDocument } from '../electron/document-commit.mjs';
import { documentFixture } from './helpers.mjs';

function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const turn = () => new Promise(resolve => setImmediate(resolve));
async function bounded(promise, label) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error(`Timed out: ${label}`)), 1500); })]); }
  finally { clearTimeout(timer); }
}
function pages(count = 3) {
  const document = documentFixture(), template = document.pagesById.page;
  for (let i = 1; i < count; i++) {
    const id = `page-${i}`; document.pages.push(id);
    document.pagesById[id] = { ...structuredClone(template), id, name: `Page ${i + 1}` };
    document.pagesById[id].objects.label.text = `Unseen page ${i}`;
  }
  return document;
}
async function fixture(t, options = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'omc-progressive-manager-')), store = new Store(dir), events = [], disposed = [];
  const record = { id: randomUUID(), title: 'Progressive', replica: new Replica({ document: options.document ?? pages() }) };
  await store.save(record); await store.flushPreviews();
  let manager;
  manager = createDocumentManager({ store,
    createRuntime(entry) { queueMicrotask(() => manager.ready(entry, entry.generation)); return { id: entry.record.id, generation: entry.generation }; },
    async disposeRuntime(entry) { disposed.push(entry.record.id); }, async flushRuntime() {},
    onEvent(entry, event) { events.push(event); options.onEvent?.(entry, event); },
    ...Object.fromEntries(Object.entries(options).filter(([key]) => !['document', 'onEvent'].includes(key))) });
  t.after(async () => {
    for (const entry of manager.entries.values()) { clearTimeout(entry.resumeTimer); clearTimeout(entry.saveTimer); }
    await manager.disposeAll(); await store.flushPreviews(); record.replica.destroy();
    await fs.rm(dir, { recursive: true, force: true });
  });
  return { store, manager, record, events, disposed };
}
function commit(manager, store, entry, data) {
  return manager.enqueue(entry, () => commitDocument(entry, data, { store,
    save: value => manager.save(value), confirmGeneration: manager.confirmGeneration,
    acknowledgment: manager.acknowledgment, validateChanges: changes => manager.assertChanges(entry, changes) }));
}
const rename = name => [[JSON.stringify(['page', 'page', 'name']), name]];

test('cached first page mounts and bootstraps before full hydration is requested', async t => {
  const created = deferred(); let f;
  f = await fixture(t, { createRuntime(entry) { created.resolve(entry); return { id: entry.record.id }; } });
  const { manager, store, record } = f, load = store.load.bind(store); let loads = 0;
  store.load = async id => { loads++; return load(id); };
  const opening = manager.open(record.id, { focus: true }), entry = await created.promise;
  assert.equal(loads, 0); assert.equal(entry.record.replica, null);
  assert.deepEqual(manager.snapshot(entry).document.pages, ['page']);
  const initialized = await manager.bootstrap(entry, { nonce: entry.bootstrapNonce,
    changes: [[JSON.stringify(['shape', 'page', 'label', 'name']), 'Normalized first page']] });
  assert.equal(initialized.ack, 0); assert.equal(initialized.acceptedSeq, 0); assert.equal(loads, 0);
  assert.equal(initialized.document.pagesById.page.objects.label.name, 'Normalized first page');
  manager.ready(entry, entry.generation); await opening;
  assert.equal(loads, 0);
  await manager.beginLoading(entry);
  assert.equal(loads, 1); assert.equal(entry.loadingState.state, 'complete');
  assert.deepEqual(entry.record.replica.document.pages, record.replica.document.pages);
  assert.equal(entry.record.replica.document.pagesById.page.objects.label.name, 'Normalized first page');
  assert.equal(entry.record.replica.document.pagesById['page-1'].objects.label.text, 'Unseen page 1');
  assert.equal(entry.record.replica.undo.undoStack.length, 0, 'bootstrap is never user Undo');
});

test('cached bootstrap cannot stash changes to unseen namespaces for later replay', async t => {
  const { manager, record } = await fixture(t), entry = await manager.open(record.id);
  clearTimeout(entry.resumeTimer);
  for (const changes of [
    [[JSON.stringify(['page', 'page-1', 'alive']), false]],
    [[JSON.stringify(['shape', 'page-1', 'label', 'alive']), false]],
    [[JSON.stringify(['geometry', 'page-1', 'label', 'position']), { x: 100, y: 200 }]],
  ]) {
    await assert.rejects(manager.bootstrap(entry, { nonce: entry.bootstrapNonce, changes }), /loading|loaded|page/i);
    assert.equal(entry.record.replica, null); assert.equal(entry.bootstrapChanges.length, 0);
  }
  await manager.bootstrap(entry, { nonce: entry.bootstrapNonce, changes: [] });
  await manager.beginLoading(entry);
  assert.deepEqual(entry.record.replica.document, record.replica.document);
});

test('early edits wait for authority and fsync without overwriting unloaded pages or user Undo', async t => {
  let projection;
  const { manager, store, record, events } = await fixture(t, { onEvent(entry, event) {
    if (['document', 'document-delta', 'document-pages'].includes(event.type)) projection?.accept(event);
  } });
  const entry = await manager.open(record.id); clearTimeout(entry.resumeTimer);
  await manager.bootstrap(entry, { nonce: entry.bootstrapNonce, changes: [] });
  projection = new DocumentProjection(manager.snapshot(entry));
  projection.enqueue({ seq: 1, changes: rename('Edited immediately') });
  const load = store.load.bind(store), gate = deferred(), started = deferred();
  store.load = async id => { started.resolve(); await gate.promise; return load(id); };
  let acknowledged = false;
  const writing = commit(manager, store, entry, { seq: 1, changes: rename('Edited immediately'), label: 'Early rename' }).then(value => { acknowledged = true; projection.accept(value); return value; });
  await started.promise; await turn();
  try {
    assert.equal(acknowledged, false); assert.equal(entry.seq, 0); assert.equal(entry.acceptedSeq, 0);
    assert.equal(projection.projected.pagesById.page.name, 'Edited immediately');
  } finally { gate.resolve(); }
  const ack = await writing;
  assert.equal(ack.ack, 1); assert.equal(projection.pending.length, 0);
  assert.equal(entry.record.replica.document.pagesById['page-2'].objects.label.text, 'Unseen page 2');
  await manager.beginLoading(entry);
  assert.deepEqual(projection.projected, entry.record.replica.document);
  const pageEvents = events.filter(event => event.type === 'document-pages');
  assert.ok(pageEvents.length); assert.ok(pageEvents.every(event => event.revision === event.fromRevision + 1));
  entry.record.replica.history('undo');
  assert.equal(entry.record.replica.document.pagesById.page.name, 'Canvas');
  assert.equal(entry.record.replica.document.pages.length, 3);
  await manager.save(entry);
  const reopened = await new Store(store.dir).load(record.id);
  try { assert.deepEqual(reopened.replica.document, entry.record.replica.document); } finally { reopened.replica.destroy(); }
});

test('a changed stored generation rejects staged bootstrap and early edits before any replay', async t => {
  const { manager, store, record } = await fixture(t), entry = await manager.open(record.id); clearTimeout(entry.resumeTimer);
  await manager.bootstrap(entry, { nonce: entry.bootstrapNonce, changes: rename('Staged only') });
  const external = new Store(store.dir, { checkpointRecords: 0 }), changed = await external.load(record.id);
  changed.replica.patch(rename('External authoritative edit'), 'Elsewhere'); await external.save(changed); await external.flushPreviews(); changed.replica.destroy();
  await assert.rejects(commit(manager, store, entry, { seq: 1, changes: rename('Must stay pending') }), { code: 'preview_changed' });
  assert.equal(entry.seq, 0); assert.equal(entry.acceptedSeq, 0); assert.equal(entry.record.replica, null);
  assert.equal(entry.loadingState.state, 'failed');
  const persisted = await new Store(store.dir).load(record.id);
  try { assert.equal(persisted.replica.document.pagesById.page.name, 'External authoritative edit'); } finally { persisted.replica.destroy(); }
});

test('a page-delivery barrier permits reentrant saves needed to finish an active title edit', async t => {
  let manager, checks = 0;
  const f = await fixture(t, { async waitForPages(entry) {
    checks++;
    await bounded(manager.enqueue(entry, async () => { entry.record.title = 'Title saved during page delivery'; await manager.save(entry); }), 'reentrant title save behind page barrier');
  } }); manager = f.manager;
  const entry = await manager.open(f.record.id); clearTimeout(entry.resumeTimer);
  await bounded(manager.beginLoading(entry), 'progressive delivery');
  assert.ok(checks > 0); assert.equal(entry.record.title, 'Title saved during page delivery');
  assert.equal(entry.loadingState.state, 'complete');
});

test('complete waits for acknowledged page delivery before allowing a full-document operation', async t => {
  const gate = deferred(), arrived = deferred();
  const { manager, record } = await fixture(t, { async waitForPages() { arrived.resolve(); await gate.promise; } });
  const entry = await manager.open(record.id); clearTimeout(entry.resumeTimer);
  let completed = false;
  const completing = manager.complete(entry).then(() => { completed = true; });
  try { await bounded(arrived.promise, 'page barrier'); await turn(); assert.equal(completed, false); }
  finally { gate.resolve(); }
  await completing;
  assert.equal(completed, true); assert.equal(entry.loadingState.state, 'complete');
  assert.equal(manager.snapshot(entry).document.pages.length, 3);
});

test('dispose stops further page publication before destroying a hydrating entry', async t => {
  const gate = deferred(), arrived = deferred(); let barriers = 0;
  const { manager, record, events } = await fixture(t, { document: pages(8), async waitForPages() { if (++barriers === 1) { arrived.resolve(); await gate.promise; } } });
  const entry = await manager.open(record.id); clearTimeout(entry.resumeTimer);
  const delivering = manager.beginLoading(entry); void delivering.catch(() => {});
  await arrived.promise;
  const disposing = manager.disposeAll();
  // A real runtime disposal rejects outstanding renderer barriers. Release our
  // fake equivalent so cancellation/draining can complete without a timer.
  gate.resolve(); await disposing; const published = events.length;
  await delivering.catch(() => {}); await turn();
  assert.equal(manager.entries.size, 0);
  assert.equal(events.length, published, 'disposed runtimes must receive no later page/loading events');
  assert.ok(barriers <= 1, 'disposal must not start a second page delivery');
});

test('disposal rejects newly admitted external work while draining earlier operations', async t => {
  const { manager, record } = await fixture(t), entry = await manager.open(record.id); clearTimeout(entry.resumeTimer);
  await manager.beginLoading(entry);
  const disposing = manager.disposeAll(); let executed = false;
  await assert.rejects(manager.enqueue(entry, () => { executed = true; }), { code: 'runtime_restarted' });
  await disposing;
  assert.equal(executed, false); assert.equal(manager.entries.size, 0);
});
