import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {coverCrop,normalizeAssets,planAssets,verifyInputs} from './ld06.mjs';
import {pngPixels,makePressureFixture} from './asset-pressure.mjs';

test('asset plan retains 26 native identities and applies the supplied two replacements',()=>{
  const fixture=JSON.parse(execFileSync('python3',[fileURLToPath(new URL('../workloads/synthetic.py',import.meta.url)),
    'fixture','LD06','--variant','metro-stories'],{encoding:'utf8',env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}}));
  fixture.font={family:'Fixture font'};
  const rows=new Map(fixture.loaded.nodes.map(row=>[row.key,row]));
  const final=new Map(fixture.expected.nodes.map(row=>[row.key,row]));
  const entry=(slot,index)=>({slot,name:index.get(`card/${slot}/name`).text,caption:index.get(`card/${slot}/caption`).text});
  const content={initial:[0,1,2,3,4,5].map(slot=>entry(slot,rows)),updates:[2,5].map(slot=>entry(slot,final))};
  const assets=new Map(fixture.assets.map(meta=>[meta.name,{meta}]));
  for(const row of fixture.expected.nodes) Object.defineProperty(row,'crop_source_px',{get(){throw Error('Expected crop read');}});
  const plan=planAssets(fixture,content,assets);
  assert.equal(plan.before.length,8); assert.equal(plan.loaded.length,18);
  assert.equal(new Set(plan.nodes.map(row=>row.id)).size,26);
  assert.equal(plan.changes.filter(row=>row.type==='node.set').length,2);
  assert.equal(plan.changes.filter(row=>row.type==='text.replace').length,4);
  assert.ok(plan.changes.every(change=>plan.loaded.some(node=>node.id===change.nodeId)));
  for(const node of plan.nodes) assert.ok([node.properties.x,node.properties.y,node.properties.width,node.properties.height].every(Number.isFinite));
  content.updates[0].caption='wrong supplied content';
  assert.throws(()=>planAssets(fixture,content,assets));
});

test('cover crop follows actual source and destination sizes, with no fixture coordinates',()=>{
  assert.deepEqual(coverCrop(128,96,160,104),[0,6.399999999999999,128,83.2]);
  assert.deepEqual(coverCrop(96,128,160,104),[0,32.8,96,62.4]);
  assert.throws(()=>coverCrop(0,128,160,104));
});

test('readback refuses missing bytes and stale geometry, and does not claim unsupported cropping',()=>{
  const raw={id:'doc',sequence:3,pages:[{rootNodeId:'root'}],nodes:{root:{id:'root'},
    picture:{id:'picture',kind:'image',parentId:'root',properties:{name:'LD06 card/0/image',assetHash:'hash',imageFit:'cover'}}}};
  const scene={revision:3,truncated:false,nodes:[{id:'alias',rawId:'picture'}],
    diagnostics:[{id:'alias',bounds:{x:24,y:32,width:160,height:104},clippedText:false,overflowParent:false}]};
  const images=new Map([['hash',{width:96,height:128,rgba_sha256:'actual-pixels'}]]);
  const result=normalizeAssets(raw,scene,images,null);
  assert.deepEqual(result.nodes[0].bounds,[24,32,160,104]);
  assert.equal(result.nodes[0].asset_rgba_sha256,'actual-pixels');
  assert.throws(()=>normalizeAssets(raw,scene,new Map(),null));
  assert.throws(()=>normalizeAssets(raw,{...scene,revision:2},images,null));
  raw.nodes.picture.properties.imageCrop={x:0,y:0,width:1,height:1};
  assert.equal(normalizeAssets(raw,scene,images,null).nodes[0].crop_source_px,null);
});

test('input verification checks both original PNG bytes and decoded pixels',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'ld06-unit-'));
  try {
    const {bytes,width,height}=makePressureFixture('shared','small').assets[0];
    const content=Buffer.from('{"initial":[],"updates":[]}');
    const asset={name:'initial-image-1.png',width,height,
      sha256:createHash('sha256').update(bytes).digest('hex'),rgba_sha256:pngPixels(bytes,width,height).sha256};
    const fixture={workload:'LD06',font_registered:true,font:{license:'OFL-1.1'},assets:[asset,
      {name:'content.json',sha256:createHash('sha256').update(content).digest('hex')}]};
    await writeFile(join(directory,asset.name),bytes); await writeFile(join(directory,'content.json'),content);
    assert.equal((await verifyInputs(fixture,directory)).assets.size,2);
    asset.rgba_sha256='incorrect-pixels'; await assert.rejects(()=>verifyInputs(fixture,directory));
  } finally {await rm(directory,{recursive:true,force:true});}
});
