import assert from 'node:assert/strict';
import test from 'node:test';

import {contentionSchedule} from './contention.mjs';

test('N-E/LD08 varies background offers while holding the foreground and per-stream schedules fixed', () => {
  const solo = contentionSchedule(2, 0);
  const one = contentionSchedule(2, 1);
  const four = contentionSchedule(2, 4);
  const withoutIds = entries => entries.map(({id, ...operation}) => operation);
  const foreground = plan => withoutIds(plan.filter(operation => operation.client === 'foreground'));
  assert.equal(solo.length, 11);
  assert.deepEqual(foreground(one), foreground(solo));
  assert.deepEqual(foreground(four), foreground(solo));
  assert.deepEqual(solo.filter(operation => operation.type === 'scalar').map(operation => operation.x), [1, 2]);
  for (let stream = 1; stream <= 4; stream++) {
    const offers = four.filter(operation => operation.client === `background-${stream}`);
    assert.deepEqual(offers.map(({type, atMs}) => ({type, atMs})),
      [{type: 'full-read', atMs: 0}, {type: 'batch', atMs: 10}]);
  }
  for (const [index, operation] of four.entries()) {
    assert.equal(operation.id, index + 1);
    assert.equal(operation.deadlineMs, operation.atMs + 5000);
    if (index > 0) assert.ok(operation.atMs >= four[index - 1].atMs);
  }
});
