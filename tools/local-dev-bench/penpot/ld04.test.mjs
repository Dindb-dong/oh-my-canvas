import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import test from 'node:test';
import {runInNewContext} from 'node:vm';
import {adaptResponsive,planResponsive,readResponsive,seedResponsive,verifyWidthSelection} from './ld04.mjs';

const fileId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const canvasId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const fixture = JSON.parse(execFileSync('/usr/bin/python3',[
  '-c', 'import sys,json; sys.path.insert(0,sys.argv[1]); from synthetic import fixture; ' +
    'print(json.dumps(fixture("LD04",private_registration={"width":1111,"nonce":"offline fixture test only"})))',
  new URL('../workloads',import.meta.url).pathname,
]));
const execute = (code, penpot) => JSON.parse(JSON.stringify(runInNewContext(`(() => {${code}})()`,{penpot})));

test('registered widths are independent of the native candidate edit payload', () => {
  const plan = planResponsive(fixture);
  assert.deepEqual(plan.widths,[768,390,1111,1440]);
  assert.equal(plan.nodes.length,31);
  assert.deepEqual(plan.nodes.find(node => node.key === 'card/0/line-0').localBounds,[12,12,316,20]);
  assert.doesNotMatch(adaptResponsive(plan,fileId),/1111|bench-width/);
  assert.doesNotMatch(seedResponsive(plan,fileId),/1111/);
  assert.throws(() => planResponsive({...fixture,private_width_registered:false}),/Register a private/);
  assert.throws(() => planResponsive({...fixture,responsive_steps:fixture.responsive_steps.toReversed()}));
});

function workspace() {
  let nextId = 0;
  const root = {children:[]};
  function shape(type, characters) {
    const result = {
      id:type === 'board' && !nextId ? canvasId : `shape-${nextId}`,
      type,characters,x:0,y:0,
      resize(width,height) { this.width = width; this.height = height; },
      ...(type === 'board' && {
        children:[],
        appendChild(child) {
          child.parent.children = child.parent.children.filter(row => row !== child);
          this.children.push(child);
          child.parent = this;
          if (this.flex) child.layoutChild ??= {};
        },
        addFlexLayout() {
          this.flex = {appendChild:child => this.appendChild(child)};
          return this.flex;
        },
      }),
      get textBounds() { return {x:this.x,y:this.y,width:40,height:this.type === 'text' ? 10 : 0}; },
      parent:root,
    };
    nextId++;
    root.children.push(result);
    return result;
  }
  return {
    currentFile:{id:fileId,pages:['p']},currentPage:{root},
    fonts:{all:[{name:'Inter Tight'}, {name:'Inter',id:'inter-pinned',applyToText:text => {
      text.fontId = 'inter-pinned'; text.fontFamily = 'Inter';
    }}]},
    createText:text => shape('text',text),createBoard:() => shape('board'),
    library:{local:{colors:[],typographies:[]}},
  };
}

test('native layout and visibility readback preserve identity without inventing a basis', () => {
  const plan = planResponsive(fixture);
  const app = workspace();
  assert.deepEqual(execute(seedResponsive(plan,fileId),app),{count:31,fontId:'inter-pinned'});
  const baseline = execute(readResponsive(fileId),app);
  const before = new Map(baseline.nodes.map(row => [row.key,row]));
  for (const node of fixture.start.nodes) assert.deepEqual(before.get(node.key).bounds,node.bounds);
  assert.ok(before.get('card/0/line-0').fully_visible);
  assert.equal(before.get('collection').gap,16);
  assert.equal(execute(adaptResponsive(plan,fileId),app),canvasId);
  const model = execute(readResponsive(fileId),app);
  const after = new Map(model.nodes.map(row => [row.key,row]));
  for (const [key,row] of before) assert.equal(after.get(key).native_id,row.native_id);
  assert.equal(after.get('collection').layout,'horizontal-wrap');
  assert.equal(after.get('card/0').min_width,230);
  assert.equal(after.get('card/0').max_width,360);
  assert.equal(after.get('card/0').basis_width,null);
  const [canvas] = app.currentPage.root.children;
  app.selection = [];
  assert.throws(() => execute(verifyWidthSelection(fileId,canvasId),app),/Wrong native width target/);
  app.selection = [canvas];
  assert.equal(execute(verifyWidthSelection(fileId,canvasId),app),canvasId);
  assert.equal(canvas.flex.verticalSizing,'auto');
  const collection = canvas.children.find(node => node.name === 'LD04 collection');
  const line = collection.children[0].children[0];
  line.x = canvas.x + canvas.width + 10;
  assert.equal(execute(readResponsive(fileId),app).nodes.find(row => row.native_id === line.id).fully_visible,false);
  canvas.proportionLock = true;
  assert.throws(() => execute(verifyWidthSelection(fileId,canvasId),app),/Wrong native width target/);
  app.currentFile.id = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
  assert.throws(() => execute(readResponsive(fileId),app),/Wrong isolated LD04 file/);
});
