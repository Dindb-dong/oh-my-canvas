import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';
import {zipSync,strToU8} from 'fflate';
import {Store} from '../core/storage.mjs';
import {persistDesignImport} from '../electron/document-assets.mjs';

let directory,readDesignFile;
test.before(async()=>{
  directory=await fs.mkdtemp(path.join(os.tmpdir(),'omc-progressive-import-'));
  await Promise.all([
    build({entryPoints:['electron/design-import.mjs'],bundle:true,platform:'node',format:'esm',outfile:path.join(directory,'electron/design-import.mjs'),logLevel:'silent'}),
    build({entryPoints:['editor/formats/design-file.ts'],bundle:true,platform:'node',format:'esm',outfile:path.join(directory,'dist/design-import.mjs'),logLevel:'silent'}),
  ]);
  await fs.copyFile('electron/design-import-worker.mjs',path.join(directory,'electron/design-import-worker.mjs'));
  ({readDesignFile}=await import(pathToFileURL(path.join(directory,'electron/design-import.mjs'))));
});
test.after(async()=>{await fs.rm(directory,{recursive:true,force:true});});
const rectangle={_class:'rectangle',name:'Rectangle',frame:{width:10,height:10}};
function fixture(rows=[[rectangle],[rectangle]],extra={}){
  return zipSync({'document.json':strToU8(JSON.stringify({pages:rows.map((_,i)=>({_ref:`pages/${i}`}))})),
    ...Object.fromEntries(rows.map((layers,i)=>[`pages/${i}.json`,strToU8(JSON.stringify({name:`Page ${i}`,layers}))])),...extra});
}
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};

test('the worker retains its complete API and never detaches caller input',async()=>{
  const input=fixture(),saved=Buffer.from(input),result=await readDesignFile(input,'sketch');
  assert.equal(result.document.pages.length,2);assert.deepEqual(result.blobs,[]);
  assert.deepEqual(Buffer.from(input),saved);assert.ok(result.timings.total>0);
});
test('real worker ACKs serialize durable bitmap writes and transfer a shared image once',async()=>{
  const png=Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==','base64'));
  const bitmap={_class:'bitmap',frame:{width:10,height:10},image:{_ref:'images/a.png'}};
  const bytes=fixture([[bitmap],[bitmap],[bitmap]],{'images/a.png':png}),store=new Store(path.join(directory,'profile'));
  const first=deferred(),release=deferred(),batches=[];let manifest;
  const done=readDesignFile(bytes,'sketch',{
    batchPages:1,onManifest(value){manifest=value;},async onBatch(batch){
      batches.push(batch);await persistDesignImport(batch,store);
      if(batch.sequence===1){first.resolve();await release.promise;}
    },
  });
  await first.promise;assert.equal(batches.length,1);
  await assert.rejects(readDesignFile(bytes,'sketch'),/Finish the current/);
  const hash=batches[0].blobs[0].hash;
  assert.deepEqual((await store.assets.get(hash)).bytes,Buffer.from(png));
  // Worker messages are isolated snapshots: main-side editing cannot mutate
  // the worker's retained source graph or subsequent final validation.
  batches[0].document.pagesById[batches[0].pageIds[0]].name='User edit';
  release.resolve();const result=await done;
  assert.equal(result.complete,true);assert.equal(result.assetCount,1);
  assert.deepEqual(batches.map(b=>b.blobs.length),[1,0,0]);
  assert.deepEqual(batches.flatMap(b=>b.pageIds),manifest.pages.map(p=>p.id));
  assert.ok(batches.every(b=>Object.values(b.document.assets)[0].src===`omc-asset:sha256:${hash}`));
  assert.equal(batches[2].document.pagesById[batches[2].pageIds[0]].name,'Page 2');
});
test('a bad later page rejects with acknowledged progress and leaves the first batch usable',async()=>{
  const batches=[];
  await assert.rejects(readDesignFile(fixture([[rectangle],[{...rectangle,frame:{width:-1,height:10}}]]),'sketch',{
    onBatch(batch){batches.push(batch);},
  }),error=>{
    assert.match(error.message,/dimensions/);
    assert.deepEqual(error.importProgress,{acknowledgedBatches:1,acknowledgedPageIds:batches[0].pageIds,completedPages:1});return true;
  });
  assert.equal(batches.length,1);assert.equal(batches[0].document.pages.length,1);
  assert.equal((await readDesignFile(fixture(),'sketch')).document.pages.length,2);
});
test('callback failure and cancellation terminate the paused worker and free the import slot',async()=>{
  let callbacks=0;
  await assert.rejects(readDesignFile(fixture(),'sketch',{onBatch(){callbacks++;throw Object.freeze(Error('disk full'));}}),/disk full/);
  assert.equal(callbacks,1);
  const abort=new AbortController(),first=deferred(),release=deferred();
  const run=readDesignFile(fixture(),'sketch',{signal:abort.signal,async onBatch(){first.resolve();await release.promise;}});
  const rejected=assert.rejects(run,error=>{assert.match(error.message,/cancel requested/);assert.equal(error.importProgress.acknowledgedBatches,0);return true;});
  await first.promise;abort.abort(Error('cancel requested'));await rejected;release.resolve();
  assert.equal((await readDesignFile(fixture(),'sketch')).document.pages.length,2);
});
test('consumer backpressure is excluded from active time but total lifetime remains bounded',async()=>{
  const result=await readDesignFile(fixture(),'sketch',{
    computeTimeoutMs:5000,totalTimeoutMs:15000,
    async onBatch(batch){if(batch.sequence===1)await new Promise(resolve=>setTimeout(resolve,5100));},
  });
  assert.equal(result.complete,true);assert.ok(result.timings.consumerWait>=5000);
  const entered=deferred(),release=deferred();
  const run=readDesignFile(fixture(),'sketch',{
    computeTimeoutMs:5000,totalTimeoutMs:1500,async onBatch(){entered.resolve();await release.promise;},
  });
  const failed=assert.rejects(run,/total lifetime/);await entered.promise;await failed;release.resolve();
});
test('aborted jobs and attempts to widen import deadlines fail before starting a worker',async()=>{
  const bytes=fixture();
  await assert.rejects(readDesignFile(bytes,'sketch',{signal:AbortSignal.abort(Error('cancelled already'))}),/cancelled already/);
  await assert.rejects(readDesignFile(bytes,'sketch',{computeTimeoutMs:30001}),/deadline/);
  await assert.rejects(readDesignFile(bytes,'sketch',{totalTimeoutMs:600001}),/deadline/);
  await assert.rejects(readDesignFile(bytes,'sketch',{onManifest(){}}),/callbacks/);
});
test('an active decode deadline terminates the worker and frees its slot',async()=>{
  await assert.rejects(readDesignFile(fixture(),'sketch',{computeTimeoutMs:1}),/timed out/);
  assert.equal((await readDesignFile(fixture(),'sketch')).document.pages.length,2);
});
