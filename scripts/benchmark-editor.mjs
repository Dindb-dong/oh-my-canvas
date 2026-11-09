import {documentPage,libraryPage} from './desktop-test-pages.mjs';
import {_electron as electron} from 'playwright';import {promises as fs} from 'node:fs';import path from 'node:path';import os from 'node:os';import assert from 'node:assert/strict';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
const profile=await fs.mkdtemp(path.join(os.tmpdir(),'omc-edit-perf-'));let app,child,client;
try{
 app=await electron.launch({env:{...process.env,OMC_TEST_BACKGROUND:'1'},args:[process.cwd(),`--profile=${profile}`]});child=app.process();let p=await app.firstWindow();await p.locator('#import').waitFor();
 await app.evaluate(({dialog},file)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]});},path.resolve('docs/design/system/component-library.omc'));await p.locator('#import').click();p=await documentPage(app);await p.waitForFunction(()=>!!window.lvMcp);
 const documentId=(await p.evaluate(()=>window.omc.invoke('snapshot'))).id;
 const config=JSON.parse((await p.evaluate(()=>window.omc.invoke('mcp-info',{transport:'stdio'}))).config).mcpServers['oh-my-canvas'];client=new Client({name:'durable performance benchmark',version:'1'},{capabilities:{}});await client.connect(new StdioClientTransport(config));
 const call=async(name,args)=>{const r=await client.callTool({name,arguments:{...args,documentId}});assert.ok(!r.isError,JSON.stringify(r));return r.structuredContent;};
 const context=await call('get_context',{}),id=context.boards[0],times=[];
 for(let i=0;i<11;i++){const start=performance.now();await call('update',{id,attrs:{name:'Durable benchmark '+i}});if(i)times.push(performance.now()-start);}
 const sorted=[...times].sort((a,b)=>a-b),middle=Math.floor(sorted.length/2),median=sorted.length%2?sorted[middle]:(sorted[middle-1]+sorted[middle])/2,p95=sorted[Math.ceil(sorted.length*.95)-1];await fs.writeFile('docs/qa/editor-performance.json',JSON.stringify({document:'component-library.omc',shapes:1065,transport:'official MCP SDK stdio → actual Electron → renderer → durable commit/fsync → response',samples:times.length,warmupEdits:1,medianMethod:'middle value or midpoint for an even sample count',p95Method:'nearest rank',medianMs:median,p95Ms:p95,samplesMs:times,at:new Date().toISOString()},null,2));console.log('PASS durable editor benchmark',median,p95);
}finally{await client?.close();if(app){await app.close().catch(()=>{});if(child.exitCode===null&&child.signalCode===null)await new Promise(r=>child.once('exit',r));}await fs.rm(profile,{recursive:true,force:true});}
