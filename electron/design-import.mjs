import {Worker} from 'node:worker_threads';
import {DESIGN_FILE_LIMIT as LIMIT} from '../core/capacity.mjs';
let pending=0;
/** Kiwi schema compilation stays outside the renderer CSP; untrusted decoders have a deadline. */
export async function readDesignFile(bytes,format){
  if(!(bytes instanceof Uint8Array)||!bytes.length||bytes.length>LIMIT||!['fig','sketch'].includes(format))throw Error('Invalid design file (256 MiB maximum)');
  if(pending>=1)throw Error('Finish the current design import first');
  pending++;
  try{return await new Promise((resolve,reject)=>{
    // Transfer a dedicated copy; detaching an IPC/caller-owned view would be a
    // surprising mutation, and Buffer.slice() may share its backing allocation.
    const input=Uint8Array.from(bytes);
    const worker=new Worker(new URL('./design-import-worker.mjs',import.meta.url),{workerData:{bytes:input,format},transferList:[input.buffer],execArgv:[],resourceLimits:{maxOldGenerationSizeMb:1536,maxYoungGenerationSizeMb:32}});
    let finished=false;
    const finish=async(error,result)=>{
      if(finished)return;finished=true;clearTimeout(timer);
      try{await worker.terminate();}catch{}
      if(error)reject(error);else resolve(result);
    };
    const timer=setTimeout(()=>{void finish(Error('Design import timed out after 30 seconds'));},30000);
    worker.once('message',result=>{void finish(result?.error?Error(result.error):null,result);});
    worker.once('error',error=>{void finish(error);});
    worker.once('exit',code=>{void finish(Error(`Design import worker stopped (${code})`));});
  });}finally{pending--;}
}
