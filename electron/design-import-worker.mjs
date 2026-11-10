import {parentPort,workerData} from 'node:worker_threads';
import {importDesignFile} from '../dist/design-import.mjs';
try{parentPort.postMessage(importDesignFile(workerData.bytes,workerData.format));}
catch(error){parentPort.postMessage({error:error.message});}
