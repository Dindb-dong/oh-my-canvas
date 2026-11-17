import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

import {observedGap, planLD03, seedLD03, sharedLD03Values} from './ld03.mjs';

const generator = fileURLToPath(new URL('../workloads/synthetic.py', import.meta.url));
const fixture = variant => JSON.parse(execFileSync('python3', [generator, 'fixture', 'LD03', '--variant', variant], {
  encoding: 'utf8', env: {...process.env, PYTHONDONTWRITEBYTECODE: '1'},
}));

test('both canonical LD03 variants keep four overrides out of the variable binding commands', async () => {
  for (const variant of ['field-relay', 'edition-grid']) {
    const source = fixture(variant);
    const plan = planLD03(source);
    const created = new Map();
    const bound = new Map();
    const patched = new Map();
    let next = 1;
    const api = {
      async call(tool, args) {
        switch (tool) {
          case 'create_node': {
            const id = next++;
            created.set(id, args);
            return {id};
          }
          default:
            throw new Error(tool);
        }
      },
      async literalGaps(documentId, overrides) {
        assert.equal(documentId, variant);
        for (const {key, field, value} of overrides) {
          assert.equal(field, 'gap');
          patched.set(key, value);
        }
      },
      async run(command, args) {
        if (command === 'file.new') return {id: variant};
        if (command === 'layout.add') return {ids: args.ids};
        if (command === 'variable.createCollection') return {id: 'collection'};
        if (command === 'variable.create') return {id: 'variable/' + args.name};
        if (command === 'variable.bind') {
          for (const id of args.ids) bound.set(`${id}:${args.field}`, args.variable);
          return {ok: true};
        }
        throw new Error(command);
      },
    };
    const {variableIds} = await seedLD03(api, source, plan);
    assert.equal(created.size, source.logical_objects);
    assert.equal(variableIds.size, 4);
    assert.equal(bound.size, 84);
    assert.equal(patched.size, 2);
    for (const override of plan.overrides) {
      const [id, node] = [...created].find(([, args]) => args.name === 'LD03 ' + override.key);
      assert.ok(!bound.has(`${id}:${override.field}`));
      assert.equal(override.field === 'fill' ? node.props.fill : patched.get(override.key), override.value);
    }
    assert.deepEqual(plan.candidate.map(style => style.key), ['target.accent', 'target.spacing']);
    assert.deepEqual(plan.probe.map(style => style.key), ['target.accent', 'target.spacing']);
  }
});

test('native spacing evidence uses the actual vertical sibling distance', () => {
  const vertical = {x0: 20, y0: 30, x1: 20, y1: 54, dashed: false, label: 'arbitrary'};
  assert.equal(observedGap([vertical, {...vertical, dashed: true, y1: 70}]), 24);
  assert.throws(() => observedGap([{...vertical, x1: 42, y1: 30}]), /vertical sibling gap/);
  assert.throws(() => observedGap([vertical, {...vertical, y1: 70}]), /vertical sibling gap/);
});

test('shared values map the exact native target and keep identities to the broker', () => {
  const source = fixture('field-relay');
  const rows = source.expected.styles.map(({key, value}) => ({name: key, id: `native/${key}`, value}));
  const ids = new Map(rows.map(({name, id}) => [name, id]));
  assert.deepEqual(sharedLD03Values(rows, ids), {
    target: {accent: '#136b62', spacing_px: 20}, archive: {accent: '#2864dc', spacing_px: 12},
  });
  rows[0].id = 'unexpected-document';
  assert.throws(() => sharedLD03Values(rows, ids));
});
