import {_electron as electron} from 'playwright';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {createMcpFetch} from '../core/mcp-fetch.mjs';

const root=process.cwd();
const primary=execFileSync('git',['worktree','list','--porcelain'],{encoding:'utf8'}).split('\n').find(line=>line.startsWith('worktree ')).slice(9);
const evidence=path.join(primary,'internal/docs/mcp-workspace-20261109/evidence');
execFileSync('git',['check-ignore',evidence],{cwd:primary});
await fs.mkdir(evidence,{recursive:true});
const profile=await fs.mkdtemp(path.join(os.tmpdir(),'omc-workspace-e2e-'));
const clients=[],errors=[],checks=[];
let app,page,runtime,token,mcpFetch;
const record=name=>{checks.push(name);console.log('PASS '+name);};
const invoke=(client,name,args={},key)=>client.callTool({name,arguments:args,...key?{_meta:{'oh-my-canvas/idempotency-key':key}}:{}});
async function ok(client,name,args={},key){const result=await invoke(client,name,args,key);assert.ok(!result.isError,`${name}: ${JSON.stringify(result)}`);return result.structuredContent;}
const snapshot=()=>page.evaluate(()=>window.omc.invoke('snapshot'));
const named=(snap,name)=>Object.values(snap.document.pagesById).flatMap(p=>Object.values(p.objects)).filter(shape=>shape.name===name);
async function launch(){
  app=await electron.launch({args:[root,`--profile=${profile}`,'--mcp-port=0'],env:{...process.env,OMC_TEST_BACKGROUND:'1'},timeout:30000});
  page=await app.firstWindow();
  page.on('pageerror',error=>errors.push(error.message));
  await page.locator('#new').waitFor();
  assert.equal(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].isVisible()),false);
  runtime=JSON.parse(await fs.readFile(path.join(profile,'mcp-runtime.json'),'utf8'));
  token=await fs.readFile(path.join(profile,'mcp-token-v2'),'utf8');
  mcpFetch=createMcpFetch(await fs.readFile(runtime.certFile,'utf8'));
}
async function connect(){
  const client=new Client({name:'workspace-regression',version:'1'},{capabilities:{}});
  const transport=new StreamableHTTPClientTransport(new URL(`https://127.0.0.1:${runtime.port}/mcp`),{fetch:mcpFetch,requestInit:{headers:{Authorization:`Bearer ${token}`}}});
  clients.push(client);await client.connect(transport);return {client,transport};
}
async function staleStatus(sessionId){
  const response=await mcpFetch(`https://127.0.0.1:${runtime.port}/mcp`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Mcp-Session-Id':sessionId,'MCP-Protocol-Version':'2025-11-25','Content-Type':'application/json',Accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list'})});
  await response.arrayBuffer();return response.status;
}
async function waitMain(predicate){for(let i=0;i<200;i++){if(await app.evaluate(predicate))return;await new Promise(resolve=>setTimeout(resolve,10));}throw Error('Test main-process gate was not reached');}
async function stop(){
  if(!app)return;
  const child=app.process();
  // Official close detaches Playwright's inspector after the app's save-and-quit path.
  await app.close();assert.equal(child.exitCode,0);assert.equal(child.signalCode,null);app=null;
}
try{
  await launch();
  const a=await connect(),b=await connect(),session=a.transport.sessionId;
  const names=(await a.client.listTools()).tools.map(tool=>tool.name);
  assert.equal(names.length,31);
  for(const name of ['list_documents','open_document','create_document','rename_document','duplicate_document','select_page'])assert.ok(names.includes(name));
  assert.deepEqual((await ok(a.client,'list_documents')).documents,[]);
  assert.equal((await ok(a.client,'list_documents')).view,'library');
  assert.equal((await invoke(a.client,'get_context')).isError,true);
  record('empty library supports MCP discovery without a manually opened canvas');

  const createdA=await ok(a.client,'create_document',{title:'Canvas A'},'create-A');
  const idA=createdA.document.id;assert.equal(createdA.document.title,'Canvas A');assert.ok(createdA.context.page.id);
  assert.deepEqual(await ok(a.client,'create_document',{title:'Canvas A'},'create-A'),createdA);
  assert.equal((await ok(a.client,'list_documents')).total,1);
  assert.equal(a.transport.sessionId,session);assert.equal(await staleStatus(b.transport.sessionId),404);
  await ok(a.client,'create_board',{name:'Retained A content',width:240,height:120});
  const createdB=await ok(a.client,'create_document',{title:'Canvas B'}),idB=createdB.document.id;
  assert.equal((await ok(a.client,'get_context')).document.id,idB);
  const listed=await ok(a.client,'list_documents',{limit:1});
  assert.equal(listed.total,2);assert.equal(listed.documents.length,1);assert.equal(listed.nextOffset,1);
  assert.ok(!JSON.stringify(listed).includes('thumbnail'));assert.ok(!JSON.stringify(listed).includes(profile));
  assert.equal((await ok(a.client,'list_documents',{offset:1,limit:1})).nextOffset,null);
  await ok(a.client,'open_document',{id:idA});
  assert.equal(named(await snapshot(),'Retained A content').length,1);
  assert.equal((await ok(a.client,'get_context')).document.id,idA);
  record('MCP creates, edits, lists and reopens canvases on the same session while retiring stale clients');

  // Delay only a synthetic old-document message so navigation can overtake its delivery.
  await app.evaluate(({BrowserWindow})=>{
    const web=BrowserWindow.getAllWindows()[0].webContents,send=web.send.bind(web);
    globalThis.__workspaceDelayed=[];globalThis.__workspaceRestoreSend=()=>{web.send=send;};
    web.send=(...args)=>{const [channel,message]=args;if(channel==='omc:event'&&message.type==='tool'&&message.call.args?.name==='Must never cross documents')globalThis.__workspaceDelayed.push(args);else send(...args);};
  });
  try{
    const delayed=invoke(a.client,'create_board',{name:'Must never cross documents',width:100,height:100}).then(result=>({result}),error=>({error}));
    await waitMain(()=>globalThis.__workspaceDelayed.length===1);
    await ok(a.client,'open_document',{id:idB});
    const cancelled=await delayed;assert.ok(cancelled.error||cancelled.result.isError);
    await app.evaluate(({BrowserWindow})=>{globalThis.__workspaceRestoreSend();for(const args of globalThis.__workspaceDelayed)BrowserWindow.getAllWindows()[0].webContents.send(...args);});
    await ok(a.client,'get_context');assert.equal(named(await snapshot(),'Must never cross documents').length,0);
  }finally{await app.evaluate(()=>{globalThis.__workspaceRestoreSend();delete globalThis.__workspaceRestoreSend;delete globalThis.__workspaceDelayed;});}
  await ok(a.client,'open_document',{id:idA});
  record('a delayed admitted edit for the old document is cancelled and cannot mutate the new document');

  // Hold the test-only IPC reply after the durable host switch, then cancel its SDK caller.
  await app.evaluate(({ipcMain},destination)=>{
    const handler=ipcMain._invokeHandlers.get('omc:invoke');
    globalThis.__workspaceHostSwitched=false;globalThis.__workspaceRelease=null;
    globalThis.__workspaceRestoreInvoke=()=>{ipcMain.removeHandler('omc:invoke');ipcMain.handle('omc:invoke',handler);};
    ipcMain.removeHandler('omc:invoke');ipcMain.handle('omc:invoke',async(event,action,data)=>{
      const result=await handler(event,action,data);
      if(action==='open'&&data.id===destination){globalThis.__workspaceHostSwitched=true;await new Promise(resolve=>globalThis.__workspaceRelease=resolve);}
      return result;
    });
  },idB);
  try{
    const controller=new AbortController(),pending=a.client.callTool({name:'open_document',arguments:{id:idB}},undefined,{signal:controller.signal});
    await waitMain(()=>globalThis.__workspaceHostSwitched);
    controller.abort();await assert.rejects(pending);
    await app.evaluate(()=>globalThis.__workspaceRelease());
    await page.waitForFunction(()=>document.querySelector('#document-name').textContent==='Canvas B'&&!document.querySelector('#editor').inert);
  }finally{await app.evaluate(()=>{globalThis.__workspaceRelease?.();globalThis.__workspaceRestoreInvoke();delete globalThis.__workspaceRestoreInvoke;delete globalThis.__workspaceRelease;delete globalThis.__workspaceHostSwitched;});}
  assert.equal((await ok(a.client,'get_context')).document.id,idB);
  await ok(a.client,'open_document',{id:idA});
  record('cancellation after the durable host switch still reconciles the renderer and permits later navigation');

  const renamed=await ok(a.client,'rename_document',{id:idA,title:'  Active A renamed  '});
  assert.equal(renamed.document.title,'Active A renamed');
  assert.equal(await page.locator('#document-name').textContent(),'Active A renamed');
  await ok(a.client,'rename_document',{id:idB,title:'Inactive B renamed'});
  assert.equal((await snapshot()).id,idA);assert.equal((await snapshot()).title,'Active A renamed');
  assert.equal((await ok(a.client,'list_documents',{query:'inactive b'})).documents[0].id,idB);
  record('active and inactive targeted renames persist without switching the current canvas');

  const beforeInvalid=(await ok(a.client,'list_documents')).total;
  for(const [name,args] of [
    ['open_document',{id:'../../outside'}],['open_document',{id:randomUUID()}],
    ['rename_document',{id:idA,title:' '}],['create_document',{title:'x'.repeat(121)}],
    ['create_document',{title:'Invalid',path:'/tmp/forbidden.omc'}],['list_documents',{limit:101}],['list_documents',{offset:-1}],
  ])assert.equal((await invoke(a.client,name,args)).isError,true,JSON.stringify({name,args}));
  assert.equal((await ok(a.client,'list_documents')).total,beforeInvalid);assert.equal((await snapshot()).id,idA);
  const damagedId=randomUUID(),damagedFile=path.join(profile,'documents',`${damagedId}.omc`);
  await fs.writeFile(damagedFile,'Synthetic damaged canvas');
  try{
    assert.equal((await ok(a.client,'list_documents')).documents.find(doc=>doc.id===damagedId).damaged,true);
    assert.equal((await invoke(a.client,'open_document',{id:damagedId})).isError,true);assert.equal((await snapshot()).id,idA);
  }finally{await fs.rm(damagedFile,{force:true});}
  record('invalid IDs, missing destinations, blank or oversized names and unsupported arguments leave the current canvas intact');

  await page.evaluate(()=>window.omc.invoke('flush'));
  const documents=path.join(profile,'documents'),preserved=path.join(profile,'documents-preserved');
  await fs.rename(documents,preserved);
  try{
    await fs.writeFile(documents,'Synthetic persistence failure');
    assert.equal((await invoke(a.client,'rename_document',{id:idA,title:'Must not publish'})).isError,true);
    assert.equal((await snapshot()).title,'Active A renamed');
    assert.equal((await invoke(a.client,'create_document',{title:'Must not replace'})).isError,true);
    assert.equal((await snapshot()).id,idA);
  }finally{await fs.rm(documents,{force:true});await fs.rename(preserved,documents);}
  record('injected save failures do not publish a renamed title or replace the current canvas');

  const copied=await ok(a.client,'duplicate_document',{id:idA,title:'Canvas A copy'},'copy-A');
  assert.notEqual(copied.document.id,idA);assert.equal(named(await snapshot(),'Retained A content').length,1);
  assert.deepEqual(await ok(a.client,'duplicate_document',{id:idA,title:'Canvas A copy'},'copy-A'),copied);
  assert.equal((await ok(a.client,'list_documents')).total,3);
  assert.equal((await invoke(a.client,'duplicate_document',{id:idA,title:'Different copy'},'copy-A')).isError,true);
  assert.equal((await ok(a.client,'list_documents')).total,3);
  record('duplicate creates an independent durable copy and session idempotency survives editor replacement');

  const firstPage=(await ok(a.client,'get_context')).page.id;
  await page.getByRole('button',{name:'Add page',exact:true}).click();
  const twoPages=await ok(a.client,'get_context'),secondPage=twoPages.page.id;
  assert.notEqual(secondPage,firstPage);assert.equal(twoPages.pages.length,2);
  await ok(a.client,'create_board',{name:'Second page only',width:200,height:100});
  await ok(a.client,'select_page',{id:firstPage});
  assert.equal((await ok(a.client,'get_context')).page.id,firstPage);
  assert.ok(!JSON.stringify(await ok(a.client,'get_tree')).includes('Second page only'));
  await ok(a.client,'select_page',{id:secondPage});
  assert.ok(JSON.stringify(await ok(a.client,'get_tree')).includes('Second page only'));
  assert.equal((await invoke(a.client,'select_page',{id:'missing-page'})).isError,true);
  record('page selection changes subsequent MCP targets while preserving both page contents');

  await page.locator('#document-title').click();
  await page.locator('#title-input').evaluate(input=>{
    input.value='조합 중';
    input.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true,data:'가'}));
    input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true,isComposing:true}));
    input.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'가'}));
    input.form.requestSubmit();
  });
  assert.ok(await page.locator('#title-input').isVisible());assert.equal((await snapshot()).title,'Canvas A copy');
  await page.locator('#title-input').evaluate(input=>{
    input.dispatchEvent(new KeyboardEvent('keyup',{key:'Enter',bubbles:true}));
    input.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true,data:'나'}));
    input.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true,isComposing:true}));
    input.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'나'}));
    input.dispatchEvent(new KeyboardEvent('keyup',{key:'Escape',bubbles:true}));
  });
  assert.ok(await page.locator('#title-input').isVisible());assert.equal((await snapshot()).title,'Canvas A copy');
  await page.locator('#title-input').fill('   ');await page.locator('#title-input').press('Enter');
  assert.ok(await page.locator('#title-input').isVisible());assert.equal((await snapshot()).title,'Canvas A copy');
  assert.equal((await invoke(a.client,'rename_document',{id:copied.document.id,title:'Must not interrupt typing'})).isError,true);
  await page.locator('#title-input').fill('Cancelled name');await page.locator('#title-input').press('Escape');
  assert.equal((await snapshot()).title,'Canvas A copy');
  await page.locator('#toast').waitFor({state:'hidden'});
  await page.locator('#document-title').click();
  await page.locator('#title-input').fill('Manual rename <safe>');
  await page.screenshot({path:path.join(evidence,'rename-editor-inline.png')});
  await page.locator('#title-input').press('Enter');await page.locator('#title-input').waitFor({state:'hidden'});
  assert.equal(await page.locator('#document-name').textContent(),'Manual rename <safe>');
  await page.locator('#document-title').click();await page.locator('#title-input').fill('Saved on blur');await page.locator('#home').focus();
  await page.locator('#title-input').waitFor({state:'hidden'});assert.equal((await snapshot()).title,'Saved on blur');
  await ok(a.client,'rename_document',{id:copied.document.id,title:'Manual rename <safe>'});
  await page.screenshot({path:path.join(evidence,'rename-editor-desktop.png')});
  await ok(a.client,'rename_document',{id:copied.document.id,title:'Long canvas title '.repeat(8).slice(0,120)});
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(960,640));
  await page.screenshot({path:path.join(evidence,'rename-editor-minimum.png')});
  assert.ok(await page.locator('#document-title').isVisible());
  const renameBounds=await page.locator('#document-title').boundingBox();assert.ok(renameBounds.x+renameBounds.width<=960);
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1500,980));
  await ok(a.client,'rename_document',{id:copied.document.id,title:'Manual rename <safe>'});
  await page.locator('#home').click();await page.locator(`[data-more="${idB}"]`).waitFor();
  await page.locator(`[data-more="${idB}"]`).click();
  await page.screenshot({path:path.join(evidence,'rename-library-actions.png')});
  await page.locator('#rename-doc').click();await page.locator('#name').fill('B renamed from library');await page.locator('#name').press('Enter');
  await page.locator('#dialog').waitFor({state:'hidden'});
  assert.equal((await snapshot()).id,copied.document.id);
  assert.equal((await ok(a.client,'list_documents',{query:'B renamed from library'})).documents[0].id,idB);
  assert.equal((await ok(a.client,'list_documents')).view,'library');
  record('inline title and library Rename support Escape, Enter, blur and escaped titles at desktop and minimum sizes');

  const oldSession=a.transport.sessionId;
  await stop();await launch();
  assert.equal(await staleStatus(oldSession),404);
  const fresh=await connect(),saved=await ok(fresh.client,'list_documents');
  assert.equal(saved.total,3);assert.ok(saved.documents.some(doc=>doc.id===idB&&doc.title==='B renamed from library'));
  await ok(fresh.client,'open_document',{id:idA});assert.equal(named(await snapshot(),'Retained A content').length,1);
  assert.equal((await snapshot()).title,'Active A renamed');
  await ok(fresh.client,'open_document',{id:copied.document.id});assert.equal((await snapshot()).title,'Manual rename <safe>');
  assert.equal((await ok(fresh.client,'get_context')).pages.length,2);assert.equal(named(await snapshot(),'Second page only').length,1);
  record('graceful restart retains names, independent copies and page content; old sessions remain invalid');
  assert.deepEqual(errors,[]);
  await stop();
  await fs.writeFile(path.join(evidence,'workspace-mcp-result.json'),JSON.stringify({passed:true,checks,rendererErrors:errors,at:new Date().toISOString()},null,2)+'\n');
}catch(error){
  await page?.screenshot({path:path.join(evidence,'workspace-failure.png')}).catch(()=>{});
  await fs.writeFile(path.join(evidence,'workspace-mcp-failure.json'),JSON.stringify({passed:false,checks,rendererErrors:errors,url:page?.url(),error:error.stack},null,2)+'\n');
  throw error;
}finally{
  await Promise.allSettled(clients.map(client=>client.close()));
  if(app){const child=app.process();await app.evaluate(({app})=>app.exit(0)).catch(()=>{});if(child.exitCode===null&&child.signalCode===null)await new Promise(resolve=>child.once('exit',resolve));}
  await fs.rm(profile,{recursive:true,force:true,maxRetries:5,retryDelay:100});
}
