import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {test} from 'node:test';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {benchRequire} from '../replays/mcp.mjs';
import {capture, normalize, plan, sourceStylesFromJsx} from './ld03.mjs';

const ts = benchRequire('typescript');
const fixtureCli = 'tools/local-dev-bench/workloads/synthetic.py';
const contract = variant => JSON.parse(execFileSync('python3', [fixtureCli, 'fixture', 'LD03', '--variant', variant], {
  env: {...process.env, PYTHONDONTWRITEBYTECODE: '1'},
}));
const scopeOf = (fixture, copy = false) => ({
  prefix: 'omc-ld03-fixture-a', fileId: copy ? 'copy-file' : 'fixture-file',
  fileName: copy ? 'Synthetic copy' : 'Synthetic original', pageId: 'page-1', boardId: 'P-0',
  nodes: Object.fromEntries(fixture.start.nodes.map((row, index) => [row.key, `P-${index}`])),
});

function nativeMock(fixture, scope, phase) {
  const {nodes, styles} = fixture[phase];
  const calls = plan(fixture, scope);
  const tokens = {tokens: calls.setup[0].arguments.tokens.map((item, index) => ({
    ...item, id: `${scope.fileId}-token-${index}`,
    value: styles[index].kind === 'color' ? styles[index].value : `${styles[index].value}px`,
  }))};
  const sourceStyles = Object.fromEntries(calls.setup[1].arguments.updates.map(item => [item.nodeIds[0], item.styles]));
  const home = {fileName: scope.fileName, pages: [{id: scope.pageId}]};
  const page = {rootNodeId: 'root', artboards: [{id: scope.boardId}]};
  const details = {};
  const computed = {styles: {}};
  for (const {key, kind, parent, text, fill, layout, gap} of nodes) {
    const id = scope.nodes[key];
    const childIds = nodes.filter(row => row.parent === key).map(row => scope.nodes[row.key]);
    details[id] = {
      id, parentId: parent === null ? 'root' : scope.nodes[parent],
      component: kind === 'frame' ? 'Frame' : 'Text', isLocked: false, isVisible: true,
      textContent: text, childIds, childCount: childIds.length,
    };
    if (layout === 'vertical') {
      computed.styles[id] = {display: 'flex', flexDirection: 'column', gap: `${gap}px`, backgroundColor: fill};
    }
  }
  const jsx = '(<>' + Object.entries(sourceStyles).map(([id, rules]) =>
    `<div id="${id}" style={${JSON.stringify(rules)}}/>`).join('\n') + '</>)';
  const state = {home, page, details, tokens, computed, sourceStyles};
  const reads = [];
  return {
    state, reads,
    capture: async (cli, ts, fixture, scope) => cli(async ({name, arguments: args}) => {
      reads.push(name);
      assert.equal(args.fileId, scope.fileId);
      switch (name) {
      case 'get_basic_info': return args.pageId ? page : home;
      case 'get_tokens': return {tokens: tokens.tokens.filter(row => args.types.includes(row.type))};
      case 'get_node_info': return details[args.nodeId];
      case 'get_computed_styles': return computed;
      case 'get_jsx': return jsx;
      default: throw Error(`Unexpected tool ${name}`);
      }
    }, ts, fixture, scope),
  };
}

test('uses supported token operations and preserves the four literal overrides', () => {
  for (const variant of ['field-relay', 'edition-grid']) {
    const fixture = contract(variant);
    const scope = scopeOf(fixture);
    const original = plan(fixture, scope);
    const copy = plan(fixture, scopeOf(fixture, true));
    const [tokens, bindings] = original.setup;
    assert.equal(tokens.name, 'create_tokens');
    assert.equal(bindings.name, 'update_styles');
    assert.equal(tokens.arguments.tokens.length, 4);
    assert.equal(bindings.arguments.updates.length, 44);
    assert.equal(bindings.arguments.updates.flatMap(row => Object.values(row.styles))
      .filter(value => !value.startsWith('var(')).length, 4);
    assert.equal(original.candidate.name, 'set_tokens');
    assert.equal(original.candidate.arguments.tokens.length, 2);
    assert.equal(copy.probe.arguments.fileId, 'copy-file');
    assert.equal(copy.probe.arguments.tokens.length, 2);
  }
});

test('reads both variants into phases accepted by the shared oracle', async () => {
  const out = mkdtempSync(join(tmpdir(), 'paper-ld03-test-'));
  try {
    for (const variant of ['field-relay', 'edition-grid']) {
      const fixture = contract(variant);
      const original = scopeOf(fixture);
      const copy = scopeOf(fixture, true);
      const phases = {before: 'start', candidate: 'expected', reopened: 'expected',
        probe: 'probe', after_probe_original: 'expected'};
      const evidence = {};
      for (const [phase, state] of Object.entries(phases)) {
        const scope = phase === 'probe' ? copy : original;
        const mock = nativeMock(fixture, scope, state);
        const result = await mock.capture(capture, ts, fixture, scope);
        assert.equal(mock.reads[0], 'get_basic_info');
        assert.equal(mock.reads.filter(name => name === 'get_node_info').length, fixture.logical_objects);
        evidence[phase] = result.snapshot;
      }
      evidence.probe_actions = fixture.probe_actions;
      const path = join(out, variant + '.json');
      writeFileSync(path, JSON.stringify(evidence));
      const result = JSON.parse(execFileSync('python3', [fixtureCli, 'grade', 'LD03', path, '--variant', variant], {
        env: {...process.env, PYTHONDONTWRITEBYTECODE: '1'},
      }));
      assert.equal(result.passed, true);
    }
  } finally {
    rmSync(out, {recursive: true, force: true});
  }
});

test('rejects missing native token identity, missing raw CSS, and unapproved scope', () => {
  const fixture = contract('field-relay');
  const scope = scopeOf(fixture);
  const {state} = nativeMock(fixture, scope, 'start');
  assert.throws(() => normalize(fixture, {...scope, pageId: 'unapproved'}, state), /outside approved file/);
  const missingStyleEvidence = {...state, sourceStyles: {}};
  assert.throws(() => normalize(fixture, scope, missingStyleEvidence), /Missing CSS evidence/);
  delete state.tokens.tokens[0].id;
  assert.throws(() => normalize(fixture, scope, state), /Missing stable native token ID/);
});

test('reads variable declarations for each JSX element without running the source', () => {
  const jsx = `(<div id="1-0" style={{ backgroundColor: 'var(--color-scope-accent)', gap: '8px' }}>
    <div id="2-0" style={{gap: 4}}>Expected</div>
  </div>)`;
  const raw = sourceStylesFromJsx(ts, jsx);
  assert.equal(raw['1-0'].backgroundColor, 'var(--color-scope-accent)');
  assert.equal(raw['2-0'].gap, 4);
});
