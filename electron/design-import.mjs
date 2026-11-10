import {Worker} from 'node:worker_threads';
import {DESIGN_FILE_LIMIT as LIMIT} from '../core/capacity.mjs';
let pending=0;
/** Kiwi schema compilation stays outside the renderer CSP; untrusted decoders have a deadline. */
export async function readDesignFile(bytes,format){
  if(!(bytes instanceof Uint8Array)||!bytes.length||bytes.length>LIMIT||!['fig','sketch'].includes(format))throw Error('Invalid design file (256 MiB maximum)');
  if(pending>=1)throw Error('Finish the current design import first');
  pending++;
  try{return await new Promise((resolve,reject)=>{
    const worker=new Worker(new URL('./design-import-worker.mjs',import.meta.url),{workerData:{bytes,format},execArgv:[],resourceLimits:{maxOldGenerationSizeMb:1536,maxYoungGenerationSizeMb:32}});
    const timer=setTimeout(()=>{void worker.terminate();reject(Error('Design import timed out after 30 seconds'));},30000);
    worker.once('message',result=>{clearTimeout(timer);void worker.terminate();if(result.error)reject(Error(result.error));else resolve(result);});
    worker.once('error',error=>{clearTimeout(timer);reject(error);});
    worker.once('exit',code=>{clearTimeout(timer);reject(Error(`Design import worker stopped (${code})`));});
  });}finally{pending--;}
}
