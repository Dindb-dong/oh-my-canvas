import {test} from 'node:test';import assert from 'node:assert/strict';import {promises as fs} from 'node:fs';import os from 'node:os';import path from 'node:path';import {randomUUID} from 'node:crypto';
import {Store,decodeFile,encodeFile} from '../core/storage.mjs';import {Replica} from '../core/replica.mjs';import {documentFixture} from './helpers.mjs';
import {changesBetween,MAX_ENVELOPE_BYTES} from '../core/document.mjs';
test('atomic local save, portable file, backup recovery, and traversal refusal',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'omc-storage-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const store=new Store(dir),r={id:randomUUID(),title:'Test',createdAt:new Date().toISOString(),replica:new Replica({document:documentFixture()})};t.after(()=>r.replica.destroy());
  await store.save(r);const portable=decodeFile(encodeFile(r));assert.deepEqual(portable.replica.document,r.replica.document);portable.replica.destroy();
  r.title='Renamed';await store.save(r);await fs.writeFile(store.file(r.id),'broken');const recovered=await store.load(r.id);assert.equal(recovered.recovered,true);assert.equal(recovered.title,'Test');recovered.replica.destroy();assert.throws(()=>store.file('../outside'));assert.equal((await store.list()).length,1);await store.remove(r.id);assert.equal((await store.list()).length,0);
});
test('simultaneous saves serialize, keeping the newest state',async t=>{const dir=await fs.mkdtemp(path.join(os.tmpdir(),'omc-save-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const store=new Store(dir),r={id:randomUUID(),title:'First',replica:new Replica({document:documentFixture()})};t.after(()=>r.replica.destroy());const first=store.save(r);r.title='Second';await Promise.all([first,store.save(r)]);const read=await store.load(r.id);assert.equal(read.title,'Second');read.replica.destroy();});
test('portable metadata is validated before import or overwriting a saved document',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'omc-metadata-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const store=new Store(dir),record={id:randomUUID(),title:'Valid',replica:new Replica({document:documentFixture()})};t.after(()=>record.replica.destroy());
  await store.save(record);const original=await fs.readFile(store.file(record.id),'utf8'),file=JSON.parse(original);
  for(const fields of [{title:{broken:true}},{title:null},{title:''},{title:' '.repeat(3)},{title:'x'.repeat(1025)},{updatedAt:{}},{updatedAt:'not a date'},{createdAt:123},{thumbnail:{}},{thumbnail:'https://example.com/image.png'},{thumbnail:'data:image/png;base64,'+'x'.repeat(500000)}]){
    assert.throws(()=>decodeFile(JSON.stringify({...file,...fields})),/Invalid canvas metadata/);
    if(!('updatedAt' in fields))await assert.rejects(store.save({...record,...fields}),/Invalid canvas metadata/);
    assert.equal(await fs.readFile(store.file(record.id),'utf8'),original);
  }
  // Earlier files may omit creation dates and thumbnails; duplicate titles can exceed the UI's 120-character rename limit.
  const legacy=decodeFile(JSON.stringify({...file,title:'x'.repeat(125),createdAt:undefined,thumbnail:undefined}));legacy.replica.destroy();
});
test('malformed metadata stays isolated in the library after a store restart and valid backups recover',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'omc-metadata-list-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const store=new Store(dir),record={id:randomUUID(),title:'Healthy canvas',replica:new Replica({document:documentFixture()})};t.after(()=>record.replica.destroy());
  await store.save(record);const file=JSON.parse(await fs.readFile(store.file(record.id),'utf8')),damagedId=randomUUID();
  await fs.writeFile(store.file(damagedId),JSON.stringify({...file,id:damagedId,title:{broken:true}}));
  const restarted=new Store(dir),listed=await restarted.list();assert.equal(listed.length,2);
  assert.equal(listed.find(d=>d.id===record.id).title,'Healthy canvas');assert.equal(listed.find(d=>d.id===damagedId).damaged,true);
  assert.ok(listed.every(d=>typeof d.title==='string'));assert.doesNotThrow(()=>listed.filter(d=>d.title.toLowerCase().includes('canvas')));
  await fs.copyFile(store.file(record.id),store.file(record.id)+'.bak');
  await fs.writeFile(store.file(record.id),JSON.stringify({...file,title:{broken:true}}));
  const recovered=await restarted.load(record.id);assert.equal(recovered.recovered,true);assert.equal(recovered.title,'Healthy canvas');recovered.replica.destroy();
});
test('large retained history is refused before mutation and every accepted file can be reopened',()=>{
  const replica=new Replica({document:documentFixture()}),record={id:randomUUID(),title:'Budget',replica};let rejected=false;
  try{
    for(let i=0;i<9;i++){
      const before=replica.document,state=replica.state,after=structuredClone(before);after.pagesById.page.objects.label.name=String(i).repeat(3*1024*1024);
      try{replica.patch(changesBetween(before,after));}catch(e){assert.match(e.message,/16 MiB/);assert.deepEqual(replica.document,before);assert.deepEqual(replica.state,state);rejected=true;break;}
      const file=encodeFile(record);assert.ok(Buffer.byteLength(file)<=MAX_ENVELOPE_BYTES);const read=decodeFile(file);assert.deepEqual(read.replica.document,replica.document);read.replica.destroy();
    }
    assert.equal(rejected,true);
    for(let i=0;i<8;i++){
      const state=replica.state;try{replica.history(i%2?'redo':'undo');}catch(e){assert.match(e.message,/16 MiB/);assert.deepEqual(replica.state,state);break;}
      const read=decodeFile(encodeFile(record));read.replica.destroy();
    }
  }finally{replica.destroy();}
});
