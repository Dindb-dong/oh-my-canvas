import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
export async function startMcpBridge({dir,dispatch}) {
  const token=randomBytes(32).toString('hex');
  const server=http.createServer(async(req,res)=>{
    const reply=(status,value)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(value));};
    const auth=req.headers.authorization || '', expected=`Bearer ${token}`;
    if(req.headers.origin || !['127.0.0.1','localhost'].includes((req.headers.host||'').split(':')[0]) || Buffer.byteLength(auth)!==Buffer.byteLength(expected) || !timingSafeEqual(Buffer.from(auth),Buffer.from(expected))) return reply(403,{error:'Forbidden'});
    if(req.method!=='POST'||req.url!=='/rpc') return reply(404,{error:'Not found'});
    try {
      const chunks=[];let length=0;
      for await(const chunk of req){length+=chunk.length;if(length>1024*1024){reply(413,{error:'Request too large'});req.destroy();return;}chunks.push(chunk);}
      const call=JSON.parse(Buffer.concat(chunks).toString());
      if(typeof call.name!=='string'||call.name.length>80)throw Error('Invalid tool');
      reply(200,await dispatch(call));
    } catch(e){if(!res.headersSent)reply(400,{error:e.message});}
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const info={port:server.address().port,token,pid:process.pid};
  const file=path.join(dir,'mcp-runtime.json');
  await fs.mkdir(dir,{recursive:true});await fs.writeFile(file,JSON.stringify(info),{mode:0o600});await fs.chmod(file,0o600);
  return {file,port:info.port,async close(){await new Promise(r=>server.close(r));await fs.rm(file,{force:true});}};
}
