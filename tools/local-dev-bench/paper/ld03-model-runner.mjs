import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {appendFileSync, readFileSync, writeFileSync} from 'node:fs';
import {mkdir, mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';

import {runLD03Agent, withLD03Broker} from '../ld03-model.mjs';
import {capture, normalize, plan, screenshot, sourceStylesFromJsx, withPaper} from './ld03.mjs';
import {createPaperLd03ModelHandlers, verifyPaperLd03Clone} from './ld03-model.mjs';

const pythonEnv = {...process.env, PYTHONDONTWRITEBYTECODE: '1'};
const rasterScript = fileURLToPath(new URL('./ld03-raster.py', import.meta.url));
const oraclePath = fileURLToPath(new URL('../workloads/', import.meta.url));

async function observe(phase, registration, location) {
  const {scope, fixture} = registration;
  return await withPaper(scope, async (read, ts) => {
    const observed = await capture(read, ts, fixture, scope);
    const rawPath = join(location.output, phase + '-raw.json');
    const imagePath = join(location.output, phase + '.jpg');
    writeFileSync(rawPath, JSON.stringify(observed), {flag: 'wx', mode: 0o600});
    writeFileSync(imagePath, await screenshot(read,fixture,scope), {flag: 'wx', mode: 0o600});
    const raster = JSON.parse(execFileSync('python3', [rasterScript, location.fixture, location.scope, rawPath, imagePath],
      {env:pythonEnv, maxBuffer:1024 * 1024}));
    writeFileSync(join(location.output, phase + '-raster.json'), JSON.stringify(raster), {flag: 'wx', mode: 0o600});
    const sourceStyles = sourceStylesFromJsx(ts, observed.raw.jsx);
    const result = normalize(fixture,scope,{...observed.raw, sourceStyles},raster);
    writeFileSync(join(location.output, phase + '-qualified.json'), JSON.stringify(result), {flag: 'wx', mode: 0o600});
    return result;
  });
}

function oracle(fixture, evidence) {
  const script = [
    'import json, sys, synthetic',
    'input = json.load(sys.stdin)',
    'fixture = input["fixture"]; evidence = input["evidence"]',
    'failures = {}; identities = {}',
    'for phase, key in (("before","start"),("candidate","expected")):',
    ' if phase in evidence:',
    '  failures[phase]=[]',
    '  identities[phase]=synthetic._phase(phase,fixture[key],evidence[phase],failures[phase])',
    'result={"phaseFailures":failures,"sameNativeIdentities":len(identities)==2 and identities["before"] == identities["candidate"]}',
    'result["fullGradeFailures"]=synthetic.grade(fixture,evidence)',
    'print(json.dumps(result))',
  ].join('\n');
  return JSON.parse(execFileSync('python3',['-c',script],{input:JSON.stringify({fixture,evidence}),
    env:{...pythonEnv,PYTHONPATH:oraclePath},maxBuffer:1024 * 1024}));
}

async function resetCopy(registration, current, audit) {
  const {fixture, scope}=registration;
  const updates=plan(fixture,scope).setup[0].arguments.tokens
    .filter(token=>token.name.endsWith('-target-accent') || token.name.endsWith('-target-spacing'))
    .map(({name,value})=>({name,value}));
  assert.equal(updates.length,2);
  await withPaper(scope,async read=>{
    const call=(name,args={})=>read({name,arguments:{...args,fileId:scope.fileId}});
    const home=await call('get_basic_info');
    assert.equal(home.fileName,scope.fileName);
    assert.ok(home.pages.some(page=>page.id===scope.pageId&&page.name===registration.cloneReceipt.candidatePage.name));
    const page=await call('get_basic_info',{pageId:scope.pageId});
    assert.ok(page.artboards.some(board=>board.id===scope.boardId&&board.name==='Field relay roster'));
    const values=[];
    for(const type of ['color','spacing']) {
      values.push(...(await call('get_tokens',{types:[type],namePattern:`--${type}-${scope.prefix}-*`,format:'json'})).tokens);
    }
    assert.equal(values.length,4);
    for(const row of current.styles) {
      const [fileId,name]=JSON.parse(row.native_id);
      assert.equal(fileId,scope.fileId);
      const found=values.filter(token=>token.name===name);
      assert.equal(found.length,1);
      assert.equal(found[0].type,row.kind==='color'?'color':'spacing');
      assert.equal(found[0].value.toLowerCase(),row.kind==='color'?row.value:`${row.value}px`);
    }
    audit({action:'observer-reset-request',fileId:scope.fileId,tokens:updates});
    const ack=await call('set_tokens',{tokens:updates});
    audit({action:'observer-reset-response',result:ack});
    assert.deepEqual(ack.tokens.map(row=>[row.name,row.result]).sort(),updates.map(row=>[row.name,'updated']).sort());
  });
}

export async function runPaperModelPilot(registration, location, options, report, dependencies = {}) {
  const {fixture}=registration;
  verifyPaperLd03Clone(registration);
  const observePhase = dependencies.observe ?? observe;
  const grade = dependencies.oracle ?? oracle;
  const reset = dependencies.reset ?? resetCopy;
  const handlerFactory = dependencies.handlers ?? createPaperLd03ModelHandlers;
  const broker = dependencies.broker ?? withLD03Broker;
  const agent = dependencies.agent ?? runLD03Agent;
  const audit = event => appendFileSync(join(location.output,'native-tool-events.jsonl'),
    JSON.stringify(event)+'\n',{mode:0o600});
  report.currentPhase='startingCapture';
  const current = await observePhase('initial',registration,location);
  const original = grade(fixture,{before:current});
  let before = current;
  if (original.phaseFailures.before.length) {
    report.startingGuardFailures = original.phaseFailures.before;
    assert.ok(options.reset, 'Fresh Paper baseline does not match the registered starting fixture');
    const known = grade(fixture,{candidate:current});
    assert.deepEqual(known.phaseFailures.candidate,[], 'Paper clone does not match the registered prior candidate');
    report.currentPhase='observerReset';
    await reset(registration,current,audit);
    before=await observePhase('before',registration,location);
    const resetGrade=grade(fixture,{before,candidate:current});
    assert.ok(resetGrade.sameNativeIdentities,'Paper cloned native identities changed across reset');
    assert.deepEqual(resetGrade.phaseFailures.before,[], 'Observer reset did not restore the registered starting fixture');
  } else {
    writeFileSync(join(location.output,'before-qualified.json'),JSON.stringify(before),{flag:'wx',mode:0o600});
  }
  report.before=before;
  const handlers=handlerFactory({...registration,baseline:before,audit});
  const sandbox=await mkdtemp(join(tmpdir(),'ld03-paper-'));
  const socket=join(sandbox,'tool.sock');
  report.currentPhase='agent';
  const started=performance.now();
  try {
    const timing = AbortSignal.timeout(600000);
    const signal = options.signal ? AbortSignal.any([options.signal,timing]) : timing;
    await broker(socket, handlers, report.modelTools, () => agent(options.modelCommand,socket,signal));
    report.agentExit='completed';
  } catch(error) {
    report.agentExit='failed';
    report.agentFailure=error.message;
  } finally {
    report.modelProcessWallMs=performance.now()-started;
    await rm(sandbox,{recursive:true,force:true});
  }
  report.currentPhase='candidateReadback';
  report.candidate=await observePhase('candidate',registration,location);
  report.oracle=grade(fixture,{before,candidate:report.candidate});
  report.candidateQualified=report.oracle.sameNativeIdentities&&
    Object.values(report.oracle.phaseFailures).every(errors=>!errors.length);
  report.currentPhase='complete';
}

async function main() {
  const {values}=parseArgs({options:{fixture:{type:'string'},scope:{type:'string'},
    'original-scope':{type:'string'},'clone-receipt':{type:'string'},output:{type:'string'},
    'model-command':{type:'string'},reset:{type:'boolean'}}});
  for(const required of ['fixture','scope','original-scope','clone-receipt','output','model-command'])
    assert.ok(values[required],`Missing --${required}`);
  const location={fixture:resolve(values.fixture),scope:resolve(values.scope),output:resolve(values.output)};
  const load=path=>JSON.parse(readFileSync(path,'utf8'));
  const registration={fixture:load(location.fixture),scope:load(location.scope),
    originalScope:load(values['original-scope']),cloneReceipt:load(values['clone-receipt'])};
  await mkdir(location.output,{mode:0o700});
  const cancellation=new AbortController();
  for(const event of ['SIGINT','SIGTERM'])process.once(event,()=>cancellation.abort(new Error(event)));
  const report={workload:'LD03',variant:'field-relay',measurementKind:'paper-model-clone-diagnostic',
    fixtureSha256:registration.fixture.fixture_sha256,modelTools:[],currentPhase:'registration',
    acceptedCompletionSeconds:null,normalEditorReopenObserved:false};
  try {
    await runPaperModelPilot(registration,location,{reset:values.reset,modelCommand:resolve(values['model-command']),
      signal:cancellation.signal},report);
    report.status=report.agentExit==='completed'&&report.candidateQualified?'candidate-verified-lifecycle-incomplete':'candidate-incomplete';
    if(report.status==='candidate-incomplete')process.exitCode=1;
  } catch(error) {
    report.status='incomplete';
    report.error=error.message;
    process.exitCode=1;
  } finally {
    writeFileSync(join(location.output,'result.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600});
    console.log(JSON.stringify({status:report.status,phase:report.currentPhase,candidateQualified:report.candidateQualified??false}));
  }
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)await main();
