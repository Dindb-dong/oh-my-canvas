import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

import {atlasIndex, findStation, nativeDocument, normalizeAtlas, verifyWrites} from './ld02-atlas.mjs';

const generator = fileURLToPath(new URL('../workloads/synthetic.py', import.meta.url));
const fixture = JSON.parse(execFileSync('python3', [generator, 'fixture', 'LD02', '--variant', 'conservation-atlas'], {
  encoding: 'utf8', env: {...process.env, PYTHONDONTWRITEBYTECODE: '1'},
}));
const index = atlasIndex(fixture);
const authored = nativeDocument(fixture, index);

test('native atlas contains ten full distinct pages and discovers the target by name and receipt', () => {
  assert.equal(authored.pages.length, 10);
  assert.equal(Object.keys(authored.nodes).length, 1010);
  for (const page of authored.pages) {
    const root = authored.nodes[page.rootNodeId];
    assert.equal(root.parentId, null);
    assert.equal(Object.values(authored.nodes).filter(node => node.homeShard === root.homeShard).length, 101);
  }
  const {text, gap, radius} = findStation(authored, index.query);
  assert.equal(gap.properties.name, 'Ceramics review');
  assert.equal(text.parentId, gap.id);
  assert.equal(radius.parentId, gap.id);
  assert.deepEqual([text.properties.text, gap.properties.layout.gap, radius.properties.cornerRadius],
    fixture.edit.map(row => row.from));
  assert.throws(() => findStation(authored, {...index.query, receipt: 'unregistered-receipt'}), /one real station/);
});

test('normalization takes geometry from observed native scene, not fixture or authored coordinates', () => {
  const raw = {...authored, id: 'synthetic-doc', sequence: '1'};
  const scenes = new Map();
  for (const page of authored.pages) {
    const root = authored.nodes[page.rootNodeId];
    const nodes = Object.values(authored.nodes).filter(node => node.homeShard === root.homeShard)
      .map((node, index) => ({rawId: node.id, id: 'alias-' + index}));
    const diagnostics = nodes.map(row => ({
      id: row.id, bounds: {x: 30, y: 40, width: 45, height: 60}, clippedText: false, overflowParent: false,
    }));
    scenes.set(page.id, {nodes, diagnostics, revision: 1, truncated: false});
  }
  const result = normalizeAtlas(raw, scenes, fixture, index);
  assert.equal(result.pages.length, 10);
  assert.equal(result.nodes.length, 1000);
  assert.ok(result.nodes.every(row => row.editable && row.bounds.join(',') === '30,40,45,60'));
  assert.deepEqual(result.nodes.map(row => row.key), fixture.start.nodes.map(row => row.key));
  scenes.get(authored.pages[0].id).revision = 2;
  assert.throws(() => normalizeAtlas(raw, scenes, fixture, index));
});

test('write oracle rejects collateral edits and preserves typed identities', () => {
  const before = structuredClone({...authored, id: 'synthetic-doc', epoch: 'synthetic-epoch', sequence: '1'});
  const target = findStation(before, index.query);
  target.text.properties.textRuns = [{text: target.text.properties.text, fontSize: 13}];
  const after = structuredClone(before);
  after.sequence = '2';
  for (const change of fixture.edit) {
    const props = after.nodes[target[change.field].id].properties;
    if (change.field === 'text') {
      props.text = change.to;
      props.textRuns[0].text = change.to;
    } else if (change.field === 'gap') props.layout.gap = change.to;
    else props.cornerRadius = change.to;
  }
  verifyWrites(before, after, target, fixture.edit);
  after.nodes[after.pages[0].rootNodeId].properties.width++;
  assert.throws(() => verifyWrites(before, after, target, fixture.edit), /Unexpected current node structure/);
});
