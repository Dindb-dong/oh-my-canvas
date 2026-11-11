import {parentPort,workerData} from 'node:worker_threads';
import {importDesignFile,importDesignFileProgressively} from '../dist/design-import.mjs';

let eventId=0,pendingAck=null;
parentPort.on('message',message=>{
  if(message?.type==='ack'&&pendingAck&&message.eventId===pendingAck.id){
    const {resolve}=pendingAck;pendingAck=null;resolve();
  }
});
function publish(type,value){
  return new Promise((resolve,reject)=>{
    const id=++eventId;
    pendingAck={id,resolve};
    // Reused bitmaps keep their declaration, but only their first published
    // use carries bytes. The parent persists them before acknowledging.
    const buffers=[...new Set((value.blobs??[]).map(blob=>blob.bytes.buffer))];
    try{parentPort.postMessage({type,eventId:id,value},buffers);}
    catch(error){pendingAck=null;reject(error);}
  });
}
try{
  const options={binaryAssets:true,...workerData.batchLimits};
  if(workerData.progressive){
    const result=await importDesignFileProgressively(workerData.bytes,workerData.format,{
      ...options,onManifest:value=>publish('manifest',value),onBatch:value=>publish('batch',value),
    });
    parentPort.postMessage({type:'complete',value:result});
  }else{
    const result=importDesignFile(workerData.bytes,workerData.format,options);
    const buffers=[...new Set((result.blobs??[]).map(blob=>blob.bytes.buffer))];
    parentPort.postMessage({type:'complete',value:result},buffers);
  }
}catch(error){parentPort.postMessage({type:'error',error:{name:error.name,message:error.message}});}
