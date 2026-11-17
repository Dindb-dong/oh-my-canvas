import assert from 'node:assert/strict';
import test from 'node:test';

import {makeFixture, targetNodeId} from './fixture.mjs';

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
