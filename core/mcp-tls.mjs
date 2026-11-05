import {promises as fs} from 'node:fs';
import path from 'node:path';
import {createPrivateKey,createPublicKey,X509Certificate} from 'node:crypto';
import selfsigned from 'selfsigned';
import {atomicWrite} from './storage.mjs';

export async function loadMcpIdentity(dir) {
  const file=path.join(dir,'mcp-identity.json'),certFile=path.join(dir,'mcp-cert.pem');
  let identity;
  try {identity=JSON.parse(await fs.readFile(file,'utf8'));}
  catch(error){
    if(error.code!=='ENOENT')throw Error('Invalid MCP TLS identity; restore the private identity files or explicitly renew client trust');
    const pems=await selfsigned.generate([{name:'commonName',value:'Oh My Canvas local MCP'}],{days:365,keySize:2048,algorithm:'sha256',extensions:[
      {name:'basicConstraints',cA:true},
      {name:'keyUsage',digitalSignature:true,keyEncipherment:true,keyCertSign:true},
      {name:'extKeyUsage',serverAuth:true},
      {name:'subjectAltName',altNames:[{type:7,ip:'127.0.0.1'},{type:2,value:'localhost'}]},
    ]});
    identity={key:pems.private,cert:pems.cert};
    await atomicWrite(file,JSON.stringify(identity),{backup:false});
  }
  try {
    const certificate=new X509Certificate(identity.cert),key=createPrivateKey(identity.key),now=Date.now();
    if(!certificate.ca||!certificate.verify(certificate.publicKey)||!certificate.checkIP('127.0.0.1')||!certificate.checkHost('localhost')||now<Date.parse(certificate.validFrom)||now>=Date.parse(certificate.validTo)||!certificate.publicKey.export({type:'spki',format:'der'}).equals(createPublicKey(key).export({type:'spki',format:'der'})))throw Error('Invalid identity');
  }catch{throw Error('Invalid or expired MCP TLS identity; restore the private identity files or explicitly renew client trust');}
  await fs.chmod(file,0o600);
  try {if(await fs.readFile(certFile,'utf8')!==identity.cert)throw Error('MCP certificate does not match its private identity');}
  catch(error){if(error.code!=='ENOENT')throw error;await atomicWrite(certFile,identity.cert,{backup:false});}
  await fs.chmod(certFile,0o600);
  return {...identity,certFile};
}
