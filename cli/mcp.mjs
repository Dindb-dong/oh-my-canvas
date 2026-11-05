#!/usr/bin/env node
import {createMcpServer} from '../electron/mcp-server.mjs';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {TOOLS} from '../dist/tool-defs.mjs';
const i=process.argv.indexOf('--runtime');
const defaultDir=process.platform==='darwin'?path.join(os.homedir(),'Library/Application Support/oh-my-canvas'):process.platform==='win32'?path.join(process.env.APPDATA||os.homedir(),'oh-my-canvas'):path.join(process.env.XDG_CONFIG_HOME||path.join(os.homedir(),'.config'),'oh-my-canvas');
const file=i>=0?process.argv[i+1]:path.join(process.env.OMC_DATA_DIR||defaultDir,'mcp-runtime.json');
const agent=`mcp-stdio-${randomUUID()}`;
const server=createMcpServer({tools:TOOLS,agent,dispatch:async(call,{signal})=>{
    const {port,token}=JSON.parse(await readFile(file,'utf8'));
    if(!Number.isInteger(port)||port<1||port>65535||typeof token!=='string')throw Error('Invalid local MCP runtime');
    const r=await fetch(`http://127.0.0.1:${port}/rpc`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify(call),signal:AbortSignal.any([signal,AbortSignal.timeout(65000)])});
    const result=await r.json();if(!r.ok)throw Error(result.error||'Local bridge rejected request');return result;
}});
server.connect(new StdioServerTransport()).catch(error=>{process.stderr.write(error.message+'\n');process.exitCode=1;});
