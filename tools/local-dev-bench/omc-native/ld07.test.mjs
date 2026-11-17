import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

import {preparedBoard, proposedCommands} from './ld07.mjs';

const generator = fileURLToPath(new URL('../workloads/synthetic.py', import.meta.url));
const fixture = JSON.parse(execFileSync('python3', [generator, 'fixture', 'LD07', '--variant', 'transit-departures'], {
  encoding: 'utf8', env: {...process.env, PYTHONDONTWRITEBYTECODE: '1'},
}));

const getNode = (board, key) => Object.values(board.nodes).find(node => node.properties.name === 'LD07 ' + key);
const nativeStyles = new Map(fixture.expected.styles.map((style, index) => [style.key, 'native-var-' + index]));

test('healthy native board carries all registered nodes and true row wrapping', () => {
  const board = preparedBoard(fixture);
  assert.equal(board.pages.length, 1);
  assert.equal(Object.keys(board.nodes).length, fixture.logical_objects + 1);
  const flow = getNode(board, 'board/flow');
  assert.deepEqual(flow.properties.layout, {
    type: 'flex', direction: 'row', wrap: true, gap: 12, padding: 12, alignContent: 'start',
  });
  assert.equal(flow.properties.clipContent, false);
  const card = fixture.expected.nodes.find(row => row.parent === 'board/flow');
  assert.equal(getNode(board, card.key).parentId, flow.id);
  assert.equal(getNode(board, card.key).properties.width, card.bounds[2]);
  assert.equal(getNode(board, card.key).properties.style['flex-shrink'], 0);
});

test('the two injections and repairs use native references and reject stale starting values', () => {
  const board = preparedBoard(fixture);
  for (const row of fixture.expected.nodes.filter(row => row.bindings)) {
    getNode(board, row.key).properties.fill = {$token: nativeStyles.get(row.bindings.fill)};
  }

  const plan = proposedCommands(board, fixture.injections, nativeStyles);
  assert.deepEqual(plan.observed, fixture.injections);
  assert.equal(plan.commands.length, 2);
  assert.equal(plan.commands[0].properties.layout.wrap, false);
  assert.equal(plan.commands[1].properties.fill.$token, nativeStyles.get('notice/accent'));

  const faulty = structuredClone(board);
  for (const {nodeId, properties} of plan.commands) Object.assign(faulty.nodes[nodeId].properties, properties);
  assert.throws(() => proposedCommands(faulty, fixture.injections, nativeStyles), /Unexpected current value/);
  const repair = proposedCommands(faulty, fixture.repair_actions, nativeStyles);
  assert.deepEqual(repair.observed, fixture.repair_actions);
  for (const {nodeId, properties} of repair.commands) Object.assign(faulty.nodes[nodeId].properties, properties);
  assert.deepEqual(faulty, board);
});
