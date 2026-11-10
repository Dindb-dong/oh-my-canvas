import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Replica} from '../core/replica.mjs';
import {changesBetween,flatten,materialize} from '../core/document.mjs';
import {documentFixture} from './helpers.mjs';
import * as Y from 'yjs';
test('document model roundtrips through field-level representation',()=>{const doc=documentFixture();assert.deepEqual(materialize(flatten(doc)),doc);});
test('an empty patch preserves state, revision and history without creating a validation mirror',()=>{
 const replica=new Replica({document:documentFixture()});
 try{
  replica.patch([[JSON.stringify(['page','page','name']),'Existing edit']],'Rename','one');
  const document=replica.document,state=replica.state,revision=replica.revision,history=[...replica.undo.undoStack],ceiling=replica.encodedStateCeiling;
  assert.equal(replica.validationDoc,null);
  replica.validator=()=>{throw Error('A no-op must not allocate a validation mirror');};
  replica.patch([],'No change','different');
  assert.equal(replica.document,document);assert.equal(replica.state,state);assert.equal(replica.revision,revision);assert.equal(replica.encodedStateCeiling,ceiling);
  assert.deepEqual(replica.undo.undoStack,history);assert.equal(replica.undo.undoStack[0],history[0]);assert.equal(history[0].meta.get('label'),'Rename');assert.equal(history[0].meta.get('group'),'one');
  assert.equal(replica.validationDoc,null);
 }finally{replica.destroy();}
});
test('an empty input patch still publishes missing recovery declarations',()=>{
 const seed=new Replica({document:documentFixture()}),raw=new Y.Doc();Y.applyUpdate(raw,seed.state);seed.destroy();
 const alive=JSON.stringify(['page','page','alive']),root=JSON.stringify(['shape','page','root','alive']);
 raw.transact(()=>{raw.getMap('fields').set(alive,false);raw.getMap('fields').set(root,false);});
 const replica=new Replica({state:Y.encodeStateAsUpdate(raw)});raw.destroy();
 try{
  assert.equal(replica.fields.get(alive),false);assert.equal(replica.fields.get(root),false);assert.equal(replica.document.pages.length,1);
  const revision=replica.revision;replica.patch([],'Recover');
  assert.equal(replica.fields.get(alive),true);assert.equal(replica.fields.get(root),true);assert.ok(replica.revision>revision);
  assert.deepEqual(replica.document,materialize(replica.fields));
 }finally{replica.destroy();}
});
test('document seeding performs one full state encode and retains first-edit capture semantics',t=>{
 const write=Y.Item.prototype.write;let encodedItems=0;
 t.mock.method(Y.Item.prototype,'write',function(...args){encodedItems++;return write.apply(this,args);});
 const document=documentFixture();document.assets={image:{src:'omc-asset:sha256:'+'a'.repeat(64)}};
 const replica=new Replica({document});
 try{
  const structs=[...replica.ydoc.store.clients.values()].reduce((count,items)=>count+items.length,0);
  assert.equal(encodedItems,structs);assert.equal(replica.revision,1);assert.equal(replica.updateLog.length,0);assert.equal(replica.retainedAssetRefs.has('a'.repeat(64)),true);
  const checkpoint=replica.captureSince();assert.equal(encodedItems,structs);assert.equal(checkpoint.full,true);
  replica.patch([[JSON.stringify(['page','page','name']),'First edit']]);const delta=replica.captureSince(checkpoint);
  assert.equal(delta.full,false);assert.ok(delta.update.byteLength<1024);
 }finally{replica.destroy();}
});
test('four offline replicas retain concurrent inserts, independent properties and embedded images',()=>{
  const a=new Replica({document:documentFixture()}), peers=Array.from({length:3},()=>new Replica({state:a.state}));const all=[a,...peers];
  all.forEach((r,i)=>{const before=r.document,after=structuredClone(before);after.pagesById.page.objects.label[['x','y','width','height'][i]]=100+i;const id=`shape-${i}`;after.pagesById.page.objects[id]={...after.pagesById.page.objects.label,id,type:'image',image:{src:'data:image/png;base64,iVBORw0KGgo='},parentId:'board'};after.pagesById.page.objects.board.childIds.push(id);r.patch(changesBetween(before,after));});
  const updates=all.map(r=>r.state);for(const r of all)for(const u of [...updates].reverse())r.receive(u);
  for(const r of all){assert.deepEqual(r.document,a.document);assert.equal(r.document.pagesById.page.objects.board.childIds.length,5);assert.equal(r.document.pagesById.page.objects.label.x,100);assert.equal(r.document.pagesById.page.objects.label.y,101);r.destroy();}
});
test('concurrent parent deletion and child insertion repair to root without resurrection',()=>{
  const a=new Replica({document:documentFixture()}),b=new Replica({state:a.state});
  const before=a.document,deleted=structuredClone(before);delete deleted.pagesById.page.objects.board;delete deleted.pagesById.page.objects.label;deleted.pagesById.page.objects.root.childIds=[];a.patch(changesBetween(before,deleted));
  const inserted=structuredClone(b.document);inserted.pagesById.page.objects.new={...inserted.pagesById.page.objects.label,id:'new'};inserted.pagesById.page.objects.board.childIds.push('new');b.patch(changesBetween(b.document,inserted));
  a.receive(b.state);b.receive(a.state);assert.deepEqual(a.document,b.document);assert.equal(a.document.pagesById.page.objects.new.parentId,'root');assert.equal(a.document.pagesById.page.objects.board,undefined);a.destroy();b.destroy();
});
test('local undo preserves another participant property edit',()=>{
  const a=new Replica({document:documentFixture()}),b=new Replica({state:a.state});let after=structuredClone(a.document);after.pagesById.page.objects.label.x=99;a.patch(changesBetween(a.document,after));b.receive(a.state);after=structuredClone(b.document);after.pagesById.page.objects.label.y=200;b.patch(changesBetween(b.document,after));a.receive(b.state);a.undo.undo();assert.equal(a.document.pagesById.page.objects.label.x,30);assert.equal(a.document.pagesById.page.objects.label.y,200);a.undo.redo();assert.equal(a.document.pagesById.page.objects.label.x,99);a.destroy();b.destroy();
});
test('invalid updates and malformed local documents leave state untouched',()=>{const r=new Replica({document:documentFixture()}),before=r.document;assert.throws(()=>r.receive(new Uint8Array([255,255,255])));assert.throws(()=>r.patch([[JSON.stringify(['shape','page','label','width']),Infinity]]));assert.deepEqual(r.document,before);r.destroy();});
function twoPages(){const d=documentFixture();d.pages.push('second');d.pagesById.second=structuredClone(d.pagesById.page);d.pagesById.second.id='second';return d;}
function removePage(r,id){const before=r.document,after=structuredClone(before);after.pages=after.pages.filter(p=>p!==id);delete after.pagesById[id];r.patch(changesBetween(before,after));}
test('concurrent distinct page deletions converge to the same editable recovery page and survive restart',()=>{
  const a=new Replica({document:twoPages()}),b=new Replica({state:a.state});removePage(a,'page');removePage(b,'second');const as=a.state,bs=b.state;a.receive(bs);b.receive(as);assert.deepEqual(a.document,b.document);assert.equal(a.document.pages.length,1);assert.deepEqual(a.document.pagesById[a.document.pages[0]].objects.root.childIds,[]);
  const before=a.document,after=structuredClone(before),pid=after.pages[0];after.pagesById[pid].name='Recovered and edited';a.patch(changesBetween(before,after));b.receive(a.state);assert.equal(b.document.pagesById[pid].name,'Recovered and edited');
  const reloaded=new Replica({state:b.state});assert.deepEqual(reloaded.document,a.document);a.destroy();b.destroy();reloaded.destroy();
});
test('undo after another participant deletes the original page remains valid, and redo restores the new page',()=>{
  const a=new Replica({document:documentFixture()}),b=new Replica({state:a.state});const after=twoPages();a.patch(changesBetween(a.document,after));b.receive(a.state);removePage(b,'page');a.receive(b.state);a.history('undo');assert.equal(a.document.pages.length,1);a.history('redo');assert.ok(a.document.pages.includes('second'));b.receive(a.state);assert.deepEqual(a.document,b.document);a.destroy();b.destroy();
});
test('speculative mirror is reused, discarded on rejection, and synchronized through undo and remote edits',()=>{
 const a=new Replica({document:documentFixture()}),b=new Replica({state:a.state});
 try{
  const edit=(r,name)=>{const before=r.document,after=structuredClone(before);after.pagesById.page.objects.label.name=name;r.patch(changesBetween(before,after),'user');};
  a.validator();edit(a,'First');const mirror=a.validationDoc;edit(a,'Second');assert.equal(a.validationDoc,mirror);
  const doc=a.document,state=Buffer.from(a.state);assert.throws(()=>a.patch([[JSON.stringify(['shape','page','label','width']),Infinity]]));assert.deepEqual(a.document,doc);assert.deepEqual(Buffer.from(a.state),state);assert.equal(a.validationDoc,null);
  a.validator();edit(a,'Third');assert.notEqual(a.validationDoc,mirror);a.history('undo');assert.equal(a.document.pagesById.page.objects.label.name,'Second');
  b.receive(a.state);edit(b,'Remote');a.receive(b.state);edit(a,'Final');b.receive(a.state);assert.deepEqual(a.document,b.document);
 }finally{a.destroy();b.destroy();}
});
test('immutable diff retains sibling order and metadata updates without touching shared shapes',()=>{
 const before=documentFixture(),page=before.pagesById.page;
 const after={...before,pagesById:{...before.pagesById,page:{...page,objects:{...page.objects,board:{...page.objects.board,childIds:['new','label']},new:{...page.objects.label,id:'new'}}}}};
 const r=new Replica({document:before});try{r.patch(changesBetween(before,after));assert.deepEqual(r.document,materialize(flatten(after)));}finally{r.destroy();}
});
test('persistent validation collects remote replacements without dropping local undo history',()=>{
 const receiver=new Replica({document:documentFixture()});let state=receiver.state;
 try{
  for(let i=0;i<9;i++){
   const sender=new Replica({state});try{const before=sender.document,after=structuredClone(before);after.pagesById.page.objects.label.name=String(i)+'x'.repeat(2*1024*1024);sender.patch(changesBetween(before,after));state=sender.state;receiver.receive(state);assert.equal(receiver.document.pagesById.page.objects.label.name[0],String(i));}finally{sender.destroy();}
  }
  const before=receiver.document,after=structuredClone(before);after.pagesById.page.objects.label.x=123;receiver.patch(changesBetween(before,after),'user');receiver.history('undo');assert.equal(receiver.document.pagesById.page.objects.label.x,30);receiver.history('redo');assert.equal(receiver.document.pagesById.page.objects.label.x,123);
 }finally{receiver.destroy();}
});
test('bounded persistence update log falls back to a complete checkpoint after eviction',()=>{
 const replica=new Replica({document:documentFixture()});
 try{
  const old=replica.captureSince();
  for(let i=0;i<520;i++)replica.patch([[JSON.stringify(['page','page','name']),String(i)]],'Rename',undefined,{recordHistory:false});
  const checkpoint=replica.captureSince(old);assert.equal(checkpoint.full,true);assert.ok(replica.updateLog.length<=512);
  const copy=new Replica({state:checkpoint.update});try{assert.deepEqual(copy.document,replica.document);}finally{copy.destroy();}
  replica.patch([[JSON.stringify(['page','page','name']),'Incremental']]);const delta=replica.captureSince(checkpoint);assert.equal(delta.full,false);assert.ok(delta.update.byteLength<1024);
  const replay=new Y.Doc();try{Y.applyUpdate(replay,checkpoint.update);Y.applyUpdate(replay,delta.update);const actual=new Replica({state:Y.encodeStateAsUpdate(replay)});try{assert.deepEqual(actual.document,replica.document);}finally{actual.destroy();}}finally{replay.destroy();}
 }finally{replica.destroy();}
});

test('an update larger than the log budget clears the gap and subsequent small deltas remain replayable',()=>{
 const document=documentFixture();document.notes='';const replica=new Replica({document});
 try{
  const previous=replica.captureSince();replica.patch([[JSON.stringify(['meta','notes']),'x'.repeat(5*1024*1024)]],'Large import',undefined,{recordHistory:false});
  assert.equal(replica.updateLog.length,0);assert.equal(replica.updateLogBytes,0);assert.equal(replica.captureSince(previous).full,true);
  const baseline={replica,revision:replica.revision};replica.patch([[JSON.stringify(['page','page','name']),'After large import']]);
  const delta=replica.captureSince(baseline);assert.equal(delta.full,false);assert.ok(delta.update.byteLength<1024);assert.equal(replica.updateLog.length,1);
 }finally{replica.destroy();}
});

test('topology validation uses retained Yjs declarations when only an alive register changes',()=>{
 const replica=new Replica({document:documentFixture()});
 try{
  const alive=JSON.stringify(['shape','page','label','alive']);
  replica.patch([[alive,false]],'Hide');assert.equal(replica.document.pagesById.page.objects.label,undefined);
  replica.patch([[alive,true]],'Restore');assert.equal(replica.document.pagesById.page.objects.label.type,'text');assert.equal(replica.document.pagesById.page.objects.label.text,'Hello');
  assert.deepEqual(replica.document,materialize(replica.fields));
  const before=replica.document,state=replica.state;
  assert.throws(()=>replica.patch([[JSON.stringify(['meta','assets','extra']),{}]]),/field key/);
  assert.equal(replica.document,before);assert.deepEqual(replica.state,state);
 }finally{replica.destroy();}
});

test('legacy aggregate register changes validate and cache the actual merged fields',()=>{
 const replica=new Replica({document:documentFixture()});
 try{
  const legacy=JSON.stringify(['meta','assets']);
  replica.patch([[legacy,{image:{src:'first'}}]],'Legacy assets');
  replica.patch([[legacy,{image:{src:'second'}}]],'Legacy assets');
  assert.equal(replica.document.assets.image.src,'second');assert.deepEqual(replica.document,materialize(replica.fields));
 }finally{replica.destroy();}
});

test('checkpoint and journal hydration applies all updates before one complete final validation',()=>{
 const seed=new Replica({document:documentFixture()}),checkpoint=seed.state,source=new Y.Doc(),updates=[],events=[];
 seed.destroy();Y.applyUpdate(source,checkpoint);source.on('update',update=>updates.push(update));
 const field=JSON.stringify(['shape','page','label','x']);source.getMap('fields').set(field,Infinity);source.getMap('fields').set(field,75);
 let replica;
 try{
  replica=new Replica({state:checkpoint,updates,onMetric:event=>events.push(event)});
  assert.equal(replica.document.pagesById.page.objects.label.x,75);assert.deepEqual(replica.document,materialize(source.getMap('fields')));
  assert.equal(events.filter(event=>event.stage==='replica-validation').length,1);assert.equal(events[0].incremental,false);assert.equal(events[0].sizeValidation,'exact');
  assert.equal(replica.updateLog.length,0);assert.equal(replica.undo.undoStack.length,0);
  const baseline={replica,revision:replica.revision};replica.patch([[JSON.stringify(['page','page','name']),'After replay']]);
  const delta=replica.captureSince(baseline);assert.equal(delta.full,false);assert.ok(delta.update.byteLength<1024);
  assert.throws(()=>new Replica({state:checkpoint,updates:[updates[0]]}),/geometry/);
  assert.throws(()=>new Replica({state:checkpoint,updates:[new Uint8Array([255,255])]}));
  assert.throws(()=>new Replica({state:new Uint8Array([255,255]),updates}),error=>error.hydrationPhase==='checkpoint');
  assert.throws(()=>new Replica({updates}),/require a checkpoint/);
 }finally{replica?.destroy();source.destroy();}
});
