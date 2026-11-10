import {test} from 'node:test';
import assert from 'node:assert/strict';
import {assertDocument,assertDocumentChanges,documentLimits,MAX_DOCUMENT_BYTES} from '../core/document.mjs';
import {documentFixture} from './helpers.mjs';

const bytes=value=>Buffer.byteLength(JSON.stringify(value));
const objectsIn=(before,objects)=>({...before,pagesById:{...before.pagesById,page:{...before.pagesById.page,objects}}});
const changeLabel=(before,fields)=>objectsIn(before,{...before.pagesById.page.objects,label:{...before.pagesById.page.objects.label,...fields}});
function atLimit(){
  const doc=documentFixture();doc.padding='';doc.padding='x'.repeat(MAX_DOCUMENT_BYTES-bytes(doc));
  assert.equal(bytes(doc),MAX_DOCUMENT_BYTES);return assertDocument(doc);
}
function checkBytes(before,after){
  const within=bytes(after)<=documentLimits(after).documentBytes;
  if(within){assert.doesNotThrow(()=>assertDocumentChanges(before,after));assert.doesNotThrow(()=>assertDocument(after));}
  else{assert.throws(()=>assertDocumentChanges(before,after),/MiB/);assert.throws(()=>assertDocument(after),/MiB/);}
}

test('dictionary deltas enforce exact bytes through scalar changes, escapes, additions and removals',()=>{
  const before=atLimit(),old=before.pagesById.page.objects;
  checkBytes(before,changeLabel(before,{name:'Hello'}));
  checkBytes(before,changeLabel(before,{name:'Hello!'}));
  checkBytes(before,changeLabel(before,{name:'\ud800\n한'}));
  checkBytes(before,changeLabel(before,{text:undefined,type:'rect'}));
  checkBytes(before,changeLabel(before,{extra:[undefined,NaN,Infinity,-0,{'"\\\n':'😀'}]}));
  const removed={...old};delete removed.label;checkBytes(before,objectsIn(before,removed));
  // Equal dictionary counts do not prove unchanged membership: the old member
  // and its punctuation must be removed even when a new member replaces it.
  const id='escaped-"\\\n\ud800';
  const replaced={...removed,[id]:{...old.label,id,name:'replacement'}};
  checkBytes(before,objectsIn(before,replaced));
  const small=assertDocument(objectsIn(before,removed));
  const restored=objectsIn(small,{...small.pagesById.page.objects,label:old.label});
  assert.equal(bytes(restored),MAX_DOCUMENT_BYTES);checkBytes(small,restored);
  checkBytes(restored,changeLabel(restored,{text:'Hello!'}));
});

test('caller hints cannot hide invalid changed or newly enumerable shapes',()=>{
  const before=assertDocument(documentFixture());
  for(const fields of [{x:1e9},{width:NaN},{id:'other'},{type:'unknown'}]){
    const after=changeLabel(before,fields);
    for(const hint of [undefined,{paths:[]},{paths:[['pagesById','page','name']]}])
      assert.throws(()=>assertDocumentChanges(before,after,hint),/geometry|shape graph/);
  }
  // An absent old member and a present undefined member are not equivalent.
  assert.throws(()=>assertDocumentChanges(before,objectsIn(before,{...before.pagesById.page.objects,bad:undefined})),/shape graph/);
  const dormant=documentFixture();
  Object.defineProperty(dormant.pagesById.page.objects,'hidden',{value:{id:'hidden',type:'rect',x:1e9},enumerable:false});
  assertDocument(dormant);
  const activated=objectsIn(dormant,{...dormant.pagesById.page.objects,hidden:dormant.pagesById.page.objects.hidden});
  assert.throws(()=>assertDocumentChanges(dormant,activated),/geometry/);
});

test('byte and object capacity reductions recheck unchanged validated dictionaries',()=>{
  const ordinary=atLimit();
  const large=assertDocument({...ordinary,capacityProfile:'large-library',padding:ordinary.padding+'x'});
  const lower={...large};delete lower.capacityProfile;
  assert.equal(bytes(lower),MAX_DOCUMENT_BYTES+1);assert.throws(()=>assertDocumentChanges(large,lower),/16 MiB/);
  const populated=documentFixture();populated.capacityProfile='large-library';
  for(let index=0;index<20000;index++)populated.pagesById.page.objects['extra-'+index]={id:'extra-'+index,type:'rect'};
  assertDocument(populated);
  const fewer={...populated};delete fewer.capacityProfile;
  assert.throws(()=>assertDocumentChanges(populated,fewer),/shape graph/);
});

test('untrusted mutable snapshots and changed container types retain full exact validation',()=>{
  const doc=atLimit(),label=doc.pagesById.page.objects.label;
  // A full import/snapshot boundary must ignore all earlier immutable proofs.
  label.text+='x';assert.throws(()=>assertDocument(doc),/16 MiB/);
  const untrusted={...doc},shared=objectsIn(untrusted,{...untrusted.pagesById.page.objects});
  assert.throws(()=>assertDocumentChanges(untrusted,shared,{paths:[]}),/16 MiB/);
  label.x=1e9;assert.throws(()=>assertDocument(doc),/geometry/);

  const arrayDocument=documentFixture(),array=[];
  Object.assign(array,arrayDocument.pagesById.page.objects);arrayDocument.pagesById.page.objects=array;
  arrayDocument.padding='';arrayDocument.padding='x'.repeat(MAX_DOCUMENT_BYTES-bytes(arrayDocument));
  assertDocument(arrayDocument);
  const plain=objectsIn(arrayDocument,{...array});
  assert.ok(bytes(plain)>MAX_DOCUMENT_BYTES);assert.throws(()=>assertDocumentChanges(arrayDocument,plain),/16 MiB/);
});

test('a leaf edit does not reserialize all unchanged dictionary key bytes',t=>{
  const doc=documentFixture();
  for(let index=0;index<1000;index++){
    const id=('long-uncached-shape-'+index+'-').padEnd(160,'x');
    doc.pagesById.page.objects[id]={id,type:'rect',x:0};
  }
  assertDocument(doc);
  const encode=TextEncoder.prototype.encode;let allocations=0;
  t.mock.method(TextEncoder.prototype,'encode',function(...args){allocations++;return encode.apply(this,args);});
  assertDocumentChanges(doc,changeLabel(doc,{x:31}));
  assert.ok(allocations<20,`One leaf edit allocated ${allocations} UTF-8 key buffers`);
});
