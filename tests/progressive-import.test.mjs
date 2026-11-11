import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../core/storage.mjs';
import { DocumentProjection } from '../core/projection.mjs';
import { createDocumentManager } from '../electron/document-manager.mjs';
import { startProgressiveImport } from '../electron/progressive-import.mjs';
import { commitDocument } from '../electron/document-commit.mjs';
import { documentFixture } from './helpers.mjs';

function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const turn = () => new Promise(resolve => setImmediate(resolve));
async function bounded(promise) {
  let timer;
  try { return await Promise.race([promise, new Promise((resolve, reject) => { timer = setTimeout(() => reject(Error('Import cleanup did not finish')), 2000); })]); }
  finally { clearTimeout(timer); }
}
function untilAborted(signal) {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
}
function batch(id, index) {
  const document = documentFixture(), page = document.pagesById.page;
  document.pages = [id]; document.pagesById = { [id]: { ...page, id, name: `Source page ${index}` } };
  document.pagesById[id].objects.label.text = `Source content ${index}`;
  return { document, pageIds: [id], blobs: [], warnings: [`Page ${index} warning`] };
}
const batches = () => [batch('first', 1), batch('second', 2), batch('third', 3)];
function worker(source, { afterBatch = async () => {}, complete = true } = {}) {
  return async (bytes, format, options) => {
    options.signal.throwIfAborted();
    options.onManifest({ pages: source.flatMap(item => item.document.pages.map(id => ({ id, name: item.document.pagesById[id].name }))) });
    for (let i = 0; i < source.length; i++) {
      options.signal.throwIfAborted(); await options.onBatch(source[i]); await afterBatch(i, options);
    }
    return { complete, warnings: source.flatMap(item => item.warnings) };
  };
}
async function fixture(t, options = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'omc-progressive-import-')), store = new Store(dir), events = [], progress = [];
  let manager;
  manager = createDocumentManager({ store,
    createRuntime(entry) { queueMicrotask(() => manager.ready(entry, entry.generation)); return { id: entry.record.id, generation: entry.generation }; },
    async disposeRuntime() {}, async flushRuntime() {},
    onEvent(entry, event) { events.push(event); options.onEvent?.(entry, event); },
    ...Object.fromEntries(Object.entries(options).filter(([key]) => key !== 'onEvent')) });
  t.after(async () => { await manager.disposeAll(); await store.flushPreviews(); await fs.rm(dir, { recursive: true, force: true }); });
  const start = (readDesignFile, extras = {}) => startProgressiveImport(new Uint8Array([1]), 'fig', {
    readDesignFile, manager, store, title: 'Imported source', onProgress: value => progress.push(value), ...extras,
  });
  return { manager, store, events, progress, start };
}
async function persisted(t, store, id) {
  const record = await new Store(store.dir).load(id); t.after(() => record.replica.destroy()); return record;
}
function commit(manager, store, entry, data) {
  return manager.enqueue(entry, () => commitDocument(entry, data, { store,
    save: value => manager.save(value), confirmGeneration: manager.confirmGeneration,
    acknowledgment: manager.acknowledgment, validateChanges: changes => manager.assertChanges(entry, changes) }));
}

test('first durable page is editable before later batches, and early edits/Undo survive completion', async t => {
  let projection;
  const { manager, store, events, progress, start } = await fixture(t, { onEvent(entry, event) {
    if (['document', 'document-delta', 'document-pages'].includes(event.type)) projection?.accept(event);
  } });
  const paint = deferred(), enteredPaint = deferred();
  const first = await start(worker(batches()), { afterFirstPaint: async entry => { enteredPaint.resolve(); await Promise.race([paint.promise, untilAborted(entry.importSignal)]); } });
  const { entry, completion } = first; await enteredPaint.promise;
  assert.deepEqual(entry.record.replica.document.pages, ['first']);
  assert.equal(entry.record.importStatus.state, 'loading'); assert.equal(entry.record.importStatus.loadedPages, 1);
  assert.equal(entry.record.importStatus.totalPages, 3); assert.equal(entry.tabOpen, true);
  const partial = await persisted(t, store, entry.record.id);
  assert.deepEqual(partial.replica.document.pages, ['first']); assert.equal(partial.importStatus.state, 'interrupted');
  projection = new DocumentProjection(manager.snapshot(entry));
  const changes = [[JSON.stringify(['page', 'first', 'name']), 'Edited before page two']];
  projection.enqueue({ seq: 1, changes });
  projection.accept(await commit(manager, store, entry, { seq: 1, changes, label: 'Early user edit' }));
  let complete = false; const exportReady = manager.complete(entry).then(() => { complete = true; });
  await turn(); assert.equal(complete, false); assert.equal(projection.pending.length, 0);
  paint.resolve(); await completion; await exportReady;
  assert.equal(complete, true); assert.equal(entry.record.importStatus.state, 'complete');
  assert.deepEqual(entry.record.replica.document.pages, ['first', 'second', 'third']);
  assert.equal(entry.record.replica.document.pagesById.first.name, 'Edited before page two');
  assert.deepEqual(projection.projected, entry.record.replica.document);
  assert.deepEqual(events.filter(event => event.type === 'document-pages').map(event => event.pageDocument.pages), [['second'], ['third']]);
  assert.equal(progress.at(-1).phase, 'complete'); assert.equal(progress.at(-1).loadedPages, 3);
  entry.record.replica.history('undo');
  assert.equal(entry.record.replica.document.pagesById.first.name, 'Source page 1');
  assert.deepEqual(entry.record.replica.document.pages, ['first', 'second', 'third']);
  await manager.save(entry);
  const reopened = await persisted(t, store, entry.record.id);
  assert.deepEqual(reopened.replica.document, entry.record.replica.document);
});

test('worker failure after the first page retains a durable partial document and forbids full export', async t => {
  const { manager, store, progress, start } = await fixture(t), proceed = deferred();
  const { entry, completion } = await start(worker(batches(), { afterBatch: async index => { if (!index) { await proceed.promise; throw Error('Decoder failed on the next page'); } } }));
  proceed.resolve(); await assert.rejects(completion, /Decoder failed/);
  assert.deepEqual(entry.record.replica.document.pages, ['first']);
  assert.equal(entry.record.importStatus.state, 'failed'); assert.equal(entry.record.importStatus.loadedPages, 1);
  assert.equal(entry.holds, 0); assert.equal(entry.cancelImport, null);
  assert.equal(progress.some(value => value.phase === 'complete'), false);
  await assert.rejects(manager.complete(entry), /Decoder failed|incomplete/);
  const read = await persisted(t, store, entry.record.id);
  assert.equal(read.importStatus.state, 'failed'); assert.equal(read.importStatus.loadedPages, 1);
  assert.deepEqual(read.replica.document.pages, ['first']);
});

test('cancellation after the first page persists cancelled metadata and no invented remaining pages', async t => {
  const { manager, store, progress, start } = await fixture(t);
  const { entry, completion } = await start(worker(batches(), { afterBatch: async (index, options) => { if (!index) await untilAborted(options.signal); } }));
  entry.cancelImport(); await assert.rejects(completion, /Import stopped/);
  assert.equal(entry.record.importStatus.state, 'cancelled'); assert.equal(entry.record.importStatus.totalPages, 3);
  assert.equal(entry.record.importStatus.loadedPages, 1); assert.equal(progress.at(-1).phase, 'cancelled');
  await assert.rejects(manager.complete(entry), /Import stopped|incomplete/);
  const read = await persisted(t, store, entry.record.id);
  assert.equal(read.importStatus.state, 'cancelled'); assert.deepEqual(read.replica.document.pages, ['first']);
  assert.deepEqual(read.importStatus.pages.map(page => page.id), ['first', 'second', 'third']);
});

test('failure before a first usable page rejects the open request without creating a canvas', async t => {
  const { manager, store, start } = await fixture(t);
  await assert.rejects(start(async () => { throw Error('Unusable design source'); }), /Unusable design source/);
  assert.equal(manager.entries.size, 0); assert.deepEqual(await store.list(), []);
});

test('page manifest/order and final completeness are checked independently', async t => {
  const { manager, store, start } = await fixture(t);
  const source = batches();
  await assert.rejects(start(async (bytes, format, { onManifest, onBatch }) => {
    onManifest({ pages: [{ id: 'first', name: 'First' }, { id: 'second', name: 'Second' }] });
    await onBatch(source[1]); return { complete: true };
  }), { code: 'invalid_import' });
  assert.deepEqual(await store.list(), []);
  const { entry, completion } = await start(worker(source, { complete: false }));
  await assert.rejects(completion, /before every page/);
  assert.equal(entry.record.importStatus.state, 'failed'); assert.equal(entry.record.importStatus.loadedPages, 3);
  assert.equal(manager.entries.size, 1);
});

test('a save failure after page publication preserves actual retained pages in terminal metadata', async t => {
  const { store, progress, start } = await fixture(t), save = store.save.bind(store); let failed = false;
  store.save = async record => {
    if (!failed && record.importStatus?.state === 'loading' && record.importStatus.loadedPages === 2) { failed = true; throw Object.assign(Error('Injected second-page fsync failure'), { code: 'EIO' }); }
    return save(record);
  };
  const { entry, completion } = await start(worker(batches()));
  await assert.rejects(completion, /second-page fsync failure/);
  assert.equal(entry.record.importStatus.state, 'failed'); assert.equal(entry.record.importStatus.loadedPages, 2);
  assert.deepEqual(entry.record.replica.document.pages, ['first', 'second']);
  assert.equal(progress.at(-1).loadedPages, 2); assert.equal(progress.at(-1).phase, 'failed');
  const read = await persisted(t, store, entry.record.id);
  assert.equal(read.importStatus.state, 'failed'); assert.equal(read.importStatus.loadedPages, 2);
  assert.deepEqual(read.replica.document.pages, ['first', 'second']);
});

test('persistent save failure reopens only the durable prefix and never claims completion', async t => {
  const { store, progress, start } = await fixture(t), save = store.save.bind(store);
  store.save = async record => {
    if (record.importStatus?.loadedPages >= 2) throw Object.assign(Error('Disk is unavailable'), { code: 'EIO' });
    return save(record);
  };
  const { entry, completion } = await start(worker(batches()));
  await assert.rejects(completion, error => error.message === 'Disk is unavailable' && error.saveError === 'Disk is unavailable');
  assert.equal(entry.saveError, 'Disk is unavailable'); assert.equal(progress.at(-1).phase, 'failed');
  const read = await persisted(t, store, entry.record.id);
  assert.deepEqual(read.replica.document.pages, ['first']);
  assert.equal(read.importStatus.state, 'interrupted'); assert.equal(read.importStatus.loadedPages, 1);
  store.save = save;
});

test('dispose cancels an active worker and durably records the partial result before destroying its Replica', async t => {
  const { manager, store, events, start } = await fixture(t);
  const { entry, completion } = await start(worker(batches(), { afterBatch: async (index, options) => { if (!index) await untilAborted(options.signal); } }));
  const failure = assert.rejects(completion, /Import stopped/);
  await manager.disposeAll(); await failure;
  const eventCount = events.length; await turn();
  assert.equal(events.length, eventCount); assert.equal(manager.entries.size, 0);
  const read = await persisted(t, store, entry.record.id);
  assert.equal(read.importStatus.state, 'cancelled'); assert.equal(read.importStatus.loadedPages, 1);
  assert.deepEqual(read.replica.document.pages, ['first']);
});

// The real worker transport rejects immediately on cancellation/timeout, even
// when its consumer is still saving or waiting for first paint. Do not await
// this callback here: the coordinator must retain its lifetime independently.
function detachedWorker(source, terminal, capture = () => {}) {
  return async (bytes, format, options) => {
    capture(options.signal);
    options.onManifest({ pages: source.map(item => ({ id: item.pageIds[0], name: item.document.pagesById[item.pageIds[0]].name })) });
    const consuming = options.onBatch(source[0]); void consuming.catch(() => {});
    await Promise.race([terminal.promise, untilAborted(options.signal)]);
    return { complete: false };
  };
}

test('worker rejection waits for a late create result before terminal status and hold cleanup', async t => {
  const { manager, store, progress, start } = await fixture(t), create = manager.create.bind(manager);
  const entered = deferred(), release = deferred(), terminal = deferred(); let lateEntry, settled = false;
  manager.create = async (...args) => { entered.resolve(); await release.promise; return lateEntry = await create(...args); };
  const opening = start(detachedWorker(batches(), terminal));
  const rejected = assert.rejects(opening, /Worker total lifetime expired/).then(() => { settled = true; });
  await entered.promise; terminal.reject(Error('Worker total lifetime expired')); await turn();
  assert.equal(settled, false, 'consumer mutation must settle before the open request rejects');
  release.resolve(); await bounded(rejected);
  assert.ok(lateEntry); assert.equal(lateEntry.holds, 0); assert.equal(lateEntry.cancelImport, null); assert.equal(lateEntry.importSignal, null);
  assert.equal(lateEntry.record.importStatus.state, 'failed'); assert.equal(progress.at(-1).phase, 'failed');
  assert.equal(progress.some(value => value.phase === 'pages' || value.phase === 'complete'), false);
  const read = await persisted(t, store, lateEntry.record.id);
  assert.equal(read.importStatus.state, 'failed'); assert.deepEqual(read.replica.document.pages, ['first']);
  await manager.closeTab(lateEntry.record.id); assert.equal(manager.entries.size, 0, 'late entry is releasable, without a leaked import hold');
});

test('cancellation across a late create return keeps only the saved first page and releases its hold', async t => {
  const { manager, store, progress, start } = await fixture(t), create = manager.create.bind(manager);
  const entered = deferred(), release = deferred(), terminal = deferred(), cancellation = new AbortController(); let lateEntry, settled = false;
  manager.create = async (...args) => { lateEntry = await create(...args); entered.resolve(); await release.promise; return lateEntry; };
  const opening = start(detachedWorker(batches(), terminal), { options: { signal: cancellation.signal } });
  const rejected = assert.rejects(opening, /Caller cancelled during create/).then(() => { settled = true; });
  await entered.promise; cancellation.abort(Error('Caller cancelled during create')); await turn(); assert.equal(settled, false);
  release.resolve(); await bounded(rejected);
  assert.equal(lateEntry.holds, 0); assert.equal(lateEntry.cancelImport, null); assert.equal(lateEntry.record.importStatus.state, 'cancelled');
  assert.equal(progress.at(-1).loadedPages, 1); assert.equal(progress.at(-1).phase, 'cancelled');
  const read = await persisted(t, store, lateEntry.record.id);
  assert.deepEqual(read.replica.document.pages, ['first']); assert.equal(read.importStatus.loadedPages, 1); assert.equal(read.importStatus.state, 'cancelled');
});

test('worker failure aborts a pending first-paint wait but remains a failure', async t => {
  const { store, progress, start } = await fixture(t), terminal = deferred(), painting = deferred(), release = deferred(); let workerSignal;
  const { entry, completion } = await start(detachedWorker(batches(), terminal, signal => { workerSignal = signal; }), {
    afterFirstPaint: async () => { painting.resolve(); await release.promise; },
  });
  await painting.promise; terminal.reject(Error('Worker crashed during first paint'));
  await bounded(assert.rejects(completion, /Worker crashed/));
  assert.equal(workerSignal.aborted, false); assert.equal(entry.record.importStatus.state, 'failed'); assert.equal(entry.holds, 0);
  assert.equal(progress.at(-1).phase, 'failed'); const count = progress.length;
  release.resolve(); await turn(); assert.equal(progress.length, count, 'late paint cannot emit progress after termination');
  const read = await persisted(t, store, entry.record.id); assert.equal(read.importStatus.state, 'failed'); assert.deepEqual(read.replica.document.pages, ['first']);
});

test('transport cancellation during a saved batch barrier counts durable pages, without consuming the next batch', async t => {
  const waiting = deferred(), terminal = deferred();
  const { store, progress, start } = await fixture(t, { async waitForPages(entry) { waiting.resolve(); await untilAborted(entry.importSignal); } });
  const source = batches();
  const { entry, completion } = await start(async (bytes, format, options) => {
    options.onManifest({ pages: source.map(item => ({ id: item.pageIds[0], name: item.pageIds[0] })) });
    await options.onBatch(source[0]);
    const second = options.onBatch(source[1]); void second.catch(() => {});
    await Promise.race([terminal.promise, untilAborted(options.signal)]); return { complete: false };
  });
  await waiting.promise; entry.cancelImport(); await bounded(assert.rejects(completion, /Import stopped/));
  assert.equal(entry.record.importStatus.state, 'cancelled'); assert.equal(entry.record.importStatus.loadedPages, 2); assert.equal(entry.holds, 0);
  assert.deepEqual(entry.record.replica.document.pages, ['first', 'second']);
  assert.deepEqual(progress.filter(value => value.phase === 'pages').map(value => value.loadedPages), [1]);
  const read = await persisted(t, store, entry.record.id);
  assert.deepEqual(read.replica.document.pages, ['first', 'second']); assert.equal(read.importStatus.state, 'cancelled'); assert.equal(read.importStatus.loadedPages, 2);
});

test('real create cancellation after its first save records cancelled metadata before releasing startup', async t => {
  const entered = deferred(), cancellation = new AbortController(), terminal = deferred();
  const { manager, store, start } = await fixture(t, { createRuntime(entry) { entered.resolve(entry); return { id: entry.record.id }; } });
  const opening = start(detachedWorker(batches(), terminal), { options: { signal: cancellation.signal } });
  const rejected = assert.rejects(opening, /Caller cancelled startup/), entry = await entered.promise;
  cancellation.abort(Error('Caller cancelled startup')); manager.ready(entry, entry.generation);
  await bounded(rejected); assert.equal(manager.entries.size, 0);
  const read = await persisted(t, store, entry.record.id);
  assert.equal(read.importStatus.state, 'cancelled'); assert.equal(read.importStatus.loadedPages, 1); assert.deepEqual(read.replica.document.pages, ['first']);
});

test('real create runtime failure after its first save records failed metadata before destroying the entry', async t => {
  const entered = deferred();
  const { manager, store, start } = await fixture(t, { createRuntime(entry) { entered.resolve(entry); return { id: entry.record.id }; } });
  const opening = start(worker(batches())), rejected = assert.rejects(opening, /Renderer could not start/), entry = await entered.promise;
  manager.ready(entry, entry.generation, Error('Renderer could not start'));
  await bounded(rejected); assert.equal(manager.entries.size, 0);
  const read = await persisted(t, store, entry.record.id);
  assert.equal(read.importStatus.state, 'failed'); assert.equal(read.importStatus.loadedPages, 1); assert.deepEqual(read.replica.document.pages, ['first']);
});

test('shutdown drains the first save before destroying its Replica and never starts the runtime', async t => {
  let runtimeStarts = 0;
  const { manager, store, start } = await fixture(t, { createRuntime() { runtimeStarts++; throw Error('Runtime must not start after shutdown'); } });
  const save = store.save.bind(store), entered = deferred(), release = deferred(); let firstSave = true, destroyed = false;
  store.save = async record => {
    if (firstSave) {
      firstSave = false; record.replica.ydoc.on('destroy', () => { destroyed = true; }); entered.resolve(record);
      await release.promise;
      assert.equal(destroyed, false, 'shutdown destroyed the authority while its first save was still using it');
    }
    return save(record);
  };
  const opening = start(worker(batches())), rejected = assert.rejects(opening, /closing/), record = await entered.promise;
  let closed = false;
  const shutdown = manager.disposeAll().then(() => { closed = true; });
  try {
    await turn();
    assert.equal(closed, false, 'shutdown returned before first-page creation drained');
    assert.equal(destroyed, false); assert.equal(runtimeStarts, 0); assert.equal(manager.entries.has(record.id), true);
  } finally { release.resolve(); }
  await bounded(Promise.all([shutdown, rejected]));
  assert.equal(destroyed, true); assert.equal(runtimeStarts, 0); assert.equal(manager.entries.size, 0);
  const read = await persisted(t, store, record.id);
  assert.equal(read.importStatus.state, 'cancelled'); assert.equal(read.importStatus.loadedPages, 1);
  assert.deepEqual(read.replica.document.pages, ['first']);
});
