import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {constants} from 'node:fs';
import {access, mkdir, mkdtemp, open, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';

import {fixture, target as edit} from './ld02-fixture.mjs';
import {Client, StreamableHTTPClientTransport} from './mcp.mjs';
import {openPhaseSampler} from './phase-sampler.mjs';

const binaryDir = process.env.OMC_BENCH_BIN_DIR ?? '/Applications/Oh My Canvas.app/Contents/MacOS';
const serviceBinary = join(binaryDir, 'omc-service');
const desktopBinary = join(binaryDir, 'omc-desktop');
const [mode, extra] = process.argv.slice(2);
assert.ok(extra === undefined && [undefined, '--agent', '--resource-replay'].includes(mode),
  'Usage: node omc-ld02.mjs [--agent | --resource-replay]');
const resourceReplay = mode === '--resource-replay';
const outputDir = process.env.OMC_BENCH_OUTPUT_DIR;
assert.ok(!mode || outputDir, 'Agent and resource modes require the runner output directory');
await Promise.all([access(serviceBinary, constants.X_OK), access(desktopBinary, constants.X_OK)]);

const id = (type, n) => `${type}_${BigInt(n).toString(16).padStart(32, '0')}`;
const rank = n => (BigInt(n) << 96n).toString(16).padStart(32, '0');
const nodes = {};

function put(kind, n, parentId, page, order, properties) {
  const key = id('node', n);
  nodes[key] = {id: key, kind, parentId, homeShard: id('shard', page), rank: rank(order), properties};
  return key;
}

const pages = fixture.pages.map((page, index) => {
  const pageNumber = index + 1;
  const base = index * 101;
  const root = put('frame', base + 1, null, pageNumber, 1, {name: page.name, width: 1280, height: 850});
  page.children.forEach((card, slot) => {
    const n = base + 2 + slot * 4;
    const parent = put('frame', n, root, pageNumber, slot + 1, {
      name: card.name, x: card.x, y: card.y, width: card.width, height: card.height,
      fill: '#ffffff',
      layout: {type: 'flex', direction: 'column', gap: card.gap, padding: card.padding},
    });
    for (const j of [0, 1]) {
      put('text', n + j + 1, parent, pageNumber, j + 1, {
        text: card.children[j].text, width: 180, height: 20,
        fontFamily: 'Inter', fontSize: 16, fill: '#222222',
      });
    }
    const swatch = card.children[2];
    put('rect', n + 3, parent, pageNumber, 3, {
      width: swatch.width, height: swatch.height, fill: swatch.fill,
    });
  });
  return {id: id('page', pageNumber), title: page.name, rootNodeId: root, rank: rank(pageNumber)};
});

const profile = await mkdtemp(join(tmpdir(), 'omc-ld02-'));
const client = new Client({name: 'omc-ld02-replay', version: '1'});
const cancellation = new AbortController();
for (const event of ['SIGTERM', 'SIGINT']) {
  process.once(event, () => cancellation.abort(new Error(`Interrupted by ${event}`)));
}
const {signal} = cancellation;
let service;
let desktop;
let sampler;

async function runAgent(endpoint, token) {
  const directory = join(profile, 'agent');
  await mkdir(directory, {mode: 0o700});
  const ledger = await open(join(outputDir, 'agent.jsonl'), 'wx', 0o600);
  const prompt = [
    `In the synthetic LD02 canvas, find the "${edit.card}" card on the "${edit.page}" page.`,
    `Change "${edit.before.text}" to "${edit.after.text}", the vertical gap to ${edit.after.gap}px,`,
    `and the swatch fill to ${edit.after.fill}. Preserve all other objects and properties.`,
    'Use only the OMC MCP tools supplied for this task. Do not use shell commands or delegate.',
  ].join(' ');
  const bearerVariable = 'OMC_BENCH_MCP_BEARER';
  try {
    const agent = spawn('codex', [
      'exec', '--ignore-user-config', '--ephemeral', '--skip-git-repo-check',
      '--sandbox', 'read-only', '-m', 'gpt-6.1-sol', '--json',
      '--disable', 'shell_tool', '--disable', 'unified_exec',
      '--cd', directory,
      '-c', `mcp_servers.omc.url=${JSON.stringify(new URL('/mcp', endpoint).href)}`,
      '-c', `mcp_servers.omc.bearer_token_env_var="${bearerVariable}"`,
      prompt,
    ], {
      cwd: directory,
      env: {...process.env, [bearerVariable]: token},
      stdio: ['ignore', ledger.fd, 'inherit'],
      signal,
    });
    const [code] = await once(agent, 'exit');
    assert.equal(code, 0, 'Codex CLI did not complete the diagnostic');
  } finally {
    await ledger.close();
  }
}

try {
  const path = join(profile, 'fixture.json');
  await writeFile(path, JSON.stringify({title: 'Synthetic LD02 Replay', pages, nodes, metadata: {}}));
  service = spawn(serviceBinary, ['--profile', profile, '--port', '0'], {stdio: 'inherit'});
  await once(service, 'spawn');

  let descriptor;
  for (let attempt = 0; attempt < 160 && !descriptor; attempt++) {
    signal.throwIfAborted();
    assert.ok(service.exitCode === null, 'OMC service exited during startup');
    try {
      descriptor = JSON.parse(await readFile(join(profile, 'native-v1/service.json'), 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
      await delay(25, undefined, {signal});
    }
  }
  assert.ok(descriptor, 'OMC service descriptor unavailable');
  const auth = {Authorization: `Bearer ${descriptor.token}`};
  assert.equal(new URL(descriptor.endpoint).hostname, '127.0.0.1');

  async function rpc(method, params = {}, session) {
    const response = await fetch(`${descriptor.endpoint}/rpc`, {
      method: 'POST',
      headers: {...auth, 'Content-Type': 'application/json', ...(session ? {'X-OMC-Session': session} : {})},
      body: JSON.stringify({id: randomUUID(), method, params}),
      signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
    });
    const payload = await response.json();
    assert.ok(!payload.error, JSON.stringify(payload.error));
    return payload.result;
  }

  await client.connect(new StreamableHTTPClientTransport(new URL(`${descriptor.endpoint}/mcp`), {
    requestInit: {headers: auth},
  }), {signal, timeout: 10_000});

  async function call(name, input) {
    const response = await client.callTool({name, arguments: input}, undefined, {signal, timeout: 30_000});
    assert.ok(!response.isError, JSON.stringify(response.content));
    return response.structuredContent ?? JSON.parse(response.content[0].text);
  }

  let imported = await call('import_document', {format: 'json', filePath: path});
  if (imported.jobId) {
    const {jobId} = imported;
    for (let attempt = 0; attempt < 200; attempt++) {
      const status = await call('native_job', {version: '1', action: 'status', jobId});
      if (status.state === 'completed') {
        imported = status.result;
        break;
      }
      assert.ok(!['failed', 'cancelled', 'interrupted'].includes(status.state), JSON.stringify(status));
      await delay(100, undefined, {signal});
    }
  }
  assert.match(imported.documentId ?? '', /^(?:doc_[0-9a-f]{32}|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/);
  const documentId = imported.documentId.startsWith('doc_')
    ? imported.documentId : `doc_${imported.documentId.replaceAll('-', '')}`;
  const external = documentId.slice(4).replace(/^(........)(....)(....)(....)(............)$/, '$1-$2-$3-$4-$5');
  desktop = spawn(desktopBinary, [
    '--profile', profile, '--automation-background',
    ...(mode ? [] : ['--smoke-exit-ms', '30000']),
  ], {stdio: 'inherit'});
  await once(desktop, 'spawn');
  for (let attempt = 0; attempt < 40; attempt++) {
    if ((await call('workspace', {action: 'state'})).window?.attached) break;
    await delay(150, undefined, {signal});
  }
  const opened = await call('workspace', {action: 'focus', documentId: external});
  assert.equal(opened.window.documentId, documentId);
  assert.equal(opened.window.windows[0].focused, false);
  const {sessionId} = await rpc('session.open');
  await rpc('workspace.open', {documentId}, sessionId);
  const snapshot = () => rpc('document.snapshot', {documentId}, sessionId);

  if (resourceReplay) {
    sampler = await openPhaseSampler(join(outputDir, 'product-resources'));
    await sampler.send({command: 'start', root_pids: [service.pid, desktop.pid]});
    await sampler.send({command: 'baseline'});
    await delay(60_000, undefined, {signal});
    await sampler.send({command: 'replay'});
  }
  const started = performance.now();
  const baseline = await snapshot();
  assert.equal(baseline.pages.length, fixture.pages.length);
  assert.equal(Object.keys(baseline.nodes).length, fixture.logicalObjects + fixture.pages.length);
  const page = baseline.pages.find(p => p.title === edit.page);
  assert.ok(page);
  const allNodes = Object.values(baseline.nodes);
  const card = allNodes.find(n => n.parentId === page.rootNodeId && n.properties.name === edit.card);
  assert.ok(card);
  const children = allNodes.filter(n => n.parentId === card.id).sort((a, b) => a.rank.localeCompare(b.rank));
  assert.equal(children.length, 3);
  const [label, reference, swatch] = children;
  assert.equal(label.properties.text, edit.before.text);
  assert.equal(reference.properties.text, edit.before.reference);
  assert.equal(card.properties.layout.gap, edit.before.gap);
  assert.equal(swatch.properties.fill, edit.before.fill);

  const targetEpoch = baseline.epoch;
  if (mode === '--agent') {
    await runAgent(descriptor.endpoint, descriptor.token);
  } else {
    const requestId = randomUUID();
    const layout = {...card.properties.layout, gap: edit.after.gap};
    await rpc('document.command', {envelope: {
      protocol: 'omc.engine/1', requestId, documentId, targetEpoch, idempotencyKey: requestId,
      preconditions: {revision: {epoch: targetEpoch, sequence: baseline.sequence}},
      command: {type: 'batch', commands: [
        {type: 'node.set', nodeId: card.id, properties: {layout}},
        {type: 'text.replace', nodeId: label.id, text: edit.after.text},
        {type: 'node.set', nodeId: swatch.id, properties: {fill: edit.after.fill}},
      ]},
    }}, sessionId);
  }

  const after = await snapshot();
  const editReadbackMs = performance.now() - started;
  assert.deepEqual(after.pages, baseline.pages);
  assert.deepEqual(Object.keys(after.nodes).sort(), Object.keys(baseline.nodes).sort());
  const changed = Object.keys(baseline.nodes)
    .filter(key => JSON.stringify(baseline.nodes[key]) !== JSON.stringify(after.nodes[key]));
  assert.deepEqual(changed.sort(), [card.id, label.id, swatch.id].sort());
  assert.equal(after.nodes[card.id].properties.layout.gap, edit.after.gap);
  assert.equal(after.nodes[label.id].properties.text, edit.after.text);
  assert.equal(after.nodes[swatch.id].properties.fill, edit.after.fill);
  if (mode === '--agent') {
    assert.equal(after.title, baseline.title);
    assert.deepEqual(after.metadata, baseline.metadata);
    assert.deepEqual(after.nodes[card.id], {
      ...card, properties: {...card.properties, layout: {...card.properties.layout, gap: edit.after.gap}},
    });
    assert.deepEqual(after.nodes[swatch.id], {
      ...swatch, properties: {...swatch.properties, fill: edit.after.fill},
    });
    const [run] = label.properties.textRuns;
    assert.equal(label.properties.textRuns.length, 1);
    assert.deepEqual(after.nodes[label.id], {
      ...label, properties: {
        ...label.properties, text: edit.after.text, textRuns: [{...run, text: edit.after.text}],
      },
    });
  }

  // The independent RPC session cannot undo operations from the closed agent MCP session.
  const undoRedoVerified = mode !== '--agent';
  if (undoRedoVerified) {
    await rpc('document.undo', {documentId, targetEpoch}, sessionId);
    assert.deepEqual((await snapshot()).nodes, baseline.nodes);
    await rpc('document.redo', {documentId, targetEpoch}, sessionId);
    assert.deepEqual((await snapshot()).nodes, after.nodes);
  }
  await rpc('document.save', {documentId}, sessionId);
  await rpc('workspace.close', {documentId}, sessionId);
  const reopened = await rpc('workspace.open', {documentId}, sessionId);
  assert.deepEqual(reopened.nodes, after.nodes);
  const verifiedWorkMs = performance.now() - started;
  if (resourceReplay) {
    await sampler.send({command: 'tail', replay_complete: true});
    await delay(30_000, undefined, {signal});
    await sampler.send({command: 'stop', tail_complete: true});
  }

  console.log(JSON.stringify({
    workload: fixture.workload,
    measurement: mode === '--agent' ? 'model-assisted-diagnostic' : 'deterministic-replay',
    ...(resourceReplay && {resourceEvidence: 'product-resources'}),
    editReadbackMs,
    ...(undoRedoVerified
      ? {serviceSaveUndoRedoReopenMs: verifiedWorkMs}
      : {agentSaveRebindMs: performance.now() - started, undoRedoVerified}),
    logicalObjects: fixture.logicalObjects,
    pages: fixture.pages.length,
    changed: changed.length,
  }));
} finally {
  await sampler?.close().catch(() => {});
  await client.close().catch(() => {});
  for (const child of [desktop, service]) {
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    }
  }
  await rm(profile, {recursive: true, force: true});
}
