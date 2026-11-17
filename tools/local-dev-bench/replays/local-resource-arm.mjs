import assert from 'node:assert/strict';
import {execFileSync, spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdir, writeFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';

import {openPhaseSampler} from './phase-sampler.mjs';

export async function runPhases(sampler, options, replay, tailCheck, pause) {
  const {rootPids, baselineSeconds, tailSeconds, maxTailSeconds, intervalSeconds} = options;
  const ready = await sampler.send({
    command: 'start', root_pids: rootPids, baseline_seconds: baselineSeconds,
    tail_seconds: tailSeconds, max_tail_seconds: maxTailSeconds, interval_seconds: intervalSeconds,
  });
  const baseline = await sampler.send({command: 'baseline'});
  await pause(baselineSeconds);
  const active = await sampler.send({command: 'replay'});
  const execution = await replay();
  const tail = await sampler.send({command: 'tail', replay_complete: execution.exitCode === 0});
  await pause(tailSeconds);
  const tailVerification = execution.exitCode === 0 && tailCheck ? await tailCheck() : null;
  const stopped = await sampler.send({command: 'stop', tail_complete: tailVerification?.exitCode === 0});
  return {ready, baseline, active, execution, tail, tailVerification, stopped};
}

function number(input, name) {
  const result = Number(input);
  assert.ok(Number.isFinite(result) && result > 0, `${name} requires a positive finite number`);
  return result;
}

function runCommand(argv, signal) {
  const started = performance.now();
  return new Promise(resolve => {
    // The deterministic replay driver is excluded from the watched product roots.
    const child = spawn(argv[0], argv.slice(1), {stdio: ['ignore', 2, 2], signal, killSignal: 'SIGKILL'});
    let launchError;
    child.once('error', error => { launchError = error.code ?? error.name; });
    child.once('close', (exitCode, exitSignal) => {
      resolve({exitCode, exitSignal, launchError, elapsedMs: performance.now() - started});
    });
  });
}

function getRootProcesses(rootPids) {
  const listing = execFileSync('/bin/ps', ['-p', rootPids.join(','), '-o', 'pid=,ppid=,lstart=,comm='],
    {encoding: 'utf8'});
  const roots = listing.trim().split('\n').map(line => line.trim());
  assert.deepEqual(roots.map(line => Number(line.split(/\s+/, 1)[0])).sort((a, b) => a - b), rootPids,
    'Every declared process must be live at enrollment');
  return roots;
}

async function main() {
  const raw = process.argv.slice(2);
  const separator = raw.indexOf('--');
  assert.ok(separator >= 0 && raw.length > separator + 1, 'Supply one deterministic replay after --');
  const {values} = parseArgs({args: raw.slice(0, separator), options: {
    output: {type: 'string'}, scope: {type: 'string'}, 'root-pid': {type: 'string', multiple: true},
    'baseline-seconds': {type: 'string', default: '60'},
    'tail-seconds': {type: 'string', default: '30'},
    'max-tail-seconds': {type: 'string', default: '90'},
    'interval-seconds': {type: 'string', default: '0.05'},
    'replay-timeout-seconds': {type: 'string', default: '180'},
    'tail-check': {type: 'string'},
  }});
  assert.ok(values.output && values.scope?.trim() && values['root-pid']?.length,
    '--output, --scope and at least one --root-pid are required');
  const rootPids = [...new Set(values['root-pid'].map(pid => number(pid, 'root-pid')))].sort((a, b) => a - b);
  assert.ok(rootPids.every(pid => Number.isInteger(pid) && pid < 2 ** 31), 'Invalid root PID');
  const options = {
    rootPids,
    baselineSeconds: number(values['baseline-seconds'], 'baseline-seconds'),
    tailSeconds: number(values['tail-seconds'], 'tail-seconds'),
    maxTailSeconds: number(values['max-tail-seconds'], 'max-tail-seconds'),
    intervalSeconds: number(values['interval-seconds'], 'interval-seconds'),
    replayTimeoutSeconds: number(values['replay-timeout-seconds'], 'replay-timeout-seconds'),
  };
  assert.ok(options.maxTailSeconds > options.tailSeconds, 'max-tail-seconds must exceed tail-seconds');
  const argv = raw.slice(separator + 1);
  const output = resolve(values.output);
  const report = {
    schemaVersion: 1, scope: values.scope, options, enrolledProcesses: getRootProcesses(rootPids),
    replayArgvSha256: createHash('sha256').update(JSON.stringify(argv)).digest('hex'),
    startedUtc: new Date().toISOString(),
  };
  await mkdir(output, {mode: 0o700});
  const stop = new AbortController();
  for (const signame of ['SIGINT', 'SIGTERM']) process.once(signame, () => stop.abort(new Error(signame)));
  let sampler;
  try {
    sampler = await openPhaseSampler(join(output, 'product-resources'));
    report.phases = await runPhases(
      sampler, options,
      () => runCommand(argv, AbortSignal.any([
        stop.signal, AbortSignal.timeout(Math.ceil(options.replayTimeoutSeconds * 1000)),
      ])),
      values['tail-check'] && (() => runCommand([resolve(values['tail-check'])], AbortSignal.any([
        stop.signal, AbortSignal.timeout(Math.ceil((options.maxTailSeconds - options.tailSeconds) * 1000)),
      ]))),
      seconds => delay(seconds * 1000, undefined, {signal: stop.signal}),
    );
  } catch (error) {
    report.error = error.message;
  } finally {
    try {
      await sampler?.close();
    } catch (error) {
      report.error ??= error.message;
    }
    const path = join(output, 'arm.json');
    await writeFile(path, JSON.stringify(report, null, 2) + '\n', {mode: 0o600, flag: 'wx'});
    console.log(JSON.stringify({report: path, phaseCompleteness: report.phases?.stopped.phase_completeness,
      error: report.error}));
  }
  if (report.error || Object.values(report.phases.stopped.phase_completeness).some(state => state !== 'COMPLETE')) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await main();
