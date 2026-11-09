import {test} from 'node:test';
import assert from 'node:assert/strict';
import {canvasTitle,renameDocument} from '../electron/document-actions.mjs';
import {createWorkspaceReplay} from '../src/workspace-mcp.js';

test('rename validates titles before loading and publishes only after persistence',async()=>{
  let loads=0,destroyed=0,saved;
  const current={id:'active',title:'Before',replica:{destroy(){destroyed++;}}};
  const inactive={id:'inactive',title:'Other',replica:{destroy(){destroyed++;}}};
  const store={async load(){loads++;return inactive;},async save(record){saved=record;assert.equal(current.title,'Before');}};
  for(const title of [null,{},'', '   ','x'.repeat(121)])await assert.rejects(renameDocument(store,current,'inactive',title),/Invalid canvas title/);
  assert.equal(loads,0);assert.equal(canvasTitle('  Canvas  '),'Canvas');
  assert.deepEqual(await renameDocument(store,current,'active','  After  '),{id:'active',title:'After'});
  assert.equal(saved.title,'After');assert.equal(destroyed,0);assert.equal(current.title,'After');
  store.save=async record=>{saved=record;};
  assert.deepEqual(await renameDocument(store,current,'inactive','Other renamed'),{id:'inactive',title:'Other renamed'});
  assert.equal(current.title,'After');assert.equal(destroyed,1);assert.equal(saved.replica,inactive.replica);
});

test('failed rename preserves the current metadata and releases inactive replicas',async()=>{
  let destroyed=0;
  const current={id:'active',title:'Kept',replica:{destroy(){throw Error('Active replica must survive');}}};
  const store={async save(){throw Error('Disk unavailable');},async load(id){return {id,title:'Other',replica:{destroy(){destroyed++;}}};}};
  await assert.rejects(renameDocument(store,current,'active','Rejected'),/Disk unavailable/);
  assert.equal(current.title,'Kept');
  await assert.rejects(renameDocument(store,current,'inactive','Rejected'),/Disk unavailable/);assert.equal(destroyed,1);
});

test('workspace retries share pending and completed results across editor mounts',async()=>{
  const replay=createWorkspaceReplay();let writes=0,finish;
  const task=()=>{writes++;return new Promise(resolve=>{finish=resolve;});};
  const first=replay.run('A','key','create_document',{title:'A'},task);
  const retry=replay.run('A','key','create_document',{title:'A'},task);
  assert.equal(first,retry);await Promise.resolve();assert.equal(writes,1);
  finish({id:'document-A'});assert.deepEqual(await retry,{id:'document-A'});
  assert.equal(replay.run('A','key','create_document',{title:'A'},task),first);
  assert.throws(()=>replay.run('A','key','create_document',{title:'B'},task),/different request/);
  assert.deepEqual(await replay.run('B','key','create_document',{title:'A'},async()=>({id:'document-B'})),{id:'document-B'});
  replay.end('A');assert.deepEqual(await replay.run('A','key','create_document',{title:'A'},async()=>({id:'new-session'})),{id:'new-session'});
});

test('failed uncertain mutations retain their retry outcome and replay storage is bounded',async()=>{
  const replay=createWorkspaceReplay();let writes=0;
  const mutate=()=>{writes++;throw Error('Lost response after persistence');};
  await assert.rejects(replay.run('A','uncertain','create_document',{},mutate),/Lost response/);
  await assert.rejects(replay.run('A','uncertain','create_document',{},mutate),/Lost response/);assert.equal(writes,1);
  for(const key of ['',123,'x'.repeat(201)])assert.throws(()=>replay.run('A',key,'create_document',{},mutate),/Invalid idempotency/);
  for(let i=0;i<101;i++)await replay.run('A',String(i),'create_document',{},async()=>i);
  assert.equal(await replay.run('A','0','create_document',{},async()=>102),102);
  replay.end();assert.equal(await replay.run('A','100','create_document',{},async()=>103),103);
});
