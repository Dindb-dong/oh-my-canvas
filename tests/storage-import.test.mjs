import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../core/storage.mjs';
import { Replica } from '../core/replica.mjs';
import { MAX_PORTABLE_BYTES } from '../core/capacity.mjs';
import { documentFixture } from './helpers.mjs';

async function fixture(t, options = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'omc-import-journal-')), events = [];
  const store = new Store(dir, { ...options, onMetric: event => events.push(event) });
  const record = { id: randomUUID(), title: 'Import journal', replica: new Replica({ document: documentFixture() }),
    importStatus: { kind: 'fig', state: 'loading', totalPages: 1, loadedPages: 1, pages: [{ id: 'page', name: 'Canvas' }] } };
  t.after(async () => { await store.flushPreviews(); record.replica.destroy(); await fs.rm(dir, { recursive: true, force: true }); });
  await store.save(record);
  return { store, record, events };
}
function rename(record, name) { record.replica.patch([[JSON.stringify(['page', 'page', 'name']), name]], 'Import change'); }
async function assertJournalLimit(store, id, maximum) {
  const directory = path.join(store.dir, '.omc-data', id);
  for (const file of await fs.readdir(directory)) if (file.endsWith('.journal')) assert.ok((await fs.stat(path.join(directory, file))).size <= maximum);
}

test('active imports defer ordinary checkpoint thresholds, then compact their terminal state once', async t => {
  const { store, record, events } = await fixture(t, { checkpointRecords: 1, checkpointBytes: 1 });
  const generation = (await store.readManifest(record.id)).manifest.generation;
  for (const name of ['One', 'Two', 'Three']) { rename(record, name); await store.save(record); }
  assert.equal((await store.readManifest(record.id)).manifest.generation, generation);
  assert.equal(events.filter(event => event.stage === 'store-checkpoint').length, 1);
  assert.equal(events.filter(event => event.stage === 'store-journal').length, 3);
  record.importStatus = { ...record.importStatus, state: 'complete' }; await store.save(record);
  assert.notEqual((await store.readManifest(record.id)).manifest.generation, generation);
  assert.equal(events.filter(event => event.stage === 'store-checkpoint').length, 2);
  assert.equal(store.saved.get(record.id).journalBytes, 0);
  const loaded = await new Store(store.dir).load(record.id);
  try { assert.equal(loaded.replica.document.pagesById.page.name, 'Three'); assert.equal(loaded.importStatus.state, 'complete'); }
  finally { loaded.replica.destroy(); }
});

test('an active import still rolls over before its hard journal byte ceiling', async t => {
  const maximum = 2048, { store, record, events } = await fixture(t, { journalLimitBytes: maximum, checkpointRecords: 0, checkpointBytes: 0 });
  for (let i = 0; i < 9; i++) {
    rename(record, `${i}:` + 'x'.repeat(400)); await store.save(record);
    await assertJournalLimit(store, record.id, maximum);
  }
  assert.ok(events.filter(event => event.stage === 'store-checkpoint').length > 1);
  assert.ok(events.filter(event => event.stage === 'store-journal').length > 1);
  const loaded = await new Store(store.dir).load(record.id);
  try { assert.equal(loaded.replica.document.pagesById.page.name, '8:' + 'x'.repeat(400)); assert.equal(loaded.importStatus.state, 'interrupted'); }
  finally { loaded.replica.destroy(); }
  assert.equal(store.journalReservations.size, 0);
});

test('queued import saves reserve journal bytes and checkpoint their captured revision before any await', async t => {
  const maximum = 2200, { store, record } = await fixture(t, { journalLimitBytes: maximum });
  const open = fs.open; let release, reached, held = false;
  const gate = new Promise(resolve => { release = resolve; }), ready = new Promise(resolve => { reached = resolve; });
  t.mock.method(fs, 'open', async (...args) => {
    const handle = await open(...args);
    if (String(args[0]).endsWith('.journal') && args[1] === 'r+' && !held) {
      held = true; const sync = handle.sync.bind(handle);
      handle.sync = async () => { reached(); await gate; return sync(); };
    }
    return handle;
  });
  rename(record, 'First:' + 'a'.repeat(300)); const writes = [store.save(record)]; await ready;
  try {
    for (const name of ['Second', 'Third', 'Fourth']) { rename(record, name + ':' + 'b'.repeat(300)); writes.push(store.save(record)); }
    rename(record, 'Never requested for save');
  } finally { release(); }
  await Promise.all(writes); await assertJournalLimit(store, record.id, maximum);
  assert.equal(store.journalReservations.size, 0);
  const loaded = await new Store(store.dir).load(record.id);
  try { assert.equal(loaded.replica.document.pagesById.page.name, 'Fourth:' + 'b'.repeat(300)); }
  finally { loaded.replica.destroy(); }
});

test('journal test/configuration limits can lower but never raise the storage ceiling', () => {
  for (const value of [0, -1, NaN, Infinity, MAX_PORTABLE_BYTES + 1]) assert.throws(() => new Store('/unused', { journalLimitBytes: value }), /Invalid journal storage limit/);
  assert.equal(new Store('/unused', { journalLimitBytes: 1 }).journalLimitBytes, 1);
  assert.equal(new Store('/unused').journalLimitBytes, MAX_PORTABLE_BYTES);
});
