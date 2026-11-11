import {persistDesignImport} from './document-assets.mjs';

const fail=message=>Object.assign(Error(message),{code:'invalid_import'});

/** Resolve once the first durable page is editable. The independently tracked
 * completion remains responsible for every later batch and an honest terminal
 * status. Losing/cancelling a worker never turns a partial import into success.
 */
export async function startProgressiveImport(bytes,format,{readDesignFile,store,manager,title,options={},onProgress=()=>{},afterFirstPaint=async()=>{}}){
  const controller=new AbortController();let manifest,entry,completedPages=0,resolveFirst,rejectFirst;
  const first=new Promise((resolve,reject)=>{resolveFirst=resolve;rejectFirst=reject;});
  const cancel=()=>controller.abort(Error('Import stopped; the pages already loaded remain saved.'));
  const parentAbort=()=>controller.abort(options.signal.reason??Error('Import cancelled'));
  options.signal?.addEventListener('abort',parentAbort,{once:true});
  if(options.signal?.aborted)parentAbort();
  const status=(state,error)=>({kind:format,state,totalPages:manifest.pages.length,loadedPages:completedPages,pages:manifest.pages.map(({id,name})=>({id,name:String(name??'Untitled page').slice(0,1024)})),...(error?{error:String(error.message??error).slice(0,1024)}:{})});
  const completion=Promise.resolve().then(async()=>{
    try{
      const result=await readDesignFile(bytes,format,{
        signal:controller.signal,
        onManifest(value){
          if(manifest||!Array.isArray(value?.pages)||!value.pages.length||value.pages.length>100||new Set(value.pages.map(p=>p.id)).size!==value.pages.length)throw fail('Invalid design page manifest');
          for(const page of value.pages)if(typeof page.id!=='string'||!page.id||page.id.length>1024)throw fail('Invalid design page identity');
          manifest=value;onProgress({phase:'decoded',loadedPages:0,totalPages:value.pages.length});
        },
        async onBatch(batch){
          if(!manifest||!Array.isArray(batch?.pageIds)||batch.pageIds.length!==batch.document?.pages?.length)throw fail('Invalid design page batch');
          const expected=manifest.pages.slice(completedPages,completedPages+batch.pageIds.length).map(p=>p.id);
          if(JSON.stringify(expected)!==JSON.stringify(batch.pageIds)||JSON.stringify(batch.document.pages)!==JSON.stringify(batch.pageIds))throw fail('Design pages arrived out of order');
          controller.signal.throwIfAborted();
          const prepared=await persistDesignImport(batch,store);controller.signal.throwIfAborted();
          completedPages+=batch.pageIds.length;
          if(!entry){
            entry=await manager.create(title,prepared.document,{...options,signal:controller.signal,importStatus:status('loading')});
            entry.holds=(entry.holds??0)+1;entry.cancelImport=cancel;entry.importSignal=controller.signal;entry.importTask=completion;
            resolveFirst({entry,completion,warnings:prepared.warnings});
            await afterFirstPaint(entry);
          }else await manager.appendPages(entry,prepared.document,status('loading'));
          onProgress({phase:'pages',loadedPages:completedPages,totalPages:manifest.pages.length,documentId:entry.record.id});
        },
      });
      if(!entry||completedPages!==manifest.pages.length||!result.complete)throw fail('Design import ended before every page arrived');
      await manager.finishImport(entry,status('complete'));
      onProgress({phase:'complete',loadedPages:completedPages,totalPages:manifest.pages.length,documentId:entry.record.id});
      return {...result,entry};
    }catch(error){
      if(entry){
        // Replica publication may have succeeded before a later save failed.
        // Report the actual retained page count, without advancing a save ACK.
        completedPages=entry.record.replica.document.pages.length;
        try{await manager.finishImport(entry,status(controller.signal.aborted?'cancelled':'failed',error));}
        catch(saveError){error.saveError=saveError.message;}
      }else rejectFirst(error);
      onProgress({phase:controller.signal.aborted?'cancelled':'failed',loadedPages:completedPages,totalPages:manifest?.pages.length??0,error:error.message,...entry?{documentId:entry.record.id}:{}});
      throw error;
    }finally{
      options.signal?.removeEventListener('abort',parentAbort);
      if(entry){entry.holds--;entry.cancelImport=null;}
    }
  });
  void completion.catch(()=>{});
  return first;
}
