import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {atlasDifferences,atlasInventory,atlasTarget,readAtlasPage,seedAtlasPage,validateFixture} from './ld02-atlas.mjs';

const generator = 'tools/local-dev-bench/workloads/synthetic.py';
const fixture = validateFixture(JSON.parse(execFileSync('python3',[generator,'fixture','LD02',
  '--variant','conservation-atlas'],{encoding:'utf8'})));
const id = '00000000-0000-4000-8000-000000000001';
const copyId = '00000000-0000-4000-8000-000000000002';
const Async = (async () => {}).constructor;
const evalScript = (code,penpot) => new Async('penpot',code)(penpot);

function synthetic(fileId) {
  let serial = 0;
  const make = () => {
    const root = {children:[]};
    const find = (shape,id) => {
      if (shape.id === id) return shape;
      return shape.children?.map(child => find(child,id)).find(Boolean);
    };
    return {id:`page-${serial++}`,name:'Page 1',root,getShapeById:native => find(root,native)};
  };
  const first = make();
  const app = {
    currentFile:{id:fileId,pages:[first]},
    currentPage:first,
    selection:[],
    history:{undoBlockBegin:() => Symbol('history'),undoBlockFinish:block => assert.equal(typeof block,'symbol')},
    createPage() {
      const page = make();
      this.currentFile.pages.push(page);
      return page;
    },
    async openPage(page) { this.currentPage = page; },
  };
  function shape(type, fields = {}) {
    let left = 0;
    let top = 0;
    let owner;
    const store = new Map();
    const objects = app.currentPage.root.children;
    const node = {
      type,id:`shape-${serial++}`,...fields,
      fills:[],
      get x() { return owner?.flex ? owner.x+owner.flex.horizontalPadding : left; },
      set x(value) { left=value; },
      get y() {
        if (!owner?.flex) return top;
        const offset = owner.children.slice(0,owner.children.indexOf(this)).reduce(
          (sum,child) => sum+child.height+owner.flex.rowGap,0);
        return owner.y+owner.flex.verticalPadding+offset;
      },
      set y(value) { top=value; },
      set parentX(value) { left=owner.x+value; },
      set parentY(value) { top=owner.y+value; },
      getPluginData:name => store.get(name),
      setPluginData:(name,value) => store.set(name,value),
      resize(width,height) { Object.assign(this,{width,height}); },
      setOwner(parent) { owner=parent; },
      appendChild(child) {
        objects.splice(objects.indexOf(child),1);
        child.setOwner(this);
        this.children.push(child);
      },
      addFlexLayout() {
        const board=this;
        return this.flex={
          appendChild:child => board.appendChild(child),
          get leftPadding() {return this.horizontalPadding;},
          get rightPadding() {return this.horizontalPadding;},
          get topPadding() {return this.verticalPadding;},
          get bottomPadding() {return this.verticalPadding;},
        };
      },
    };
    objects.push(node);
    return node;
  }
  app.createBoard = () => shape('board',{children:[]});
  app.createText = characters => shape('text',{characters});
  app.createRectangle = () => shape('rectangle');
  return app;
}

async function seed(app) {
  for (const [index,page] of fixture.start.pages.entries()) {
    const result=await evalScript(seedAtlasPage(fixture,page,index,app.currentFile.id),app);
    assert.equal(result.logicalObjects,100);
  }
}

async function snapshot(app) {
  const state=await evalScript(atlasInventory(fixture,app.currentFile.id),app);
  const nodes = (await Promise.all(state.pages.map(page => evalScript(readAtlasPage(page,app.currentFile.id),app)))).flat();
  return {...state,nodes,styles:[]};
}

test('Atlas seeds actual native structure and locates only exact station and receipt among distractors', async () => {
  const original=synthetic(id);
  await assert.rejects(evalScript(seedAtlasPage(fixture,fixture.start.pages[0],0,copyId),original),/Wrong isolated Atlas/);
  await seed(original);
  const before=await snapshot(original);
  assert.deepEqual(atlasDifferences(fixture.start,before,2),[]);
  assert.equal(before.pages.length,10);
  assert.equal(before.nodes.length,1000);
  assert.equal(before.nodes.filter(node=>node.name==='Ceramics review').length,3);
  const edit=await evalScript(atlasTarget(id,true,fixture),original);
  assert.deepEqual(edit,fixture.edit);
  const candidate=await snapshot(original);
  assert.deepEqual(atlasDifferences(fixture.expected,candidate,2),[]);
  assert.equal(original.currentPage.name,'Conservation arrivals');
  await assert.rejects(evalScript(atlasTarget(id,true,fixture),original),/Wrong native Atlas starting values/);
  const copy=synthetic(copyId);
  await seed(copy);
  const copyBefore=await snapshot(copy);
  await evalScript(atlasTarget(copyId,true,fixture),copy);
  const copyEdited=await snapshot(copy);

  // Browser keyboard history is exercised live. Mock the three native stages
  // for this check of the unchanged neutral gate and snapshot format.
  const evidence={before,candidate,reopened:candidate,edit,copy_before:copyBefore,copy_edited:copyEdited,
    copy_undo:copyBefore,copy_redo:copyEdited,copy_history:{undo_count:1,redo_count:1},after_probe_original:candidate};
  const temp=await mkdtemp(join(tmpdir(),'omc-atlas-mock-'));
  try {
    const path=join(temp,'evidence.json');
    await writeFile(path,JSON.stringify(evidence));
    const judged=JSON.parse(execFileSync('python3',[generator,'grade','LD02',path,'--variant','conservation-atlas'],{encoding:'utf8'}));
    assert.deepEqual(judged,{passed:true,failures:[]});
  } finally {
    await rm(temp,{recursive:true,force:true});
  }
});
