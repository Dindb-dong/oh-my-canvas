import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';

import {discoverGuest, dockerReader, guestRound, openGuestCollector, summarizeGuest} from './penpot-guest-resources.mjs';

const project = 'omc-perf-penpot-fixture';
const frontend = 'penpot-frontend';
const backend = 'penpot-backend';

function sample(service,bytes,ns,when) {
  return {service,raw:{read:new Date(when).toISOString(),memory_stats:{usage:bytes,stats:{inactive_file:1}},
    cpu_stats:{cpu_usage:{total_usage:ns}}}};
}

test('sums only whole, synchronized rounds and differences monotonic CPU counters', () => {
  const now = Date.now();
  const first = guestRound(1,2,[sample(frontend,10,0,now),sample(backend,90,0,now+1)],10);
  const second = guestRound(3,4,[sample(frontend,90,2e9,now+20),sample(backend,10,3e9,now+21)],10);
  const skew = guestRound(5,6,[sample(frontend,500,3e9,now+40),sample(backend,500,4e9,now+60)],10);
  const crossing = guestRound(7,12,[sample(frontend,500,4e9,now+90),sample(backend,500,5e9,now+91)],10);
  assert.equal(skew.chargedBytes,null);
  const summary = summarizeGuest([first,second,skew,crossing],{startMs:1,endMs:8,attested:true},true,1);
  assert.equal(summary.synchronizedMemoryRounds,2);
  assert.equal(summary.observedGuestChargedPeakBytes,100);
  assert.equal(summary.observedGuestCpuSeconds,7);
  assert.equal(summary.perContainer[frontend].observedChargedPeakBytes,500);
  assert.equal(summarizeGuest([first],{startMs:0,endMs:3,attested:false},true,1).observedGuestChargedPeakBytes,null);
  assert.equal(summarizeGuest([first],{startMs:0,endMs:3,attested:true},false,1).status,'INCOMPLETE');
});

test('keeps missing CPU, counter resets and early termination explicit', () => {
  const now = Date.now();
  const first = guestRound(1,2,[sample(frontend,10,2e9,now)],10);
  const second = guestRound(3,4,[sample(frontend,20,1e9,now+1)],10);
  assert.equal(summarizeGuest([first,second],{startMs:0,endMs:5,attested:true},true,1).observedGuestCpuSeconds,null);
  assert.equal(summarizeGuest([first],{startMs:0},true,1).status,'INCOMPLETE');
  const missing = guestRound(3,4,[{service:frontend,error:'Unavailable'}],10);
  assert.equal(missing.chargedBytes,null);
  assert.equal(missing.rows[0].cpuNs,null);
});

test('Unix Docker API enrolment, one-shot raw data and restart validation', async () => {
  const path = await mkdtemp(join(tmpdir(),'ppg-'));
  const socket = join(path,'docker.sock');
  const id = 'a'.repeat(64);
  const labels = {'com.docker.compose.project':project,'com.docker.compose.service':frontend};
  const inspected = {
    Id:id, Image:'sha256:'+'b'.repeat(64), Config:{Labels:labels,Env:['unrelated-secret']},
    State:{Running:true,StartedAt:'2026-11-17T08:00:00Z'},RestartCount:0,
  };
  let resolveStats;
  const observedStats = new Promise(resolve => { resolveStats = resolve; });
  const seen = [];
  const server = createServer((req,res) => {
    seen.push([req.method,req.url]);
    const stats = `/v1.53/containers/${id}/stats?stream=false&one-shot=true`;
    let result;
    if (req.url === '/version') result = {Os:'linux',Version:'fixture',ApiVersion:'1.53'};
    else if (req.url === '/v1.53/info') result = {CgroupVersion:'2'};
    else if (req.url.startsWith('/v1.53/containers/json?')) {
      result = [{Id:id,Labels:labels,Ports:[{Type:'tcp',PublicPort:19001}]}];
    } else if (req.url === `/v1.53/containers/${id}/json`) result = inspected;
    else if (req.url === stats) {
      result = {...sample(frontend,123,1,Date.now()).raw,id};
      resolveStats();
    } else {
      res.statusCode = 404;
      result = {};
    }
    res.end(JSON.stringify(result));
  });
  try {
    server.listen(socket);
    await once(server,'listening');
    const read = dockerReader(socket);
    const enrollment = await discoverGuest(read,project,[frontend]);
    assert.deepEqual(enrollment.frontendPublicPorts,[19001]);
    await assert.rejects(discoverGuest(read,project,[backend]), /Expected exactly one running/);
    await assert.rejects(discoverGuest(read,'shared-production',[frontend]), /task-owned benchmark/);
    const raw = join(path,'guest.jsonl');
    const collector = await openGuestCollector(raw,read,enrollment,{periodMs:100});
    collector.mark({command:'baseline'},performance.now(),performance.now());
    collector.start();
    try {
      await observedStats;
      inspected.RestartCount = 1;
      collector.mark({command:'replay'},performance.now(),performance.now());
    } finally {
      const summary = await collector.close();
      assert.equal(summary.stable,false);
      assert.match(summary.validationError,/Container changed/);
    }
    const evidence = await readFile(raw,'utf8');
    assert.ok(!evidence.includes('unrelated-secret'));
    assert.ok(seen.every(([method]) => method === 'GET'));
    assert.ok(evidence.includes('guest.sample'));
    assert.equal(evidence.trim().split('\n').map(JSON.parse).at(-1).type,'guest.summary');
  } finally {
    server.close();
    if (server.listening) await once(server,'close');
    await rm(path,{recursive:true,force:true});
  }
});
