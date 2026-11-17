import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';

import {
  createAccount, connectEditor, getMcpEndpoint, loopbackOrigin, newFile, waitForBackend,
} from '../penpot-ld02.mjs';
import {
  changeFieldRelay, planFieldRelay, readFieldRelay, refreshFieldRelay, seedFieldRelay, stateDifferences,
} from '../penpot/ld03.mjs';
import {decodeNativeResult, readAfterAttach} from '../penpot/ld09.mjs';
import {runPhases} from './local-resource-arm.mjs';
import {openPhaseSampler} from './phase-sampler.mjs';
import {discoverGuest, dockerReader, openGuestCollector} from './penpot-guest-resources.mjs';

const roles = ['penpot-frontend','penpot-backend','penpot-postgres','penpot-valkey','penpot-mcp'];

function identities(state) {
  return Object.fromEntries(['nodes','styles'].map(key => [
    key,Object.fromEntries(state[key].map(row => [row.key,row.native_id])),
  ]));
}

function observeSave(page, origin) {
  return page.waitForResponse(response => response.ok() && new URL(response.url()).origin === origin &&
    response.url().includes('/update-file') && response.request().method() === 'POST', {timeout:8000})
    .then(() => true, () => false);
}

async function reopen(editor, context, location) {
  const reopened = await context.newPage();
  await editor.close();
  await reopened.goto(location.href);
  await connectEditor(reopened);
  return reopened;
}

async function verify(execute, id, spec) {
  const deadline = performance.now()+6500;
  let state, differences;
  do {
    state = await readAfterAttach(() => execute(readFieldRelay(id)));
    differences = stateDifferences(spec,state);
    if (!differences.length) return state;
    await delay(150);
  } while (performance.now() < deadline);
  throw new Error(`Penpot native readback: ${differences.length} differences (${differences.slice(0,8).join(', ')})`);
}

async function run({origin,fixture,project,socket,output}) {
  planFieldRelay(fixture);
  const read = dockerReader(socket);
  const guestEnrollment = await discoverGuest(read,project,roles);
  assert.ok(guestEnrollment.frontendPublicPorts.includes(Number(new URL(origin).port)),
    'Registered origin is outside the selected project frontend');
  await waitForBackend(origin);
  await mkdir(output,{mode:0o700});
  const save = (name,data) => writeFile(join(output,name),JSON.stringify(data,null,2)+'\n',{flag:'wx',mode:0o600});
  const {Client, StreamableHTTPClientTransport, benchRequire} = await import('./mcp.mjs');
  const {chromium} = benchRequire('playwright');
  const client = new Client({name:'penpot-ld03-resource-arm',version:'1'});
  const email = `omc-bench-${randomBytes(10).toString('hex')}@example.test`;
  const password = randomBytes(20).toString('hex')+'Aa1!';
  const cancel = new AbortController();
  const stop = () => cancel.abort(new Error('Interrupted'));
  for (const signal of ['SIGINT','SIGTERM']) process.once(signal,stop);
  let chrome, browser, endpoint, host, guest;
  const report = {schemaVersion:1,fixtureSha256:fixture.fixture_sha256,origin,project,
    scope:'isolated headless Chrome and separate named Linux cgroup panels',utcStart:new Date().toISOString()};
  const redact = value => [email,password,endpoint?.searchParams.get('userToken')].filter(Boolean)
    .reduce((result,secret) => result.replaceAll(secret,'[redacted]'),value);
  try {
    chrome = await chromium.launchServer({channel:'chrome',headless:true,host:'127.0.0.1'});
    assert.equal(new URL(chrome.wsEndpoint()).hostname,'127.0.0.1');
    const pid = chrome.process().pid;
    assert.ok(Number.isInteger(pid) && pid > 1,'No task-owned browser root');
    browser = await chromium.connect(chrome.wsEndpoint());
    const context = await browser.newContext({locale:'en-US',viewport:{width:1440,height:960}});
    context.setDefaultTimeout(15000);
    const dashboard = await context.newPage();
    await createAccount(dashboard,origin,email,password);
    endpoint = await getMcpEndpoint(dashboard,origin);
    await client.connect(new StreamableHTTPClientTransport(endpoint),{timeout:10000});
    let editor = await newFile(dashboard,context,origin);
    await connectEditor(editor);
    if (editor !== dashboard) await dashboard.close();
    const location = new URL(editor.url());
    assert.equal(location.origin,origin);
    const file = location.searchParams.get('file-id');
    assert.match(file,/^[a-f0-9-]{36}$/i);
    const execute = async code => decodeNativeResult(await client.callTool({
      name:'execute_code',arguments:{code},
    },undefined,{timeout:20000,signal:cancel.signal}));
    assert.equal(await readAfterAttach(() => execute('return penpot.currentFile.id;')),file);
    const initialSave = observeSave(editor,origin);
    assert.deepEqual(await execute(seedFieldRelay(fixture,file)),{nodes:fixture.logical_objects,styles:4});
    assert.ok(await initialSave,'Fixture save was not observed');
    editor = await reopen(editor,context,location);
    const before = await verify(execute,file,fixture.start);
    await save('fixture-ready.json',before);
    report.browserRoot = {pid,version:browser.version(),headless:true,renderer:'UNVERIFIED'};
    report.resourceRegistration = {
      browserIntervalSeconds:.05, guestIntervalMs:1000, maxGuestRoundSkewMs:250,
      baselineSeconds:60,tailSeconds:30,maxTailSeconds:90,
    };
    const changes = fixture.expected.styles.filter(style => style.key.startsWith('target.'))
      .map(({key,value}) => ({key,value}));
    assert.deepEqual(changes.map(change => change.key),['target.accent','target.spacing']);
    host = await openPhaseSampler(join(output,'host-browser'));
    guest = await openGuestCollector(join(output,'guest-containers.jsonl'),read,guestEnrollment);
    guest.start();
    const both = {
      async send(message) {
        const beforeMs = performance.now();
        const reply = await host.send(message);
        if (message.command !== 'start') guest.mark(message,beforeMs,performance.now());
        return reply;
      },
    };
    report.phases = await runPhases(both,{rootPids:[pid],intervalSeconds:.05,
      baselineSeconds:60,tailSeconds:30,maxTailSeconds:90},async () => {
      const started = performance.now();
      try {
        const saved = observeSave(editor,origin);
        await execute(changeFieldRelay(file,changes));
        assert.equal(await execute(refreshFieldRelay(file)),true);
        const candidate = await verify(execute,file,fixture.expected);
        await save('candidate.json',candidate);
        assert.ok(await saved,'Candidate save was not observed');
        editor = await reopen(editor,context,location);
        const reopened = await verify(execute,file,fixture.expected);
        await save('reopened.json',reopened);
        for (const state of [candidate,reopened]) {
          assert.equal(state.document_id,before.document_id);
          assert.deepEqual(identities(state),identities(before));
        }
        return {exitCode:0,elapsedMs:performance.now()-started,saveObserved:true};
      } catch (error) {
        return {exitCode:1,elapsedMs:performance.now()-started,error:redact(error.message)};
      }
    },null,seconds => delay(seconds*1000,undefined,{signal:cancel.signal}));
  } catch (error) {
    report.error = redact(error.message);
  } finally {
    const ended = await Promise.allSettled([guest?.close(),host?.close()]);
    if (ended[0].status === 'fulfilled') report.guest = ended[0].value;
    report.collectorErrors = ended.filter(row => row.status === 'rejected').map(row => redact(row.reason.message));
    await Promise.allSettled([client.close(),browser?.close()]);
    try {
      await chrome?.close();
    } catch (error) {
      report.collectorErrors.push(redact(error.message));
      await chrome.kill().catch(killError => report.collectorErrors.push(redact(killError.message)));
    }
    for (const signal of ['SIGINT','SIGTERM']) process.off(signal,stop);
    await save('arm.json',report);
    console.log(JSON.stringify({output,replay:report.phases?.execution,host:report.phases?.stopped.phase_completeness,
      guestReplay:report.guest?.phases.replay?.status,error:report.error}));
  }
  const guestReplay = report.guest?.phases.replay;
  if (report.error || report.collectorErrors.length || report.phases?.execution.exitCode !== 0 ||
      report.phases.stopped.phase_completeness.replay !== 'COMPLETE' ||
      guestReplay?.observedGuestChargedPeakBytes == null || guestReplay.observedGuestCpuSeconds === null) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const {values} = parseArgs({options:{
    origin:{type:'string'},fixture:{type:'string'},project:{type:'string'},socket:{type:'string'},output:{type:'string'},
  }});
  assert.ok(Object.values(values).length === 5,'Supply --origin --fixture --project --socket --output');
  await run({...values,origin:loopbackOrigin(values.origin),fixture:JSON.parse(await readFile(values.fixture,'utf8'))});
}
