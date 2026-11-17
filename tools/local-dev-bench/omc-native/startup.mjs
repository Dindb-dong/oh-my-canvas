import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createHash, randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {basename, join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {parseArgs} from 'node:util';
import {fileURLToPath} from 'node:url';

import {makeFixture, targetNodeName} from './fixture.mjs';

const PREFIX = 'Synthetic N-F';
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export function plan(count, distractorNodes, targetNodes) {
  assert.ok([0, 15, 100].includes(count), 'Saved library count must be 0, 15 or 100');
  for (const value of [distractorNodes, targetNodes]) {
    assert.ok([100, 1000, 10000].includes(value), 'Fixture size must be 100, 1000 or 10000');
  }
  const saved = Array.from({length: count}, (_, index) => ({
    title: `${PREFIX} saved ${String(index + 1).padStart(3, '0')}`, nodes: distractorNodes,
  }));
  return {saved, target: {title: `${PREFIX} target`, nodes: targetNodes}};
}

export function verifyCatalog(rows, titles, thumbnails) {
  assert.ok(Array.isArray(rows));
  assert.deepEqual(rows.map(row => row.title).sort(), [...titles].sort());
  assert.equal(new Set(rows.map(row => row.id)).size, titles.length, 'Saved document identities must be distinct');
  const pngs = rows.filter(row => typeof row.thumbnail === 'string');
  assert.equal(pngs.length, thumbnails ? Math.min(titles.length, 15) : 0,
    'Catalog did not include the expected designated thumbnails');
  assert.ok(pngs.every(row => Buffer.from(row.thumbnail, 'base64').subarray(0, PNG.length).equals(PNG)),
    'Expected a native PNG thumbnail');
  return {count: rows.length, thumbnails: pngs.length};
}

export function authoredDocument(doc) {
  const {document} = makeFixture({experiment: 'N-A', nodeCount: doc.nodes, depth: 1, cssRules: 0});
  document.title = doc.title;
  document.nodes[document.pages[0].rootNodeId].properties.figThumbnail = true;
  return document;
}

export async function verifyFirstEdit(rpc, documentId, before) {
  const targets = Object.values(before.nodes).filter(node => node.properties?.name === targetNodeName);
  assert.equal(targets.length, 1);
  const [node] = targets;
  const x = node.properties.x + 1;
  assert.ok(Number.isFinite(x));
  const requestId = randomUUID();
  const {epoch, sequence} = before;
  const {result: receipt, ...edit} = await rpc('document.command', {envelope: {
    protocol: 'omc.engine/1', requestId, idempotencyKey: requestId, documentId, targetEpoch: epoch,
    preconditions: {revision: {epoch, sequence}},
    command: {type: 'node.set', nodeId: node.id, properties: {x}},
  }});
  assert.equal(receipt.status, 'durable');
  assert.equal(receipt.revision.epoch, epoch);
  assert.equal(BigInt(receipt.revision.sequence), BigInt(sequence) + 1n);
  const {result: after, ...readback} = await rpc('document.snapshot', {documentId});
  assert.equal(after.epoch, epoch);
  assert.equal(BigInt(after.sequence), BigInt(receipt.revision.sequence));
  assert.deepEqual(after.pages, before.pages);
  assert.deepEqual(after.metadata, before.metadata);
  assert.deepEqual(after.nodes, {...before.nodes, [node.id]: {...node, properties: {...node.properties, x}}});
  return {after, edit, readback};
}

async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
  child.kill('SIGINT');
  try {
    await exited;
  } finally {
    clearTimeout(timer);
  }
}

async function run(fixture, binary, report, signal) {
  const {Client, StreamableHTTPClientTransport} = await import('../replays/mcp.mjs');
  const profile = await mkdtemp(join(tmpdir(), 'omc-native-startup-'));
  let child, client, endpoint, headers, sessionId, launchedAt;

  async function rpc(method, params = {}) {
    const started = performance.now();
    const reply = await fetch(new URL('/rpc', endpoint), {
      method: 'POST',
      headers: {...headers, 'Content-Type': 'application/json', ...(sessionId && {'X-OMC-Session': sessionId})},
      body: JSON.stringify({id: randomUUID(), method, params}),
      signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
    });
    const raw = await reply.arrayBuffer();
    assert.ok(reply.ok, `${method} HTTP ${reply.status}`);
    const decoded = JSON.parse(Buffer.from(raw).toString('utf8'));
    assert.ok(!decoded.error, `${method} failed: ${decoded.error?.code}`);
    return {result: decoded.result, elapsedMs: performance.now() - started, responseBytes: raw.byteLength};
  }

  async function start() {
    const started = launchedAt = performance.now();
    child = spawn(binary, ['--profile', profile, '--port', '0'], {stdio: ['ignore', 2, 2]});
    await once(child, 'spawn');
    let descriptor;
    const path = join(profile, 'native-v1', 'service.json');
    while (!descriptor && performance.now() - started < 30_000) {
      signal.throwIfAborted();
      assert.ok(child.exitCode === null && child.signalCode === null, 'Native service exited during startup');
      try {
        const value = JSON.parse(await readFile(path, 'utf8'));
        if (value.pid === child.pid) descriptor = value;
      } catch (error) {
        if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
      }
      if (!descriptor) await delay(20, undefined, {signal});
    }
    assert.ok(descriptor, 'Native service descriptor did not become ready');
    endpoint = new URL(descriptor.endpoint);
    assert.equal(endpoint.hostname, '127.0.0.1');
    headers = {Authorization: `Bearer ${descriptor.token}`};
    const descriptorMs = performance.now() - started;
    sessionId = undefined;
    const session = await rpc('session.open');
    sessionId = session.result.sessionId;
    assert.ok(sessionId);
    return {descriptorMs, sessionMs: session.elapsedMs};
  }

  async function list(expected, thumbnails) {
    const {result, ...timing} = await rpc('workspace.list', {thumbnails});
    return {...timing, ...verifyCatalog(result.documents, expected, thumbnails)};
  }

  async function seed(doc) {
    const document = authoredDocument(doc);
    const path = join(profile, 'source.json');
    await writeFile(path, JSON.stringify(document), {mode: 0o600});
    const call = async (name, args) => {
      const response = await client.callTool({name, arguments: args}, undefined, {signal, timeout: 60_000});
      assert.ok(!response.isError, `${name} returned an error`);
      return response.structuredContent ?? JSON.parse(response.content[0].text);
    };
    let imported = await call('import_document', {format: 'json', filePath: path});
    if (imported.jobId) {
      const {jobId} = imported;
      const deadline = performance.now() + 60_000;
      for (;;) {
        const status = await call('native_job', {version: '1', action: 'status', jobId});
        if (status.state === 'completed') {
          imported = status.result;
          break;
        }
        assert.ok(performance.now() < deadline && !['failed', 'interrupted', 'cancelled'].includes(status.state),
          `Native fixture import stopped in state ${status.state}`);
        await delay(50, undefined, {signal});
      }
    }
    assert.match(imported.documentId ?? '', /^(?:doc_[0-9a-f]{32}|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/);
    await rm(path);
    const documentId = imported.documentId.startsWith('doc_')
      ? imported.documentId : `doc_${imported.documentId.replaceAll('-', '')}`;
    await rpc('workspace.close', {documentId});
    return documentId;
  }

  async function reopen() {
    await client?.close();
    client = undefined;
    await stop(child);
    return start();
  }

  try {
    await start();
    report.preparation = {};
    const prepStarted = performance.now();
    client = new Client({name: 'omc-native-startup', version: '1'});
    await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', endpoint), {
      requestInit: {headers},
    }), {signal, timeout: 10_000});
    for (const doc of fixture.saved) await seed(doc);
    const savedTitles = fixture.saved.map(doc => doc.title);
    report.preparation.library = await list(savedTitles, false);
    report.preparation.seedMs = performance.now() - prepStarted;
    report.emptyStart = await reopen();
    report.emptyStart.catalog = await list(savedTitles, false);
    report.emptyStart.thumbnails = await list(savedTitles, true);

    client = new Client({name: 'omc-native-startup', version: '1'});
    await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', endpoint), {
      requestInit: {headers},
    }), {signal, timeout: 10_000});
    const targetSeedStarted = performance.now();
    const documentId = await seed(fixture.target);
    report.preparation.targetSeedMs = performance.now() - targetSeedStarted;
    const allTitles = [...savedTitles, fixture.target.title];
    report.targetStart = await reopen();
    report.targetStart.catalog = await list(allTitles, false);
    const {result, ...open} = await rpc('workspace.open', {documentId});
    const names = Object.values(result.nodes).map(item => item.properties?.name);
    assert.equal(names.length, fixture.target.nodes);
    assert.equal(names.filter(name => name === targetNodeName).length, 1);
    report.targetStart.openSnapshot = {...open, verifiedNodes: names.length};
    report.targetStart.firstContentMs = performance.now() - launchedAt;
    const {after, edit, readback} = await verifyFirstEdit(rpc, documentId, result);
    report.targetStart.firstVerifiedEdit = {edit, readback, sinceProcessLaunchMs: performance.now() - launchedAt};
    const {result: _saved, ...save} = await rpc('document.save', {documentId});
    const {result: _closed, ...close} = await rpc('workspace.close', {documentId});
    const {result: opened, ...warmOpen} = await rpc('workspace.open', {documentId});
    assert.equal(opened.id, documentId);
    assert.equal(opened.epoch, after.epoch);
    assert.equal(opened.sequence, after.sequence);
    assert.deepEqual(opened.pages, after.pages);
    assert.deepEqual(opened.metadata, after.metadata);
    assert.deepEqual(opened.nodes, after.nodes);
    report.targetStart.warmReopen = {save, close, open: warmOpen, verifiedNodes: names.length};
    report.targetStart.thumbnails = await list(allTitles, true);
    report.status = 'verified';
  } finally {
    try {
      await client?.close();
    } finally {
      await stop(child);
      await rm(profile, {force: true, recursive: true});
    }
  }
}

async function main() {
  const {values} = parseArgs({options: {
    'saved-docs': {type: 'string', default: '0'},
    'saved-nodes': {type: 'string', default: '100'},
    'target-nodes': {type: 'string', default: '100'},
    'fixture-only': {type: 'boolean'},
  }});
  const fixture = plan(Number(values['saved-docs']), Number(values['saved-nodes']), Number(values['target-nodes']));
  const report = {
    experiment: 'N-F', measurementKind: 'installed-headless-startup-diagnostic',
    osCache: 'uncontrolled', fixture,
    unavailable: ['first visible window/content', 'physical I/O', 'first accepted visual edit', 'true cold disk cache'],
  };
  if (!values['fixture-only']) {
    const binary = join(process.env.OMC_BENCH_BIN_DIR ?? '/Applications/Oh My Canvas.app/Contents/MacOS', 'omc-service');
    report.binary = {name: basename(binary), sha256: createHash('sha256').update(await readFile(binary)).digest('hex')};
    const cancellation = new AbortController();
    for (const event of ['SIGINT', 'SIGTERM']) {
      process.once(event, () => cancellation.abort(new Error(`Interrupted by ${event}`)));
    }
    try {
      await run(fixture, binary, report, cancellation.signal);
    } catch (error) {
      report.status = 'error';
      report.error = error.message;
      process.exitCode = 1;
    }
  }
  console.log(JSON.stringify(report, null, 2));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
