import https from 'node:https';
import {checkServerIdentity} from 'node:tls';
import {X509Certificate} from 'node:crypto';
import {Readable} from 'node:stream';

export function createMcpFetch(cert) {
  const fingerprint=new X509Certificate(cert).fingerprint256;
  return async(input,init)=>{
    const request=new Request(input,init),url=new URL(request.url);
    if(url.protocol!=='https:'||!['127.0.0.1','localhost'].includes(url.hostname)||url.username||url.password)throw Error('MCP requires an authenticated loopback HTTPS endpoint');
    request.signal.throwIfAborted();
    return new Promise((resolve,reject)=>{
      const outgoing=https.request(url,{method:request.method,headers:Object.fromEntries(request.headers),signal:request.signal,ca:cert,agent:false,rejectUnauthorized:true,checkServerIdentity:(hostname,peer)=>checkServerIdentity(hostname,peer)||(peer.fingerprint256===fingerprint?undefined:Error('MCP server certificate changed'))},incoming=>{
        if(incoming.statusCode>=300&&incoming.statusCode<400){incoming.destroy();reject(Error('MCP redirects are not allowed'));return;}
        const headers=new Headers();
        for(let i=0;i<incoming.rawHeaders.length;i+=2)headers.append(incoming.rawHeaders[i],incoming.rawHeaders[i+1]);
        resolve(new Response([204,205,304].includes(incoming.statusCode)||request.method==='HEAD'?null:Readable.toWeb(incoming),{status:incoming.statusCode,statusText:incoming.statusMessage,headers}));
      });
      outgoing.on('error',reject);
      if(request.body){const body=Readable.fromWeb(request.body);body.on('error',error=>outgoing.destroy(error));body.pipe(outgoing);outgoing.on('close',()=>body.destroy());}
      else outgoing.end();
    });
  };
}
