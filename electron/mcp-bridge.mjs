import https from 'node:https';
import {randomBytes,randomUUID,timingSafeEqual} from 'node:crypto';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {StreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {isInitializeRequest} from '@modelcontextprotocol/sdk/types.js';
import {atomicWrite} from '../core/storage.mjs';
import {createMcpServer} from './mcp-server.mjs';
import {loadMcpIdentity} from '../core/mcp-tls.mjs';
export const MCP_PORT=47831;
export const MCP_LIMITS=Object.freeze({sessions:32,requests:8,connections:64,bodyBytes:1024*1024,idleMs:30*60*1000,bodyMs:10000,requestMs:63000});
export async function startMcpBridge({dir,dispatch,endSession=()=>{},port=MCP_PORT,tools,limits={}}) {
  const budget={...MCP_LIMITS,...limits};
  const {key,cert,certFile}=await loadMcpIdentity(dir);
  if(!Number.isInteger(port)||port<0||port>65535)throw Error('Invalid MCP port');
  const tokenFile=path.join(dir,'mcp-token-v2'),file=path.join(dir,'mcp-runtime.json');
  let legacyCredential=false;
  try {const previous=JSON.parse(await fs.readFile(file,'utf8'));legacyCredential=previous!==null&&typeof previous==='object'&&Object.hasOwn(previous,'token');}
  catch(e){if(e.code!=='ENOENT')throw e;}
  // Invalidate legacy relay discovery even when the new listener cannot start.
  await fs.rm(file,{force:true});
  let token;
  if(legacyCredential){token=randomBytes(32).toString('hex');await atomicWrite(tokenFile,token,{backup:false});}
  else try {token=await fs.readFile(tokenFile,'utf8');if(!/^[a-f0-9]{64}$/.test(token))throw Error('Invalid local MCP token');await fs.chmod(tokenFile,0o600);}
  catch(e){if(e.code!=='ENOENT')throw e;token=randomBytes(32).toString('hex');await atomicWrite(tokenFile,token,{backup:false});}
  const sessions=new Map(),legacy=new Map(),controllers=new Set(),sockets=new Set();
  let accepting=true,active=0,reading=0,actualPort,closing;
  const stopAccepting=()=>{accepting=false;for(const controller of controllers)controller.abort(Error('MCP server is closing'));};
  async function release(session) {
    if(session.closed)return;
    session.closed=true;sessions.delete(session.id);
    for(const controller of session.controllers)controller.abort(Error('MCP session ended'));
    // Finish pending exchanges before the SDK closes streams and suppresses late replies.
    await Promise.allSettled([...session.requests].map(id=>session.transport.send({jsonrpc:'2.0',id,error:{code:-32000,message:'MCP session ended; inspect the document before retrying'}})));
    for(const releaseSlot of session.slots)releaseSlot();session.slots.clear();
    await Promise.allSettled([Promise.resolve().then(()=>endSession(session.agent)),session.server?.close()]);
  }
  async function invoke(call,{signal}={},session) {
    const controller=new AbortController(),abort=()=>controller.abort(signal.reason);
    if(signal?.aborted)abort();else signal?.addEventListener('abort',abort,{once:true});
    controllers.add(controller);session?.controllers.add(controller);
    let timer;
    try {
      const aborted=new Promise((_,reject)=>{const fail=()=>reject(controller.signal.reason);controller.signal.addEventListener('abort',fail,{once:true});if(controller.signal.aborted)fail();});
      timer=setTimeout(()=>controller.abort(new DOMException('Editor tool timed out; inspect the document before retrying','TimeoutError')),budget.requestMs);
      return await Promise.race([Promise.resolve().then(()=>{controller.signal.throwIfAborted();return dispatch(call,{signal:controller.signal});}),aborted]);
    }finally{clearTimeout(timer);controllers.delete(controller);session?.controllers.delete(controller);signal?.removeEventListener('abort',abort);}
  }
  const server=https.createServer({key,cert,handshakeTimeout:budget.bodyMs},async(req,res)=>{
    const reply=(status,value)=>{if(res.headersSent||res.destroyed)return;res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(value));};
    const auth=req.headers.authorization||'',expected=`Bearer ${token}`;
    if(req.headers.origin!==undefined||![`127.0.0.1:${actualPort}`,`localhost:${actualPort}`].includes(req.headers.host)||Buffer.byteLength(auth)!==Buffer.byteLength(expected)||!timingSafeEqual(Buffer.from(auth),Buffer.from(expected)))return reply(403,{error:'Forbidden'});
    if(!['/mcp','/rpc'].includes(req.url))return reply(404,{error:'Not found'});
    if(!accepting)return reply(503,{error:'MCP server is closing'});
    if(req.url==='/mcp'&&!['POST','DELETE'].includes(req.method)){res.setHeader('Allow','POST, DELETE');return reply(405,{error:'Method not allowed'});}
    if(req.url==='/rpc'&&req.method!=='POST')return reply(405,{error:'Method not allowed'});
    if(reading>=budget.requests+8)return reply(429,{error:'Too many incoming MCP requests'});
    reading++;
    let bodyTimer,session,created=false,counted=false,readingBody=true,releaseSlot,requestId;
    try {
      let body;
      if(req.method==='POST') {
        const chunks=[];let length=0;
        body=await new Promise((resolve,reject)=>{
          const clean=()=>{clearTimeout(bodyTimer);req.removeListener('data',data);req.removeListener('end',end);req.removeListener('error',error);};
          const error=e=>{clean();reject(e);};
          const fail=(message,status)=>{clean();req.resume();res.setHeader('Connection','close');res.once('finish',()=>req.destroy());const e=Error(message);e.status=status;reject(e);};
          const data=chunk=>{length+=chunk.length;if(length>budget.bodyBytes)return fail('Request too large',413);chunks.push(chunk);};
          const end=()=>{clean();try{resolve(JSON.parse(Buffer.concat(chunks).toString()));}catch{fail('Invalid JSON',400);}};
          bodyTimer=setTimeout(()=>fail('Request body timed out',408),budget.bodyMs);
          req.on('data',data);req.on('end',end);req.on('error',error);
        });
      }
      reading--;readingBody=false;
      const control=req.method==='DELETE'||(req.url==='/mcp'&&body?.method==='notifications/cancelled');
      if(!control){if(active>=budget.requests)return reply(429,{error:'Too many pending MCP requests'});active++;counted=true;}
      if(!accepting)return reply(503,{error:'MCP server is closing'});
      if(req.url==='/rpc') {
        if(!body||typeof body.name!=='string'||body.name.length>80||typeof body.agent!=='string'||!/^mcp-stdio-[a-f0-9-]{36}$/.test(body.agent))return reply(400,{error:'Invalid legacy tool call'});
        if(!legacy.has(body.agent)&&sessions.size+legacy.size>=budget.sessions)return reply(429,{error:'Too many MCP sessions'});
        legacy.set(body.agent,Date.now());
        return reply(200,await invoke(body));
      }
      const id=req.headers['mcp-session-id'];
      if(id){session=sessions.get(id);if(!session)return reply(404,{error:'MCP session not found'});}
      else {
        if(req.method!=='POST'||!isInitializeRequest(body))return reply(400,{error:'Initialize an MCP session first'});
        if(sessions.size+legacy.size>=budget.sessions)return reply(429,{error:'Too many MCP sessions'});
        session={id:randomUUID(),agent:`mcp-http-${randomUUID()}`,controllers:new Set(),slots:new Set(),requests:new Set(),touched:Date.now(),closed:false};
        const transport=new StreamableHTTPServerTransport({sessionIdGenerator:()=>session.id,enableJsonResponse:false,onsessionclosed:()=>release(session),maxRequestBodySize:budget.bodyBytes});
        session.transport=transport;sessions.set(session.id,session);created=true;
        session.server=createMcpServer({tools:tools??(await import('../dist/tool-defs.mjs')).TOOLS,agent:session.agent,onCancel:id=>{
          // The SDK suppresses cancelled replies; settle its response stream to release request state.
          void transport.send({jsonrpc:'2.0',id,error:{code:-32800,message:'Request cancelled; inspect the document before retrying'}}).catch(()=>{});
        },dispatch:(call,extra)=>invoke(call,extra,session)});
        if(session.closed||!accepting){await session.server.close();throw Error('MCP session ended during initialization');}
        session.server.onclose=()=>{void release(session);};
        await session.server.connect(transport);
      }
      session.touched=Date.now();
      releaseSlot=()=>{if(counted){active--;counted=false;}session.slots.delete(releaseSlot);};
      if(counted)session.slots.add(releaseSlot);
      if(body?.method&&(typeof body.id==='number'||typeof body.id==='string')){requestId=body.id;session.requests.add(requestId);}
      await session.transport.handleRequest(req,res,body);
      if(created&&!session.transport.sessionId)await release(session);
    }catch(e){reply(e.status??400,{error:e.message});if(created&&session)await release(session);}
    finally{clearTimeout(bodyTimer);releaseSlot?.();if(requestId!==undefined)session?.requests.delete(requestId);if(counted)active--;if(readingBody)reading--;}
  });
  server.maxConnections=budget.connections;
  server.requestTimeout=budget.bodyMs;server.headersTimeout=budget.bodyMs;server.timeout=budget.requestMs+budget.bodyMs;
  server.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});
  const sweep=setInterval(()=>{
    const cutoff=Date.now()-budget.idleMs;
    for(const session of sessions.values())if(!session.controllers.size&&session.touched<cutoff)void release(session);
    for(const [agent,touched] of legacy)if(touched<cutoff){legacy.delete(agent);void Promise.resolve().then(()=>endSession(agent)).catch(()=>{});}
  },Math.min(budget.idleMs,60000));sweep.unref();
  async function resetSessions() {
    await Promise.all([...sessions.values()].map(release));
    const agents=[...legacy.keys()];legacy.clear();await Promise.allSettled(agents.map(agent=>Promise.resolve().then(()=>endSession(agent))));
  }
  async function close() {
    if(closing)return closing;
    closing=(async()=>{
      stopAccepting();clearInterval(sweep);
      const stopped=new Promise(resolve=>server.close(resolve));
      for(const socket of sockets)socket.destroy();
      await Promise.allSettled([...sessions.values()].map(release));
      await Promise.allSettled([...legacy.keys()].map(agent=>Promise.resolve().then(()=>endSession(agent))));legacy.clear();
      await stopped;
      try{await fs.unlink(file);}catch(e){if(e.code!=='ENOENT'&&e.code!=='EISDIR'&&e.code!=='EPERM')throw e;}
    })();return closing;
  }
  try {
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
    actualPort=server.address().port;
    await atomicWrite(file,JSON.stringify({version:2,port:actualPort,pid:process.pid,certFile}),{backup:false});
  }catch(e){clearInterval(sweep);if(server.listening)await close();throw e;}
  return {file,certFile,port:actualPort,url:`https://127.0.0.1:${actualPort}/mcp`,stopAccepting,resumeAccepting(){if(!closing)accepting=true;},resetSessions,close};
}
