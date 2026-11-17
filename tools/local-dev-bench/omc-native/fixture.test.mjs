import assert from 'node:assert/strict';
import test from 'node:test';

import {makeFixture, targetNodeId} from './fixture.mjs';
import {historySchedule} from './history.mjs';

test('N-A holds target properties constant while varying size and ancestor depth', () => {
  for (const nodeCount of [1000, 10000, 100000]) {
    for (const depth of [1, 32]) {
      const {document, summary} = makeFixture({experiment: 'N-A', nodeCount, depth, cssRules: 0});
      assert.equal(document.pages.length, 1);
      assert.equal(Object.keys(document.nodes).length, nodeCount);
      assert.equal(summary.activePageAuthoredNodes, nodeCount - 1);
      const target = document.nodes[targetNodeId];
      assert.deepEqual(target.properties, {
        name: 'Probe edit target', x: 0, y: 0, width: 10, height: 10, fill: '#cc5533',
      });
      let parent = target.parentId;
      for (let i = 1; i < depth; i++) parent = document.nodes[parent].parentId;
      assert.equal(parent, document.pages[0].rootNodeId);
    }
  }
});

test('N-B keeps the complete authored active page constant with unrelated pages and CSS', () => {
  const baseline = makeFixture({experiment: 'N-B', nodeCount: 100, depth: 1, cssRules: 0});
  const activeShard = baseline.document.nodes[targetNodeId].homeShard;
  for (const nodeCount of [100, 1000, 10000, 100000]) {
    const {document, summary} = makeFixture({experiment: 'N-B', nodeCount, depth: 1, cssRules: 1000});
    assert.deepEqual(document.pages[0], baseline.document.pages[0]);
    const active = Object.fromEntries(Object.entries(document.nodes).filter(([, n]) => n.homeShard === activeShard));
    assert.deepEqual(active, baseline.document.nodes);
    assert.equal(Object.keys(active).length, 101);
    assert.equal(Object.keys(document.nodes).length, summary.documentNodeCount);
    assert.equal(document.metadata.css.split('\n').length, 1000);
  }
});

test('N-C starts all conditions from the same authored frame and restores every target', () => {
  const {document, summary} = makeFixture({experiment: 'N-C', nodeCount: 17, depth: 1, cssRules: 0});
  assert.equal(summary.documentNodeCount, 17);
  const root = document.nodes[document.pages[0].rootNodeId];
  assert.deepEqual(root.properties, {name: 'Probe active page', width: 1440, height: 900});
  const shapes = Object.values(document.nodes).filter(node => node.parentId === root.id);
  assert.equal(shapes.length, 16);
  assert.equal(new Set(shapes.map(node => node.properties.name)).size, 16);
  const geometry = shapes.map(node => node.properties.x);
  for (const placement of ['concentrated', 'distributed']) {
    for (const edits of [0, 1000, 100000]) {
      const final = [...geometry];
      const hits = Array(shapes.length).fill(0);
      for (const {target, delta} of historySchedule(edits, placement, shapes.length)) {
        assert.equal(final[target], geometry[target] + 1 - delta);
        final[target] = geometry[target] + delta;
        hits[target]++;
      }
      assert.deepEqual(final, geometry);
      assert.equal(hits.reduce((sum, count) => sum + count, 0), edits);
      if (edits > 0 && placement === 'distributed') assert.equal(hits.filter(Boolean).length, 16);
      if (edits > 0 && placement === 'concentrated') assert.equal(hits[0], edits);
    }
  }
});
