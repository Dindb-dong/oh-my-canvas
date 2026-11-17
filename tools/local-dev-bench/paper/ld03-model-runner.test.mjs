import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {runPaperModelPilot} from './ld03-model-runner.mjs';

const fixture = {workload:'LD03',source_family_id:'field-relay',
  fixture_sha256:'b7017f570e4fcdb728cf715ad9bcfdc26b905c91d3b687e19c81125ec76a2a57'};
const scope = {fileId:'test-copy',pageId:'test-copy-page',boardId:'test-copy-board',
  fileName:'OMC Benchmark LD03 verification / ld03-copy-cap-01',prefix:'omc-ld03-field-relay-cap-01'};
const registration = {scope,fixture,originalScope:{fileId:'test-original'},
  cloneReceipt:{status:'copied-background-readable',copy:{fileId:scope.fileId,name:scope.fileName},
    candidatePage:{id:scope.pageId,name:'LD03 preflight / field-relay-cap-01'}}};
const witness = (state, phase) => ({state,phase});
const signal = new AbortController();

const oracle = (_fixture, observations) => ({
  phaseFailures:Object.fromEntries(Object.entries(observations).map(([name,row])=>
    [name,row.state===(name==='before'?'initial':'candidate')?[]:['wrong state']])),
  sameNativeIdentities:true,
  fullGradeFailures:['reopened: missing observation'],
});

test('guards reset, brokers model interaction, then independently observes the candidate', async t => {
  const output=await mkdtemp(join(tmpdir(),'paper-ld03-test-'));
  t.after(()=>rm(output,{recursive:true,force:true}));
  const report={modelTools:[]};
  const calls=[];
  let state='candidate';
  const deps={
    oracle,
    observe:async phase=>{calls.push(phase);return witness(state,phase);},
    reset:async (_registration,current)=>{assert.equal(current.state,'candidate');calls.push('reset');state='initial';},
    handlers:({baseline})=>{
      assert.equal(baseline.state,'initial');
      return {inspect:async()=>state,apply:async()=>{state='candidate';}};
    },
    broker:async (_path, handlers,_events, callback)=>{
      assert.equal(await handlers.inspect(),'initial');
      calls.push('broker');
      await handlers.apply();
      await callback();
    },
    agent:async(path, socket, abortSignal)=>{
      assert.equal(path,'operator-command');
      assert.match(socket,/tool\.sock$/);
      assert.equal(abortSignal.aborted,false);
      calls.push('agent');
    },
  };
  await runPaperModelPilot(registration,{output},{reset:true,modelCommand:'operator-command',signal:signal.signal},report,deps);
  assert.deepEqual(calls,['initial','reset','before','broker','agent','candidate']);
  assert.equal(report.candidateQualified,true);
  assert.equal(report.agentExit,'completed');
});

test('rejects a fresh clone drift without an authorized reset or recognized prior state', async t => {
  const output=await mkdtemp(join(tmpdir(),'paper-ld03-test-'));
  t.after(()=>rm(output,{recursive:true,force:true}));
  const deps={oracle,observe:async()=>witness('drift'),reset:async()=>assert.fail('unexpected reset'),
    handlers:()=>assert.fail('unexpected handlers')};
  await assert.rejects(runPaperModelPilot(registration,{output},{reset:false},{},deps),/does not match the registered starting fixture/);
  await assert.rejects(runPaperModelPilot(registration,{output},{reset:true},{},deps),/does not match the registered prior candidate/);
});

test('still captures the product state after a failed launch', async t => {
  const output=await mkdtemp(join(tmpdir(),'paper-ld03-test-'));
  t.after(()=>rm(output,{recursive:true,force:true}));
  const report={modelTools:[]};
  const phases=[];
  const deps={oracle,observe:async phase=>{phases.push(phase);return witness('initial',phase);},
    handlers:()=>({}),broker:async(_socket,_handlers,_events,callback)=>callback(),
    agent:async()=>{throw Error('observer launcher failed');}};
  await runPaperModelPilot(registration,{output},{modelCommand:'operator-command'},report,deps);
  assert.equal(report.candidateQualified,false);
  assert.equal(report.agentExit,'failed');
  assert.deepEqual(phases,['initial','candidate']);
});
