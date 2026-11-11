import {test} from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Store} from '../core/storage.mjs';
import {Replica} from '../core/replica.mjs';
import {randomUUID} from 'node:crypto';
import {changesBetween} from '../core/document.mjs';
import {DocumentProjection} from '../core/projection.mjs';
import {createDocumentManager} from '../electron/document-manager.mjs';
import {documentFixture} from './helpers.mjs';

async function fixture(t,options={}){
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'omc-doc-manager-')),store=new Store(dir),disposed=[],flushed=[];
  let manager;
  manager=createDocumentManager({store,createRuntime(entry){queueMicrotask(()=>manager.ready(entry,entry.generation));return {id:entry.record.id,generation:entry.generation};},async disposeRuntime(entry){if(entry.runtime)disposed.push(entry.record.id);},async flushRuntime(entry){flushed.push(entry.record.id);},...options});
  t.after(async()=>{await manager.disposeAll();await store.flushPreviews();await fs.rm(dir,{recursive:true,force:true});});
  return {manager,store,disposed,flushed};
}
function change(entry,name){const before=entry.record.replica.document,after=structuredClone(before);after.pagesById.page.objects.label.name=name;entry.record.replica.patch(changesBetween(before,after));}

test('MCP bindings and explicit targets stay independent of UI tab selection',async t=>{
  const {manager}=await fixture(t);
  const a=await manager.create('A',documentFixture(),{agent:'A'}),b=await manager.create('B',documentFixture(),{agent:'B'});
  assert.equal(manager.state().activeTabId,null);assert.equal(manager.resolve('A'),a.record.id);assert.equal(manager.resolve('B'),b.record.id);
  manager.activate(b.record.id);manager.activate(a.record.id);
  assert.equal(manager.resolve('A'),a.record.id);assert.equal(manager.resolve('B'),b.record.id);
  assert.equal(manager.resolve('A',b.record.id,true),b.record.id);
  assert.throws(()=>manager.resolve('A',undefined,true),{code:'document_required'});
  assert.throws(()=>manager.resolve('unbound'),{code:'document_required'});
  assert.throws(()=>manager.resolve('A','../../outside',true),{code:'bad_args'});
  manager.bind('A',b);assert.equal(manager.resolve('A'),b.record.id);assert.equal(manager.state().activeTabId,a.record.id);
});

test('concurrent live replicas with colliding layer IDs persist only their own edits',async t=>{
  const {manager,store}=await fixture(t);
  const [a,b]=await Promise.all([manager.create('A',documentFixture()),manager.create('B',documentFixture())]);
  change(a,'Only A');change(b,'Only B');
  await Promise.all([manager.save(a),manager.save(b)]);
  const savedA=await store.load(a.record.id),savedB=await store.load(b.record.id);
  try{assert.equal(savedA.replica.document.pagesById.page.objects.label.name,'Only A');assert.equal(savedB.replica.document.pagesById.page.objects.label.name,'Only B');}finally{savedA.replica.destroy();savedB.replica.destroy();}
});

test('closing a bound tab keeps its runtime until the last agent releases it',async t=>{
  const {manager,disposed}=await fixture(t);
  const a=await manager.create('A',documentFixture(),{agent:'agent',focus:true}),b=await manager.create('B',documentFixture());
  await manager.closeTab(a.record.id);
  assert.equal(manager.state().activeTabId,b.record.id);assert.ok(manager.entries.has(a.record.id));assert.equal(a.tabOpen,false);assert.ok(a.runtime);assert.deepEqual(disposed,[]);
  await manager.endAgent('agent');assert.equal(manager.entries.has(a.record.id),false);assert.deepEqual(disposed,[a.record.id]);assert.ok(b.runtime);
});

test('reopening a tab while its release save is pending vetoes disposal',async t=>{
  const {manager,store,disposed}=await fixture(t),entry=await manager.create('A',documentFixture());
  entry.tabOpen=false;const save=store.save.bind(store);let finish,started;
  const saving=new Promise(resolve=>{started=resolve;});
  store.save=async record=>{started();await new Promise(resolve=>{finish=resolve;});return save(record);};
  const releasing=manager.release(entry);await saving;
  await manager.open(entry.record.id,{agent:'new-agent',focus:true});finish();await releasing;
  assert.equal(manager.entries.get(entry.record.id),entry);assert.equal(entry.tabOpen,true);assert.equal(manager.state().activeTabId,entry.record.id);assert.deepEqual(disposed,[]);
  store.save=save;
});

test('loading while a runtime is being disposed waits and creates a fresh entry',async t=>{
  let finish,started,gated=true;const disposing=new Promise(resolve=>{started=resolve;});
  const {manager}=await fixture(t,{async disposeRuntime(){if(gated){gated=false;started();await new Promise(resolve=>{finish=resolve;});}}});
  const entry=await manager.create('A',documentFixture());entry.tabOpen=false;
  const releasing=manager.release(entry);await disposing;
  const opening=manager.open(entry.record.id,{focus:true});await Promise.resolve();finish();await releasing;const next=await opening;
  assert.notEqual(next,entry);assert.ok(next.runtime);assert.ok(next.generation>entry.generation);
});

test('resident limit refuses another create before its file is persisted',async t=>{
  const {manager,store}=await fixture(t,{maxResidents:2});
  await Promise.all([manager.create('A',documentFixture()),manager.create('B',documentFixture())]);
  await assert.rejects(manager.create('C',documentFixture()),{code:'resource_limit'});
  assert.equal((await store.list()).length,2);assert.equal(manager.entries.size,2);
});

test('dormant rename and duplicate source do not consume resident runtime slots',async t=>{
  const {manager}=await fixture(t,{maxResidents:2}),source=await manager.create('Dormant source',documentFixture()),id=source.record.id;
  await manager.closeTab(id);const a=await manager.create('A',documentFixture()),b=await manager.create('B',documentFixture());
  await manager.rename(id,'Dormant renamed');assert.equal(manager.entries.size,2);assert.equal(manager.entries.has(id),false);
  await assert.rejects(manager.duplicate(id,'Blocked copy'),{code:'resource_limit'});assert.equal(manager.entries.size,2);assert.equal(manager.entries.has(id),false);
  await manager.closeTab(b.record.id);const copy=await manager.duplicate(id,'Allowed copy');
  assert.equal(manager.entries.size,2);assert.equal(manager.entries.has(id),false);assert.ok(a.runtime);assert.ok(copy.runtime);
});

test('unrelated session end cannot dispose startup, and canceled startup releases its runtime',async t=>{
  let started,entry;const starting=new Promise(resolve=>{started=resolve;});
  const {manager,disposed}=await fixture(t,{createRuntime(candidate){entry=candidate;started();return {id:candidate.record.id};}});
  const cancellation=new AbortController(),creating=manager.create('Starting',documentFixture(),{agent:'B',signal:cancellation.signal});
  await starting;await manager.endAgent('unrelated');assert.ok(entry.runtime);assert.deepEqual(disposed,[]);
  cancellation.abort(Error('Caller ended'));manager.ready(entry,entry.generation);
  await assert.rejects(creating,/Caller ended/);assert.equal(manager.entries.size,0);assert.equal(manager.bindings.has('B'),false);assert.deepEqual(disposed,[entry.record.id]);
});

test('rename and duplicate use a background document live replica',async t=>{
  const {manager}=await fixture(t);
  const a=await manager.create('A',documentFixture()),b=await manager.create('B',documentFixture(),{focus:true});
  change(a,'Unsaved live A');await manager.rename(a.record.id,'Renamed A');
  assert.equal(a.record.title,'Renamed A');assert.equal(manager.state().activeTabId,b.record.id);
  const copy=await manager.duplicate(a.record.id,'Copy');
  assert.equal(copy.record.replica.document.pagesById.page.objects.label.name,'Unsaved live A');assert.notEqual(copy.record.id,a.record.id);assert.equal(manager.state().activeTabId,b.record.id);
});

test('renderer restart changes only its generation and preserves other runtimes',async t=>{
  const {manager}=await fixture(t);
  const a=await manager.create('A',documentFixture()),b=await manager.create('B',documentFixture());
  const previous=a.generation,bRuntime=b.runtime;
  manager.runtimeGone(a);assert.ok(a.generation>previous);await manager.ensureRuntime(a);
  assert.ok(a.generation>previous);assert.equal(b.runtime,bRuntime);assert.equal(b.generation,1);
});

test('an IPC operation queued for a previous renderer generation never executes',async t=>{
  const {manager}=await fixture(t),entry=await manager.create('A',documentFixture());let finish,executed=false;
  const held=manager.enqueue(entry,()=>new Promise(resolve=>{finish=resolve;}));await Promise.resolve();
  const stale=manager.enqueue(entry,()=>{executed=true;});
  manager.runtimeGone(entry);await manager.ensureRuntime(entry);finish();await held;
  await assert.rejects(stale,{code:'runtime_restarted'});assert.equal(executed,false);
});

test('one document save failure does not block another document writer',async t=>{
  const {manager,store}=await fixture(t);
  const a=await manager.create('A',documentFixture()),b=await manager.create('B',documentFixture());
  const save=store.save.bind(store);let rejectA,started;
  const firstStarted=new Promise(resolve=>{started=resolve;});
  store.save=record=>record.id===a.record.id?new Promise((_,reject)=>{rejectA=reject;started();}):save(record);
  const writingA=manager.save(a);await firstStarted;
  change(b,'B still saves');await manager.save(b);rejectA(Error('A disk failure'));
  await assert.rejects(writingA,/A disk failure/);assert.equal(a.saveError,'A disk failure');assert.equal(b.saveError,null);
  store.save=save;
});

test('failed uninitialized join candidates can be discarded without saving a damaged file',async t=>{
  const {manager,store}=await fixture(t),id=randomUUID();
  const entry=await manager.load(id,{id,title:'Uninitialized join',replica:new Replica()});
  assert.equal(manager.discard(entry),true);assert.equal(manager.entries.size,0);assert.deepEqual(await store.list(),[]);
});

test('renderer deltas restore deleted shape declarations and containment through undo and redo',async t=>{
  let projection;
  const deltas=[];
  const {manager}=await fixture(t,{onEvent(entry,event){if(event.type==='document-delta'){deltas.push(event);projection?.accept(event);}}});
  const entry=await manager.create('History',documentFixture());projection=new DocumentProjection(manager.snapshot(entry));
  const before=entry.record.replica.document,after=structuredClone(before);
  delete after.pagesById.page.objects.board;after.pagesById.page.objects.root.childIds=['label'];
  entry.record.replica.patch(changesBetween(before,after),'Delete board');
  assert.deepEqual(projection.document,entry.record.replica.document);assert.equal(projection.document.pagesById.page.objects.label.parentId,'root');
  entry.record.replica.history('undo');
  assert.deepEqual(projection.document,entry.record.replica.document);assert.equal(projection.document.pagesById.page.objects.board.type,'frame');assert.equal(projection.document.pagesById.page.objects.label.parentId,'board');
  assert.ok(deltas.at(-1).changes.some(([key])=>key===JSON.stringify(['shape','page','board','type'])));
  entry.record.replica.history('redo');assert.deepEqual(projection.document,entry.record.replica.document);
});

test('renderer deltas restore every declaration when a historical page becomes visible again',async t=>{
  let projection;
  const {manager}=await fixture(t,{onEvent(entry,event){if(event.type==='document-delta')projection?.accept(event);}});
  const document=documentFixture();document.pages.push('other');document.pagesById.other={...structuredClone(document.pagesById.page),id:'other',name:'Other page'};
  const entry=await manager.create('Pages',document);projection=new DocumentProjection(manager.snapshot(entry));
  const before=entry.record.replica.document,after=structuredClone(before);after.pages=['other'];delete after.pagesById.page;
  entry.record.replica.patch(changesBetween(before,after),'Delete page');assert.deepEqual(projection.document,entry.record.replica.document);
  entry.record.replica.history('undo');assert.deepEqual(projection.document,entry.record.replica.document);assert.equal(projection.document.pagesById.page.objects.label.text,'Hello');
});

test('a legacy aggregate asset update cannot erase independent per-ID renderer declarations',async t=>{
  let projection;
  const {manager}=await fixture(t,{onEvent(entry,event){if(event.type==='document-delta')projection?.accept(event);}});
  const document=documentFixture();document.assets={owned:{src:'https://example.test/owned.png'}};
  const entry=await manager.create('Assets',document);projection=new DocumentProjection(manager.snapshot(entry));
  const remote=new Replica({state:entry.record.replica.state});t.after(()=>remote.destroy());
  remote.ydoc.transact(()=>remote.fields.set(JSON.stringify(['meta','assets']),{owned:{src:'https://example.test/stale.png'},legacy:{src:'https://example.test/legacy.png'}}));
  entry.record.replica.receive(remote.state);
  assert.deepEqual(projection.document,entry.record.replica.document);assert.equal(projection.document.assets.owned.src,'https://example.test/owned.png');assert.ok(projection.document.assets.legacy);
});
