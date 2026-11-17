import assert from 'node:assert/strict';
import {test} from 'node:test';
import {
  collectLifecycle, decodeNativeResult, makeCase, parsePlan, readAfterAttach, validateEvidence,
} from './ld09.mjs';
import {scaleBatches, scaleCode, seedCode, seedReadbackCode} from './seed.mjs';

function prepared(size = 'small', count = 0) {
  const testCase = makeCase(size, count);
  const origin = 'http://127.0.0.1:19001';
  const fileId = '00000000-0000-4000-8000-000000000001';
  const pageId = '00000000-0000-4000-8000-000000000002';
  return {
    size, savedLibraryEntries:count, origin, fileId, pageId, textId:'00000000-0000-4000-8000-000000000003',
    workspaceUrl:`${origin}/?screen=workspace&file-id=${fileId}&page-id=${pageId}`,
    savedCatalog:[testCase.targetName, ...testCase.distractorNames],
  };
}

function mocked(plan, {assetStatus, losesEdit = false} = {}) {
  const calls = [];
  let text = plan.beforeText;
  let clock = 0;
  return {
    calls, now:() => ++clock,
    launch:async () => calls.push('launch'),
    open:async () => calls.push('open'),
    async readNative() {
      calls.push('read');
      return {
        fileId:plan.fileId, fileName:plan.targetName, pageId:plan.pageId, pageName:plan.openedPage,
        textId:plan.textId, logicalObjects:plan.logicalObjects, text, fontId:plan.assetFont?.fontId,
      };
    },
    async assetFontReady() {
      calls.push('assets');
      return assetStatus ?? {status:'unobservable', reason:'test browser does not expose the asset'};
    },
    async edit() { calls.push('edit'); text = plan.afterText; },
    async waitForSave() { calls.push('save'); return false; },
    async reopen() {
      calls.push('reopen');
      if (losesEdit) text = plan.beforeText;
    },
  };
}

test('case plans cover 0/15/100 saved distractors and two document sizes', () => {
  for (const size of ['small', 'large']) {
    for (const count of [0, 15, 100]) {
      const input = prepared(size, count);
      const plan = parsePlan(input);
      assert.equal(new Set(plan.distractorNames).size, count);
      assert.equal(plan.tier, size === 'small' && count === 0 ? 'qualification' : 'prepared-scale');
      assert.equal(plan.logicalObjects, size === 'small' ? 4 : 1000);
      assert.throws(() => parsePlan({...input, workspaceUrl:input.workspaceUrl.replace('page-id=', 'page=')}));
      assert.throws(() => parsePlan({...input, savedCatalog:[...input.savedCatalog, 'unknown file']}));
    }
  }
  assert.throws(() => parsePlan({...prepared(), origin:'http://192.168.0.5:19001'}));
});

test('headless lifecycle separates launch, native content, verified edit and warm reopen', async () => {
  const plan = parsePlan(prepared());
  const driver = mocked(plan);
  const evidence = await collectLifecycle(plan, driver, driver.now);
  assert.deepEqual(driver.calls, ['launch','open','read','assets','edit','read','save','reopen','read']);
  validateEvidence(plan, evidence);
  assert.equal(evidence.events.find(event => event.name === 'first_window').status, 'unobservable');
  assert.equal(evidence.events.find(event => event.name === 'asset_font_ready').status, 'unobservable');
  const tampered = structuredClone(evidence);
  tampered.reopened.textId = plan.fileId;
  assert.throws(() => validateEvidence(plan, tampered), /Native document fixture/);
  tampered.reopened.textId = plan.textId;
  tampered.events.at(-1).elapsedMs = 0;
  assert.throws(() => validateEvidence(plan, tampered), /monotonic/);
});

test('recorded asset and font evidence is checked and lost edits fail reopen', async () => {
  const assetFont = {assetPaths:{'/assets/mock': 'a'.repeat(64)}, fontFamily:'Fixture Sans', fontId:'fixture-font'};
  const plan = parsePlan({...prepared(), assetFont});
  const assetStatus = {status:'observed', method:'asset-response-sha256-and-browser-font',
    assetPaths:assetFont.assetPaths, fontFamily:assetFont.fontFamily};
  const driver = mocked(plan, {assetStatus});
  const evidence = await collectLifecycle(plan, driver, driver.now);
  validateEvidence(plan, evidence);
  evidence.events.find(event => event.name === 'asset_font_ready').fontFamily = 'Fallback';
  assert.throws(() => validateEvidence(plan, evidence));
  const lossy = mocked(plan, {assetStatus, losesEdit:true});
  await assert.rejects(collectLifecycle(plan, lossy, lossy.now), /Native document fixture/);
});

test('small seeder rejects the wrong file and prepares four independently native shapes', async () => {
  const fixture = makeCase('small', 0);
  const page = {id:'mock-page', name:'Page 1', root:{children:[]}};
  let sequence = 0;
  const shape = (type, properties = {}) => ({
    id:`mock-shape-${sequence++}`, type, ...properties,
    resize(width, height) { Object.assign(this, {width, height}); },
    bringToFront() {},
  });
  const penpot = {
    currentPage:page,
    currentFile:{id:'mock-fixture', name:fixture.targetName, pages:[page]},
    createBoard() {
      const board = shape('board', {
        children:[],
        addFlexLayout() { return {appendChild:child => this.children.push(child)}; },
      });
      this.currentPage.root.children.push(board);
      return board;
    },
    createText:characters => shape('text', {characters}),
    createRectangle:() => shape('rectangle'),
    createEllipse:() => shape('ellipse'),
  };
  const AsyncFunction = (async () => {}).constructor;
  const execute = code => new AsyncFunction('penpot', code)(penpot);
  await assert.rejects(execute(seedCode('unrelated-file')), /Wrong synthetic fixture start state/);
  assert.deepEqual(page.root.children, []);
  const state = await execute(seedCode('mock-fixture'));
  assert.deepEqual(page.root.children[0].children.map(child => child.type), ['text','rectangle','ellipse']);
  assert.equal(await execute(seedReadbackCode({...fixture, fileId:'mock-fixture', ...state})), true);
  await assert.rejects(execute(seedCode('mock-fixture')), /Wrong synthetic fixture start state/);
  page.root.children[0].children[0].characters = 'Unexpected';
  await assert.rejects(execute(seedReadbackCode({...fixture, fileId:'mock-fixture', ...state})), /did not survive reopen/);

  const large = makeCase('large', 100);
  penpot.currentFile.name = large.targetName;
  page.root.children = [];
  const batches = scaleBatches(large);
  assert.equal(batches.length, 10);
  await assert.rejects(execute(scaleCode(large, 'mock-fixture', batches[1])), /Wrong synthetic scale seed state/);
  for (const batch of batches) {
    assert.ok(batch.end - batch.start <= 25);
    assert.equal(await execute(scaleCode(large, 'mock-fixture', batch)), batch.end);
  }
  assert.equal(new Set(page.root.children.map(card => card.name)).size, 249);
  const scaled = await execute(seedCode('mock-fixture', large));
  assert.equal(page.root.children.length, 250);
  assert.equal(await execute(seedReadbackCode({...large, fileId:'mock-fixture', ...scaled})), true);
  page.root.children[20].children.pop();
  await assert.rejects(execute(seedReadbackCode({...large, fileId:'mock-fixture', ...scaled})), /did not survive reopen/);
});

test('preparation binds native catalog order and complete inventory to acceptance evidence', async () => {
  const raw = prepared('small', 15);
  const catalogUrl = `${raw.origin}/?screen=dashboard-files&project-id=00000000-0000-4000-8000-000000000004`;
  const [target, ...distractors] = raw.savedCatalog;
  const input = {...raw, catalogUrl, catalogOrder:'modified-desc',
    savedCatalog:[target, ...distractors.reverse()]};
  const plan = parsePlan(input);
  assert.throws(() => parsePlan({...input, savedCatalog:raw.savedCatalog}), /modification order/);
  assert.throws(() => parsePlan({...input, savedCatalog:input.savedCatalog.slice(0,-1)}), /modification order/);
  assert.throws(() => parsePlan({...input, catalogUrl:input.workspaceUrl}), /catalog URL/);
  const driver = mocked(plan);
  const evidence = await collectLifecycle(plan, driver, driver.now);
  validateEvidence(plan, evidence);
  evidence.catalogEvidence.savedNames = raw.savedCatalog;
  assert.throws(() => validateEvidence(plan, evidence));
});

test('Penpot workspace attachment retries only known route failures on readback', async () => {
  let calls = 0;
  let paused = 0;
  const response = text => ({content:[{type:'text', text}]});
  const detached = response('Tool execution failed: Error: No Penpot instance connected for user token.');
  const timing = {duration:500, now:() => paused, pause:async ms => { paused += ms; }};
  const result = await readAfterAttach(async () => decodeNativeResult(++calls === 1 ? detached : response('{"result":42}')), timing);
  assert.equal(result, 42);
  assert.equal(calls, 2);
  assert.equal(paused, 250);
  await assert.rejects(readAfterAttach(async () => decodeNativeResult(detached), timing), /workspace is not attached/);
  const elapsed = paused;
  await assert.rejects(readAfterAttach(async () => decodeNativeResult(response('{"error":"wrong target"}')), timing),
    /native fixture operation failed/);
  await assert.rejects(readAfterAttach(async () => decodeNativeResult(response('Tool execution failed: unclassified')), timing),
    /non-JSON tool failure/);
  assert.equal(paused, elapsed);
});
