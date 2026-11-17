import assert from 'node:assert/strict';
import {spawn, spawnSync} from 'node:child_process';
import {createHash, randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';

import {captureLD03, planLD03, seedLD03} from '../omc-native/ld03.mjs';
import {runPhases} from './local-resource-arm.mjs';
import {openPhaseSampler} from './phase-sampler.mjs';

const fixtureSha = 'b7017f570e4fcdb728cf715ad9bcfdc26b905c91d3b687e19c81125ec76a2a57';
const installed = '/Applications/Oh My Canvas.app/Contents/MacOS';
const workloadDir = resolve(dirname(fileURLToPath(import.meta.url)), '../workloads');
const nativeId = external => {
  assert.match(external, /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i);
  return 'doc_' + external.replaceAll('-', '');
};

export function registeredPlan(fixture) {
  assert.equal(fixture.fixture_sha256, fixtureSha, 'Use the same field-relay fixture as the Penpot resource arm');
  assert.equal(fixture.source_family_id, 'field-relay');
  assert.equal(fixture.logical_objects, 146);
  assert.equal(fixture.start.nodes.length, fixture.logical_objects);
  const plan = planLD03(fixture);
  assert.deepEqual(plan.candidate.map(({key,value}) => [key,value]), [
    ['target.accent','#136b62'],['target.spacing',20],
  ]);
  return plan;
}

export function pendingWork(metrics) {
  const values = [
    metrics.jobs?.active,metrics.jobs?.queued,metrics.jobs?.reservedBytes,
    metrics.admission?.pendingAndActive,metrics.admission?.activeDocuments,metrics.admission?.reservedTransportBytes,
  ];
  return {exitCode:values.every(value => value === 0) ? 0 : 1,
    jobs:metrics.jobs,admission:metrics.admission};
}

export function compareReplay(before, candidate, reopened) {
  const identity = frame => Object.fromEntries(['nodes','styles'].map(kind => [
    kind,Object.fromEntries(frame[kind].map(row => [row.key,row.native_id])),
  ]));
  for (const frame of [candidate,reopened]) {
    assert.equal(frame.document_id,before.document_id);
    assert.deepEqual(identity(frame),identity(before),'Replaced native identities');
  }
  const index = new Map(before.nodes.map(row => [row.key,row]));
  const cards = candidate.nodes.filter(row => Object.hasOwn(row,'bindings'));
  assert.equal(cards.length,44);
  const changes = Object.fromEntries(['fill','gap'].map(
    prop => [prop,cards.filter(row => row[prop] !== index.get(row.key)[prop]).length],
  ));
  assert.deepEqual(changes,{fill:38,gap:38});
  return changes;
}

function oracle(code,args) {
  const child = spawnSync('python3',['-B','-c',code,workloadDir,...args],
    {encoding:'utf8',timeout:10000,maxBuffer:256*1024});
  assert.equal(child.status,0,child.stderr || String(child.error));
}

function grade(fixture, evidence, phase) {
  const code = [
    'import json,sys',
    'sys.path.insert(0,sys.argv[1])',
    'from synthetic import _phase',
    'fixture,evidence=[json.load(open(path)) for path in sys.argv[2:4]]',
    'errors=[]',
    'identities=_phase(sys.argv[4],fixture[sys.argv[4]],evidence,errors)',
    'assert identities and not errors,errors',
  ].join('\n');
  oracle(code,[fixture,evidence,phase]);
}

async function stop(child, signal = 'SIGTERM') {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  const exit = once(child,'exit');
  const deadline = setTimeout(() => child.kill('SIGKILL'),5000);
  try {
    child.kill(signal);
    await exit;
  } finally {
    clearTimeout(deadline);
  }
}

async function live(fixturePath, fixture, plan, output) {
  const {Client,StreamableHTTPClientTransport} = await import('./mcp.mjs');
  const binary = name => join(installed,name);
  const [serviceHash,desktopHash] = await Promise.all(['omc-service','omc-desktop'].map(async name =>
    createHash('sha256').update(await readFile(binary(name))).digest('hex')));
  await mkdir(output,{mode:0o700});
  const profile = await mkdtemp(join(tmpdir(),'omc-ld03-resources-'));
  const report = {schemaVersion:1,fixtureSha256:fixtureSha,serviceHash,desktopHash,
    measurement:'resource-only deterministic LD03',renderProfile:'isolated native background desktop',
    unobserved:['display presentation','pixel fidelity','platform-complete lifecycle accounting']};
  const cancel = new AbortController();
  const interrupt = () => cancel.abort(new Error('Interrupted'));
  for (const s of ['SIGINT','SIGTERM']) process.once(s,interrupt);
  const save = async (file,data) => {
    const path = join(output,file);
    await writeFile(path,JSON.stringify(data,null,2)+'\n',{mode:0o600,flag:'wx'});
    return path;
  };
  let service, desktop, sampler, endpoint, headers;
  const clients = [];
  async function startService() {
    service = spawn(binary('omc-service'),['--profile',profile,'--port','0'],{stdio:['ignore',2,2]});
    await once(service,'spawn');
    for (let i=0; i<200; i++) {
      assert.equal(service.exitCode,null,'Native service exited at startup');
      try {
        const data = JSON.parse(await readFile(join(profile,'native-v1/service.json'),'utf8'));
        if (data.pid === service.pid) {
          endpoint = new URL(data.endpoint);
          assert.equal(endpoint.hostname,'127.0.0.1');
          headers = {Authorization:`Bearer ${data.token}`};
          return;
        }
      } catch (error) {
        if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
      }
      await delay(25,undefined,{signal:cancel.signal});
    }
    throw new Error('Native service did not publish the isolated descriptor');
  }
  async function connect(path) {
    const client = new Client({name:'omc-ld03-resource-arm',version:'1'});
    clients.push(client);
    const transport = new StreamableHTTPClientTransport(new URL(path,endpoint),{requestInit:{headers}});
    await client.connect(transport,{signal:cancel.signal,timeout:10000});
    assert.ok(transport.sessionId);
    return {
      call: async (name,args) => {
        const result = await client.callTool({name,arguments:args},undefined,{signal:cancel.signal,timeout:20000});
        assert.ok(!result.isError,`${name}: ${result.content[0]?.text}`);
        return result.structuredContent ?? JSON.parse(result.content[0].text);
      },
      rpc: async (method,id,extra={}) => {
        const response = await fetch(new URL('/rpc',endpoint),{
          method:'POST',
          headers:{...headers,'Content-Type':'application/json','X-OMC-Session':transport.sessionId},
          body:JSON.stringify({id:randomUUID(),method,params:{...(id && {documentId:nativeId(id)}),...extra}}),
          signal:AbortSignal.any([cancel.signal,AbortSignal.timeout(20000)]),
        });
        const payload = await response.json();
        assert.ok(response.ok && !payload.error,`${method}: ${payload.error?.code ?? response.status}`);
        return payload.result;
      },
    };
  }
  function nativeApi(connection) {
    const {call,rpc} = connection;
    return {
      call,run:(command,params={}) => call('run_command',{command,params}),
      bind:id => rpc('workspace.open',id),snapshot:id => rpc('document.snapshot',id),
      async literalGaps(id,overrides) {
        const before = await rpc('document.snapshot',id);
        const commands = overrides.map(({key,value}) => {
          const nodes = Object.values(before.nodes).filter(node => node.properties.name === `LD03 ${key}`);
          assert.equal(nodes.length,1);
          const [node] = nodes;
          const {layout} = node.properties;
          assert.equal(layout.type,'flex');
          assert.equal(layout.direction,'column');
          return {type:'node.set',nodeId:node.id,properties:{layout:{...layout,gap:value}}};
        });
        const requestId = randomUUID();
        const receipt = await rpc('document.command',id,{envelope:{
          protocol:'omc.engine/1',documentId:before.id,requestId,idempotencyKey:requestId,
          targetEpoch:before.epoch,preconditions:{revision:{epoch:before.epoch,sequence:before.sequence}},
          command:{type:'batch',commands},
        }});
        assert.equal(receipt.status,'durable');
      },
    };
  }
  async function capture(connection,id,phase,file) {
    const state = await captureLD03(nativeApi(connection),id,fixture);
    grade(fixturePath,await save(file,state),phase);
    return state;
  }

  async function disposeInstalled() {
    await Promise.allSettled(clients.splice(0).map(client => client.close()));
    try {
      await stop(desktop);
    } finally {
      desktop = undefined;
      await stop(service,'SIGINT');
    }
  }

  try {
    await startService();
    const writer = await connect('/mcp/figcraft');
    const legacy = await connect('/mcp');
    const api = nativeApi(writer);
    const {id,variableIds} = await seedLD03(api,fixture,plan);
    await writer.rpc('document.save',id);
    desktop = spawn(binary('omc-desktop'),['--profile',profile,'--automation-background'],{stdio:['ignore',2,2]});
    await once(desktop,'spawn');
    const state = () => legacy.call('workspace',{action:'state'});
    let attached;
    for (let i=0; i<40 && !attached; i++) {
      assert.equal(desktop.exitCode,null,'Background desktop exited while attaching');
      attached = (await state()).window?.attached;
      if (!attached) await delay(100,undefined,{signal:cancel.signal});
    }
    assert.equal(attached,true,'Native desktop did not attach');
    async function focus() {
      const {window} = await legacy.call('workspace',{action:'focus',documentId:id});
      assert.equal(window.documentId,nativeId(id));
      assert.ok(window.windows.length && window.windows.every(item => item.focused === false));
    }
    await focus();
    const baselineReader = await connect('/mcp/figcraft');
    const before = await capture(baselineReader,id,'start','before.json');
    report.roots = {service:service.pid,desktop:desktop.pid};
    report.execution = {actions:[]};
    sampler = await openPhaseSampler(join(output,'product-resources'));
    let candidate;
    let reopened;
    report.phases = await runPhases(sampler,{rootPids:Object.values(report.roots),intervalSeconds:.05,
      baselineSeconds:60,tailSeconds:30,maxTailSeconds:90},async () => {
      const start = performance.now();
      try {
        for (const {key,value} of plan.candidate) {
          await api.run('variable.set',{variable:variableIds.get(key),value});
          report.execution.actions.push({op:'set_style',key,value});
        }
        await writer.rpc('document.save',id);
        const reader = await connect('/mcp/figcraft');
        candidate = await capture(reader,id,'expected','candidate.json');
        await legacy.call('workspace',{action:'close',documentId:id});
        for (const connection of [writer,baselineReader,reader]) {
          assert.equal((await connection.rpc('workspace.close',id)).released,true);
        }
        const {window} = await state();
        assert.notEqual(window.documentId,nativeId(id),'Document remained open after close');
        assert.ok(window.windows.length && window.windows.every(item => item.focused === false));
        await focus();
        const reopenReader = await connect('/mcp/figcraft');
        reopened = await capture(reopenReader,id,'expected','reopened.json');
        report.execution.changes = compareReplay(before,candidate,reopened);
        return {exitCode:0,elapsedMs:performance.now()-start};
      } catch (error) {
        return {exitCode:1,elapsedMs:performance.now()-start,error:error.message};
      }
    },async () => pendingWork(await writer.rpc('workspace.metrics')),seconds =>
      delay(seconds*1000,undefined,{signal:cancel.signal}));
    await sampler.close();
    sampler = undefined;

    if (report.phases.execution.exitCode === 0) {
      const started = performance.now();
      await disposeInstalled();
      assert.equal(service.exitCode,0,'First native service must exit normally');
      await startService();
      assert.notEqual(service.pid,report.roots.service);
      const freshReader = await connect('/mcp/figcraft');
      const fresh = await capture(freshReader,id,'expected','fresh-service-reopened.json');
      assert.deepEqual(compareReplay(before,candidate,fresh),report.execution.changes);
      report.freshServiceReopen = {pid:service.pid,elapsedMs:performance.now()-started,outsideResourceWindow:true};
    }
  } catch (error) {
    report.error = error.message;
  } finally {
    try {
      try {
        await sampler?.close();
      } finally {
        await disposeInstalled();
      }
    } catch (error) {
      report.error ??= error.message;
    } finally {
      for (const s of ['SIGINT','SIGTERM']) process.off(s,interrupt);
      await rm(profile,{recursive:true,force:true,maxRetries:5});
      await save('arm.json',report);
    }
  }
  console.log(JSON.stringify({output,phases:report.phases?.stopped.phase_completeness,
    replay:report.phases?.execution,freshServiceReopen:report.freshServiceReopen,error:report.error}));
  if (report.error || report.phases?.execution.exitCode !== 0 || !report.freshServiceReopen) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const {values} = parseArgs({options:{
    fixture:{type:'string'},output:{type:'string'},'fixture-only':{type:'boolean'},
  }});
  assert.ok(values.fixture && (values.output || values['fixture-only']),'Supply --fixture and --output');
  const fixture = JSON.parse(await readFile(values.fixture,'utf8'));
  const plan = registeredPlan(fixture);
  oracle([
    'import json,sys',
    'sys.path.insert(0,sys.argv[1])',
    'from synthetic import fixture',
    'assert json.load(open(sys.argv[2])) == fixture("LD03","field-relay"), "Fixture differs from the canonical generated contract"',
  ].join('\n'),[values.fixture]);
  if (values['fixture-only']) console.log(JSON.stringify({
    fixtureSha256:fixtureSha,nodes:fixture.logical_objects,cards:plan.cards.length,setup:'NOT_RUN',
  }));
  else await live(values.fixture,fixture,plan,values.output);
}
