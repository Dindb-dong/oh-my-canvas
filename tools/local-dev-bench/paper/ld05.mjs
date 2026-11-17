import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {copyFile, mkdir, readFile, realpath, writeFile} from 'node:fs/promises';
import {basename, dirname, isAbsolute, join, resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {benchRequire} from '../replays/mcp.mjs';
import {mergeExtraCard, mergeStyles, sourceProbe} from '../omc-native/ld05.mjs';
import {withPaper} from './ld03.mjs';
import {publishCandidate} from '../publish-candidate.mjs';
import {awaitNativeReopen, inheritedDeadline} from '../figma/ld05-run.mjs';

const approvedCanvas = 'OMC Benchmark • Synthetic CAP Probe • 2026-11-17';
const sourceScript = fileURLToPath(new URL('../ld05_source.py', import.meta.url));
const escape = text => String(text).replace(/[&<>"']/g, char =>
  ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'})[char]);
const node = (name, styles, body = '') => `<div layer-name="${escape(name)}" style="${escape(styles)}">${body}</div>`;
const color = value => {
  if (/^#[\da-f]{6}$/i.test(value)) return value.toLowerCase();
  const match = /^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/.exec(value);
  assert.ok(match && match.slice(1).every(channel => Number(channel) <= 255), 'Unexpected Paper color');
  return '#' + match.slice(1).map(channel => Number(channel).toString(16).padStart(2, '0')).join('');
};

export function paperLD05Markup(rendered, appearance, assetPaths, cycle, observedSource) {
  const {JSDOM} = benchRequire('jsdom');
  const {window} = new JSDOM(rendered);
  try {
    const doc = window.document;
    const textControl = (name, text, styles = '') => {
      assert.ok(text, `Missing source text for ${name}`);
      return {name, html: node(name, styles, escape(text)), text};
    };
    const readText = (name, selector) => textControl(name, doc.querySelector(selector)?.textContent?.trim());
    const listing = doc.querySelector('.cards');
    assert.ok(listing, 'Missing rendered source list');
    const {gap, radius, heading, accent, wrap, direction, variantBorder} = appearance;
    for (const value of [gap, radius, heading]) assert.match(value, /^\d+(\.\d+)?px$/);
    assert.ok(['row', 'column'].includes(direction));
    assert.ok(['wrap', 'nowrap'].includes(wrap));
    const controls = [
      readText('Source title', 'h1'), readText('Source control', '#toggle'), readText('Source status', '#state'),
    ];
    if (observedSource) {
      assert.equal(observedSource.check_control_name, controls[1].text);
      assert.equal(observedSource.keyboard_before, controls[2].text);
      controls.push(textControl('Source selected state', observedSource.keyboard_after),
        textControl('Source component', observedSource.component));
    }
    if (cycle >= 2) {
      controls.push(readText('Source field label', 'label[for="fixture-value"]'),
        readText('Source validation', '#field-error'), readText('Source saved message', '#saved'));
    }
    if (cycle === 3) controls.push(readText('Source list label', 'label[for="show-extra"]'));
    const cards = [...listing.querySelectorAll('article.card')].map((element, index) => {
      const heading = element.querySelector('h2')?.textContent?.trim();
      const detail = element.querySelector('p')?.textContent?.trim();
      const src = element.querySelector('img')?.getAttribute('src') ?? '';
      assert.ok(/^\.\/assets\/[a-z-]+\.png$/.test(src));
      const asset = basename(src);
      const path = assetPaths[asset];
      assert.ok(typeof path === 'string' && isAbsolute(path) && basename(path) === asset, 'Unregistered Paper asset');
      const layerHeading = textControl(`Heading ${index}`, heading, `font-size:${appearance.heading};color:${color(accent)}`);
      const layerDetail = textControl(`Detail ${index}`, detail);
      const name = `Card ${index}`;
      const variant = element.getAttribute('data-variant');
      assert.match(variant, /^[a-z-]+$/);
      const border = variant === 'standard' ? '' : `;border:2px solid ${color(variantBorder)}`;
      const image = `<img layer-name="Image ${index}" src="paper-asset://${escape(path)}" width="64" height="36" alt="">`;
      return {name, heading, detail, asset, variant, html: node(name,
        `display:flex;flex-direction:column;gap:4px;padding:16px;width:224px;border-radius:${radius};background-color:#ffffff${border}`,
        image + layerHeading.html + layerDetail.html)};
    });
    assert.ok(cards.length);
    return {
      controls, cards, list: node('Source cards', `width:100%;display:flex;flex-direction:${direction};flex-wrap:${wrap};gap:${gap}`),
    };
  } finally {
    window.close();
  }
}

// Project only measured fields. Missing behavioral or component observations stay
// absent so the shared oracle rejects them instead of accepting fixture values.
export function normalizePaperSource(browser, wanted, componentBoundary) {
  const state = browser.states[0];
  assert.equal(typeof state.controlName, 'string');
  assert.equal(typeof state.beforePress, 'string');
  assert.equal(typeof state.statusVisible, 'boolean');
  const value = {check_control_name: state.controlName,
    keyboard_before: state.beforePress, keyboard_after: state.afterPress,
    status_visible: state.statusVisible,
    cards: state.cards.map(card => card.label), asset: basename(state.cards.at(-1).src)};
  if (state.form) Object.assign(value, {field_name: state.form.fieldName,
    invalid_result: state.form.invalid.message, submitted_value: state.form.retainedValue,
    valid_result: state.form.saved.slice(0, -state.form.retainedValue.length - 2)});
  if (componentBoundary) {
    assert.match(componentBoundary.module_sha256, /^[a-f0-9]{64}$/);
    assert.equal(componentBoundary.module_sha256, componentBoundary.initial_module_sha256);
    assert.match(componentBoundary.app_source, /import\s*\{createCard\}\s*from\s*['"]\.\/card\.mjs['"]/);
    assert.match(componentBoundary.module_source, /export function createCard\(/);
    assert.ok(componentBoundary.registered_component);
    value.component = componentBoundary.registered_component;
  }
  const px = input => { assert.match(input, /^\d+px$/); return Number(input.slice(0, -2)); };
  if (Object.hasOwn(wanted, 'gap')) Object.assign(value, {gap: px(state.styles.gap),
    radius: px(state.styles.radius), heading_size: px(state.styles.heading)});
  if (Object.hasOwn(wanted, 'wrap')) Object.assign(value, {wrap: state.styles.wrap === 'wrap',
    accent: color(state.styles.accent).toUpperCase()});
  if (Object.hasOwn(wanted, 'variant')) Object.assign(value, {variant: state.cards.at(-1).variant,
    copy: state.cards.at(-1).detail, variant_border: color(state.styles.variantBorder).toUpperCase()});
  return value;
}

export function normalizePaperNative(snapshot, wanted, assetHashes) {
  const controls = Object.fromEntries(snapshot.controls.map(row => [row.name, row.text]));
  const asset = Object.keys(assetHashes).find(key => assetHashes[key] === snapshot.cards.at(-1).originalAssetSha256);
  const value = {check_control_name: controls['Source control'], keyboard_before: controls['Source status'],
    ...(controls['Source selected state'] ? {keyboard_after: controls['Source selected state']} : {}),
    ...(controls['Source component'] ? {component: controls['Source component']} : {}),
    status_visible: Boolean(controls['Source status']), cards: snapshot.cards.map(row => row.heading), asset};
  if (controls['Source field label']) {
    const saved = /^(.*): (.*)$/.exec(controls['Source saved message']);
    Object.assign(value, {field_name: controls['Source field label'], invalid_result: controls['Source validation'],
      ...(saved ? {valid_result: saved[1], submitted_value: saved[2]} : {})});
  }
  const px = input => { assert.match(input, /^\d+px$/); return Number(input.slice(0, -2)); };
  const list = snapshot.styles[snapshot.listId], first = snapshot.cards[0], last = snapshot.cards.at(-1);
  if (Object.hasOwn(wanted, 'gap')) Object.assign(value, {gap: px(list.gap),
    radius: px(snapshot.styles[first.id].borderRadius), heading_size: px(snapshot.styles[first.headingId].fontSize)});
  if (Object.hasOwn(wanted, 'wrap')) Object.assign(value, {wrap: snapshot.flex.wrap === 'wrap',
    accent: color(snapshot.styles[first.headingId].color).toUpperCase()});
  if (Object.hasOwn(wanted, 'variant')) Object.assign(value, {variant: last.name.startsWith('Variant ') ?
    last.name.slice(8) : undefined, copy: last.detail, variant_border: color(snapshot.styles[last.id].borderColor).toUpperCase()});
  return value;
}

async function readNamed(read, parent, name) {
  const {children} = await read('get_children', {nodeId: parent});
  const hits = children.filter(child => child.name === name);
  assert.equal(hits.length, 1, `Missing or duplicate native layer ${name}`);
  const row = await read('get_node_info', {nodeId: hits[0].id});
  assert.equal(row.parentId, parent);
  assert.equal(row.isLocked, false);
  assert.equal(row.isVisible, true);
  return row;
}

export async function verifyImage(read, imageId, trustedAsset) {
  const deadline = performance.now() + 5000;
  while (performance.now() < deadline) {
    const image = await read('get_fill_image', {nodeId: imageId});
    const rawUrl = image.originalUrl ?? image.url ?? image.imageUrl ?? image.metadata?.url;
    assert.ok(rawUrl, 'Paper did not return the native stored image URL');
    const url = new URL(rawUrl);
    assert.equal(url.origin, 'https://app.paper.design');
    assert.ok(!url.username && !url.password);
    if (url.protocol === 'blob:') {
      await delay(100);
      continue;
    }
    assert.equal(url.protocol, 'https:');
    const response = await fetch(url, {redirect: 'error', signal: AbortSignal.timeout(5000)});
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /^image\/png/);
    const stored = Buffer.from(await response.arrayBuffer());
    const local = await readFile(trustedAsset);
    assert.deepEqual(stored, local, 'Paper original PNG differs from the registered source asset');
    return createHash('sha256').update(stored).digest('hex');
  }
  throw new Error('Paper image stayed in renderer blob storage for 5 seconds; persisted original bytes unavailable');
}

function setting(nodeIds, styles) {
  return {nodeIds, styles};
}

export async function resolvePaperFlex(style) {
  assert.equal(style.display, 'flex');
  const {chromium} = benchRequire('playwright');
  const browser = await chromium.launch({channel: 'chrome', headless: true});
  try {
    const page = await browser.newPage();
    return await page.evaluate(styles => {
      const element = document.createElement('div');
      Object.assign(element.style, styles);
      document.body.append(element);
      const actual = getComputedStyle(element);
      return {direction: actual.flexDirection, wrap: actual.flexWrap};
    }, style);
  } finally {
    await browser.close();
  }
}

export async function paperLD05Cycle(read, scope, pageId, name, source, edits, cycle, assetPaths, save,
  {observeImage = verifyImage} = {}) {
  assert.equal(scope.fileName, approvedCanvas);
  assert.match(scope.fileId, /^[-\w]+$/);
  const call = async (tool, args = {}) => {
    const result = await read({name: tool, arguments: {...args, fileId: scope.fileId}});
    assert.ok(result && !result.error && !result.errors?.length, `Paper ${tool} recorded an in-band failure`);
    return result;
  };
  const info = await call('get_basic_info', {pageId});
  assert.equal(info.fileName, scope.fileName);
  assert.equal(info.artboards.some(board => board.name === name), false);
  const working = new Set();
  const write = async (targetNodeId, html) => {
    const {createdNodes} = await call('write_html', {targetNodeId, mode: 'insert-children', html});
    assert.ok(createdNodes?.length);
    for (const {id} of createdNodes) working.add(id);
  };
  try {
    await call('create_artboard', {pageId, name, styles: {
      width: '1120px', height: '760px', display: 'flex', flexDirection: 'column', gap: '12px', padding: '16px',
    }});
    const fresh = await call('get_basic_info', {pageId});
    const board = fresh.artboards.find(row => row.name === name);
    assert.ok(board && !info.artboards.some(row => row.id === board.id));
    working.add(board.id);
    for (const item of source.controls) await write(board.id, item.html);
    await write(board.id, source.list);
    const list = await readNamed(call, board.id, 'Source cards');
    for (const card of source.cards) await write(list.id, card.html);
    await call('finish_working_on_nodes', {nodeIds: [board.id]});
    const controls = [];
    for (const {name, text} of source.controls) {
      const row = await readNamed(call, board.id, name);
      assert.equal(row.component, 'Text');
      assert.equal(row.textContent, text);
      controls.push({id: row.id, name: row.name, text: row.textContent});
    }
    const cards = [];
    for (const [index, expected] of source.cards.entries()) {
      const card = await readNamed(call, list.id, expected.name);
      const heading = await readNamed(call, card.id, `Heading ${index}`);
      const detail = await readNamed(call, card.id, `Detail ${index}`);
      const image = await readNamed(call, card.id, `Image ${index}`);
      assert.equal(heading.textContent, expected.heading);
      assert.equal(detail.textContent, expected.detail);
      const originalAssetSha256 = await observeImage(call, image.id, assetPaths[expected.asset]);
      cards.push({id: card.id, name: card.name, heading: heading.textContent, detail: detail.textContent,
        headingId: heading.id, detailId: detail.id, imageId: image.id, originalAssetSha256});
    }
    const nodeIds = [list.id, ...cards.flatMap(row => [row.id, row.headingId])];
    const refreshStyles = (await call('get_computed_styles', {nodeIds})).styles;
    const refreshed = {boardId: board.id, listId: list.id, controls, cards: structuredClone(cards),
      styles: refreshStyles, flex: cycle === 3 ? await resolvePaperFlex(refreshStyles[list.id]) : undefined};
    await save('native-refresh.json', refreshed);
    const last = cards.at(-1);
    const update = cycle === 1 ? [
      setting([list.id], {gap: `${edits.gap}px`}),
      setting(cards.map(row => row.id), {borderRadius: `${edits.radius}px`}),
      setting(cards.map(row => row.headingId), {fontSize: `${edits.heading_size}px`}),
    ] : cycle === 2 ? [
      setting([list.id], {flexDirection: 'row', flexWrap: 'wrap'}),
      setting(cards.map(row => row.id), {flexBasis: '224px', flexGrow: 1, flexShrink: 1}),
      setting(cards.map(row => row.headingId), {color: edits.accent}),
    ] : [
      setting([last.id], {borderWidth: '2px', borderStyle: 'solid', borderColor: edits.variant_border}),
      setting([last.imageId], {backgroundImage: `url("paper-asset://${assetPaths[edits.asset]}")`}),
    ];
    const response = await call('update_styles', {updates: update});
    await save('native-style-response.json', response);
    const results = response.updates ?? response.results ?? [];
    assert.ok(results.every(row => !row.error && row.result !== 'error' && !Object.keys(row.ignoredStyles ?? {}).length),
      'Paper ignored a required style edit');
    if (cycle === 3) {
      await call('set_text_content', {updates: [{nodeId: last.detailId, html: escape(edits.copy)}]});
      await call('rename_nodes', {updates: [{nodeId: last.id, name: 'Variant ' + edits.variant}]});
    }
    const {styles} = await call('get_computed_styles', {nodeIds: [list.id, ...cards.flatMap(row => [row.id, row.headingId])]});
    await save('native-style-readback.json', styles);
    const observed = {};
    if (cycle === 1) {
      observed.gap = styles[list.id].gap;
      observed.radius = styles[cards[0].id].borderRadius;
      observed.heading_size = styles[cards[0].headingId].fontSize;
      assert.equal(observed.gap, `${edits.gap}px`);
      assert.ok(cards.every(row => styles[row.id].borderRadius === `${edits.radius}px` &&
        styles[row.headingId].fontSize === `${edits.heading_size}px`));
    } else if (cycle === 2) {
      observed.accent = color(styles[cards[0].headingId].color);
      Object.assign(observed, await resolvePaperFlex(styles[list.id]));
      observed.flex = ['flexGrow', 'flexShrink', 'flexBasis'].map(key => styles[cards[0].id][key]).join(' ');
      assert.equal(observed.direction, 'row');
      assert.equal(observed.wrap, 'wrap');
      assert.equal(observed.flex, '1 1 224px');
      assert.ok(cards.every(row => color(styles[row.headingId].color) === edits.accent.toLowerCase()));
    } else {
      observed.variant_border = color(styles[last.id].borderColor);
      assert.equal(observed.variant_border, edits.variant_border.toLowerCase());
      observed.copy = (await call('get_node_info', {nodeId: last.detailId})).textContent;
      assert.equal(observed.copy, edits.copy);
      const path = assetPaths[edits.asset];
      assert.equal(basename(path), edits.asset);
      observed.assetSha256 = await observeImage(call, last.imageId, path);
      observed.asset = basename(path);
      const layerName = (await call('get_node_info', {nodeId: last.id})).name;
      assert.equal(layerName, 'Variant ' + edits.variant);
      observed.variant = layerName.slice('Variant '.length);
    }
    const jsx = await call('get_jsx', {nodeId: board.id, format: 'inline-styles', includeNodeIds: true});
    assert.ok(jsx);
    await save('native-edit.json', {styles, observed, jsx});
    if (cycle === 3) Object.assign(last, {name: 'Variant ' + observed.variant, detail: observed.copy,
      originalAssetSha256: observed.assetSha256});
    const edited = {boardId: board.id, listId: list.id, controls, cards, styles,
      flex: cycle === 2 ? {direction: observed.direction, wrap: observed.wrap} : refreshed.flex};
    return {pageId, boardId: board.id, observed, refreshed, edited, nativeReadback: {styles, jsx}};
  } finally {
    if (working.size) await call('finish_working_on_nodes', {nodeIds: [...working]});
  }
}

function sourceCommand(action, fixture, sourceDir, cycle) {
  const args = ['-B', sourceScript, action, fixture.source_family_id, sourceDir];
  if (cycle) args.push('--cycle', String(cycle));
  const manifest = JSON.parse(execFileSync('python3', args, {encoding: 'utf8'}));
  assert.equal(manifest.fixture_sha256, fixture.fixture_sha256);
  return manifest;
}

async function registerAssets(sourceDir, manifest) {
  const assetDir = await realpath(join(sourceDir, 'assets'));
  const paths = {};
  for (const [key, hash] of Object.entries(manifest.files).filter(([name]) => name.startsWith('assets/'))) {
    const path = await realpath(join(sourceDir, key));
    assert.equal(dirname(path), assetDir);
    const actual = createHash('sha256').update(await readFile(path)).digest('hex');
    assert.equal(actual, hash);
    paths[basename(key)] = path;
  }
  assert.equal(Object.keys(paths).length, 2);
  return paths;
}

export async function verifyPaperReopen(read, scope, pageId, canvas) {
  const call = (name, args = {}) => read({name, arguments: {...args, fileId: scope.fileId}});
  const info = await call('get_basic_info', {pageId});
  assert.equal(info.fileName, scope.fileName);
  assert.equal(info.pageId, pageId);
  assert.ok(info.artboards.some(board => board.id === canvas.boardId));
  const {styles} = await call('get_computed_styles', {nodeIds: Object.keys(canvas.nativeReadback.styles)});
  assert.deepEqual(styles, canvas.nativeReadback.styles, 'Paper native styles changed after normal editor reopen');
  const jsx = await call('get_jsx', {nodeId: canvas.boardId, format: 'inline-styles', includeNodeIds: true});
  assert.equal(jsx, canvas.nativeReadback.jsx, 'Paper editable subtree changed after normal editor reopen');
  return {pageId, boardId: canvas.boardId, styles, jsx};
}

export async function runPaperLD05(read, scope, fixture, output, runId, {nativeReopen = false} = {}) {
  assert.equal(scope.fileName, approvedCanvas);
  assert.equal(fixture.workload_id, 'LD05');
  assert.ok(['route-board', 'supply-ledger'].includes(fixture.source_family_id));
  assert.match(runId, /^[a-z0-9][a-z0-9-]{7,63}$/);
  const deadline = nativeReopen ? inheritedDeadline() : null;
  const sourceDir = join(output, 'source');
  const initial = sourceCommand('prepare', fixture, sourceDir);
  const assets = await registerAssets(sourceDir, initial);
  const name = `LD05 ${fixture.source_family_id} / ${runId}`;
  const call = (tool, args = {}) => read({name: tool, arguments: {...args, fileId: scope.fileId}});
  const home = await call('get_basic_info');
  assert.equal(home.fileName, approvedCanvas);
  assert.ok(!home.pages.some(page => page.name === name));
  let approved = home.artboards.some(board => board.name === 'CAP Editable Scene');
  for (const page of home.pages) {
    if (approved) break;
    approved = (await call('get_basic_info', {pageId: page.id})).artboards.some(board => board.name === 'CAP Editable Scene');
  }
  assert.ok(approved, 'Missing approved Paper canvas marker');
  await call('create_page', {name});
  const current = await call('get_basic_info');
  assert.equal(current.fileName, approvedCanvas);
  const pages = current.pages.filter(page => page.name === name);
  assert.equal(pages.length, 1);
  const [page] = pages;
  assert.ok(!home.pages.some(row => row.id === page.id));
  assert.deepEqual(current.pages.filter(row => row.id !== page.id), home.pages);
  const result = {fixture_sha256: fixture.fixture_sha256, starting_source_sha256: initial.source_sha256, cycles: []};
  let parent = initial;
  for (const [index, rules] of fixture.cycles.entries()) {
    const cycle = index + 1;
    const dir = join(output, 'cycle-' + cycle);
    await mkdir(dir, {mode: 0o700});
    const save = (filename, value) => writeFile(join(dir, filename), JSON.stringify(value, null, 2) + '\n',
      {mode: 0o600, flag: 'wx'});
    const patched = sourceCommand('patch', fixture, sourceDir, cycle);
    const before = await sourceProbe(sourceDir, fixture, patched, cycle, rules.source_state);
    const refreshBoundary = {registered_component: fixture.cycles[0].source_state.component,
      module_sha256: patched.files['card.mjs'], initial_module_sha256: initial.files['card.mjs'],
      app_source: await readFile(join(sourceDir, 'app.mjs'), 'utf8'),
      module_source: await readFile(join(sourceDir, 'card.mjs'), 'utf8')};
    const observedSource = normalizePaperSource(before, rules.source_state, refreshBoundary);
    await save('source-refresh-boundary.json', refreshBoundary);
    const content = paperLD05Markup(before.evaluatedHtml, before.states[0].styles, assets, cycle, observedSource);
    await save('source-before.json', before.states);
    const canvas = await paperLD05Cycle(read, scope, page.id, name + ' / cycle ' + cycle, content,
      rules.result, cycle, assets, save);
    let lifecycle;
    if (nativeReopen) {
      lifecycle = await awaitNativeReopen({output, runId, cycle, fileKey: scope.fileId, pageId: page.id,
        writtenAt: new Date().toISOString(), deadline});
      const reopened = await verifyPaperReopen(read, scope, page.id, canvas);
      assert.ok(performance.now() < deadline, 'Attempt deadline expired during Paper reopen readback');
      await save('native-reopened.json', {lifecycle, reopened});
    }
    const stylesheet = join(sourceDir, 'theme.css');
    const data = join(sourceDir, 'data.mjs');
    await writeFile(stylesheet, mergeStyles(await readFile(stylesheet, 'utf8'), cycle, canvas.observed));
    if (cycle === 3) {
      const {variant, asset, copy} = canvas.observed;
      await writeFile(data, mergeExtraCard(await readFile(data, 'utf8'), variant, asset, copy));
    }
    const merged = sourceCommand('manifest', fixture, sourceDir);
    const changed = Object.keys(merged.files).filter(key => patched.files[key] !== merged.files[key]);
    assert.deepEqual(changed, cycle === 3 ? ['theme.css', 'data.mjs'] : ['theme.css']);
    const clean = join(output, 'clean-' + cycle);
    for (const [name, hash] of Object.entries(merged.files)) {
      const destination = join(clean, name);
      await mkdir(dirname(destination), {recursive: true, mode: 0o700});
      await copyFile(join(sourceDir, name), destination);
      assert.equal(createHash('sha256').update(await readFile(destination)).digest('hex'), hash);
      if (name.endsWith('.mjs')) execFileSync(process.execPath, ['--check', destination]);
    }
    assert.equal(merged.files['card.mjs'], initial.files['card.mjs']);
    assert.equal(merged.files['app.mjs'], patched.files['app.mjs']);
    const after = await sourceProbe(clean, fixture, merged, cycle, rules.result);
    await save('source-after.json', after.states);
    const componentBoundary = {registered_component: fixture.cycles[0].source_state.component,
      module_sha256: merged.files['card.mjs'], initial_module_sha256: initial.files['card.mjs'],
      app_source: await readFile(join(clean, 'app.mjs'), 'utf8'),
      module_source: await readFile(join(clean, 'card.mjs'), 'utf8')};
    await save('source-component-boundary.json', componentBoundary);
    const record = {source_parent_sha256: parent.source_sha256, source_patch_sha256: patched.source_sha256,
      result_checkout_sha256: merged.source_sha256, canvas, checked_widths: after.states.map(row => row.width),
      refreshed_canvas: normalizePaperNative(canvas.refreshed, rules.source_state,
        Object.fromEntries(Object.entries(patched.files).filter(([name]) => name.startsWith('assets/')).map(([name, hash]) => [basename(name), hash]))),
      source_result: normalizePaperSource(after, rules.result, componentBoundary),
      ...(lifecycle ? {reopened_canvas: normalizePaperNative(canvas.edited, rules.result,
        Object.fromEntries(Object.entries(merged.files).filter(([name]) => name.startsWith('assets/')).map(([name, hash]) => [basename(name), hash])))} : {}),
      native_projection_scope: 'Editable source-state labels; source behavior executes only in the clean source browser',
      canvas_editable: true, clean_build: true,
      behavior_tests_passed: true, component_reused: true, no_missing_assets: true,
      ...(lifecycle ? {normal_editor_reopen: 'OBSERVED', editor_lifecycle: lifecycle} :
        {normal_editor_reopen: 'NOT_OBSERVED'})};
    result.cycles.push(record);
    await save('roundtrip-observations.json', record);
    parent = merged;
  }
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [fixtureFile, fileId, runId, option, ...extra] = process.argv.slice(2);
  assert.ok(fixtureFile && fileId && runId && process.env.OMC_BENCH_OUTPUT_DIR);
  assert.ok(!extra.length && (!option || option === '--native-reopen'));
  const fixture = JSON.parse(await readFile(resolve(fixtureFile), 'utf8'));
  const scope = {fileId, fileName: approvedCanvas};
  const result = await withPaper(scope, read => runPaperLD05(read, scope, fixture, process.env.OMC_BENCH_OUTPUT_DIR,
    runId, {nativeReopen: option === '--native-reopen'}));
  await writeFile(join(process.env.OMC_BENCH_OUTPUT_DIR, 'paper-roundtrip-diagnostic.json'), JSON.stringify(result),
    {mode: 0o600, flag: 'wx'});
  assert.ok(process.env.OMC_BENCH_CANDIDATE, 'Use run_attempt.py for common LD05 candidate publication');
  await publishCandidate(process.env.OMC_BENCH_CANDIDATE, result);
  console.log(JSON.stringify({cycles: result.cycles.length,
    normalReopenObserved: result.cycles.every(cycle => cycle.normal_editor_reopen === 'OBSERVED')}));
}
