import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import test from 'node:test';
import {awaitNativeReopen,normalizeNativeCycle,normalizeSourceCycle,sourceComponentIdentity} from './ld05-run.mjs';
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

test('cycle results are assembled from actual canvas and source observations and reject missing proof',()=>{
  const hash=value=>createHash('sha256').update(value).digest('hex');
  const app_source="import {Card as createCard} from './card.mjs';";
  const module_source='export function createCard() {}\nexport {createCard as Card};';
  const boundary={app_source,module_source,app_sha256:hash(app_source),module_sha256:hash(module_source),
    initial_module_sha256:hash(module_source)};
  assert.equal(sourceComponentIdentity(boundary),'Card');
  assert.throws(()=>sourceComponentIdentity(),/Missing observed/);
  const wrongApp=app_source.replace('Card as','WrongCard as');
  assert.throws(()=>sourceComponentIdentity({...boundary,app_source:wrongApp,app_sha256:hash(wrongApp)}),/export differs/);
  assert.throws(()=>sourceComponentIdentity({...boundary,module_source:module_source+'\n// changed'}),/bytes differ/);
  const expected={check_control_name:'Toggle',keyboard_before:'Off',keyboard_after:'On',component:'Card',
    status_visible:true,cards:['One','Two'],asset:'one.png',gap:20,radius:14,heading_size:24};
  const assets={'one.png':Buffer.from([137,80,78,71,1,2,3,4,5]),'two.png':Buffer.from([137,80,78,71,5,4,3,2,1])};
  const labels={title:'Board',check_control_name:'Toggle',keyboard_before:'Off',keyboard_after:'On',component:'Card'};
  const observed={labels,gap:20,direction:'VERTICAL',cards:['One','Two'].map(title=>({title,detail:'Detail',
    variant:'standard',radius:14,headingSize:24,accent:'#253357',imageBytes:[...assets['one.png']]}))};
  assert.deepEqual(normalizeNativeCycle(expected,observed,assets),expected);
  assert.throws(()=>normalizeNativeCycle(expected,{...observed,gap:8},assets),/semantics differ/);
  assert.throws(()=>normalizeNativeCycle(expected,{...observed,labels:{...labels,keyboard_after:undefined}},assets),/Missing observed/);
  assert.throws(()=>normalizeNativeCycle(expected,{...observed,cards:observed.cards.map(card=>({...card,imageBytes:undefined}))},assets),/asset bytes/);
  const fixture={title:'Board',widths:[360,768,1200]};
  const browser={evaluatedHtml:'<h1>Board</h1>',states:fixture.widths.map(width=>({width,controlName:'Toggle',
    beforePress:'Off',statusVisible:true,afterPress:'On',
    cards:observed.cards.map(card=>({label:card.title,detail:card.detail,variant:card.variant,
      src:'./assets/one.png',loaded:true})),styles:{gap:'20px',radius:'14px',heading:'24px',wrap:'nowrap',
      accent:'rgb(37, 51, 87)',variantBorder:'rgba(0, 0, 0, 0)'}}))};
  assert.deepEqual(normalizeSourceCycle(fixture,expected,browser,assets,boundary),expected);
  const changed=structuredClone(browser);
  changed.states[0].styles.gap='8px';
  assert.throws(()=>normalizeSourceCycle(fixture,expected,changed,assets,boundary),/semantics differ/);
  const missing=structuredClone(browser);
  delete missing.states[0].beforePress;
  assert.throws(()=>normalizeSourceCycle(fixture,expected,missing,assets,boundary),/actual initial source status/);
});
