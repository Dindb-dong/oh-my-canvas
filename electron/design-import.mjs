import {Worker} from 'node:worker_threads';
import {DESIGN_FILE_LIMIT as LIMIT} from '../core/capacity.mjs';

const COMPUTE_TIMEOUT=30000,TOTAL_TIMEOUT=10*60*1000;
let pending=0;
const cancelled=signal=>signal?.reason instanceof Error?signal.reason:new DOMException('Design import cancelled','AbortError');

/** Kiwi decoding remains outside the renderer CSP. onBatch opts into ordered,
 * dependency-complete page delivery and returns a completion summary. Awaited
 * consumers are excluded from the 30 s compute budget, but the entire job is
 * bounded to ten minutes. Callbacks ACK by resolving after durable save.
 */
export async function readDesignFile(bytes,format,options={}){
  if(!(bytes instanceof Uint8Array)||!bytes.length||bytes.length>LIMIT||!['fig','sketch'].includes(format))throw Error('Invalid design file (256 MiB maximum)');
  const {onBatch,onManifest,signal}=options,progressive=typeof onBatch==='function';
  if(onBatch!==undefined&&!progressive||onManifest!==undefined&&typeof onManifest!=='function'||onManifest&&!progressive)throw Error('Invalid progressive design import callbacks');
  const computeTimeout=options.computeTimeoutMs??COMPUTE_TIMEOUT,totalTimeout=options.totalTimeoutMs??TOTAL_TIMEOUT;
  // Callers can request a stricter budget; production limits cannot be raised.
  if(!Number.isInteger(computeTimeout)||computeTimeout<1||computeTimeout>COMPUTE_TIMEOUT||!Number.isInteger(totalTimeout)||totalTimeout<1||totalTimeout>TOTAL_TIMEOUT)throw Error('Invalid design import deadline');
  const computeExpired=()=>Error(`Design import timed out after ${computeTimeout/1000} seconds of active processing`);
  if(signal?.aborted)throw cancelled(signal);
  if(pending>=1)throw Error('Finish the current design import first');
  pending++;
  try{return await new Promise((resolve,reject)=>{
    // Dedicated copy: never detach a caller-owned Buffer or IPC view.
    const input=Uint8Array.from(bytes);
    const worker=new Worker(new URL('./design-import-worker.mjs',import.meta.url),{
      workerData:{bytes:input,format,progressive,batchLimits:{batchPages:options.batchPages,batchObjects:options.batchObjects}},
      transferList:[input.buffer],execArgv:[],resourceLimits:{maxOldGenerationSizeMb:1536,maxYoungGenerationSizeMb:32},
    });
    let finished=false,handling=false,manifest=false,eventId=0,batches=0,completedPages=0;
    let remaining=computeTimeout,activeSince=0,computeTimer=null;
    const pageIds=[],knownPages=new Set();
    const stopCompute=()=>{
      if(computeTimer!==null){clearTimeout(computeTimer);computeTimer=null;remaining-=performance.now()-activeSince;}
    };
    const finish=async(error,result)=>{
      if(finished)return;finished=true;stopCompute();clearTimeout(totalTimer);signal?.removeEventListener('abort',abort);
      if(error){
        const original=error;error=Error(original.message,{cause:original});error.name=original.name;
        error.importProgress={acknowledgedBatches:batches,acknowledgedPageIds:[...pageIds],completedPages};
      }
      try{await worker.terminate();}catch{}
      if(error)reject(error);else resolve(result);
    };
    const startCompute=()=>{
      activeSince=performance.now();
      computeTimer=setTimeout(()=>{void finish(computeExpired());},Math.max(0,remaining));
    };
    const abort=()=>{void finish(cancelled(signal));};
    const totalTimer=setTimeout(()=>{void finish(Error('Design import exceeded its total lifetime'));},totalTimeout);
    signal?.addEventListener('abort',abort,{once:true});
    startCompute();
    worker.on('message',async message=>{
      if(finished)return;
      try{
        if(handling)throw Error('Design import worker sent a batch before acknowledgement');
        if(message?.type==='error'){
          const error=Error(message.error?.message??'Design import failed');error.name=message.error?.name??'Error';
          return void finish(error);
        }
        if(message?.type==='complete'){
          stopCompute();if(remaining<=0)throw computeExpired();
          if(progressive&&(!manifest||completedPages!==knownPages.size||message.value?.complete!==true||message.value?.pageCount!==completedPages))throw Error('Design import finished with missing pages');
          return void finish(null,message.value);
        }
        if(!progressive||!['manifest','batch'].includes(message?.type)||message.eventId!==eventId+1)throw Error('Invalid design import worker event');
        eventId=message.eventId;handling=true;stopCompute();
        if(remaining<=0)throw computeExpired();
        if(message.type==='manifest'){
          if(manifest||!Array.isArray(message.value?.pages)||!message.value.pages.length||message.value.pages.length>100||message.value.pageCount!==message.value.pages.length)throw Error('Invalid design import manifest');
          for(const [index,page] of message.value.pages.entries()){
            if(typeof page.id!=='string'||!page.id||page.index!==index||knownPages.has(page.id))throw Error('Invalid design import page order');
            knownPages.add(page.id);
          }
          manifest=true;await onManifest?.(message.value);
        }else{
          const batch=message.value,nextPages=batch?.pageIds;
          if(!manifest||batch?.sequence!==batches+1||!Array.isArray(nextPages)||!nextPages.length||batch.totalPages!==knownPages.size||batch.completedPages!==completedPages+nextPages.length||!Array.isArray(batch.document?.pages)||batch.document.pages.length!==nextPages.length)throw Error('Invalid design import batch');
          const ordered=[...knownPages];
          for(const [index,id] of nextPages.entries())if(id!==ordered[completedPages+index]||id!==batch.document.pages[index])throw Error('Invalid design import page order');
          await onBatch(batch);
          if(finished)return;
          batches++;completedPages+=nextPages.length;pageIds.push(...nextPages);
        }
        if(finished)return;
        handling=false;startCompute();worker.postMessage({type:'ack',eventId});
      }catch(error){void finish(error instanceof Error?error:Error(String(error)));}
    });
    worker.once('error',error=>{void finish(error);});
    worker.once('exit',code=>{void finish(Error(`Design import worker stopped (${code})`));});
  });}finally{pending--;}
}
