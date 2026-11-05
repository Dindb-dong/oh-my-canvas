#!/usr/bin/env node
import {createMcpServer} from '../electron/mcp-server.mjs';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {TOOLS} from '../dist/tool-defs.mjs';
import {createMcpFetch} from '../core/mcp-fetch.mjs';
const i=process.argv.indexOf('--runtime');
const defaultDir=process.platform==='darwin'?path.join(os.homedir(),'Library/Application Support/oh-my-canvas'):process.platform==='win32'?path.join(process.env.APPDATA||os.homedir(),'oh-my-canvas'):path.join(process.env.XDG_CONFIG_HOME||path.join(os.homedir(),'.config'),'oh-my-canvas');
const file=path.resolve(i>=0?process.argv[i+1]:path.join(process.env.OMC_DATA_DIR||defaultDir,'mcp-runtime.json'));
let connection;
async function closeConnection(entry) {
  if(!entry)return;
  let timer;
  try {await Promise.race([entry.ready.then(()=>entry.transport.terminateSession()).catch(()=>{}),new Promise(resolve=>{timer=setTimeout(resolve,1000);})]);}
  finally {clearTimeout(timer);await entry.client.close().catch(()=>{});}
}
async function session() {
  const {version,port,pid,certFile}=JSON.parse(await readFile(file,'utf8'));
  if(version!==2||!Number.isInteger(port)||port<1||port>65535||!Number.isSafeInteger(pid)||pid<1||typeof certFile!=='string'||path.resolve(certFile)!==path.join(path.dirname(file),'mcp-cert.pem'))throw Error('Invalid local MCP runtime; restart the updated desktop app');
  const [token,cert]=await Promise.all([readFile(path.join(path.dirname(file),'mcp-token-v2'),'utf8'),readFile(certFile,'utf8')]);
  if(!/^[a-f0-9]{64}$/.test(token))throw Error('Invalid local MCP token');
  const signature=JSON.stringify({port,pid,token,cert});
  if(!connection||connection.signature!==signature) {
    const previous=connection,client=new Client({name:'oh-my-canvas-stdio',version:'0.1.0'},{capabilities:{}});
    const transport=new StreamableHTTPClientTransport(new URL(`https://127.0.0.1:${port}/mcp`),{fetch:createMcpFetch(cert),requestInit:{headers:{Authorization:`Bearer ${token}`}},reconnectionOptions:{maxRetries:0}});
    const entry={signature,client,transport,ready:null};
    connection=entry;
    entry.ready=Promise.resolve().then(async()=>{await closeConnection(previous);await client.connect(transport,{timeout:65000});});
  }
  const entry=connection;
  try {await entry.ready;return entry;}
  catch(error){if(connection===entry)connection=undefined;await entry.client.close().catch(()=>{});throw error;}
}
const server=createMcpServer({tools:TOOLS,agent:'stdio-relay',dispatch:async(call,{signal})=>{
  signal.throwIfAborted();
  const entry=await session();signal.throwIfAborted();
  try {
    return await entry.client.callTool({name:call.name,arguments:call.args,...call.context?.idempotencyKey?{_meta:{'oh-my-canvas/idempotency-key':call.context.idempotencyKey}}:{}},undefined,{signal,timeout:65000});
  }catch(error){
    if(error.code===404){if(connection===entry)connection=undefined;await closeConnection(entry);}
    throw error;
  }
}});
async function stop(){const previous=connection;connection=undefined;await closeConnection(previous);await server.close();}
process.stdin.once('end',()=>{void stop();});
server.connect(new StdioServerTransport()).catch(error=>{process.stderr.write(error.message+'\n');process.exitCode=1;});
