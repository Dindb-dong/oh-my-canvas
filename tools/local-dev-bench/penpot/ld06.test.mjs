import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {runInNewContext} from 'node:vm';
import {placeSlot,verifyInputs} from './ld06.mjs';

const id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const digest = data => createHash('sha256').update(data).digest('hex');

test('verifies all ten registered local inputs and rejects a changed PNG',async () => {
  const root = await mkdtemp(join(tmpdir(),'penpot-ld06-test-'));
  const content = JSON.stringify({initial:Array.from({length:6},(_,slot) => ({slot})),updates:[{slot:2},{slot:5}]});
  const values = {'content.json':content,'fixture-font.ttf':'font', 'replacement-image-3.png':'replacement 3',
    'replacement-image-6.png':'replacement 6',...Object.fromEntries(Array.from({length:6},(_,index) =>
      [`initial-image-${index+1}.png`,`initial ${index+1}`]))};
  const fixture = {workload:'LD06',source_family_id:'metro-stories',font_registered:true,logical_objects:26,
    font:{family:'Noto Sans KR',license:'OFL-1.1'},start:{nodes:Array(8)},
    assets:Object.entries(values).map(([name,data]) => ({name,sha256:digest(data)}))};
  try {
    await Promise.all(Object.entries(values).map(([name,data]) => writeFile(join(root,name),data)));
    assert.equal((await verifyInputs(fixture,root)).assets.size,10);
    await writeFile(join(root,'initial-image-1.png'),'modified');
    await assert.rejects(verifyInputs(fixture,root),/bytes changed for initial-image-1\.png/);
  } finally {
    await rm(root,{recursive:true,force:true});
  }
});

test('pinned native replacement uploads exact original bytes and retains three existing layers',async () => {
  const key = 'card/2';
  const mediaId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  const rows = [{key:`${key}/image`,kind:'image',asset_rgba_sha256:'registered-rgba'},
    {key:`${key}/name`,kind:'text',text:'Coastal Loop'},{key:`${key}/caption`,kind:'text',text:'제주 해안'}];
  const children = rows.map((row,index) => ({id:`child-${index}`,name:`LD06 ${row.key}`}));
  const scope = {name:'LD06 canvas',children:[{name:`LD06 ${key}`,children}]};
  const asset = {meta:{name:'replacement-image-3.png',rgba_sha256:'registered-rgba'},bytes:Buffer.from('pinned PNG')};
  const content = {slot:2,name:'Coastal Loop',caption:'제주 해안'};
  const penpot = {currentFile:{id,pages:[{}]},currentPage:{root:{children:[scope]}},
    fonts:{findById:fontId => ({fontId})}, async uploadMediaData(name,raw,mime) {
      assert.equal(name,asset.meta.name);
      assert.equal(Buffer.from(raw).compare(asset.bytes),0);
      assert.equal(mime,'image/png');
      return {id:mediaId,name,width:128,height:96,mtype:mime};
    }};
  const code = placeSlot(id,rows,content,asset,'custom-face',true);
  assert.equal(await runInNewContext(`(async () => {${code}})()`,{penpot,atob}),mediaId);
  assert.deepEqual(children.map(child => child.id),['child-0','child-1','child-2']);
  assert.equal(children[0].fills[0].fillImage.keepAspectRatio,true);
  assert.equal(children[2].characters,content.caption);
  penpot.currentFile.id = mediaId;
  await assert.rejects(runInNewContext(`(async () => {${code}})()`,{penpot,atob}),/Wrong isolated LD06 file/);
});
