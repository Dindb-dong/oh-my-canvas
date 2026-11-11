import {persistDesignImport} from './document-assets.mjs';

const fail=message=>Object.assign(Error(message),{code:'invalid_import'});

/** Resolve once the first durable page is editable. The independently tracked
 * completion remains responsible for every later batch and an honest terminal
 * status. Losing/cancelling a worker never turns a partial import into success.
 */
export async function startProgressiveImport(bytes,format,{readDesignFile,store,manager,title,options={},onProgress=()=>{},afterFirstPaint=async()=>{}}){
  const controller=new AbortController(),consumer=new AbortController(),inFlight=new Set();
  const warnings=new Set();
  const rememberWarnings=values=>{
    if(values===undefined)return;
    if(!Array.isArray(values)||values.length>40||values.some(value=>typeof value!=='string'))throw fail('Invalid design import warnings');
    for(const value of values){
      if(warnings.size>=40)break;
      let message=value.slice(0,1024);
      if(value.length>1024&&/[\uD800-\uDBFF]$/.test(message))message=message.slice(0,-1);
      warnings.add(message.toWellFormed());
    }
  };
  let manifest,entry,completedPages=0,resolveFirst,rejectFirst,ownsHold=false,accepting=true,terminalError,consumerError;
  const first=new Promise((resolve,reject)=>{resolveFirst=resolve;rejectFirst=reject;});
  const abortConsumer=()=>consumer.abort(controller.signal.reason);
  controller.signal.addEventListener('abort',abortConsumer,{once:true});
  const cancel=()=>controller.abort(Error('Import stopped; the pages already loaded remain saved.'));
  const parentAbort=()=>controller.abort(options.signal.reason??Error('Import cancelled'));
  options.signal?.addEventListener('abort',parentAbort,{once:true});
  if(options.signal?.aborted)parentAbort();
  const status=(state,error,loadedPages=completedPages)=>({kind:format,state,totalPages:manifest.pages.length,loadedPages,pages:manifest.pages.map(({id,name})=>({id,name:String(name??'Untitled page').slice(0,1024)})),...(error?{error:String(error.message??error).slice(0,1024)}:{})});
  const drainConsumers=async()=>{while(inFlight.size)await Promise.allSettled([...inFlight]);};
  async function paint(entry){
    // Paint acknowledgement has no document mutation. Abort this wait promptly,
    // while create/append/save consumers themselves must finish before cleanup.
    const signal=consumer.signal;signal.throwIfAborted();let abort;
    const stopped=new Promise((resolve,reject)=>{abort=()=>reject(signal.reason);signal.addEventListener('abort',abort,{once:true});});
    try{await Promise.race([Promise.resolve().then(()=>{signal.throwIfAborted();return afterFirstPaint(entry);}),stopped]);}
    finally{signal.removeEventListener('abort',abort);}
  }
  const completion=Promise.resolve().then(async()=>{
    try{
      const result=await readDesignFile(bytes,format,{
        signal:controller.signal,
        onManifest(value){
          if(!accepting)throw terminalError??fail('Design import is no longer accepting pages');
          if(manifest||!Array.isArray(value?.pages)||!value.pages.length||value.pages.length>100||new Set(value.pages.map(p=>p.id)).size!==value.pages.length)throw fail('Invalid design page manifest');
          for(const page of value.pages)if(typeof page.id!=='string'||!page.id||page.id.length>1024)throw fail('Invalid design page identity');
          manifest=value;onProgress({phase:'decoded',loadedPages:0,totalPages:value.pages.length});
        },
        onBatch(batch){
          if(!accepting)throw terminalError??fail('Design import is no longer accepting pages');
          if(inFlight.size)throw fail('Design pages arrived before the previous batch completed');
          const task=(async()=>{
            if(!manifest||!Array.isArray(batch?.pageIds)||batch.pageIds.length!==batch.document?.pages?.length)throw fail('Invalid design page batch');
            const expected=manifest.pages.slice(completedPages,completedPages+batch.pageIds.length).map(p=>p.id);
            if(JSON.stringify(expected)!==JSON.stringify(batch.pageIds)||JSON.stringify(batch.document.pages)!==JSON.stringify(batch.pageIds))throw fail('Design pages arrived out of order');
            consumer.signal.throwIfAborted();
            rememberWarnings(batch.warnings);
            const prepared=await persistDesignImport(batch,store);consumer.signal.throwIfAborted();
            const nextCount=completedPages+batch.pageIds.length;
            if(!entry){
              entry=await manager.create(title,prepared.document,{...options,signal:controller.signal,importStatus:status('loading',undefined,nextCount)});
              entry.holds=(entry.holds??0)+1;ownsHold=true;entry.cancelImport=cancel;entry.importSignal=consumer.signal;entry.importTask=completion;
              completedPages=nextCount;
              // A worker timeout can reject independently while create is still
              // saving/mounting. Claim its result, then observe the terminal cause
              // before exposing it as a successful first-page open.
              consumer.signal.throwIfAborted();
              resolveFirst({entry,completion,warnings:[...warnings]});
              await paint(entry);
            }else{
              await manager.appendPages(entry,prepared.document,status('loading',undefined,nextCount));
              completedPages=nextCount;
            }
            consumer.signal.throwIfAborted();
            onProgress({phase:'pages',loadedPages:completedPages,totalPages:manifest.pages.length,documentId:entry.record.id});
          })();
          inFlight.add(task);
          // A transport may stop awaiting the callback after its own deadline.
          // Keep both ownership and a rejection handler until consumption ends.
          void task.then(()=>inFlight.delete(task),error=>{inFlight.delete(task);consumerError??=error;});
          return task;
        },
      });
      accepting=false;await drainConsumers();
      if(consumerError)throw consumerError;
      consumer.signal.throwIfAborted();
      if(!entry||completedPages!==manifest.pages.length||!result.complete)throw fail('Design import ended before every page arrived');
      rememberWarnings(result.warnings);
      await manager.finishImport(entry,status('complete'),[...warnings]);
      onProgress({phase:'complete',loadedPages:completedPages,totalPages:manifest.pages.length,documentId:entry.record.id});
      return {...result,warnings:[...warnings],entry};
    }catch(error){
      // Do not turn a worker failure into a user cancellation merely because we
      // abort its pending paint/projection wait to finish the consumer lifetime.
      const terminalState=controller.signal.aborted?'cancelled':'failed';
      accepting=false;terminalError=error;consumer.abort(error);
      await drainConsumers();
      if(entry){
        // Replica publication may have succeeded before a later save failed.
        // Report the actual retained page count, without advancing a save ACK.
        completedPages=entry.record.replica.document.pages.length;
        try{await manager.finishImport(entry,status(terminalState,error),[...warnings]);}
        catch(saveError){error.saveError=saveError.message;}
      }
      // Rejection is harmless if the first page was already exposed. Otherwise
      // it must happen even when a late consumer has since acquired an entry.
      rejectFirst(error);
      onProgress({phase:terminalState,loadedPages:completedPages,totalPages:manifest?.pages.length??0,error:error.message,...entry?{documentId:entry.record.id}:{}});
      throw error;
    }finally{
      options.signal?.removeEventListener('abort',parentAbort);
      controller.signal.removeEventListener('abort',abortConsumer);
      if(entry){if(ownsHold)entry.holds--;entry.cancelImport=null;entry.importSignal=null;}
    }
  });
  void completion.catch(()=>{});
  return first;
}
