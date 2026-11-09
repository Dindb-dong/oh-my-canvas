import {_electron as electron} from 'playwright';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {createMcpFetch} from '../core/mcp-fetch.mjs';

const dir=await fs.mkdtemp(path.join(os.tmpdir(),'omc-http-e2e-'));
const clients=[],errors=[],checks=[];
let app,shell,page,port,token,certificate,mcpFetch,documentId,conflictApp,appChild,conflictChild;
const record=name=>{checks.push(name);console.log('PASS '+name);};
const workspaceTools=new Set(['list_documents','open_document','create_document','rename_document','duplicate_document']);
const call=(client,name,args={},meta)=>client.callTool({name,arguments:{...workspaceTools.has(name)?{}:{documentId},...args},...meta?{_meta:meta}:{}});
async function activeDocument(shell,previous=null){for(let i=0;i<600;i++){const id=await shell.evaluate(async()=>(await window.omc.invoke('workspace')).activeTabId);if(typeof id==='string'&&id!==previous)return id;await new Promise(resolve=>setTimeout(resolve,50));}throw Error('Visible document did not become active');}
async function documentPage(instance,id){assert.equal(typeof id,'string');const page=instance.windows().find(item=>{try{return new URL(item.url()).searchParams.get('documentId')===id;}catch{return false;}});assert.ok(page,'Document runtime page missing');try{await page.waitForFunction(()=>!!window.lvMcp&&!document.querySelector('#editor').inert,null,{timeout:30000});}catch(error){console.error('Runtime readiness diagnostic',await page.evaluate(()=>({url:location.href,mcp:!!window.lvMcp,inert:document.querySelector('#editor')?.inert,toast:document.querySelector('#toast')?.textContent})),errors);throw error;}return page;}
const snapshot=()=>page.evaluate(()=>window.omc.invoke('snapshot'));
const count=(snap,name)=>Object.values(snap.document.pagesById).flatMap(p=>Object.values(p.objects)).filter(s=>s.name===name).length;
async function launch(){
  app=await electron.launch({env:{...process.env,OMC_TEST_BACKGROUND:'1'},executablePath:process.env.OMC_TEST_EXECUTABLE,args:[...process.env.OMC_TEST_EXECUTABLE?[]:[process.cwd()],`--profile=${dir}`,`--mcp-port=${port??0}`],timeout:30000});
  appChild=app.process();shell=await app.firstWindow();
  assert.equal(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].isVisible()),false,'Synthetic MCP test window must start hidden');
  shell.on('pageerror',error=>errors.push(error.message));app.on('window',runtimePage=>runtimePage.on('pageerror',error=>errors.push(error.message)));
  await shell.locator('#new').waitFor();
  if(documentId)await shell.locator(`[data-open="${documentId}"]`).click();else await shell.locator('#start-sample').click();
  documentId=await activeDocument(shell);page=await documentPage(app,documentId);
  const runtime=JSON.parse(await fs.readFile(path.join(dir,'mcp-runtime.json'),'utf8'));
  assert.equal(runtime.version,2);assert.equal('token' in runtime,false);
  const currentToken=await fs.readFile(path.join(dir,'mcp-token-v2'),'utf8');
  if(port!==undefined){assert.equal(runtime.port,port);assert.equal(currentToken,token);}else{port=runtime.port;token=currentToken;}
  const currentCertificate=await fs.readFile(runtime.certFile,'utf8');
  if(certificate!==undefined)assert.equal(currentCertificate,certificate);else certificate=currentCertificate;
  mcpFetch=createMcpFetch(certificate);
  documentId=(await snapshot()).id;
}
async function connect(){
  const client=new Client({name:'same-http-client',version:'1'},{capabilities:{}});
  const transport=new StreamableHTTPClientTransport(new URL(`https://127.0.0.1:${port}/mcp`),{fetch:mcpFetch,requestInit:{headers:{Authorization:`Bearer ${token}`}}});
  clients.push(client);await client.connect(transport);return {client,transport};
}
async function gracefulClose(instance){
  const child=instance.process();
  // Official close detaches Playwright's inspector after the app's save-and-quit path.
  await instance.close();assert.equal(child.exitCode,0);assert.equal(child.signalCode,null);
}

async function stop(){if(app){await gracefulClose(app);app=null;}}

try{
  await launch();
  const info=await page.evaluate(()=>window.omc.invoke('mcp-info'));
  assert.equal(info.available,true);assert.ok(!JSON.stringify(info).includes(token));
  assert.deepEqual(JSON.parse(info.config).mcpServers['oh-my-canvas'],{url:`https://127.0.0.1:${port}/mcp`,bearer_token_env_var:'OMC_MCP_TOKEN'});
  conflictApp=await electron.launch({env:{...process.env,OMC_TEST_BACKGROUND:'1'},executablePath:process.env.OMC_TEST_EXECUTABLE,args:[...process.env.OMC_TEST_EXECUTABLE?[]:[process.cwd()],`--profile=${path.join(dir,'conflict')}`,`--mcp-port=${port}`],timeout:30000});
  conflictChild=conflictApp.process();const conflictPage=await conflictApp.firstWindow();
  assert.equal(await conflictApp.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].isVisible()),false,'Synthetic conflict test window must start hidden');
  await conflictPage.locator('#new').waitFor();
  assert.equal((await conflictPage.evaluate(()=>window.omc.invoke('mcp-info'))).available,false);
  await conflictPage.locator('#start-sample').click();await documentPage(conflictApp,await activeDocument(conflictPage));
  await gracefulClose(conflictApp);
  conflictApp=null;record('secret-free URL configuration and port-conflict editing without fallback');
  const a=await connect(),b=await connect();
  assert.notEqual(a.transport.sessionId,b.transport.sessionId);
  assert.equal(a.transport.protocolVersion,'2025-11-25');
  assert.equal((await a.client.listTools()).tools.length,31);
  assert.ok(!(await call(b.client,'get_context')).isError);
  record('official SDK HTTP initialize/list/call, 31 tools, negotiated 2025-11-25 and distinct sessions with identical client names');
  const first=await call(a.client,'create_board',{name:'HTTP author A',width:200,height:100},{'oh-my-canvas/idempotency-key':'http-once'});assert.ok(!first.isError,JSON.stringify(first));
  assert.deepEqual(await call(a.client,'create_board',{name:'HTTP author A',width:200,height:100},{'oh-my-canvas/idempotency-key':'http-once'}),first);
  assert.equal(count(await snapshot(),'HTTP author A'),1);
  assert.ok(!(await call(b.client,'create_board',{name:'HTTP author B',width:200,height:100})).isError);
  assert.equal((await call(a.client,'undo')).isError,true);
  assert.ok(!(await call(b.client,'undo')).isError);
  assert.equal(count(await snapshot(),'HTTP author B'),0);
  assert.equal(count(await snapshot(),'HTTP author A'),1);
  record('session-owned idempotency and Undo isolation reach durable main-process readback');
  const closeArgs={name:'Failed-close replay proof',width:180,height:90},closeMeta={'oh-my-canvas/idempotency-key':'failed-close-once'};
  const beforeFailedClose=await call(a.client,'create_board',closeArgs,closeMeta);assert.ok(!beforeFailedClose.isError,JSON.stringify(beforeFailedClose));
  const retainedAlias=beforeFailedClose.structuredContent.id,retainedRawId=beforeFailedClose.structuredContent.rawId,retainedSession=a.transport.sessionId;
  await page.evaluate(()=>window.omc.invoke('flush'));
  await page.evaluate(()=>{window.__httpCloseCancelled=false;window.__httpCloseUnsubscribe=window.omc.on(message=>{if(message.type==='error'&&/Could not save before closing/.test(message.message))window.__httpCloseCancelled=true;});});
  const documents=path.join(dir,'documents'),preservedDocuments=path.join(dir,'documents-before-failed-close');
  await fs.rename(documents,preservedDocuments);
  try{
    await fs.writeFile(documents,'Test-owned obstruction: documents must be a directory.');
    await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].close());
    await page.waitForFunction(()=>window.__httpCloseCancelled,null,{timeout:10000});
    assert.equal(app.process().exitCode,null);assert.equal(app.process().signalCode,null);
    assert.match(await page.locator('#toast').textContent(),/EEXIST|ENOTDIR|Could not save|not a directory/i);
  }finally{
    await fs.rm(documents,{force:true});await fs.rename(preservedDocuments,documents);
    await page.evaluate(()=>{window.__httpCloseUnsubscribe();delete window.__httpCloseUnsubscribe;delete window.__httpCloseCancelled;});
  }
  assert.equal(a.transport.sessionId,retainedSession);
  assert.deepEqual(await call(a.client,'create_board',closeArgs,closeMeta),beforeFailedClose);
  assert.equal(count(await snapshot(),closeArgs.name),1);
  const retainedTree=await call(a.client,'get_tree',{id:retainedAlias,depth:1});assert.ok(!retainedTree.isError,JSON.stringify(retainedTree));
  assert.equal(retainedTree.structuredContent.tree.rawId,retainedRawId);
  assert.ok(!(await call(a.client,'undo')).isError);assert.equal(count(await snapshot(),closeArgs.name),0);
  record('failed native close resumes the same session without clearing replay cache, aliases or Undo ownership');
  const oldSession=a.transport.sessionId;
  await b.transport.terminateSession();await b.client.close();
  assert.ok(!(await call(a.client,'get_context')).isError);
  record('ending one HTTP session preserves another');
  await stop();await a.client.close();
  await launch();
  const stale=await mcpFetch(`https://127.0.0.1:${port}/mcp`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Mcp-Session-Id':oldSession,'MCP-Protocol-Version':'2025-11-25','Content-Type':'application/json',Accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list'})});
  assert.equal(stale.status,404);await stale.arrayBuffer();
  const fresh=await connect();assert.notEqual(fresh.transport.sessionId,oldSession);assert.ok(!(await call(fresh.client,'get_context')).isError);
  assert.equal(count(await snapshot(),'HTTP author A'),1);
  record('same HTTPS URL, pinned certificate and persistent credential survive graceful restart; old session rejected and mutation retained once');
  const priorSession=fresh.transport.sessionId;
  await app.evaluate(({Menu})=>Menu.getApplicationMenu().items.find(item=>item.label==='File').submenu.items.find(item=>item.label==='New canvas').click());
  await activeDocument(shell,documentId);
  const previousResponse=await mcpFetch(`https://127.0.0.1:${port}/mcp`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Mcp-Session-Id':priorSession,'MCP-Protocol-Version':'2025-11-25','Content-Type':'application/json',Accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list'})});
  assert.equal(previousResponse.status,200);await previousResponse.arrayBuffer();
  const switched=await connect();assert.ok(!(await call(switched.client,'get_context')).isError);
  assert.equal((await call(fresh.client,'get_context')).structuredContent.document.id,documentId);
  record('opening another UI tab preserves existing HTTP sessions and explicit document targets');
  assert.deepEqual(errors,[]);await stop();
  console.log(JSON.stringify({passed:true,protocol:'2025-11-25',checks,rendererErrors:errors}));
}catch(error){console.error('HTTP E2E failed:',error.stack);throw error;}finally{
  await Promise.allSettled(clients.map(client=>client.close()));
  if(conflictApp){const child=conflictChild;await conflictApp.evaluate(({app})=>app.exit(0)).catch(()=>{});if(child.exitCode===null&&child.signalCode===null)await new Promise(resolve=>child.once('exit',resolve));}
  if(app){const child=appChild;await app.evaluate(({app})=>app.exit(0)).catch(()=>{});if(child.exitCode===null&&child.signalCode===null)await new Promise(resolve=>child.once('exit',resolve));}
  await fs.rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100});
}
