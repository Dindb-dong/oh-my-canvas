import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {readDesignFile} from '../electron/design-import.mjs';
import {persistDesignImport} from '../electron/document-assets.mjs';
import {Replica} from '../core/replica.mjs';
import {Store} from '../core/storage.mjs';
import {changesFromPatches} from '../core/document.mjs';

// One complete import and five steady edits on the same Replica. The source
// Replica and its speculative mirror are released before measuring reopen.
// Reports only counts, hashes and timings, never private design text.
const checkout=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const arg=name=>process.argv.find(value=>value.startsWith(`--${name}=`))?.slice(name.length+3);
const integer=(name,fallback,minimum)=>{
  const value=Number(arg(name)??fallback);
  if(!Number.isInteger(value)||value<minimum)throw Error(`Invalid --${name}`);
  return value;
};
const samples=integer('samples',5,1),warmups=integer('warmups',1,0);
const file=path.resolve(arg('file')??path.join(checkout,'fixtures/design-files/iOS-and-iPadOS-27.fig'));
const output=arg('output')&&path.resolve(arg('output'));
const format=path.extname(file).slice(1).toLowerCase();
const directory=await mkdtemp(path.join(os.tmpdir(),'omc-document-core-benchmark-'));
const progress=value=>process.stderr.write(JSON.stringify(value)+'\n');
const timed=async run=>{const started=performance.now();const value=await run();return {value,ms:performance.now()-started};};
const stats=values=>{
  const sorted=[...values].sort((a,b)=>a-b);
  return {medianMs:sorted[Math.floor(sorted.length/2)],p95Ms:sorted[Math.ceil(sorted.length*.95)-1],samplesMs:values};
};
async function importAndEdit(){
  const metrics=[],replicaMetrics=[],store=new Store(directory,{onMetric:event=>metrics.push(event)}),phases={};
  let replica,input=await readFile(file),result,prepared,document;
  try{
    if(input.subarray(0,64).toString().startsWith('version https://git-lfs.github.com/spec/'))throw Error('Resolve the Git LFS fixture before benchmarking');
    const fixture={sha256:createHash('sha256').update(input).digest('hex'),inputBytes:input.byteLength};
    progress({phase:'worker-import'});
    let imported=await timed(()=>readDesignFile(input,format));result=imported.value;input=null;phases.workerImportMs=imported.ms;imported=null;
    const worker=result.timings;
    fixture.blobBytes=(result.blobs??[]).reduce((sum,blob)=>sum+blob.bytes.byteLength,0);fixture.blobCount=result.blobs?.length??0;
    progress({phase:'persist-blobs',workerImportMs:phases.workerImportMs,blobCount:fixture.blobCount,blobBytes:fixture.blobBytes});
    prepared=await timed(()=>persistDesignImport(result,store));phases.persistBlobsMs=prepared.ms;fixture.warningCount=prepared.value.warnings.length;
    result=null;document=prepared.value.document;prepared=null;
    const counts=document.pages.map(id=>Object.keys(document.pagesById[id].objects).length),index=counts.indexOf(Math.max(...counts)),pageId=document.pages[index];
    const jsonStarted=performance.now();fixture.documentBytes=Buffer.byteLength(JSON.stringify(document));phases.documentJsonEncodeMs=performance.now()-jsonStarted;
    fixture.pageCount=document.pages.length;fixture.shapeCount=counts.reduce((a,b)=>a+b,0);fixture.pageShapeCounts=counts;
    const replicaStarted=performance.now();replica=new Replica({document,onMetric:event=>replicaMetrics.push(event)});phases.initialReplicaMs=performance.now()-replicaStarted;document=null;
    const initialValidation=replicaMetrics.at(-1);phases.initialDocumentValidationMs=initialValidation.documentMs;phases.initialStateEncodingMs=initialValidation.encodeStateMs;
    const record={id:randomUUID(),title:'Core benchmark',createdAt:new Date().toISOString(),replica};
    const checkpoint=await timed(()=>store.save(record));phases.initialCheckpointMs=checkpoint.ms;fixture.stateBytes=replica.state.byteLength;
    progress({phase:'rename',documentBytes:fixture.documentBytes,stateBytes:fixture.stateBytes,pageCount:fixture.pageCount,shapeCount:fixture.shapeCount});
    const edits=[];let firstRename,expectedName;
    for(let iteration=-warmups-1;iteration<samples;iteration++){
      const before=replica.document,page=before.pagesById[pageId],name='Benchmark page '+iteration;
      const after={...before,pagesById:{...before.pagesById,[pageId]:{...page,name}}},observation={};
      const translation=performance.now(),changes=changesFromPatches(before,after,[{path:['pagesById',pageId,'name'],old:page.name,value:name}]);observation.translationMs=performance.now()-translation;
      const metricStart=replicaMetrics.length,patchStarted=performance.now();replica.patch(changes,'Rename page');observation.replicaMs=performance.now()-patchStarted;
      const validation=replicaMetrics.slice(metricStart).find(event=>event.stage==='replica-validation');
      observation.documentValidationMs=validation.documentMs;observation.stateEncodingMs=validation.encodeStateMs;observation.sizeValidation=validation.sizeValidation;
      const saveStarted=performance.now();await store.save(record);observation.journalMs=performance.now()-saveStarted;
      observation.totalMs=observation.translationMs+observation.replicaMs+observation.journalMs;
      const journal=metrics.filter(event=>event.stage==='store-journal').at(-1);
      observation.changeBytes=Buffer.byteLength(JSON.stringify(changes));observation.updateBytes=journal.updateBytes;observation.journalBytes=journal.bytes;
      assert.equal(validation.incremental,true);assert.ok(observation.updateBytes<4096);assert.equal(replica.document.pagesById[pageId].name,name);
      expectedName=name;if(iteration===-warmups-1)firstRename=observation;else if(iteration>=0)edits.push(observation);
      progress({phase:'rename-complete',sample:iteration===-warmups-1?'first':iteration<0?'warmup':iteration+1,...observation});
    }
    return {recordId:record.id,pageId,expectedName,fixture,phases,worker,firstRename,edits,renamePage:{index,shapeCount:counts[index]}};
  }finally{input=null;result=null;prepared=null;document=null;replica?.destroy();}
}
try{
  const run=await importAndEdit();
  // WeakRefs held by Store are cleared only after the current job ends. Yield
  // before explicit collection so reopen is not measured beside the old mirror.
  await new Promise(resolve=>setImmediate(resolve));globalThis.gc?.();
  progress({phase:'reopen',sourceReplicaClosed:true,rssBytes:process.memoryUsage().rss});
  const reopening=await timed(()=>new Store(directory).load(run.recordId));
  try{assert.equal(reopening.value.replica.document.pagesById[run.pageId].name,run.expectedName);assert.equal(reopening.value.replica.document.pages.length,run.fixture.pageCount);}
  finally{reopening.value.replica.destroy();}
  run.phases.reopenMs=reopening.ms;
  const timingKeys=['translationMs','replicaMs','documentValidationMs','stateEncodingMs','journalMs','totalMs'];
  const report={
    description:'One production import, asset persistence, initial Replica/checkpoint, first page rename, warmed renames and one reopen after closing the source Replica',
    environment:{node:process.version,platform:process.platform,arch:process.arch,cpu:os.cpus()[0]?.model,logicalCpus:os.availableParallelism(),explicitGc:!!globalThis.gc},
    samples,warmups,percentileMethod:'Nearest rank: sorted[ceil(0.95*n)-1]; with five samples p95 is the observed maximum. Import and reopen are single observations.',
    excludes:['Electron IPC','editor reconciliation and initialization','native rendering and input latency','image decoding for display','portable export','visual fidelity'],
    fixture:run.fixture,phases:run.phases,workerPhases:run.worker,renamePage:run.renamePage,firstRename:run.firstRename,
    steadyRename:Object.fromEntries(timingKeys.map(key=>[key,stats(run.edits.map(edit=>edit[key]))])),edits:run.edits,
    memoryAfterReopen:{rssBytes:process.memoryUsage().rss,heapUsedBytes:process.memoryUsage().heapUsed}
  };
  if(output){await mkdir(path.dirname(output),{recursive:true});await writeFile(output,JSON.stringify(report,null,2)+'\n');}
  process.stdout.write(JSON.stringify(report,null,2)+'\n');
}finally{await rm(directory,{recursive:true,force:true});}
