import {test} from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import http from 'node:http';
import {randomBytes,randomUUID} from 'node:crypto';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {StreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {createMcpServer} from '../electron/mcp-server.mjs';
import {loadMcpIdentity} from '../core/mcp-tls.mjs';
import {createMcpFetch} from '../core/mcp-fetch.mjs';

async function identity(t) {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'omc-mcp-tls-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  return {dir,...await loadMcpIdentity(dir)};
}
async function listen(server,t,port=0) {
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  return `https://127.0.0.1:${server.address().port}`;
}
test('MCP TLS identity is private, stable across restart and rejects corruption',async t=>{
  const original=await identity(t),reopened=await loadMcpIdentity(original.dir);
  assert.equal(reopened.key,original.key);assert.equal(reopened.cert,original.cert);assert.equal(reopened.certFile,original.certFile);
  for(const file of ['mcp-identity.json','mcp-cert.pem'])assert.equal((await fs.stat(path.join(original.dir,file))).mode&0o777,0o600);
  assert.deepEqual((await fs.readdir(original.dir)).sort(),['mcp-cert.pem','mcp-identity.json']);
  const other=await identity(t);
  await fs.writeFile(path.join(original.dir,'mcp-identity.json'),JSON.stringify({key:other.key,cert:original.cert}));
  await assert.rejects(loadMcpIdentity(original.dir),/Invalid or expired MCP TLS identity/);
  assert.equal(await fs.readFile(original.certFile,'utf8'),original.cert);
});
test('official SDK authenticates pinned HTTPS identity and consumes POST SSE responses',async t=>{
  const keys=await identity(t),token=randomBytes(32).toString('hex');
  const transport=new StreamableHTTPServerTransport({sessionIdGenerator:()=>randomUUID(),enableJsonResponse:false});
  const mcp=createMcpServer({tools:[{name:'get_context',inputSchema:{type:'object'}}],agent:'tls-proof',dispatch:async call=>({content:[{type:'text',text:call.agent}]})});
  await mcp.connect(transport);t.after(()=>mcp.close());
  let authorized=0;
  const url=await listen(https.createServer(keys,(req,res)=>{
    if(req.headers.authorization!==`Bearer ${token}`){res.writeHead(403);res.end();return;}
    authorized++;
    if(req.method==='GET'){res.writeHead(405);res.end();return;}
    void transport.handleRequest(req,res).catch(error=>res.destroy(error));
  }),t);
  const client=new Client({name:'pinned-client',version:'1'},{capabilities:{}});t.after(()=>client.close());
  const connection=new StreamableHTTPClientTransport(new URL(url+'/mcp'),{fetch:createMcpFetch(keys.cert),requestInit:{headers:{Authorization:`Bearer ${token}`}}});
  await client.connect(connection);
  assert.equal((await client.listTools()).tools.length,1);
  assert.equal((await client.callTool({name:'get_context',arguments:{}})).content[0].text,'tls-proof');
  assert.ok(authorized>=3);
  await connection.terminateSession();
});
test('port takeover with an unrelated certificate cannot receive a pinned client bearer',async t=>{
  const trusted=await identity(t),imposter=await identity(t),token=randomBytes(32).toString('hex');let authorizationSeen=false;
  const server=https.createServer(imposter,(req,res)=>{authorizationSeen||=!!req.headers.authorization;res.end('{}');});
  const url=await listen(server,t),fetch=createMcpFetch(trusted.cert);
  await assert.rejects(fetch(url+'/mcp',{method:'POST',headers:{Authorization:`Bearer ${token}`},body:'{}'}));
  assert.equal(authorizationSeen,false);
});
test('plaintext port takeover cannot receive Authorization and redirects never forward it',async t=>{
  const keys=await identity(t),token=randomBytes(32).toString('hex');let authorizationSeen=false,forwarded=false;
  const plain=http.createServer((req,res)=>{authorizationSeen||=!!req.headers.authorization;res.end('{}');});
  plain.on('clientError',(_,socket)=>socket.destroy());
  const url=await listen(plain,t),fetch=createMcpFetch(keys.cert);
  await assert.rejects(fetch(url+'/mcp',{headers:{Authorization:`Bearer ${token}`}}));assert.equal(authorizationSeen,false);
  await assert.rejects(fetch(url.replace('https:','http:')+'/mcp',{headers:{Authorization:`Bearer ${token}`}}),/requires an authenticated loopback HTTPS/);
  const target=await listen(https.createServer(keys,(_,res)=>{forwarded=true;res.end('{}');}),t);
  const redirect=await listen(https.createServer(keys,(_,res)=>{res.writeHead(307,{Location:target});res.end();}),t);
  await assert.rejects(fetch(redirect,{headers:{Authorization:`Bearer ${token}`}}),/redirects are not allowed/);assert.equal(forwarded,false);
});
test('pinned HTTPS fetch cancels a response stream and rejects arbitrary hosts before sending',async t=>{
  const keys=await identity(t),controller=new AbortController();
  const url=await listen(https.createServer(keys,(_,res)=>{res.writeHead(200,{'Content-Type':'text/event-stream'});res.write('data: pending\n\n');}),t);
  const fetch=createMcpFetch(keys.cert),response=await fetch(url,{signal:controller.signal}),body=response.text();
  controller.abort();await assert.rejects(body);
  await assert.rejects(fetch('https://example.invalid/',{headers:{Authorization:'Bearer scratch'}}),/requires an authenticated loopback HTTPS/);
});
