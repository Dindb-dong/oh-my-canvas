import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import test from 'node:test';

import {compareReplay,pendingWork,registeredPlan} from './omc-ld03-resource-arm.mjs';

const fixture = JSON.parse(execFileSync('python3', [
  '-B',new URL('../workloads/synthetic.py',import.meta.url).pathname,'fixture','LD03','--variant','field-relay',
],{encoding:'utf8'}));

test('pins the same 146-node workload and two targets as Penpot', () => {
  const plan = registeredPlan(fixture);
  assert.equal(plan.cards.length,44);
  assert.deepEqual(plan.candidate.map(row => row.value),['#136b62',20]);
  assert.throws(() => registeredPlan({...fixture,fixture_sha256:'wrong'}), /same field-relay/);
});

test('retains original document and property identities through an exact scoped replay', () => {
  const make = spec => ({
    document_id:'original',
    nodes:spec.nodes.map(row => ({...row,native_id:'node:'+row.key})),
    styles:spec.styles.map(row => ({...row,native_id:'style:'+row.key})),
  });
  const before = make(fixture.start);
  const after = make(fixture.expected);
  const reopened = structuredClone(after);
  assert.deepEqual(compareReplay(before,after,reopened),{fill:38,gap:38});
  reopened.nodes[1].native_id = 'replacement';
  assert.throws(() => compareReplay(before,after,reopened), /Replaced native identities/);
});

test('only attests tail with observed empty job and admission counters', () => {
  const jobs = {active:0,queued:0,reservedBytes:0};
  const admission = {pendingAndActive:0,activeDocuments:0,reservedTransportBytes:0};
  assert.equal(pendingWork({jobs,admission}).exitCode,0);
  assert.equal(pendingWork({jobs:{...jobs,queued:1},admission}).exitCode,1);
  assert.equal(pendingWork({jobs}).exitCode,1);
});
