import assert from 'node:assert/strict';

const id = (kind, index) => `${kind}_${index.toString(16).padStart(32, '0')}`;
const rank = index => (BigInt(index) << 96n).toString(16).padStart(32, '0');
export const targetNodeId = id('node', 2);
export const targetNodeName = 'Probe edit target';

export function makeFixture({experiment, nodeCount, depth, cssRules}) {
  assert.ok(nodeCount >= 100 && (depth === 1 || depth === 32));
  assert.ok(experiment === 'N-A' || experiment === 'N-B');
  const pages = [];
  const nodes = {};
  const activePageAuthoredNodes = experiment === 'N-B' ? 100 : nodeCount - 1;
  const documentNodeCount = experiment === 'N-B' && nodeCount === 100 ? 101 : nodeCount;
  let nextNode = 3;

  function addNode(number, kind, parentId, shard, order, properties) {
    const key = id('node', number);
    nodes[key] = {id: key, kind, parentId, homeShard: shard, rank: rank(order), properties};
    return key;
  }

  function addPage(pageIndex, count, nesting) {
    const title = pageIndex === 1 ? 'Probe active page' : `Probe background page ${pageIndex - 1}`;
    const shard = id('shard', pageIndex);
    const root = addNode(pageIndex === 1 ? 1 : nextNode++, 'frame', null, shard, 1, {
      name: title, width: 1440, height: 900,
    });
    pages.push({id: id('page', pageIndex), title, rootNodeId: root, rank: rank(pageIndex)});

    let parent = root;
    for (let level = 1; level < nesting; level++) {
      parent = addNode(nextNode++, 'frame', parent, shard, 1, {
        name: `Probe ancestor ${level}`, x: 0, y: 0, width: 1440, height: 900,
      });
    }
    for (let i = 0; i < count - nesting + 1; i++) {
      const number = pageIndex === 1 && i === 0 ? 2 : nextNode++;
      addNode(number, 'rect', parent, shard, i + 1, {
        name: number === 2 ? targetNodeName : `Probe shape ${i + 1}`,
        x: 16 * (i % 10), y: 16 * Math.floor(i / 10),
        width: 10, height: 10, fill: '#cc5533',
      });
    }
  }

  addPage(1, activePageAuthoredNodes, depth);
  for (let remaining = documentNodeCount - activePageAuthoredNodes - 1; remaining > 0; remaining -= 1001) {
    addPage(pages.length + 1, Math.min(1001, remaining) - 1, 1);
  }
  const metadata = cssRules ? {
    css: Array.from({length: cssRules}, (_, i) => `.unused-${i}{fill:#456789}`).join('\n'),
  } : {};
  return {
    document: {title: 'Synthetic native performance probe', pages, nodes, metadata},
    summary: {activePageAuthoredNodes, pageCount: pages.length, documentNodeCount},
  };
}
