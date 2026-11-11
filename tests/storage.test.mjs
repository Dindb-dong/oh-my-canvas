import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import * as Y from 'yjs';
import { Store, decodeFile, encodeFile } from '../core/storage.mjs';
import { Replica } from '../core/replica.mjs';
import { encodeJournalRecord } from '../core/journal.mjs';
import { documentFixture } from './helpers.mjs';
import { changesBetween, MAX_ENVELOPE_BYTES } from '../core/document.mjs';
import { hashAsset, assetRef } from '../core/assets.mjs';

async function fixture(t, options = {}, document = documentFixture()) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'omc-storage-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const events = [], store = new Store(directory, { onMetric: event => events.push(event), ...options });
  const record = { id: randomUUID(), title: 'Original', createdAt: new Date().toISOString(), replica: new Replica({ document }) };
  t.after(() => record.replica.destroy());
  return { directory, events, store, record };
}
function renameShape(record, name) {
  const before = record.replica.document, after = structuredClone(before);
  after.pagesById.page.objects.label.name = name;
  record.replica.patch(changesBetween(before, after), 'Rename');
}
async function manifestFor(store, id) { return JSON.parse(await fs.readFile(store.file(id), 'utf8')); }
async function reopen(t, store, id) { const record = await store.load(id); t.after(() => record.replica.destroy()); return record; }

test('local manifests and portable exports reopen, and manifest recovery preserves acknowledged journal edits', async t => {
  const { store, record } = await fixture(t);
  await store.save(record);
  const manifest = await manifestFor(store, record.id);
  assert.equal(manifest.format, 'oh-my-canvas-local'); assert.equal(manifest.state, undefined);
  assert.ok((await fs.stat(store.file(record.id))).size < 2048);
  const portable = decodeFile(await store.export(record));
  assert.deepEqual(portable.replica.document, record.replica.document); portable.replica.destroy();
  record.title = 'Renamed'; renameShape(record, 'Journal revision'); await store.save(record);
  await fs.writeFile(store.file(record.id), 'broken manifest');
  const recovered = await reopen(t, store, record.id);
  assert.equal(recovered.recovered, true); assert.equal(recovered.title, 'Renamed');
  assert.equal(recovered.replica.document.pagesById.page.objects.label.name, 'Journal revision');
  await store.save(recovered); assert.equal((await store.list())[0].title, 'Renamed');
  assert.throws(() => store.file('../outside'));
  await store.remove(record.id); assert.deepEqual(await store.list(), []);
});

test('queued saves capture their requested revision and duplicate callers wait for durability', async t => {
  const { store, record, events } = await fixture(t);
  const rename = fs.rename; let release, started;
  const gate = new Promise(resolve => { release = resolve; }), ready = new Promise(resolve => { started = resolve; });
  let intercepted = false;
  t.mock.method(fs, 'rename', async (...args) => {
    if (!intercepted && args[1] === store.file(record.id)) { intercepted = true; started(); await gate; }
    return rename(...args);
  });
  const first = store.save(record); await ready;
  let duplicateFinished = false;
  const duplicate = store.save(record).then(() => { duplicateFinished = true; });
  record.title = 'Latest'; renameShape(record, 'New state'); const second = store.save(record);
  await new Promise(resolve => setImmediate(resolve)); assert.equal(duplicateFinished, false);
  release(); await Promise.all([first, duplicate, second]);
  const read = await reopen(t, new Store(store.dir), record.id);
  assert.equal(read.title, 'Latest'); assert.equal(read.replica.document.pagesById.page.objects.label.name, 'New state');
  assert.equal(events.filter(event => ['store-checkpoint', 'store-journal'].includes(event.stage)).length, 2);
});

test('metadata and small edits append a bounded delta without encoding another full state', async t => {
  const doc = documentFixture(); doc.notes = 'x'.repeat(2 * 1024 * 1024);
  const { store, record, events } = await fixture(t, {}, doc);
  await Promise.all(Array.from({ length: 6 }, () => store.save(record)));
  const first = await manifestFor(store, record.id), checkpoint = store.generationFiles(record.id, first.generation).state;
  const original = await fs.readFile(checkpoint);
  renameShape(record, 'Tiny edit');
  Object.defineProperty(record.replica, 'state', { configurable: true, get() { throw Error('Unexpected whole-state serialization during save'); } });
  record.title = 'Metadata plus delta'; await store.save(record); await store.save(record);
  delete record.replica.state;
  assert.deepEqual(await fs.readFile(checkpoint), original);
  assert.equal((await manifestFor(store, record.id)).generation, first.generation);
  const writes = events.filter(event => event.stage === 'store-journal');
  assert.equal(writes.length, 1); assert.ok(writes[0].updateBytes < 1024); assert.ok(writes[0].bytes < 4096);
  assert.equal(events.filter(event => event.stage === 'store-checkpoint').length, 1);
  const read = await reopen(t, new Store(store.dir), record.id);
  assert.equal(read.title, record.title); assert.deepEqual(read.replica.document, record.replica.document);
});

test('metadata validation rejects malformed imports and leaves durable files untouched', async t => {
  const { store, record } = await fixture(t); await store.save(record);
  const original = await fs.readFile(store.file(record.id), 'utf8'), portable = JSON.parse(encodeFile(record));
  for (const fields of [{ title: {} }, { title: null }, { title: '' }, { title: '   ' }, { title: 'x'.repeat(1025) }, { updatedAt: {} }, { updatedAt: 'not a date' }, { createdAt: 123 }, { thumbnail: {} }, { thumbnail: 'https://example.com/image.png' }, { thumbnail: 'data:image/png;base64,' + 'x'.repeat(500000) }]) {
    assert.throws(() => decodeFile(JSON.stringify({ ...portable, ...fields })), /Invalid canvas metadata/);
    await assert.rejects(store.save({ ...record, ...fields }), /Invalid canvas metadata/);
    assert.equal(await fs.readFile(store.file(record.id), 'utf8'), original);
  }
  const legacy = decodeFile(JSON.stringify({ ...portable, version: 1, title: 'x'.repeat(125), createdAt: undefined, thumbnail: undefined }));
  legacy.replica.destroy();
});

test('legacy embedded files load and new workspaces use manifests while damaged entries remain isolated', async t => {
  const { store, record } = await fixture(t);
  await fs.writeFile(store.file(record.id), encodeFile(record));
  const loaded = await reopen(t, store, record.id); assert.deepEqual(loaded.replica.document, record.replica.document);
  loaded.title = 'Migrated'; await store.save(loaded); assert.equal((await manifestFor(store, record.id)).format, 'oh-my-canvas-local');
  const bad = randomUUID(); await fs.writeFile(store.file(bad), JSON.stringify({ format: 'oh-my-canvas-local', title: {} }));
  const items = await new Store(store.dir).list();
  assert.equal(items.find(item => item.id === bad).damaged, true);
  assert.equal(items.find(item => item.id === record.id).title, 'Migrated');
  assert.ok(items.every(item => typeof item.title === 'string'));
});

test('checkpoint publication failures and journal fsync failures retry without losing the last acknowledged edit', async t => {
  const { store, record } = await fixture(t);
  const rename = fs.rename; let failManifest = true;
  t.mock.method(fs, 'rename', async (...args) => {
    if (failManifest && args[1] === store.file(record.id)) { failManifest = false; throw Error('Injected manifest publication failure'); }
    return rename(...args);
  });
  await assert.rejects(store.save(record), /Injected manifest/); await store.save(record);
  const open = fs.open; let failSync = true;
  t.mock.method(fs, 'open', async (...args) => {
    const handle = await open(...args);
    if (String(args[0]).endsWith('.journal') && args[1] === 'r+') {
      const sync = handle.sync.bind(handle);
      handle.sync = async () => { if (failSync) { failSync = false; throw Error('Injected fsync failure'); } return sync(); };
    }
    return handle;
  });
  renameShape(record, 'Retry state'); record.title = 'Retry metadata';
  await assert.rejects(store.save(record), /Injected fsync/);
  const before = await reopen(t, new Store(store.dir), record.id);
  assert.equal(before.title, 'Original'); assert.equal(before.replica.document.pagesById.page.objects.label.name, 'Hello');
  await store.save(record);
  const after = await reopen(t, new Store(store.dir), record.id);
  assert.equal(after.title, 'Retry metadata'); assert.equal(after.replica.document.pagesById.page.objects.label.name, 'Retry state');
});

test('a truncated final journal record recovers, while corruption in a complete record is an explicit error', async t => {
  const { store, record } = await fixture(t); await store.save(record);
  renameShape(record, 'Acknowledged'); await store.save(record);
  const manifest = await manifestFor(store, record.id), file = store.generationFiles(record.id, manifest.generation).journal;
  const valid = await fs.readFile(file);
  const uncommitted = encodeJournalRecord({ version: 1, sequence: 2, metadata: { id: record.id, title: 'Never ACKed' }, update: null, assetHashes: [] });
  await fs.appendFile(file, uncommitted.subarray(0, uncommitted.length - 7));
  const restarted = new Store(store.dir), recovered = await reopen(t, restarted, record.id);
  assert.equal(recovered.recovered, true); assert.equal(recovered.title, 'Original');
  assert.equal(recovered.replica.document.pagesById.page.objects.label.name, 'Acknowledged');
  recovered.title = 'After recovery'; await restarted.save(recovered);
  const clean = await reopen(t, new Store(store.dir), record.id); assert.equal(clean.recovered, false); assert.equal(clean.title, 'After recovery');
  // Corrupt a complete record in the current generation, with a valid backup
  // available: recovery must not hide acknowledged-edit corruption.
  clean.title = 'One'; const nextStore = new Store(store.dir); await nextStore.load(record.id).then(r => r.replica.destroy());
  await nextStore.save(clean); clean.title = 'Two'; await nextStore.save(clean);
  const current = await manifestFor(nextStore, record.id), currentJournal = nextStore.generationFiles(record.id, current.generation).journal;
  const damaged = await fs.readFile(currentJournal); assert.ok(damaged.length > 40); damaged[40] ^= 1; await fs.writeFile(currentJournal, damaged);
  await assert.rejects(new Store(store.dir).load(record.id), error => error.code === 'JOURNAL_CORRUPT');
  assert.ok(valid.length > 0);
});

test('periodic checkpoints preserve edits and an interrupted replacement keeps the previous generation usable', async t => {
  const { store, record, events } = await fixture(t, { checkpointRecords: 2 }); await store.save(record);
  for (const name of ['First', 'Second', 'Third', 'Fourth', 'Fifth', 'Sixth']) { renameShape(record, name); await store.save(record); }
  assert.equal(events.filter(event => event.stage === 'store-checkpoint').length, 3);
  const generations = await fs.readdir(path.join(store.dir, '.omc-data', record.id));
  assert.equal(generations.filter(name => name.endsWith('.state')).length, 2);
  assert.equal(generations.filter(name => name.endsWith('.journal')).length, 2);
  const read = await reopen(t, new Store(store.dir), record.id); assert.equal(read.replica.document.pagesById.page.objects.label.name, 'Sixth');
  await fs.writeFile(store.file(record.id), 'broken');
  const recovered = await reopen(t, new Store(store.dir), record.id);
  assert.equal(recovered.recovered, true); assert.equal(recovered.replica.document.pagesById.page.objects.label.name, 'Fifth');
});

test('a complete malformed Yjs journal record never silently falls back to a healthy older checkpoint', async t => {
  const { store, record } = await fixture(t, { checkpointRecords: 0 }); await store.save(record);
  record.title = 'Current checkpoint'; await store.save(record);
  const manifest = await manifestFor(store, record.id), file = store.generationFiles(record.id, manifest.generation).journal;
  const metadata = { id: record.id, title: record.title };
  await fs.appendFile(file, encodeJournalRecord({ version: 1, sequence: 1, metadata, update: Buffer.from([255, 255, 255]).toString('base64'), assetHashes: [] }));
  await fs.appendFile(file, encodeJournalRecord({ version: 1, sequence: 2, metadata, update: null, assetHashes: [] }));
  await assert.rejects(new Store(store.dir).load(record.id), error => error.code === 'JOURNAL_CORRUPT');
});

test('reopen hydrates checkpoint plus journals into one fully validated replica',async t=>{
  const {store,record}=await fixture(t);await store.save(record);
  for(const name of ['Replay one','Replay two','Replay three']){renameShape(record,name);await store.save(record);}
  const events=[],reader=new Store(store.dir,{onMetric:event=>events.push(event)}),loaded=await reopen(t,reader,record.id);
  assert.equal(loaded.replica.document.pagesById.page.objects.label.name,'Replay three');
  const validations=events.filter(event=>event.stage==='replica-validation'&&event.phase==='store-load');
  assert.equal(validations.length,1);assert.equal(validations[0].incremental,false);assert.equal(validations[0].sizeValidation,'exact');
  assert.equal(loaded.replica.updateLog.length,0);
  renameShape(loaded,'After reopen');await reader.save(loaded);
  assert.equal(events.filter(event=>event.stage==='store-journal').at(-1).updateBytes<1024,true);
});

test('a checksum-matching malformed checkpoint still recovers its backup even when the damaged generation has a journal',async t=>{
  const {store,record}=await fixture(t,{checkpointRecords:1});await store.save(record);
  renameShape(record,'Backup journal edit');await store.save(record);renameShape(record,'New checkpoint');await store.save(record);renameShape(record,'Current journal edit');await store.save(record);
  const manifest=await manifestFor(store,record.id),files=store.generationFiles(record.id,manifest.generation),invalid=Buffer.from([255,255,255]);
  assert.ok((await fs.stat(files.journal)).size>0);
  manifest.checkpoint={bytes:invalid.length,sha256:createHash('sha256').update(invalid).digest('hex')};
  await fs.writeFile(files.state,invalid);await fs.writeFile(store.file(record.id),JSON.stringify(manifest));
  const recovered=await reopen(t,new Store(store.dir),record.id);assert.equal(recovered.recovered,true);assert.equal(recovered.replica.document.pagesById.page.objects.label.name,'Backup journal edit');
});

test('stale concurrent Store writers fail instead of truncating another writer journal or replacing its checkpoint', async t => {
  const { store, record } = await fixture(t); await store.save(record);
  const other = new Store(store.dir, { checkpointRecords: 0 }), stale = await reopen(t, other, record.id);
  renameShape(record, 'Winning write'); await store.save(record);
  renameShape(stale, 'Stale write'); await assert.rejects(other.save(stale), error => error.code === 'STORE_CONFLICT');
  const read = await reopen(t, new Store(store.dir), record.id); assert.equal(read.replica.document.pagesById.page.objects.label.name, 'Winning write');
});

test('save acknowledgement survives immediate SIGKILL and reopen in another process', { skip: process.platform === 'win32' }, async t => {
  const { directory, store, record } = await fixture(t); await store.save(record);
  const script = `import {Store} from ${JSON.stringify(new URL('../core/storage.mjs', import.meta.url).href)};
const store=new Store(process.argv[1]);const record=await store.load(process.argv[2]);record.title='Durable ACK';
record.replica.patch([[JSON.stringify(['page','page','name']),'Durable page']],'Edit');await store.save(record);
process.stdout.write('ACK\\n',()=>process.kill(process.pid,'SIGKILL'));`;
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, directory, record.id], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', errors = ''; child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { errors += data; });
    child.on('error', reject); child.on('close', (code, signal) => resolve({ code, signal, output, errors }));
  });
  assert.equal(result.errors, ''); assert.match(result.output, /ACK/); assert.equal(result.signal, 'SIGKILL');
  const read = await reopen(t, new Store(directory), record.id);
  assert.equal(read.title, 'Durable ACK'); assert.equal(read.replica.document.pagesById.page.name, 'Durable page');
});

test('large retained history is rejected before mutation and every accepted portable file reopens', () => {
  const replica = new Replica({ document: documentFixture() }), record = { id: randomUUID(), title: 'Budget', replica };
  let rejected = false;
  try {
    for (let i = 0; i < 9; i++) {
      const before = replica.document, state = replica.state, after = structuredClone(before);
      after.pagesById.page.objects.label.name = String(i).repeat(3 * 1024 * 1024);
      try { replica.patch(changesBetween(before, after)); }
      catch (error) { assert.match(error.message, /16 MiB/); assert.deepEqual(replica.document, before); assert.deepEqual(replica.state, state); rejected = true; break; }
      const file = encodeFile(record); assert.ok(Buffer.byteLength(file) <= MAX_ENVELOPE_BYTES);
      const read = decodeFile(file); assert.deepEqual(read.replica.document, replica.document); read.replica.destroy();
    }
    assert.equal(rejected, true);
  } finally { replica.destroy(); }
});

test('large libraries opt into a bounded budget and reopen with shared assets intact',()=>{
  const document=documentFixture();document.assets={image:{src:'data:image/png;base64,'+'A'.repeat(17*1024*1024)}};
  assert.throws(()=>new Replica({document}),/16 MiB/);
  document.capacity='large';const replica=new Replica({document});
  try{const encoded=encodeFile({id:randomUUID(),title:'Library',replica});assert.equal(JSON.parse(encoded).version,3);const loaded=decodeFile(encoded);try{assert.deepEqual(loaded.replica.document,replica.document);assert.equal(loaded.state,undefined);}finally{loaded.replica.destroy();}}
  finally{replica.destroy();}
});

test('library listing refreshes metadata after external changes',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'omc-list-cache-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const store=new Store(dir),record={id:randomUUID(),title:'First',replica:new Replica({document:documentFixture()})};t.after(()=>record.replica.destroy());await store.save(record);
  const results=await Promise.all([store.list(),store.list(),store.list()]);assert.ok(results.every(items=>items[0].title==='First'));
  record.title='External rename';await fs.writeFile(store.file(record.id),encodeFile(record));assert.equal((await store.list())[0].title,record.title);
});

test('compressed envelopes reject invalid payloads even with a matching checksum',()=>{
  const replica=new Replica({document:documentFixture()});
  try{const file=JSON.parse(encodeFile({id:randomUUID(),title:'Invalid compressed state',replica}));file.version=3;file.state=Buffer.from('not gzip').toString('base64');file.sha256=createHash('sha256').update(file.state).digest('hex');assert.throws(()=>decodeFile(JSON.stringify(file)),/header|compression|gzip/i);}
  finally{replica.destroy();}
});

test('legacy v3 migration externalizes live raster bytes and preserves Yjs merge identity and legacy entity maps',async t=>{
  const bytes=Buffer.alloc(1024*1024,17),src='data:image/png;base64,'+bytes.toString('base64'),ref=assetRef(hashAsset(bytes));
  const document=documentFixture();document.assets={image:{id:'image',src},svg:{src:'data:image/svg+xml;base64,PHN2Zy8+'}};
  document.components={component:{id:'component',name:'Existing component'}};document.styles={style:{id:'style',color:'#ff0000'}};
  document.libraries={library:{id:'library',assets:{image:{src}}}};
  const {store,record}=await fixture(t,{},document),legacy=new Y.Doc();t.after(()=>legacy.destroy());
  Y.applyUpdate(legacy,record.replica.state);
  const fields=legacy.getMap('fields');legacy.transact(()=>{
    for(const group of ['assets','components','styles','libraries']){
      for(const id of Object.keys(document[group]))fields.delete(JSON.stringify([group,id]));
      fields.set(JSON.stringify(['meta',group]),document[group]);
    }
    fields.set(JSON.stringify(['assets','removed']),null);
  });
  const sourceState=Y.encodeStateAsUpdate(legacy),offline=new Replica({state:sourceState});t.after(()=>offline.destroy());
  offline.patch([[JSON.stringify(['page','page','name']),'Offline legacy edit']],'Offline');
  const state=Buffer.from(gzipSync(sourceState)).toString('base64');
  const portable=JSON.stringify({format:'oh-my-canvas',version:3,id:record.id,title:record.title,state,sha256:createHash('sha256').update(state).digest('hex')});
  await fs.writeFile(store.file(record.id),portable);
  const loaded=await reopen(t,store,record.id),doc=loaded.replica.document;
  assert.equal(doc.assets.image.src,ref);assert.equal(doc.libraries.library.assets.image.src,ref);assert.equal(doc.assets.svg.src,document.assets.svg.src);
  assert.deepEqual(doc.components,document.components);assert.deepEqual(doc.styles,document.styles);assert.equal(doc.assets.removed,undefined);
  assert.equal(JSON.stringify(doc).includes(src),false);assert.deepEqual((await store.assets.get(hashAsset(bytes))).bytes,bytes);
  assert.ok(loaded.replica.state.byteLength<64*1024);assert.equal(loaded.replica.undo.undoStack.length,0);
  for(const group of ['assets','components','styles','libraries'])assert.equal(loaded.replica.fields.get(JSON.stringify(['meta',group])),null);
  for(const [client,clock] of Y.decodeStateVector(Y.encodeStateVector(legacy)))assert.ok(Y.decodeStateVector(Y.encodeStateVector(loaded.replica.ydoc)).get(client)>=clock);
  loaded.replica.receive(offline.state);assert.equal(loaded.replica.document.pagesById.page.name,'Offline legacy edit');assert.equal(loaded.replica.document.assets.image.src,ref);
  await store.save(loaded);const restarted=await reopen(t,new Store(store.dir),record.id);assert.equal(restarted.replica.document.assets.image.src,ref);
  assert.equal((await manifestFor(store,record.id)).format,'oh-my-canvas-local');
});

test('asset migration retries against a concurrent edit and does not clear existing Undo',async t=>{
  const document=documentFixture();document.assets={image:{src:'data:image/png;base64,'+Buffer.from('migration pixels').toString('base64')}};
  const {store,record}=await fixture(t,{},document);renameShape(record,'Before migration');
  const originalImport=store.assets.import.bind(store.assets);let release,started,first=true;
  const ready=new Promise(resolve=>{started=resolve;}),gate=new Promise(resolve=>{release=resolve;});
  store.assets.import=async assets=>{if(first){first=false;started();await gate;}return originalImport(assets);};
  const preparing=store.prepareRecord(record);await ready;renameShape(record,'Concurrent name');release();await preparing;
  assert.equal(record.replica.document.pagesById.page.objects.label.name,'Concurrent name');assert.match(record.replica.document.assets.image.src,/^omc-asset:/);
  record.replica.history('undo');assert.equal(record.replica.document.pagesById.page.objects.label.name,'Before migration');assert.match(record.replica.document.assets.image.src,/^omc-asset:/);
});

test('failed migration blob publication leaves the complete legacy file recoverable for retry',async t=>{
  const document=documentFixture();document.assets={image:{src:'data:image/png;base64,'+Buffer.from('durable migration').toString('base64')}};
  const {store,record}=await fixture(t,{},document),portable=encodeFile(record);await fs.writeFile(store.file(record.id),portable);
  const rename=fs.rename;let fail=true;
  t.mock.method(fs,'rename',async(...args)=>{if(fail&&String(args[1]).startsWith(store.assets.directory)){fail=false;throw Error('Injected blob publication failure');}return rename(...args);});
  await assert.rejects(store.load(record.id),/Injected blob/);assert.equal(await fs.readFile(store.file(record.id),'utf8'),portable);
  const loaded=await reopen(t,store,record.id);assert.match(loaded.replica.document.assets.image.src,/^omc-asset:/);assert.equal((await manifestFor(store,record.id)).format,'oh-my-canvas-local');
});
