import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

import {observedGap, planLD03, seedLD03} from './ld03.mjs';

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
          case 'get_node':
            return {layout: {type: 'flex', direction: 'column', gap: 42}};
          case 'set_properties':
            patched.set(args.ids[0], args.props.layout.gap);
            return {ok: true};
          default:
            throw new Error(tool);
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
      assert.equal(override.field === 'fill' ? node.props.fill : patched.get(id), override.value);
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
