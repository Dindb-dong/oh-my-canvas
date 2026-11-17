import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { makePlan } from './adapter.mjs';

const variables = ['target/accent', 'target/spacing', 'keep/accent', 'keep/spacing'];

function scalar(value) {
  assert.ok(value && Object.keys(value).sort().join() === 'accent,spacing_px' &&
    typeof value.accent === 'string' && /^#[a-f\d]{6}$/i.test(value.accent) &&
    Number.isInteger(value.spacing_px) && value.spacing_px >= 0 && value.spacing_px <= 128, 'Invalid shared values');
  return { accent: value.accent.toLowerCase(), spacing_px: value.spacing_px };
}

async function nativeSharedValues(figma, scope) {
  if (figma.fileKey !== scope.fileKey) throw new Error('Wrong synthetic Figma Draft');
  const all = await figma.variables.getLocalVariablesAsync();
  if (all.length !== scope.ids.length) throw new Error('Wrong variable count in the synthetic fixture');
  const rows = scope.ids.map(([name, id], index) => {
    const matching = all.filter(item => item.id === id && item.name === name);
    const [item] = matching;
    if (matching.length !== 1 || item.remote || item.resolvedType !== (index % 2 ? 'FLOAT' : 'COLOR')) {
      throw new Error('Wrong native variable identity or type');
    }
    return item;
  });
  const collections = await figma.variables.getLocalVariableCollectionsAsync();
  const [collection] = collections;
  if (collections.length !== 1 || collection.modes.length !== 1 ||
      rows.some(item => item.variableCollectionId !== collection.id)) throw new Error('Unexpected native variable collection');
  const mode = collection.defaultModeId;
  const hex = color => {
    if (!color || (color.a ?? 1) !== 1 ||
        !['r', 'g', 'b'].every(c => typeof color[c] === 'number' && color[c] >= 0 && color[c] <= 1)) {
      throw new Error('Unexpected color value');
    }
    return '#' + ['r','g','b'].map(c => Math.round(color[c] * 255).toString(16).padStart(2, '0')).join('');
  };
  const pair = start => ({ accent: hex(rows[start].valuesByMode[mode]), spacing_px: rows[start + 1].valuesByMode[mode] });
  const same = (left, right) => left.accent === right.accent && left.spacing_px === right.spacing_px;
  if (!same(pair(2), scope.before.archive)) throw new Error('Protected archive values differ from the approved baseline');
  if (scope.change) {
    if (!same(pair(0), scope.before.target)) throw new Error('Target values differ from the approved starting state');
    const [r,g,b] = [1,3,5].map(i => parseInt(scope.change.accent.slice(i,i+2), 16) / 255);
    rows[0].setValueForMode(mode, {r,g,b});
    rows[1].setValueForMode(mode, scope.change.spacing_px);
    if (!same(pair(0), scope.change) || !same(pair(2), scope.before.archive)) {
      throw new Error('Native write receipt differs from the scoped edit');
    }
  }
  return { target: pair(0), archive: pair(2) };
}

// Scope is supplied by the trusted runner from independent synthetic Draft evidence.
export function figmaLD03Driver({ fixture, fileKey, sessionId, nativeIds, before }, invoke) {
  assert.equal(fixture, 'field-relay');
  assert.match(fileKey ?? '', /^[A-Za-z0-9_-]{1,128}$/);
  assert.match(sessionId ?? '', /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i);
  const ids = variables.map(name => [name, nativeIds[name]]);
  assert.equal(Object.keys(nativeIds).length, 4);
  assert.equal(new Set(ids.map(([, id]) => id)).size, 4);
  assert.ok(ids.every(([, id]) => typeof id === 'string' && /^VariableID:\d+:\d+$/.test(id)));
  const scope = { fileKey, ids, before: { target: scalar(before.target), archive: scalar(before.archive) } };
  let requested = false;
  async function call(change) {
    const description = change ? 'Update only two pinned shared variables in the approved synthetic Draft' :
      'Read only the four pinned variables in the approved synthetic Draft';
    const args = { fileKey, sessionId, description, skillNames: 'resource:figma-use',
      code: `return await (${nativeSharedValues.toString()})(figma, ${JSON.stringify({...scope, change})});` };
    const response = await invoke(args);
    assert.notEqual(response?.isError, true, 'Figma rejected the scoped native operation');
    assert.equal(response?.content?.length, 1);
    assert.equal(response.content[0].type, 'text');
    const raw = JSON.parse(response.content[0].text);
    const observed = { target: scalar(raw.target), archive: scalar(raw.archive) };
    assert.deepEqual(observed.archive, scope.before.archive, 'The protected archive value changed');
    if (change) assert.deepEqual(observed.target, change, 'The observed native target values did not match the write');
    return observed;
  }
  return {
    inspect: () => call(),
    apply: input => {
      const change = scalar(input);
      assert.equal(requested, false, 'Only one native LD03 write can be attempted');
      requested = true;
      return call(change);
    },
  };
}

function isolatedOptions(servers) {
  assert.ok(servers.some(server => server.name === 'figma' && server.enabled && server.auth_status === 'o_auth' &&
    server.transport.url === 'https://mcp.figma.com/mcp'), 'Official Figma MCP OAuth is unavailable');
  const opts = servers.filter(server => server.name !== 'figma').flatMap(server => {
    assert.match(server.name, /^[A-Za-z0-9_-]+$/);
    const dummy = server.transport.type === 'stdio' ? 'command="/usr/bin/false"' : 'url="http://127.0.0.1:9/mcp"';
    return ['-c', `mcp_servers.${server.name}={enabled=false,${dummy}}`];
  });
  return [...opts, '-c', 'mcp_servers.figma={enabled=true,url="https://mcp.figma.com/mcp",enabled_tools=["use_figma"]}'];
}

// The existing OAuth credential remains in Codex; there is no model turn in this app-server.
async function withFigmaMCP(run, { binary = 'codex', timeoutMs = 18_000 } = {}) {
  const listed = JSON.parse(execFileSync(binary, ['mcp', 'list', '--json'], { encoding: 'utf8', timeout: timeoutMs }));
  const options = isolatedOptions(listed);
  const dir = await mkdtemp(join(tmpdir(), 'omc-figma-ld03-'));
  const start = performance.now();
  const child = spawn(binary, ['app-server', '--disable', 'apps', '--disable', 'plugins', ...options, '--stdio'],
    { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map();
  let id = 0;
  let exited;
  child.stderr.resume();
  const reader = createInterface({input: child.stdout});
  const send = message => child.stdin.write(JSON.stringify({jsonrpc: '2.0', ...message}) + '\n');
  const fail = error => {
    exited = error;
    for (const query of pending.values()) {
      clearTimeout(query.timer);
      query.reject(error);
    }
    pending.clear();
  };
  child.on('error', fail);
  child.stdin.on('error', fail);
  child.on('exit', code => fail(new Error(`Figma broker Codex app-server exited (${code})`)));
  reader.on('line', line => {
    let event;
    try { event = JSON.parse(line); } catch { return; }
    if ('method' in event && 'id' in event) {
      send({id: event.id, error: {code: -32601, message: 'Client callbacks unavailable'}});
      return;
    }
    const query = pending.get(event.id);
    if (!query) return;
    pending.delete(event.id);
    clearTimeout(query.timer);
    if (event.error) query.reject(new Error(`Codex app-server rejected ${query.method} (${event.error.code})`));
    else query.resolve(event.result);
  });
  function rpc(method, params) {
    if (exited) return Promise.reject(exited);
    return new Promise((resolve, reject) => {
      id += 1;
      const callId = id;
      const timer = setTimeout(() => {
        pending.delete(callId);
        reject(new Error(`Codex app-server timed out during ${method}`));
      }, timeoutMs);
      pending.set(callId, {method, resolve, reject, timer});
      send({id: callId, method, params});
    });
  }
  try {
    await rpc('initialize', {clientInfo: {name: 'omc-figma-ld03', version: '1.0.0'},
      capabilities: {experimentalApi: true, explicitGatewayOauth: true}});
    send({method: 'initialized', params: {}});
    const initialized = performance.now();
    const startThread = await rpc('thread/start', {cwd: dir, ephemeral: true, approvalPolicy: 'never', sandbox: 'read-only'});
    const threadId = startThread.thread.id;
    assert.ok(typeof threadId === 'string' && threadId);
    const threaded = performance.now();
    const availability = await rpc('mcpServerStatus/list', {threadId});
    const active = availability.data.filter(server => Object.keys(server.tools).length > 0);
    assert.deepEqual(active.map(server => server.name), ['figma']);
    assert.equal(active[0].authStatus, 'oAuth');
    assert.deepEqual(Object.keys(active[0].tools), ['use_figma']);
    const readiness = { initialization_ms: initialized - start, ephemeral_thread_ms: threaded - initialized,
      connector_discovery_ms: performance.now() - threaded };
    return await run(args => rpc('mcpServer/tool/call', {
      threadId, server: 'figma', tool: 'use_figma', arguments: args,
    }), readiness);
  } finally {
    reader.close();
    if (child.exitCode === null && child.signalCode === null) {
      child.stdin.end();
      child.kill();
      await once(child, 'close').catch(() => {});
    }
    await rm(dir, {recursive: true, force: true});
  }
}

export function withOfficialFigmaLD03(scope, run, options) {
  return withFigmaMCP((invoke, readiness) => run(figmaLD03Driver(scope, invoke), readiness), options);
}

// The trusted observer controls these predefined read-only payloads outside the model socket.
export function captureOfficialFigmaLD03(scope, fixture, options) {
  assert.equal(fixture.workload, 'LD03');
  assert.equal(fixture.source_family_id, scope.fixture);
  const plan = makePlan(fixture, scope.fileKey, null).captures.before;
  return withFigmaMCP(async (invoke, readiness) => {
    const ms = [];
    async function read(args) {
      const start = performance.now();
      const response = await invoke({...args, fileKey: scope.fileKey, sessionId: scope.sessionId});
      ms.push(performance.now() - start);
      assert.notEqual(response?.isError, true, 'Independent Figma read failed');
      return response;
    }
    const capture = {header: await read(plan.header), nodes: [], images: []};
    for (const batch of plan.nodes) capture.nodes.push(await read(batch));
    return {capture, ms, readiness};
  }, options);
}
