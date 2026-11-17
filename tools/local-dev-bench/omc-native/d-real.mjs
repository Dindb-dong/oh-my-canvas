import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {once} from 'node:events';
import {createReadStream} from 'node:fs';
import {lstat, mkdtemp, readFile, realpath, rm, statfs, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';

const fixtureBytes = 160_627_671;
const fixtureHash = 'c7c4fdbe469ae451c9a3d3d384a2102fa08dfaa220a1277e2df17fc2146c5ee7';
const expected = {pages: 46, objects: 39_363, bitmapHashes: 160};
const terminal = new Set(['completed', 'failed', 'interrupted', 'cancelled']);

export class ToolError extends Error {
  constructor(name, value) {
    super(`${name}: ${JSON.stringify(value)}`);
    this.value = value;
  }
}

async function sha256(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

function imageHashes(value, output) {
  if (value === null || typeof value !== 'object') return;
  for (const candidate of [value.assetHash, value.image?.hash]) {
    if (typeof candidate === 'string' && /^[a-f0-9]{64}$/.test(candidate)) output.add(candidate);
  }
  for (const child of Object.values(value)) imageHashes(child, output);
}

export async function readStructure(call, documentId, profile) {
  const context = await call('open_document', {id: documentId});
  assert.equal(context.documentId, documentId);
  assert.ok(Array.isArray(context.pages), 'Expected bounded native page catalog');
  const stored = new Map();
  const byKind = {};
  const assets = new Set();
  const digest = createHash('sha256');
  let cursor, revision, batches = 0;
  let maxNodes = 0;
  let maxDecodedBytes = 0;
  for (;;) {
    assert.ok(++batches <= 1500, 'Native query exceeded page-count bound');
    const page = await call('native_query', {
      version: '1', documentId, limit: 200, ...(cursor && {cursor}),
    });
    assert.ok(page.revision && Array.isArray(page.nodes) && page.nodes.length <= 200, 'Malformed bounded query page');
    revision ??= page.revision;
    assert.deepEqual(page.revision, revision, 'Bounded query changed revision');
    assert.equal(page.revision.epoch, context.nativeRevision.epoch);
    assert.equal(String(page.revision.sequence), String(context.nativeRevision.sequence));
    maxNodes = Math.max(maxNodes, page.nodes.length);
    maxDecodedBytes = Math.max(maxDecodedBytes, Buffer.byteLength(JSON.stringify(page)));
    for (const node of page.nodes) {
      assert.ok(typeof node.id === 'string' && !stored.has(node.id), 'Duplicate or malformed node identity');
      stored.set(node.id, node.parentId);
      byKind[node.kind] = (byKind[node.kind] ?? 0) + 1;
      imageHashes(node.properties, assets);
      digest.update(JSON.stringify(node)).update('\n');
    }
    if (page.complete) break;
    assert.ok(page.cursor && page.cursor !== cursor && page.nodes.length, 'Cursor failed to progress');
    cursor = page.cursor;
  }
  const roots = new Set();
  for (const [key, parent] of stored) {
    if (parent === null) roots.add(key);
    else assert.ok(stored.has(parent), 'Node parent is outside the document');
  }
  // Memoized walks check that all nodes terminate at an actual page root.
  const connected = new Set(roots);
  for (const id of stored.keys()) {
    const path = new Set();
    let current = id;
    while (!connected.has(current)) {
      assert.ok(!path.has(current), 'Cyclic parent relationships in imported nodes');
      path.add(current);
      current = stored.get(current);
    }
    for (const node of path) connected.add(node);
  }
  const counts = {pages: context.pages.length, objects: stored.size, bitmapHashes: assets.size};
  const differences = Object.fromEntries(Object.keys(expected)
    .filter(key => counts[key] !== expected[key])
    .map(key => [key, {expected: expected[key], observed: counts[key], delta: counts[key] - expected[key]}]));
  if (roots.size !== counts.pages) differences.pageRoots = {expected: counts.pages, observed: roots.size};
  let verifiedAssetBytes = 0;
  for (const hash of assets) {
    const file = join(profile, 'native-v1/assets/sha256', hash.slice(0, 2), hash);
    const stat = await lstat(file);
    assert.ok(stat.isFile() && stat.size <= 64 * 1024 ** 2, 'Asset is not a bounded regular file');
    assert.equal(await sha256(file), hash, 'Asset digest disagrees with imported node reference');
    verifiedAssetBytes += stat.size;
  }
  return {
    counts, differences, rootCount: roots.size, pages: context.pages, revision,
    nodeDigest: digest.digest('hex'), nodeKinds: byKind, verifiedAssetHashes: [...assets].sort(),
    verifiedAssetBytes, boundedQuery: {batches, maxNodes, maxDecodedBytes},
  };
}

async function stop(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
  child.kill('SIGINT');
  try {
    await exited;
  } finally {
    clearTimeout(timer);
  }
}

export async function submitImport(call, filePath, imports, route, signal) {
  const now = performance.now();
  const entry = {route, polls: []};
  imports.push(entry);
  const args = {format: 'fig', filePath};
  let ticket;
  try {
    ticket = route === 'import_document' ? await call(route, args) : await call(route, {
      version: '1', action: 'submit', kind: 'import', arguments: args,
    });
  } catch (error) {
    if (!(error instanceof ToolError)) throw error;
    entry.state = 'rejected_before_ticket';
    entry.error = error.value;
    entry.elapsedMs = performance.now() - now;
    return null;
  }
  entry.submissionMs = performance.now() - now;
  if (!ticket.jobId) {
    entry.state = 'completed_synchronously';
    return ticket;
  }
  entry.jobId = ticket.jobId;
  while (performance.now() - now < 300_000) {
    const status = await call('native_job', {version: '1', action: 'status', jobId: ticket.jobId});
    entry.polls.push({state: status.state, progress: status.progress, observedMs: performance.now() - now});
    if (terminal.has(status.state)) {
      entry.state = status.state;
      entry.error = status.error;
      entry.elapsedMs = performance.now() - now;
      entry.jobClockMs = status.finishedAtMs - status.createdAtMs;
      return status.result;
    }
    await delay(125, undefined, {signal});
  }
  entry.state = 'timeout';
  const cancellation = await call('native_job', {version: '1', action: 'cancel', jobId: ticket.jobId});
  entry.cancellation = {state: cancellation.state, cancellationBoundary: cancellation.cancellationBoundary};
  return null;
}

async function live(filePath, binary, report, signal) {
  const {Client, StreamableHTTPClientTransport} = await import('../replays/mcp.mjs');
  const storage = await statfs(tmpdir());
  report.freeBytesBefore = storage.bavail * storage.bsize;
  assert.ok(report.freeBytesBefore >= 4 * 1024 ** 3, 'D-REAL profile needs 4 GiB free on its temporary filesystem');
  const profile = await mkdtemp(join(tmpdir(), 'omc-native-d-real-'));
  let child, client;

  async function start() {
    const started = performance.now();
    child = spawn(binary, ['--profile', profile, '--port', '0'], {stdio: ['ignore', 2, 2]});
    await once(child, 'spawn');
    let descriptor;
    while (performance.now() - started < 15_000) {
      signal.throwIfAborted();
      assert.ok(child.exitCode === null && child.signalCode === null, 'Service exited during startup');
      try {
        const value = JSON.parse(await readFile(join(profile, 'native-v1/service.json'), 'utf8'));
        if (value.pid === child.pid) {
          descriptor = value;
          break;
        }
      } catch (error) {
        if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
      }
      await delay(25, undefined, {signal});
    }
    assert.ok(descriptor, 'No observed service descriptor for the task-owned process');
    const endpoint = new URL(descriptor.endpoint);
    assert.equal(endpoint.hostname, '127.0.0.1');
    client = new Client({name: 'omc-d-real', version: '1'});
    await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', endpoint), {
      requestInit: {headers: {Authorization: `Bearer ${descriptor.token}`}},
    }), {timeout: 10_000, signal});
    return {pid: child.pid, elapsedMs: performance.now() - started};
  }

  async function call(name, args) {
    const response = await client.callTool({name, arguments: args}, undefined, {timeout: 30_000, signal});
    const value = response.structuredContent ?? JSON.parse(response.content[0].text);
    if (response.isError) throw new ToolError(name, value);
    return value;
  }

  try {
    report.start = await start();
    report.capabilities = await call('native_capabilities', {version: '1'});
    const schemas = await client.listTools({}, {timeout: 10_000, signal});
    report.schemas = schemas.tools.filter(tool =>
      ['import_document', 'native_job', 'native_query', 'open_document', 'list_documents'].includes(tool.name));
    let imported = await submitImport(call, filePath, report.imports, 'import_document', signal);
    if (!imported) {
      report.catalogAfterFirstAttempt = await call('list_documents', {limit: 10});
      if (['failed', 'rejected_before_ticket'].includes(report.imports[0].state) &&
          report.catalogAfterFirstAttempt.documents.length === 0) {
        imported = await submitImport(call, filePath, report.imports, 'native_job', signal);
        report.catalogAfterSecondAttempt = await call('list_documents', {limit: 10});
      }
    }
    if (!imported) {
      report.status = report.imports.length === 2 && report.imports.every(entry => entry.error?.code === 'resource_limit')
        ? 'CAPACITY_REJECTED' : 'IMPORT_FAILED';
      return;
    }
    assert.ok(imported.documentId, 'Durable import result returned no document identity');
    report.documentId = imported.documentId;
    report.importDiagnostics = {total: imported.diagnostics?.length ?? null, sample: imported.diagnostics?.slice(0, 10)};
    let started = performance.now();
    report.importedStructure = await readStructure(call, imported.documentId, profile);
    report.importStructureMs = performance.now() - started;
    await client.close();
    client = undefined;
    await stop(child);
    assert.equal(child.exitCode, 0, 'First service must exit normally before fresh-process reopen');
    report.restart = await start();
    assert.notEqual(report.restart.pid, report.start.pid, 'Reopen requires a distinct process');
    started = performance.now();
    report.reopenedStructure = await readStructure(call, imported.documentId, profile);
    report.reopenAndStructureMs = performance.now() - started;
    const {boundedQuery: _initialPages, ...initial} = report.importedStructure;
    const {boundedQuery: _reopenedPages, ...reopened} = report.reopenedStructure;
    assert.deepEqual(reopened, initial, 'Fresh-process bounded readback changed the imported document');
    report.status = Object.keys(initial.differences).length ? 'STRUCTURAL_MISMATCH' : 'PASS';
  } finally {
    try {
      await client?.close();
    } finally {
      await stop(child);
      await rm(profile, {recursive: true, force: true, maxRetries: 5});
    }
  }
}

async function main() {
  const {values} = parseArgs({options: {
    fixture: {type: 'string'}, output: {type: 'string'}, 'fixture-only': {type: 'boolean'},
  }});
  assert.ok(values.fixture && (values.output || values['fixture-only']), '--fixture and --output are required for a live run');
  const file = await realpath(resolve(values.fixture));
  const stat = await lstat(file);
  assert.ok(stat.isFile() && stat.size === fixtureBytes, 'D-REAL byte count disagrees with checked-in manifest');
  assert.equal(await sha256(file), fixtureHash, 'D-REAL source hash mismatch');
  const binary = join(process.env.OMC_BENCH_BIN_DIR ?? '/Applications/Oh My Canvas.app/Contents/MacOS', 'omc-service');
  const report = {
    schemaVersion: 1, fixture: {id: 'D-REAL', bytes: stat.size, sha256: fixtureHash, expected},
    utcStart: new Date().toISOString(), scope: 'isolated native service; single process-cold case per live stage',
    status: 'FIXTURE_VERIFIED', imports: [],
    unmeasured: ['first usable or early-edit readiness', 'viewport and actual presentation',
      'native UI interaction', 'source semantic or pixel fidelity', 'disk-cold behavior', 'complete export'],
  };
  if (!values['fixture-only']) {
    const cancellation = new AbortController();
    for (const event of ['SIGINT', 'SIGTERM']) process.once(event, () => cancellation.abort(new Error(event)));
    try {
      report.serviceSha256 = await sha256(binary);
      await live(file, binary, report, cancellation.signal);
    } catch (error) {
      report.status = 'ERROR';
      report.error = error.message;
    }
  }
  if (values.output) await writeFile(values.output, JSON.stringify(report, null, 2) + '\n', {flag: 'wx', mode: 0o600});
  console.log(JSON.stringify({status: report.status, fixture: report.fixture, imports: report.imports.map(
    ({route, state, error}) => ({route, state, error}),
  ), error: report.error}));
  if (!['PASS', 'FIXTURE_VERIFIED'].includes(report.status)) process.exitCode = 1;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await main();
