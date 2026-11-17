import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {stat} from 'node:fs/promises';
import {join} from 'node:path';

export function* historySchedule(edits, placement, targetCount) {
  assert.ok(Number.isInteger(edits) && edits >= 0 && edits % 2 === 0);
  assert.ok(['concentrated', 'distributed'].includes(placement));
  assert.ok(Number.isInteger(targetCount) && targetCount >= 2);
  for (let pair = 0; pair < edits / 2; pair++) {
    const target = placement === 'concentrated' ? 0 : pair % targetCount;
    yield {target, delta: 1};
    yield {target, delta: 0};
  }
}

async function storageBytes(profile, documentId) {
  assert.match(documentId, /^doc_[0-9a-f]{32}$/);
  const database = join(profile, 'native-v1', 'documents', documentId, 'document.sqlite');
  const {size: sqlite} = await stat(database);
  try {
    const {size: wal} = await stat(database + '-wal');
    return {sqlite, wal};
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return {sqlite, wal: 0};
  }
}

function revisionOf({epoch, sequence}) {
  return {epoch, sequence};
}

export async function measureHistory({
  rpc, restart, signal, profile, documentId, sessionId, initial,
  authoredShapes, report, placement, edits, samples,
}) {
  const targets = authoredShapes.map(authored => {
    const matches = Object.values(initial.nodes).filter(node => node.properties.name === authored.name);
    assert.equal(matches.length, 1, `One imported target for ${authored.name}`);
    const [node] = matches;
    for (const [property, value] of Object.entries(authored)) {
      assert.deepEqual(node.properties[property], value, `Imported ${authored.name}.${property}`);
    }
    return node;
  });
  assert.equal(targets.length, 16);
  assert.equal(initial.pages.length, 1);
  const root = initial.nodes[initial.pages[0].rootNodeId];
  assert.equal(root.kind, 'frame');
  assert.equal(root.properties.width, 1440);
  assert.equal(root.properties.height, 900);
  assert.ok(targets.every(node => node.parentId === root.id && node.kind === 'rect'));

  const snapshot = () => rpc('document.snapshot', {documentId}, sessionId);
  let revision = revisionOf(initial);
  const condition = report.history;
  condition.startRevision = revision;
  condition.appliedPriorEdits = 0;
  condition.storageBeforeAging = await storageBytes(profile, documentId);

  async function patch(node, delta) {
    signal.throwIfAborted();
    const requestId = randomUUID();
    const {result: receipt, ...metrics} = await rpc('document.command', {envelope: {
      protocol: 'omc.engine/1', requestId, documentId, targetEpoch: revision.epoch, idempotencyKey: requestId,
      preconditions: {revision}, command: {
        type: 'node.set', nodeId: node.id, properties: {x: node.properties.x + delta},
      },
    }}, sessionId);
    assert.equal(receipt.status, 'durable');
    assert.equal(receipt.revision.epoch, revision.epoch);
    assert.equal(BigInt(receipt.revision.sequence), BigInt(revision.sequence) + 1n);
    revision = receipt.revision;
    return metrics;
  }

  function verifyControl(state) {
    assert.deepEqual(revisionOf(state), revision);
    assert.equal(state.title, initial.title);
    assert.deepEqual(state.pages, initial.pages);
    assert.deepEqual(state.nodes, initial.nodes);
    assert.deepEqual(state.metadata, initial.metadata);
  }

  const agingStarted = performance.now();
  for (const {target, delta} of historySchedule(edits, placement, targets.length)) {
    await patch(targets[target], delta);
    condition.appliedPriorEdits++;
  }
  condition.agingWallMs = performance.now() - agingStarted;
  condition.agedRevision = revision;
  condition.storageAfterAging = await storageBytes(profile, documentId);
  const {result: aged, ...equalGeometry} = await snapshot();
  verifyControl(aged);
  report.stages.agedStateSnapshot = equalGeometry;
  condition.geometryMatchesFresh = true;

  await rpc('session.close', {}, sessionId);
  await restart();
  ({result: {sessionId}} = await rpc('session.open'));
  const {result: reopened, ...reopenMetrics} = await rpc('workspace.open', {documentId}, sessionId);
  verifyControl(reopened);
  report.stages.reopenedWorkspace = reopenMetrics;
  condition.storageAfterReopen = await storageBytes(profile, documentId);

  const [target] = targets;
  for (let i = 0; i < samples; i++) {
    const sample = {index: i + 1};
    report.samples.push(sample);
    const {result: queried, ...read} = await rpc('tool.call', {
      name: 'native_query', arguments: {version: '1', documentId, limit: 17},
    }, sessionId);
    sample.boundedNodeRead = read;
    assert.deepEqual(queried.revision, revision);
    assert.equal(queried.complete, true);
    assert.equal(queried.nodes.length, 17);
    assert.deepEqual(queried.nodes.find(node => node.id === target.id), target);
    sample.scalarEdit = await patch(target, 1);
    const {result: moved, ...full} = await snapshot();
    sample.fullSnapshotAfterEdit = full;
    assert.deepEqual(revisionOf(moved), revision);
    assert.deepEqual(moved.nodes[target.id], {...target, properties: {...target.properties, x: target.properties.x + 1}});
    sample.restore = await patch(target, 0);
    verifyControl((await snapshot()).result);
    sample.verified = true;
  }
  condition.finalRevision = revision;
  condition.storageAfterSamples = await storageBytes(profile, documentId);
  await rpc('session.close', {}, sessionId);
}
