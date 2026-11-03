import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Replica} from '../core/replica.mjs';
import {changesBetween,flatten,materialize} from '../core/document.mjs';
import {documentFixture} from './helpers.mjs';
test('document model roundtrips through field-level representation',()=>{const doc=documentFixture();assert.deepEqual(materialize(flatten(doc)),doc);});
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
  edit(a,'First');const mirror=a.validationDoc;edit(a,'Second');assert.equal(a.validationDoc,mirror);
  const doc=a.document,state=Buffer.from(a.state);assert.throws(()=>a.patch([[JSON.stringify(['shape','page','label','width']),Infinity]]));assert.deepEqual(a.document,doc);assert.deepEqual(Buffer.from(a.state),state);assert.equal(a.validationDoc,null);
  edit(a,'Third');assert.notEqual(a.validationDoc,mirror);a.history('undo');assert.equal(a.document.pagesById.page.objects.label.name,'Second');
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
