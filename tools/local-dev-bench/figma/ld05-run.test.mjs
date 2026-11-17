import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import test from 'node:test';
import {awaitNativeReopen} from './ld05-run.mjs';
import {publishCandidate} from '../publish-candidate.mjs';

// These temp-directory receipts model the root observer and never enter live evidence.
async function syntheticReceipt(output,patch={}) {
  const requestPath=join(output,'cycle-1-await-editor-reopen.json');
  let request;
  for (let tries=0;tries<50;tries++) {
    try {request=JSON.parse(await readFile(requestPath,'utf8'));break;} catch(error) {
      if(error.code!=='ENOENT')throw error;
    }
    await delay(2);
  }
  assert.ok(request);
  const closed=Date.now()+5;
  await delay(15);
  const receipt={...request,actor:'root-cua',closed_at:new Date(closed).toISOString(),
    reopened_at:new Date().toISOString(),close_observation:'synthetic test-only close observation',
    reopen_observation:'synthetic test-only same-file editor observation',...patch};
  await publishCandidate(join(output,'cycle-1-editor-reopen.json'),receipt);
  return receipt;
}

const context=output=>({output,runId:'synthetic-only-run',cycle:1,fileKey:'test-file',pageId:'1:2',
  writtenAt:new Date(Date.now()-10).toISOString(),deadline:performance.now()+2000});

test('native readback stays behind a correctly scoped atomic observer receipt',async()=>{
  const output=await mkdtemp(join(tmpdir(),'ld05-reopen-test-'));
  try {
    const promise=awaitNativeReopen(context(output));
    let observed=false;
    const observedPromise=promise.then(receipt=>{observed=true;return receipt;});
    await delay(10);
    assert.equal(observed,false);
    const receipt=await syntheticReceipt(output);
    assert.deepEqual(await observedPromise,receipt);
    assert.equal(observed,true);
  } finally {await rm(output,{recursive:true,force:true});}
});

test('wrong run, file, page, cycle, nonce and stale UI observations are rejected',async()=>{
  for(const patch of [{run_id:'another-run'},{file_key:'other-file'},{page_id:'8:8'},{cycle:2},{nonce:'old-request'},
    {closed_at:'2000-01-01T00:00:00.000Z'},{reopened_at:'2000-01-01T00:00:00.000Z'},
    {reopened_at:'2099-01-01T00:00:00.000Z'},{close_observation:''},{actor:'made-up-observer'}]) {
    const output=await mkdtemp(join(tmpdir(),'ld05-reopen-test-'));
    try {
      const promise=awaitNativeReopen(context(output));
      const rejected=assert.rejects(promise);
      await syntheticReceipt(output,patch);
      await rejected;
    } finally {await rm(output,{recursive:true,force:true});}
  }
});

test('an absent UI receipt expires within the existing deadline and preserves the request',async()=>{
  const output=await mkdtemp(join(tmpdir(),'ld05-reopen-test-'));
  try {
    const deadline=performance.now()+70;
    await assert.rejects(awaitNativeReopen({...context(output),deadline}),/deadline expired/);
    assert.ok(performance.now()-deadline<150);
    assert.equal(JSON.parse(await readFile(join(output,'cycle-1-await-editor-reopen.json'),'utf8')).cycle,1);
  } finally {await rm(output,{recursive:true,force:true});}
});
