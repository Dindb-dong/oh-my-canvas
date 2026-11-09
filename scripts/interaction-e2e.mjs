import {documentPage,libraryPage} from './desktop-test-pages.mjs';
import {_electron as electron} from 'playwright';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const primary=execFileSync('git',['worktree','list','--porcelain'],{cwd:root,encoding:'utf8'}).split('\n')[0].slice('worktree '.length);
const qa=path.join(primary,'internal/docs/plans/2026-11-05-interactions/qa');
const profile=await fs.mkdtemp(path.join(os.tmpdir(),'omc-interaction-e2e-'));
await fs.mkdir(qa,{recursive:true});
const results=[],errors=[],penTrace=[],mod=process.platform==='darwin'?'Meta':'Control';
let app,page,fixtureNumber=0;
const identity={a:1,b:0,c:0,d:1,e:0,f:0};
function shape(id,type,x,y,width,height,props={}) {
  return {id,type,name:id,parentId:'board',enclosingFrameId:'board',x,y,width,height,
    box:{x,y,width,height},corners:[{x,y},{x:x+width,y},{x:x+width,y:y+height},{x,y:y+height}],
    rotation:0,transform:{...identity},inverseTransform:{...identity},fills:[{color:'#7c9fe5'}],strokes:[],...props};
}
function fixture(items=[]) {
  const objects={root:shape('root','frame',0,0,1000,800,{parentId:'root',enclosingFrameId:'root',childIds:['board'],fills:[]}),
    board:shape('board','frame',40,40,720,540,{parentId:'root',enclosingFrameId:'root',childIds:[],fills:[{color:'#ffffff'}]})};
  for(const item of items)objects[item.id]=item;
  for(const item of items)objects[item.parentId].childIds??=[];
  for(const item of items)objects[item.parentId].childIds.push(item.id);
  return {pages:['page'],pagesById:{page:{id:'page',name:'Interaction QA',objects}},components:{},styles:{},libraries:{}};
}
async function until(fn,message,timeout=8000) {
  const end=Date.now()+timeout;let last;
  while(Date.now()<end){try{const value=await fn();if(value)return value;}catch(error){last=error;}await new Promise(r=>setTimeout(r,60));}
  throw Error(message+(last?': '+last.message:''));
}
async function snapshot(){return page.evaluate(()=>window.omc.invoke('snapshot'));}
async function objects(){const s=await snapshot();return s.document.pagesById[s.document.pages[0]].objects;}
async function selected(){return page.locator('#editor .layers .row[aria-selected=true]').evaluateAll(nodes=>nodes.map(n=>n.dataset.id));}
async function fresh(items=[]) {
  await page.mouse.up();await page.keyboard.press('Escape');
  page=await libraryPage(app,{closeTabs:true});
  const file=path.join(profile,`fixture-${fixtureNumber++}.json`);
  await fs.writeFile(file,JSON.stringify(fixture(items)));
  await app.evaluate(({dialog},file)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]});},file);
  await page.locator('#import').click();page=await documentPage(app);
  await until(async()=>{const o=await objects();return !!o.board&&Object.keys(o).length===items.length+2;},'fixture did not open');
  await page.waitForFunction(()=>!!window.lvMcp&&!document.querySelector('#editor')?.inert);
  await page.locator('#editor .ltabs button').filter({hasText:'Layers'}).click();
  await choose('move');
  await click(20,20);
}
async function point(x,y){const box=await page.locator('#editor #stage').boundingBox();return {x:box.x+x,y:box.y+y};}
async function click(x,y,options={}){const p=await point(x,y);await page.mouse.click(p.x,p.y,options);}
async function drag(from,to){const a=await point(...from),b=await point(...to);await page.mouse.move(a.x,a.y);await page.mouse.down();await page.mouse.move(b.x,b.y,{steps:8});await page.mouse.up();}
async function choose(tool){await page.locator(`#editor [data-tool="${tool}"]`).click();}
async function row(id,options={}){await page.locator(`#editor .layers .row[data-id="${id}"] .name`).click(options);}
async function tracePen(label){
  const trace=await page.evaluate(async()=>{
    const result=await window.lvMcp.handleToolCall('interaction-qa','get_context',{});
    const context=result.structuredContent??JSON.parse(result.content[0].text);
    const html=context.selection?.[0]?await window.lvMcp.handleToolCall('interaction-qa','get_html',{id:context.selection[0]}):null;
    return {context,html,nodes:[...document.querySelectorAll('#overlay .path-node')].map(n=>({left:n.style.left,top:n.style.top})),paths:[...document.querySelectorAll('#stage svg [data-shape-id] path')].map(n=>n.getAttribute('d'))};
  });
  penTrace.push({label,...trace});
}
async function shot(name){await page.screenshot({path:path.join(qa,name+'.png')});}
async function undo(){await page.keyboard.press(mod+'+z');}
async function test(name,fn){
  const start=Date.now();
  try{await fn();results.push({name,status:'passed',ms:Date.now()-start});console.log('PASS',name);}
  catch(error){await shot(name+'-failure').catch(()=>{});results.push({name,status:'failed',error:error.stack,ms:Date.now()-start});console.log('FAIL',name,error.message);}
}
async function layerDrag(source,target,placement) {
  const src=page.locator(`.layers .row[data-id="${source}"]`),dst=page.locator(`.layers .row[data-id="${target}"]`);
  await src.scrollIntoViewIfNeeded();let a=await src.boundingBox();
  await page.mouse.move(a.x+90,a.y+a.height/2);await page.mouse.down();
  await page.mouse.move(a.x+96,a.y+a.height/2,{steps:2});
  await dst.scrollIntoViewIfNeeded();const b=await dst.boundingBox();
  const y=b.y+(placement==='before'?2:placement==='after'?b.height-2:b.height/2);
  await page.mouse.move(b.x+110,y,{steps:12});
  // Chromium begins native HTML DnD after crossing its drag threshold; a second move delivers dragover.
  await page.mouse.move(b.x+111,y);
  return async()=>page.mouse.up();
}
try {
  app=await electron.launch({args:[root,`--profile=${profile}`],env:{...process.env,OMC_TEST_BACKGROUND:'1',ELECTRON_DISABLE_SECURITY_WARNINGS:'true'},timeout:30000});
  page=await app.firstWindow();page.setDefaultTimeout(8000);
  page.on('pageerror',error=>errors.push(error.message));
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1500,980));
  await page.locator('#new').waitFor();
  await test('pen-closed-path',async()=>{
    await fresh();await choose('pen');
    await click(120,120);await tracePen('first point');await click(260,120);await tracePen('second point');await click(260,240);await tracePen('third point');
    assert.equal(await page.locator('#overlay .transform-handle').count(),0,'pen must not expose transform hit targets');
    const hover=await point(170,260);await page.mouse.move(hover.x,hover.y);
    assert.equal(await page.locator('svg[data-pen-preview=true]').count(),1,'next pen segment preview missing');
    await shot('pen-live-preview');await click(120,120);await tracePen('clicked first point to close');
    const pen=await until(async()=>Object.values(await objects()).find(s=>s.name==='Pen'),'closed pen not committed');
    assert.equal(pen.content.at(-1).command,'close');
    assert.equal(pen.content.filter(n=>n.command==='line').length,2);
    assert.deepEqual(pen.content.filter(n=>n.command!=='close').map(({x,y})=>({x,y})),[{x:120,y:120},{x:260,y:120},{x:260,y:240}],'pen endpoints must match mouse clicks');
    await shot('pen-closed-path');await undo();
    await until(async()=>!Object.values(await objects()).some(s=>s.name==='Pen'),'one Undo did not remove whole pen');
  });
  await test('pen-curve-enter',async()=>{
    await fresh();await choose('pen');await drag([120,180],[160,120]);await drag([300,180],[340,240]);
    await page.keyboard.press('Enter');
    const pen=await until(async()=>Object.values(await objects()).find(s=>s.name==='Pen'),'curve not committed');
    assert.ok(pen.content.some(n=>n.command==='curve'));
    assert.deepEqual(pen.content.map(({x,y})=>({x,y})),[{x:120,y:180},{x:300,y:180}],'curve anchors must match mouse down points');
    const curve=pen.content.find(n=>n.command==='curve');
    assert.equal(curve.x1,160);assert.equal(curve.y1,120);assert.equal(curve.x2,260);assert.equal(curve.y2,120);
    await shot('pen-curve-enter');
  });
  await test('pen-tool-switch',async()=>{
    await fresh();await choose('pen');await click(120,120);await click(260,210);
    await page.keyboard.press('v');
    const pen=await until(async()=>Object.values(await objects()).find(s=>s.name==='Pen'),'V did not finish valid pen');
    assert.equal(await page.locator('[data-tool="move"][aria-pressed=true]').count(),1);
    await drag([190,165],[230,195]);
    await until(async()=>(await objects())[pen.id].x!==pen.x,'move blocked after pen tool switch');
  });
  await test('pen-handle-return-to-anchor',async()=>{
    await fresh();await choose('pen');
    for(const x of [120,300]) {
      const p=await point(x,180);await page.mouse.move(p.x,p.y);await page.mouse.down();
      await page.mouse.move(p.x+40,p.y-60,{steps:4});await page.mouse.move(p.x,p.y,{steps:4});await page.mouse.up();
    }
    await click(420,180);await page.keyboard.press('Enter');
    const pen=await until(async()=>Object.values(await objects()).find(s=>s.name==='Pen'),'returned handle path not committed');
    assert.deepEqual(pen.content.map(({x,y})=>({x,y})),[{x:120,y:180},{x:300,y:180},{x:420,y:180}]);
    assert.equal(pen.content[1].x1,120);assert.equal(pen.content[1].y1,180);
    assert.equal(pen.content[1].x2,300);assert.equal(pen.content[1].y2,180);
    assert.equal(pen.content[2].x1,300);assert.equal(pen.content[2].y1,180);
  });
  await test('pen-double-click-finish',async()=>{
    await fresh();await choose('pen');await click(120,120);await click(260,120,{clickCount:2});
    const pen=await until(async()=>Object.values(await objects()).find(s=>s.name==='Pen'),'double-click path not committed');
    assert.deepEqual(pen.content.map(({x,y})=>({x,y})),[{x:120,y:120},{x:260,y:120}],'double-click must not duplicate final endpoint');
  });
  await test('canvas-shift-and-jitter',async()=>{
    await fresh([shape('A','rect',100,100,80,60),shape('B','rect',260,100,80,60)]);
    await click(140,130);await page.keyboard.down('Shift');await click(300,130);await page.keyboard.up('Shift');
    assert.deepEqual(new Set(await selected()),new Set(['A','B']));
    const p=await point(300,130);await page.mouse.move(p.x,p.y);await page.mouse.down();await page.mouse.move(p.x+2,p.y+1);await page.mouse.up();
    const o=await objects();assert.equal(o.A.x,100);assert.equal(o.B.x,260);
    assert.equal(await page.locator('#overlay .selection-member[data-id]').count(),2,'individual selected bounds must be visible');
    assert.equal(await page.locator('#overlay .selection-outline:not(.selection-member)').count(),1,'aggregate bounds must be visible');
    await shot('canvas-multiple-selection');
  });
  await test('frame-interior-marquee',async()=>{
    await fresh([shape('A','rect',100,100,80,60),shape('B','rect',260,100,80,60)]);
    await drag([80,80],[355,175]);
    assert.deepEqual(new Set(await selected()),new Set(['A','B']));
    assert.equal((await objects()).board.x,40);assert.equal((await objects()).board.y,40);
    await shot('frame-interior-marquee');
  });
  await test('layer-range-selection',async()=>{
    const items=Array.from({length:10},(_,i)=>shape('L'+String(i+1).padStart(2,'0'),'rect',100+i*14,100+i*10,50,40));
    await fresh(items);await row('L10');await row('L01',{modifiers:['Shift']});
    assert.equal((await selected()).length,10);
    assert.equal(await page.locator('.layers[aria-multiselectable=true]').count(),1);
    await shot('layer-range-selection');
  });
  const orderItems=()=>['A','B','C','D','E'].map((id,i)=>shape(id,'rect',100+i*60,100,40,40));
  for(const placement of ['before','after'])await test('layer-drop-'+placement,async()=>{
    await fresh(orderItems());await row('D');await row('B',{modifiers:[mod]});
    assert.deepEqual(new Set(await selected()),new Set(['B','D']));
    const release=await layerDrag('D','C',placement);
    assert.equal(await page.locator(`.layers .row[data-id="C"][data-drop="${placement}"]`).count(),1,'destination preview missing');
    await shot('layer-drop-'+placement+'-preview');await release();
    const expected=placement==='before'?['A','C','B','D','E']:['A','B','D','C','E'];
    await until(async()=>JSON.stringify((await objects()).board.childIds)===JSON.stringify(expected),'drop differs from preview/order');
    assert.equal(await page.locator('.layers [data-drop]').count(),0,'drop indication was not cleared');
    await undo();await until(async()=>JSON.stringify((await objects()).board.childIds)==='["A","B","C","D","E"]','Undo did not restore layer order');
  });
  await test('layer-drop-inside',async()=>{
    await fresh([...orderItems(),shape('target','frame',450,250,200,180,{childIds:[]})]);
    await row('D');await row('B',{modifiers:[mod]});
    const release=await layerDrag('D','target','inside');
    assert.equal(await page.locator('.layers .row[data-id="target"][data-drop="inside"]').count(),1,'inside preview missing');
    await shot('layer-drop-inside-preview');await release();
    await until(async()=>JSON.stringify((await objects()).target.childIds)==='["B","D"]','inside drop changed relative order');
    const o=await objects();assert.equal(o.B.parentId,'target');assert.equal(o.B.x,160);assert.equal(o.B.y,100);
    await undo();await until(async()=>(await objects()).B.parentId==='board','Undo did not restore parents');
  });
  assert.deepEqual(errors,[],'renderer errors');
} catch(error) {results.push({name:'runner',status:'failed',error:error.stack});console.error(error);}
finally {
  if(page)await page.evaluate(()=>window.omc.invoke('flush')).catch(()=>{});
  if(app)await app.close().catch(()=>{});
  await fs.rm(profile,{recursive:true,force:true,maxRetries:5,retryDelay:150});
  const report={passed:results.every(r=>r.status==='passed')&&errors.length===0,results,rendererErrors:errors,at:new Date().toISOString()};
  await fs.writeFile(path.join(qa,'result.json'),JSON.stringify(report,null,2));
  await fs.writeFile(path.join(qa,'pen-trace.json'),JSON.stringify(penTrace,null,2));
  if(!report.passed)process.exitCode=1;
}
