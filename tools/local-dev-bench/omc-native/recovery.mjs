import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {targetNodeName} from './fixture.mjs';

export async function measureImportCrash({rpc, call, crashAndRestart, filePath, baseline, report, signal}) {
  const evidence = {boundary: 'running-background-import', polls: []};
  report.recovery = evidence;
  const {jobId} = await call('native_job', {
    version: '1', action: 'submit', kind: 'import',
    arguments: {format: 'json', filePath},
  });
  assert.match(jobId, /^job_/);
  const start = performance.now();
  while (true) {
    const {state, progress} = await call('native_job', {version: '1', action: 'status', jobId});
    evidence.polls.push({state, phase: progress?.phase ?? null, elapsedMs: performance.now() - start});
    if (state === 'running' && progress?.phase && progress.phase !== 'queued') break;
    assert.ok(['running', 'queued'].includes(state), 'Import became terminal before active fault boundary');
    assert.ok(performance.now() - start < 5_000, 'No active background import observed within the deadline');
    await delay(20, undefined, {signal});
  }
  evidence.crashAndRestart = await crashAndRestart();
  const {result: {sessionId}} = await rpc('session.open');
  const {result: {documents}} = await rpc('workspace.list', {}, sessionId);
  evidence.reopenedCatalogCount = documents.length;
  assert.deepEqual(documents.map(document => document.id), [baseline.id], 'Unexpected persistent import staging document');
  const {result: reopened} = await rpc('workspace.open', {documentId: baseline.id}, sessionId);
  for (const field of ['id', 'epoch', 'sequence', 'title', 'nodes', 'pages', 'metadata']) {
    assert.deepEqual(reopened[field], baseline[field], `Existing document changed after interrupted import: ${field}`);
  }
  evidence.existingDocumentVerified = {nodes: Object.keys(reopened.nodes).length, revision: reopened.sequence};
}

export async function measureAcknowledgedRecovery({rpc, crashAndRestart, dropReceipt, documentId, report}) {
  const result = {boundary: dropReceipt ? 'response-headers-before-caller-receipt' : 'after-durable-receipt'};
  report.recovery = result;
  const {result: authenticated} = await rpc('session.open', {identity: {action: 'register'}});
  const {sessionId, identity} = authenticated;
  const registration = identity ?? authenticated.registration;
  assert.ok(registration?.registrationId && registration.credential, 'Expected a durable task-local principal');
  const {result: baseline} = await rpc('workspace.open', {documentId}, sessionId);
  const target = Object.values(baseline.nodes).filter(node => node.properties?.name === targetNodeName);
  assert.equal(target.length, 1);
  const [node] = target;
  assert.equal(node.properties.x, 0);
  const epoch = baseline.epoch;

  async function png(session) {
    const {result: encoded, ...metrics} = await rpc('document.export', {
      documentId, pageId: baseline.pages[0].id, format: 'png', scale: 0.25,
    }, session);
    const bytes = Buffer.from(encoded.contentBase64, 'base64');
    assert.equal(encoded.mediaType, 'image/png');
    assert.ok(bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])));
    return {...metrics, pngBytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex')};
  }

  function command(x, sequence) {
    const requestId = randomUUID();
    return {
      protocol: 'omc.engine/1', requestId, documentId, targetEpoch: epoch, idempotencyKey: requestId,
      preconditions: {revision: {epoch, sequence}},
      command: {type: 'node.set', nodeId: node.id, properties: {x}},
    };
  }

  async function edit(envelope) {
    const {result: receipt, ...metrics} = await rpc('document.command', {envelope}, sessionId);
    assert.equal(receipt.status, 'durable');
    assert.equal(receipt.revision.epoch, epoch);
    assert.equal(BigInt(receipt.revision.sequence), BigInt(envelope.preconditions.revision.sequence) + 1n);
    return {revision: receipt.revision, metrics};
  }

  function expected(x) {
    return {...baseline.nodes, [node.id]: {...node, properties: {...node.properties, x}}};
  }

  const first = await edit(command(8, baseline.sequence));
  result.firstDurable = first.metrics;
  const {result: undone} = await rpc('document.undo', {documentId, targetEpoch: epoch}, sessionId);
  assert.equal(undone.status, 'durable');
  assert.deepEqual((await rpc('document.snapshot', {documentId}, sessionId)).result.nodes, baseline.nodes);
  const {result: redone} = await rpc('document.redo', {documentId, targetEpoch: epoch}, sessionId);
  assert.equal(redone.status, 'durable');
  assert.deepEqual((await rpc('document.snapshot', {documentId}, sessionId)).result.nodes, expected(8));
  result.undoRedoBeforeCrash = true;
  result.preCrashExport = await png(sessionId);

  const envelope = command(16, redone.revision.sequence);
  const expectedSequence = BigInt(redone.revision.sequence) + 1n;
  if (dropReceipt) {
    const {crashAndRestart, ...fault} = await dropReceipt(envelope, sessionId);
    result.fault = {...fault, applicationReceiptConsumed: false};
    result.crashAndRestart = crashAndRestart;
  } else {
    const last = await edit(envelope);
    result.lastDurable = {revision: last.revision, ...last.metrics};
    result.crashAndRestart = await crashAndRestart();
  }

  const {result: resumed} = await rpc('session.open', {identity: {
    registrationId: registration.registrationId, credential: registration.credential,
  }});
  const {result: reopened, ...openMetrics} = await rpc('workspace.open', {documentId}, resumed.sessionId);
  assert.equal(reopened.epoch, epoch);
  assert.equal(BigInt(reopened.sequence), expectedSequence);
  assert.deepEqual(reopened.pages, baseline.pages);
  assert.deepEqual(reopened.metadata, baseline.metadata);
  assert.deepEqual(reopened.nodes, expected(16));
  const revision = {epoch: reopened.epoch, sequence: reopened.sequence};
  result.reopen = {...openMetrics, verifiedNodes: Object.keys(reopened.nodes).length, revision};

  const {result: replay} = await rpc('document.command', {envelope}, resumed.sessionId);
  assert.equal(replay.status, 'durable');
  assert.equal(replay.revision.epoch, revision.epoch);
  assert.equal(BigInt(replay.revision.sequence), BigInt(revision.sequence));
  const {result: postRetry} = await rpc('document.snapshot', {documentId}, resumed.sessionId);
  assert.equal(postRetry.sequence, reopened.sequence);
  assert.deepEqual(postRetry.nodes, reopened.nodes);
  result.idempotentRetransmission = true;
  result.postCrashExport = await png(resumed.sessionId);
  assert.notEqual(result.postCrashExport.sha256, result.preCrashExport.sha256,
    'Export must reflect the new durable position');
}
