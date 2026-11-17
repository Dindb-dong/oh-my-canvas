import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createHash, randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {createReadStream, constants} from 'node:fs';
import {access, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {basename, join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {parseArgs} from 'node:util';

import {makeFixture, targetNodeName} from './fixture.mjs';
import {historySchedule, measureHistory} from './history.mjs';
import {collectDesktopTrace, measureRendering} from './rendering.mjs';
import {contentionSchedule, measureContention} from './contention.mjs';

const {values} = parseArgs({options: {
  experiment: {type: 'string'},
  nodes: {type: 'string'},
  depth: {type: 'string', default: '1'},
  desktop: {type: 'string'},
  samples: {type: 'string', default: '5'},
  'css-rules': {type: 'string', default: '0'},
  'history-edits': {type: 'string'},
  'history-shape': {type: 'string'},
  'ui-docs': {type: 'string'},
  'background-streams': {type: 'string'},
  'fixture-only': {type: 'boolean', default: false},
}});
const {experiment} = values;
const isHistory = experiment === 'N-C';
const isRendering = experiment === 'N-D';
const isContention = ['N-E', 'LD08'].includes(experiment);
const desktop = values.desktop ?? (isRendering || isContention ? 'attached' : 'headless');
const nodeCount = Number(values.nodes ?? (isHistory ? 17 : isRendering || isContention ? 1000 : NaN));
const depth = Number(values.depth);
const sampleCount = Number(values.samples);
const cssRules = Number(values['css-rules']);
assert.ok(['N-A', 'N-B', 'N-C', 'N-D', 'N-E', 'LD08'].includes(experiment),
  '--experiment must be N-A, N-B, N-C, N-D, N-E or LD08');
assert.ok(isHistory ? nodeCount === 17 : [1000, 10000, 100000].includes(nodeCount) || (experiment === 'N-B' && nodeCount === 100),
  '--nodes must be 1000, 10000, 100000, 100 for the N-B baseline, or 17 for N-C');
assert.ok([1, 32].includes(depth), '--depth must be 1 or 32');
assert.ok(['headless', 'attached'].includes(desktop), '--desktop must be headless or attached');
assert.ok(Number.isInteger(sampleCount) && sampleCount >= 1 && sampleCount <= 50, '--samples must be 1–50');
assert.ok(Number.isInteger(cssRules) && cssRules >= 0 && cssRules <= 1000, '--css-rules must be 0–1000');
assert.ok(experiment === 'N-B' || !cssRules, '--css-rules is specific to N-B');
assert.ok(isHistory || (values['history-edits'] === undefined && values['history-shape'] === undefined),
  '--history-edits and --history-shape are specific to N-C');
assert.ok(!isHistory || (depth === 1 && desktop === 'headless'), 'N-C uses a fixed headless fixture at depth 1');
assert.ok(!isRendering || desktop === 'attached', 'N-D requires the isolated background desktop');
assert.ok(isContention || (values['ui-docs'] === undefined && values['background-streams'] === undefined),
  '--ui-docs and --background-streams are specific to N-E/LD08');
assert.ok(!isContention || (desktop === 'attached' && nodeCount === 1000 && depth === 1),
  'N-E/LD08 uses the fixed 1,000-node depth-1 fixture and the isolated background desktop');
const uiDocs = Number(values['ui-docs'] ?? 1);
const streams = Number(values['background-streams'] ?? 0);
assert.ok([1, 5, 10].includes(uiDocs), '--ui-docs must be 1, 5 or 10');
assert.ok([0, 1, 4].includes(streams), '--background-streams must be 0, 1 or 4');
const historyEdits = Number(values['history-edits'] ?? 0);
const historyPlacement = values['history-shape'] ?? 'concentrated';
assert.ok(Number.isInteger(historyEdits) && historyEdits >= 0 && historyEdits <= 100_000 && historyEdits % 2 === 0,
  '--history-edits must be an even number from 0 through 100000');
assert.ok(['concentrated', 'distributed'].includes(historyPlacement), '--history-shape must be concentrated or distributed');

let {document, summary} = makeFixture({experiment: isRendering || isContention ? 'N-A' : experiment, nodeCount, depth, cssRules});
let input = JSON.stringify(document);
const expectedCss = document.metadata.css;
const authoredShapes = isHistory
  ? Object.values(document.nodes).filter(node => node.kind === 'rect').map(node => node.properties)
  : [];
assert.equal(Object.keys(document.nodes).length, summary.documentNodeCount);
document = null;
const report = {
  schemaVersion: 1,
  measurementKind: 'native-stage-diagnostic',
  experiment,
  fixture: {
    nodeCount, depth, cssRules, inputBytes: Buffer.byteLength(input), ...summary,
    sha256: createHash('sha256').update(input).digest('hex'),
  },
  desktop,
  binaries: {},
  stages: {},
  samples: [],
  unavailable: {
    sceneReadyMs: 'No revision-linked native scene telemetry exposed by the installed binary.',
    frameSubmitMs: 'No revision-linked frame submission exposed for this RPC edit.',
    framePresentMs: 'Presentation is unobserved in the background profile.',
    activeInteractionP95Ms: 'The probe does not drive an interactive input workload.',
    styledActiveNodes: 'The installed path does not expose active-scene style counts.',
    indexedActiveNodes: 'The installed path does not expose active-scene index counts.',
  },
};
if (isHistory) {
  const editsPerTarget = Array(authoredShapes.length).fill(0);
  const terminalDelta = Array(authoredShapes.length).fill(0);
  for (const {target, delta} of historySchedule(historyEdits, historyPlacement, authoredShapes.length)) {
    editsPerTarget[target]++;
    terminalDelta[target] = delta;
  }
  assert.ok(terminalDelta.every(delta => delta === 0));
  report.history = {priorEdits: historyEdits, placement: historyEdits ? historyPlacement : 'fresh', editsPerTarget};
  report.unavailable.historyReplayCpu = 'No isolated operation-replay CPU counter exposed by the installed path.';
  report.unavailable.tombstoneRetention = 'This diagnostic ages scalar coordinates only.';
}
if (isRendering) {
  report.rendering = {
    condition: 'isolated background desktop',
    input: 'FigCraft MCP viewport automation',
    frameTraceEnabled: true,
    metalPhaseSamples: null,
  };
  report.unavailable.cacheOutcomes = 'The installed desktop automation does not expose cache hits or misses.';
  report.unavailable.inputToSubmit = 'These automation commands do not trigger OS input trace markers.';
  report.unavailable.frameSubmitMs = 'No submission is linked to an individual automation command.';
  report.unavailable.gpuCompletion = 'Metal phase traces record CPU-side calls only.';
}
if (isContention) {
  report.contention = {uiDocs, streams, schedule: contentionSchedule(sampleCount, streams)};
  report.unavailable.activeInteractionP95Ms = 'No physical input-to-visible observations from the isolated background desktop.';
  report.unavailable.serviceQueueWaitMs = 'Only client offer, dispatch, and response times are observed per request.';
  report.unavailable.assetResidency = 'The qualification fixture contains geometry only.';
}

async function hashFile(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function stop(child, exitSignal = 'SIGTERM') {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill(exitSignal);
  const deadline = setTimeout(() => child.kill('SIGKILL'), exitSignal === 'SIGINT' ? 10_000 : 2_000);
  try {
    await exited;
  } finally {
    clearTimeout(deadline);
  }
}

async function run() {
  const {Client, StreamableHTTPClientTransport} = await import('../replays/mcp.mjs');
  const directory = process.env.OMC_BENCH_BIN_DIR ?? '/Applications/Oh My Canvas.app/Contents/MacOS';
  const serviceBinary = join(directory, 'omc-service');
  const desktopBinary = join(directory, 'omc-desktop');
  for (const [name, path] of [['service', serviceBinary], ['desktop', desktopBinary]]) {
    if (name === 'desktop' && desktop === 'headless') continue;
    await access(path, constants.X_OK);
    report.binaries[name] = {name: basename(path), sha256: await hashFile(path)};
  }

  const profile = await mkdtemp(join(tmpdir(), 'omc-native-probe-'));
  const cancellation = new AbortController();
  for (const event of ['SIGTERM', 'SIGINT']) {
    process.once(event, () => cancellation.abort(new Error(`Interrupted by ${event}`)));
  }
  const {signal} = cancellation;
  let service;
  let window;
  let client;
  let renderingClient;
  let endpoint;
  let auth;
  try {
    const source = join(profile, 'fixture.json');
    const contentionSource = isContention ? Buffer.from(input).toString('base64') : undefined;
    await writeFile(source, input, {mode: 0o600});
    input = null;
    const descriptorPath = join(profile, 'native-v1/service.json');

    async function startService() {
      const startup = performance.now();
      service = spawn(serviceBinary, ['--profile', profile, '--port', '0'], {stdio: ['ignore', 2, 2]});
      await once(service, 'spawn');
      let descriptor;
      while (!descriptor && performance.now() - startup < 10_000) {
        signal.throwIfAborted();
        assert.ok(service.exitCode === null && service.signalCode === null, 'OMC service exited during setup');
        try {
          const published = JSON.parse(await readFile(descriptorPath, 'utf8'));
          if (published.pid === service.pid) descriptor = published;
        } catch (error) {
          if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
        }
        if (!descriptor) await delay(25, undefined, {signal});
      }
      assert.ok(descriptor, 'OMC service descriptor unavailable');
      endpoint = new URL(descriptor.endpoint);
      assert.equal(endpoint.hostname, '127.0.0.1');
      auth = {Authorization: `Bearer ${descriptor.token}`};
      return performance.now() - startup;
    }

    report.stages.serviceDescriptorMs = await startService();

    async function rpc(method, params = {}, session, timeout = 120_000) {
      const body = JSON.stringify({id: randomUUID(), method, params});
      const start = performance.now();
      const response = await fetch(new URL('/rpc', endpoint), {
        method: 'POST',
        headers: {...auth, 'Content-Type': 'application/json', ...(session ? {'X-OMC-Session': session} : {})},
        body,
        signal: AbortSignal.any([signal, AbortSignal.timeout(timeout)]),
      });
      const bytes = await response.arrayBuffer();
      const receivedAt = performance.now();
      assert.ok(response.ok, `${method}: HTTP ${response.status}`);
      const payload = JSON.parse(Buffer.from(bytes).toString('utf8'));
      const parsedAt = performance.now();
      assert.ok(!payload.error, `${method}: ${payload.error?.code ?? 'RPC error'}`);
      return {
        result: payload.result,
        elapsedMs: parsedAt - start,
        responseMs: receivedAt - start,
        decodeAndParseMs: parsedAt - receivedAt,
        jsonBodyBytes: bytes.byteLength,
      };
    }

    async function call(name, args, timeout = 120_000, caller = client) {
      const response = await caller.callTool({name, arguments: args}, undefined, {signal, timeout});
      assert.ok(!response.isError, `${name} returned an MCP error`);
      return response.structuredContent ?? JSON.parse(response.content[0].text);
    }

    client = new Client({name: 'omc-native-stage-probe', version: '1'});
    const mcpStarted = performance.now();
    await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', endpoint), {
      requestInit: {headers: auth},
    }), {signal, timeout: 10_000});
    report.stages.mcpConnectMs = performance.now() - mcpStarted;

    const importStarted = performance.now();
    let imported = await call('import_document', {format: 'json', filePath: source});
    if (imported.jobId) {
      const {jobId} = imported;
      while (performance.now() - importStarted < 180_000) {
        const status = await call('native_job', {version: '1', action: 'status', jobId});
        if (status.state === 'completed') {
          imported = status.result;
          break;
        }
        assert.ok(!['failed', 'cancelled', 'interrupted'].includes(status.state), `Import ${status.state}`);
        await delay(100, undefined, {signal});
      }
    }
    assert.match(imported.documentId ?? '', /^(?:doc_[0-9a-f]{32}|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/);
    report.stages.importAndPollMs = performance.now() - importStarted;
    await rm(source);
    const documentId = imported.documentId.startsWith('doc_')
      ? imported.documentId : `doc_${imported.documentId.replaceAll('-', '')}`;

    const external = documentId.slice(4).replace(/^(........)(....)(....)(....)(............)$/, '$1-$2-$3-$4-$5');
    let trace;
    if (desktop === 'attached') {
      const windowStarted = performance.now();
      window = spawn(desktopBinary, ['--profile', profile, '--automation-background'], {
        stdio: ['ignore', 2, isRendering ? 'pipe' : 2],
        env: isRendering ? {...process.env, OMC_NATIVE_FRAME_TRACE: '1'} : process.env,
      });
      if (isRendering) trace = collectDesktopTrace(window.stderr);
      await once(window, 'spawn');
      let attached = false;
      while (performance.now() - windowStarted < 30_000) {
        assert.ok(window.exitCode === null && window.signalCode === null, 'OMC desktop exited during setup');
        if ((await call('workspace', {action: 'state'}, 5_000)).window?.attached) {
          attached = true;
          break;
        }
        await delay(100, undefined, {signal});
      }
      assert.ok(attached, 'Isolated background desktop did not attach');
      report.stages.desktopAttachMs = performance.now() - windowStarted;
      const focusStarted = performance.now();
      const opened = await call('workspace', {action: 'focus', documentId: external});
      assert.equal(opened.window?.documentId, documentId);
      assert.equal(opened.window.windows[0].focused, false);
      report.stages.desktopOpenMs = performance.now() - focusStarted;
    }

    const {result: {sessionId}} = await rpc('session.open');
    let {result: initial, ...workspaceOpen} = await rpc('workspace.open', {documentId}, sessionId);
    report.stages.workspaceOpen = workspaceOpen;
    assert.equal(initial.pages.length, summary.pageCount);
    assert.equal(Object.keys(initial.nodes).length, summary.documentNodeCount);
    if (isHistory) {
      await measureHistory({
        rpc, restart, signal, profile, documentId, sessionId, initial, authoredShapes, report,
        placement: historyPlacement, edits: historyEdits, samples: sampleCount,
      });
      return;
    }
    if (isRendering || isContention) {
      renderingClient = new Client({name: 'omc-native-rendering-probe', version: '1'});
      await renderingClient.connect(new StreamableHTTPClientTransport(new URL('/mcp/figcraft', endpoint), {
        requestInit: {headers: auth},
      }), {signal, timeout: 10_000});
    }
    if (isContention) {
      await measureContention({
        report, rpc, legacy: call, figcraft: (name, args, timeout) => call(name, args, timeout, renderingClient),
        signal, contentBase64: contentionSource, foreground: initial, sessionId,
      });
      return;
    }
    if (isRendering) {
      await measureRendering({
        call: (name, args) => call(name, args, 15_000, renderingClient),
        documentId: external, report, sampleCount, signal, trace,
      });
      const {result: final} = await rpc('document.snapshot', {documentId}, sessionId);
      assert.deepEqual(final, initial, 'Viewport automation leaves the canonical document unchanged');
      report.rendering.canonicalDocumentUnchanged = true;
      return;
    }
    // Native JSON import remaps IDs. Resolve the sole named target from the imported state.
    let targets = Object.values(initial.nodes).filter(node => node.properties.name === targetNodeName);
    assert.equal(targets.length, 1);
    const [{id: targetNodeId, properties: targetProperties}] = targets;
    targets = null;
    assert.equal(targetProperties.x, 0);
    if (expectedCss !== undefined) assert.equal(initial.metadata.css, expectedCss, 'Imported inactive CSS');
    const {epoch, sequence: startSequence} = initial;
    initial = null;
    let sequence = startSequence;
    for (let i = 0; i < sampleCount; i++) {
      signal.throwIfAborted();
      const sample = {index: i + 1};
      report.samples.push(sample);
      const x = i + 1;
      const requestId = randomUUID();
      const {result: receipt, ...durable} = await rpc('document.command', {envelope: {
        protocol: 'omc.engine/1', requestId, documentId, targetEpoch: epoch, idempotencyKey: requestId,
        preconditions: {revision: {epoch, sequence}}, command: {
          type: 'node.set', nodeId: targetNodeId, properties: {x},
        },
      }}, sessionId);
      sample.durableRpc = durable;
      assert.equal(receipt.status, 'durable');
      const previousSequence = sequence;
      sequence = await readEditedSnapshot(sample, 'fullSnapshot', x);
      assert.ok(sequence > previousSequence, 'The edit advanced the revision');
      const changedSequence = await readEditedSnapshot(sample, 'conditionalChanged', x, previousSequence);
      assert.equal(changedSequence, sequence);
      const {result: unchanged, ...conditional} = await rpc('document.snapshot', {
        documentId, ifRevision: {epoch, sequence},
      }, sessionId);
      sample.conditionalUnchanged = conditional;
      assert.equal(unchanged, null);
      sample.verified = true;
    }

    async function readEditedSnapshot(sample, stage, x, priorSequence) {
      const {result, ...metrics} = await rpc('document.snapshot', {
        documentId,
        ...(priorSequence === undefined ? {} : {ifRevision: {epoch, sequence: priorSequence}}),
      }, sessionId);
      sample[stage] = metrics;
      assert.equal(result.epoch, epoch);
      assert.equal(result.nodes[targetNodeId].properties.x, x);
      return result.sequence;
    }

    async function restart() {
      const started = performance.now();
      await client.close();
      client = undefined;
      await stop(service, 'SIGINT');
      assert.equal(service.exitCode, 0, 'OMC service must exit normally before the reopen timing');
      report.stages.gracefulShutdownMs = performance.now() - started;
      report.stages.restartedServiceDescriptorMs = await startService();
    }
  } finally {
    try {
      await Promise.all([stop(window), client?.close(), renderingClient?.close()]);
    } finally {
      await stop(service, isHistory ? 'SIGINT' : 'SIGTERM');
      await rm(profile, {recursive: true, force: true, maxRetries: 10});
    }
  }
}

try {
  if (values['fixture-only']) {
    report.status = 'fixture-only';
  } else {
    await run();
    report.status = 'verified';
  }
} catch (error) {
  report.status = 'failed';
  report.error = error.message;
  process.exitCode = 1;
}
console.log(JSON.stringify(report, null, 2));
