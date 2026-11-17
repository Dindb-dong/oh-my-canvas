import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createHash, randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';

const id = (kind, n) => `${kind}_${n.toString(16).padStart(32, '0')}`;
const rank = n => n.toString(16).padStart(8, '0') + '0'.repeat(24);
const sha256 = value => createHash('sha256').update(value).digest('hex');
const externalId = native => {
  assert.match(native, /^doc_[0-9a-f]{32}$/);
  return native.slice(4).replace(/^(........)(....)(....)(....)(............)$/, '$1-$2-$3-$4-$5');
};
const nativeId = external => {
  assert.match(external, /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
  return 'doc_' + external.replaceAll('-', '');
};

export function atlasIndex(fixture) {
  assert.equal(fixture.schema, 'omc-local-dev/workload-fixture/1');
  assert.equal(fixture.workload, 'LD02');
  assert.equal(fixture.source_family_id, 'conservation-atlas');
  assert.equal(fixture.start.pages.length, 10);
  assert.equal(fixture.logical_objects, 1000);
  assert.equal(fixture.start.nodes.length, 1000);
  const children = new Map();
  const byKey = new Map();
  for (const row of fixture.start.nodes) {
    assert.ok(!byKey.has(row.key));
    assert.ok(row.parent === null || byKey.get(row.parent)?.page === row.page);
    byKey.set(row.key, row);
    const parent = row.parent ?? row.page;
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(row);
  }
  const card = byKey.get(fixture.edit.find(edit => edit.field === 'gap').key);
  const query = {name: card.name, receipt: byKey.get(card.key + '/receipt').text};
  return {children, byKey, query};
}

export function nativeDocument(fixture, {byKey, children}) {
  const nodes = {};
  const roots = new Map();
  const nodeIds = new Map();
  let next = 1;
  const pages = fixture.start.pages.map(({key, name}, index) => {
    const root = id('node', next++);
    const shard = id('shard', index + 1);
    roots.set(key, {root, shard});
    nodes[root] = {id: root, kind: 'frame', parentId: null, rank: rank(1), homeShard: shard,
      properties: {name, width: fixture.viewport.width, height: fixture.viewport.height}};
    return {id: id('page', index + 1), title: name, rootNodeId: root, rank: rank(index + 1)};
  });
  for (const row of fixture.start.nodes) {
    const key = id('node', next++);
    const {root, shard} = roots.get(row.page);
    const parent = byKey.get(row.parent);
    const [x, y, width, height] = row.bounds;
    const properties = {name: row.name, x: x - (parent?.bounds[0] ?? 0), y: y - (parent?.bounds[1] ?? 0), width, height};
    if (row.fill !== undefined) properties.fill = row.fill;
    if (row.layout === 'vertical') {
      properties.layout = {type: 'flex', direction: 'column', gap: row.gap, padding: row.padding};
    }
    if (row.kind === 'text') {
      Object.assign(properties, {text: row.text, fontFamily: 'Inter', fontSize: 13, fill: '#222222'});
    }
    if (row.kind === 'rectangle') properties.cornerRadius = row.radius;
    const siblings = children.get(row.parent ?? row.page);
    nodes[key] = {
      id: key, kind: row.kind === 'rectangle' ? 'rect' : row.kind, parentId: parent ? nodeIds.get(parent.key) : root,
      homeShard: shard, rank: rank(siblings.indexOf(row) + 1), properties,
    };
    nodeIds.set(row.key, key);
  }
  return {title: 'Synthetic LD02 conservation atlas', pages, nodes, metadata: {}};
}

function rankedChildren(raw) {
  const children = new Map();
  for (const node of Object.values(raw.nodes)) {
    if (!children.has(node.parentId)) children.set(node.parentId, []);
    children.get(node.parentId).push(node);
  }
  for (const siblings of children.values()) siblings.sort((a, b) => a.rank.localeCompare(b.rank) || a.id.localeCompare(b.id));
  return children;
}

export function findStation(raw, query) {
  const children = rankedChildren(raw);
  const matches = Object.values(raw.nodes).filter(node => node.kind === 'frame' && node.properties.name === query.name
    && children.get(node.id)?.some(child => child.kind === 'text' && child.properties.name === 'receipt'
      && child.properties.text === query.receipt));
  assert.equal(matches.length, 1, 'Name and receipt must identify one real station');
  const [frame] = matches;
  const one = (name, kind) => {
    const found = children.get(frame.id).filter(node => node.kind === kind && node.properties.name === name);
    assert.equal(found.length, 1);
    return found[0];
  };
  return {text: one('status', 'text'), gap: frame, radius: one('marker', 'rect')};
}

export function normalizeAtlas(raw, scenePages, fixture, index) {
  const children = rankedChildren(raw);
  const nodes = [];
  const pages = [];
  const sceneChecks = {clippedTextNativeIds: [], overflowParentNativeIds: []};
  assert.equal(raw.pages.length, fixture.start.pages.length);
  assert.equal(Object.keys(raw.nodes).length, fixture.logical_objects + raw.pages.length);
  assert.ok(Object.keys(raw.metadata).every(key => !/^(?:styles|tokens|figcraftCollections)\//.test(key)));
  for (let i = 0; i < raw.pages.length; i++) {
    const native = raw.pages[i];
    const specPage = fixture.start.pages[i];
    assert.equal(native.title, specPage.name);
    pages.push({key: specPage.key, name: native.title, native_id: native.id});
    const scene = scenePages.get(native.id);
    assert.equal(scene.truncated, false);
    assert.equal(String(scene.revision), String(raw.sequence));
    assert.equal(scene.nodes.length, 101);
    assert.equal(scene.diagnostics.length, 101);
    assert.equal(scene.nodes[0].rawId, native.rootNodeId);
    const aliasToRaw = new Map(scene.nodes.map(row => [row.id, row.rawId]));
    const rawBounds = new Map(scene.diagnostics.map(row => [aliasToRaw.get(row.id), row]));
    assert.equal(rawBounds.size, 101);

    function walk(parent, logicalParent, editable) {
      const actual = children.get(parent) ?? [];
      const expected = index.children.get(logicalParent ?? specPage.key) ?? [];
      assert.equal(actual.length, expected.length, `Wrong child count under ${logicalParent ?? specPage.key}`);
      for (const [order, node] of actual.entries()) {
        const {key} = expected[order];
        const props = node.properties;
        const layout = rawBounds.get(node.id);
        const {x, y, width, height} = layout.bounds;
        const bounds = [x, y, width, height];
        assert.ok(bounds.every(Number.isFinite));
        if (layout.clippedText) sceneChecks.clippedTextNativeIds.push(node.id);
        if (layout.overflowParent) sceneChecks.overflowParentNativeIds.push(node.id);
        const row = {key, page: specPage.key, native_id: node.id, parent: logicalParent,
          kind: node.kind === 'rect' ? 'rectangle' : node.kind, name: props.name, bounds,
          editable: editable && props.visible !== false && props.hidden !== true && props.locked !== true};
        if (node.kind === 'text') row.text = props.text;
        else if (typeof props.fill === 'string') row.fill = props.fill.toLowerCase();
        if (props.cornerRadius !== undefined) row.radius = props.cornerRadius;
        if (props.layout?.type === 'flex' && props.layout.direction === 'column') {
          row.layout = 'vertical';
          row.gap = props.layout.gap;
          row.padding = props.layout.padding;
        }
        if (logicalParent && index.byKey.get(logicalParent).layout) row.order = order;
        if (props.fillStyleId || props.textStyleId || props.figcraftVariableBindings) row.bindings = {unregistered: true};
        nodes.push(row);
        walk(node.id, key, row.editable);
      }
    }
    walk(native.rootNodeId, null, true);
  }
  assert.equal(nodes.length, fixture.logical_objects);
  return {document_id: raw.id, nodes, pages, styles: [], sceneChecks};
}

const observedValue = (field, node) => ({
  text: node.properties.text, gap: node.properties.layout?.gap, radius: node.properties.cornerRadius,
})[field];

export function verifyWrites(before, after, targets, changes) {
  assert.deepEqual(after.pages, before.pages);
  assert.deepEqual(after.metadata, before.metadata);
  assert.equal(after.id, before.id);
  assert.equal(after.epoch, before.epoch);
  assert.equal(after.title, before.title);
  const expected = {...before.nodes};
  for (const change of changes) {
    const node = targets[change.field];
    const props = node.properties;
    assert.equal(observedValue(change.field, node), change.from);
    switch (change.field) {
      case 'text': {
        const runs = props.textRuns;
        assert.equal(runs.length, 1);
        expected[node.id] = {...node, properties: {...props, text: change.to, textRuns: [{...runs[0], text: change.to}]}};
        break;
      }
      case 'gap':
        expected[node.id] = {...node, properties: {...props, layout: {...props.layout, gap: change.to}}};
        break;
      case 'radius':
        expected[node.id] = {...node, properties: {...props, cornerRadius: change.to}};
        break;
      default:
        throw new Error(`Unknown atlas field ${change.field}`);
    }
  }
  assert.deepEqual(after.nodes, expected, 'Unexpected current node structure or property changes');
}

async function execute(fixture, index, report, signal) {
  const {Client, StreamableHTTPClientTransport} = await import('../replays/mcp.mjs');
  const binaryDir = process.env.OMC_BENCH_BIN_DIR ?? '/Applications/Oh My Canvas.app/Contents/MacOS';
  const serviceBinary = join(binaryDir, 'omc-service');
  const desktopBinary = join(binaryDir, 'omc-desktop');
  report.binaries = {service: sha256(await readFile(serviceBinary)), desktop: sha256(await readFile(desktopBinary))};
  const profile = await mkdtemp(join(tmpdir(), 'omc-ld02-atlas-'));
  let environment;

  async function stop(child, graceful) {
    if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit');
    child.kill(graceful ? 'SIGINT' : 'SIGTERM');
    const watchdog = setTimeout(() => child.kill('SIGKILL'), 5000);
    try {
      await exited;
    } finally {
      clearTimeout(watchdog);
    }
  }

  async function shutdown() {
    if (!environment) return;
    const {desktop, service, clients} = environment;
    try {
      await Promise.all([stop(desktop, false), ...clients.map(client => client.close())]);
    } finally {
      await stop(service, true);
    }
  }

  async function start() {
    environment = {clients: []};
    const service = spawn(serviceBinary, ['--profile', profile, '--port', '0'], {stdio: ['ignore', 2, 2]});
    environment.service = service;
    await once(service, 'spawn');
    let descriptor;
    for (let attempt = 0; attempt < 200 && !descriptor; attempt++) {
      signal.throwIfAborted();
      assert.ok(service.exitCode === null && service.signalCode === null);
      try {
        const found = JSON.parse(await readFile(join(profile, 'native-v1/service.json'), 'utf8'));
        if (found.pid === service.pid) descriptor = found;
      } catch (error) {
        if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
      }
      if (!descriptor) await delay(25, undefined, {signal});
    }
    assert.ok(descriptor);
    const endpoint = new URL(descriptor.endpoint);
    assert.equal(endpoint.hostname, '127.0.0.1');
    const headers = {Authorization: `Bearer ${descriptor.token}`};
    environment.rpc = async (method, params, sessionId) => {
      const response = await fetch(new URL('/rpc', endpoint), {
        method: 'POST',
        headers: {...headers, 'Content-Type': 'application/json', ...(sessionId ? {'X-OMC-Session': sessionId} : {})},
        body: JSON.stringify({id: randomUUID(), method, params}),
        signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
      });
      const payload = await response.json();
      assert.ok(response.ok && !payload.error, `${method}: ${payload.error?.code} ${payload.error?.message}`);
      return payload.result;
    };
    for (const [name, path] of [['legacy', '/mcp'], ['fig', '/mcp/figcraft']]) {
      const client = new Client({name: `omc-atlas-${name}`, version: '1'});
      environment.clients.push(client);
      const transport = new StreamableHTTPClientTransport(new URL(path, endpoint), {requestInit: {headers}});
      await client.connect(transport, {signal, timeout: 10_000});
      environment[name] = {
        sessionId: transport.sessionId,
        call: async (tool, args) => {
          const result = await client.callTool({name: tool, arguments: args}, undefined, {signal, timeout: 20_000});
          assert.ok(!result.isError, `${tool}: ${result.content[0]?.text}`);
          return result.structuredContent ?? JSON.parse(result.content[0].text);
        },
      };
    }
    environment.writer = (await environment.rpc('session.open', {})).sessionId;
    environment.observer = (await environment.rpc('session.open', {})).sessionId;
  }

  async function focus(documentId) {
    const {legacy} = environment;
    if (!environment.desktop) {
      const desktop = spawn(desktopBinary, ['--profile', profile, '--automation-background'], {stdio: ['ignore', 2, 2]});
      environment.desktop = desktop;
      await once(desktop, 'spawn');
      let attached;
      for (let i = 0; i < 40 && !attached; i++) {
        assert.ok(desktop.exitCode === null && desktop.signalCode === null);
        attached = (await legacy.call('workspace', {action: 'state'})).window?.attached;
        if (!attached) await delay(100, undefined, {signal});
      }
      assert.equal(attached, true, 'Isolated desktop did not attach');
    }
    const result = await legacy.call('workspace', {action: 'focus', documentId: externalId(documentId)});
    assert.equal(result.window.documentId, documentId);
    assert.ok(result.window.windows.every(window => window.focused === false));
  }

  async function capture(documentId, verifySelection = false) {
    const {rpc, observer, legacy} = environment;
    const raw = await rpc('document.snapshot', {documentId}, observer);
    assert.equal(raw.id, documentId);
    const scenes = new Map();
    const call = (name, args) => rpc('tool.call', {name, arguments: {documentId: externalId(documentId), ...args}}, observer);
    for (const page of raw.pages) {
      const selected = await call('select_page', {id: page.id});
      assert.equal(selected.page.id, page.id);
      scenes.set(page.id, await call('get_tree', {depth: 3, detail: 'detailed'}));
    }
    const normalized = normalizeAtlas(raw, scenes, fixture, index);
    if (verifySelection) {
      const window = (await legacy.call('workspace', {action: 'state'})).window;
      assert.equal(window.attached, true);
      assert.equal(window.documentId, documentId);
      assert.ok(window.windows.length && window.windows.every(row => row.focused === false));
      assert.ok(Array.isArray(window.selection));
      assert.deepEqual(window.selection, []);
      normalized.selected_native_ids = window.selection;
      normalized.observedDesktopPageId = window.pageId;
    }
    assert.deepEqual(await rpc('document.snapshot', {documentId}, observer), raw);
    return {raw, normalized};
  }

  async function edit(documentId, captureBefore) {
    const {rpc, writer} = environment;
    const discoveryStarted = performance.now();
    const raw = await rpc('document.snapshot', {documentId}, writer);
    assert.deepEqual(raw, captureBefore.raw);
    const target = findStation(raw, index.query);
    const keyByNative = new Map(captureBefore.normalized.nodes.map(node => [node.native_id, node.key]));
    const ledger = fixture.edit.map(change => ({
      key: keyByNative.get(target[change.field].id), field: change.field,
      from: observedValue(change.field, target[change.field]), to: change.to,
    }));
    assert.deepEqual(ledger, fixture.edit);
    const discoveryMs = performance.now() - discoveryStarted;
    const requestId = randomUUID();
    const commands = ledger.map(({field, to}) => {
      const {id: nodeId, properties} = target[field];
      if (field === 'text') return {type: 'text.replace', nodeId, text: to};
      return {type: 'node.set', nodeId, properties: field === 'gap'
        ? {layout: {...properties.layout, gap: to}} : {cornerRadius: to}};
    });
    const receipt = await rpc('document.command', {envelope: {
      protocol: 'omc.engine/1', requestId, documentId, targetEpoch: raw.epoch,
      idempotencyKey: requestId, preconditions: {revision: {epoch: raw.epoch, sequence: raw.sequence}},
      command: {type: 'batch', commands},
    }}, writer);
    assert.equal(receipt.status, 'durable');
    assert.equal(receipt.revision.epoch, raw.epoch);
    assert.equal(BigInt(receipt.revision.sequence), BigInt(raw.sequence) + 1n);
    return {ledger, target, discoveryMs, revision: receipt.revision};
  }

  async function phase(name, fn) {
    report.currentPhase = name;
    const started = performance.now();
    try {
      return await fn();
    } finally {
      report.elapsedMs[name] = performance.now() - started;
    }
  }

  try {
    await phase('serviceStart', start);
    const original = await phase('fixtureImport', () => environment.rpc('document.import', {
      format: 'json', contentBase64: Buffer.from(JSON.stringify(nativeDocument(fixture, index))).toString('base64'),
    }, environment.writer));
    await phase('originalBackgroundOpen', () => focus(original.id));
    const before = await phase('startingReadback', () => capture(original.id, true));
    report.before = before.normalized;
    const copied = await phase('verificationDuplicate', async () => {
      await environment.rpc('workspace.open', {documentId: original.id}, environment.fig.sessionId);
      const result = await environment.fig.call('run_command', {command: 'file.duplicate', params: {}});
      const distinct = nativeId(result.id);
      assert.notEqual(distinct, original.id);
      return distinct;
    });
    const primary = await phase('candidateDiscoveryAndEdit', () => edit(original.id, before));
    report.elapsedMs.candidateDiscoveryOnly = primary.discoveryMs;
    report.edit = primary.ledger;
    report.candidateRevision = primary.revision;
    await phase('candidateSave', () => environment.rpc('document.save', {documentId: original.id}, environment.writer));
    const candidate = await phase('candidateReadback', () => capture(original.id));
    verifyWrites(before.raw, candidate.raw, primary.target, primary.ledger);
    report.candidate = candidate.normalized;

    await phase('normalServiceReopen', async () => {
      await environment.legacy.call('workspace', {action: 'close', documentId: externalId(original.id)});
      await shutdown();
      assert.equal(environment.service.exitCode, 0, 'Service did not shut down normally');
      await start();
      await environment.rpc('workspace.open', {documentId: original.id}, environment.observer);
    });
    const reopened = await phase('reopenedReadback', () => capture(original.id));
    assert.deepEqual(reopened.raw, candidate.raw);
    report.reopened = reopened.normalized;
    await phase('copyBackgroundOpen', () => focus(copied));
    const copyBefore = await phase('copyStartingReadback', () => capture(copied, true));
    report.copy_before = copyBefore.normalized;
    await environment.rpc('workspace.open', {documentId: copied}, environment.writer);
    const copyEdit = await phase('copyDiscoveryAndEdit', () => edit(copied, copyBefore));
    report.elapsedMs.copyDiscoveryOnly = copyEdit.discoveryMs;
    const copyAfter = await phase('copyEditedReadback', () => capture(copied));
    verifyWrites(copyBefore.raw, copyAfter.raw, copyEdit.target, copyEdit.ledger);
    report.copy_edited = copyAfter.normalized;
    report.copy_history = {undo_count: 0, redo_count: 0};
    for (const [action, expected] of [['undo', copyBefore.raw], ['redo', copyAfter.raw]]) {
      const receipt = await phase(`copy_${action}_command`, () => environment.rpc(`document.${action}`, {
        documentId: copied, targetEpoch: copyBefore.raw.epoch,
      }, environment.writer));
      assert.equal(receipt.status, 'durable');
      assert.equal(receipt.revision.epoch, expected.epoch);
      report.copy_history[action + '_count']++;
      const actual = await phase(`copy_${action}_readback`, () => capture(copied));
      assert.deepEqual(actual.raw, {...expected, sequence: receipt.revision.sequence});
      report[`copy_${action}`] = actual.normalized;
    }
    const protectedOriginal = await phase('protectedOriginalReadback', () => capture(original.id));
    assert.deepEqual(protectedOriginal.raw, candidate.raw);
    report.after_probe_original = protectedOriginal.normalized;
    report.currentPhase = 'complete';
  } finally {
    try {
      await shutdown();
    } finally {
      await rm(profile, {recursive: true, force: true, maxRetries: 10});
    }
  }
}

async function main() {
  const {values} = parseArgs({options: {fixture: {type: 'string'}, 'fixture-only': {type: 'boolean'}}});
  assert.ok(values.fixture, 'Provide the canonical LD02 conservation-atlas fixture');
  const fixture = JSON.parse(await readFile(values.fixture, 'utf8'));
  const index = atlasIndex(fixture);
  const report = {measurementKind: 'installed-omc-canonical-deterministic-atlas', workload: fixture.workload,
    variant: fixture.source_family_id, fixtureSha256: fixture.fixture_sha256, elapsedMs: {}};
  const controller = new AbortController();
  for (const event of ['SIGINT', 'SIGTERM']) process.once(event, () => controller.abort(new Error(event)));
  try {
    if (values['fixture-only']) {
      const document = nativeDocument(fixture, index);
      report.nativeFixtureSha256 = sha256(JSON.stringify(document));
      report.logicalObjects = Object.keys(document.nodes).length - document.pages.length;
      report.pages = document.pages.length;
      findStation(document, index.query);
      report.status = 'fixture-only';
    } else {
      await execute(fixture, index, report, controller.signal);
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
