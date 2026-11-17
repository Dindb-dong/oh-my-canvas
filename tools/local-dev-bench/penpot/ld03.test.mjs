import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {changeFieldRelay, planFieldRelay, readFieldRelay, refreshFieldRelay, runFieldRelayModel, seedFieldRelay, stateDifferences} from './ld03.mjs';

const generator = 'tools/local-dev-bench/workloads/synthetic.py';
const fixture = JSON.parse(execFileSync('python3', [generator,'fixture','LD03','--variant','field-relay'], {encoding:'utf8'}));
const fileId = '00000000-0000-4000-8000-000000000001';
const copyId = '00000000-0000-4000-8000-000000000002';

function fakePenpot(documentId) {
  const root = {children:[]};
  let counter = 0;
  const page = {root};
  const add = (type, properties = {}) => {
    const shape = {
      id:`${documentId}-shape-${counter++}`, type, tokens:{}, ...properties,
      resize(width,height) { Object.assign(this, {width,height}); },
      applyToken(token, [property]) {
        this.tokens[property] = token.name;
        token.shapes.push({shape:this,property});
        token.apply();
      },
    };
    let name;
    Object.defineProperty(shape, 'name', {
      get:() => name,
      set:value => { name = value.replaceAll('/', ' / '); },
    });
    root.children.push(shape);
    return shape;
  };
  const catalog = {
    sets:[],
    addSet({name}) {
      const set = {
        name, tokens:[],
        activeStatus:false,
        get active() { return this.activeStatus; },
        set active(value) {
          this.activeStatus = value;
          if (value) for (const token of this.tokens) token.apply();
        },
        toggleActive() { this.active = !this.active; },
        addToken({type,name,value}) {
          let currentValue = value;
          const token = {
            id:`${documentId}-token-${counter++}`, name, type, shapes:[],
            get value() { return currentValue; },
            set value(value) { currentValue = value; },
            apply() {
              for (const {shape,property} of this.shapes) {
                if (property === 'rowGap') shape.flex.rowGap = Number(this.value);
                else shape.fills = [{fillColor:this.value,fillOpacity:1}];
              }
            },
          };
          this.tokens.push(token);
          return token;
        },
      };
      this.sets.push(set);
      return set;
    },
  };
  return {
    currentPage:page, currentFile:{id:documentId,pages:[page]}, library:{local:{tokens:catalog}},
    createText:characters => add('text',{characters}),
    createBoard:() => add('board',{
      children:[],
      appendChild(shape) {
        root.children.splice(root.children.indexOf(shape),1);
        this.children.push(shape);
      },
      addFlexLayout() { return this.flex = {appendChild:shape => this.appendChild(shape)}; },
    }),
  };
}

const AsyncFunction = (async () => {}).constructor;
const run = (code, penpot) => new AsyncFunction('penpot', code)(penpot);

test('field-relay uses native editable objects, four real override omissions and two narrow token edits', async () => {
  const authored = planFieldRelay(fixture);
  assert.equal(authored.length, fixture.logical_objects);
  assert.deepEqual(authored.filter(item => item.layout === 'vertical' && Object.keys(item.bindings).length === 1)
    .map(item => Object.keys(item.bindings)[0]), ['gap','fill','fill','gap']);
  const original = fakePenpot(fileId);
  await assert.rejects(run(seedFieldRelay(fixture,copyId), original), /Wrong isolated/);
  assert.deepEqual(await run(seedFieldRelay(fixture,fileId), original), {nodes:fixture.logical_objects, styles:4});
  assert.equal(original.currentPage.root.children[0].children[0].name, 'LD03 board / title');
  const before = await run(readFieldRelay(fileId), original);
  assert.deepEqual(stateDifferences(fixture.start, before), []);
  const bad = structuredClone(before);
  const card = bad.nodes.find(node => node.key === 'target/0/0');
  delete card.bindings.gap;
  card.gap = 99;
  assert.deepEqual(stateDifferences(fixture.start, bad), ['target/0/0.gap','target/0/0.bindings']);
  const after = fixture.expected.styles.filter(style => style.key.startsWith('target.'));
  assert.throws(() => changeFieldRelay(fileId, [...after, {key:'keep.accent'}]));
  await run(changeFieldRelay(fileId,after), original);
  const unpropagated = await run(readFieldRelay(fileId), original);
  assert.equal(stateDifferences(fixture.expected, unpropagated).length, 76);
  assert.equal(await run(refreshFieldRelay(fileId), original), true);
  const candidate = await run(readFieldRelay(fileId), original);

  const copy = fakePenpot(copyId);
  await run(seedFieldRelay(fixture,copyId), copy);
  await run(changeFieldRelay(copyId,after), copy);
  const probeActions = await run(changeFieldRelay(copyId,fixture.probe_actions), copy);
  assert.equal(await run(refreshFieldRelay(copyId), copy), true);
  const probe = await run(readFieldRelay(copyId), copy);
  const afterProbeOriginal = await run(readFieldRelay(fileId), original);
  const evidence = {before,candidate,reopened:candidate,probe,probe_actions:probeActions,after_probe_original:afterProbeOriginal};
  assert.equal(before.nodes.filter(node => node.bindings.gap).length, 42);
  assert.equal(before.nodes.filter(node => node.bindings.fill).length, 42);
  const tmp = await mkdtemp(join(tmpdir(),'omc-ld03-test-'));
  try {
    const path = join(tmp,'evidence.json');
    await writeFile(path, JSON.stringify(evidence));
    const result = JSON.parse(execFileSync('python3', [generator,'grade','LD03',path,'--variant','field-relay'], {encoding:'utf8'}));
    assert.deepEqual(result, {passed:true, failures:[]});
    const originalOnly = JSON.parse(execFileSync('python3', [
      'tools/local-dev-bench/penpot/ld03-original.py', path,
    ], {encoding:'utf8'}));
    assert.deepEqual(originalOnly, {scope:'original-edit-and-reopen', passed:true, failures:[]});
  } finally {
    await rm(tmp,{recursive:true,force:true});
  }
});

test('model socket sees only live shared values, and its actions control candidate without an expected-value fallback', async () => {
  const penpot = fakePenpot(fileId);
  const execute = code => run(code,penpot);
  await execute(seedFieldRelay(fixture,fileId));
  const before = await execute(readFieldRelay(fileId));
  const changes = [{key:'target.accent',value:'#449933'},{key:'target.spacing',value:23}];
  const ids = Object.fromEntries(before.styles.map(style => [style.key,style.native_id]));
  const replaced = {...ids,'target.spacing':'replacement'};
  await assert.rejects(execute(changeFieldRelay(fileId,changes,replaced)),/Wrong native token/);
  assert.deepEqual(stateDifferences(fixture.start,await execute(readFieldRelay(fileId))),[]);

  const temp = await mkdtemp(join(tmpdir(),'omc-penpot-actor-'));
  try {
    const actor = join(temp,'actor.mjs');
    await writeFile(actor,`#!/usr/bin/env node
import assert from 'node:assert/strict';
import {createConnection} from 'node:net';
function request(name,args) {
  return new Promise((resolve,reject) => {
    const socket = createConnection(process.argv[2], () => socket.write(JSON.stringify({name,arguments:args})+'\\n'));
    let body = '';
    socket.setEncoding('utf8').on('data', chunk => body += chunk);
    socket.on('error',reject).on('end', () => resolve(JSON.parse(body)));
  });
}
const initial = await request('inspect_shared_values',{});
assert.deepEqual(initial,{result:{target:{accent:'#2864dc',spacing_px:12},archive:{accent:'#2864dc',spacing_px:12}}});
const unscoped = await request('set_shared_values',{accent:'#449933',spacing_px:23,archive:'#ffffff'});
assert.match(unscoped.error,/Expected a six-digit accent/);
const changed = await request('set_shared_values',{accent:'#449933',spacing_px:23});
assert.deepEqual(changed,{result:{target:{accent:'#449933',spacing_px:23},archive:initial.result.archive}});
`,{mode:0o700});
    const modelTools = [];
    const candidateActions = [];
    let writes = 0;
    await runFieldRelayModel({execute,fileId,before,modelCommand:actor,modelTools,candidateActions,beforeWrite:() => writes++});
    assert.equal(writes,1);
    assert.deepEqual(modelTools.map(event => event.status),['ok','rejected','ok']);
    assert.deepEqual(candidateActions.map(action => [action.key,action.nativeId,action.value]),[
      ['target.accent',ids['target.accent'],'#449933'],['target.spacing',ids['target.spacing'],23],
    ]);
    const candidate = await execute(readFieldRelay(fileId));
    assert.ok(stateDifferences(fixture.expected,candidate).length > 0);
    assert.deepEqual(candidate.styles.filter(style => style.key.startsWith('keep.')),
      before.styles.filter(style => style.key.startsWith('keep.')));
  } finally {
    await rm(temp,{recursive:true,force:true});
  }
});
