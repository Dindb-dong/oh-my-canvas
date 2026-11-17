import assert from 'node:assert/strict';
import {open} from 'node:fs/promises';
import {request} from 'node:http';
import {setTimeout as delay} from 'node:timers/promises';

const serviceName = /^penpot-[a-z-]+$/;
const containerId = /^[a-f0-9]{64}$/;
const units = 'Linux Docker cgroup-charged bytes and cumulative container CPU nanoseconds';

export function dockerReader(socketPath) {
  assert.ok(socketPath.startsWith('/'), 'Provide the absolute Unix socket of the local Docker Engine');
  return (path, signal) => new Promise((resolve, reject) => {
    const socket = request({socketPath, path, method:'GET', signal: AbortSignal.any([
      AbortSignal.timeout(2500), ...(signal ? [signal] : []),
    ])}, response => {
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`Docker API HTTP ${response.statusCode}`));
        return;
      }
      const chunks = [];
      let size = 0;
      response.on('data', chunk => {
        size += chunk.length;
        if (size > 1024 ** 2) response.destroy(new Error('Docker API response exceeds 1 MiB'));
        else chunks.push(chunk);
      });
      response.on('error', reject);
      response.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch (error) {
          reject(error);
        }
      });
    });
    socket.once('error', reject);
    socket.end();
  });
}

function identity(row, id, project, service) {
  assert.equal(row.Id,id);
  assert.equal(row.Config?.Labels?.['com.docker.compose.project'],project);
  assert.equal(row.Config?.Labels?.['com.docker.compose.service'],service);
  assert.equal(row.State?.Running,true);
  assert.ok(/^sha256:[a-f0-9]{64}$/.test(row.Image) && typeof row.State.StartedAt === 'string'
    && Number.isInteger(row.RestartCount), 'Incomplete container restart/image identity');
  return {
    id, service, imageId:row.Image, startedAt:row.State.StartedAt, restartCount:row.RestartCount,
  };
}

export async function discoverGuest(read, project, services) {
  assert.match(project,/^omc-perf-penpot(?:-[a-z0-9-]+)?$/,'Use a task-owned benchmark Compose project');
  assert.ok(services.length && new Set(services).size === services.length && services.every(name => serviceName.test(name)),
    'List each required Penpot Compose service once');
  const version = await read('/version');
  assert.equal(version.Os, 'linux');
  assert.ok(/^1\.[0-9]+$/.test(version.ApiVersion) && Number(version.ApiVersion.split('.')[1]) >= 41,
    'Docker Engine API must support one-shot container stats');
  const endpoint = `/v${version.ApiVersion}`;
  const info = await read(`${endpoint}/info`);
  assert.equal(info.CgroupVersion, '2', 'This guest panel requires Linux cgroup v2');
  const filters = encodeURIComponent(JSON.stringify({label:[`com.docker.compose.project=${project}`]}));
  const candidates = await read(`${endpoint}/containers/json?filters=${filters}`);
  const selected = await Promise.all(services.map(async service => {
    const matches = candidates.filter(row => row.Labels?.['com.docker.compose.project'] === project
      && row.Labels?.['com.docker.compose.service'] === service);
    assert.ok(matches.length === 1 && containerId.test(matches[0].Id),
      `Expected exactly one running task container for ${service}`);
    const {Id:id} = matches[0];
    return identity(await read(`${endpoint}/containers/${id}/json`),id,project,service);
  }));
  const extras = candidates.filter(row => row.Labels?.['com.docker.compose.project'] === project
    && !selected.some(container => row.Id === container.id))
    .map(row => ({id:row.Id, service:row.Labels?.['com.docker.compose.service']}));
  const frontendId = selected.find(row => row.service === 'penpot-frontend')?.id;
  const frontendPublicPorts = candidates.find(row => row.Id === frontendId)?.Ports?.filter(
    port => port.Type === 'tcp' && Number.isSafeInteger(port.PublicPort),
  ).map(port => port.PublicPort) ?? [];
  return {project, selected, extras, frontendPublicPorts, cgroupVersion:info.CgroupVersion,
    engineVersion:version.Version, engineApi:version.ApiVersion, endpoint, os:version.Os};
}

function counter(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function guestRound(startMs, endMs, results, maxSkewMs) {
  const rows = results.map(({service, raw, error}) => {
    const memory = raw?.memory_stats;
    const usage = counter(memory?.usage);
    const inactive = counter(memory?.stats?.inactive_file);
    const readMs = Date.parse(raw?.read);
    const cpu = counter(raw?.cpu_stats?.cpu_usage?.total_usage);
    return {
      service, chargedBytes:usage,
      cacheAdjustedBytes:usage !== null && inactive !== null && inactive <= usage ? usage-inactive : null,
      cpuNs:cpu, daemonReadMs:Number.isFinite(readMs) && readMs > 0 ? readMs : null, error,
    };
  });
  const daemonTimes = rows.map(row => row.daemonReadMs);
  const daemonSkewMs = daemonTimes.includes(null) ? null : Math.max(...daemonTimes)-Math.min(...daemonTimes);
  const acquisitionMs = endMs-startMs;
  const synchronized = daemonSkewMs !== null && daemonSkewMs <= maxSkewMs && acquisitionMs <= maxSkewMs;
  const chargedBytes = synchronized && rows.every(row => row.chargedBytes !== null)
    ? rows.reduce((sum,row) => sum+row.chargedBytes,0) : null;
  return {startMs,endMs,acquisitionMs,daemonSkewMs,chargedBytes,rows};
}

export function summarizeGuest(rounds, window, stable, periodMs) {
  if (!window) return null;
  const {startMs,endMs,attested} = window;
  if (endMs === undefined) return {status:'INCOMPLETE',durationMs:null,reason:'Unclosed phase'};
  const eligible = rounds.filter(row => row.startMs >= startMs && row.endMs <= endMs);
  const memory = eligible.filter(row => row.chargedBytes !== null);
  const gap = eligible.length > 1 ? Math.max(...eligible.slice(1).map(
    (row,index) => row.startMs-eligible[index].startMs,
  )) : null;
  const observed = stable && attested && memory.length > 0;
  const perContainer = {};
  for (const {service} of eligible[0]?.rows ?? []) {
    const all = eligible.map(round => round.rows.find(row => row.service === service));
    const cpu = all.map(row => row.cpuNs);
    const complete = cpu.length >= 2 && cpu.every((value,index) =>
      value !== null && (index === 0 || value >= cpu[index-1]));
    const bytes = all.flatMap(row => row.chargedBytes === null ? [] : [row.chargedBytes]);
    perContainer[service] = {
      observedCpuSeconds: stable && attested && complete ? (cpu.at(-1)-cpu[0])/1e9 : null,
      observedChargedPeakBytes: stable && attested && bytes.length ? Math.max(...bytes) : null,
    };
  }
  const cpuSum = Object.values(perContainer).map(row => row.observedCpuSeconds);
  const maximumGapExceeded = gap !== null && gap > 3*periodMs;
  return {
    durationMs:endMs-startMs, attested, rounds:eligible.length, synchronizedMemoryRounds:memory.length,
    maxRoundGapMs:gap, maximumGapExceeded,
    observedGuestChargedPeakBytes:observed ? Math.max(...memory.map(row => row.chargedBytes)) : null,
    observedGuestCpuSeconds:cpuSum.length && !cpuSum.includes(null) ? cpuSum.reduce((a,b)=>a+b,0) : null,
    perContainer,
    status: !stable || !attested ? 'INCOMPLETE' : !eligible.length ? 'NOT_OBSERVABLE' : 'DIAGNOSTIC',
  };
}

export async function openGuestCollector(file, read, enrollment, {periodMs=1000,maxSkewMs=250}={}) {
  assert.ok(Number.isFinite(periodMs) && periodMs > 0 && Number.isFinite(maxSkewMs) && maxSkewMs > 0);
  const {endpoint} = enrollment;
  const log = await open(file,'wx',0o600);
  const save = item => log.writeFile(JSON.stringify(item)+'\n');
  const rounds = [];
  const phases = {};
  const stop = new AbortController();
  let active, running;
  await save({type:'guest.header',units,periodMs,maxSkewMs,enrollment,clock:'Node performance.now() inside controller'});
  async function collect() {
    while (!stop.signal.aborted) {
      const startMs = performance.now();
      const results = await Promise.all(enrollment.selected.map(async ({id,service}) => {
        try {
          const raw = await read(`${endpoint}/containers/${id}/stats?stream=false&one-shot=true`,stop.signal);
          if (raw.id !== undefined) assert.equal(raw.id,id);
          return {service,raw};
        } catch (error) {
          return {service,error:error.message};
        }
      }));
      const endMs = performance.now();
      const round = guestRound(startMs,endMs,results,maxSkewMs);
      rounds.push(round);
      await save({type:'guest.sample',...round,raw:results});
      await delay(Math.max(0,periodMs-(performance.now()-startMs)),undefined,{signal:stop.signal})
        .catch(error => { if (!stop.signal.aborted) throw error; });
    }
  }
  return {
    start() {
      assert.equal(running,undefined);
      running = collect().then(() => null, error => error.message);
    },
    mark(command, beforeMs, afterMs) {
      if (active) {
        phases[active].endMs = beforeMs;
        phases[active].attested = active === 'replay' ? command.replay_complete
          : active === 'tail' ? command.tail_complete : true;
      }
      active = command.command === 'stop' ? undefined : command.command;
      if (active) phases[active] = {startMs:afterMs};
    },
    async close() {
      stop.abort();
      const collectorError = await running;
      let stable = !collectorError;
      let validationError;
      try {
        for (const row of enrollment.selected) {
          const observed = identity(await read(`${endpoint}/containers/${row.id}/json`),
            row.id,enrollment.project,row.service);
          assert.deepEqual(observed,row,`Container changed during resource window: ${row.service}`);
        }
      } catch (error) {
        stable = false;
        validationError = error.message;
      }
      const primary = phases.replay && phases.tail && {
        startMs:phases.replay.startMs,endMs:phases.tail.endMs,
        attested:phases.replay.attested === true && phases.tail.attested === true,
      };
      const summary = {
        type:'guest.summary',units,stable,collectorError,validationError,
        phases:Object.fromEntries(Object.entries(phases).map(([phase,window]) => [
          phase,summarizeGuest(rounds,window,stable,periodMs),
        ])),
        primaryReplayAndTail:summarizeGuest(rounds,primary,stable,periodMs),
      };
      try {
        await save(summary);
      } finally {
        await log.close();
      }
      return summary;
    },
  };
}
