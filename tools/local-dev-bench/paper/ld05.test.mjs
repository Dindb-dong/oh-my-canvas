import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {normalizePaperNative, normalizePaperSource, paperLD05Markup, resolvePaperFlex, verifyImage, verifyPaperReopen} from './ld05.mjs';

const head = '<h1>Service route board</h1><button id="toggle">Pin route</button><p id="state">Route unpinned</p>';
const validation = '<label for="fixture-value">Dispatch note</label><p id="field-error">Enter four characters.</p>' +
  '<p id="saved">Dispatch note saved</p>';
const conditionalList = '<label for="show-extra">Show extra item</label>';
const list = '<ul class="cards"><li><article class="card" data-variant="standard">' +
  '<h2>Depot &amp; quay</h2><p>Item 1</p><img src="./assets/city-route.png" /></article></li></ul>';
const appearance = {gap: '12px', radius: '6px', heading: '20px', accent: 'rgb(37, 51, 87)',
  wrap: 'nowrap', direction: 'column', variantBorder: 'rgb(0, 0, 0)'};
const assets = {'city-route.png': '/fixture/assets/city-route.png'};

test('LD05 renders edited source states as named native-editable Paper markup', () => {
  const sources = [head + list, head + list + validation, head + list + validation + conditionalList];
  for (const [index, html] of sources.entries()) {
    const {controls, cards, list: listing} = paperLD05Markup(html, appearance, assets, index + 1);
    assert.equal(controls.length, [3, 6, 7][index]);
    assert.equal(cards[0].heading, 'Depot & quay');
    assert.match(cards[0].html, /Depot &amp; quay/);
    assert.match(cards[0].html, /src="paper-asset:\/\/\/fixture\/assets\/city-route.png"/);
    assert.match(listing, /flex-direction:column;flex-wrap:nowrap;gap:12px/);
  }
  assert.throws(() => paperLD05Markup(head + list, appearance, {}, 1), /Unregistered Paper asset/);
  assert.throws(() => paperLD05Markup(head + list, appearance, assets, 2), /Missing source text/);
  assert.throws(() => paperLD05Markup(head + list.replace('./assets/', 'https://example.com/'),
    appearance, assets, 1));
});

test('native image waits for upload before fetching exact original bytes', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'paper-ld05-image-'));
  t.after(() => rm(folder, {recursive: true, force: true}));
  const path = join(folder, 'asset.png');
  const bytes = Buffer.from('synthetic fixture original bytes');
  await writeFile(path, bytes);
  const fetch = t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url.href, 'https://app.paper.design/synthetic/native-original');
    assert.equal(options.redirect, 'error');
    return new Response(bytes, {headers: {'content-type': 'image/png'}});
  });
  let reads = 0;
  const read = async () => ({originalUrl: ++reads === 1 ? 'blob:https://app.paper.design/synthetic' :
    'https://app.paper.design/synthetic/native-original'});
  assert.equal(await verifyImage(read, 'synthetic', path), createHash('sha256').update(bytes).digest('hex'));
  assert.equal(fetch.mock.callCount(), 1);
  assert.equal(reads, 2);
  await assert.rejects(verifyImage(async () => ({originalUrl: 'https://example.com/other'}), 'synthetic', path));
});

test('native CSS omission resolves through browser CSS defaults', async () => {
  assert.deepEqual(await resolvePaperFlex({width: '100%', display: 'flex', gap: '20px', flexWrap: 'wrap'}),
    {direction: 'row', wrap: 'wrap'});
  await assert.rejects(resolvePaperFlex({display: 'block'}));
});

test('post-reopen native observation checks exact file, page, subtree and styles', async () => {
  const scope = {fileId: 'synthetic-only-file', fileName: 'Synthetic Paper test'};
  const canvas = {boardId: 'test-board', nativeReadback: {
    styles: {'test-heading': {fontSize: '24px'}}, jsx: '<div id="test-board">Source card</div>',
  }};
  const replies = {
    get_basic_info: {fileName: scope.fileName, pageId: 'test-page', artboards: [{id: 'test-board'}]},
    get_computed_styles: {styles: canvas.nativeReadback.styles}, get_jsx: canvas.nativeReadback.jsx,
  };
  const calls = [];
  const read = async ({name, arguments: args}) => {
    assert.equal(args.fileId, scope.fileId);
    calls.push(name);
    return replies[name];
  };
  assert.deepEqual(await verifyPaperReopen(read, scope, 'test-page', canvas), {
    pageId: 'test-page', boardId: 'test-board', ...canvas.nativeReadback,
  });
  assert.deepEqual(calls, ['get_basic_info', 'get_computed_styles', 'get_jsx']);
  for (const [name, value] of [
    ['get_basic_info', {...replies.get_basic_info, pageId: 'other-page'}],
    ['get_computed_styles', {styles: {'test-heading': {fontSize: '12px'}}}],
    ['get_jsx', '<div id="replacement">Source card</div>'],
  ]) {
    await assert.rejects(verifyPaperReopen(selector => Promise.resolve(selector.name === name ? value : replies[selector.name]),
      scope, 'test-page', canvas));
  }
});


test('common LD05 projections retain only actual observations and leave unsupported keys absent', () => {
  const browser = {evaluatedHtml: head.replace('<p id="state">', '<p id="state" role="status">') + list,
    states: [{controlName: 'Actual measured control', beforePress: 'Actual measured initial', statusVisible: true,
      cards: [{label: 'Observed card', src: './assets/city-route.png'}], afterPress: 'Observed selected',
      styles: {gap: '20px', radius: '14px', heading: '24px'}}]};
  const wanted = {gap: 999, component: 'InventedComponent', keyboard_after: 'Invented state'};
  const source = normalizePaperSource(browser, wanted);
  assert.equal(source.gap, 20);
  assert.equal(source.keyboard_after, 'Observed selected');
  assert.equal(source.check_control_name, 'Actual measured control');
  assert.equal(source.keyboard_before, 'Actual measured initial');
  assert.equal(source.component, undefined);
  const formBrowser = structuredClone(browser);
  formBrowser.states[0].form = {fieldName: 'Measured field', invalid: {message: 'Measured error'},
    retainedValue: 'Observed input', saved: 'Measured saved: Observed input'};
  const form = normalizePaperSource(formBrowser, wanted);
  assert.equal(form.field_name, 'Measured field');
  assert.equal(form.submitted_value, 'Observed input');
  assert.equal(form.valid_result, 'Measured saved');
  const boundary = {module_sha256: 'a'.repeat(64),
    initial_module_sha256: 'a'.repeat(64), app_source: "import {RegisteredCard as createCard} from './card.mjs';",
    module_source: 'export function createCard({title}) {}\nexport {createCard as RegisteredCard};'};
  boundary.module_sha256 = createHash('sha256').update(boundary.module_source).digest('hex');
  boundary.initial_module_sha256 = boundary.module_sha256;
  boundary.app_sha256 = createHash('sha256').update(boundary.app_source).digest('hex');
  assert.equal(normalizePaperSource(browser, wanted, boundary).component, 'RegisteredCard');
  assert.throws(() => normalizePaperSource(browser, wanted, {...boundary, module_sha256: 'b'.repeat(64)}));
  assert.throws(() => normalizePaperSource(browser, wanted, {...boundary, app_source: 'import fake from "./other.mjs"'}));
  assert.throws(() => normalizePaperSource(browser, wanted, {...boundary, module_source: 'export function createCard() {}'}));
  const snapshot = {listId: 'list', controls: [{name: 'Source control', text: 'Actual control'},
    {name: 'Source status', text: 'Actual status'}], cards: [{id: 'card', headingId: 'heading',
      heading: 'Actual card', originalAssetSha256: 'hash'}],
    styles: {list: {gap: '18px'}, card: {borderRadius: '10px'}, heading: {fontSize: '22px'}}};
  const native = normalizePaperNative(snapshot, wanted, {'sample-roll.png': 'hash'});
  assert.equal(native.gap, 18);
  assert.equal(native.asset, 'sample-roll.png');
  assert.deepEqual(native.cards, ['Actual card']);
  assert.equal(native.keyboard_after, undefined);
  assert.equal(native.component, undefined);
  assert.notDeepEqual(native, wanted);
  assert.equal(normalizePaperNative(snapshot, wanted, {}).asset, undefined);
});


test('native editable labels preserve measured source states without inventing native interaction', () => {
  const measured = {check_control_name: 'Pin route', keyboard_before: 'Route unpinned',
    keyboard_after: 'Actual source-selected state', component: 'Verified source boundary'};
  const content = paperLD05Markup(head + list, appearance, assets, 1, measured);
  const controls = content.controls.map(row => ({name: row.name, text: row.text}));
  assert.ok(content.controls.find(row => row.name === 'Source selected state').html.includes('Actual source-selected state'));
  assert.ok(content.controls.find(row => row.name === 'Source component').html.includes('Verified source boundary'));
  const snapshot = {listId: 'list', controls, cards: [{id: 'card', headingId: 'heading', heading: 'Observed card',
    originalAssetSha256: 'original-png'}], styles: {}};
  const value = normalizePaperNative(snapshot, {}, {'city-route.png': 'original-png'});
  assert.equal(value.keyboard_after, measured.keyboard_after);
  assert.equal(value.component, measured.component);
  snapshot.controls.find(row => row.name === 'Source selected state').text = 'Changed native label';
  assert.equal(normalizePaperNative(snapshot, {}, {}).keyboard_after, 'Changed native label');
  assert.throws(() => paperLD05Markup(head + list, appearance, assets, 1,
    {...measured, keyboard_before: 'Unobserved state'}));
  assert.throws(() => paperLD05Markup(head + list, appearance, assets, 1,
    {...measured, component: undefined}));
});
