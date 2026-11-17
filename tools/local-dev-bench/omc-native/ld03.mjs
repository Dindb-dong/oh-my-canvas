import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createHash, randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {mkdtemp, open, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';
import {runLD03Agent, withLD03Broker} from '../ld03-model.mjs';
import {publishCandidate} from '../publish-candidate.mjs';

const marker = 'LD03 ';
const styleProperties = {accent: 'fill', spacing: 'gap'};
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const storedId = id => {
  assert.match(id, /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/);
  return `doc_${id.replaceAll('-', '')}`;
};

export function planLD03(fixture) {
  assert.equal(fixture.workload, 'LD03');
  assert.equal(fixture.target_references, 40);
  assert.equal(fixture.local_overrides, 4);
  const cards = fixture.start.nodes.filter(node => node.bindings);
  assert.equal(cards.length, 44);
  const bindingGroups = fixture.start.styles.map(style => {
    const field = styleProperties[style.key.split('.')[1]];
    assert.ok(field);
    return {style, field, keys: cards.filter(node => node.bindings[field] === style.key).map(node => node.key)};
  });
  const overrides = cards.flatMap(node => ['fill', 'gap']
    .filter(field => !node.bindings[field]).map(field => ({key: node.key, field, value: node[field]})));
  assert.equal(overrides.length, 4);
  const changes = phase => fixture[phase].styles.filter((style, index) => style.value !== fixture.start.styles[index].value);
  const candidate = changes('expected');
  const probe = changes('probe');
  assert.deepEqual(candidate.map(row => row.key), ['target.accent', 'target.spacing']);
  assert.deepEqual(probe.map(row => row.key), candidate.map(row => row.key));
  return {cards, bindingGroups, overrides, candidate, probe};
}

function geometry(row, index, source) {
  if (row.parent === null) return {x: 0, y: 0, width: 1440, height: 960};
  if (row.kind === 'text') {
    const parent = source.get(row.parent);
    const y = parent.bindings && row.key.endsWith('/state') ? 23 + parent.gap : 7;
    return {x: 10, y, width: parent.bindings ? 120 : 200, height: 16};
  }
  if (row.bindings) return {x: 12 + (index % 2) * 150, y: 36 + Math.floor(index / 2) * 82, width: 144, height: 76};
  if (row.key === 'board/editorial' || row.key === 'board/distribution') {
    return {x: row.key.endsWith('editorial') ? 12 : 710, y: 42, width: 690, height: 650};
  }
  const column = index % 4;
  return {x: 14 + column * 338, y: 42 + Math.floor(index / 4) * 440, width: 324, height: 458};
}

export async function seedLD03(api, fixture, plan) {
  const {id} = await api.run('file.new', {name: `LD03 ${fixture.source_family_id}`});
  const source = new Map(fixture.start.nodes.map(node => [node.key, node]));
  const ids = new Map();
  const siblings = new Map();
  for (const row of fixture.start.nodes) {
    const index = siblings.get(row.parent) ?? 0;
    siblings.set(row.parent, index + 1);
    if (row.parent !== null) assert.ok(ids.has(row.parent), `Parent must precede ${row.key}`);
    const result = await api.call('create_node', {
      type: row.kind, name: marker + row.key,
      ...(row.parent === null ? {} : {parent: ids.get(row.parent)}),
      ...geometry(row, index, source),
      ...(row.kind === 'text' ? {
        text: row.text, props: {fontSize: 12, fill: source.get(row.parent)?.bindings ? '#ffffff' : '#203040'},
      } : {}),
      ...(row.fill === undefined ? {} : {props: {fill: row.fill}}),
      select: false,
    });
    assert.ok(Number.isInteger(result.id));
    ids.set(row.key, result.id);
  }
  const cardIds = plan.cards.map(row => ids.get(row.key));
  for (let i = 0; i < cardIds.length; i += 8) {
    await api.run('layout.add', {ids: cardIds.slice(i, i + 8), direction: 'vertical'});
  }
  await api.literalGaps(id, plan.overrides.filter(row => row.field === 'gap'));
  const {id: collection} = await api.run('variable.createCollection', {name: 'LD03 shared values'});
  const variableIds = new Map();
  for (const {style, field, keys} of plan.bindingGroups) {
    const variable = await api.run('variable.create', {
      collection, name: style.key, type: style.kind === 'color' ? 'color' : 'number', value: style.value,
    });
    assert.ok(typeof variable.id === 'string' && variable.id);
    variableIds.set(style.key, variable.id);
    await api.run('variable.bind', {ids: keys.map(key => ids.get(key)), field, variable: variable.id});
  }
  return {id, variableIds};
}

export function observedGap(lines) {
  assert.ok(Array.isArray(lines), 'Missing native distance lines');
  const candidates = lines.filter(line => !line.dashed && Math.abs(line.x1 - line.x0) < 1e-7 && line.y1 > line.y0);
  assert.equal(candidates.length, 1, 'Expected a single vertical sibling gap');
  const [line] = candidates;
  return Math.round((line.y1 - line.y0) * 100) / 100;
}

function color(value) {
  assert.match(value, /^#[0-9a-f]{6}$/i);
  return value.toLowerCase();
}

export function sharedLD03Values(variables, ids) {
  assert.equal(variables.length, ids.size);
  const seen = new Map(variables.map(row => [row.name, row]));
  for (const [key, id] of ids) assert.equal(seen.get(key)?.id, id);
  const family = key => ({
    accent: color(seen.get(`${key}.accent`).value),
    spacing_px: seen.get(`${key}.spacing`).value,
  });
  return {target: family('target'), archive: family('keep')};
}

export function validateLD03Baseline(fixture, observation) {
  assert.ok(typeof observation.document_id === 'string');
  const styles = new Map(observation.styles.map(row => [row.key, row]));
  assert.equal(styles.size, fixture.start.styles.length);
  assert.equal(styles.size, observation.styles.length);
  assert.equal(new Set(observation.styles.map(row => row.native_id)).size, styles.size);
  for (const expected of fixture.start.styles) {
    const actual = styles.get(expected.key);
    assert.ok(actual?.native_id);
    for (const [key, value] of Object.entries(expected)) assert.deepEqual(actual[key], value);
  }
  const nodes = new Map(observation.nodes.map(row => [row.key, row]));
  assert.equal(nodes.size, fixture.start.nodes.length);
  assert.equal(nodes.size, observation.nodes.length);
  assert.equal(new Set(observation.nodes.map(row => row.native_id)).size, nodes.size);
  for (const expected of fixture.start.nodes) {
    const actual = nodes.get(expected.key);
    assert.ok(actual?.native_id);
    assert.equal(actual.editable, true);
    for (const [key, value] of Object.entries(expected)) {
      const required = key === 'bindings' ? Object.fromEntries(Object.entries(value)
        .map(([field, style]) => [field, styles.get(style).native_id])) : value;
      assert.deepEqual(actual[key], required, `Prepared baseline differs: ${expected.key}.${key}`);
    }
  }
}

export function validatePreparedLD03(prepared, fixture, binarySha256, sourceSha256) {
  assert.equal(prepared.schema, 'omc-ld03-prepared/1');
  assert.equal(prepared.fixtureContentSha256, sha256(JSON.stringify(fixture)));
  assert.equal(prepared.binarySha256, binarySha256);
  assert.equal(prepared.sourceSha256, sourceSha256);
  assert.ok(typeof prepared.profile === 'string' && prepared.profile.startsWith('/'));
  assert.match(prepared.ownershipToken, /^[a-f0-9-]{36}$/);
  assert.equal(prepared.beforeSha256, sha256(JSON.stringify(prepared.before)));
  assert.equal(prepared.documentId, prepared.before.document_id);
  storedId(prepared.documentId);
  validateLD03Baseline(fixture, prepared.before);
  assert.deepEqual(prepared.variableIds, prepared.before.styles.map(row => [row.key, row.native_id]));
  return {id: prepared.documentId, variableIds: new Map(prepared.variableIds)};
}

export async function captureLD03(api, documentId, fixture) {
  await api.bind(documentId);
  const raw = await api.snapshot(documentId);
  assert.equal(raw.id, storedId(documentId));
  assert.equal(raw.pages.length, 1);
  const pageRoot = raw.pages[0].rootNodeId;
  const rawNodes = Object.values(raw.nodes).filter(node => node.id !== pageRoot);
  assert.equal(rawNodes.length, fixture.logical_objects);
  const keys = new Map(rawNodes.map(node => {
    const name = node.properties.name;
    assert.ok(name.startsWith(marker), 'Unexpected unmarked layer in isolated fixture');
    return [node.id, name.slice(marker.length)];
  }));
  assert.equal(new Set(keys.values()).size, rawNodes.length);

  const tree = await api.call('inspect_document', {depth: 1});
  assert.equal(tree.id, documentId);
  assert.equal(tree.layers.length, 1);
  const board = await api.call('get_node', {id: tree.layers[0].id, depth: 12});
  const aliases = new Map();
  function walk(node) {
    const key = node.name.slice(marker.length);
    assert.ok(node.name.startsWith(marker) && !aliases.has(key));
    aliases.set(key, node);
    for (const child of node.children ?? []) walk(child);
  }
  walk(board);
  assert.equal(aliases.size, rawNodes.length);

  const catalog = await api.run('variable.list');
  assert.equal(catalog.collections.length, 1);
  assert.equal(catalog.variables.length, fixture.start.styles.length);
  const styles = catalog.variables.map(variable => {
    assert.ok(['color', 'number'].includes(variable.type));
    assert.equal(variable.collection, catalog.collections[0].id);
    assert.ok(typeof variable.id === 'string' && variable.id);
    return {
      key: variable.name, native_id: variable.id, kind: variable.type === 'color' ? 'color' : 'length',
      value: variable.type === 'color' ? color(variable.value) : variable.value,
    };
  });
  const styleIds = new Set(styles.map(style => style.native_id));
  async function captureNode(node) {
    const key = keys.get(node.id);
    const alias = aliases.get(key);
    assert.equal(alias.type.toLowerCase(), node.kind, `Native and FigCraft layer types disagree for ${key}`);
    const props = node.properties;
    const row = {
      key, native_id: node.id, kind: node.kind,
      parent: node.parentId === pageRoot ? null : keys.get(node.parentId),
      editable: props.locked !== true && props.visible !== false,
    };
    if (node.kind === 'text') {
      row.text = props.text;
      assert.equal(alias.characters, row.text);
    }
    if (props.layout?.direction === 'column') {
      assert.equal(props.layout.type, 'flex');
      const [label, state] = alias.children;
      assert.equal(alias.children.length, 2);
      assert.equal(label.name, marker + key + '/label');
      assert.equal(state.name, marker + key + '/state');
      const rendered = await api.run('inspect.properties', {id: alias.id, colorFormat: 'hex'});
      const paints = rendered.sections.find(section => section.title === 'Fills')?.rows;
      assert.equal(paints?.length, 1);
      row.fill = color(paints[0].color);
      const distances = await api.run('measure.distances', {ids: [label.id], to: state.id});
      row.gap = observedGap(distances.lines);
      row.layout = 'vertical';
      row.bindings = {};
      if (props.fills !== undefined) assert.equal(props.fills.length, 1);
      const authored = {fill: props.fills?.[0]?.color ?? props.fill, gap: props.layout.gap};
      for (const [field, value] of Object.entries(authored)) {
        if (value && typeof value === 'object') {
          assert.deepEqual(Object.keys(value), ['$token']);
          assert.ok(styleIds.has(value.$token), `Binding outside the scoped variables: ${key}.${field}`);
          row.bindings[field] = value.$token;
        } else {
          assert.equal(field === 'fill' ? color(value) : value, row[field], `Literal property changed: ${key}.${field}`);
        }
      }
    }
    return row;
  }
  // Keep a single document bound and drain every outstanding read before changing scope.
  const nodes = [];
  for (let start = 0; start < rawNodes.length; start += 4) {
    const rows = await Promise.allSettled(rawNodes.slice(start, start + 4).map(captureNode));
    for (const row of rows) {
      if (row.status === 'rejected') throw row.reason;
      nodes.push(row.value);
    }
  }
  return {document_id: documentId, nodes, styles};
}

async function runLD03(fixture, plan, report, modelCommand, preparation = {}) {
  const {Client, StreamableHTTPClientTransport} = await import('../replays/mcp.mjs');
  const serviceBinary = join(process.env.OMC_BENCH_BIN_DIR ?? '/Applications/Oh My Canvas.app/Contents/MacOS', 'omc-service');
  report.binarySha256 = sha256(await readFile(serviceBinary));
  const sourceSha256 = sha256(await readFile(new URL(import.meta.url)));
  const preparedBytes = preparation.prepared && await readFile(preparation.prepared);
  const prepared = preparedBytes && JSON.parse(preparedBytes);
  const preparedOriginal = prepared && validatePreparedLD03(prepared, fixture, report.binarySha256, sourceSha256);
  const profile = prepared?.profile ?? await mkdtemp(join(tmpdir(), 'omc-ld03-'));
  const ownershipPath = join(profile, '.ld03-owner');
  const ownershipToken = prepared?.ownershipToken ?? randomUUID();
  const lockPath = join(profile, '.ld03-measured.lock');
  let lease;
  let preserveProfile = Boolean(prepared);
  const descriptorPath = join(profile, 'native-v1/service.json');
  const cancellation = new AbortController();
  const {signal} = cancellation;
  for (const event of ['SIGTERM', 'SIGINT']) process.once(event, () => cancellation.abort(new Error(event)));
  let service;
  let client;
  let transport;
  let descriptor;

  async function start() {
    service = spawn(serviceBinary, ['--profile', profile, '--port', '0'], {stdio: ['ignore', 2, 2]});
    await once(service, 'spawn');
    for (let attempt = 0; attempt < 200; attempt++) {
      signal.throwIfAborted();
      assert.ok(service.exitCode === null && service.signalCode === null);
      try {
        const seen = JSON.parse(await readFile(descriptorPath, 'utf8'));
        if (seen.pid === service.pid) {
          descriptor = seen;
          return;
        }
      } catch (error) {
        if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
      }
      await delay(25, undefined, {signal});
    }
    throw new Error('Timed out waiting for the isolated OMC descriptor');
  }

  function url(path) {
    const endpoint = new URL(descriptor.endpoint);
    assert.equal(endpoint.hostname, '127.0.0.1');
    return new URL(path, endpoint);
  }
  const headers = () => ({Authorization: `Bearer ${descriptor.token}`});
  async function stop() {
    try {
      await client?.close();
    } finally {
      client = undefined;
      if (service?.pid && service.exitCode === null && service.signalCode === null) {
        const exited = once(service, 'exit');
        service.kill('SIGINT');
        const watchdog = setTimeout(() => service.kill('SIGKILL'), 5000);
        try {
          await exited;
        } finally {
          clearTimeout(watchdog);
        }
      }
    }
  }
  async function connect() {
    client = new Client({name: 'omc-ld03-replay', version: '1'});
    transport = new StreamableHTTPClientTransport(url('/mcp/figcraft'), {requestInit: {headers: headers()}});
    await client.connect(transport, {signal, timeout: 10_000});
    assert.ok(transport.sessionId);
  }
  async function rpc(method, documentId, args = {}) {
    const response = await fetch(url('/rpc'), {
      method: 'POST',
      headers: {...headers(), 'Content-Type': 'application/json', 'X-OMC-Session': transport.sessionId},
      body: JSON.stringify({id: randomUUID(), method, params: {documentId: storedId(documentId), ...args}}),
      signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
    });
    const payload = await response.json();
    assert.ok(response.ok && !payload.error, `${method}: ${payload.error?.code ?? response.status}`);
    return payload.result;
  }
  async function call(name, args) {
    const result = await client.callTool({name, arguments: args}, undefined, {signal, timeout: 20_000});
    assert.ok(!result.isError, `${args.command ?? name}: ${result.content[0]?.text}`);
    return result.structuredContent ?? JSON.parse(result.content[0].text);
  }
  async function literalGaps(documentId, overrides) {
    const snapshot = await rpc('document.snapshot', documentId);
    assert.equal(snapshot.id, storedId(documentId));
    const commands = overrides.map(({key, value}) => {
      const nodes = Object.values(snapshot.nodes).filter(node => node.properties.name === marker + key);
      assert.equal(nodes.length, 1);
      const [node] = nodes;
      const {layout} = node.properties;
      assert.equal(layout.type, 'flex');
      assert.equal(layout.direction, 'column');
      return {type: 'node.set', nodeId: node.id, properties: {layout: {...layout, gap: value}}};
    });
    const {epoch, sequence} = snapshot;
    const requestId = randomUUID();
    const receipt = await rpc('document.command', documentId, {envelope: {
      protocol: 'omc.engine/1', documentId: snapshot.id, requestId, idempotencyKey: requestId,
      targetEpoch: epoch, preconditions: {revision: {epoch, sequence}}, command: {type: 'batch', commands},
    }});
    assert.equal(receipt.status, 'durable');
    assert.equal(receipt.revision.epoch, epoch);
    assert.equal(BigInt(receipt.revision.sequence), BigInt(sequence) + 1n);
  }
  const api = {
    literalGaps,
    call, run: (command, params = {}) => call('run_command', {command, params}),
    bind: documentId => rpc('workspace.open', documentId),
    snapshot: documentId => rpc('document.snapshot', documentId),
  };
  async function phase(name, work) {
    report.currentPhase = name;
    const started = performance.now();
    try {
      return await work();
    } finally {
      report.elapsedMs[name] = performance.now() - started;
    }
  }
  async function change(expected, variables, ledger) {
    for (const {key, value} of expected) {
      assert.ok(variables.has(key));
      await api.run('variable.set', {variable: variables.get(key), value});
      ledger.push({op: 'set_style', key, value});
    }
  }

  async function sharedValues(original) {
    const {variables} = await api.run('variable.list');
    return sharedLD03Values(variables, original.variableIds);
  }

  try {
    if (prepared) {
      assert.equal(await readFile(ownershipPath, 'utf8'), ownershipToken, 'Prepared profile ownership differs');
      lease = await open(lockPath, 'wx', 0o600);
      report.preparedStart = {descriptorSha256: sha256(preparedBytes), profile,
        beforeSha256: prepared.beforeSha256, cleanupOwner: 'operator', fixtureSeedingInMeasuredWindow: false};
    } else if (preparation.prepare) {
      await writeFile(ownershipPath, ownershipToken, {flag: 'wx', mode: 0o600});
    }
    await phase('serviceStart', async () => { await start(); await connect(); });
    const original = preparedOriginal ?? await phase('setup', () => seedLD03(api, fixture, plan));
    if (preparation.prepare) await phase('startingSave', () => rpc('document.save', original.id));
    report.before = await phase('startingReadback', () => captureLD03(api, original.id, fixture));
    if (prepared || preparation.prepare) validateLD03Baseline(fixture, report.before);
    if (prepared) assert.deepEqual(report.before, prepared.before, 'Prepared native identities or values changed');
    if (preparation.prepare) {
      await phase('preparedServiceStop', stop);
      assert.equal(service.exitCode, 0, 'Prepared service did not exit normally');
      const descriptor = {schema: 'omc-ld03-prepared/1', createdAt: new Date().toISOString(), profile, ownershipToken,
        documentId: original.id, variableIds: report.before.styles.map(row => [row.key, row.native_id]),
        fixtureContentSha256: sha256(JSON.stringify(fixture)), fixtureSha256: fixture.fixture_sha256,
        binarySha256: report.binarySha256, sourceSha256, before: report.before,
        beforeSha256: sha256(JSON.stringify(report.before)), cleanupOwner: 'operator'};
      await writeFile(preparation.prepare, JSON.stringify(descriptor, null, 2) + '\n', {flag: 'wx', mode: 0o600});
      preserveProfile = true;
      report.prepared = {descriptor: preparation.prepare, profile, cleanupOwner: 'operator'};
      report.currentPhase = 'prepared';
      return;
    }
    report.candidateActions = [];
    await phase('candidateEdit', async () => {
      if (!modelCommand) return change(plan.candidate, original.variableIds, report.candidateActions);
      const socketPath = join(profile, 'model.sock');
      report.modelTools = [];
      await withLD03Broker(socketPath, {
        inspect: () => sharedValues(original),
        apply: async ({accent, spacing_px}) => {
          await sharedValues(original);
          await change([{key: 'target.accent', value: accent}, {key: 'target.spacing', value: spacing_px}],
            original.variableIds, report.candidateActions);
          return sharedValues(original);
        },
      }, report.modelTools, () => runLD03Agent(modelCommand, socketPath, signal));
    });
    await phase('candidateSave', () => rpc('document.save', original.id));
    report.candidate = await phase('candidateReadback', () => captureLD03(api, original.id, fixture));
    await phase('normalServiceReopen', async () => {
      await stop();
      assert.equal(service.exitCode, 0, 'The original service did not exit normally');
      await start();
      await connect();
    });
    report.reopened = await phase('reopenedReadback', () => captureLD03(api, original.id, fixture));
    const copy = await phase('verificationCopy', () => api.run('file.duplicate'));
    assert.notEqual(copy.id, original.id, 'Verification must use a separate document');
    const copyBefore = await phase('verificationCopyStart', () => captureLD03(api, copy.id, fixture));
    const copyVariables = new Map(copyBefore.styles.map(style => [style.key, style.native_id]));
    report.probe_actions = [];
    await phase('verificationCopyEdit', () => change(plan.probe, copyVariables, report.probe_actions));
    report.probe = await phase('verificationCopyReadback', () => captureLD03(api, copy.id, fixture));
    report.after_probe_original = await phase('protectedOriginalReadback', () => captureLD03(api, original.id, fixture));
    report.currentPhase = 'complete';
    if (process.env.OMC_BENCH_CANDIDATE) await publishCandidate(process.env.OMC_BENCH_CANDIDATE, report);
  } finally {
    try {
      await stop();
    } finally {
      if (lease) {
        await lease.close();
        await rm(lockPath);
      }
      if (!preserveProfile) await rm(profile, {recursive: true, force: true, maxRetries: 10});
    }
  }
}

async function main() {
  const {values} = parseArgs({options: {
    fixture: {type: 'string'}, 'fixture-only': {type: 'boolean'}, 'model-command': {type: 'string'},
    prepare: {type: 'string'}, prepared: {type: 'string'},
  }});
  assert.ok(values.fixture, 'Supply --fixture from synthetic.py fixture LD03');
  assert.ok(!(values.prepare && values.prepared), 'Choose --prepare or --prepared');
  assert.ok(!values.prepare || (!values['model-command'] && !values['fixture-only']), 'Preparation does not run a model');
  assert.ok(!values.prepared || !values['fixture-only']);
  const fixture = JSON.parse(await readFile(values.fixture, 'utf8'));
  const plan = planLD03(fixture);
  const report = {
    measurementKind: values['model-command'] ? 'installed-headless-model-shared-value-probe' :
      'installed-headless-deterministic-shared-value-probe',
    workload: fixture.workload, variant: fixture.source_family_id, fixtureSha256: fixture.fixture_sha256,
    logicalObjects: fixture.logical_objects, targetReferences: fixture.target_references,
    localOverrides: plan.overrides, elapsedMs: {},
  };
  try {
    if (values['fixture-only']) {
      report.status = 'fixture-only';
      report.bindingsPerVariable = Object.fromEntries(plan.bindingGroups.map(row => [row.style.key, row.keys.length]));
    } else {
      await runLD03(fixture, plan, report, values['model-command'], values);
      report.status = values.prepare ? 'prepared' : 'awaiting-canonical-grade';
    }
  } catch (error) {
    report.status = 'failed';
    report.error = error.message;
    process.exitCode = 1;
  }
  console.log(JSON.stringify(report, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
