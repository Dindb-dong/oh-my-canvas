import {parentPort,workerData} from 'node:worker_threads';
import {importDesignFile} from '../dist/design-import.mjs';
try{
  const result=importDesignFile(workerData.bytes,workerData.format,{binaryAssets:true});
  const buffers=[...new Set((result.blobs??[]).map(blob=>blob.bytes.buffer))];
  parentPort.postMessage(result,buffers);
}
catch(error){parentPort.postMessage({error:error.message});}
