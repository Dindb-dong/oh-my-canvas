import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {isDeepStrictEqual} from 'node:util';

import {targetNodeName} from './fixture.mjs';
import {viewportSchedule} from './rendering.mjs';

const operationBudgetMs = 5_000;

export function contentionSchedule(samples, streams) {
  const plan = [{client: 'foreground', type: 'select', atMs: 0}];
  let atMs = 20;
  for (const step of viewportSchedule(samples)) {
    plan.push({client: 'foreground', type: 'viewport', atMs, ...step});
    atMs += 20;
    if (step.command === 'view.zoomOut') {
      plan.push({client: 'foreground', type: 'scalar', atMs, x: step.sample});
      atMs += 20;
    }
  }
  for (let i = 0; i < streams; i++) {
    const client = `background-${i + 1}`;
    plan.push({client, type: 'full-read', atMs: 0});
    plan.push({client, type: 'batch', atMs: 10});
  }
  return plan.sort((a, b) => a.atMs - b.atMs).map((operation, index) => ({
    id: index + 1, deadlineMs: operation.atMs + operationBudgetMs, ...operation,
  }));
}

function externalId(id) {
  assert.match(id, /^doc_[0-9a-f]{32}$/);
  return id.slice(4).replace(/^(........)(....)(....)(....)(............)$/, '$1-$2-$3-$4-$5');
}

function documentTargets(state) {
  assert.equal(state.pages.length, 1);
  const nodes = Object.values(state.nodes);
  assert.equal(nodes.length, 1000);
  return [targetNodeName, 'Probe shape 2'].map(name => {
    const found = nodes.filter(node => node.properties.name === name);
    assert.equal(found.length, 1);
    return found[0];
  });
}

function summary(results) {
  const ok = results.filter(result => result.status === 'verified');
  const ordered = ok.map(result => result.completionMs - result.offeredMs).sort((a, b) => a - b);
  const percentile = p => ordered.length ? ordered[Math.ceil(ordered.length * p) - 1] : null;
  return {
    offered: results.filter(result => result.offeredMs !== undefined).length,
    completed: ok.length,
    failures: results.filter(result => result.status !== 'verified').length,
    lastOutcomeMs: results.length ? Math.max(...results.map(result => result.completionMs)) : null,
    clientWallP50Ms: percentile(0.5), clientWallP95Ms: percentile(0.95),
    clientWallP99Ms: ordered.length >= 1000 ? percentile(0.99) : null,
  };
}

export async function measureContention({
  report, rpc, legacy, figcraft, signal, contentBase64, foreground, sessionId,
}) {
  const context = report.contention;
  const roles = new Map();
  const ui = [foreground];
  const background = [];
  const {result: {sessionId: seedSession}} = await rpc('session.open');
  async function seed(title) {
    const {result} = await rpc('document.import', {format: 'json', contentBase64, title}, seedSession);
    assert.equal(result.title, title);
    documentTargets(result);
    return result;
  }
  try {
    for (let i = 1; i < context.uiDocs; i++) ui.push(await seed(`Native LD08 UI ${i + 1}`));
    for (let i = 0; i < context.streams; i++) background.push(await seed(`Native LD08 background ${i + 1}`));
  } finally {
    await rpc('session.close', {}, seedSession);
  }
  const all = [...ui, ...background];
  assert.equal(new Set(all.map(doc => doc.id)).size, all.length);
  for (const document of [...ui.slice(1), foreground]) {
    const result = await legacy('workspace', {action: 'focus', documentId: externalId(document.id)}, 10_000);
    assert.equal(result.window.documentId, document.id);
    assert.ok(result.window.windows.every(window => window.focused === false));
  }

  async function inspectTabs(expected) {
    const result = await legacy('workspace', {action: 'state'}, 10_000);
    assert.equal(result.window.attached, true);
    assert.ok(result.window.windows.length > 0 && result.window.windows.every(window => window.focused === false));
    const openIds = result.window.windows.flatMap(window => window.files.map(file => file.id));
    assert.deepEqual(openIds.sort(), expected.map(doc => doc.id).sort());
    return openIds;
  }

  context.uiOpenDocumentIds = await inspectTabs(ui);
  context.backgroundOnlyDocumentIds = background.map(doc => doc.id);
  roles.set('foreground', {sessionId, document: foreground});
  for (const [index, document] of background.entries()) {
    const {result: {sessionId}} = await rpc('session.open');
    const {result: opened} = await rpc('workspace.open', {documentId: document.id}, sessionId);
    assert.deepEqual(opened, document);
    roles.set(`background-${index + 1}`, {sessionId, document});
  }
  for (const role of roles.values()) {
    role.targets = documentTargets(role.document);
    role.revision = {epoch: role.document.epoch, sequence: role.document.sequence};
  }

  async function metrics() {
    const {result} = await rpc('workspace.metrics', {}, sessionId);
    return {admission: result.admission, jobs: result.jobs, workerCount: result.workerPids.length, sessions: result.sessions};
  }

  const startingView = await figcraft('run_command', {command: 'view.set', params: {cx: 72, cy: 96, zoom: 1}}, 10_000);
  assert.equal(startingView.zoom, 1);
  assert.equal(startingView.cx, 72);
  assert.equal(startingView.cy, 96);
  context.metricsBefore = await metrics();

  async function edit(role, changes, timeout) {
    const requestId = randomUUID();
    const commands = changes.map(([target, x]) => ({
      type: 'node.set', nodeId: role.targets[target].id, properties: {x},
    }));
    const {result: receipt, ...timing} = await rpc('document.command', {envelope: {
      protocol: 'omc.engine/1', requestId, documentId: role.document.id, targetEpoch: role.revision.epoch,
      idempotencyKey: requestId, preconditions: {revision: role.revision},
      command: commands.length === 1 ? commands[0] : {type: 'batch', commands},
    }}, role.sessionId, timeout);
    assert.equal(receipt.status, 'durable');
    assert.equal(receipt.revision.epoch, role.revision.epoch);
    assert.equal(BigInt(receipt.revision.sequence), BigInt(role.revision.sequence) + 1n);
    role.revision = receipt.revision;
    return {receiptRevision: role.revision, responseBytes: timing.jsonBodyBytes};
  }

  async function execute(operation, timeout) {
    const role = roles.get(operation.client);
    const {id, epoch, sequence} = role.document;
    switch (operation.type) {
      case 'select': {
        const result = await legacy('view', {action: 'select', documentId: externalId(id), ids: [role.targets[0].id]}, timeout);
        assert.equal(result.selection.length, 1);
        return {selection: result.selection};
      }
      case 'viewport': {
        const state = await figcraft('run_command', {command: operation.command, params: operation.params}, timeout);
        for (const key of ['cx', 'cy', 'zoom']) assert.ok(Math.abs(state[key] - operation.expected[key]) < 1e-7);
        return {camera: {cx: state.cx, cy: state.cy, zoom: state.zoom}};
      }
      case 'scalar':
        return edit(role, [[0, operation.x]], timeout);
      case 'batch':
        return edit(role, [[0, 10], [1, 30]], timeout);
      case 'full-read': {
        const {result: observed, ...timing} = await rpc('document.snapshot', {documentId: id}, role.sessionId, timeout);
        assert.equal(observed.id, id);
        assert.equal(observed.epoch, epoch);
        assert.deepEqual(observed.pages, role.document.pages);
        assert.equal(Object.keys(observed.nodes).length, 1000);
        const isInitial = BigInt(observed.sequence) === BigInt(sequence);
        assert.ok(isInitial || BigInt(observed.sequence) === BigInt(sequence) + 1n);
        assert.deepEqual(role.targets.map(node => observed.nodes[node.id].properties.x),
          isInitial ? role.targets.map(node => node.properties.x) : [10, 30]);
        return {observedRevision: {epoch, sequence: observed.sequence}, responseBytes: timing.jsonBodyBytes};
      }
      default:
        throw new Error(`Unknown operation ${operation.type}`);
    }
  }

  const started = performance.now();
  const elapsed = () => performance.now() - started;
  let previous;
  const tasks = [];
  for (const operation of context.schedule) {
    const prerequisite = operation.client === 'foreground' ? previous : undefined;
    const result = {id: operation.id, client: operation.client, type: operation.type, dueMs: operation.atMs};
    report.samples.push(result);
    const task = (async () => {
      try {
        await delay(Math.max(0, operation.atMs - elapsed()), undefined, {signal});
        result.offeredMs = elapsed();
        if (prerequisite && (await prerequisite).status !== 'verified') {
          result.status = 'blocked';
          return result;
        }
        result.dispatchMs = elapsed();
        const remaining = Math.floor(operation.deadlineMs - result.dispatchMs);
        assert.ok(remaining > 0, 'Operation deadline elapsed before dispatch');
        result.detail = await execute(operation, remaining);
        assert.ok(elapsed() <= operation.deadlineMs, 'Operation exceeded its registered deadline');
        result.status = 'verified';
      } catch (error) {
        result.status = 'failed';
        result.error = error.message;
      } finally {
        result.completionMs = elapsed();
      }
      return result;
    })();
    tasks.push(task);
    if (operation.client === 'foreground') previous = task;
  }
  const results = await Promise.all(tasks);
  context.lastOfferMs = Math.max(0, ...results.map(result => result.offeredMs ?? 0));
  context.lastOutcomeMs = Math.max(...results.map(result => result.completionMs));
  context.drainAfterLastOfferMs = context.lastOutcomeMs - context.lastOfferMs;
  context.clients = Object.fromEntries([...roles.keys()].map(client =>
    [client, summary(results.filter(result => result.client === client))]));
  context.metricsAfterWork = await metrics();
  context.uiOpenAfterWork = await inspectTabs(ui);

  context.documentChecks = [];
  try {
    for (const document of all) {
      const role = [...roles.values()].find(candidate => candidate.document.id === document.id);
      const {result: after} = await rpc('document.snapshot', {documentId: document.id}, role?.sessionId ?? sessionId);
      const expectedNodes = {...document.nodes};
      if (role) {
        const changes = document === foreground
          ? [[0, context.schedule.filter(operation => operation.type === 'scalar').length]]
          : [[0, 10], [1, 30]];
        for (const [target, x] of changes) {
          const node = role.targets[target];
          expectedNodes[node.id] = {...node, properties: {...node.properties, x}};
        }
      }
      const expected = {...document, sequence: role?.revision.sequence ?? document.sequence, nodes: expectedNodes};
      const verified = isDeepStrictEqual(after, expected);
      context.documentChecks.push({documentId: document.id, verified});
    }
  } finally {
    for (const role of [...roles.values()].slice(1)) {
      await rpc('workspace.close', {documentId: role.document.id}, role.sessionId);
      await rpc('session.close', {}, role.sessionId);
    }
    for (const document of [...ui].reverse()) {
      await legacy('workspace', {action: 'close', documentId: externalId(document.id)}, 10_000);
    }
    await inspectTabs([]);
    await rpc('workspace.close', {documentId: foreground.id}, sessionId);
    context.allTabsAndExplicitLeasesClosedAtMs = elapsed();
    context.metricsImmediatelyAfterClose = await metrics();
    await delay(250, undefined, {signal});
    context.metricsAfterCloseIdle = await metrics();
    context.postCloseObservationAtMs = elapsed();
  }
  assert.ok(results.every(result => result.status === 'verified'), 'One or more offered operations did not complete');
  assert.ok(context.documentChecks.every(check => check.verified), 'A terminal document did not match its scoped edit');
}
