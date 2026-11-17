import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';

import {captureLD03, observedGap, planLD03, seedLD03, sharedLD03Values, validateLD03Baseline, validatePreparedLD03} from './ld03.mjs';

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

test('same-document readbacks overlap with bounded concurrency and keep source order', async () => {
  const doc = '01234567-89ab-cdef-0123-456789abcdef';
  const cards = Array.from({length: 5}, (_, index) => ({
    id: `card-${index}`, kind: 'frame', parentId: 'root',
    properties: {name: `LD03 card-${index}`, fill: '#112233', layout: {type: 'flex', direction: 'column', gap: 14}},
  }));
  const children = cards.flatMap(card => ['label', 'state'].map(text => ({
    id: `${card.id}/${text}`, kind: 'text', parentId: card.id, properties: {name: `LD03 ${card.id}/${text}`, text},
  })));
  const board = {id: 'board', kind: 'frame', parentId: 'root', properties: {name: 'LD03 board'}};
  for (const card of cards) card.parentId = board.id;
  const raws = [...cards, ...children, board];
  const aliases = cards.map(card => ({id: card.id, type: 'FRAME', name: card.properties.name,
    children: children.filter(child => child.parentId === card.id).map(child => ({
      id: child.id, type: 'TEXT', name: child.properties.name, characters: child.properties.text,
    })),
  }));
  let active = 0;
  let peak = 0;
  const api = {
    bind: id => assert.equal(id, doc),
    snapshot: id => ({id: 'doc_' + id.replaceAll('-', ''), pages: [{rootNodeId: 'root'}], nodes: raws}),
    call: tool => tool === 'inspect_document' ? {id: doc, layers: [{id: board.id}]} :
      {id: board.id, name: board.properties.name, type: 'FRAME', children: aliases},
    async run(command) {
      if (command === 'variable.list') return {collections: [{id: 'collection'}], variables: []};
      peak = Math.max(peak, ++active);
      await delay(5);
      active -= 1;
      return command === 'inspect.properties' ? {sections: [{title: 'Fills', rows: [{color: '#112233'}]}]} :
        {lines: [{x0: 0, x1: 0, y0: 0, y1: 14, dashed: false}]};
    },
  };
  const result = await captureLD03(api, doc, {logical_objects: raws.length, start: {styles: []}});
  assert.equal(peak, 4);
  assert.equal(active, 0);
  assert.deepEqual(result.nodes.map(node => node.native_id), raws.map(node => node.id));
  assert.ok(result.nodes.filter(node => node.layout === 'vertical').every(node => node.gap === 14));
});

test('prepared baseline verifies native values, token references, overrides and editable identity',()=>{
  const source=fixture('field-relay');
  const before={document_id:'01234567-89ab-cdef-0123-456789abcdef',
    styles:source.start.styles.map(row=>({...row,native_id:'variable/'+row.key})),
    nodes:source.start.nodes.map((row,index)=>({...row,native_id:'node/'+index,editable:true,
      ...(row.bindings&&{bindings:Object.fromEntries(Object.entries(row.bindings).map(([field,key])=>[field,'variable/'+key]))})}))};
  validateLD03Baseline(source,before);
  for(const mutate of [
    value=>{value.styles[0].value='#000000';},
    value=>{value.nodes.find(row=>row.bindings?.fill).bindings.fill='wrong-variable';},
    value=>{value.nodes.find(row=>row.bindings&&!row.bindings.gap).gap=999;},
    value=>{value.nodes[0].editable=false;},
    value=>{value.nodes[1].native_id=value.nodes[0].native_id;},
  ]) {
    const changed=structuredClone(before); mutate(changed);
    assert.throws(()=>validateLD03Baseline(source,changed));
  }
  const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const prepared={schema:'omc-ld03-prepared/1',profile:'/tmp/omc-ld03-unit',
    ownershipToken:'01234567-89ab-cdef-0123-456789abcdef',documentId:before.document_id,
    fixtureContentSha256:hash(source),binarySha256:'binary',sourceSha256:'runner',
    before,beforeSha256:hash(before),variableIds:before.styles.map(row=>[row.key,row.native_id])};
  const loaded=validatePreparedLD03(prepared,source,'binary','runner');
  assert.equal(loaded.id,before.document_id);
  assert.equal(loaded.variableIds.get('target.accent'),'variable/target.accent');
  assert.throws(()=>validatePreparedLD03(prepared,source,'changed-binary','runner'));
  assert.throws(()=>validatePreparedLD03(prepared,source,'binary','changed-runner'));
  assert.throws(()=>validatePreparedLD03({...prepared,beforeSha256:'changed'},source,'binary','runner'));
  assert.throws(()=>validatePreparedLD03({...prepared,variableIds:[]},source,'binary','runner'));
  const changedFixture=structuredClone(source); changedFixture.brief+='changed';
  assert.throws(()=>validatePreparedLD03(prepared,changedFixture,'binary','runner'));
});
