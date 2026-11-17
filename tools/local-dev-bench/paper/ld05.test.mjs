import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {paperLD05Markup, verifyImage} from './ld05.mjs';

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
