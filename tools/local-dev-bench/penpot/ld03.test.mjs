import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {chmod, mkdtemp, rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {changeFieldRelay, loadPreparedDescriptor, planFieldRelay, preparationSaveFence, preparedIdentityHash,
  readFieldRelay, readPreparationFence, refreshFieldRelay, requirePreparedBaseline, runFieldRelayModel,
  seedFieldRelay, stateDifferences, validatePreparedDescriptor} from './ld03.mjs';

const generator = 'tools/local-dev-bench/workloads/synthetic.py';
const loadFixture = variant => JSON.parse(execFileSync('python3',
  [generator,'fixture','LD03','--variant',variant],{encoding:'utf8'}));
const fixture = loadFixture('field-relay');
const edition = loadFixture('edition-grid');
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

for (const source of [fixture,edition]) test(`${source.source_family_id}: prepared start rejects a changed fixture, origin, native identity or baseline value`,async()=>{
  const native = fakePenpot(fileId);
  await run(seedFieldRelay(source,fileId),native);
  const state = await run(readFieldRelay(fileId),native);
  const pageId = '00000000-0000-4000-8000-000000000003';
  const origin = 'http://localhost:19001';
  const descriptor = {schema:'omc-penpot-ld03-prepared/1',fixtureSha256:source.fixture_sha256,
    fileName:`OMC Benchmark LD03 / ${source.source_family_id}`,
    workspace:`${origin}/?screen=workspace&file-id=${fileId}&page-id=${pageId}`,
    baselineIdentitySha256:preparedIdentityHash(state),saveFence:{pageId,marker:'a'.repeat(32)},
    storageState:{cookies:[],origins:[]}};
  assert.equal(validatePreparedDescriptor(source,origin,descriptor).searchParams.get('file-id'),fileId);
  requirePreparedBaseline(source,descriptor,state);
  assert.equal(preparedIdentityHash({...state,nodes:[...state.nodes].reverse()}),descriptor.baselineIdentitySha256);
  assert.throws(()=>validatePreparedDescriptor(source,origin,{...descriptor,fixtureSha256:'wrong'}),/Prepared fixture/);
  assert.throws(()=>validatePreparedDescriptor(source,'http://localhost:19002',descriptor));
  assert.throws(()=>validatePreparedDescriptor(source,origin,{...descriptor,
    storageState:{cookies:[],origins:[{origin:'https://unrelated.test'}]}}),/storage origin/);
  const swapped = structuredClone(state);swapped.nodes[0].native_id = 'replacement';
  assert.throws(()=>requirePreparedBaseline(source,descriptor,swapped),/identities changed/);
  const changed = structuredClone(state);changed.styles[0].value = '#ffffff';
  assert.throws(()=>requirePreparedBaseline(source,descriptor,changed),/baseline differs/);
  const directory = await mkdtemp(join(tmpdir(),'omc-ld03-prepared-'));
  try {
    const path = join(directory,'private.json');
    await writeFile(path,JSON.stringify(descriptor),{mode:0o600});
    assert.equal((await loadPreparedDescriptor(path,source,origin)).enrolled.baselineIdentitySha256,
      descriptor.baselineIdentitySha256);
    const link = join(directory,'linked.json');await symlink(path,link);
    await assert.rejects(loadPreparedDescriptor(link,source,origin),/private regular file/);
    await chmod(path,0o644);
    await assert.rejects(loadPreparedDescriptor(path,source,origin),/private regular file/);
  } finally { await rm(directory,{recursive:true,force:true}); }
});

test('preparation waits for actual contentsave then checks the persisted page marker',async()=>{
  const pageId = '00000000-0000-4000-8000-000000000003';
  const marker = 'b'.repeat(32);
  const data = new Map();let listener,removed = 0;
  const page = {id:pageId,setPluginData(key,value) { data.set(key,value);queueMicrotask(()=>listener()); },
    getPluginData:key=>data.get(key)};
  const penpot = {currentFile:{id:fileId,pages:[page]},currentPage:page,
    on(event,callback) { assert.equal(event,'contentsave');listener=callback;return 'listener-id'; },
    off(id) { assert.equal(id,'listener-id');removed++; }};
  assert.deepEqual(await run(preparationSaveFence(fileId,marker),penpot),{pageId,marker,contentsave:true});
  assert.equal(removed,1);
  assert.equal(await run(readPreparationFence(fileId,pageId),penpot),marker);
  await assert.rejects(run(readPreparationFence(copyId,pageId),penpot),/Wrong isolated/);
  await assert.rejects(run(readPreparationFence(fileId,copyId),penpot),/Missing LD03 prepared page/);
});

for (const [source, remainingBindings] of [
  [fixture, ['gap','fill','fill','gap']], [edition, ['fill','gap','gap','fill']],
]) {
  test(`${source.source_family_id} preserves native editability, four override omissions and scoped token propagation`, async () => {
    const fixture = source;
    const authored = planFieldRelay(fixture);
    assert.equal(authored.length, fixture.logical_objects);
    assert.deepEqual(authored.filter(item => item.layout === 'vertical' && Object.keys(item.bindings).length === 1)
      .map(item => Object.keys(item.bindings)[0]), remainingBindings);
    const original = fakePenpot(fileId);
    await assert.rejects(run(seedFieldRelay(fixture,copyId), original), /Wrong isolated/);
    assert.deepEqual(await run(seedFieldRelay(fixture,fileId), original), {nodes:fixture.logical_objects, styles:4});
    assert.equal(original.currentPage.root.children[0].children[0].name, 'LD03 board / title');
    const before = await run(readFieldRelay(fileId), original);
    assert.deepEqual(stateDifferences(fixture.start, before), []);
    const bad = structuredClone(before);
    const card = bad.nodes.find(node => node.key.startsWith('target/') && node.bindings.gap);
    delete card.bindings.gap;
    card.gap = 99;
    assert.deepEqual(stateDifferences(fixture.start, bad), [`${card.key}.gap`,`${card.key}.bindings`]);
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
    await run(refreshFieldRelay(copyId), copy);
    const copyBefore = await run(readFieldRelay(copyId), copy);
    const probeActions = await run(changeFieldRelay(copyId,fixture.probe_actions), copy);
    assert.equal(await run(refreshFieldRelay(copyId), copy), true);
    const probe = await run(readFieldRelay(copyId), copy);
    const afterProbeOriginal = await run(readFieldRelay(fileId), original);
    const reopened = await run(readFieldRelay(fileId), original);
    const evidence = {before,candidate,reopened,probe,probe_actions:probeActions,copy_before:copyBefore,
      after_probe_original:afterProbeOriginal};
    assert.equal(before.nodes.filter(node => node.bindings.gap).length, 42);
    assert.equal(before.nodes.filter(node => node.bindings.fill).length, 42);
    const tmp = await mkdtemp(join(tmpdir(),'omc-ld03-test-'));
    try {
      const path = join(tmp,'evidence.json');
      await writeFile(path, JSON.stringify(evidence));
      const result = JSON.parse(execFileSync('python3',
        [generator,'grade','LD03',path,'--variant',fixture.source_family_id],{encoding:'utf8'}));
      assert.deepEqual(result, {passed:true, failures:[]});
      if (fixture.source_family_id === 'field-relay') {
        const originalOnly = JSON.parse(execFileSync('python3', [
          'tools/local-dev-bench/penpot/ld03-original.py', path,
        ], {encoding:'utf8'}));
        assert.deepEqual(originalOnly, {scope:'original-edit-and-reopen', passed:true, failures:[]});
      }
    } finally {
      await rm(tmp,{recursive:true,force:true});
    }
  });
}

test('edition-grid packs both wrappers, all ten rows in each group and the separate archive without overlaps', async () => {
  const boxes = planFieldRelay(edition).filter(node => node.kind === 'frame');
  const byKey = new Map(boxes.map(node => [node.key,node]));
  assert.deepEqual(byKey.get('board/editorial').box,[20,76,552,844]);
  assert.deepEqual(byKey.get('board/distribution').box,[596,76,552,844]);
  assert.deepEqual(byKey.get('target/3/9').box,[10,746,240,74]);
  for (const {key,parent,box:[x,y,w,h]} of boxes) {
    assert.ok(w > 0 && h > 0,key);
    if (!parent) continue;
    const {box:[,,parentW,parentH]} = byKey.get(parent);
    assert.ok(x >= 0 && y >= 0 && x + w <= parentW && y + h <= parentH,key);
    for (const other of boxes.filter(row => row.parent === parent && row.key !== key)) {
      const [otherX,otherY,otherW,otherH] = other.box;
      assert.ok(x + w <= otherX || otherX + otherW <= x || y + h <= otherY || otherY + otherH <= y,
        `${key} overlaps ${other.key}`);
    }
  }
  const penpot = fakePenpot(fileId);
  await run(seedFieldRelay(edition,fileId),penpot);
  const [root] = penpot.currentPage.root.children;
  const frames = [root];
  while (frames.length) {
    const shape = frames.pop();
    const key = shape.name.slice('LD03 '.length).replaceAll(' / ','/');
    const position = shape === root ? [shape.x,shape.y] : [shape.parentX,shape.parentY];
    assert.deepEqual([...position,shape.width,shape.height],byKey.get(key).box);
    frames.push(...shape.children.filter(child => child.type === 'board'));
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
