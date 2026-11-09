import {constants,promises as fs} from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';

export const MAX_EXPORT_BYTES=100*1024*1024;
export const MAX_INLINE_BYTES=512*1024;
const invalid=message=>Object.assign(Error(message),{code:'bad_args'});
async function destination(filePath,protectedDirectory,protectedDirectories=[]){
  if(typeof filePath!=='string'||!path.isAbsolute(filePath)||filePath.includes('\0'))throw invalid('filePath must be an absolute local path');
  const parent=await fs.realpath(path.dirname(filePath)),file=path.join(parent,path.basename(filePath));
  for(const directory of [protectedDirectory,...protectedDirectories].filter(Boolean)){const protectedRoot=await fs.realpath(directory);if(file===protectedRoot||file.startsWith(protectedRoot+path.sep))throw invalid('Use a path outside protected application files');}
  return file;
}
export async function readExplicitFile(filePath,{limit,protectedDirectory,signal}={}){
  const file=await destination(filePath,protectedDirectory);signal?.throwIfAborted();
  const handle=await fs.open(file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try{
    const stat=await handle.stat();if(!stat.isFile())throw invalid('Import requires a regular file');if(stat.size>limit)throw invalid(`Input exceeds ${limit} bytes`);
    const chunks=[];let length=0;
    while(length<=limit){signal?.throwIfAborted();const chunk=Buffer.allocUnsafe(Math.min(65536,limit+1-length)),{bytesRead}=await handle.read(chunk,0,chunk.length,null);if(!bytesRead)break;length+=bytesRead;if(length>limit)throw invalid(`Input exceeds ${limit} bytes`);chunks.push(chunk.subarray(0,bytesRead));}
    return Buffer.concat(chunks,length);
  }finally{await handle.close();}
}
export async function writeExplicitFile(filePath,bytes,{overwrite=false,protectedDirectory,protectedDirectories,signal}={}){
  if(!(bytes instanceof Uint8Array)||!bytes.byteLength||bytes.byteLength>MAX_EXPORT_BYTES)throw invalid('Invalid or oversized export');
  const file=await destination(filePath,protectedDirectory,protectedDirectories);signal?.throwIfAborted();
  let existing;try{existing=await fs.lstat(file);}catch(error){if(error.code!=='ENOENT')throw error;}
  if(existing&&(!existing.isFile()||existing.isSymbolicLink()))throw invalid('Export destination must be a regular file');
  if(existing&&!overwrite)throw Object.assign(Error('Destination already exists; set overwrite:true to replace it'),{code:'exists'});
  const temporary=path.join(path.dirname(file),`.omc-export-${randomUUID()}.tmp`);
  try{
    const handle=await fs.open(temporary,'wx',0o600);
    try{await handle.writeFile(bytes,{signal});await handle.sync();}finally{await handle.close();}
    signal?.throwIfAborted();
    if(overwrite)await fs.rename(temporary,file);
    else await fs.link(temporary,file);
    const directory=await fs.open(path.dirname(file),'r');try{await directory.sync();}catch(error){if(!['EINVAL','EPERM','EBADF'].includes(error.code))throw error;}finally{await directory.close();}
    return {filePath:file,bytes:bytes.byteLength};
  }finally{await fs.rm(temporary,{force:true});}
}
