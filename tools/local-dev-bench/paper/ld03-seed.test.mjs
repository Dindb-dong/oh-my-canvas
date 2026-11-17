import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {test} from 'node:test';
import {benchRequire} from '../replays/mcp.mjs';
import {boardPlan, seed} from './ld03-seed.mjs';

const ts = benchRequire('typescript');
const fixture = JSON.parse(execFileSync('python3', [
  'tools/local-dev-bench/workloads/synthetic.py', 'fixture', 'LD03', '--variant', 'field-relay',
], {env: {...process.env, PYTHONDONTWRITEBYTECODE: '1'}}));
const file = {fileId: 'approved-mock', name: 'OMC Benchmark • Synthetic CAP Probe • 2026-11-17'};
const runId = 'smoke-test-01';

function mock({wrongName, missingControl, duplicatePage, duplicateToken, ignoredCss} = {}) {
  const name = wrongName || file.name;
  const run = boardPlan(fixture, file, runId);
  const original = {id: 'existing-page', name: 'Control page'};
  const pages = [original];
  if (duplicatePage) pages.push({id: 'collision', name: run.pageName});
  const tokens = duplicateToken ? [{
    type: 'color', name: `--color-${run.prefix}-target-accent`, value: '#ffffff',
  }] : [];
  const calls = [];
  const nodes = new Map();
  let next = 100;
  const pageId = 'new-test-page';
  const boardId = 'new-test-board';

  function node(id, parentId, component, css, textContent = null) {
    nodes.set(id, {detail: {
      id, parentId, component, textContent, isLocked: false, isVisible: true, childIds: [], childCount: 0,
    }, css});
  }

  function addMarkup(html, parentId) {
    const syntax = ts.createSourceFile('import.tsx', html, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    assert.equal(syntax.parseDiagnostics.length, 0);
    const add = (element, parent) => {
      assert.ok(ts.isJsxElement(element), 'Mock requires actual nested editable markup');
      const attribute = element.openingElement.attributes.properties.find(attr => attr.name?.text === 'style');
      const css = Object.fromEntries(attribute.initializer.text.split(';').map(pair => {
        const [key, value] = pair.split(':');
        return [key.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase()), value];
      }));
      const children = element.children.filter(ts.isJsxElement);
      const id = `L-${next++}`;
      const text = element.children.filter(ts.isJsxText).map(section => section.getText(syntax)).join('');
      node(id, parent, children.length ? 'Frame' : 'Text', css, text);
      children.forEach(child => {
        const childId = add(child, id);
        nodes.get(id).detail.childIds.push(childId);
      });
      nodes.get(id).detail.childCount = children.length;
      return id;
    };
    return add(syntax.statements[0].expression, parentId);
  }

  async function read({name: action, arguments: args}) {
    assert.equal(args.fileId, file.fileId);
    calls.push({action, args});
    switch (action) {
    case 'get_basic_info': {
      const artboards = args.pageId === pageId ?
        (nodes.has(boardId) ? [{id: boardId, name: run.boardName}] : []) :
        (args.pageId === original.id && !missingControl ? [{id: 'control-board', name: 'CAP Editable Scene'}] : []);
      return {fileName: name, pages: structuredClone(pages), artboards, rootNodeId: `root-${args.pageId}`};
    }
    case 'create_page':
      assert.equal(args.name, run.pageName);
      pages.push({id: pageId, name: args.name});
      return {id: pageId};
    case 'create_artboard':
      assert.equal(args.pageId, pageId);
      node(boardId, `root-${pageId}`, 'Frame', args.styles);
      return {id: boardId};
    case 'write_html': {
      assert.equal(args.targetNodeId, boardId);
      assert.equal(args.mode, 'insert-children');
      const id = addMarkup(args.html, boardId);
      const parent = nodes.get(boardId).detail;
      parent.childIds.unshift(id); // Deliberately prepend to test observed insertion IDs.
      parent.childCount = parent.childIds.length;
      return {created: [id]};
    }
    case 'get_children':
      return {children: nodes.get(args.nodeId).detail.childIds.map(id => ({id}))};
    case 'get_node_info':
      return nodes.get(args.nodeId).detail;
    case 'get_tokens':
      return {tokens: tokens.filter(token => args.types.includes(token.type))};
    case 'create_tokens':
      args.tokens.forEach((token, index) => tokens.push({...token, id: `T-${index}`}));
      return {results: tokens.map(row => ({name: row.name, result: 'created'}))};
    case 'update_styles':
      assert.equal(args.updates.length, 44);
      if (ignoredCss) return {ignoredStyles: {gap: 'unsupported'}};
      args.updates.forEach(row => {
        row.nodeIds.forEach(id => Object.assign(nodes.get(id).css, row.styles));
      });
      return {ignoredStyles: {}};
    case 'get_computed_styles': {
      const effective = Object.fromEntries(args.nodeIds.map(id => [id, Object.fromEntries(
        Object.entries(nodes.get(id).css).map(([prop, value]) =>
          [prop, tokens.find(row => value === `var(${row.name})`)?.value ?? value]),
      )]));
      return {styles: effective};
    }
    case 'get_jsx':
      return '<>' + [...nodes].map(([id, row]) => `<div id="${id}" style={${JSON.stringify(row.css)}} />`).join('') + '</>';
    case 'finish_working_on_nodes':
      assert.ok(args.nodeIds.includes(boardId));
      assert.ok(args.nodeIds.every(id => nodes.has(id)));
      return {};
    default: throw Error(`Unexpected tool ${action}`);
    }
  }
  return {read, calls};
}

test('creates only one new page and editable board and captures the prepared fixture', async () => {
  const {read, calls} = mock();
  const finished = await seed(read, ts, fixture, file, runId);
  assert.equal(finished.blocker, undefined);
  assert.equal(finished.scope.pageId, 'new-test-page');
  assert.equal(Object.keys(finished.scope.nodes).length, fixture.logical_objects);
  assert.equal(Object.keys(finished.before.raw.details).length, fixture.logical_objects);
  assert.deepEqual(finished.before.snapshot.styles.map(row => row.value), fixture.start.styles.map(row => row.value));
  assert.equal(finished.before.snapshot.nodes.filter(row => Object.hasOwn(row.bindings ?? {}, 'fill')).length, 42);
  assert.equal(finished.before.snapshot.nodes.filter(row => Object.hasOwn(row.bindings ?? {}, 'gap')).length, 42);
  assert.equal(calls.filter(call => call.action === 'write_html').length, 7);
  assert.equal(calls.filter(call => call.action === 'create_page').length, 1);
  assert.equal(calls.at(-1).action, 'finish_working_on_nodes');
});

test('rejects mismatched file and existing run state without any write', async () => {
  for (const [options, failure] of [
    [{wrongName: 'Different file'}, /Expected values/],
    [{missingControl: true}, /control board missing/],
    [{duplicatePage: true}, /page already exists/],
    [{duplicateToken: true}, /token namespace already exists/],
  ]) {
    const {read, calls} = mock(options);
    await assert.rejects(seed(read, ts, fixture, file, runId), failure);
    assert.ok(calls.every(call => call.action.startsWith('get_')));
  }
});

test('preserves scoped partial evidence when Paper ignores an intended property', async () => {
  const {read, calls} = mock({ignoredCss: true});
  const result = await seed(read, ts, fixture, file, runId);
  assert.match(result.blocker, /in-band failure in update_styles/);
  assert.equal(result.before, undefined);
  assert.equal(result.scope.pageId, 'new-test-page');
  assert.equal(calls.at(-1).action, 'finish_working_on_nodes');
});

test('offline plan validates fixture, pre-approved canvas name and run naming', () => {
  assert.throws(() => boardPlan(fixture, {...file, name: 'Company file'}, runId));
  assert.throws(() => boardPlan(fixture, file, 'bad/route'));
  const plan = boardPlan(fixture, file, runId);
  assert.equal(plan.prefix, 'omc-ld03-smoke-test-01');
  assert.equal(plan.artboardStyles.width, '1440px');
  assert.ok(plan.fragments.some(html => html.includes('Archive · reference only')));
});
