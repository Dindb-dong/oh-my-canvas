import {test} from 'node:test';
import assert from 'node:assert/strict';
import {documentFixture} from './helpers.mjs';
import {Replica} from '../core/replica.mjs';
import {flatten,materialize,changesBetween,changesFromPatches,projectChanges,assertDocument,assertDocumentChanges,MAX_ENVELOPE_BYTES,MAX_PORTABLE_BYTES} from '../core/document.mjs';
import {DocumentProjection} from '../core/projection.mjs';

test('page-name journal translates without visiting unrelated image shapes',()=>{
  const before=documentFixture(),page=before.pagesById.page;
  const after={...before,pagesById:{...before.pagesById,page:{...page,name:'Renamed'}}};
  const expected=changesBetween(before,after);
  Object.defineProperty(page.objects,'unvisited',{enumerable:true,get(){throw Error('Unchanged shape visited');}});
  const changes=changesFromPatches(before,after,[{path:['pagesById','page','name'],value:'Renamed',old:'Canvas'}]);
  assert.deepEqual(changes,expected);assert.ok(JSON.stringify(changes).length<100);
  const next=projectChanges(before,changes);
  assert.equal(next.pagesById.page.objects,page.objects);assert.equal(next.pagesById.page.name,'Renamed');
});

test('journal adapter retains canonical shape order and topology repair',()=>{
  const before=documentFixture(),after=structuredClone(before);
  after.pagesById.page.objects.new={...after.pagesById.page.objects.label,id:'new',name:'New'};
  after.pagesById.page.objects.board.childIds=['new','label'];
  const patches=[{path:['pagesById','page','objects','new'],value:after.pagesById.page.objects.new},{path:['pagesById','page','objects','board','childIds'],value:['new','label'],old:['label']}];
  const changes=changesFromPatches(before,after,patches);
  assert.deepEqual(projectChanges(before,changes),materialize(flatten(after)));
});

test('scalar projections equal canonical materialization and share other pages',()=>{
  const before=documentFixture();before.pages.push('second');before.pagesById.second={...before.pagesById.page,id:'second'};
  const changes=[[JSON.stringify(['shape','page','label','x']),77],[JSON.stringify(['shape','page','label','name']),'Moved']];
  const fields=flatten(before);for(const [k,v] of changes)fields.set(k,v);
  const next=projectChanges(before,changes);assert.deepEqual(next,materialize(fields));
  assert.equal(next.pagesById.second,before.pagesById.second);
  assert.equal(next.pagesById.page.objects.board,before.pagesById.page.objects.board);
  assert.equal(before.pagesById.page.objects.label.x,30);
});

test('asset entries merge independent concurrent additions and override legacy meta tombstones',()=>{
  const a=new Replica({document:documentFixture()}),b=new Replica({state:a.state});
  try{
    const add=(r,id)=>{const before=r.document,after={...before,assets:{...before.assets,[id]:{id,kind:'image',src:'omc-asset:sha256:'+'a'.repeat(64)}}};r.patch(changesFromPatches(before,after,[{path:['assets',id],value:after.assets[id]}]));};
    add(a,'a');add(b,'b');const as=a.state,bs=b.state;a.receive(bs);b.receive(as);
    assert.deepEqual(Object.keys(a.document.assets).sort(),['a','b']);assert.deepEqual(a.document,b.document);
    const fields=flatten(documentFixture());fields.set(JSON.stringify(['assets','old']),null);fields.set(JSON.stringify(['meta','assets']),{old:{src:'legacy'}});
    assert.deepEqual(materialize(fields).assets,{});
  }finally{a.destroy();b.destroy();}
});

test('incremental local validation retains exact escaped UTF-8 budget and geometry bounds',()=>{
  const before=assertDocument(documentFixture());
  const next=projectChanges(before,[[JSON.stringify(['shape','page','label','x']),1e9]]);
  assert.throws(()=>assertDocumentChanges(before,next),/geometry/);
  const large={...before,notes:'한'.repeat(6*1024*1024)};
  assert.throws(()=>assertDocumentChanges(before,large),/16 MiB/);
  assert.equal(MAX_ENVELOPE_BYTES,24*1024*1024);assert.equal(MAX_PORTABLE_BYTES,384*1024*1024);
});

test('activating a dormant page establishes fresh geometry and shape identity proofs',()=>{
  for(const corrupt of [shape=>{shape.x=1e9;},shape=>{shape.id='different';}]){
    const before=documentFixture(),hidden=structuredClone(before.pagesById.page);hidden.id='hidden';
    corrupt(hidden.objects.label);before.pagesById.hidden=hidden;assertDocument(before);
    const after={...before,pages:[...before.pages,'hidden']};
    assert.throws(()=>assertDocumentChanges(before,after),/geometry|shape graph/);
    // Copying the object map must not make its unchanged dormant shapes trusted.
    const copied={...after,pagesById:{...before.pagesById,hidden:{...hidden,objects:{...hidden.objects}}}};
    assert.throws(()=>assertDocumentChanges(before,copied),/geometry|shape graph/);
  }
});

test('activating a stored dormant page sends its complete shape declarations',()=>{
  const before=documentFixture();before.pagesById.hidden={...structuredClone(before.pagesById.page),id:'hidden',name:'Dormant page'};
  const after={...before,pages:[...before.pages,'hidden']};
  const journal=[{path:['pages'],old:before.pages,value:after.pages}];
  for(const changes of [changesBetween(before,after),changesFromPatches(before,after,journal)]){
    assert.ok(changes.some(([key])=>key===JSON.stringify(['shape','hidden','label','type'])));
    assert.deepEqual(projectChanges(before,changes),materialize(flatten(after)));
  }
});

test('retiring legacy entity maps preserves newly declared entries regardless of patch order',()=>{
  const before=documentFixture();before.assets={image:{src:'legacy'}};before.components={button:{name:'Button'}};
  const changes=[
    [JSON.stringify(['assets','image']),{src:'omc-asset:sha256:'+'a'.repeat(64)}],
    [JSON.stringify(['components','button']),{name:'Button'}],
    [JSON.stringify(['meta','assets']),null],
    [JSON.stringify(['meta','components']),null]
  ];
  const fields=flatten(before);for(const [key,value] of changes)fields.set(key,value);
  assert.deepEqual(projectChanges(before,changes),materialize(fields));assert.deepEqual(projectChanges(before,changes.slice().reverse()),materialize(fields));
});

function snap(doc=documentFixture()){return {id:'document',generation:3,document:doc,revision:0,ack:0,acceptedSeq:0};}
const rename=name=>[[JSON.stringify(['page','page','name']),name]];
test('accepted deltas apply once while durable ACK retires pending writes later',()=>{
  const p=new DocumentProjection(snap());p.enqueue({seq:1,changes:rename('One')});
  const result=p.accept({type:'document-delta',id:'document',generation:3,fromRevision:0,revision:1,originSequence:1,acceptedSeq:1,ack:0,changes:rename('One')});
  assert.equal(result.redundant,true);assert.equal(p.pending.length,1);assert.equal(p.projected.pagesById.page.name,'One');
  p.accept({type:'commit-ack',id:'document',generation:3,revision:1,acceptedSeq:1,ack:1});assert.equal(p.pending.length,0);
});

test('lost delta triggers resync before ACK can retire an unapplied edit',()=>{
  const p=new DocumentProjection(snap());p.enqueue({seq:1,changes:rename('One')});
  assert.equal(p.accept({type:'commit-ack',id:'document',generation:3,revision:1,ack:1,acceptedSeq:1}).resync,true);
  assert.equal(p.pending.length,1);
  const document=projectChanges(p.document,rename('One'));
  p.accept({...snap(document),revision:1,ack:1,acceptedSeq:1});assert.equal(p.pending.length,0);assert.equal(p.projected.pagesById.page.name,'One');
});

test('remote delta rebases queued edits and rejects generation/missing revision',()=>{
  const p=new DocumentProjection(snap());p.enqueue({seq:1,changes:rename('Local')});
  const remote=[[JSON.stringify(['shape','page','label','x']),55]];
  const result=p.accept({type:'document-delta',id:'document',generation:3,fromRevision:0,revision:1,changes:remote,ack:0,acceptedSeq:0});
  assert.equal(result.document.pagesById.page.name,'Local');assert.equal(result.document.pagesById.page.objects.label.x,55);
  assert.equal(p.accept({type:'document-delta',id:'document',generation:4,fromRevision:1,revision:2,changes:remote}).ignored,true);
  assert.equal(p.accept({type:'document-delta',id:'document',generation:3,fromRevision:2,revision:3,changes:remote}).resync,true);
  assert.equal(p.revision,1);
});

test('invalid acknowledgments or failed rebase cannot partially publish a revision',()=>{
  const p=new DocumentProjection(snap());p.enqueue({seq:1,changes:rename('Local')});
  const before=p.document,pending=p.pending;
  const delta={type:'document-delta',id:'document',generation:3,fromRevision:0,revision:1,changes:rename('Remote'),ack:0,acceptedSeq:0};
  for(const message of [{...delta,ack:-1},{...snap(projectChanges(before,rename('Snapshot'))),revision:1,ack:1,acceptedSeq:0}]){
    assert.throws(()=>p.accept(message),/acknowledgment/);
    assert.equal(p.document,before);assert.equal(p.revision,0);assert.equal(p.ack,0);assert.equal(p.accepted,0);assert.equal(p.pending,pending);
  }
  p.enqueue({seq:2,changes:[['not a field key',true]]});
  assert.throws(()=>p.accept(delta));
  assert.equal(p.document,before);assert.equal(p.revision,0);assert.equal(p.pending,pending);
  p.reject(2);assert.equal(p.accept(delta).document.pagesById.page.name,'Local');
});
