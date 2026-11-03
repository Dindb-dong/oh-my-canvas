import {test} from 'node:test';import assert from 'node:assert/strict';import {promises as fs} from 'node:fs';import os from 'node:os';import path from 'node:path';
import {startMcpBridge} from '../electron/mcp-bridge.mjs';
import http from 'node:http';
import {randomUUID} from 'node:crypto';import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';import {Client} from '@modelcontextprotocol/sdk/client/index.js';import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {Replica} from '../core/replica.mjs';import {changesBetween} from '../core/document.mjs';import {documentFixture} from './helpers.mjs';
test('local MCP bridge rejects missing auth, DNS rebinding Host and browser Origin',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'omc-mcp-')),bridge=await startMcpBridge({dir,dispatch:async c=>({content:[{type:'text',text:c.name}]})});t.after(async()=>{await bridge.close();await fs.rm(dir,{recursive:true,force:true});});
  const {port,token}=JSON.parse(await fs.readFile(bridge.file,'utf8')),url=`http://127.0.0.1:${port}/rpc`;
  for(const headers of [{},{Authorization:`Bearer ${token}`,Origin:'https://evil.example'}])assert.equal((await fetch(url,{method:'POST',headers,body:'{}'})).status,403);
  const rebound=await new Promise((resolve,reject)=>{const req=http.request(url,{method:'POST',headers:{Authorization:`Bearer ${token}`,Host:'evil.example'}},res=>{res.resume();resolve(res.statusCode);});req.on('error',reject);req.end('{}');});assert.equal(rebound,403);
  const r=await fetch(url,{method:'POST',headers:{Authorization:`Bearer ${token}`},body:JSON.stringify({name:'get_context',args:{}})});assert.equal(r.status,200);assert.equal((await r.json()).content[0].text,'get_context');assert.equal((await fs.stat(bridge.file)).mode&0o777,0o600);
});
test('independent stdio clients retain unique identities and cannot undo each other',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'omc-mcp-identity-')),root=fileURLToPath(new URL('..',import.meta.url)),replica=new Replica({document:documentFixture()}),clients=[];
  let bridge; t.after(async()=>{await Promise.all(clients.map(c=>c.close()));await bridge?.close();replica.destroy();await fs.rm(dir,{recursive:true,force:true});});
  const executable=path.join(dir,'mcp-cli.cjs');
  await build({entryPoints:[path.join(root,'cli/mcp.mjs')],bundle:true,platform:'node',format:'cjs',outfile:executable,logLevel:'silent',plugins:[{name:'source-tool-definitions',setup(b){b.onResolve({filter:/tool-defs\.mjs$/},()=>({path:path.join(root,'editor/mcp/defs.ts')}));}}]});
  const reply=value=>({content:[{type:'text',text:JSON.stringify(value)}],structuredContent:value});
  bridge=await startMcpBridge({dir,dispatch:async call=>{
    if(call.name==='create_board'){
      const before=replica.document,after=structuredClone(before),id=randomUUID();
      after.pagesById.page.objects[id]={id,type:'frame',name:call.args.name,parentId:'root',enclosingFrameId:'root',childIds:[],x:0,y:0,width:100,height:100};after.pagesById.page.objects.root.childIds.push(id);
      replica.patch(changesBetween(before,after),`agent:${call.agent}`);return reply({agent:call.agent});
    }
    if(call.name==='undo'){
      if(replica.undo.undoStack.at(-1)?.meta.get('label')!==`agent:${call.agent}`)return {isError:true,content:[{type:'text',text:'nothing_to_undo'}]};
      replica.history('undo');return reply({agent:call.agent});
    }
    return reply({agent:call.agent,names:Object.values(replica.document.pagesById.page.objects).map(s=>s.name)});
  }});
  for(const name of ['A','B']){const client=new Client({name,version:'1'},{capabilities:{}});clients.push(client);await client.connect(new StdioClientTransport({command:process.execPath,args:[executable,'--runtime',bridge.file]}));}
  const [a,b]=clients,call=(client,name,args={})=>client.callTool({name,arguments:args});
  const first=await call(a,'create_board',{name:'Agent A board'}),second=await call(b,'create_board',{name:'Agent B board'});
  const aId=first.structuredContent.agent,bId=second.structuredContent.agent;assert.match(aId,/^mcp-stdio-[0-9a-f-]{36}$/);assert.notEqual(aId,bId);
  assert.equal((await call(a,'get_context')).structuredContent.agent,aId);
  assert.equal((await call(a,'undo')).isError,true);
  let names=(await call(a,'get_context')).structuredContent.names;assert.ok(names.includes('Agent A board'));assert.ok(names.includes('Agent B board'));
  assert.ok(!(await call(b,'undo')).isError);names=(await call(a,'get_context')).structuredContent.names;assert.ok(names.includes('Agent A board'));assert.ok(!names.includes('Agent B board'));
  assert.ok(!(await call(a,'undo')).isError);assert.ok(!(await call(a,'get_context')).structuredContent.names.includes('Agent A board'));
});
