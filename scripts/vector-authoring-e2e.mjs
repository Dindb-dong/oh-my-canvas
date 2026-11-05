/** Real Electron authoring regressions, isolated from the user's canvas library. */
import {_electron as electron} from 'playwright';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const primary=execFileSync('git',['worktree','list','--porcelain'],{cwd:root,encoding:'utf8'}).split('\n')[0].slice(9);
const output=path.join(primary,'internal/docs/vector-authoring/runtime');
const temporary=await fs.mkdtemp(path.join(os.tmpdir(),'omc-vector-e2e-'));
const results=[],errors=[],mod=process.platform==='darwin'?'Meta':'Control';
let app,page,sequence=0;
await fs.mkdir(output,{recursive:true});
const identity={a:1,b:0,c:0,d:1,e:0,f:0};
function shape(id,type,x,y,width,height,extra={}) {
  return {id,type,name:id,parentId:'board',enclosingFrameId:'board',x,y,width,height,
    box:{x,y,width,height},corners:[{x,y},{x:x+width,y},{x:x+width,y:y+height},{x,y:y+height}],
    rotation:0,transform:{...identity},inverseTransform:{...identity},fills:[{color:'#202124'}],strokes:[],...extra};
}
function fixture(items=[],boardExtra={}) {
  return {pages:['page'],pagesById:{page:{id:'page',name:'Vector authoring QA',objects:{
    root:shape('root','frame',0,0,900,700,{parentId:'root',enclosingFrameId:'root',childIds:['board'],fills:[]}),
    board:shape('board','frame',40,40,720,540,{parentId:'root',enclosingFrameId:'root',childIds:items.map(s=>s.id),fills:[],...boardExtra}),
    ...Object.fromEntries(items.map(s=>[s.id,s])),
  }}},components:{},styles:{},libraries:{}};
}
const compound=()=>shape('logo','path',100,100,200,200,{fillRule:'evenodd',content:[
  {command:'move',x:100,y:100},{command:'line',x:300,y:100},{command:'line',x:300,y:300},{command:'line',x:100,y:300},{command:'close'},
  {command:'move',x:150,y:150},{command:'line',x:250,y:150},{command:'line',x:250,y:250},{command:'line',x:150,y:250},{command:'close'},
]});
async function until(check,message,timeout=15000) {
  const end=Date.now()+timeout;let last;
  while(Date.now()<end){try{const value=await check();if(value)return value;}catch(error){last=error;}await new Promise(resolve=>setTimeout(resolve,60));}
  throw Error(message+(last?': '+last.message:''));
}
async function objects(){const snap=await page.evaluate(()=>window.omc.invoke('snapshot'));return snap.document.pagesById[snap.document.pages[0]].objects;}
async function rawTool(name,args={}){return page.evaluate(({name,args})=>window.lvMcp.handleToolCall('vector-runtime-qa',name,args,{signal:AbortSignal.timeout(45000)}),{name,args});}
async function tool(name,args={}) {
  const result=await rawTool(name,args);assert.ok(!result.isError,JSON.stringify(result));
  await page.evaluate(()=>window.omc.invoke('flush'));return result.structuredContent??JSON.parse(result.content[0].text);
}
async function fresh(items=[],boardExtra={}) {
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1500,980));
  await page.keyboard.press('Escape');
  await page.waitForFunction(()=>document.querySelector('#workspace')?.hidden||!document.querySelector('#editor')?.inert);
  if(!await page.locator('#library').isVisible())await page.locator('#home').click();
  await page.locator('#import').waitFor();
  const file=path.join(temporary,`fixture-${sequence++}.json`);await fs.writeFile(file,JSON.stringify(fixture(items,boardExtra)));
  await app.evaluate(({dialog},file)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]});},file);
  await page.locator('#import').click();
  await until(async()=>{const data=await objects();return !!data.board&&Object.keys(data).length===items.length+2;},'fixture did not open');
  await page.waitForFunction(()=>!!window.lvMcp&&!document.querySelector('#editor')?.inert);
  await page.locator('[data-tool="move"]').click();
}
async function select(id){await page.locator(`.layers .row[data-id="${id}"] .name`).click();}
async function shot(name){await page.screenshot({path:path.join(output,name+'.png')});}
async function test(name,check) {
  if(process.env.OMC_VECTOR_TEST&&!name.includes(process.env.OMC_VECTOR_TEST))return;
  const start=Date.now();
  try{await check();results.push({name,status:'passed',ms:Date.now()-start});console.log('PASS',name);}
  catch(error){await shot(name+'-failure').catch(()=>{});results.push({name,status:'failed',error:error.stack,ms:Date.now()-start});console.error('FAIL',name,error.message);}
}
async function exportSelection(format,name) {
  const file=path.join(output,name+'.'+format);await fs.rm(file,{force:true});
  await app.evaluate(({dialog},file)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath:file});},file);
  await page.locator('#export').click();await page.locator(`[data-format="${format}"]`).click();
  await until(async()=>{try{return (await fs.stat(file)).size>20;}catch{return false;}},'export did not write a file');
  await page.locator('#dialog').waitFor({state:'hidden'});return file;
}
async function pngStats(src) {
  return page.evaluate(async src=>{
    const image=new Image();image.src=src;await image.decode();const canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;
    const ctx=canvas.getContext('2d');ctx.drawImage(image,0,0);const pixels=ctx.getImageData(0,0,image.width,image.height).data;
    let transparent=0,opaque=0;for(let i=3;i<pixels.length;i+=4){transparent+=pixels[i]===0;opaque+=pixels[i]>240;}
    return {width:image.width,height:image.height,transparent,opaque};
  },src);
}
async function stageCrop(region={x:70,y:70,width:550,height:300}) {
  const stage=await page.locator('#stage').boundingBox();return page.screenshot({clip:{...region,x:stage.x+region.x,y:stage.y+region.y},scale:'css'});
}
async function compareInk(before,after) {
  return page.evaluate(async pair=>{
    const read=async src=>{const image=new Image();image.src=src;await image.decode();const c=document.createElement('canvas');c.width=image.width;c.height=image.height;const ctx=c.getContext('2d');ctx.drawImage(image,0,0);return {pixels:ctx.getImageData(0,0,c.width,c.height).data,width:c.width,height:c.height};};
    const [original,current]=await Promise.all(pair.map(read)),{width,height}=original,a=original.pixels,b=current.pixels,aa=new Uint8Array(a.length/4),bb=new Uint8Array(b.length/4);let union=0,intersection=0;
    for(let i=0;i<a.length;i+=4){aa[i/4]=a[i]<120&&a[i+1]<120&&a[i+2]<120;bb[i/4]=b[i]<120&&b[i+1]<120&&b[i+2]<120;union+=aa[i/4]||bb[i/4];intersection+=aa[i/4]&&bb[i/4];}
    const coverage=(from,to)=>{let total=0,matched=0;for(let i=0;i<from.length;i++){if(!from[i])continue;total++;const x=i%width,y=Math.floor(i/width);let found=false;for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++)if(x+dx>=0&&x+dx<width&&y+dy>=0&&y+dy<height&&to[(y+dy)*width+x+dx])found=true;matched+=found;}return {total,coverage:matched/Math.max(1,total)};};
    const mass=pixels=>{let total=0;for(let i=0;i<pixels.length;i+=4)if(Math.max(pixels[i],pixels[i+1],pixels[i+2])<230&&Math.max(pixels[i],pixels[i+1],pixels[i+2])-Math.min(pixels[i],pixels[i+1],pixels[i+2])<40)total+=(240-(pixels[i]+pixels[i+1]+pixels[i+2])/3)/240;return total;};
    return {union,intersection,iou:intersection/Math.max(1,union),reference:{...coverage(aa,bb),mass:mass(a)},actual:{...coverage(bb,aa),mass:mass(b)}};
  },[before,after].map(bytes=>'data:image/png;base64,'+bytes.toString('base64')));
}
try {
  app=await electron.launch({executablePath:process.env.OMC_ELECTRON_EXECUTABLE,args:[root,`--profile=${temporary}/profile`],env:{...process.env,OMC_TEST_BACKGROUND:'1',ELECTRON_DISABLE_SECURITY_WARNINGS:'true'},timeout:30000});
  page=await app.firstWindow();page.setDefaultTimeout(10000);page.on('pageerror',error=>{errors.push(error.stack??error.message);console.error('Renderer error:',error.stack??error.message);});
  page.on('console',message=>{if(message.type()==='error')console.error('Renderer console:',message.text().slice(0,500));});
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1500,980));
  console.log('Window URL:',page.url());await page.locator('#new').waitFor();
  await test('svg-import-creates-editable-paths',async()=>{
    await fresh();await tool('write_svg',{target:'board',position:'last',svg:'<svg xmlns="http://www.w3.org/2000/svg" width="240" height="240"><path fill="#202124" fill-rule="evenodd" d="M20 20H220V220H20Z M70 70H170V170H70Z"/></svg>'});
    const paths=Object.values(await objects()).filter(s=>s.type==='path');assert.equal(paths.length,1);
    const result=await tool('get_path',{id:paths[0].id});assert.equal(result.editable,true);assert.equal(result.coordinateSpace,'world');
    assert.equal(result.segments.filter(s=>s.command==='close').length,2);await select(paths[0].id);await shot('editable-svg');
  });
  await test('compound-path-edit-keeps-inner-contour',async()=>{
    await fresh([compound()]);const original=await tool('get_path',{id:'logo'});
    await tool('edit_path',{id:'logo',revision:original.revision,action:'move_nodes',indices:[1],dx:15,dy:0});
    const edited=(await objects()).logo.content;assert.equal(edited[1].x,315);assert.deepEqual(edited.slice(5),compound().content.slice(5));
    const stale=await rawTool('edit_path',{id:'logo',revision:original.revision,action:'move_nodes',indices:[1],dx:99,dy:0});assert.equal(stale.isError,true);
    await tool('undo');assert.deepEqual((await objects()).logo.content,compound().content);
  });
  await test('imported-path-edits-render-after-moving-and-rotating',async()=>{
    await fresh();await tool('write_svg',{target:'board',position:'last',svg:'<svg xmlns="http://www.w3.org/2000/svg" width="240" height="240"><path d="M20 20H200V200H20Z"/></svg>'});
    const imported=Object.values(await objects()).find(s=>s.type==='path'),original=await tool('get_path',{id:imported.id});
    await tool('edit_path',{id:imported.id,revision:original.revision,action:'move_nodes',indices:[1],dx:30,dy:12});await select(imported.id);
    const x=page.getByLabel('X',{exact:true});await x.fill(String(imported.x+20));await x.press('Enter');
    const rotation=page.getByLabel('Rotate',{exact:true});await rotation.fill('30');await rotation.press('Enter');
    await until(async()=>Math.abs((await objects())[imported.id].rotation-30)<.001,'rotation did not commit');
    const current=(await objects())[imported.id];
    const svg=await fs.readFile(await exportSelection('svg','edited-transformed-svg'),'utf8');
    for(const node of current.content.filter(s=>s.command!=='close'))assert.ok(svg.includes(`${node.x} ${node.y}`),'export omitted edited native coordinates');
    const displayed=await page.locator(`#stage [data-shape-id="${imported.id}"] path`).evaluateAll(nodes=>nodes.map(n=>n.getAttribute('d')).join(' '));
    assert.ok(displayed.includes(`${current.content[1].x} ${current.content[1].y}`),'on-screen path retained stale SVG geometry');await shot('edited-transformed-svg');
  });
  await test('boolean-subtraction-preserves-operands',async()=>{
    await fresh([shape('outer','rect',100,100,200,200),shape('inner','ellipse',150,150,100,100)]);
    const context=await tool('get_context');const result=await tool('boolean',{ids:['outer','inner'],operation:'subtract',revision:context.revision});
    const data=await objects();assert.equal(data[result.rawId].type,'boolean');assert.deepEqual(data[result.rawId].childIds,['outer','inner']);assert.equal(data.outer.parentId,result.rawId);assert.equal(data.inner.parentId,result.rawId);
    await select(result.rawId);await shot('boolean-hole');await tool('undo');assert.equal((await objects()).outer.parentId,'board');
  });
  await test('numeric-node-edit-moves-selected-anchor',async()=>{
    await fresh([compound()]);await select('logo');await page.getByRole('button',{name:'Edit nodes',exact:true}).click();
    await page.getByLabel('Selected node',{exact:true}).selectOption('1');const x=page.getByLabel('Node X',{exact:true});await x.fill('322');await x.press('Enter');
    await until(async()=>(await objects()).logo.content[1].x===322,'numeric edit did not move anchor');assert.deepEqual((await objects()).logo.content.slice(5),compound().content.slice(5));await shot('numeric-path-inspector');
    await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(960,640));await x.scrollIntoViewIfNeeded();
    const field=await x.boundingBox(),inspector=await page.locator('#right').boundingBox();assert.ok(field.x>=inspector.x&&field.x+field.width<=inspector.x+inspector.width+1,'node field overflows compact inspector');await shot('numeric-path-inspector-compact');
    await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1500,980));
  });
  await test('boolean-flatten-result-supports-node-editing',async()=>{
    await fresh([shape('outer','rect',100,100,200,200),shape('inner','ellipse',150,150,100,100)]);const context=await tool('get_context');
    const combined=await tool('boolean',{ids:['outer','inner'],operation:'subtract',revision:context.revision});const flattened=await tool('boolean',{ids:[combined.rawId],operation:'flatten',revision:combined.revision});
    const native=await tool('get_path',{id:flattened.rawId});assert.equal(native.editable,true);assert.equal((await objects())[combined.rawId].hidden,true);
    const index=native.segments.findIndex(s=>s.command!=='close');await tool('edit_path',{id:flattened.rawId,revision:native.revision,action:'move_nodes',indices:[index],dx:8,dy:4});
    const edited=(await objects())[flattened.rawId].content[index];assert.equal(edited.x,native.segments[index].x+8);assert.equal(edited.y,native.segments[index].y+4);
  });
  await test('stroke-outline-preserves-original-and-appearance',async()=>{
    await fresh([shape('stroke','path',100,130,250,100,{fills:[],strokes:[{color:'#202124',width:12}],strokeCap:'round',strokeJoin:'round',content:[{command:'move',x:100,y:230},{command:'curve',x1:170,y1:100,x2:270,y2:100,x:350,y:230}]})]);
    await select('stroke');const before=await stageCrop();await page.getByRole('button',{name:'Outline stroke',exact:true}).click();
    const outlined=await until(async()=>Object.values(await objects()).find(s=>s.id!=='stroke'&&s.type==='path'),'stroke outline was not created');
    assert.equal((await objects()).stroke.hidden,true);assert.ok(outlined.content.length>4);await select('board');const after=await stageCrop();const comparison=await compareInk(before,after);assert.ok(comparison.iou>.90,JSON.stringify(comparison));await fs.writeFile(path.join(output,'stroke-pixel-comparison.json'),JSON.stringify(comparison,null,2));await shot('stroke-outline');
  });
  await test('polar-handle-fields-maintain-symmetric-tangents',async()=>{
    await fresh([compound()]);await select('logo');await page.getByRole('button',{name:'Edit nodes',exact:true}).click();await page.getByLabel('Selected node',{exact:true}).selectOption('1');await page.getByLabel('Node type',{exact:true}).selectOption('symmetric');
    await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(960,640));
    const angle=page.getByLabel('Incoming angle (°)',{exact:true});await angle.fill('90');await angle.press('Enter');const length=page.getByLabel('Incoming length',{exact:true});await length.fill('25');await length.press('Enter');
    assert.ok((await angle.boundingBox()).width>=32,'compact angle value has too little visible space');const data=(await objects()).logo.content;assert.ok(Math.abs(data[1].x2-300)<.001&&Math.abs(data[1].y2-125)<.001);assert.ok(Math.abs(data[2].x1-300)<.001&&Math.abs(data[2].y1-75)<.001);assert.deepEqual(data.slice(5),compound().content.slice(5));await shot('polar-path-inspector-compact');
  });
  await test('mcp-outline-undo-restores-source-and-removes-result',async()=>{
    const source=shape('stroke','path',100,130,250,100,{fills:[],strokes:[{color:'#202124',width:12}],content:[{command:'move',x:100,y:230},{command:'line',x:350,y:130}]});
    await fresh([source]);const context=await tool('get_context');await tool('outline',{ids:['stroke'],kind:'stroke',revision:context.revision});
    assert.equal((await objects()).stroke.hidden,true);assert.ok(Object.keys(await objects()).length>3);await tool('undo');
    const restored=await objects();assert.ok(!restored.stroke.hidden);assert.equal(Object.keys(restored).length,3);assert.deepEqual(restored.stroke.content,source.content);
  });
  if(!process.env.OMC_VECTOR_SKIP_TEXT)await test('mixed-text-outline-preserves-glyph-placement',async()=>{
    const content={type:'richText',verticalAlign:'top',children:[{textAlign:'left',children:[{text:'가나다 ',fontFamily:'Noto Sans KR',fontSize:48,fontWeight:400,color:'#202124'},{text:'Logo AV',fontFamily:'IBM Plex Sans',fontSize:48,fontWeight:600,color:'#202124',letterSpacing:2}]}]};
    await fresh([shape('wordmark','text',110,130,500,100,{content,fontFamily:'IBM Plex Sans',fontSize:48})]);await select('board');await page.evaluate(()=>document.fonts.ready);const before=await stageCrop();await select('wordmark');
    await page.getByRole('button',{name:'Outline text',exact:true}).click();await until(async()=>{
      const error=await page.locator('.omc-toast[role="alert"]').allTextContents();if(error.length)throw Error(error.join('; '));
      return (await objects()).wordmark.hidden===true;
    },'text outline did not preserve hidden source',30000);
    const paths=Object.values(await objects()).filter(s=>s.type==='path');assert.ok(paths.length>0);await select('board');const after=await stageCrop();const comparison=await compareInk(before,after);assert.ok(comparison.iou>.85,JSON.stringify(comparison));
    await fs.writeFile(path.join(output,'text-before.png'),before);await fs.writeFile(path.join(output,'text-after.png'),after);await fs.writeFile(path.join(output,'text-pixel-comparison.json'),JSON.stringify(comparison,null,2));
    await select(paths[0].id);const svg=await fs.readFile(await exportSelection('svg','outlined-text'),'utf8');assert.match(svg,/<path/);assert.doesNotMatch(svg,/<text\b/);await shot('text-outline');
  });
  else results.push({name:'mixed-text-outline-preserves-glyph-placement',status:'skipped',reason:'OMC_VECTOR_SKIP_TEXT requested while the outline engine is being integrated.'});
  if(!process.env.OMC_VECTOR_SKIP_TEXT)await test('rotated-text-outline-keeps-layout-slot',async()=>{
    const content={type:'richText',verticalAlign:'top',children:[{textAlign:'left',children:[{text:'Logo AV',fontFamily:'IBM Plex Sans',fontSize:40,fontWeight:400,color:'#202124'}]}]};
    await fresh([shape('wordmark','text',0,0,240,100,{content,fontFamily:'IBM Plex Sans',fontSize:40}),shape('sibling','rect',0,0,100,100,{fills:[{color:'#7dd3fc'}]})],{layout:{type:'flex',direction:'row',gap:{row:20,column:20},padding:{top:40,right:20,bottom:20,left:40}}});
    await select('wordmark');const rotate=page.getByLabel('Rotate',{exact:true});await rotate.fill('15');await rotate.press('Enter');await select('board');const previous=await objects(),region={x:30,y:20,width:600,height:360},before=await stageCrop(region);
    const context=await tool('get_context');await tool('outline',{ids:['wordmark'],kind:'text',revision:context.revision});await select('board');const data=await objects(),replacement=Object.values(data).find(s=>s.outlineSourceId==='wordmark');
    assert.ok(replacement);for(const key of ['x','y','width','height'])assert.equal(data.sibling[key],previous.sibling[key],'outline moved its layout sibling');
    const after=await stageCrop(region),comparison=await compareInk(before,after);await fs.writeFile(path.join(output,'rotated-text-before.png'),before);await fs.writeFile(path.join(output,'rotated-text-after.png'),after);await fs.writeFile(path.join(output,'rotated-text-pixel-comparison.json'),JSON.stringify(comparison,null,2));
    // Native text hinting changes edge darkness; both silhouettes must still agree within one CSS pixel.
    assert.ok(comparison.iou>.80&&comparison.reference.coverage>=.99&&comparison.actual.coverage>=.99,JSON.stringify(comparison));await shot('rotated-text-outline');
  });
  await test('save-reopen-preserves-native-paths',async()=>{
    await fresh([compound()]);const original=await tool('get_path',{id:'logo'});await tool('edit_path',{id:'logo',revision:original.revision,action:'move_nodes',indices:[1],dx:12,dy:3});
    await page.locator('#home').click();await page.locator('[data-open]').first().click();await page.waitForFunction(()=>!!window.lvMcp&&!document.querySelector('#editor')?.inert&&!document.querySelector('#workspace')?.hidden);
    assert.equal((await objects()).logo.content[1].x,312);assert.equal((await objects()).logo.content[1].y,103);
  });
  if(process.env.OMC_BACKGROUND_FIXTURE)await test('image-cutout-exports-alpha-and-restores-original',async()=>{
    const bytes=await fs.readFile(process.env.OMC_BACKGROUND_FIXTURE),src='data:image/png;base64,'+bytes.toString('base64');const input=await pngStats(src);
    await fresh([shape('photo','image',100,100,360,300,{fills:[],image:{src,width:input.width,height:input.height,mimeType:'image/png'}})]);await select('photo');await shot('image-original');
    await page.getByRole('button',{name:'Remove background',exact:true}).click();const cutout=await until(async()=>{const shape=(await objects()).photo;return shape.originalImage&&shape;},'image cutout did not complete',60000);
    assert.equal(cutout.originalImage.src,src);assert.equal(cutout.x,100);assert.equal(cutout.width,360);const stats=await pngStats(cutout.image.src);assert.ok(stats.transparent>0&&stats.opaque>0,JSON.stringify(stats));
    await shot('image-cutout');const exported=await fs.readFile(await exportSelection('png','image-cutout-export'));const exportedStats=await pngStats('data:image/png;base64,'+exported.toString('base64'));assert.ok(exportedStats.transparent>0&&exportedStats.opaque>0);await fs.writeFile(path.join(output,'image-alpha-comparison.json'),JSON.stringify({input,cutout:stats,exported:exportedStats},null,2));
    await page.getByRole('button',{name:'Restore original',exact:true}).click();await until(async()=>(await objects()).photo.image.src===src,'restore did not restore image');assert.equal((await objects()).photo.originalImage,undefined);
  });
  else results.push({name:'image-cutout-exports-alpha-and-restores-original',status:'skipped',reason:'Set OMC_BACKGROUND_FIXTURE to a local foreground photo PNG to exercise local segmentation.'});
  assert.deepEqual(errors,[],'renderer errors');
} catch(error) {results.push({name:'runner',status:'failed',error:error.stack});console.error('Window URL:',page?.url());await page?.screenshot({path:path.join(output,'runner-failure.png'),timeout:3000}).catch(error=>console.error('Screenshot failed:',error.message));console.error(error);}
finally {
  if(page)await Promise.race([page.evaluate(()=>window.omc.invoke('flush')).catch(()=>{}),new Promise(resolve=>setTimeout(resolve,2000))]);
  if(app){await Promise.race([app.evaluate(({app})=>app.exit(0)).catch(()=>{}),new Promise(resolve=>setTimeout(resolve,2000))]);if(app.process().exitCode===null)app.process().kill('SIGKILL');}
  await fs.rm(temporary,{recursive:true,force:true,maxRetries:5,retryDelay:150});
  const report={passed:results.every(r=>r.status!=='failed')&&errors.length===0,results,rendererErrors:errors,at:new Date().toISOString()};await fs.writeFile(path.join(output,'result.json'),JSON.stringify(report,null,2)+'\n');
  if(!report.passed)process.exitCode=1;console.log(JSON.stringify(report,null,2));
}
