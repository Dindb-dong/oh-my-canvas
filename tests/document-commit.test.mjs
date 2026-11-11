import {test} from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {Replica} from '../core/replica.mjs';
import {Store} from '../core/storage.mjs';
import {DocumentProjection} from '../core/projection.mjs';
import {commitDocument} from '../electron/document-commit.mjs';
import {drainPendingCommits,createDocumentWriteQueue,permanentCommitFailure} from '../src/document-sync.mjs';
import {documentFixture} from './helpers.mjs';

const rename=name=>[[JSON.stringify(['page','page','name']),name]];
const io=message=>Object.assign(Error(message),{code:'EIO'});
async function fixture(t){
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'omc-commit-')),store=new Store(directory);
  const record={id:randomUUID(),title:'Sequence test',replica:new Replica({document:documentFixture()})};
  const entry={record,seq:0,acceptedSeq:0,revision:0,generation:1};
  record.replica.onUpdate(()=>{entry.revision++;if(entry.committingSeq!==undefined)entry.acceptedSeq=entry.committingSeq;});
  t.after(async()=>{await store.flushPreviews();record.replica.destroy();await fs.rm(directory,{recursive:true,force:true});});
  const acknowledgment=()=>({type:'commit-ack',id:record.id,generation:entry.generation,revision:entry.revision,ack:entry.seq,acceptedSeq:entry.acceptedSeq});
  const snapshot=()=>({...acknowledgment(),document:record.replica.document});
  const options={store,save:()=>store.save(record),confirmGeneration:(e,generation)=>{if(e.generation!==generation)throw Object.assign(Error('Runtime restarted'),{code:'runtime_restarted'});},acknowledgment};
  await store.save(record);
  return {entry,record,store,options,snapshot};
}

function renderer(f,{onRejected=()=>{},invokeHistory}={}){
  const projection=new DocumentProjection(f.snapshot()),calls=[];
  const project=async message=>{const result=projection.accept(message);if(result.resync)projection.accept(f.snapshot());};
  const drain=through=>drainPendingCommits({getProjection:()=>projection,commit:item=>{calls.push(item.discard?`${item.seq} discard`:item.seq);return commitDocument(f.entry,item,f.options);},project,refresh:()=>project(f.snapshot()),onRejected},through);
  const writes=createDocumentWriteQueue({drain,wait:async()=>{},flush:()=>f.options.save(f.entry),invokeHistory:invokeHistory??(async()=>false),project});
  return {projection,calls,writes,project};
}

test('host rejects sequence gaps before asset preparation or document mutation',async t=>{
  const f=await fixture(t),before=f.record.replica.document;
  let prepared=0;f.options.store={prepareChanges:async changes=>{prepared++;return changes;}};
  await assert.rejects(commitDocument(f.entry,{seq:2,changes:rename('Skipped')},f.options),{code:'sequence_gap'});
  assert.equal(prepared,0);assert.equal(f.entry.acceptedSeq,0);assert.equal(f.entry.seq,0);assert.equal(f.record.replica.document,before);
});

test('later queued edit retries failed asset persistence before advancing cumulative ACK',async t=>{
  const f=await fixture(t),put=f.store.assets.put.bind(f.store.assets);
  let failed=false;f.store.assets.put=async(...args)=>{if(!failed){failed=true;throw io('Image fsync failed');}return put(...args);};
  const r=renderer(f),src='data:image/png;base64,'+Buffer.from('image original bytes').toString('base64');
  r.projection.enqueue({seq:1,changes:[[JSON.stringify(['assets','image']),{id:'image',kind:'image',src}]]});
  const first=assert.rejects(r.writes.commit(1),{code:'commit_retry'});
  r.projection.enqueue({seq:2,changes:rename('Later name')});
  const second=r.writes.commit(2);await Promise.all([first,second]);
  assert.deepEqual(r.calls,[1,1,2]);assert.equal(r.projection.ack,2);assert.equal(r.projection.pending.length,0);
  const document=f.record.replica.document,reference=document.assets.image.src;
  assert.match(reference,/^omc-asset:sha256:/);assert.equal(document.pagesById.page.name,'Later name');
  assert.equal((await f.store.assets.get(reference.slice(-64))).bytes.toString(),'image original bytes');
  const reopened=await new Store(f.store.dir).load(f.record.id);
  try{assert.deepEqual(reopened.replica.document,document);}finally{reopened.replica.destroy();}
});

test('accepted write with failed durability cannot be discarded and duplicate ACK retries save',async t=>{
  const f=await fixture(t),save=f.options.save;
  let saves=0;f.options.save=async()=>{if(++saves===1)throw Object.assign(Error('Invalid filesystem argument'),{code:'EINVAL'});await save();};
  let failure;
  try{await commitDocument(f.entry,{seq:1,changes:rename('Accepted')},f.options);}catch(error){failure=error;}
  assert.equal(failure.code,'commit_retry');assert.equal(permanentCommitFailure(failure),false);
  assert.equal(f.entry.acceptedSeq,1);assert.equal(f.entry.seq,0);assert.equal(f.entry.revision,1);
  const discarded=await commitDocument(f.entry,{seq:1,changes:[],discard:true},f.options);
  assert.equal(discarded.discarded,false);assert.equal(discarded.ack,1);assert.equal(saves,2);
  assert.equal(f.record.replica.document.pagesById.page.name,'Accepted');
  await commitDocument(f.entry,{seq:1,changes:rename('Never reapplied')},f.options);
  assert.equal(saves,3);assert.equal(f.entry.revision,1);assert.equal(f.record.replica.document.pagesById.page.name,'Accepted');
});

test('permanent rejection consumes only an explicit empty slot, then permits the next edit',async t=>{
  const f=await fixture(t),before=f.record.replica.document;
  await assert.rejects(commitDocument(f.entry,{seq:1,changes:[['bad JSON',0]]},f.options),{code:'commit_rejected'});
  await assert.rejects(commitDocument(f.entry,{seq:2,changes:rename('Too soon')},f.options),{code:'sequence_gap'});
  await assert.rejects(commitDocument(f.entry,{seq:1,changes:rename('Not empty'),discard:true},f.options),{code:'commit_rejected'});
  assert.equal(f.entry.acceptedSeq,0);
  const result=await commitDocument(f.entry,{seq:1,changes:[],discard:true},f.options);
  assert.equal(result.discarded,true);assert.equal(result.ack,1);assert.equal(f.record.replica.document,before);assert.equal(f.entry.revision,0);
  const retry=await commitDocument(f.entry,{seq:1,changes:[],discard:true},f.options);assert.equal(retry.discarded,false);
  await commitDocument(f.entry,{seq:2,changes:rename('Valid later edit')},f.options);
  assert.equal(f.entry.seq,2);assert.equal(f.record.replica.document.pagesById.page.name,'Valid later edit');
});

test('renderer discards a rejected slot and rebases before sending a later edit',async t=>{
  const f=await fixture(t),rejected=[],r=renderer(f,{onRejected:seq=>rejected.push(seq)});
  r.projection.enqueue({seq:1,changes:[['bad JSON',0]]});r.projection.enqueue({seq:2,changes:rename('Good edit')});
  await r.writes.commit(2);
  assert.deepEqual(r.calls,[1,'1 discard',2]);assert.deepEqual(rejected,[1]);
  assert.equal(r.projection.ack,2);assert.equal(r.projection.pending.length,0);assert.equal(r.projection.projected.pagesById.page.name,'Good edit');
});

test('history waits for earlier durability, preserves later queued edits, and does not run after failure',async t=>{
  const f=await fixture(t),save=f.options.save;let blocked=true,historyCalls=0;
  f.options.save=async()=>{if(blocked)throw io('Disk unavailable');await save();};
  const r=renderer(f,{invokeHistory:async action=>{historyCalls++;assert.equal(f.entry.seq,1);f.record.replica.history(action);await save();return f.snapshot();}});
  r.projection.enqueue({seq:1,changes:rename('Before Undo')});
  await assert.rejects(r.writes.commit(1),{code:'commit_retry'});
  await assert.rejects(r.writes.history('undo',{},1),{code:'commit_retry'});assert.equal(historyCalls,0);
  blocked=false;
  const history=r.writes.history('undo',{},1);
  r.projection.enqueue({seq:2,changes:rename('After Undo')});const later=r.writes.commit(2);
  await history;await later;
  assert.equal(historyCalls,1);assert.equal(f.record.replica.document.pagesById.page.name,'After Undo');assert.equal(r.projection.ack,2);
  assert.deepEqual(r.calls,[1,1,1,2]);
});

test('asset preparation cannot publish into a restarted renderer generation',async t=>{
  const f=await fixture(t);let finish;
  f.options.store={prepareChanges:()=>new Promise(resolve=>{finish=resolve;})};
  const task=commitDocument(f.entry,{seq:1,changes:rename('Old renderer')},f.options);
  f.entry.generation++;finish(rename('Old renderer'));
  await assert.rejects(task,{code:'runtime_restarted'});assert.equal(f.entry.acceptedSeq,0);assert.equal(f.record.replica.document.pagesById.page.name,'Canvas');
});
