import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {
  atlasDifferences,atlasInventory,atlasTarget,readAtlasPage,readAtlasPages,reopenAtlas,runAtlasModel,seedAtlasPage,
  seedSaveFence,seedFenceReadback,validateFixture,
} from './ld02-atlas.mjs';

const generator = 'tools/local-dev-bench/workloads/synthetic.py';
const fixture = validateFixture(JSON.parse(execFileSync('python3',[generator,'fixture','LD02',
  '--variant','conservation-atlas'],{encoding:'utf8'})));
const id = '00000000-0000-4000-8000-000000000001';
const copyId = '00000000-0000-4000-8000-000000000002';
const Async = (async () => {}).constructor;
const evalScript = (code,penpot) => new Async('penpot',code)(penpot);

test('final seed fence waits for contentsave and independently reads the persisted marker',async()=>{
  const marker='a'.repeat(32), data=new Map();
  let callback, detached=false;
  const page={id:copyId,setPluginData:(key,value)=>{data.set(key,value);queueMicrotask(callback);},
    getPluginData:key=>data.get(key)};
  const app={currentFile:{id,pages:[page]},currentPage:page,
    on:(event,listener)=>{assert.equal(event,'contentsave');callback=listener;return 'listener';},
    off:listener=>{assert.equal(listener,'listener');detached=true;}};
  assert.deepEqual(await evalScript(seedSaveFence(id,marker),app),{pageId:copyId,marker,contentsave:true});
  assert.ok(detached);
  assert.equal(await evalScript(seedFenceReadback(id,copyId),app),marker);
  await assert.rejects(evalScript(seedFenceReadback(copyId,id),app),/Wrong isolated/);
});

test('normal reopen closes the old workspace and awaits document readiness before attach',async()=>{
  const calls=[];
  const fresh={goto:async(url,options)=>calls.push(['navigate',url,options])};
  const original={close:async()=>calls.push(['closed'])};
  const context={newPage:async()=>{calls.push(['created']);return fresh;}};
  const url=new URL('http://localhost:19001/?screen=workspace');
  const result=await reopenAtlas(original,context,url,async page=>{assert.equal(page,fresh);calls.push(['attached']);});
  assert.equal(result,fresh);
  assert.deepEqual(calls,[['created'],['closed'],['navigate',url.href,{waitUntil:'domcontentloaded'}],['attached']]);
});

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

test('batched Atlas capture preserves native page bindings and row order', async () => {
  const app = synthetic(id);
  await seed(app);
  const {pages} = await evalScript(atlasInventory(fixture,id),app);
  const pair = pages.slice(0,2);
  const single = await Promise.all(pair.map(page => evalScript(readAtlasPage(page,id),app)));
  const batched = await evalScript(readAtlasPages(pair,id),app);
  assert.equal(batched.length,200);
  assert.deepEqual(batched,single.flat());
  await assert.rejects(evalScript(readAtlasPages(pair,copyId),app), /Wrong isolated Atlas document/);
});

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

const selector = {name:'Ceramics review',receipt:'AC-270'};

async function fakeAgent(operations) {
  const dir = await mkdtemp(join(tmpdir(),'omc-atlas-agent-'));
  const executable = join(dir,'agent.mjs');
  await writeFile(executable,`#!${process.execPath}
import assert from 'node:assert/strict';
import {connect} from 'node:net';
async function send(name,args) {
  const client = connect(process.argv[2]);
  client.on('connect',()=>client.write(JSON.stringify({name,arguments:args})+'\\n'));
  let body = '';
  for await (const chunk of client) body += chunk;
  return JSON.parse(body);
}
for (const [name,args,expected] of ${JSON.stringify(operations)}) {
  const reply = await send(name,args);
  if (typeof expected === 'string') assert.match(reply.error,new RegExp(expected));
  else assert.deepEqual(reply.result,expected);
}
`,{mode:0o700});
  return {executable,cleanup:() => rm(dir,{recursive:true,force:true})};
}

test('Atlas model lookup reads native distractors without switching pages and guards current file/selection/IDs', async () => {
  const work = synthetic(id);
  await seed(work);
  const startingPage = work.currentPage.id;
  const read = station => evalScript(atlasTarget(id,false,fixture,{selector:station}),work);
  const before = await snapshot(work);
  await assert.rejects(read({...selector,receipt:'AC-207'}),/absent or ambiguous/);
  const other = before.nodes.find(node => node.kind === 'frame' && node.name !== selector.name &&
    before.nodes.some(row => row.parent === node.key && row.name === 'receipt'));
  const otherReceipt = before.nodes.find(node => node.parent === other.key && node.name === 'receipt').text;
  assert.ok(await read({name:other.name,receipt:otherReceipt}));
  assert.deepEqual(await read(selector),{text:'Condition check pending',gap:8,radius:4});
  assert.equal(work.currentPage.id,startingPage);
  assert.equal(await read({...selector,receipt:'AC-999'}),null);
  await assert.rejects(evalScript(atlasTarget(copyId,false,fixture,{selector}),work),/Wrong isolated Atlas/);
  const scoped = Object.fromEntries(fixture.edit.map(({key,field}) =>
    [field,before.nodes.find(node => node.key === key).native_id]));
  scoped.page = before.pages.find(page => page.key === fixture.working_page).native_id;
  const requested = {text:'Model-selected change',gap:15,radius:11};
  const edit = scope => evalScript(atlasTarget(id,true,fixture,{selector,requested,nativeScope:scope}),work);
  await assert.rejects(edit(scoped),/outside the permitted working page/);
  await work.openPage(work.currentFile.pages.find(page => page.id === scoped.page));
  work.selection = [{id:scoped.gap}];
  await assert.rejects(edit(scoped),/requires cleared selection/);
  work.selection = [];
  await assert.rejects(edit({...scoped,text:'unregistered'}),/unregistered native shape/);
  assert.deepEqual(await snapshot(work),before);
});

test('Atlas model command performs one native batch and does not substitute the grader values', async () => {
  const work = synthetic(id);
  await seed(work);
  const pageName = fixture.start.pages.find(page => page.key === fixture.working_page).name;
  await work.openPage(work.currentFile.pages.find(page => page.name === pageName));
  const before = await snapshot(work);
  const edits = {text:'Model-selected change',gap_px:15,radius_px:11};
  const command = await fakeAgent([
    ['edit_section',{...selector,...edits},'Locate the permitted station'],
    ['find_section',selector,{...selector,text:'Condition check pending',gap_px:8,radius_px:4}],
    ['edit_section',{...selector,...edits},{...selector,...edits}],
    ['edit_section',{...selector,...edits},'already attempted'],
  ]);
  const modelTools = [];
  let writes = 0;
  const actions = await runAtlasModel({
    execute:code => evalScript(code,work),fixture,fileId:id,before,modelCommand:command.executable,modelTools,
    beforeWrite:() => { writes++; },
  }).finally(command.cleanup);
  assert.equal(writes,1);
  assert.deepEqual(modelTools.map(event => event.status),['rejected','ok','ok','rejected']);
  assert.deepEqual(actions.map(action => action.to),['Model-selected change',15,11]);
  const after = await snapshot(work);
  assert.deepEqual(before.nodes.map(node => node.native_id),after.nodes.map(node => node.native_id));
  assert.notDeepEqual(actions,fixture.edit);
  assert.ok(atlasDifferences(fixture.expected,after,2).some(issue => issue.endsWith('/status.text')));
});

test('Atlas model completion without a tool write preserves the entire original', async () => {
  const work = synthetic(id);
  await seed(work);
  const before = await snapshot(work);
  const command = await fakeAgent([]);
  const actions = await runAtlasModel({
    execute:code => evalScript(code,work),fixture,fileId:id,before,modelCommand:command.executable,modelTools:[],
    beforeWrite:() => assert.fail('No fallback write is allowed'),
  }).finally(command.cleanup);
  assert.deepEqual(actions,[]);
  assert.deepEqual(await snapshot(work),before);
});
