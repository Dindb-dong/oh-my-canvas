import {test} from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {startMcpBridge} from '../electron/mcp-bridge.mjs';

const root=fileURLToPath(new URL('..',import.meta.url));
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
let definitions;
async function fixture(t,dispatch) {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'omc-stdio-http-')),clients=[];
  let bridge;
  t.after(async()=>{await Promise.allSettled(clients.map(client=>client.close()));await bridge?.close();await fs.rm(dir,{recursive:true,force:true});});
  if(!definitions){const built=await build({entryPoints:[path.join(root,'editor/mcp/defs.ts')],bundle:true,platform:'node',format:'esm',write:false,logLevel:'silent'});definitions=(await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`)).TOOLS;}
  const executable=path.join(dir,'mcp-cli.cjs');
  await build({entryPoints:[path.join(root,'cli/mcp.mjs')],bundle:true,platform:'node',format:'cjs',outfile:executable,logLevel:'silent',plugins:[{name:'source-tools',setup(b){b.onResolve({filter:/tool-defs\.mjs$/},()=>({path:path.join(root,'editor/mcp/defs.ts')}));}}]});
  bridge=await startMcpBridge({dir,port:0,tools:definitions,dispatch});
  const connect=async()=>{const client=new Client({name:'stdio-http-regression',version:'1'},{capabilities:{}});clients.push(client);await client.connect(new StdioClientTransport({command:process.execPath,args:[executable,'--runtime',bridge.file]}));return client;};
  return {dir,bridge,connect};
}
const result=call=>({content:[{type:'text',text:call.agent}],structuredContent:{agent:call.agent,key:call.context?.idempotencyKey??null}});
test('stdio SDK cancellation reaches the bridge signal without ending the HTTP session',{timeout:15000},async t=>{
  const began=deferred(),cancelled=deferred();let waitingAgent;
  const f=await fixture(t,async(call,{signal})=>{
    if(call.args.wait){waitingAgent=call.agent;began.resolve();await new Promise((_,reject)=>{const abort=()=>{cancelled.resolve();reject(signal.reason);};if(signal.aborted)abort();else signal.addEventListener('abort',abort,{once:true});});}
    return result(call);
  }),client=await f.connect(),controller=new AbortController();
  const pending=client.callTool({name:'get_context',arguments:{wait:true}},undefined,{signal:controller.signal});
  await began.promise;controller.abort();await assert.rejects(pending);await cancelled.promise;
  const next=await client.callTool({name:'get_context',arguments:{}});
  assert.equal(next.isError,undefined);assert.equal(next.structuredContent.agent,waitingAgent);
});
test('stdio concurrent calls share one HTTP agent and relay idempotency metadata',{timeout:15000},async t=>{
  const f=await fixture(t,async call=>result(call)),a=await f.connect(),b=await f.connect();
  const names=(await a.listTools()).tools.map(tool=>tool.name);
  for(const name of ['list_documents','open_document','create_document','rename_document','duplicate_document','select_page'])assert.ok(names.includes(name),name);
  const calls=await Promise.all(Array.from({length:3},()=>a.callTool({name:'get_context',arguments:{},_meta:{'oh-my-canvas/idempotency-key':'stdio-key'}})));
  for(const call of calls){assert.equal(call.isError,undefined);assert.equal(call.structuredContent.agent,calls[0].structuredContent.agent);assert.equal(call.structuredContent.key,'stdio-key');}
  const other=await b.callTool({name:'get_context',arguments:{}});assert.notEqual(other.structuredContent.agent,calls[0].structuredContent.agent);
});
test('stdio reports a stale-session mutation once and reconnects only for a later explicit call',{timeout:15000},async t=>{
  let writes=0;
  const f=await fixture(t,async call=>{if(call.name==='create_board')writes++;return result(call);}),client=await f.connect();
  const first=await client.callTool({name:'get_context',arguments:{}});
  await f.bridge.resetSessions();
  const call={name:'create_board',arguments:{name:'No automatic retry',width:100,height:100}};
  const stale=await client.callTool(call);assert.equal(stale.isError,true);assert.equal(writes,0);
  const explicit=await client.callTool(call);assert.equal(explicit.isError,undefined);assert.equal(writes,1);assert.notEqual(explicit.structuredContent.agent,first.structuredContent.agent);
  const descriptor=JSON.parse(await fs.readFile(f.bridge.file,'utf8'));assert.equal(descriptor.version,2);assert.equal(Object.hasOwn(descriptor,'token'),false);
});
