import {test} from 'node:test';import assert from 'node:assert/strict';import {promises as fs} from 'node:fs';import os from 'node:os';import path from 'node:path';
import {startMcpBridge} from '../electron/mcp-bridge.mjs';
import https from 'node:https';
import {createMcpFetch} from '../core/mcp-fetch.mjs';
import {randomUUID} from 'node:crypto';import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';import {Client} from '@modelcontextprotocol/sdk/client/index.js';import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {Replica} from '../core/replica.mjs';import {changesBetween} from '../core/document.mjs';import {documentFixture} from './helpers.mjs';
test('local MCP bridge rejects missing auth, DNS rebinding Host and browser Origin',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'omc-mcp-')),bridge=await startMcpBridge({dir,port:0,dispatch:async c=>({content:[{type:'text',text:c.name}]})});t.after(async()=>{await bridge.close();await fs.rm(dir,{recursive:true,force:true});});
  const {port,certFile}=JSON.parse(await fs.readFile(bridge.file,'utf8')),token=await fs.readFile(path.join(dir,'mcp-token-v2'),'utf8'),cert=await fs.readFile(certFile,'utf8'),fetch=createMcpFetch(cert),url=`https://127.0.0.1:${port}/rpc`;
  for(const headers of [{},{Authorization:`Bearer ${token}`,Origin:'https://evil.example'}])assert.equal((await fetch(url,{method:'POST',headers,body:'{}'})).status,403);
  const rebound=await new Promise((resolve,reject)=>{const req=https.request(url,{method:'POST',ca:cert,servername:'localhost',headers:{Authorization:`Bearer ${token}`,Host:'evil.example'}},res=>{res.resume();resolve(res.statusCode);});req.on('error',reject);req.end('{}');});assert.equal(rebound,403);
  const r=await fetch(url,{method:'POST',headers:{Authorization:`Bearer ${token}`},body:JSON.stringify({name:'get_context',args:{},agent:`mcp-stdio-${randomUUID()}`})});assert.equal(r.status,200);assert.equal((await r.json()).content[0].text,'get_context');assert.equal((await fs.stat(bridge.file)).mode&0o777,0o600);
});
test('independent stdio clients retain unique identities and cannot undo each other',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'omc-mcp-identity-')),root=fileURLToPath(new URL('..',import.meta.url)),replica=new Replica({document:documentFixture()}),clients=[];
  let bridge; t.after(async()=>{await Promise.all(clients.map(c=>c.close()));await bridge?.close();replica.destroy();await fs.rm(dir,{recursive:true,force:true});});
  const executable=path.join(dir,'mcp-cli.cjs');
  await build({entryPoints:[path.join(root,'cli/mcp.mjs')],bundle:true,platform:'node',format:'cjs',outfile:executable,logLevel:'silent',plugins:[{name:'source-tool-definitions',setup(b){b.onResolve({filter:/tool-defs\.mjs$/},()=>({path:path.join(root,'editor/mcp/defs.ts')}));}}]});
  const reply=value=>({content:[{type:'text',text:JSON.stringify(value)}],structuredContent:value});
  bridge=await startMcpBridge({dir,port:0,tools:await sourceTools(),dispatch:async call=>{
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
  const aId=first.structuredContent.agent,bId=second.structuredContent.agent;assert.match(aId,/^mcp-http-[0-9a-f-]{36}$/);assert.notEqual(aId,bId);
  assert.equal((await call(a,'get_context')).structuredContent.agent,aId);
  assert.equal((await call(a,'undo')).isError,true);
  let names=(await call(a,'get_context')).structuredContent.names;assert.ok(names.includes('Agent A board'));assert.ok(names.includes('Agent B board'));
  assert.ok(!(await call(b,'undo')).isError);names=(await call(a,'get_context')).structuredContent.names;assert.ok(names.includes('Agent A board'));assert.ok(!names.includes('Agent B board'));
  assert.ok(!(await call(a,'undo')).isError);assert.ok(!(await call(a,'get_context')).structuredContent.names.includes('Agent A board'));
});

import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {StreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import net from 'node:net';
import tls from 'node:tls';
let toolDefinitions;
async function sourceTools(){
  if(!toolDefinitions){const built=await build({entryPoints:[fileURLToPath(new URL('../editor/mcp/defs.ts',import.meta.url))],bundle:true,platform:'node',format:'esm',write:false,logLevel:'silent'});toolDefinitions=(await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`)).TOOLS;}
  return toolDefinitions;
}
async function httpFixture(t,options={}) {
  await sourceTools();
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'omc-http-')),ended=[],clients=[];
  let bridge=await startMcpBridge({dir,port:0,tools:toolDefinitions,endSession:agent=>ended.push(agent),dispatch:async call=>({content:[{type:'text',text:call.agent}],structuredContent:{agent:call.agent}}),...options});
  const token=await fs.readFile(path.join(dir,'mcp-token-v2'),'utf8'),cert=await fs.readFile(path.join(dir,'mcp-cert.pem'),'utf8'),fetch=createMcpFetch(cert);
  const connect=async(options={})=>{const client=new Client({name:'identical-client',version:'1'},{capabilities:{}}),transport=new StreamableHTTPClientTransport(new URL(bridge.url),{fetch,...options,requestInit:{headers:{Authorization:`Bearer ${token}`}}});clients.push({client,transport});await client.connect(transport);return {client,transport};};
  t.after(async()=>{await Promise.allSettled(clients.map(({client})=>client.close()));await bridge.close();await fs.rm(dir,{recursive:true,force:true});});
  return {get bridge(){return bridge;},dir,token,cert,fetch,ended,connect,async restart(){const port=bridge.port;await bridge.close();bridge=await startMcpBridge({dir,port,tools:toolDefinitions,dispatch:async call=>({content:[{type:'text',text:call.agent}]})});},post(body,headers={},method='POST'){return fetch(bridge.url,{method,headers:{Authorization:`Bearer ${token}`,Accept:'application/json, text/event-stream','Content-Type':'application/json',...headers},...method==='POST'?{body:typeof body==='string'?body:JSON.stringify(body)}:{}});}};
}
const initialize=id=>({jsonrpc:'2.0',id,method:'initialize',params:{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'same',version:'1'}}});
test('HTTP SDK clients list all tools, isolate identical client identities and terminate agents',async t=>{
  const f=await httpFixture(t),a=await f.connect(),b=await f.connect();
  const listed=(await a.client.listTools()).tools,expected=await sourceTools();
  assert.deepEqual(listed,expected);
  for(const name of ['write_svg','get_path','edit_path','boolean','outline','image'])assert.ok(listed.some(tool=>tool.name===name),name);
  const call=client=>client.callTool({name:'get_context',arguments:{}}),[one,two]=await Promise.all([call(a.client),call(b.client)]);
  assert.match(one.structuredContent.agent,/^mcp-http-[a-f0-9-]{36}$/);assert.notEqual(one.structuredContent.agent,two.structuredContent.agent);
  assert.equal((await call(a.client)).structuredContent.agent,one.structuredContent.agent);
  await a.transport.terminateSession();assert.ok(f.ended.includes(one.structuredContent.agent));
  assert.equal((await call(b.client)).structuredContent.agent,two.structuredContent.agent);
});
test('HTTP validates auth, exact hosts, origins, media, methods, versions and body bounds',async t=>{
  const f=await httpFixture(t,{limits:{bodyBytes:512}});
  for(const headers of [{Authorization:''},{Authorization:'Bearer wrong'},{Origin:''},{Origin:'null'}])assert.equal((await f.post(initialize(1),headers)).status,403);
  // Fetch normalizes Host; raw HTTP exercises the exact authority sent on the wire.
  for(const Host of ['127.0.0.1.evil:'+f.bridge.port,'localhost:1','[::1]:'+f.bridge.port]){
    const status=await new Promise((resolve,reject)=>{const req=https.request(f.bridge.url,{method:'POST',ca:f.cert,servername:'localhost',headers:{Host,Authorization:`Bearer ${f.token}`,'Content-Type':'application/json',Accept:'application/json, text/event-stream'}},res=>{res.resume();resolve(res.statusCode);});req.on('error',reject);req.end(JSON.stringify(initialize(1)));});assert.equal(status,403);
  }
  assert.equal((await f.post(undefined,{},'GET')).status,405);
  assert.equal((await f.post('{')).status,400);
  const exact=JSON.stringify(initialize(10));assert.equal((await f.post(exact+' '.repeat(512-Buffer.byteLength(exact)))).status,200);
  assert.equal((await f.post('x'.repeat(513))).status,413);
  assert.equal((await f.post(initialize(1),{Accept:'application/json'})).status,406);
  assert.equal((await f.post(initialize(1),{'Content-Type':'text/plain'})).status,415);
  const r=await f.post(initialize(1));assert.equal(r.status,200);
  const id=r.headers.get('mcp-session-id');assert.ok(id);assert.equal(JSON.parse((await r.text()).match(/^data: (.+)$/m)[1]).result.protocolVersion,'2025-11-25');
  assert.equal((await f.post({jsonrpc:'2.0',id:2,method:'tools/list'},{'mcp-session-id':id,'mcp-protocol-version':'unsupported'})).status,400);
  assert.equal((await f.post({jsonrpc:'2.0',id:2,method:'tools/list'},{'mcp-session-id':'missing'})).status,404);
  assert.equal((await fs.stat(path.join(f.dir,'mcp-token-v2'))).mode&0o777,0o600);
  assert.equal((await fs.stat(f.bridge.file)).mode&0o777,0o600);
  const descriptor=JSON.parse(await fs.readFile(f.bridge.file,'utf8'));assert.equal(descriptor.version,2);assert.equal(Object.hasOwn(descriptor,'token'),false);
  assert.deepEqual((await fs.readdir(f.dir)).sort(),['mcp-cert.pem','mcp-identity.json','mcp-runtime.json','mcp-token-v2']);
});
test('HTTP enforces session limit, reclaims DELETE sessions and idle sessions',async t=>{
  const f=await httpFixture(t,{limits:{sessions:1,idleMs:30}}),first=await f.post(initialize(1)),id=first.headers.get('mcp-session-id');
  assert.equal(first.status,200);assert.equal((await f.post(initialize(1))).status,429);
  assert.equal((await f.post(undefined,{'mcp-session-id':id,'mcp-protocol-version':'2025-11-25'},'DELETE')).status,200);
  assert.equal((await f.post(initialize(1))).status,200);
  await new Promise(resolve=>setTimeout(resolve,90));
  assert.equal((await f.post(initialize(1))).status,200);assert.equal(f.ended.length,2);
});
test('HTTP cancellation isolates requests and pending limit is reclaimed',async t=>{
  let started,release,onCancelled,onResponses,entered=0,cancelled=0,responses=0;const responded=new Promise(resolve=>onResponses=resolve),trackedFetch=async(url,init)=>{const response=await f.fetch(url,init);if(init?.body&&JSON.parse(init.body).method==='tools/call')void response.clone().text().then(()=>{if(++responses===2)onResponses();});return response;};const began=new Promise(resolve=>started=resolve),bothCancelled=new Promise(resolve=>onCancelled=resolve),gate=new Promise(resolve=>release=resolve);
  const f=await httpFixture(t,{limits:{requests:2},dispatch:async(call,{signal})=>{if(call.args.wait){if(++entered===2)started();await Promise.race([gate,new Promise((_,reject)=>{signal.addEventListener('abort',()=>{if(++cancelled===2)onCancelled();reject(signal.reason);},{once:true});})]);}return {content:[{type:'text',text:call.agent}]};}}),a=await f.connect({fetch:trackedFetch}),b=await f.connect({fetch:trackedFetch}),abort=new AbortController();
  const waiting=a.client.callTool({name:'get_context',arguments:{wait:true}},undefined,{signal:abort.signal});
  const secondAbort=new AbortController(),second=b.client.callTool({name:'get_context',arguments:{wait:true}},undefined,{signal:secondAbort.signal});
  await Promise.race([began,new Promise((_,reject)=>setTimeout(()=>reject(Error('Both requests did not enter dispatch')),2000).unref())]);
  assert.equal((await f.post({jsonrpc:'2.0',id:99,method:'tools/list'},{'mcp-session-id':b.transport.sessionId,'mcp-protocol-version':'2025-11-25'})).status,429);
  abort.abort();await assert.rejects(waiting);secondAbort.abort();await assert.rejects(second);
  await Promise.race([bothCancelled,new Promise((_,reject)=>setTimeout(()=>reject(Error('Cancellation did not reach both handlers')),2000).unref())]);
  assert.equal(cancelled,2);
  await Promise.race([responded,new Promise((_,reject)=>setTimeout(()=>reject(Error('Cancelled HTTP response slots were not reclaimed')),2000).unref())]);release();
  assert.ok(!(await b.client.callTool({name:'get_context',arguments:{}})).isError);
});
test('HTTP stable URL and private credential survive restart, old session is rejected',async t=>{
  const f=await httpFixture(t),r=await f.post(initialize(1)),id=r.headers.get('mcp-session-id'),url=f.bridge.url;
  await f.restart();assert.equal(f.bridge.url,url);assert.equal(await fs.readFile(path.join(f.dir,'mcp-token-v2'),'utf8'),f.token);
  assert.equal((await f.post({jsonrpc:'2.0',id:2,method:'tools/list'},{'mcp-session-id':id,'mcp-protocol-version':'2025-11-25'})).status,404);
  assert.equal((await f.post(initialize(1))).status,200);
});
test('HTTP startup collision never falls back, descriptor failure rolls back listener',async t=>{
  const f=await httpFixture(t),dir=await fs.mkdtemp(path.join(os.tmpdir(),'omc-collision-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  await assert.rejects(startMcpBridge({dir,port:f.bridge.port,dispatch:async()=>{}}),{code:'EADDRINUSE'});
  assert.equal((await f.post(initialize(1))).status,200);
  const probe=net.createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
  await fs.mkdir(path.join(dir,'mcp-runtime.json'));
  await assert.rejects(startMcpBridge({dir,port,dispatch:async()=>{}}));
  await new Promise((resolve,reject)=>{probe.once('error',reject);probe.listen(port,'127.0.0.1',resolve);});await new Promise(resolve=>probe.close(resolve));
});
test('HTTP rejects a stalled body and closes idle sockets without waiting',async t=>{
  const f=await httpFixture(t,{limits:{bodyMs:200}});
  const status=await new Promise((resolve,reject)=>{const req=https.request(f.bridge.url,{method:'POST',ca:f.cert,servername:'localhost',headers:{Authorization:`Bearer ${f.token}`,'Content-Type':'application/json','Content-Length':'100'}},res=>{res.resume();resolve(res.statusCode);});req.on('error',reject);req.write('{');});assert.equal(status,408);
  const socket=net.connect(f.bridge.port,'127.0.0.1');socket.on('error',error=>assert.equal(error.code,'ECONNRESET'));await new Promise(resolve=>socket.once('connect',resolve));
  const disconnected=new Promise(resolve=>socket.once('close',resolve));await Promise.all([f.bridge.close(),f.bridge.close(),disconnected]);assert.equal(socket.destroyed,true);
});
test('HTTP socket disconnect does not cancel a tool or close its session',async t=>{
  let started,release,completed,toolSignal,commits=0;const began=new Promise(resolve=>started=resolve),gate=new Promise(resolve=>release=resolve),done=new Promise(resolve=>completed=resolve);
  const f=await httpFixture(t,{dispatch:async(call,{signal})=>{if(call.args.wait){toolSignal=signal;started();await gate;commits++;completed();}return {content:[{type:'text',text:call.agent}]};}});
  const initialized=await f.post(initialize(1)),id=initialized.headers.get('mcp-session-id');
  const req=https.request(f.bridge.url,{method:'POST',ca:f.cert,servername:'localhost',headers:{Authorization:`Bearer ${f.token}`,'Content-Type':'application/json',Accept:'application/json, text/event-stream','mcp-session-id':id,'mcp-protocol-version':'2025-11-25'}},res=>res.resume());req.on('error',()=>{});
  req.end(JSON.stringify({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'get_context',arguments:{wait:true}}}));await began;
  const disconnected=new Promise(resolve=>req.once('close',resolve));req.destroy();await disconnected;
  assert.equal((await f.post({jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'get_context',arguments:{}}},{'mcp-session-id':id,'mcp-protocol-version':'2025-11-25'})).status,200);
  assert.equal(toolSignal.aborted,false);release();await done;assert.equal(commits,1);
});

test('DELETE and document reset reclaim every pending request admission slot',{timeout:10000},async t=>{
  const exchanges=new Set(),original=StreamableHTTPServerTransport.prototype.handleRequest;
  t.mock.method(StreamableHTTPServerTransport.prototype,'handleRequest',function(...args){const pending=original.apply(this,args);exchanges.add(pending);void pending.then(()=>exchanges.delete(pending),()=>exchanges.delete(pending));return pending;});
  let entered=0,ready,release;
  const gate=new Promise(resolve=>release=resolve);
  const f=await httpFixture(t,{limits:{requests:2},dispatch:async(call,{signal})=>{
    if(call.args.wait){if(++entered===2)ready();await gate;assert.equal(signal.aborted,true);}
    return {content:[{type:'text',text:call.agent}]};
  }});
  for(const action of ['DELETE','reset']){
    entered=0;const began=new Promise(resolve=>ready=resolve),{client,transport}=await f.connect();
    const pending=Promise.allSettled([client.callTool({name:'get_context',arguments:{wait:true}}),client.callTool({name:'get_context',arguments:{wait:true}})]);
    await began;
    if(action==='DELETE')assert.equal((await f.post(undefined,{'mcp-session-id':transport.sessionId,'mcp-protocol-version':'2025-11-25'},'DELETE')).status,200);
    else await f.bridge.resetSessions();
    await pending;await Promise.all([...exchanges]);assert.equal(exchanges.size,0);
    // Reinitialize while the original dispatchers remain stalled, then use the full budget again.
    const next=await f.connect();
    entered=0;const restarted=new Promise(resolve=>ready=resolve);
    const nextPending=Promise.allSettled([next.client.callTool({name:'get_context',arguments:{wait:true}}),next.client.callTool({name:'get_context',arguments:{wait:true}})]);
    await restarted;await f.bridge.resetSessions();await nextPending;await Promise.all([...exchanges]);assert.equal(exchanges.size,0);
  }
  release();
});
test('a long-lived HTTP session reclaims successful SDK response streams',async t=>{
  const transports=new Set(),original=StreamableHTTPServerTransport.prototype.handleRequest;
  t.mock.method(StreamableHTTPServerTransport.prototype,'handleRequest',function(...args){transports.add(this);return original.apply(this,args);});
  const f=await httpFixture(t),{client}=await f.connect();
  const expectedNames=(await sourceTools()).map(tool=>tool.name);
  for(let i=0;i<200;i++)assert.deepEqual((await client.listTools()).tools.map(tool=>tool.name),expectedNames);
  assert.equal(transports.size,1);
  // Read pinned SDK bookkeeping to detect leaks; production never modifies SDK internals.
  for(const transport of transports){
    const state=transport._webStandardTransport;
    assert.equal(state._streamMapping.size,0);assert.equal(state._requestToStreamMapping.size,0);assert.equal(state._requestResponseMap.size,0);
  }
});
test('TCP admission bounds unauthenticated stalled TLS sockets and recovers capacity',async t=>{
  const f=await httpFixture(t,{limits:{connections:2}}),sockets=[];
  const open=()=>new Promise((resolve,reject)=>{const socket=tls.connect({port:f.bridge.port,host:'127.0.0.1',ca:f.cert,servername:'localhost'});sockets.push(socket);socket.once('secureConnect',()=>resolve(socket));socket.once('error',reject);});
  t.after(()=>{for(const socket of sockets)socket.destroy();});
  const first=await open(),second=await open();
  first.write('GET /mcp HTTP/1.1\r\n');second.write('GET /mcp HTTP/1.1\r\n');
  const overflow=net.connect(f.bridge.port,'127.0.0.1');sockets.push(overflow);overflow.on('error',error=>assert.equal(error.code,'ECONNRESET'));
  await new Promise(resolve=>overflow.once('close',resolve));assert.equal(overflow.destroyed,true);
  const closed=Promise.all([first,second].map(socket=>new Promise(resolve=>socket.once('close',resolve))));first.destroy();second.destroy();await closed;
  assert.equal((await f.post(initialize(1))).status,200);
});

test('runtime discovery excludes credentials and retires legacy bearer on migration, including failed listen',async t=>{
  for(const legacyDescriptor of [true,false]){
    const dir=await fs.mkdtemp(path.join(os.tmpdir(),'omc-migration-')),file=path.join(dir,'mcp-runtime.json'),oldToken='a'.repeat(64),listener=net.createServer();
    let bridge;t.after(async()=>{await bridge?.close();await new Promise(resolve=>listener.close(resolve));await fs.rm(dir,{recursive:true,force:true});});
    await fs.writeFile(path.join(dir,'mcp-token'),oldToken,{mode:0o600});
    await new Promise(resolve=>listener.listen(0,'127.0.0.1',resolve));const port=listener.address().port;
    if(legacyDescriptor){await fs.writeFile(file,JSON.stringify({port,token:oldToken,pid:1}),{mode:0o600});await fs.writeFile(path.join(dir,'mcp-token-v2'),oldToken,{mode:0o600});}
    await assert.rejects(startMcpBridge({dir,port,tools:[],dispatch:async()=>({content:[]})}),{code:'EADDRINUSE'});
    await assert.rejects(fs.readFile(file),{code:'ENOENT'});
    const token=await fs.readFile(path.join(dir,'mcp-token-v2'),'utf8');assert.notEqual(token,oldToken);
    await new Promise(resolve=>listener.close(resolve));
    bridge=await startMcpBridge({dir,port,tools:[],dispatch:async()=>({content:[]})});
    const descriptor=JSON.parse(await fs.readFile(file,'utf8'));assert.equal(descriptor.version,2);assert.equal(Object.hasOwn(descriptor,'token'),false);
    // The pre-TLS relay rejects this shape before its HTTP fetch because token is absent.
    assert.throws(()=>{if(!Number.isInteger(descriptor.port)||descriptor.port<1||descriptor.port>65535||typeof descriptor.token!=='string')throw Error('Invalid local MCP runtime');},/Invalid local MCP runtime/);
    const fetch=createMcpFetch(await fs.readFile(descriptor.certFile,'utf8')),headers={Accept:'application/json, text/event-stream','Content-Type':'application/json'};
    assert.equal((await fetch(bridge.url,{method:'POST',headers:{...headers,Authorization:`Bearer ${oldToken}`},body:JSON.stringify(initialize(1))})).status,403);
    assert.equal((await fetch(bridge.url,{method:'POST',headers:{...headers,Authorization:`Bearer ${token}`},body:JSON.stringify(initialize(1))})).status,200);
    await bridge.close();bridge=await startMcpBridge({dir,port,tools:[],dispatch:async()=>({content:[]})});
    assert.equal(await fs.readFile(path.join(dir,'mcp-token-v2'),'utf8'),token);
  }
});
