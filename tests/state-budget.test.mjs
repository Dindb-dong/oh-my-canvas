import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import {Replica} from '../core/replica.mjs';
import {MAX_STATE_BYTES,materialize} from '../core/document.mjs';
import {localMapStateBound,supportsLocalMapBound} from '../core/state-budget.mjs';
import {documentFixture} from './helpers.mjs';

const key=(...parts)=>JSON.stringify(parts);
function simulatedHistory(replica,direction){
  const trial=replica.trial(),undo=new Y.UndoManager(trial.getMap('fields'),{captureTimeout:0});
  try{undo.undoStack=structuredClone(replica.undo.undoStack);undo.redoStack=structuredClone(replica.undo.redoStack);undo[direction]();return materialize(trial.getMap('fields'));}
  finally{undo.destroy();trial.destroy();}
}
function assertCeiling(replica){
  const exact=Y.encodeStateAsUpdate(replica.ydoc).byteLength;
  assert.ok(exact<=replica.encodedStateCeiling,`${exact} exceeds ${replica.encodedStateCeiling}`);
  assert.ok(replica.encodedStateCeiling<=MAX_STATE_BYTES);
  return exact;
}

test('ordinary local validation encodes only its transaction, without revisiting unrelated state payloads',()=>{
  const events=[],replica=new Replica({document:documentFixture(),onMetric:event=>events.push(event)});
  try{
    replica.validator();
    replica.patch([[key('page','page','name'),'Prepare mirror']]);
    const untouched=replica.validationDoc.getMap('fields')._map.get(key('shape','page','label','text')),write=untouched.write;
    untouched.write=()=>{throw Error('Unrelated payload was serialized');};
    try{replica.patch([[key('page','page','name'),'Small edit']]);}finally{untouched.write=write;}
    assert.equal(events.at(-1).sizeValidation,'bounded');assert.equal(events.at(-1).encodeStateMs,0);assert.equal(replica.cachedState,undefined);assertCeiling(replica);
    const exact=replica.state.byteLength;assert.equal(replica.encodedStateCeiling,exact);
  }finally{replica.destroy();}
});

test('the first scalar edit validates before publication without allocating a full speculative mirror',()=>{
  const events=[],replica=new Replica({document:documentFixture(),onMetric:event=>events.push(event)});
  try{
    Object.defineProperty(replica,'state',{configurable:true,get(){throw Error('Whole-state access during a scalar edit');}});
    replica.patch([[key('page','page','name'),'First fast edit']]);assert.equal(replica.validationDoc,null);assert.equal(events.at(-1).sizeValidation,'bounded');assertCeiling(replica);
    const document=replica.document,ceiling=replica.encodedStateCeiling,revision=replica.revision;
    assert.throws(()=>replica.patch([[key('shape','page','label','x'),Infinity]]),/geometry/);
    assert.equal(replica.document,document);assert.equal(replica.revision,revision);assert.equal(replica.encodedStateCeiling,ceiling);
    delete replica.state;replica.history('undo');assert.equal(replica.document.pagesById.page.name,'Canvas');assertCeiling(replica);
  }finally{replica.destroy();}
});

test('the V1 bound survives clock and value-length thresholds, GC, Undo and repeated property replacements',()=>{
  const replica=new Replica({document:documentFixture()});
  try{
    replica.validator().clientID=127;
    const lengths=[0,1,126,127,128,129,16383,16384];
    for(let i=0;i<280;i++){
      const field=i%3===0?key('page','page','name'):key('meta','note-'+(i%7));
      const value=i%4===0?{unicode:'한🙂',escaped:'"\n\\',nested:[null,true,i]}:'x'.repeat(lengths[i%lengths.length]);
      replica.patch([[field,value]],'Edit',undefined,{recordHistory:i%3!==0});assertCeiling(replica);
      if(i%41===0){replica.history('undo');assertCeiling(replica);replica.history('redo');assertCeiling(replica);}
      if(i%67===0){replica.undo.clear();replica.patch([[key('meta','collected'),i]],'Collect',undefined,{recordHistory:false});assertCeiling(replica);}
    }
  }finally{replica.destroy();}
});

test('new clients across V1 client-count and identifier thresholds reset exact budgets before further local edits',()=>{
  const replica=new Replica({document:documentFixture()});
  try{
    for(const client of [...Array.from({length:130},(_,i)=>i+1),16383,16384,2097151,2097152]){
      const peer=new Replica({state:replica.state});
      try{peer.validator().clientID=client;peer.patch([[key('meta','peer-'+client),'v'+client]]);replica.receive(peer.state);}finally{peer.destroy();}
      assertCeiling(replica);replica.patch([[key('page','page','name'),'Client '+client]],'Rename',undefined,{recordHistory:false});assertCeiling(replica);
    }
  }finally{replica.destroy();}
});

test('a conservative ceiling near capacity falls back to exact encoding and releases accumulated slack',()=>{
  const events=[],replica=new Replica({document:documentFixture(),onMetric:event=>events.push(event)});
  try{
    replica.validator();replica.encodedStateCeiling=MAX_STATE_BYTES-1;
    replica.patch([[key('page','page','name'),'Still fits']]);
    assert.equal(events.at(-1).sizeValidation,'exact');assert.ok(replica.encodedStateCeiling<65536);assertCeiling(replica);
    const document=replica.document,state=replica.state,ceiling=replica.encodedStateCeiling;
    assert.throws(()=>replica.patch([[key('shape','page','label','x'),Infinity]]),/geometry/);
    assert.equal(replica.document,document);assert.deepEqual(replica.state,state);assert.equal(replica.encodedStateCeiling,ceiling);
    assert.equal(localMapStateBound(Number.MAX_SAFE_INTEGER,1,1),null);
  }finally{replica.destroy();}
});

test('loaded-history validation uses the live client identifier width before publishing its exact ceiling',()=>{
  const seed=new Replica({document:documentFixture()}),replica=new Replica({state:seed.state});seed.destroy();
  try{
    replica.ydoc.clientID=0xffffffff;replica.validator().clientID=1;
    replica.patch([[key('page','page','name'),'Undo under a wider live client'],[key('meta','history-test'),'first']]);
    const trial=replica.trial();try{assert.equal(trial.clientID,0xffffffff);}finally{trial.destroy();}
    replica.history('undo');assertCeiling(replica);assert.equal(replica.document.pagesById.page.name,'Canvas');
    replica.history('redo');assertCeiling(replica);assert.equal(replica.document.pagesById.page.name,'Undo under a wider live client');
  }finally{replica.destroy();}
});

test('consecutive Undo and redo dry-runs follow live redone chains instead of validating a stale value',()=>{
  const replica=new Replica({document:documentFixture()});
  try{
    for(const name of ['A','B','C'])replica.patch([[key('page','page','name'),name]],name);
    for(const [direction,expected] of [['undo','B'],['undo','A'],['undo','Canvas'],['redo','A'],['redo','B'],['redo','C'],['undo','B'],['undo','A']]){
      const predicted=simulatedHistory(replica,direction);assert.equal(predicted.pagesById.page.name,expected);
      replica.history(direction);assert.deepEqual(replica.document,predicted);assertCeiling(replica);
    }
  }finally{replica.destroy();}
});

test('a second Undo preflights the large payload it actually restores and rejects before the state cap',()=>{
  const document=documentFixture();document.notes='original';
  const replica=new Replica({document});
  try{
    replica.patch([[key('meta','notes'),'A'.repeat(8*1024*1024)]],'Large A');
    replica.patch([[key('meta','notes'),'B']],'Small B');replica.patch([[key('meta','notes'),'C']],'Small C');
    replica.history('undo');assert.equal(replica.document.notes,'B');
    const predicted=simulatedHistory(replica,'undo');assert.equal(predicted.notes.length,8*1024*1024);assert.equal(predicted.notes[0],'A');
    const before=replica.document,state=replica.state,revision=replica.revision;
    assert.throws(()=>replica.history('undo'),/exceed.*16 MiB/);
    assert.equal(replica.document,before);assert.equal(replica.revision,revision);assert.deepEqual(replica.state,state);assertCeiling(replica);
  }finally{replica.destroy();}
});

test('history rejects conservative near-capacity growth before publishing a mutation',()=>{
  const document=documentFixture();document.notes='x'.repeat(MAX_STATE_BYTES-10000);
  const replica=new Replica({document});
  try{
    const padding=MAX_STATE_BYTES-replica.state.byteLength-384;
    replica.patch([[key('meta','notes'),document.notes+'x'.repeat(padding)]],'Fill',undefined,{recordHistory:false});
    replica.patch([[key('page','page','name'),'Changed']],'Rename');
    const before=replica.document,state=replica.state,revision=replica.revision;
    assert.throws(()=>replica.history('undo'),/History operation may exceed/);
    assert.equal(replica.document,before);assert.equal(replica.revision,revision);assert.deepEqual(replica.state,state);assertCeiling(replica);
  }finally{replica.destroy();}
});

test('binary shared content and pending causal updates use exact validation instead of the atomic-register bound',()=>{
  const events=[],replica=new Replica({document:documentFixture(),onMetric:event=>events.push(event)}),source=new Y.Doc();
  try{
    const binary=key('meta','binary');replica.patch([[binary,new Uint8Array([1,2,3])]]);
    assert.equal(events.at(-1).sizeValidation,'exact');assert.equal(supportsLocalMapBound(replica.ydoc,[binary]),false);assertCeiling(replica);
    const updates=[];source.on('update',update=>updates.push(update));source.getMap('fields').set(key('meta','causal'),'first');source.getMap('fields').set(key('meta','causal'),'second');
    replica.receive(updates[1]);assert.ok(replica.ydoc.store.pendingStructs);assertCeiling(replica);
    replica.patch([[key('page','page','name'),'Pending dependency']]);assert.equal(events.at(-1).sizeValidation,'exact');assertCeiling(replica);
    replica.receive(updates[0]);assert.equal(replica.document.causal,'second');assertCeiling(replica);
  }finally{source.destroy();replica.destroy();}
});
