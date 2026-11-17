import assert from 'node:assert/strict';
import test from 'node:test';

import {runPhases} from './local-resource-arm.mjs';

const options = {rootPids: [123], baselineSeconds: 60, tailSeconds: 30, maxTailSeconds: 90, intervalSeconds: .05};

async function observe(replayExit, tailExit) {
  const calls = [];
  const result = await runPhases({
    async send(message) {
      calls.push(message);
      return {state: message.command};
    },
  }, options, async () => {
    calls.push('run replay');
    return {exitCode: replayExit};
  }, tailExit === null ? null : async () => {
    calls.push('check pending work');
    return {exitCode: tailExit};
  }, async seconds => calls.push(seconds));
  return {calls, result};
}

test('keeps registered baseline and tail around the external replay', async () => {
  const {calls} = await observe(0, 0);
  assert.deepEqual(calls, [
    {command: 'start', root_pids: [123], baseline_seconds: 60, tail_seconds: 30, max_tail_seconds: 90,
      interval_seconds: .05},
    {command: 'baseline'}, 60, {command: 'replay'}, 'run replay',
    {command: 'tail', replay_complete: true}, 30, 'check pending work', {command: 'stop', tail_complete: true},
  ]);
});

test('preserves a failed replay, a failed tail check, and a missing tail check', async () => {
  for (const [replayCode, tailCode] of [[1, 0], [0, 1], [0, null]]) {
    const {calls} = await observe(replayCode, tailCode);
    assert.deepEqual(calls[5], {command: 'tail', replay_complete: replayCode === 0});
    assert.equal(calls.includes('check pending work'), replayCode === 0 && tailCode !== null);
    assert.deepEqual(calls.at(-1), {command: 'stop', tail_complete: false});
  }
});
