import assert from 'node:assert/strict';
import test from 'node:test';
import {measureAcknowledgedRecovery} from './recovery.mjs';

function mock({loseEdit = false} = {}) {
  const report = {};
  let sequence = 0;
  let x = 0;
  let crashed = false;
  let receiptKey;
  const epoch = 'test-epoch';
  const receipt = () => ({status: 'durable', revision: {epoch, sequence: String(sequence)}});
  const rpc = async (method, args, session) => {
    let result;
    if (method === 'session.open') {
      if (crashed) assert.equal(args.identity.registrationId, 'principal-1');
      result = {sessionId: crashed ? 'session-2' : 'session-1',
        registration: {registrationId: 'principal-1', credential: 'synthetic'}};
    } else if (method === 'document.command') {
      if (crashed) {
        assert.equal(session, 'session-2');
        assert.equal(args.envelope.idempotencyKey, receiptKey);
      } else {
        assert.equal(args.envelope.preconditions.revision.sequence, String(sequence));
        x = args.envelope.command.properties.x;
        sequence++;
        receiptKey = args.envelope.idempotencyKey;
      }
      result = receipt();
    } else if (method === 'document.undo' || method === 'document.redo') {
      x = method === 'document.undo' ? 0 : 8;
      sequence++;
      result = receipt();
    } else if (method === 'document.export') {
      result = {mediaType: 'image/png', contentBase64: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, x]).toString('base64')};
    } else {
      assert.ok(['workspace.open', 'document.snapshot'].includes(method));
      result = {epoch, sequence: String(sequence), pages: [{id: 'page-1'}], metadata: {},
        nodes: {'node-1': {id: 'node-1', properties: {name: 'Probe edit target', x}}}};
    }
    return {result, elapsedMs: 1};
  };
  const crashAndRestart = async () => {
    assert.equal(x, 16);
    crashed = true;
    if (loseEdit) x = 8;
    return {signal: 'SIGKILL'};
  };
  return {rpc, crashAndRestart, documentId: 'document-1', report};
}

test('N-H checks the crash boundary, semantic recovery, receipt replay, and export', async () => {
  const args = mock();
  await measureAcknowledgedRecovery(args);
  assert.equal(args.report.recovery.undoRedoBeforeCrash, true);
  assert.equal(args.report.recovery.idempotentRetransmission, true);
  assert.equal(args.report.recovery.reopen.verifiedNodes, 1);
});

test('N-H rejects a recovered document that lost the acknowledged edit', async () => {
  await assert.rejects(measureAcknowledgedRecovery(mock({loseEdit: true})), {code: 'ERR_ASSERTION'});
});

test('N-H verifies exactly-once recovery without recording an unconsumed receipt', async () => {
  const args = mock();
  await measureAcknowledgedRecovery({...args, dropReceipt: async (envelope, session) => {
    await args.rpc('document.command', {envelope}, session);
    return {httpStatus: 200, crashAndRestart: await args.crashAndRestart()};
  }});
  const {boundary, fault, lastDurable, idempotentRetransmission} = args.report.recovery;
  assert.equal(boundary, 'response-headers-before-caller-receipt');
  assert.equal(fault.applicationReceiptConsumed, false);
  assert.equal(lastDurable, undefined);
  assert.equal(idempotentRetransmission, true);
});
