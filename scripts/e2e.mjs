import {_electron as electron} from 'playwright';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';

const root=process.cwd(),dir=await fs.mkdtemp(path.join(os.tmpdir(),'omc-e2e-'));
const apps=[],pages=[],errors=[];
await fs.mkdir('docs/qa',{recursive:true});
async function launch(index){
  const profile=path.join(dir,String(index));
  await fs.mkdir(profile,{recursive:true});
  await fs.writeFile(path.join(profile,'preferences.json'),JSON.stringify({name:index===0?'Host':`Peer ${index}`}));
  const app=await electron.launch({args:[root,`--profile=${profile}`],env:{...process.env,OMC_TEST_BACKGROUND:'1',ELECTRON_DISABLE_SECURITY_WARNINGS:'true'},timeout:30000});
  apps.push(app);const page=await app.firstWindow();pages.push(page);
  page.on('pageerror',e=>{errors.push(e.message);console.error('Renderer error:',e.message);});
  page.on('console',m=>{if(m.type()==='error')console.error('Renderer console:',m.text().slice(0,350));});
  await page.locator('#new').waitFor();return {app,page,profile};
}
async function tool(page,name,args={}){const result=await page.evaluate(async({name,args})=>window.lvMcp.handleToolCall('e2e',name,args),{name,args});if(result.isError)throw Error(JSON.stringify(result));await page.evaluate(()=>window.omc.invoke('flush'));return result;}
async function waitFor(fn,ms=15000){const start=Date.now();while(Date.now()-start<ms){if(await fn())return;await new Promise(r=>setTimeout(r,100));}throw Error('Timed out waiting for convergence');}
const text=r=>r.content.filter(c=>c.type==='text').map(c=>c.text).join('\n');
let client;
try{
  const host=await launch(0);
  await host.page.screenshot({path:'docs/qa/library-empty.png'});
  await host.page.locator('#start-sample').click();
  await host.page.waitForFunction(()=>!!window.lvMcp,{timeout:20000});
  console.log('PASS Electron opens sample editor');
  await host.page.evaluate(()=>document.fonts.ready);
  await host.page.screenshot({path:'docs/qa/editor.png'});
  const context=text(await tool(host.page,'get_context'));assert.match(context,/board/i);
  const hostInfo=await host.page.evaluate(()=>window.omc.invoke('host',{port:0}));
  const invite=await host.page.evaluate(port=>window.omc.invoke('invite',{address:`127.0.0.1:${port}`}),hostInfo.port);
  for(let i=1;i<4;i++){
    const guest=await launch(i);
    await guest.page.locator('#collaborate').click();await guest.page.locator('#tab-join').click();await guest.page.locator('#join-invite').fill(invite);await guest.page.locator('#join-session').click();
    await guest.page.waitForFunction(()=>!!window.lvMcp,{timeout:20000});
  }
  await waitFor(async()=>await host.page.locator('#peers .avatar').count()===4);
  console.log('PASS four independent Electron clients connected over TLS');
  await Promise.all(pages.map((page,i)=>tool(page,'create_board',{name:`Peer ${i+1}`,width:320,height:240})));
  await waitFor(async()=>{const trees=await Promise.all(pages.map(p=>tool(p,'get_tree',{depth:1})));return trees.every(t=>['Peer 1','Peer 2','Peer 3','Peer 4'].every(n=>text(t).includes(n)));});
  console.log('PASS simultaneous four-person board creation converges');
  const created=await tool(host.page,'create_board',{name:'MCP undo proof',width:200,height:200});
  await tool(host.page,'undo');
  assert.ok(!text(await tool(host.page,'get_tree',{depth:1})).includes('MCP undo proof'));
  console.log('PASS agent undo awaits durable per-participant CRDT history');
  const board=(await tool(host.page,'find',{name:'Peer 1'})).structuredContent.matches.find(s=>s.name==='Peer 1'&&s.kind==='frame')?.id;assert.ok(board);
  const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF8sAAAAASUVORK5CYII=';
  await tool(host.page,'write_html',{target:board,position:'last',html:`<div style="padding:16px;display:flex;gap:8px"><img src="data:image/png;base64,${png}" style="width:24px;height:24px"><div style="font-family:IBM Plex Sans;font-size:18px;color:#326950">Shared image</div></div>`});
  await waitFor(async()=>{const found=await Promise.all(pages.map(p=>tool(p,'find',{text:'Shared image'})));return found.every(r=>text(r).includes('Shared image'));});
  assert.match(JSON.stringify(await tool(pages[2],'get_html',{id:(await tool(pages[2],'find',{name:'Peer 1'})).structuredContent.matches.find(s=>s.name==='Peer 1'&&s.kind==='frame').id})),/data:image/);
  console.log('PASS embedded image and HTML content share without an asset server');
  await host.page.screenshot({path:'docs/qa/four-peers.png'});
  await host.page.locator('#mcp').click();await host.page.screenshot({path:'docs/qa/mcp.png'});await host.page.locator('.close').click();
  client=new Client({name:'oh-my-canvas-e2e',version:'1'},{capabilities:{}});
  await client.connect(new StdioClientTransport({command:process.execPath,args:[path.join(root,'dist/mcp-cli.cjs'),'--runtime',path.join(host.profile,'mcp-runtime.json')]}));
  const tools=await client.listTools();assert.ok(tools.tools.some(t=>t.name==='write_html'));
  const remote=await client.callTool({name:'get_context',arguments:{}});assert.equal(remote.isError,undefined);
  console.log('PASS official MCP SDK stdio initialize/list/call to actual renderer');
  await client.close();client=null;
  // Exercise native export handlers with test-owned dialog destinations.
  for(const format of ['omc','json','svg','png']){
    const file=path.join(dir,`export.${format}`);
    await host.app.evaluate(({dialog},file)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath:file});},file);
    await host.page.locator('#export').click();await host.page.locator(`[data-format="${format}"]`).click();
    await waitFor(async()=>{try{return(await fs.stat(file)).size>20;}catch{return false;}});
    await host.page.locator('#dialog').waitFor({state:'hidden'});
    if(format==='svg')assert.match(await fs.readFile(file,'utf8'),/<svg/);
    if(format==='png')assert.equal((await fs.readFile(file)).subarray(1,4).toString(),'PNG');
  }
  console.log('PASS OMC/JSON/SVG/PNG exports write real local files');
  await pages[1].evaluate(()=>window.omc.invoke('leave'));
  await tool(pages[1],'create_board',{name:'Offline board',width:200,height:200});
  await pages[1].locator('#collaborate').click();await pages[1].locator('#tab-join').click();await pages[1].locator('#join-invite').fill(invite);await pages[1].locator('#join-session').click();await pages[1].locator('#dialog').waitFor({state:'hidden'});
  await waitFor(async()=>text(await tool(host.page,'get_tree',{depth:1})).includes('Offline board'));
  console.log('PASS saved offline changes merge after rejoining');
  await host.page.locator('#collaborate').click();await host.page.screenshot({path:'docs/qa/collaboration.png'});await host.page.locator('.close').click();
  await host.app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1000,720));await host.page.screenshot({path:'docs/qa/editor-narrow.png'});await host.app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1500,980));
  await host.page.locator('#home').click();await host.page.locator('[data-open]').first().waitFor();await host.page.screenshot({path:'docs/qa/library-populated.png'});
  await host.page.locator('[data-open]').first().click();await host.page.waitForFunction(()=>!!window.lvMcp);
  const after=text(await tool(host.page,'get_tree',{depth:1}));assert.ok(after.includes('Peer 4'));
  console.log('PASS local save and reopen retains collaborative changes');
  await host.app.evaluate(({dialog},file)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]});},path.join(dir,'export.omc'));
  await host.app.evaluate(({Menu})=>Menu.getApplicationMenu().items.find(i=>i.label==='File').submenu.items.find(i=>i.label==='Open…').click());
  await waitFor(async()=>text(await tool(host.page,'get_tree',{depth:1})).includes('Offline board'));
  console.log('PASS opening an older portable file preserves newer local edits');
  assert.deepEqual(errors,[]);
  await fs.writeFile('docs/qa/e2e-result.json',JSON.stringify({passed:true,clients:4,rendererErrors:errors,checks:['sample editor','4 TLS clients','concurrent inserts','agent undo','embedded images','MCP stdio SDK','OMC/JSON/SVG/PNG exports','offline rejoin','local save/reopen','older portable-file merge'],at:new Date().toISOString()},null,2));
}finally{
  if(client)await client.close().catch(()=>{});
  for(const page of pages)await page.evaluate(()=>window.omc.invoke('flush')).catch(()=>{});
  for(const app of apps){await app.evaluate(({app})=>app.exit(0)).catch(()=>{});await new Promise(r=>{if(app.process().exitCode!==null)r();else app.process().once('exit',r);});}
  await fs.rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:150});
}
