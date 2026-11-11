import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DocumentProjection} from '../core/projection.mjs';
import {createSnapshotResync,commitErrorMessage,permanentCommitFailure} from '../src/document-sync.mjs';
import {documentFixture} from './helpers.mjs';

const snapshot=revision=>({id:'document',generation:1,document:documentFixture(),revision,ack:0,acceptedSeq:0});
const tick=()=>new Promise(resolve=>setImmediate(resolve));

test('a newer lost revision during an in-flight snapshot triggers another snapshot',async()=>{
  const projection=new DocumentProjection(snapshot(0)),requests=[];
  const sync=createSnapshotResync({getRevision:()=>projection.revision,accept:value=>projection.accept(value),snapshot:()=>new Promise(resolve=>requests.push(resolve))});
  assert.equal(projection.accept({id:'document',generation:1,type:'document-delta',fromRevision:1,revision:2,changes:[]}).resync,true);
  const first=sync.request(2);assert.equal(requests.length,1);
  assert.equal(projection.accept({id:'document',generation:1,type:'document-delta',fromRevision:3,revision:4,changes:[]}).resync,true);
  assert.equal(sync.request(4),first);
  requests[0](snapshot(2));await tick();assert.equal(requests.length,2);assert.equal(projection.revision,2);
  requests[1](snapshot(4));await first;assert.equal(projection.revision,4);assert.equal(sync.target,4);assert.equal(sync.pending,null);
});

test('forced rebase requires a snapshot requested after the force call',async()=>{
  const projection=new DocumentProjection(snapshot(0)),requests=[];
  const sync=createSnapshotResync({getRevision:()=>projection.revision,accept:value=>projection.accept(value),snapshot:()=>new Promise(resolve=>requests.push(resolve))});
  const first=sync.request(1);sync.request(0,{force:true});
  requests[0](snapshot(1));await tick();assert.equal(requests.length,2);
  requests[1](snapshot(1));await first;assert.equal(projection.revision,1);
});

test('a gap arriving while the completed resync Promise is clearing is not lost',async()=>{
  let revision=0,calls=0,sync;
  sync=createSnapshotResync({getRevision:()=>revision,snapshot:async()=>snapshot(++calls),accept:value=>{
    revision=value.revision;
    if(revision===1)queueMicrotask(()=>queueMicrotask(()=>sync.request(2)));
  }});
  await sync.request(1);assert.equal(revision,2);assert.equal(calls,2);assert.equal(sync.pending,null);
});

test('resync attempts are bounded and retain their unmet target for an explicit retry',async()=>{
  const projection=new DocumentProjection(snapshot(0));let calls=0,latest=1;
  const sync=createSnapshotResync({maxAttempts:3,getRevision:()=>projection.revision,accept:value=>projection.accept(value),snapshot:async()=>{calls++;return snapshot(latest);}});
  await assert.rejects(sync.request(5),{code:'resync_required'});assert.equal(calls,3);assert.equal(sync.target,5);assert.equal(projection.revision,1);
  latest=5;await sync.wait();assert.equal(calls,4);assert.equal(projection.revision,5);
});

test('revisions observed during mounting are synchronized once the runtime can accept snapshots',async()=>{
  let revision=0,calls=0;
  const sync=createSnapshotResync({getRevision:()=>revision,accept:value=>{revision=value.revision;},snapshot:async()=>{calls++;return snapshot(7);}});
  sync.note(4);sync.note(7);sync.note(3);assert.equal(calls,0);
  await sync.wait();assert.equal(revision,7);assert.equal(calls,1);
});

test('IPC-stable retry tags prevent filesystem errors from being discarded as invalid edits',()=>{
  const rejected=Error("Error invoking remote method: [commit_rejected] Invalid patch");
  const retry=Error("Error invoking remote method: [commit_retry] Invalid filesystem argument");
  assert.equal(permanentCommitFailure(rejected),true);assert.equal(permanentCommitFailure(retry),false);
  assert.equal(permanentCommitFailure(Error('Unknown temporary failure')),false);
  assert.equal(permanentCommitFailure(Error('[sequence_gap] Resolve edit 1 first')),false);
  assert.equal(commitErrorMessage(retry),'Error invoking remote method: Invalid filesystem argument');
});
