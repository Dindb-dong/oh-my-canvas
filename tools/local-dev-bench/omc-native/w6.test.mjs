import assert from 'node:assert/strict';
import test from 'node:test';

import {compileW6Schedule} from './w6.mjs';

test('W6 shared five-document plan expands every registered minute and checkpoint', () => {
  const schedule = compileW6Schedule(101);
  assert.equal(schedule.activeDurationMs, 3_600_000);
  const checkpoints = [];
  const periodic = [];
  for (const plan of schedule.minutes) {
    const operations = label => plan.operations.filter(row => row.operation === label);
    assert.equal(plan.activeDurationMs, 60_000);
    assert.ok(plan.operations.every((row, index, all) =>
      row.atMs >= 0 && row.atMs < plan.activeDurationMs && (!index || row.atMs > all[index - 1].atMs)));
    assert.deepEqual(operations('switch-document').map(row => row.documentSlot).sort(), [0, 1, 2, 3, 4]);
    const pages = operations('traverse-page');
    assert.equal(new Set(pages.map(({documentSlot, pageSlot}) => `${documentSlot}:${pageSlot}`)).size, 10);
    assert.ok(pages.every(({documentSlot, pageSlot}) => pageSlot < schedule.documents[documentSlot].pageCount));
    const groups = operations('edit-group');
    assert.equal(groups.flatMap(row => row.edits).length, 20);
    assert.deepEqual(operations('undo-group').map(row => row.groupId), groups.map(row => row.groupId));
    assert.deepEqual(operations('redo-group').map(row => row.groupId), groups.map(row => row.groupId));
    assert.equal(operations('bounded-screenshot').length, 10);
    assert.equal(operations('open-temporary-document').length, 1);
    assert.equal(operations('close-temporary-document').length, 1);
    assert.equal(operations('submit-import').length, operations('submit-full-export').length);
    if (operations('submit-import').length) periodic.push(plan.minute);
    if (plan.quiescence) {
      checkpoints.push(plan.minute);
      assert.equal(plan.quiescence.idleMs, 30_000);
    }
  }
  assert.deepEqual(periodic, Array.from({length: 12}, (_, i) => (i + 1) * 5));
  assert.deepEqual(checkpoints, [15, 30, 45, 60]);
});

test('all three registered repeats are deterministic and select different page targets', () => {
  const repeats = [101, 202, 303].map(seed => compileW6Schedule(seed));
  assert.deepEqual(repeats[0], compileW6Schedule(101));
  const firstPages = repeats.map(run => run.minutes[0].operations.find(row => row.operation === 'traverse-page').pageSlot);
  assert.equal(new Set(firstPages).size, 3);
  assert.throws(() => compileW6Schedule(1), /registered repeat seed/);
});
