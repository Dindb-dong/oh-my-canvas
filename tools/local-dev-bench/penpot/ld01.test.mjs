import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {runInNewContext} from 'node:vm';
import {applyProbe,createDashboard,normalizeImages,readDashboard,verifyInputs} from './ld01.mjs';

const id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const fixtures = JSON.parse(execFileSync('python3',['-B','-c',`
import sys,json,base64
sys.path.insert(0,sys.argv[1])
import synthetic,ld01
print(json.dumps([{'fixture':synthetic.fixture('LD01',family),'assets':[
 {'meta':meta,'base64':base64.b64encode(data).decode()} for meta,data in ld01.make_assets(source)]}
 for family,source in ld01.VARIANTS.items()]))
`,fileURLToPath(new URL('../workloads/',import.meta.url))],{encoding:'utf8'}));

function sandbox(assets) {
  const root = {children:[]};
  const shapes = [];
  const imageBytes = new Map();
  let uploads = 0;
  const add = (type,text) => {
    const shape = {id:`native-${shapes.length}`,name:'',type,characters:text,children:[],fills:[],
      resize(width,height) { this.width=width; this.height=height; },
      appendChild(child) {
        child.parent.children.splice(child.parent.children.indexOf(child),1);
        this.children.push(child);child.parent=this;
      },
      addFlexLayout() {
        this.flex = {appendChild:child=>{this.appendChild(child);child.layoutChild={};}};
        return this.flex;
      },parent:root};
    root.children.push(shape);shapes.push(shape);return shape;
  };
  const penpot = {currentFile:{id,pages:[{}]},currentPage:{root},
    fonts:{all:[{name:'Inter',applyToText(shape) { shape.fontFamily='Inter';shape.fontId='inter-face'; }}]},
    createText:text=>add('text',text),createRectangle:()=>add('rectangle'),createBoard:()=>add('board'),
    async uploadMediaData(name,bytes,mime) {
      assert.equal(mime,'image/png');
      assert.deepEqual(Buffer.from(bytes),assets.find(asset=>asset.meta.name === name).bytes);
      const mediaId = `bbbbbbbb-bbbb-bbbb-bbbb-${String(++uploads).padStart(12,'0')}`;
      imageBytes.set(mediaId,bytes);
      return {id:mediaId,name,mtype:mime,width:32,height:32};
    }};
  const execute = async code=>{
    for (const shape of shapes) for (const fill of shape.fills) if (fill.fillImage) {
      fill.fillImage.data = async()=>imageBytes.get(fill.fillImage.id);
    }
    return JSON.parse(JSON.stringify(await runInNewContext(`(async()=>{${code}})()`,{penpot,atob})));
  };
  return {root,shapes,penpot,execute,uploads:()=>uploads};
}

for (const entry of fixtures) test(`${entry.fixture.source_family_id}: creates native objects and reads observed geometry and image bytes`,async()=>{
  const {fixture} = entry;
  const assets = entry.assets.map(({meta,base64})=>({meta,bytes:Buffer.from(base64,'base64')}));
  const native = sandbox(assets);
  assert.deepEqual((await native.execute(readDashboard(id))).nodes,[]);
  assert.equal(await native.execute(createDashboard(fixture,assets,id)),fixture.logical_objects);
  assert.equal(native.uploads(),2);
  const title = native.shapes.find(shape=>shape.name === 'LD01 header/title');
  title.x += 37; title.characters = 'Observed content';
  const state = normalizeImages(await native.execute(readDashboard(id)),assets);
  const observed = state.nodes.find(row=>row.key === 'header/title');
  assert.equal(observed.bounds[0],title.x);
  assert.equal(observed.text,'Observed content');
  assert.equal(observed.font_family,'Inter');
  assert.equal(state.nodes.length,fixture.logical_objects);
  assert.equal(state.nodes.find(row=>row.key === 'filters').layout,'horizontal');
  for (const row of state.nodes.filter(row=>row.kind === 'image')) {
    assert.equal(row.asset_rgba_sha256,assets.find(asset=>asset.meta.sha256 === row.stored_png_sha256).meta.rgba_sha256);
  }
  assert.deepEqual(await native.execute(applyProbe(id,fixture.probe_actions)),fixture.probe_actions);
  assert.equal(title.characters,'Shift review');
  assert.equal(native.shapes.find(shape=>shape.name === 'LD01 filters').flex.columnGap,20);
  native.penpot.currentFile.id = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
  await assert.rejects(native.execute(readDashboard(id)),/Wrong isolated LD01/);
});

test('rejects modified source image bytes before any native operation',async()=>{
  const {fixture,assets} = fixtures[0];
  const directory = await mkdtemp(join(tmpdir(),'penpot-ld01-'));
  try {
    await Promise.all(assets.map(asset=>writeFile(join(directory,asset.meta.name),Buffer.from(asset.base64,'base64'))));
    assert.equal((await verifyInputs(fixture,directory)).length,2);
    await writeFile(join(directory,'badge.png'),'changed');
    await assert.rejects(verifyInputs(fixture,directory),/Fixture asset bytes changed/);
  } finally { await rm(directory,{recursive:true,force:true}); }
});
