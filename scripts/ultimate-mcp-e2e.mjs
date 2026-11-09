import {_electron as electron} from 'playwright';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {createMcpFetch} from '../core/mcp-fetch.mjs';
import {decodeFile,encodeFile} from '../core/storage.mjs';
import {Replica} from '../core/replica.mjs';
import {TOOLS} from '../dist/tool-defs.mjs';

const root=process.cwd();
const primary=execFileSync('git',['worktree','list','--porcelain'],{encoding:'utf8'}).split('\n').find(line=>line.startsWith('worktree ')).slice(9);
const evidence=path.join(primary,'internal/docs/ultimate-mcp-20261109/e2e');
execFileSync('git',['check-ignore',evidence],{cwd:primary});
await fs.mkdir(evidence,{recursive:true});
const temporary=await fs.mkdtemp(path.join(os.tmpdir(),'omc-ultimate-mcp-'));
const profile=path.join(temporary,'profile'),files=path.join(temporary,'files');
await fs.mkdir(files,{recursive:true});
await fs.writeFile(path.join(evidence,'resources.json'),JSON.stringify({owner:'ultimate-mcp-e2e',temporary,profile,files,pid:process.pid,createdAt:new Date().toISOString()},null,2)+'\n');
const clients=[],errors=[],checks=[];
let app,shell,runtime,token,mcpFetch,guest;
const record=name=>{checks.push(name);console.log('PASS '+name);};
const invoke=(client,name,args={},key)=>client.callTool({name,arguments:args,...key?{_meta:{'oh-my-canvas/idempotency-key':key}}:{}});
async function ok(client,name,args={},key){
  const result=await invoke(client,name,args,key);
  assert.ok(!result.isError,`${name}: ${JSON.stringify(result)}`);
  assert.equal(result.structuredContent?.ok,true,`${name} did not return structured success`);
  return result.structuredContent;
}
async function rejects(client,name,args={},code){
  const result=await invoke(client,name,args);
  assert.equal(result.isError,true,`${name} unexpectedly succeeded`);
  if(code)assert.equal(result.structuredContent?.error?.code,code,JSON.stringify(result));
  return result.structuredContent;
}
async function until(fn,message){
  for(let i=0;i<400;i++){
    const result=await fn();
    if(result)return result;
    await new Promise(resolve=>setTimeout(resolve,25));
  }
  throw Error(message);
}
async function runtimePage(id,instance=app){
  const page=await until(()=>instance.windows().filter(page=>{
    try{return new URL(page.url()).searchParams.get('documentId')===id;}catch{return false;}
  }).sort((a,b)=>Number(new URL(b.url()).searchParams.get('generation'))-Number(new URL(a.url()).searchParams.get('generation')))[0],'Document runtime did not appear');
  await page.waitForFunction(()=>!!window.lvMcp&&!document.querySelector('#editor').inert,null,{timeout:30000});
  return page;
}
const snapshot=page=>page.evaluate(()=>window.omc.invoke('snapshot'));
const objects=snap=>Object.values(snap.document.pagesById).flatMap(page=>Object.values(page.objects));
const named=(snap,name)=>objects(snap).filter(shape=>shape.name===name);
async function stored(id){
  const record=decodeFile(await fs.readFile(path.join(profile,'documents',`${id}.omc`),'utf8'));
  try{return structuredClone(record.replica.document);}finally{record.replica.destroy();}
}
async function launch(){
  app=await electron.launch({
    env:{...process.env,OMC_TEST_BACKGROUND:'1'},executablePath:process.env.OMC_TEST_EXECUTABLE,
    args:[...process.env.OMC_TEST_EXECUTABLE?[]:[root],`--profile=${profile}`,'--mcp-port=0'],timeout:30000
  });
  app.on('window',page=>page.on('pageerror',error=>errors.push(error.message)));
  shell=await app.firstWindow();
  await shell.locator('#new').waitFor();
  assert.equal(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].isVisible()),false,'Synthetic test must not activate the live app');
  runtime=JSON.parse(await fs.readFile(path.join(profile,'mcp-runtime.json'),'utf8'));
  token=await fs.readFile(path.join(profile,'mcp-token-v2'),'utf8');
  mcpFetch=createMcpFetch(await fs.readFile(runtime.certFile,'utf8'));
}
async function connect(stdio=false,targetProfile=profile){
  const descriptor=JSON.parse(await fs.readFile(path.join(targetProfile,'mcp-runtime.json'),'utf8'));
  const credential=await fs.readFile(path.join(targetProfile,'mcp-token-v2'),'utf8');
  const fetch=createMcpFetch(await fs.readFile(descriptor.certFile,'utf8'));
  const client=new Client({name:'ultimate-mcp-parity',version:'1'},{capabilities:{}});
  const transport=stdio
    ? new StdioClientTransport({command:process.execPath,args:[path.join(root,'dist/mcp-cli.cjs'),'--runtime',path.join(targetProfile,'mcp-runtime.json')]})
    : new StreamableHTTPClientTransport(new URL(`https://127.0.0.1:${descriptor.port}/mcp`),{fetch,requestInit:{headers:{Authorization:`Bearer ${credential}`}}});
  clients.push(client);
  await client.connect(transport);
  return client;
}
async function stop(){
  if(!app)return;
  const child=app.process();
  await app.close();
  assert.equal(child.exitCode,0);
  assert.equal(child.signalCode,null);
  app=null;
}
async function screenshotPixels(page,result){
  assert.ok(!result.isError,JSON.stringify(result));
  const image=result.content.find(item=>item.type==='image');assert.ok(image);
  return page.evaluate(async image=>{
    const bitmap=await createImageBitmap(new Blob([Uint8Array.from(atob(image.data),character=>character.charCodeAt(0))],{type:image.mimeType}));
    const canvas=new OffscreenCanvas(bitmap.width,bitmap.height),context=canvas.getContext('2d');context.drawImage(bitmap,0,0);
    const pixels=context.getImageData(0,0,bitmap.width,bitmap.height).data,counts={orange:0,violet:0};
    for(let index=0;index<pixels.length;index+=4){
      if(pixels[index]===194&&pixels[index+1]===65&&pixels[index+2]===12&&pixels[index+3]===255)counts.orange++;
      if(pixels[index]===126&&pixels[index+1]===34&&pixels[index+2]===206&&pixels[index+3]===255)counts.violet++;
    }
    return {width:bitmap.width,height:bitmap.height,...counts};
  },image);
}

async function editing(client,documentId,page){
  const call=(name,args={},key)=>ok(client,name,{documentId,...args},key);
  const first=(await call('get_context')).page.id;
  await call('page',{action:'create',name:'Agent page'});
  const created=(await call('get_context')).page.id;
  assert.notEqual(created,first);
  await call('page',{action:'rename',pageId:created,name:'Authored page'});
  await call('create_shape',{type:'rect',x:40,y:50,width:120,height:80,properties:{name:'Native rectangle',fills:[{color:'#dc2626'}],radius:12}});
  let snap=await snapshot(page),rectangle=named(snap,'Native rectangle')[0];
  assert.ok(rectangle);assert.equal(rectangle.type,'rect');assert.equal(rectangle.radius,12);
  await call('page',{action:'duplicate',pageId:created,name:'Copied page'});
  const copied=(await call('get_context')).page.id;
  snap=await snapshot(page);
  const copy=snap.document.pagesById[copied].objects;
  assert.equal(Object.values(copy).filter(shape=>shape.name==='Native rectangle').length,1);
  assert.ok(!copy[rectangle.id],'Duplicated page reused a source layer ID');
  await call('page',{action:'reorder',pageId:copied,index:0});
  assert.equal((await snapshot(page)).document.pages[0],copied);
  await call('page',{action:'delete',pageId:copied});
  assert.ok(!(await snapshot(page)).document.pages.includes(copied));
  await call('select_page',{id:created});
  record('page creation, rename, duplication with independent IDs, reorder and deletion work through MCP');

  await call('edit_shapes',{action:'patch',ids:[rectangle.id],properties:{strokeWidth:2,strokes:[{color:'#111111'}],opacity:0.8,exportSettings:[{type:'png',suffix:'@2x',scale:2}]}});
  await call('edit_shapes',{action:'translate',ids:[rectangle.id],dx:30,dy:20});
  snap=await snapshot(page);rectangle=snap.document.pagesById[created].objects[rectangle.id];
  assert.equal(rectangle.x,70);assert.equal(rectangle.y,70);assert.equal(rectangle.strokeWidth,2);
  await call('edit_shapes',{action:'resize',ids:[rectangle.id],width:140,height:90});
  await call('edit_shapes',{action:'rotate',ids:[rectangle.id],angle:15});
  snap=await snapshot(page);rectangle=snap.document.pagesById[created].objects[rectangle.id];
  assert.equal(rectangle.width,140);assert.equal(rectangle.height,90);assert.equal(rectangle.rotation,15);
  await call('edit_shapes',{action:'patch',ids:[rectangle.id],properties:{rotation:0,locked:true}});
  await rejects(client,'edit_shapes',{documentId,action:'translate',ids:[rectangle.id],dx:100,dy:0});
  await call('edit_shapes',{action:'patch',ids:[rectangle.id],properties:{locked:false}});
  await call('create_shape',{type:'ellipse',x:270,y:90,width:60,height:60,properties:{name:'Native ellipse',fills:[{color:'#2563eb'}]}});
  const ellipse=named(await snapshot(page),'Native ellipse')[0];
  await call('edit_shapes',{action:'group',ids:[rectangle.id,ellipse.id],name:'Native group'});
  const group=named(await snapshot(page),'Native group')[0];
  assert.deepEqual(new Set(group.childIds),new Set([rectangle.id,ellipse.id]));
  await call('edit_shapes',{action:'ungroup',ids:[group.id]});
  assert.ok(!(await snapshot(page)).document.pagesById[created].objects[group.id]);
  await call('edit_shapes',{action:'align',ids:[rectangle.id,ellipse.id],alignment:'top'});
  snap=await snapshot(page);
  assert.equal(snap.document.pagesById[created].objects[rectangle.id].y,snap.document.pagesById[created].objects[ellipse.id].y);
  await call('edit_shapes',{action:'mask',ids:[rectangle.id,ellipse.id],maskId:ellipse.id,mode:'alpha'});
  snap=await snapshot(page);const mask=Object.values(snap.document.pagesById[created].objects).find(shape=>shape.maskId===ellipse.id);
  assert.ok(mask?.isMaskGroup);
  await call('edit_shapes',{action:'unmask',ids:[mask.id]});
  await call('edit_shapes',{action:'ungroup',ids:[mask.id]});
  await call('edit_shapes',{action:'layout',ids:[rectangle.id,ellipse.id],layout:{type:'flex',direction:'row',gap:16}});
  snap=await snapshot(page);
  assert.ok(Object.values(snap.document.pagesById[created].objects).some(shape=>shape.layout?.type==='flex'&&shape.childIds?.includes(ellipse.id)));
  record('native shape properties, geometry, lock guards, grouping, alignment, masks and layout persist');

  await call('create_shape',{type:'text',x:40,y:260,width:360,height:60,properties:{name:'Native text',content:{type:'richText',children:[{type:'paragraph',children:[{text:'Hello canvas',fontFamily:'IBM Plex Sans',fontSize:18,fontWeight:400,fills:[{color:'#111111'}]}]}]}}});
  const text=named(await snapshot(page),'Native text')[0];
  await call('edit_text',{id:text.id,action:'range_style',range:{start:0,end:5},style:{fontWeight:700}});
  await call('edit_text',{id:text.id,action:'replace',range:{start:6,end:12},text:'MCP'});
  await call('edit_text',{id:text.id,action:'paragraph_style',style:{textAlign:'center'}});
  snap=await snapshot(page);const formatted=snap.document.pagesById[created].objects[text.id].content.children[0];
  assert.equal(formatted.children.map(run=>run.text).join(''),'Hello MCP');
  assert.equal(formatted.children[0].fontWeight,700);assert.equal(formatted.textAlign,'center');
  await call('edit_text',{id:text.id,action:'find_replace',find:'MCP',replace:'automation',all:true});
  assert.equal((await snapshot(page)).document.pagesById[created].objects[text.id].content.children[0].children.map(run=>run.text).join(''),'Hello automation');
  const unchanged=await stored(documentId);
  await rejects(client,'edit_text',{documentId,id:text.id,action:'range_style',range:{start:0,end:99999},style:{fontWeight:500}});
  assert.deepEqual(await stored(documentId),unchanged);
  record('rich text range styling, replacement, paragraph formatting and find/replace preserve valid runs');

  const clip=await call('clipboard',{action:'copy',ids:[text.id]});
  await call('clipboard',{action:'paste',x:440,y:260,...clip.payload?{payload:clip.payload}:{}});
  assert.equal(named(await snapshot(page),'Native text').length,2);
  await call('undo');assert.equal(named(await snapshot(page),'Native text').length,1);
  await call('redo');assert.equal(named(await snapshot(page),'Native text').length,2);
  await call('view',{action:'select',ids:[rectangle.id]});
  const selected=await call('get_context');assert.equal(selected.selection.length,1);
  await call('view',{action:'tool',tool:'pen'});
  assert.equal((await call('view',{action:'get'})).tool,'pen');
  await call('view',{action:'set',flags:{showRulers:true,showGrids:true}});
  assert.equal((await call('view',{action:'get'})).flags.showRulers,true);
  await call('view',{action:'fit',ids:[text.id]});
  await call('view',{action:'tool',tool:'move'});
  await call('view',{action:'select',ids:[]});
  record('private native clipboard, agent Undo/Redo, selection, tools and canvas view are operable without clicks');

  const before=await stored(documentId);
  await rejects(client,'batch',{documentId,ops:[{tool:'create_board',args:{name:'Rolled back board',width:100}},{tool:'update',args:{id:'does-not-exist',text:'Invalid'}}]});
  assert.deepEqual(await stored(documentId),before);
  await rejects(client,'batch',{documentId,ops:[
    {tool:'create_shape',args:{type:'rect',properties:{name:'Rolled back native shape'}}},
    {tool:'edit_shapes',args:{action:'patch',ids:[rectangle.id],properties:{opacity:0.2}}},
    {tool:'edit_text',args:{id:text.id,action:'replace',range:{start:0,end:99999},text:'Invalid'}},
  ]});
  assert.deepEqual(await stored(documentId),before);
  for(const [name,args] of [
    ['create_shape',{type:'rect',properties:{constructor:'forbidden'}}],
    ['edit_shapes',{action:'patch',ids:[rectangle.id],properties:{id:'forged'}}],
    ['edit_shapes',{action:'patch',ids:[rectangle.id],properties:{opacity:2}}],
    ['page',{action:'delete',pageId:'missing-page'}],
  ])await rejects(client,name,{documentId,...args});
  assert.deepEqual(await stored(documentId),before);
  await call('batch',{ops:[
    {tool:'edit_shapes',args:{action:'patch',ids:[rectangle.id],properties:{opacity:0.65}}},
    {tool:'edit_text',args:{id:text.id,action:'range_style',range:{start:0,end:5},style:{fontWeight:600}}},
  ]});
  assert.equal((await stored(documentId)).pagesById[created].objects[rectangle.id].opacity,0.65);
  await call('undo');assert.deepEqual(await stored(documentId),before);
  await call('redo');
  assert.equal((await stored(documentId)).pagesById[created].objects[text.id].content.children[0].children[0].fontWeight,600);
  record('invalid native inputs and failing mixed batches leave the durable document unchanged');
  return {pageId:created,rectangleId:rectangle.id,textId:text.id,firstPageId:first};
}

async function resources(client,documentId,page,rectangleId){
  const call=(name,args={})=>ok(client,name,{documentId,...args});
  const style=(await call('styles',{action:'create',type:'paint',name:'Agent red',value:[{color:'#dc2626'}]})).style;
  await call('styles',{action:'apply',id:style.id,ids:[rectangleId],kind:'fill'});
  assert.equal((await snapshot(page)).document.pagesById[(await call('get_context')).page.id].objects[rectangleId].fillStyleId,style.id);
  assert.ok((await call('styles',{action:'users',id:style.id})).users.some(user=>user.id===rectangleId));
  await call('styles',{action:'update',id:style.id,patch:{name:'Agent green',value:[{color:'#16a34a'}]}});
  assert.equal((await call('styles',{action:'get',id:style.id})).style.name,'Agent green');
  const copied=(await call('styles',{action:'duplicate',id:style.id,name:'Agent green copy'})).style;
  assert.notEqual(copied.id,style.id);
  await call('styles',{action:'detach',ids:[rectangleId],kind:'fill'});
  assert.ok(!(await snapshot(page)).document.pagesById[(await call('get_context')).page.id].objects[rectangleId].fillStyleId);
  await call('styles',{action:'delete',id:copied.id});
  await rejects(client,'styles',{documentId,action:'get',id:copied.id});
  const styleList=await call('styles',{action:'list',query:'Agent green'});
  assert.equal(styleList.styles.length,1);
  record('shared style CRUD, duplicate, apply, usage inspection and detach work through the real renderer');

  const library={id:'ultimate-e2e-library',name:'Agent library',version:1,enabled:true,components:{},objects:{},styles:{},variantSets:{}};
  await call('libraries',{action:'add',snapshot:library});
  assert.ok((await call('libraries',{action:'list'})).libraries.some(item=>item.id===library.id));
  const exported=await call('libraries',{action:'export',id:library.id});
  assert.equal(exported.snapshot.version,1);
  await call('libraries',{action:'update',id:library.id,snapshot:{...library,version:2,name:'Updated agent library'}});
  await call('libraries',{action:'enable',id:library.id,enabled:false});
  assert.equal((await call('libraries',{action:'get',id:library.id})).library.enabled,false);
  await call('libraries',{action:'enable',id:library.id,enabled:true});
  await call('libraries',{action:'remove',id:library.id});
  assert.ok(!(await call('libraries',{action:'list'})).libraries.some(item=>item.id===library.id));
  record('embedded libraries can be added, read, exported, updated, enabled, disabled and unlinked');

  const png=await page.evaluate(()=>{const canvas=document.createElement('canvas');canvas.width=2;canvas.height=2;const context=canvas.getContext('2d');context.fillStyle='#16a34a';context.fillRect(0,0,2,2);return canvas.toDataURL('image/png');});
  const image=(await call('document_assets',{action:'add',kind:'image',name:'Agent pixel',dataUrl:png})).asset;
  assert.equal(image.embedded,true);assert.equal('src' in image,false);
  await call('document_assets',{action:'place',id:image.id,x:440,y:80,width:80,height:80});
  assert.ok(objects(await snapshot(page)).some(shape=>shape.assetId===image.id));
  assert.ok((await call('document_assets',{action:'list',query:'Agent pixel'})).assets.some(asset=>asset.id===image.id));
  const svg='data:image/svg+xml;base64,'+Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" fill="#2563eb"/></svg>').toString('base64');
  const vector=(await call('document_assets',{action:'add',kind:'svg',name:'Agent vector asset',dataUrl:svg})).asset;
  await call('document_assets',{action:'place',id:vector.id,x:540,y:80,width:80,height:80});
  const fontUrl='data:font/woff2;base64,'+(await fs.readFile(path.join(root,'public/fonts/plex.woff2'))).toString('base64');
  const font=(await call('document_assets',{action:'add',kind:'font',name:'Agent font',family:'Agent Test Sans',dataUrl:fontUrl,weight:'100 900'})).asset;
  assert.ok((await call('fonts',{query:'Agent Test Sans'})).fonts.some(item=>item.family==='Agent Test Sans'&&item.faces.some(face=>face.status==='loaded')));
  const before=await stored(documentId);
  for(const args of [
    {kind:'image',name:'Bad external',dataUrl:'https://example.invalid/image.png'},
    {kind:'image',name:'Bad pixels',dataUrl:'data:image/png;base64,YmFk'},
    {kind:'font',name:'Bad font',family:'Invalid Sans',dataUrl:'data:font/woff2;base64,YmFk'},
  ])await rejects(client,'document_assets',{documentId,action:'add',...args});
  assert.deepEqual(await stored(documentId),before);
  await call('document_assets',{action:'remove',id:font.id});
  await call('document_assets',{action:'remove',id:vector.id});
  await call('document_assets',{action:'remove',id:image.id});
  assert.ok(!(await call('document_assets',{action:'list'})).assets.some(asset=>asset.id===image.id));
  const imageFile=path.join(files,'agent-pixel.png');await fs.writeFile(imageFile,Buffer.from(png.split(',')[1],'base64'));
  const fileAsset=(await ok(client,'import_resource',{documentId,kind:'image',filePath:imageFile,name:'File image asset'})).asset;
  await call('document_assets',{action:'place',id:fileAsset.id,x:640,y:80,width:40,height:40});
  assert.ok(objects(await snapshot(page)).some(shape=>shape.assetId===fileAsset.id));
  await call('document_assets',{action:'remove',id:fileAsset.id});
  const bmp=Buffer.alloc(58);bmp.write('BM');bmp.writeUInt32LE(58,2);bmp.writeUInt32LE(54,10);bmp.writeUInt32LE(40,14);bmp.writeInt32LE(1,18);bmp.writeInt32LE(1,22);bmp.writeUInt16LE(1,26);bmp.writeUInt16LE(24,28);bmp.writeUInt32LE(4,34);bmp.set([0x56,0x34,0x12],54);
  const bmpFile=path.join(files,'native-pixel.bmp');await fs.writeFile(bmpFile,bmp);
  const bmpAsset=(await ok(client,'import_resource',{documentId,kind:'image',filePath:bmpFile,name:'Native BMP asset'})).asset;
  assert.equal(bmpAsset.mimeType,'image/bmp');
  await call('document_assets',{action:'place',id:bmpAsset.id,x:700,y:100,width:30,height:30});
  const bmpShape=objects(await snapshot(page)).find(shape=>shape.assetId===bmpAsset.id);assert.ok(bmpShape);
  const bmpPixel=await page.evaluate(async source=>{const image=new Image();image.src=source;await image.decode();const canvas=document.createElement('canvas');canvas.width=1;canvas.height=1;const context=canvas.getContext('2d');context.drawImage(image,0,0);return [...context.getImageData(0,0,1,1).data];},bmpShape.image.src);
  assert.deepEqual(bmpPixel,[0x12,0x34,0x56,255]);
  await call('document_assets',{action:'remove',id:bmpAsset.id});
  record('embedded image, SVG and real font imports, placement, search and removal reject invalid data atomically');

  for(const format of ['svg','png','jpg','webp','pdf','html','json']){
    const exported=await call('export_selection',{format,ids:[rectangleId],scale:1});
    assert.equal(typeof exported.data,'string',`${format} returned no export payload`);
    const bytes=Buffer.from(exported.data,exported.encoding==='base64'?'base64':'utf8');
    if(format==='svg')assert.match(bytes.toString(),/<svg\b/);
    if(format==='html')assert.match(bytes.toString(),/<[a-z]/);
    if(format==='json')assert.ok(JSON.parse(bytes.toString()));
    if(format==='pdf')assert.equal(bytes.subarray(0,5).toString(),'%PDF-');
    if(format==='jpg')assert.deepEqual([...bytes.subarray(0,2)],[255,216]);
    if(format==='webp'){assert.equal(bytes.subarray(0,4).toString(),'RIFF');assert.equal(bytes.subarray(8,12).toString(),'WEBP');}
    if(format==='png'){
      assert.equal(bytes.subarray(1,4).toString(),'PNG');
      await fs.writeFile(path.join(evidence,'native-rectangle.png'),bytes);
    }
  }
  record('native selection exports produce SVG, PNG, JPEG, WebP, PDF, HTML and editable JSON');
}

async function collaborate(client,documentId,page){
  assert.equal((await ok(client,'collaboration',{action:'status',documentId})).mode,'offline');
  const hosted=await ok(client,'collaboration',{action:'host',documentId,port:0,name:'MCP host'});
  assert.ok(hosted.port>0);
  const invitation=await ok(client,'collaboration',{action:'invite',documentId,address:`127.0.0.1:${hosted.port}`});
  const guestProfile=path.join(temporary,'guest');
  guest=await electron.launch({
    env:{...process.env,OMC_TEST_BACKGROUND:'1'},executablePath:process.env.OMC_TEST_EXECUTABLE,
    args:[...process.env.OMC_TEST_EXECUTABLE?[]:[root],`--profile=${guestProfile}`,'--mcp-port=0'],timeout:30000
  });
  guest.on('window',page=>page.on('pageerror',error=>errors.push(error.message)));
  const guestShell=await guest.firstWindow();await guestShell.locator('#new').waitFor();
  const peer=await connect(false,guestProfile);
  await guest.evaluate(({app},documentId)=>{
    const {createRequire}=process.getBuiltinModule('module'),{join}=process.getBuiltinModule('path');
    const {Collaboration}=createRequire(join(app.getAppPath(),'package.json'))('./core/collaboration.mjs');
    const original=Collaboration.prototype.join,state={ready:false,release:()=>{},restore:()=>{Collaboration.prototype.join=original;}};
    globalThis.__ultimateJoinRace=state;
    Collaboration.prototype.join=async function(invitation){
      const result=await original.call(this,invitation);
      if(this.id===documentId){state.candidate=this;state.ready=true;await new Promise(resolve=>{state.release=resolve;});}
      return result;
    };
  },documentId);
  let pendingJoin;
  try{
    pendingJoin=invoke(peer,'collaboration',{action:'join',documentId,invite:invitation.invite,name:'MCP racing guest',focus:false}).then(result=>({result}),error=>({error}));
    await until(()=>guest.evaluate(()=>globalThis.__ultimateJoinRace.ready),'Guest join did not reach the post-handshake gate');
    await guestShell.evaluate(id=>window.omc.invoke('activate-document',{id}),documentId);
    const guestPage=await runtimePage(documentId,guest);
    const uiHost=await guestPage.evaluate(()=>window.omc.invoke('host',{port:0}));
    assert.ok(uiHost.port>0);
    await guest.evaluate(()=>globalThis.__ultimateJoinRace.release());
    const completed=await pendingJoin;if(completed.error)throw completed.error;const raced=completed.result;
    assert.equal(raced.isError,true,'A delayed MCP join replaced a newer UI collaboration session');
    assert.equal(raced.structuredContent?.error?.code,'busy',JSON.stringify(raced));
    const preserved=await ok(peer,'collaboration',{action:'status',documentId});
    assert.equal(preserved.mode,'host');assert.equal(preserved.port,uiHost.port);
    assert.equal(await guest.evaluate(()=>globalThis.__ultimateJoinRace.candidate.closed),true,'Rejected candidate collaboration remained open');
    await until(async()=>(await ok(client,'collaboration',{action:'status',documentId})).peers.length===1,'Rejected guest join left an orphan peer on the original host');
    await guestPage.evaluate(()=>window.omc.invoke('leave'));
    assert.equal((await ok(peer,'collaboration',{action:'status',documentId})).mode,'offline');
    record('a delayed MCP join rejects a concurrent UI host, preserves that host and closes only the candidate connection');
  }finally{
    await guest.evaluate(()=>{const state=globalThis.__ultimateJoinRace;state?.release();state?.restore();delete globalThis.__ultimateJoinRace;}).catch(()=>{});
    await pendingJoin?.catch(()=>{});
  }
  await guestShell.evaluate(()=>window.omc.invoke('show-library'));
  await ok(peer,'collaboration',{action:'join',documentId,invite:invitation.invite,name:'MCP guest',focus:false});
  assert.equal((await ok(peer,'workspace',{action:'state'})).activeTabId,null,'Joining collaboration stole the guest visible library');
  const status=await ok(peer,'collaboration',{action:'status',documentId});
  assert.equal(status.mode,'guest');assert.equal(status.connected,true);
  await ok(peer,'create_board',{documentId,name:'Local guest authored board',width:160,height:80});
  await until(async()=>named(await snapshot(page),'Local guest authored board').length===1,'Guest edit did not reach the host canvas');
  await rejects(client,'delete_document',{id:documentId,expectedTitle:'Ultimate MCP A'});
  const peerContext=await ok(peer,'get_context',{documentId});
  await ok(peer,'collaboration',{action:'cursor',documentId,cursor:{x:20,y:30,page:peerContext.page.id,selection:[]}});
  await ok(peer,'collaboration',{action:'cursor',documentId});
  await ok(peer,'collaboration',{action:'leave',documentId});
  assert.equal((await ok(peer,'collaboration',{action:'status',documentId})).mode,'offline');
  await ok(client,'collaboration',{action:'leave',documentId});
  assert.equal((await ok(client,'collaboration',{action:'status',documentId})).mode,'offline');
  const child=guest.process();
  const exited=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Guest MCP quit did not finish')),30000);child.once('exit',(code,signal)=>{clearTimeout(timer);try{assert.equal(code,0);assert.equal(signal,null);resolve();}catch(error){reject(error);}});});
  await ok(peer,'workspace',{action:'quit'});
  await exited;await guest.close().catch(()=>{});guest=null;
  record('typed MCP hosts, invites, joins, edits and leaves a real TLS collaboration session over loopback only');
}

try{
  await launch();
  const a=await connect(),b=await connect(),stdio=await connect(true);
  const catalog=(await a.listTools()).tools;
  assert.deepEqual(catalog.map(tool=>tool.name),TOOLS.map(tool=>tool.name));
  assert.equal(new Set(catalog.map(tool=>tool.name)).size,catalog.length);
  for(const name of ['page','create_shape','edit_shapes','edit_text','styles','libraries','document_assets','clipboard','view','export_selection','redo','workspace','preferences','save_document','delete_document','import_document','export_document','collaboration'])assert.ok(catalog.some(tool=>tool.name===name),`Missing ${name}`);
  for(const name of ['page','create_shape','edit_shapes','edit_text','styles','libraries','document_assets','clipboard','view','export_selection','redo']){
    assert.ok(catalog.find(tool=>tool.name===name).inputSchema.required.includes('documentId'),`${name} lacks an explicit target`);
    await rejects(a,name,{},'bad_args');
  }
  await rejects(a,'get_context',{},'document_required');
  record('actual HTTPS catalog matches the shipped schemas; all new editor families require an explicit document');

  const createdA=await ok(a,'create_document',{title:'Ultimate MCP A'}),idA=createdA.document.id;
  const createdB=await ok(b,'create_document',{title:'Ultimate MCP B'}),idB=createdB.document.id;
  let pageA=await runtimePage(idA),pageB=await runtimePage(idB);
  assert.equal((await ok(a,'workspace',{action:'state'})).activeTabId,null);
  await ok(b,'workspace',{action:'focus',documentId:idB});
  const authored=await editing(a,idA,pageA);
  await resources(a,idA,pageA,authored.rectangleId);
  const beforeCrash=await stored(idA);
  const crashed=pageA.waitForEvent('crash');
  await app.evaluate(({webContents},id)=>webContents.getAllWebContents().find(contents=>contents.getURL().includes('documentId='+id)).forcefullyCrashRenderer(),idA);
  await crashed;
  await rejects(a,'import_resource',{documentId:idA,kind:'image',filePath:path.join(files,'agent-pixel.png')},'runtime_restarted');
  assert.deepEqual(await stored(idA),beforeCrash);
  await ok(a,'get_context',{documentId:idA});pageA=await runtimePage(idA);
  await ok(a,'select_page',{documentId:idA,id:authored.pageId});
  const recoveredAsset=(await ok(a,'import_resource',{documentId:idA,kind:'image',filePath:path.join(files,'agent-pixel.png'),name:'Recovered runtime asset'})).asset;
  await ok(a,'document_assets',{documentId:idA,action:'remove',id:recoveredAsset.id});
  record('file imports reject a crashed runtime until fresh context is read and retain the original durable document');
  await collaborate(a,idA,pageA);
  assert.equal((await ok(a,'workspace',{action:'state'})).activeTabId,idB,'Background editor operations stole the visible tab');
  assert.equal(named(await snapshot(pageB),'Native rectangle').length,0);

  await ok(stdio,'open_document',{id:idA});
  await ok(stdio,'create_shape',{documentId:idA,type:'star',x:700,y:60,width:80,height:80,properties:{name:'Bundled stdio star',fills:[{color:'#eab308'}]}});
  assert.equal(named(await snapshot(pageA),'Bundled stdio star').length,1);
  await Promise.all([
    ok(a,'create_shape',{documentId:idA,type:'rect',x:700,y:180,width:40,height:40,properties:{name:'Only A'}}),
    ok(b,'create_shape',{documentId:idB,type:'ellipse',x:20,y:20,width:40,height:40,properties:{name:'Only B'}}),
  ]);
  assert.equal(named(await snapshot(pageA),'Only B').length,0);assert.equal(named(await snapshot(pageB),'Only A').length,0);
  await rejects(stdio,'undo',{documentId:idA});
  await ok(a,'undo',{documentId:idA});assert.equal(named(await snapshot(pageA),'Only A').length,0);
  await rejects(b,'redo',{documentId:idA});
  await ok(a,'redo',{documentId:idA});assert.equal(named(await snapshot(pageA),'Only A').length,1);
  record('HTTPS and stdio edit independent canvases concurrently and refuse another agent’s Undo/Redo history');

  await ok(a,'workspace',{action:'focus',documentId:idA});
  await pageA.locator('#document-title').click();
  await pageA.locator('#title-input').fill('Uncommitted human title');
  const beforeBusy=await stored(idA);
  await rejects(a,'page',{documentId:idA,action:'create',name:'Must reject during title edit'},'busy');
  await rejects(a,'create_shape',{documentId:idA,type:'rect',properties:{name:'Must reject during title edit'}},'busy');
  assert.deepEqual(await stored(idA),beforeBusy);
  await pageA.locator('#title-input').press('Escape');
  await ok(b,'workspace',{action:'focus',documentId:idB});
  record('active human title edits block page and shape mutations without publishing durable changes');

  await ok(a,'preferences',{action:'set',name:'MCP Test Designer',view:'list',documentId:idA,starred:true});
  let prefs=(await ok(a,'preferences',{action:'get'})).preferences;
  assert.equal(prefs.name,'MCP Test Designer');assert.equal(prefs.view,'list');assert.ok(prefs.starred.includes(idA));
  assert.deepEqual((await ok(a,'list_documents',{starredOnly:true})).documents.map(document=>document.id),[idA]);
  assert.deepEqual((await ok(a,'list_documents',{sort:'title'})).documents.map(document=>document.title),['Ultimate MCP A','Ultimate MCP B']);
  await ok(a,'preferences',{action:'set',documentId:idA,starred:false});
  assert.ok(!(await ok(a,'preferences',{action:'get'})).preferences.starred.includes(idA));
  const connection=await ok(a,'workspace',{action:'connection'});
  assert.ok(!JSON.stringify(connection).includes(token),'Connection introspection leaked a private credential');
  assert.ok((await ok(a,'workspace',{action:'about'})).ok);
  const capabilities=await ok(a,'workspace',{action:'capabilities'});
  assert.equal(capabilities.protocol.explicitTargets,true);
  assert.equal(capabilities.protocol.implicitVisibleTabTarget,false);
  assert.equal(capabilities.tools.length,catalog.length);
  assert.equal((await ok(a,'workspace',{action:'window',visible:false,fullscreen:false})).visible,false);
  await rejects(a,'workspace',{action:'window',devTools:true});
  const knownPixel=await pageA.evaluate(()=>{const canvas=document.createElement('canvas');canvas.width=1;canvas.height=1;const context=canvas.getContext('2d');context.fillStyle='#123456';context.fillRect(0,0,1,1);return canvas.toDataURL('image/png');});
  const bitmap=await app.evaluate(({nativeImage},src)=>[...nativeImage.createFromDataURL(src).toBitmap({scaleFactor:1})],knownPixel);
  assert.deepEqual(bitmap,[0x56,0x34,0x12,255],'Native image bitmap color order differs from screen sampling assumptions');
  record('capability discovery, window state and native bitmap color order match the macOS runtime');
  for(const [name,color,x] of [['Full export orange','#c2410c',800],['Full export violet','#7e22ce',960]])await ok(a,'create_shape',{documentId:idA,type:'frame',x,y:260,width:100,height:80,properties:{name,fills:[{color}]}});
  const exportBoard=named(await snapshot(pageA),'Full export orange')[0];
  const violetBoard=named(await snapshot(pageA),'Full export violet')[0];
  await ok(a,'view',{documentId:idA,action:'select',ids:[exportBoard.id]});
  const firstShot=await invoke(a,'screenshot',{documentId:idA,mode:'overview'});
  await ok(a,'view',{documentId:idA,action:'select',ids:[violetBoard.id]});
  const secondShot=await invoke(a,'screenshot',{documentId:idA,mode:'overview'});
  const [firstPixels,secondPixels]=await Promise.all([screenshotPixels(pageA,firstShot),screenshotPixels(pageA,secondShot)]);
  for(const summary of [firstPixels,secondPixels]){assert.ok(summary.orange>100,JSON.stringify(summary));assert.ok(summary.violet>100,JSON.stringify(summary));}
  assert.deepEqual(firstPixels,secondPixels,'Default page screenshot depended on the human selection');
  const wholePage=firstShot.content.find(item=>item.type==='image');await fs.writeFile(path.join(evidence,'whole-page.png'),Buffer.from(wholePage.data,'base64'));
  record('default MCP screenshots contain both separated boards with stable pixels regardless of human selection');
  await ok(a,'view',{documentId:idA,action:'select',ids:[exportBoard.id]});
  const svgFile=path.join(files,'all-boards.svg');
  await ok(a,'export_document',{id:idA,format:'svg',filePath:svgFile});
  const fullSvg=await fs.readFile(svgFile,'utf8');
  assert.match(fullSvg,/#c2410c/i);assert.match(fullSvg,/#7e22ce/i);
  for(const format of ['png','pdf'])await rejects(a,'export_document',{id:idA,format});
  await ok(a,'export_document',{id:idA,format:'png',ids:[exportBoard.id],filePath:path.join(files,'explicit-board.png')});
  assert.equal((await fs.readFile(path.join(files,'explicit-board.png'))).subarray(1,4).toString(),'PNG');
  const constrainedFile=path.join(files,'constrained-board.png');
  await ok(a,'export_document',{id:idA,format:'png',ids:[exportBoard.id],filePath:constrainedFile,bounds:{x:800,y:260,width:100,height:80},constraint:{type:'width',value:96},background:'#ffffff',omitFill:true});
  const constrained=await pageA.evaluate(async data=>{const image=await createImageBitmap(new Blob([Uint8Array.from(data)],{type:'image/png'}));const canvas=new OffscreenCanvas(image.width,image.height),context=canvas.getContext('2d');context.drawImage(image,0,0);return {width:image.width,center:[...context.getImageData(Math.floor(image.width/2),Math.floor(image.height/2),1,1).data]};},[...await fs.readFile(constrainedFile)]);
  assert.equal(constrained.width,96);assert.deepEqual(constrained.center,[255,255,255,255]);
  await ok(a,'view',{documentId:idA,action:'select',ids:[]});
  record('whole-canvas export ignores the human selection; ambiguous raster and PDF exports require explicit layers');
  await ok(a,'save_document',{id:idA});
  const file=path.join(files,'authored.omc');
  await ok(a,'export_document',{id:idA,format:'omc',filePath:file});
  const exportedRecord=decodeFile(await fs.readFile(file,'utf8'));
  try{assert.deepEqual(exportedRecord.replica.document,await stored(idA));}finally{exportedRecord.replica.destroy();}
  const originalBytes=await fs.readFile(file);
  await rejects(a,'export_document',{id:idA,format:'omc',filePath:file});
  assert.deepEqual(await fs.readFile(file),originalBytes);
  await ok(a,'export_document',{id:idA,format:'omc',filePath:file,overwrite:true});
  for(const filePath of ['relative.omc',path.join(profile,'private.omc')])await rejects(a,'export_document',{id:idA,format:'omc',filePath});
  const linked=path.join(files,'linked.omc');await fs.symlink(file,linked);
  await rejects(a,'export_document',{id:idA,format:'omc',filePath:linked,overwrite:true});
  await rejects(a,'import_document',{format:'omc',filePath:linked});
  const json=await ok(a,'export_document',{id:idA,format:'json'});
  assert.equal(json.encoding,'base64');
  const payload=Buffer.from(json.data,'base64').toString();
  const beforeImport=(await ok(a,'list_documents')).total;
  const malformedDocument=await stored(idA);
  malformedDocument.pagesById[authored.pageId].objects[authored.rectangleId].fills=[{color:'#ffffff',gradient:{stops:'invalid nested paint'}}];
  const malformedJson=JSON.stringify(malformedDocument),malformedJsonFile=path.join(files,'malformed-nested.json');
  await fs.writeFile(malformedJsonFile,malformedJson);
  await rejects(a,'import_document',{format:'json',payload:malformedJson,title:'Must reject malformed nested paint'});
  await rejects(a,'import_document',{format:'json',filePath:malformedJsonFile,title:'Must reject malformed nested paint'});
  const malformedReplica=new Replica({document:malformedDocument});
  let malformedOmc;
  try{malformedOmc=encodeFile({id:randomUUID(),title:'Malformed nested portable',createdAt:new Date().toISOString(),replica:malformedReplica});}finally{malformedReplica.destroy();}
  const malformedOmcFile=path.join(files,'malformed-nested.omc');await fs.writeFile(malformedOmcFile,malformedOmc);
  await rejects(a,'import_document',{format:'omc',payload:malformedOmc});
  await rejects(a,'import_document',{format:'omc',filePath:malformedOmcFile});
  await rejects(a,'import_document',{format:'json',payload:'{malformed'});
  await rejects(a,'import_document',{format:'json',payload,filePath:file});
  assert.equal((await ok(a,'list_documents')).total,beforeImport);
  const imported=await ok(a,'import_document',{format:'json',payload,title:'Imported MCP copy'});
  const importedPage=await runtimePage(imported.documentId);
  assert.equal(named(await snapshot(importedPage),'Native rectangle').length,1);
  assert.equal((await ok(a,'workspace',{action:'state'})).activeTabId,idB);
  const importedFile=path.join(files,'copy.json');await fs.writeFile(importedFile,payload);
  const fileImported=await ok(a,'import_document',{format:'json',filePath:importedFile,title:'Imported MCP file copy'});
  const fileImportedPage=await runtimePage(fileImported.documentId);
  assert.equal(named(await snapshot(fileImportedPage),'Native rectangle').length,1);
  await rejects(a,'import_document',{format:'omc',filePath:file});
  record('preferences and explicit save/import/export are durable, dialog-free and preserve existing files and the live profile');

  const disposable=await ok(a,'create_document',{title:'Disposable MCP canvas'}),disposableId=disposable.document.id;
  await rejects(a,'page',{documentId:disposableId,action:'delete',pageId:disposable.context.page.id});
  await rejects(a,'delete_document',{id:disposableId,expectedTitle:'Disposable MCP canvas'});
  await ok(a,'workspace',{action:'close',documentId:disposableId,release:true});
  await rejects(a,'delete_document',{id:disposableId,expectedTitle:'Wrong title'});
  await ok(a,'delete_document',{id:disposableId,expectedTitle:'Disposable MCP canvas'});
  assert.ok(!(await ok(a,'list_documents')).documents.some(doc=>doc.id===disposableId));
  await ok(a,'workspace',{action:'close',documentId:imported.documentId,release:true});
  await ok(a,'delete_document',{id:imported.documentId,expectedTitle:'Imported MCP copy'});
  await ok(a,'workspace',{action:'close',documentId:fileImported.documentId,release:true});
  await ok(a,'delete_document',{id:fileImported.documentId,expectedTitle:'Imported MCP file copy'});
  await ok(a,'workspace',{action:'close',documentId:idA,release:true});
  await rejects(a,'delete_document',{id:idA,expectedTitle:'Ultimate MCP A'});
  await ok(stdio,'create_board',{documentId:idA,name:'Closed tab remains agent-owned',width:160,height:90});
  await ok(a,'open_document',{id:idA});
  record('last-page protection, title-checked deletion and other agents’ document ownership survive tab closure');

  await ok(a,'workspace',{action:'show_library'});
  assert.equal((await ok(a,'workspace',{action:'state'})).libraryVisible,true);
  await ok(b,'workspace',{action:'focus',documentId:idB});
  const shot=await invoke(a,'screenshot',{documentId:idA,mode:'overview'}),image=shot.content.find(item=>item.type==='image');
  assert.ok(!shot.isError&&image);await fs.writeFile(path.join(evidence,'authored-page.'+(image.mimeType==='image/png'?'png':'svg')),Buffer.from(image.data,'base64'));
  await ok(a,'view',{documentId:idA,action:'fit',ids:(await ok(a,'get_context',{documentId:idA})).boards});
  await pageA.screenshot({path:path.join(evidence,'runtime-ui.png')});
  const expectedA=await stored(idA),expectedB=await stored(idB);
  await stop();
  await launch();
  const fresh=await connect();
  await ok(fresh,'open_document',{id:idA});pageA=await runtimePage(idA);
  await ok(fresh,'open_document',{id:idB});pageB=await runtimePage(idB);
  assert.deepEqual((await snapshot(pageA)).document,expectedA);
  assert.deepEqual((await snapshot(pageB)).document,expectedB);
  prefs=(await ok(fresh,'preferences',{action:'get'})).preferences;
  assert.equal(prefs.name,'MCP Test Designer');assert.equal(prefs.view,'list');
  assert.deepEqual(errors,[]);
  await stop();
  record('all authored geometry, rich text, resources, independent documents and preferences survive a graceful restart');
  await fs.writeFile(path.join(evidence,'result.json'),JSON.stringify({passed:true,checks,toolCount:catalog.length,rendererErrors:errors,at:new Date().toISOString()},null,2)+'\n');
}catch(error){
  const windowState=app?await Promise.all(app.windows().map(async page=>({url:page.url(),body:await page.locator('body').innerText({timeout:1000}).catch(()=>null)}))):[];
  await shell?.screenshot({path:path.join(evidence,'failure-window.png')}).catch(()=>{});
  await fs.writeFile(path.join(evidence,'failure.json'),JSON.stringify({passed:false,checks,rendererErrors:errors,windows:windowState,error:error.stack},null,2)+'\n');
  throw error;
}finally{
  await Promise.allSettled(clients.map(client=>client.close()));
  await guest?.close().catch(()=>{});
  if(app){
    const child=app.process();
    await app.evaluate(({app})=>app.exit(0)).catch(()=>{});
    if(child.exitCode===null&&child.signalCode===null)await new Promise(resolve=>child.once('exit',resolve));
  }
  await fs.rm(temporary,{recursive:true,force:true,maxRetries:5,retryDelay:100});
  await fs.writeFile(path.join(evidence,'resources.json'),JSON.stringify({owner:'ultimate-mcp-e2e',temporary,profile,files,pid:process.pid,cleaned:true,at:new Date().toISOString()},null,2)+'\n');
}
