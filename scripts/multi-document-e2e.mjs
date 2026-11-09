import {_electron as electron} from 'playwright';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {createMcpFetch} from '../core/mcp-fetch.mjs';
import {decodeFile} from '../core/storage.mjs';
import {changesBetween} from '../core/document.mjs';

const root=process.cwd(),primary=execFileSync('git',['worktree','list','--porcelain'],{encoding:'utf8'}).split('\n').find(line=>line.startsWith('worktree ')).slice(9);
const evidence=path.join(primary,'internal/docs/mcp-workspace-20261109/multi-document-evidence');
execFileSync('git',['check-ignore',evidence],{cwd:primary});await fs.mkdir(evidence,{recursive:true});
const profile=await fs.mkdtemp(path.join(os.tmpdir(),'omc-multi-document-'));
const clients=[],errors=[],checks=[],expectedCrashes=new Set();
let app,child,shell,runtime,token,mcpFetch;
const record=name=>{checks.push(name);console.log('PASS '+name);};
const invoke=(client,name,args={},key)=>client.callTool({name,arguments:args,...key?{_meta:{'oh-my-canvas/idempotency-key':key}}:{}});
async function ok(client,name,args={},key){const result=await invoke(client,name,args,key);assert.ok(!result.isError,`${name}: ${JSON.stringify(result)}`);return result.structuredContent;}
async function until(fn,message){for(let i=0;i<300;i++){const result=await fn();if(result)return result;await new Promise(resolve=>setTimeout(resolve,25));}throw Error(message);}
const workspace=()=>shell.evaluate(()=>window.omc.invoke('workspace'));
async function runtimePage(id){
  const page=await until(()=>app.windows().filter(page=>{try{return new URL(page.url()).searchParams.get('documentId')===id;}catch{return false;}}).sort((a,b)=>Number(new URL(b.url()).searchParams.get('generation'))-Number(new URL(a.url()).searchParams.get('generation')))[0],'Document runtime page did not appear');
  await page.waitForFunction(()=>!!window.lvMcp&&!document.querySelector('#editor').inert,null,{timeout:30000});return page;
}
const snapshot=page=>page.evaluate(()=>window.omc.invoke('snapshot'));
const named=(snap,name)=>Object.values(snap.document.pagesById).flatMap(page=>Object.values(page.objects)).filter(shape=>shape.name===name);
async function launch(){
  app=await electron.launch({args:[root,`--profile=${profile}`,'--mcp-port=0'],env:{...process.env,OMC_TEST_BACKGROUND:'1'},timeout:30000});child=app.process();
  app.on('window',page=>{page.on('pageerror',error=>errors.push(error.message));page.on('crash',()=>{if(!expectedCrashes.has(page))errors.push('Unexpected document renderer crash');});});
  shell=await app.firstWindow();await shell.locator('#new').waitFor();
  runtime=JSON.parse(await fs.readFile(path.join(profile,'mcp-runtime.json'),'utf8'));token=await fs.readFile(path.join(profile,'mcp-token-v2'),'utf8');mcpFetch=createMcpFetch(await fs.readFile(runtime.certFile,'utf8'));
}
async function connect(stdio=false){
  const client=new Client({name:'identical-multi-document-client',version:'1'},{capabilities:{}});
  const transport=stdio?new StdioClientTransport({command:process.execPath,args:[path.join(root,'dist/mcp-cli.cjs'),'--runtime',path.join(profile,'mcp-runtime.json')]}):new StreamableHTTPClientTransport(new URL(`https://127.0.0.1:${runtime.port}/mcp`),{fetch:mcpFetch,requestInit:{headers:{Authorization:`Bearer ${token}`}}});
  clients.push(client);await client.connect(transport);return {client,transport};
}
async function stop(){if(!app)return;await app.close();assert.equal(child.exitCode,0);app=null;}
async function pixels(page,shot){
  const item=shot.content.find(content=>content.type==='image');assert.ok(item,'MCP screenshot returned no pixels');
  return page.evaluate(async image=>{const bitmap=await createImageBitmap(new Blob([Uint8Array.from(atob(image.data),value=>value.charCodeAt(0))],{type:image.mimeType}));const canvas=new OffscreenCanvas(bitmap.width,bitmap.height),ctx=canvas.getContext('2d');ctx.drawImage(bitmap,0,0);return [...ctx.getImageData(Math.floor(bitmap.width/2),Math.floor(bitmap.height/2),1,1).data];},item);
}
try{
  await launch();const a=await connect(),b=await connect(),shared=await connect(),stdio=await connect(true);
  const created=await ok(a.client,'create_document',{title:'Repository A'}),idA=created.document.id;
  assert.equal((await workspace()).activeTabId,null,'Background MCP creation stole the visible library');
  const anchor=await ok(a.client,'create_board',{documentId:idA,name:'Shared raw ID',width:240,height:120});
  const copied=await ok(b.client,'duplicate_document',{id:idA,title:'Repository B'}),idB=copied.document.id;
  let pageA=await runtimePage(idA),pageB=await runtimePage(idB);
  const raw=anchor.rawId;assert.ok((await snapshot(pageB)).document.pagesById[copied.context.page.id].objects[raw]);
  assert.equal((await workspace()).activeTabId,null);assert.equal((await ok(shared.client,'list_documents')).boundDocumentId,null);
  await shell.evaluate(id=>window.omc.invoke('activate-document',{id}),idB);
  assert.equal((await invoke(shared.client,'get_context')).isError,true,'Unbound reads used the visible tab');
  for(const client of [a.client,b.client,shared.client])assert.equal((await invoke(client,'create_board',{name:'Missing target must fail',width:20})).isError,true);
  assert.equal(named(await snapshot(pageA),'Missing target must fail').length,0);assert.equal(named(await snapshot(pageB),'Missing target must fail').length,0);
  record('one profile hosts separate document runtimes; background opens and unbound or missing-target calls never use the visible tab');

  const contextA=await ok(a.client,'get_context'),contextB=await ok(b.client,'get_context');
  assert.equal(contextA.document.id,idA);assert.equal(contextB.document.id,idB);assert.equal(contextA.boards[1],anchor.id);assert.equal(contextA.boards[1],contextB.boards[1]);
  await ok(a.client,'update',{documentId:idA,id:anchor.id,attrs:{name:'A anchor'},style:{'background-color':'#dc2626'}});
  await ok(b.client,'update',{documentId:idB,id:contextB.boards[1],attrs:{name:'B anchor'},style:{'background-color':'#2563eb'}});
  assert.equal((await snapshot(pageA)).document.pagesById[contextA.page.id].objects[raw].fills[0].color,'#dc2626');
  assert.equal((await snapshot(pageB)).document.pagesById[contextB.page.id].objects[raw].fills[0].color,'#2563eb');
  await Promise.all([
    (async()=>{for(let i=0;i<4;i++)await ok(a.client,'create_board',{documentId:idA,name:`Only A ${i}`,width:120,height:80});})(),
    (async()=>{for(let i=0;i<4;i++)await ok(b.client,'create_board',{documentId:idB,name:`Only B ${i}`,width:120,height:80});})(),
    (async()=>{for(let i=0;i<8;i++)await shell.evaluate(id=>window.omc.invoke('activate-document',{id}),i%2?idA:idB);})(),
  ]);
  assert.equal((await ok(a.client,'get_context')).document.id,idA);assert.equal((await ok(b.client,'get_context')).document.id,idB);
  for(let i=0;i<4;i++){assert.equal(named(await snapshot(pageA),`Only B ${i}`).length,0);assert.equal(named(await snapshot(pageB),`Only A ${i}`).length,0);}
  record('two identical HTTP clients edit their own documents concurrently while UI tabs switch, including colliding raw IDs and aliases');

  await ok(shared.client,'open_document',{id:idA});
  const pendingA=ok(shared.client,'create_board',{documentId:idA,name:'Shared transport A',width:140});
  await ok(shared.client,'open_document',{id:idB});
  await Promise.all([pendingA,ok(shared.client,'create_board',{documentId:idB,name:'Shared transport B',width:140})]);
  await ok(shared.client,'get_context',{documentId:idA});await ok(shared.client,'get_context',{documentId:idB});
  await ok(shared.client,'update',{documentId:idA,id:raw,attrs:{name:'A anchor explicit'}});
  await ok(shared.client,'update',{documentId:idB,id:raw,attrs:{name:'B anchor explicit'}});
  await ok(stdio.client,'open_document',{id:idA});await ok(stdio.client,'create_board',{documentId:idA,name:'Stdio A',width:100});
  await ok(stdio.client,'open_document',{id:idB});await ok(stdio.client,'create_board',{documentId:idB,name:'Stdio B',width:100});
  assert.equal(named(await snapshot(pageA),'Shared transport B').length,0);assert.equal(named(await snapshot(pageB),'Shared transport A').length,0);
  assert.equal(named(await snapshot(pageA),'Stdio B').length,0);assert.equal(named(await snapshot(pageB),'Stdio A').length,0);
  assert.equal(named(await snapshot(pageA),'A anchor explicit')[0].id,raw);assert.equal(named(await snapshot(pageB),'B anchor explicit')[0].id,raw);
  record('one multiplexed HTTP session and stdio retain explicit targets across rebinds without leaking writes');

  await shell.evaluate(id=>window.omc.invoke('activate-document',{id}),idB);
  await pageB.locator('#document-title').click();await pageB.locator('#title-input').fill('User is typing in B');
  await ok(a.client,'create_board',{documentId:idA,name:'A progresses while B types',width:100});
  assert.equal(await pageB.locator('#title-input').inputValue(),'User is typing in B');assert.equal(await pageB.locator('#title-input').evaluate(input=>document.activeElement===input),true);
  assert.equal((await workspace()).activeTabId,idB);assert.equal((await snapshot(pageB)).title,'Repository B');
  await pageB.locator('#title-input').press('Escape');
  await ok(a.client,'write_html',{documentId:idA,target:raw,position:'last',html:'<p style="font-family:IBM Plex Sans;font-size:14px;color:#fff">Background A 한글</p>'});
  const shotA=await invoke(a.client,'screenshot',{documentId:idA,id:raw,mode:'overview'}),shotB=await invoke(b.client,'screenshot',{documentId:idB,id:raw,mode:'overview'});
  assert.ok(!shotA.isError);assert.ok(!shotB.isError);
  for(const [name,shot] of [['background-A',shotA],['visible-B',shotB]]){const image=shot.content.find(item=>item.type==='image');await fs.writeFile(path.join(evidence,name+'.png'),Buffer.from(image.data,'base64'));}
  const [red,blue]=await Promise.all([pixels(pageA,shotA),pixels(pageB,shotB)]);assert.ok(red[0]>150&&red[1]<120&&red[2]<120,JSON.stringify(red));assert.ok(blue[2]>150&&blue[0]<120,JSON.stringify(blue));
  const fonts=await ok(a.client,'fonts',{documentId:idA,query:'IBM Plex Sans'});assert.ok(fonts.fonts.some(font=>font.family==='IBM Plex Sans'&&font.faces.some(face=>face.status==='loaded')));
  assert.equal((await workspace()).activeTabId,idB);
  record('typing in B stays focused while A advances; background screenshots contain the correct document pixels and loaded fonts without focus changes');

  for(const action of ['snapshot','commit'])await assert.rejects(pageA.evaluate(({action,id,generation})=>window.omc.invoke(action,{id,documentId:id,generation,seq:1,changes:[]}),{action,id:idB,generation:(await snapshot(pageB)).generation}),/identity|sender|document/i);
  const beforeB=await snapshot(pageB),afterB=structuredClone(beforeB.document);afterB.pagesById[beforeB.document.pages[0]].objects[raw].name='Forged B write';
  await assert.rejects(pageA.evaluate(data=>window.omc.invoke('commit',data),{id:idB,documentId:idB,generation:beforeB.generation,seq:beforeB.ack+1,changes:changesBetween(beforeB.document,afterB)}),/identity|sender|document/i);
  assert.equal(named(await snapshot(pageB),'Forged B write').length,0);
  await app.evaluate(({webContents},id)=>{
    const web=webContents.getAllWebContents().find(wc=>wc.getURL().includes('documentId='+id)),send=web.send.bind(web);
    globalThis.__multiPending=null;globalThis.__multiRestore=()=>{web.send=send;};
    web.send=(...args)=>{if(args[0]==='omc:event'&&args[1]?.type==='tool'&&args[1].call.args.name==='Genuine B result')globalThis.__multiPending={args,id:args[1].id};else send(...args);};
  },idB);
  try{
    let settled=false;const pending=ok(b.client,'create_board',{documentId:idB,name:'Genuine B result',width:100}).then(result=>{settled=true;return result;});
    const pendingId=await until(()=>app.evaluate(()=>globalThis.__multiPending?.id),'B request did not reach its own runtime');
    await pageA.evaluate(id=>window.omc.toolResult(id,{content:[{type:'text',text:'forged'}],structuredContent:{ok:true,forged:true}}),pendingId);
    await pageA.evaluate(()=>window.omc.invoke('snapshot'));assert.equal(settled,false,'A renderer settled B’s pending request');
    await app.evaluate(({webContents},id)=>{globalThis.__multiRestore();webContents.getAllWebContents().find(wc=>wc.getURL().includes('documentId='+id)).send(...globalThis.__multiPending.args);},idB);
    assert.equal((await pending).forged,undefined);assert.equal(named(await snapshot(pageB),'Genuine B result').length,1);
  }finally{await app.evaluate(()=>{globalThis.__multiRestore();delete globalThis.__multiRestore;delete globalThis.__multiPending;});}
  record('document sender identity rejects cross-document snapshots, forged commits and forged tool replies');

  await shell.evaluate(id=>window.omc.invoke('close-document',{id}),idA);
  assert.ok(!(await workspace()).tabs.some(tab=>tab.id===idA));
  const closed=(await ok(a.client,'list_documents')).documents.find(doc=>doc.id===idA);assert.equal(closed.open,false);assert.equal(closed.inUse,true);
  await ok(a.client,'create_board',{documentId:idA,name:'A remains in use',width:100});assert.equal((await workspace()).activeTabId,idB);
  await ok(a.client,'open_document',{id:idA});assert.equal((await workspace()).activeTabId,idB);
  const generation=(await snapshot(pageA)).generation;expectedCrashes.add(pageA);
  await app.evaluate(({webContents},id)=>webContents.getAllWebContents().find(wc=>wc.getURL().includes('documentId='+id)).forcefullyCrashRenderer(),idA);
  await ok(b.client,'create_board',{documentId:idB,name:'B survives A crash',width:100});
  const recovered=await ok(a.client,'get_context',{documentId:idA});pageA=await runtimePage(idA);assert.ok(recovered.generation>generation);assert.equal(named(await snapshot(pageA),'A remains in use').length,1);
  const stale=await invoke(shared.client,'update',{documentId:idA,id:raw,attrs:{name:'Stale generation must fail'}});assert.equal(stale.isError,true);assert.equal(stale.structuredContent.error.code,'runtime_restarted');
  assert.equal(named(await snapshot(pageA),'Stale generation must fail').length,0);
  await ok(shared.client,'get_context',{documentId:idA});await ok(shared.client,'create_board',{documentId:idA,name:'A refreshed generation',width:100});
  record('closing an agent-owned tab keeps its runtime usable; renderer recovery rejects another agent’s stale generation while B stays usable');

  await shell.evaluate(id=>window.omc.invoke('activate-document',{id}),idB);
  await shell.screenshot({path:path.join(evidence,'tabs-desktop.png')});await pageB.screenshot({path:path.join(evidence,'runtime-B-desktop.png')});
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(960,640));
  await shell.screenshot({path:path.join(evidence,'tabs-minimum.png')});await pageB.screenshot({path:path.join(evidence,'runtime-B-minimum.png')});
  const tabBounds=await shell.locator('#document-tabs').boundingBox();assert.ok(tabBounds.width<=960);
  const memory=await app.evaluate(({app})=>app.getAppMetrics().map(({type,memory})=>({type,memory})));
  for(const [id,own,foreign] of [[idA,'Only A 0','Only B 0'],[idB,'Only B 0','Only A 0']]){
    const record=decodeFile(await fs.readFile(path.join(profile,'documents',id+'.omc'),'utf8'));
    try{const snap={document:record.replica.document};assert.equal(named(snap,own).length,1);assert.equal(named(snap,foreign).length,0);}finally{record.replica.destroy();}
  }
  const oldSession=a.transport.sessionId;await stop();await launch();
  const response=await mcpFetch(`https://127.0.0.1:${runtime.port}/mcp`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Mcp-Session-Id':oldSession,'MCP-Protocol-Version':'2025-11-25','Content-Type':'application/json',Accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list'})});assert.equal(response.status,404);await response.arrayBuffer();
  const fresh=await connect();assert.equal((await invoke(fresh.client,'get_context')).isError,true);
  await ok(fresh.client,'open_document',{id:idA});pageA=await runtimePage(idA);await ok(fresh.client,'open_document',{id:idB});pageB=await runtimePage(idB);
  assert.equal(named(await snapshot(pageA),'Only A 0').length,1);assert.equal(named(await snapshot(pageA),'Only B 0').length,0);assert.equal(named(await snapshot(pageB),'Only B 0').length,1);assert.equal(named(await snapshot(pageB),'Only A 0').length,0);
  record('both portable records and graceful restart preserve isolated edits, while old sessions and new unbound defaults remain rejected');
  assert.deepEqual(errors,[]);await stop();await fs.writeFile(path.join(evidence,'multi-document-result.json'),JSON.stringify({passed:true,checks,rendererErrors:errors,memory,at:new Date().toISOString()},null,2)+'\n');
}catch(error){await fs.writeFile(path.join(evidence,'multi-document-failure.json'),JSON.stringify({checks,rendererErrors:errors,error:error.stack},null,2)+'\n');throw error;}
finally{await Promise.allSettled(clients.map(client=>client.close()));await app?.close().catch(()=>{});await fs.rm(profile,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
