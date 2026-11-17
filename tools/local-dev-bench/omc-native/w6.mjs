import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';

const seeds = [101, 202, 303];
const minuteMs = 60_000;
const documentFixtures = ['D-NATIVE', ...Array(4).fill('D-100K')];
const pageCounts = [46, 20, 20, 20, 20];

export function compileW6Schedule(seed) {
  assert.ok(seeds.includes(seed), 'Expected registered repeat seed 101, 202 or 303');
  const minutes = [];

  for (let minute = 1; minute <= 60; minute++) {
    const operations = [];
    const add = (atMs, operation, fields = {}) => operations.push({atMs, operation, ...fields});
    for (let order = 0; order < documentFixtures.length; order++) {
      const documentSlot = (order + minute - 1) % documentFixtures.length;
      const base = order * 11_000;
      add(base, 'switch-document', {documentSlot});
      for (let step = 0; step < 2; step++) {
        const pageSlot = (seed + minute * 2 + step) % pageCounts[documentSlot];
        const page = {documentSlot, pageSlot};
        const group = {...page, groupId: `m${minute}-d${documentSlot}-p${pageSlot}`};
        const offset = base + step * 5_000;
        add(offset + 400, 'traverse-page', page);
        add(offset + 900, 'edit-group', {...group, edits: [
          {targetSlot: 0, property: 'x', delta: 1},
          {targetSlot: 1, property: 'y', delta: 1},
        ]});
        add(offset + 2_000, 'undo-group', group);
        add(offset + 3_000, 'redo-group', group);
        add(offset + 4_000, 'bounded-screenshot', {...page, bounds: {x: 0, y: 0, width: 320, height: 200}});
      }
    }
    if (minute % 5 === 0) {
      // Jobs are submitted on independent sessions and drained at the declared checkpoints.
      add(5_100, 'submit-import', {source: 'D-REAL', destination: 'staging'});
      add(16_100, 'submit-full-export', {
        documentSlot: (minute / 5 + seed) % documentFixtures.length, format: 'omc',
      });
    }
    add(56_000, 'open-temporary-document', {documentSlot: 'temporary'});
    add(58_000, 'close-temporary-document', {documentSlot: 'temporary'});
    operations.sort((a, b) => a.atMs - b.atMs);
    minutes.push({
      minute, activeDurationMs: minuteMs, operations,
      ...(minute % 15 === 0 && {quiescence: {
        steps: ['stop-offers', 'drain-jobs', 'wait-gpu-fences', 'idle', 'sample'],
        idleMs: 30_000,
      }}),
    });
  }
  return {
    schemaVersion: 1,
    status: 'offline-plan',
    workload: 'W6',
    seed,
    variant: {documents: 5, resources: 'shared', fixture: 'D-RES-S'},
    activeDurationMs: minutes.length * minuteMs,
    documents: documentFixtures.map((fixture, slot) => ({slot, fixture, pageCount: pageCounts[slot]})),
    targetBinding: 'Resolve and record real document, page and editable node IDs, requests and expected outcomes before offering work.',
    minutes,
    abandonedClientCases: [
      {lease: 'native-query-cursor', expireAfterMs: 60_000, expected: 'snapshot_expired'},
      {lease: 'native-result', expireAfterMs: 300_000, expected: 'snapshot_expired'},
    ],
  };
}

function main() {
  const {values} = parseArgs({options: {seed: {type: 'string'}}});
  assert.ok(values.seed, 'Use --seed 101, 202 or 303 to emit the offline plan');
  console.log(JSON.stringify(compileW6Schedule(Number(values.seed)), null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
