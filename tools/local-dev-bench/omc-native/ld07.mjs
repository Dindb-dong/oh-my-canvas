import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createHash, randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';

import {pngPixels} from './asset-pressure.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const id = (kind, n) => `${kind}_${n.toString(16).padStart(32, '0')}`;
const rank = n => n.toString(16).padStart(8, '0') + '0'.repeat(24);
const keyFor = node => {
  const {name} = node.properties;
  assert.ok(name.startsWith('LD07 '));
  return name.slice(5);
};
const externalId = raw => {
  assert.match(raw, /^doc_[0-9a-f]{32}$/);
  return raw.slice(4).replace(/^(........)(....)(....)(....)(............)$/, '$1-$2-$3-$4-$5');
};

export function preparedBoard(fixture) {
  assert.equal(fixture.workload, 'LD07');
  assert.ok(['transit-departures', 'clinic-check-in'].includes(fixture.source_family_id));
  const title = fixture.source_family_id === 'transit-departures' ? 'Transit departures' : 'Clinic check-in';
  const [root, shard] = [id('node', 1), id('shard', 1)];
  const {width, height} = fixture.viewport;
  const nodes = {[root]: {id: root, kind: 'frame', parentId: null, homeShard: shard, rank: rank(1),
    properties: {name: title, width, height}}};
  const parents = new Map();
  const counts = new Map();
  for (const [index, row] of fixture.expected.nodes.entries()) {
    const child = id('node', index + 2);
    const parent = row.parent === null ? undefined : parents.get(row.parent);
    assert.ok(row.parent === null || parent);
    const [left, top, width, height] = row.bounds;
    const properties = {
      name: 'LD07 ' + row.key, x: left - (parent?.left ?? 0), y: top - (parent?.top ?? 0), width, height,
    };
    if (row.fill !== undefined) properties.fill = row.fill;
    // The registered cards retain their authored widths when wrapping is disabled.
    if (row.parent === 'board/flow') properties.style = {'flex-shrink': 0};
    if (row.kind === 'text') Object.assign(properties, {
      text: row.text, fontFamily: 'Inter', fontSize: row.key === 'board/title' ? 20 : 12,
      fill: /\/(service(?:-mirror)?|notice)\/label$/.test(row.key) ? '#ffffff' : '#273549',
    });
    if (row.layout) {
      assert.equal(row.layout, 'horizontal');
      properties.layout = {type: 'flex', direction: 'row', wrap: row.wrap, gap: row.gap,
        padding: row.padding, alignContent: 'start'};
      properties.clipContent = row.clip;
    }
    const ordinal = (counts.get(row.parent) ?? 0) + 1;
    counts.set(row.parent, ordinal);
    nodes[child] = {id: child, kind: row.kind, parentId: parent?.id ?? root,
      homeShard: shard, rank: rank(ordinal), properties};
    parents.set(row.key, {id: child, left, top});
  }
  return {title: 'Synthetic LD07 ' + title.toLowerCase(), nodes, metadata: {},
    pages: [{id: id('page', 1), title, rootNodeId: root, rank: rank(1)}]};
}

function scopedNodes(snapshot) {
  assert.equal(snapshot.pages.length, 1);
  const root = snapshot.pages[0].rootNodeId;
  return new Map(Object.values(snapshot.nodes).filter(node => node.id !== root).map(node => [keyFor(node), node]));
}

export function proposedCommands(snapshot, operations, nativeByStyle) {
  const nodes = scopedNodes(snapshot);
  const styleByNative = new Map([...nativeByStyle].map(([name, native]) => [native, name]));
  const observed = [];
  const commands = operations.map(operation => {
    const {collection, key, field, to} = operation;
    if (collection === 'styles') {
      assert.equal(field, 'value');
      const entityId = nativeByStyle.get(key);
      const prefix = 'tokens/' + entityId + '/';
      assert.equal(snapshot.metadata[prefix + 'name'], key);
      const from = snapshot.metadata[prefix + 'value'];
      assert.equal(from, operation.from);
      const modes = snapshot.metadata[prefix + 'modes'];
      assert.deepEqual(Object.values(modes), [from]);
      const [mode] = Object.keys(modes);
      assert.match(to, /^#[0-9a-f]{6}$/i);
      observed.push({collection, key, field, from, to});
      return {type: 'catalog.set', namespace: 'tokens', entityId, properties: {value: to, modes: {[mode]: to}}};
    }
    assert.equal(collection, 'nodes');
    const node = nodes.get(operation.key);
    const {layout, fill} = node.properties;
    let from;
    let properties;
    if (field === 'wrap' || field === 'gap') {
      assert.equal(layout.type, 'flex');
      assert.equal(layout.direction, 'row');
      from = layout[field];
      properties = {layout: {...layout, [field]: to}};
    } else {
      assert.equal(field, 'bindings.fill');
      from = styleByNative.get(fill.$token);
      assert.ok(nativeByStyle.has(operation.to));
      properties = {fill: {$token: nativeByStyle.get(operation.to)}};
    }
    assert.equal(from, operation.from, `Unexpected current value for ${operation.key}.${field}`);
    observed.push({collection: 'nodes', key: keyFor(node), field, from, to: operation.to});
    return {type: 'node.set', nodeId: node.id, properties};
  });
  return {commands, observed};
}

function recordedColor(pixels, bounds) {
  const [x, y, width] = bounds;
  const actual = pixels.at(Math.floor(x + width - 7), Math.floor(y + 5));
  assert.equal(actual[3], 255);
  return '#' + actual.slice(0, 3).map(channel => channel.toString(16).padStart(2, '0')).join('');
}

function normalize(snapshot, geometry, catalog, pixels, fixture) {
  const nodes = scopedNodes(snapshot);
  assert.equal(nodes.size, fixture.logical_objects);
  assert.equal(Object.keys(snapshot.nodes).length, nodes.size + 1);
  assert.equal(String(geometry.revision), String(snapshot.sequence));
  assert.equal(geometry.truncated, false);
  assert.equal(geometry.nodes.length, nodes.size + 1);
  const rawByAlias = new Map(geometry.nodes.map(row => [row.id, row.rawId]));
  const measurements = new Map(geometry.diagnostics.map(row => [rawByAlias.get(row.id), row]));
  assert.equal(measurements.size, nodes.size + 1);
  const keys = new Map([...nodes].map(([key, node]) => [node.id, key]));
  const variableIds = new Set(catalog.variables.map(variable => variable.id));
  assert.equal(catalog.variables.length, 2);
  const styles = catalog.variables.map(variable => {
    assert.equal(variable.type, 'color');
    return {native_id: variable.id, key: variable.name, kind: variable.type, value: variable.value.toLowerCase()};
  });
  const sceneNotes = {overflow: [], clipped: []};
  const rows = [];
  const cards = [...nodes.values()].filter(node => node.parentId === nodes.get('board/flow').id)
    .sort((a, b) => a.rank.localeCompare(b.rank));
  for (const [key, node] of nodes) {
    const {properties: props, parentId} = node;
    const item = measurements.get(node.id);
    const {x, y, width, height} = item.bounds;
    const bounds = [x, y, width, height];
    assert.ok(bounds.every(Number.isFinite));
    if (item.overflowParent) sceneNotes.overflow.push(key);
    if (item.clippedText) sceneNotes.clipped.push(key);
    const parent = parentId === snapshot.pages[0].rootNodeId ? null : keys.get(parentId);
    const row = {key, native_id: node.id, kind: node.kind, parent, bounds,
      editable: props.locked !== true && props.hidden !== true && props.visible !== false};
    if (node.kind === 'text') row.text = props.text;
    else if (typeof props.fill === 'string') row.fill = props.fill.toLowerCase();
    if (props.fill && typeof props.fill === 'object') {
      assert.deepEqual(Object.keys(props.fill), ['$token']);
      assert.ok(variableIds.has(props.fill.$token), 'Unexpected scoped fill reference');
      row.bindings = {fill: props.fill.$token};
      row.fill = recordedColor(pixels, bounds);
    }
    if (props.layout) {
      assert.equal(props.layout.type, 'flex');
      assert.equal(props.layout.direction, 'row');
      Object.assign(row, {layout: 'horizontal', wrap: props.layout.wrap, gap: props.layout.gap,
        padding: props.layout.padding, clip: props.clipContent});
    }
    if (parent === 'board/flow') row.order = cards.indexOf(node);
    rows.push(row);
  }
  return {document_id: snapshot.id, nodes: rows, styles, sceneNotes};
}

async function run(fixture, report, signal, artifactDir) {
  const {Client, StreamableHTTPClientTransport} = await import('../replays/mcp.mjs');
  const binary = join(process.env.OMC_BENCH_BIN_DIR ?? '/Applications/Oh My Canvas.app/Contents/MacOS', 'omc-service');
  report.binarySha256 = digest(await readFile(binary));
  const profile = await mkdtemp(join(tmpdir(), 'omc-ld07-'));
  const descriptorPath = join(profile, 'native-v1/service.json');
  let service, client, transport, descriptor, observer, writer;

  async function rpc(method, params, sessionId) {
    const endpoint = new URL(descriptor.endpoint);
    assert.equal(endpoint.hostname, '127.0.0.1');
    const response = await fetch(new URL('/rpc', endpoint), {
      method: 'POST',
      headers: {Authorization: `Bearer ${descriptor.token}`, 'Content-Type': 'application/json',
        ...(sessionId && {'X-OMC-Session': sessionId})},
      body: JSON.stringify({id: randomUUID(), method, params}),
      signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
    });
    const bytes = await response.arrayBuffer();
    const payload = JSON.parse(Buffer.from(bytes).toString('utf8'));
    assert.ok(response.ok && !payload.error, `${method}: ${payload.error?.code} ${payload.error?.message}`);
    return {value: payload.result, bytes: bytes.byteLength};
  }
  async function start() {
    service = spawn(binary, ['--profile', profile, '--port', '0'], {stdio: ['ignore', 2, 2]});
    await once(service, 'spawn');
    descriptor = undefined;
    for (let i = 0; i < 200 && !descriptor; i++) {
      signal.throwIfAborted();
      assert.ok(service.exitCode === null && service.signalCode === null);
      try {
        const found = JSON.parse(await readFile(descriptorPath, 'utf8'));
        if (found.pid === service.pid) descriptor = found;
      } catch (error) {
        if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
      }
      if (!descriptor) await delay(25, undefined, {signal});
    }
    assert.ok(descriptor);
    ({value: {sessionId: writer}} = await rpc('session.open', {}));
    ({value: {sessionId: observer}} = await rpc('session.open', {}));
    client = new Client({name: 'omc-ld07-replay', version: '1'});
    transport = new StreamableHTTPClientTransport(new URL('/mcp/figcraft', descriptor.endpoint), {
      requestInit: {headers: {Authorization: `Bearer ${descriptor.token}`}},
    });
    await client.connect(transport, {signal, timeout: 10_000});
  }
  async function stop() {
    try {
      await client?.close();
    } finally {
      if (service?.pid && service.exitCode === null && service.signalCode === null) {
        const exited = once(service, 'exit');
        const watchdog = setTimeout(() => service.kill('SIGKILL'), 4000);
        service.kill('SIGINT');
        try {
          await exited;
        } finally {
          clearTimeout(watchdog);
        }
      }
    }
  }
  async function call(name, args) {
    const result = await client.callTool({name, arguments: args}, undefined, {signal, timeout: 20_000});
    assert.ok(!result.isError, `${args.command ?? name}: ${result.content[0]?.text}`);
    return result.structuredContent ?? JSON.parse(result.content[0].text);
  }
  const command = (name, params = {}) => call('run_command', {command: name, params});
  const catalog = () => command('variable.list');
  async function mutate(snapshot, plan) {
    const {id: documentId, epoch, sequence} = snapshot;
    const requestId = randomUUID();
    const {value: receipt} = await rpc('document.command', {envelope: {
      protocol: 'omc.engine/1', requestId, documentId, targetEpoch: epoch, idempotencyKey: requestId,
      preconditions: {revision: {epoch, sequence}}, command: {type: 'batch', commands: plan.commands},
    }}, writer);
    assert.equal(receipt.status, 'durable');
    assert.equal(receipt.revision.epoch, epoch);
    assert.equal(BigInt(receipt.revision.sequence), BigInt(sequence) + 1n);
    const {value: after} = await rpc('document.snapshot', {documentId}, observer);
    const expected = structuredClone(snapshot);
    expected.sequence = receipt.revision.sequence;
    for (const {type, nodeId, namespace, entityId, properties} of plan.commands) {
      if (type === 'catalog.set') {
        for (const [key, value] of Object.entries(properties)) expected.metadata[[namespace, entityId, key].join('/')] = value;
      } else {
        Object.assign(expected.nodes[nodeId].properties, properties);
      }
    }
    assert.deepEqual(after, expected, 'Only the two intended authored properties may change');
    return after;
  }
  async function phase(name, work) {
    report.currentPhase = name;
    const start = performance.now();
    try { return await work(); } finally { report.elapsedMs[name] = performance.now() - start; }
  }

  try {
    await phase('serviceStart', start);
    const {value: imported} = await phase('healthyImport', () => rpc('document.import', {
      format: 'json', contentBase64: Buffer.from(JSON.stringify(preparedBoard(fixture))).toString('base64'),
    }, writer));
    const documentId = imported.id;
    const tool = (name, args) => rpc('tool.call', {
      name, arguments: {documentId: externalId(documentId), ...args},
    }, observer);
    const idOf = await phase('healthyBindings', async () => {
      await rpc('workspace.open', {documentId}, transport.sessionId);
      const inspected = await call('inspect_document', {depth: 7});
      assert.equal(inspected.id, externalId(documentId));
      const aliases = new Map();
      function walk(layer) {
        aliases.set(layer.name.slice(5), layer.id);
        for (const child of layer.children ?? []) walk(child);
      }
      for (const layer of inspected.layers) walk(layer);
      const collectionName = fixture.source_family_id === 'transit-departures' ? 'Departure color families' : 'Clinic color families';
      const {id: collection} = await command('variable.createCollection', {name: collectionName});
      const ids = new Map();
      for (const style of fixture.expected.styles) {
        const variable = await command('variable.create', {collection, name: style.key, type: style.kind, value: style.value});
        ids.set(style.key, variable.id);
        const targets = fixture.expected.nodes.filter(row => row.bindings?.fill === style.key);
        await command('variable.bind', {ids: targets.map(row => aliases.get(row.key)), field: 'fill', variable: variable.id});
      }
      assert.equal(new Set(ids.values()).size, 2);
      return ids;
    });
    const {value: healthy} = await rpc('document.snapshot', {documentId}, observer);
    const injection = proposedCommands(healthy, fixture.injections, idOf);
    const faulty = await phase('fixtureFaultInjection', () => mutate(healthy, injection));
    report.injections = injection.observed;

    async function capture(snapshot, phaseName, file) {
      const geometry = (await tool('get_tree', {depth: 7, detail: 'detailed'})).value;
      const pageId = snapshot.pages[0].id;
      const {width, height} = fixture.viewport;
      const {value: exported} = await rpc('document.export', {
        documentId, pageId, format: 'png', bounds: {x: 0, y: 0, width, height},
      }, observer);
      assert.equal(exported.mediaType, 'image/png');
      assert.deepEqual(exported.revision, {epoch: snapshot.epoch, sequence: snapshot.sequence});
      assert.deepEqual(exported.diagnostics, []);
      const png = Buffer.from(exported.contentBase64, 'base64');
      await writeFile(join(artifactDir, file), png, {flag: 'wx', mode: 0o600});
      const pixels = pngPixels(png, width, height);
      const state = normalize(snapshot, geometry, await catalog(), pixels, fixture);
      assert.deepEqual((await rpc('document.snapshot', {documentId}, observer)).value, snapshot);
      return {state, artifact: {sha256: digest(png), width, height, document_id: snapshot.id, phase: phaseName}};
    }
    const symptom = await phase('symptomCaptureAndReadback', () => capture(faulty, 'before', fixture.symptom_screenshot_name));
    report.before = symptom.state;
    report.symptom_capture = symptom.artifact;
    const repair = await phase('scopedDiagnosis', async () => {
      const scopes = scopedNodes(faulty);
      const full = await tool('get_tree', {depth: 7, detail: 'detailed'});
      const scoped = [];
      const plan = proposedCommands(faulty, fixture.repair_actions, idOf);
      for (const {collection, key, from} of plan.observed) {
        if (collection === 'styles') {
          const actual = await tool('native_tokens', {version: '1', action: 'list'});
          assert.deepEqual(actual.value.revision, {epoch: faulty.epoch, sequence: faulty.sequence});
          const style = actual.value.items.find(item => item.id === idOf.get(key));
          assert.equal(style.name, key);
          assert.equal(style.value, from);
          assert.deepEqual(Object.values(style.modes), [from]);
          scoped.push({key, bytes: actual.bytes, scope: 'token-catalog'});
        } else {
          const actual = await tool('get_tree', {id: scopes.get(key).id, depth: 1, detail: 'detailed'});
          assert.equal(actual.value.nodes[0].rawId, scopes.get(key).id);
          assert.equal(String(actual.value.revision), String(faulty.sequence));
          assert.deepEqual(actual.value.nodes[0].properties, scopes.get(key).properties);
          scoped.push({key, bytes: actual.bytes, scope: 'node-subtree'});
        }
      }
      report.readPayloadBytes = {wholeDocument: full.bytes, scoped};
      report.diagnoses = plan.observed.map(({to, ...observed}) => observed);
      return plan;
    });
    const healed = await phase('repair', () => mutate(faulty, repair));
    report.repair_actions = repair.observed;
    await phase('save', () => rpc('document.save', {documentId}, writer));
    const candidate = await phase('candidateReadback', () => capture(healed, 'candidate', 'candidate.png'));
    report.candidate = candidate.state;
    report.candidate_capture = candidate.artifact;
    assert.notEqual(report.candidate_capture.sha256, report.symptom_capture.sha256);

    await phase('normalProcessReopen', async () => {
      await stop();
      assert.equal(service.exitCode, 0);
      await start();
      await rpc('workspace.open', {documentId}, observer);
      await rpc('workspace.open', {documentId}, transport.sessionId);
    });
    const {value: reopened} = await rpc('document.snapshot', {documentId}, observer);
    assert.deepEqual(reopened, healed);
    const final = await phase('reopenedReadback', () => capture(reopened, 'reopened', 'reopened.png'));
    report.reopened = final.state;
    report.reopened_capture = final.artifact;
    assert.equal(report.reopened_capture.sha256, report.candidate_capture.sha256);
    report.currentPhase = 'complete';
  } finally {
    try { await stop(); } finally { await rm(profile, {recursive: true, force: true, maxRetries: 10}); }
  }
}

async function main() {
  const {values} = parseArgs({options: {fixture: {type: 'string'}, 'artifact-dir': {type: 'string'}, 'fixture-only': {type: 'boolean'}}});
  assert.ok(values.fixture && (values['fixture-only'] || values['artifact-dir']));
  const fixture = JSON.parse(await readFile(values.fixture, 'utf8'));
  const report = {measurementKind: 'installed-omc-deterministic-defect-replay', workload: 'LD07',
    variant: fixture.source_family_id, fixtureSha256: fixture.fixture_sha256, elapsedMs: {}};
  const controller = new AbortController();
  for (const event of ['SIGTERM', 'SIGINT']) process.once(event, () => controller.abort(new Error(event)));
  try {
    if (values['fixture-only']) {
      const prepared = preparedBoard(fixture);
      report.fixtureProjectionSha256 = digest(JSON.stringify(prepared));
      report.logicalObjects = Object.keys(prepared.nodes).length - 1;
      report.status = 'fixture-only';
    } else {
      const artifactDir = values['artifact-dir'];
      await mkdir(artifactDir, {recursive: true});
      await run(fixture, report, controller.signal, artifactDir);
      report.status = 'awaiting-canonical-grade';
    }
  } catch (error) {
    report.status = 'failed';
    report.error = error.message;
    process.exitCode = 1;
  }
  console.log(JSON.stringify(report, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
