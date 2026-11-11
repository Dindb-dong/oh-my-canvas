import test from 'node:test';
import assert from 'node:assert/strict';
import {Replica} from '../core/replica.mjs';
import * as Y from 'yjs';
import {DocumentProjection} from '../core/projection.mjs';
import {flatten,materialize,projectChanges} from '../core/document.mjs';
import {mergePageDocuments,assertLoadedPageChanges} from '../core/page-projection.mjs';
import {appendImportedPages} from '../electron/document-pages.mjs';
import {documentFixture} from './helpers.mjs';

const key=(...parts)=>JSON.stringify(parts);
function pageDocument(id='later'){
  const doc=documentFixture(),page=doc.pagesById.page;
  doc.pages=[id];doc.pagesById={[id]:{...page,id,name:id}};return doc;
}
const catalogValue=(name,kind)=>({id:'shared',name,...kind==='assets'?{kind:'image',src:'omc-asset:sha256:'+'a'.repeat(64)}:{}});

test('new pages preserve header values and existing modern or legacy catalog definitions',()=>{
  for(const legacy of [false,true]){
    const first=documentFixture(),batch=pageDocument();first.extra={note:'user header'};batch.extra={note:'incoming header'};
    for(const catalog of ['assets','components','styles','libraries']){
      first[catalog]={shared:catalogValue('existing',catalog)};
      batch[catalog]={shared:catalogValue('incoming',catalog),added:{...catalogValue('new',catalog),id:'added'}};
    }
    const replica=new Replica({document:first});
    try{
      if(legacy)replica.ydoc.transact(()=>{
        for(const catalog of ['assets','components','styles','libraries']){
          replica.fields.delete(key(catalog,'shared'));replica.fields.set(key('meta',catalog),first[catalog]);
        }
      },'legacy-fixture');
      appendImportedPages(replica,batch);
      assert.deepEqual(replica.document.pages,['page','later']);assert.deepEqual(replica.document.extra,first.extra);
      for(const catalog of ['assets','components','styles','libraries']){
        assert.equal(replica.document[catalog].shared.name,'existing');assert.equal(replica.document[catalog].added.name,'new');
      }
      assert.deepEqual(replica.document.pagesById.later,materialize(flatten(batch)).pagesById.later);
      assert.equal(replica.undo.undoStack.length,0);
    }finally{replica.destroy();}
  }
});

test('catalog tombstones fail explicitly instead of publishing a page with a missing dependency',()=>{
  for(const hardDelete of [false,true]){
    const first=documentFixture();first.assets={shared:catalogValue('original','assets')};
    const replica=new Replica({document:first}),batch=pageDocument();batch.assets=first.assets;
    batch.pagesById.later.objects.label.image={assetId:'shared'};
    try{
      replica.ydoc.transact(()=>{if(hardDelete)replica.fields.delete(key('assets','shared'));else replica.fields.set(key('assets','shared'),null);},'deleted-fixture');
      const before=replica.document,state=Buffer.from(replica.state),revision=replica.revision;
      assert.throws(()=>appendImportedPages(replica,batch),/catalog ID was previously deleted/);
      assert.equal(replica.document,before);assert.equal(replica.revision,revision);assert.deepEqual(Buffer.from(replica.state),state);
    }finally{replica.destroy();}
  }
});

test('an incompatible catalog collision rejects instead of redirecting imported dependencies',()=>{
  for(const [catalog,oldValue,newValue] of [
    ['assets',{src:'omc-asset:sha256:'+'a'.repeat(64),kind:'image'},{src:'omc-asset:sha256:'+'b'.repeat(64),kind:'image'}],
    ['components',{mainId:'old'},{mainId:'other'}],['styles',{value:{color:'#fff'}},{value:{color:'#000'}}],['libraries',{components:{first:{}}},{components:{second:{}}}],
  ]){
    const document=documentFixture();document[catalog]={shared:{id:'shared',name:'User label',...oldValue}};
    const replica=new Replica({document}),batch=pageDocument();batch[catalog]={shared:{id:'shared',name:'Imported label',...newValue}};
    try{
      const before=replica.document,state=Buffer.from(replica.state);
      assert.throws(()=>appendImportedPages(replica,batch),/conflicts with an existing definition/);
      assert.equal(replica.document,before);assert.deepEqual(Buffer.from(replica.state),state);
    }finally{replica.destroy();}
  }
});

test('new-page validation reuses unchanged pages without encoding or decoding the whole replica',()=>{
  const events=[],replica=new Replica({document:documentFixture(),onMetric:event=>events.push(event)});
  try{
    const before=replica.document,retained=replica.fields._map.get(key('shape','page','label','text')),write=retained.write;
    retained.write=()=>{throw Error('Unchanged state was encoded');};
    Object.defineProperty(replica,'state',{configurable:true,get(){throw Error('Full state was accessed');}});
    try{appendImportedPages(replica,pageDocument());}finally{retained.write=write;delete replica.state;}
    assert.equal(replica.validationDoc,null);assert.equal(replica.document.pagesById.page,before.pagesById.page);
    assert.equal(events.at(-1).sizeValidation,'independent-bound');assert.ok(Y.encodeStateAsUpdate(replica.ydoc).byteLength<=replica.encodedStateCeiling);
    assert.deepEqual(replica.document,materialize(replica.fields));
  }finally{replica.destroy();}
});

test('canonical page declarations and live order remain accurate before publication',()=>{
  const replica=new Replica({document:documentFixture()});
  try{
    replica.patch([[key('page','page','order'),73]],'Reorder');
    appendImportedPages(replica,pageDocument());
    assert.deepEqual(replica.document.pages,['page','later']);assert.deepEqual(replica.document,materialize(replica.fields));
    const invalid=pageDocument('hidden');invalid.pagesById.hidden.alive=false;
    const before=replica.document,state=Buffer.from(replica.state);
    assert.throws(()=>appendImportedPages(replica,invalid),/page declarations/);
    assert.equal(replica.document,before);assert.deepEqual(Buffer.from(replica.state),state);
  }finally{replica.destroy();}
});

test('a near-capacity ceiling falls back to exact validation for page additions',()=>{
  const events=[],replica=new Replica({document:documentFixture(),onMetric:event=>events.push(event)});
  try{
    replica.encodedStateCeiling=16*1024*1024-1;appendImportedPages(replica,pageDocument());
    assert.equal(events.at(-1).sizeValidation,'exact');assert.ok(replica.encodedStateCeiling<65536);
    assert.deepEqual(replica.document,materialize(replica.fields));
  }finally{replica.destroy();}
});

test('values normalized by Yjs use decoded-state validation rather than a pre-encoding projection',()=>{
  const unusual=[new Date('2025-01-01T00:00:00Z'),Object.assign([1,2],{label:'extra'}),[,2],{text:'\ud800'},Object.defineProperty({},'value',{enumerable:true,get:()=>4}),{toJSON(){return 'serialized';},kept:5}];
  for(const value of unusual){
    const events=[],replica=new Replica({document:documentFixture(),onMetric:event=>events.push(event)}),batch=pageDocument();
    batch.pagesById.later.objects.label.extension={value};
    try{
      appendImportedPages(replica,batch);
      assert.equal(events.at(-1).sizeValidation,'exact');assert.deepEqual(replica.document,materialize(replica.fields));
    }finally{replica.destroy();}
  }
});

test('used page namespaces cannot be resurrected through retained orphan or deleted registers',()=>{
  for(const family of ['page','shape','geometry'])for(const hardDelete of [false,true]){
    const replica=new Replica({document:documentFixture()}),field=family==='page'?key('page','later','alive'):key(family,'later','orphan','x');
    try{
      replica.ydoc.transact(()=>{replica.fields.set(field,family==='page'?false:3);},'orphan-fixture');
      if(hardDelete)replica.ydoc.transact(()=>{replica.fields.delete(field);},'deleted-fixture');
      assert.deepEqual(replica.document.pages,['page']);
      const state=Buffer.from(replica.state),revision=replica.revision;
      assert.throws(()=>appendImportedPages(replica,pageDocument()),/already used by document history/);
      assert.equal(replica.revision,revision);assert.deepEqual(Buffer.from(replica.state),state);
    }finally{replica.destroy();}
  }
});

test('invalid, overlapping, and combined over-capacity page batches reject atomically',()=>{
  const replica=new Replica({document:documentFixture()});
  try{
    const bad=pageDocument();bad.pagesById.later.objects.label.x=Infinity;
    const large=pageDocument();large.capacity='large';large.pagesById.later.name='x'.repeat(17*1024*1024);
    for(const batch of [bad,documentFixture(),large]){
      const before=replica.document,state=Buffer.from(replica.state),revision=replica.revision;
      assert.throws(()=>appendImportedPages(replica,batch),/geometry|existing page|16 MiB/);
      assert.equal(replica.document,before);assert.equal(replica.revision,revision);assert.deepEqual(Buffer.from(replica.state),state);
    }
  }finally{replica.destroy();}
});

test('retained Undo bytes remain inside the capacity preflight for a new page',()=>{
  const document=documentFixture();document.pagesById.page.objects.label.name='a'.repeat(6*1024*1024);
  const replica=new Replica({document});
  try{
    replica.patch([[key('shape','page','label','name'),'b'.repeat(6*1024*1024)]],'Rename');
    const batch=pageDocument();batch.pagesById.later.objects.label.name='c'.repeat(5*1024*1024);
    const before=replica.document,state=Buffer.from(replica.state),revision=replica.revision,history=replica.undo.undoStack.length;
    // The visible 11 MiB document fits. Its prior 6 MiB name, retained for
    // Undo, makes the actual Yjs state exceed the ordinary 16 MiB capacity.
    assert.throws(()=>appendImportedPages(replica,batch),/history exceed 16 MiB/);
    assert.equal(replica.document,before);assert.equal(replica.revision,revision);assert.equal(replica.undo.undoStack.length,history);assert.deepEqual(Buffer.from(replica.state),state);
  }finally{replica.destroy();}
});

test('an existing edit and its Undo/redo survive a remote-origin page addition',()=>{
  const replica=new Replica({document:documentFixture()}),batch=pageDocument();
  try{
    replica.patch([[key('page','page','name'),'User title']],'Rename page');
    const history=replica.undo.undoStack.length;
    appendImportedPages(replica,batch);
    assert.equal(replica.undo.undoStack.length,history);assert.equal(replica.document.pagesById.page.name,'User title');
    replica.history('undo');assert.equal(replica.document.pagesById.page.name,'Canvas');assert.deepEqual(replica.document.pages,['page','later']);
    replica.history('redo');assert.equal(replica.document.pagesById.page.name,'User title');
    assert.deepEqual(replica.document.pagesById.later,materialize(flatten(batch)).pagesById.later);
  }finally{replica.destroy();}
});

test('page projections rebase pending edits across ordered page revisions and require missing-revision resync',()=>{
  const document=materialize(flatten(documentFixture())),projection=new DocumentProjection({id:'doc',generation:2,revision:0,ack:0,document});
  const changes=[[key('page','page','name'),'Pending title']];projection.enqueue({seq:1,changes});
  const batch=materialize(flatten(pageDocument()));
  const message={type:'document-pages',id:'doc',generation:2,fromRevision:0,revision:1,ack:0,acceptedSeq:0,pageDocument:batch,pageOrder:['page','later']};
  assert.deepEqual(projection.accept({...message,fromRevision:1,revision:2}),{resync:true});
  assert.equal(projection.revision,0);assert.equal(projection.pending.length,1);
  const result=projection.accept(message);
  assert.deepEqual(result.document.pages,['page','later']);assert.equal(result.document.pagesById.page.name,'Pending title');
  assert.equal(projection.document.pagesById.page.name,'Canvas');assert.equal(projection.pending.length,1);
  projection.accept({type:'document-delta',id:'doc',generation:2,fromRevision:1,revision:2,ack:0,acceptedSeq:1,originSequence:1,changes});
  assert.equal(projection.pending.length,1);assert.deepEqual(projection.projected,projectChanges(mergePageDocuments(document,batch),changes));
  projection.accept({type:'commit-ack',id:'doc',generation:2,revision:2,ack:1,acceptedSeq:1});
  assert.equal(projection.pending.length,0);assert.equal(projection.projected.pagesById.page.name,'Pending title');
});

test('partially loaded edits stay in visible namespaces and cannot remove shared definitions',()=>{
  const document=documentFixture();document.assets={shared:catalogValue('shared','assets')};
  assert.doesNotThrow(()=>assertLoadedPageChanges(document,[[key('page','page','name'),'Edited'],[key('shape','page','new-shape','alive'),true]]));
  for(const change of [[key('shape','hidden','x','name'),'Hidden'],[key('page','page','alive'),false],[key('assets','shared'),null],[key('meta','capacity'),'large']])assert.throws(()=>assertLoadedPageChanges(document,[change]),/loading|Wait/);
});
