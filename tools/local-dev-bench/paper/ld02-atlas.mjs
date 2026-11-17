import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';

const approvedName = 'OMC Benchmark • Synthetic CAP Probe • 2026-11-17';
const escapes = {'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'};
const escape = value => value.replace(/[&<>"']/g, symbol => escapes[symbol]);
const callWith = (read, fileId) => (name, args = {}) => read({name, arguments: {...args, fileId}});
const kind = {Frame: 'frame', Text: 'text', Rectangle: 'rectangle'};
const readConcurrency = 16;

async function readBatches(items, read) {
  const results = [];
  for (let start = 0; start < items.length; start += readConcurrency) {
    const batch = await Promise.allSettled(items.slice(start, start + readConcurrency).map(read));
    const failed = batch.find(row => row.status === 'rejected');
    if (failed) throw failed.reason;
    results.push(...batch.map(row => row.value));
  }
  return results;
}
function atlasKind(row) {
  if (row.name === 'marker' && row.component === 'Frame' && row.childCount === 0) return 'rectangle';
  return kind[row.component];
}

function prepared(fixture) {
  assert.equal(fixture.workload, 'LD02');
  assert.equal(fixture.source_family_id, 'conservation-atlas');
  assert.equal(fixture.start.pages.length, 10);
  assert.equal(fixture.start.nodes.length, 1000);
  const nodes = new Map(fixture.start.nodes.map(row => [row.key, row]));
  assert.equal(nodes.size, 1000);
  const branches = Map.groupBy(fixture.start.nodes, row => row.parent ?? row.page);
  return {nodes, branches};
}

export function atlasPlan(fixture, source, runId) {
  assert.equal(source.name, approvedName);
  assert.match(source.fileId, /^[-\w]+$/);
  assert.match(runId, /^[a-z0-9][a-z0-9-]{7,31}$/);
  const {nodes, branches} = prepared(fixture);
  const prefix = `LD02 atlas ${runId} / `;
  function markup(row) {
    const [x, y, width, height] = row.bounds;
    const parent = nodes.get(row.parent);
    const styles = [`width:${width}px`,`height:${height}px`,'box-sizing:border-box','flex-shrink:0'];
    if (!parent || parent.kind === 'frame' && !parent.layout) {
      styles.push('position:absolute',`left:${x - (parent?.bounds[0] ?? 0)}px`,`top:${y - (parent?.bounds[1] ?? 0)}px`);
    }
    if (row.kind === 'frame') styles.push('display:flex','flex-direction:column');
    if (row.fill) styles.push(`background-color:${row.fill}`);
    if (row.layout) styles.push(`padding:${row.padding}px`,`gap:${row.gap}px`);
    if (row.radius !== undefined) styles.push(`border-radius:${row.radius}px`);
    if (row.kind === 'text') styles.push('font-family:Arial','font-size:13px',`line-height:${height}px`,'color:#172324');
    const content = row.kind === 'text' ? escape(row.text) : (branches.get(row.key) ?? []).map(markup).join('');
    return `<div layer-name="${escape(row.name)}" style="${styles.join(';')}">${content}</div>`;
  }

  const pages = fixture.start.pages.map(page => {
    const sourceZones = branches.get(page.key);
    assert.equal(sourceZones.length, 4);
    assert.equal(fixture.start.nodes.filter(row => row.page === page.key).length, 100);
    const name = prefix + page.name;
    const zoneArtboards = sourceZones.map(zone => {
      const [left, top, width, height] = zone.bounds;
      return {key: zone.key, name: zone.name, styles: {
        width: `${width}px`, height: `${height}px`, left: `${left}px`, top: `${top}px`,
        display: 'flex', flexDirection: 'column', backgroundColor: zone.fill,
      }, html: (branches.get(zone.key) ?? []).map(markup).join('')};
    });
    return {key: page.key, name, neutral_name: page.name, zoneFragments: sourceZones.map(markup), zoneArtboards,
      create: {name: 'create_page', arguments: {fileId: source.fileId, name}}};
  });
  return {fileId: source.fileId, fileName: source.name, prefix, logicalObjects: nodes.size, pages};
}

export async function seedAtlasPage(read, plan, page, pageId) {
  const call = callWith(read, plan.fileId);
  const before = await call('get_basic_info', {pageId});
  assert.equal(before.fileName, plan.fileName);
  assert.ok(before.rootNodeId);
  assert.deepEqual((await call('get_children', {nodeId: before.rootNodeId})).children, []);
  const working = new Set();
  try {
    for (const zone of page.zoneArtboards) {
      const response = await call('create_artboard', {pageId, name: zone.name, styles: zone.styles});
      assert.ok(!response.error && !response.errors?.length);
      const current = await call('get_basic_info', {pageId});
      assert.equal(current.fileName, plan.fileName);
      const matches = current.artboards.filter(row => row.name === zone.name);
      assert.equal(matches.length, 1);
      const [board] = matches;
      assert.ok(board.id && !working.has(board.id));
      assert.equal(board.width, Number.parseFloat(zone.styles.width));
      assert.equal(board.height, Number.parseFloat(zone.styles.height));
      working.add(board.id);
      const written = await call('write_html', {targetNodeId: board.id, mode: 'insert-children', html: zone.html});
      assert.ok(!written.error && !written.errors?.length && written.createdNodes?.length);
    }
    const positioning = await call('update_styles', {updates: page.zoneArtboards.map((zone, index) => ({
      nodeIds: [[...working][index]], styles: {left: zone.styles.left, top: zone.styles.top},
    }))});
    const positioned = positioning.updates ?? positioning.results ?? [];
    assert.ok(positioned.every(row => !row.error && !Object.keys(row.ignoredStyles ?? {}).length),
      'Paper ignored registered artboard positions');
    const complete = await call('get_basic_info', {pageId});
    assert.equal(complete.artboards.length, 4);
    for (const zone of page.zoneArtboards) {
      const board = complete.artboards.find(row => row.name === zone.name);
      assert.equal(board.worldX, Number.parseFloat(zone.styles.left));
      assert.equal(board.worldY, Number.parseFloat(zone.styles.top));
    }
    assert.deepEqual(new Set(complete.artboards.map(row => row.id)), working);
  } finally {
    if (working.size) await call('finish_working_on_nodes', {nodeIds: [...working]});
  }
}

async function pageInventory(call, plan) {
  const home = await call('get_basic_info');
  assert.equal(home.fileName, plan.fileName, 'Unexpected Paper canvas');
  const confirmed = home.pages.filter(row => row.name.startsWith(plan.prefix));
  assert.equal(confirmed.length, 10, 'The run requires ten prepared pages');
  assert.equal(new Set(confirmed.map(row => row.id)).size, 10);
  return plan.pages.map(spec => {
    const matching = confirmed.filter(row => row.name === spec.name);
    assert.equal(matching.length, 1, 'Unexpected or duplicate run page');
    return {key: spec.key, name: spec.neutral_name, native_id: matching[0].id};
  });
}

async function discoverAtlasStation(read, plan, {title, receipt}) {
  const call = callWith(read, plan.fileId);
  const pages = await pageInventory(call, plan);
  const hits = await readBatches(pages.flatMap(page => [title, receipt].map(textValue => ({page, textValue}))),
    ({page, textValue}) => call('find_nodes', {pageId: page.native_id, textValue}));
  const candidates = [];
  for (const [index, page] of pages.entries()) {
    const [titles, receipts] = hits.slice(index * 2, index * 2 + 2);
    if (!titles.nodes.length || !receipts.nodes.length) continue;
    const details = rows => readBatches(rows, ({id}) => call('get_node_info', {nodeId: id}));
    const named = (await details(titles.nodes)).filter(row => row.component === 'Text' && row.textContent === title);
    const coded = (await details(receipts.nodes)).filter(row => row.component === 'Text' && row.textContent === receipt);
    for (const text of named) {
      const code = coded.filter(row => row.parentId === text.parentId);
      if (code.length === 1) candidates.push({section: {id: text.parentId, pageId: page.native_id},
        titleId: text.id, receiptId: code[0].id});
    }
  }
  if (!candidates.length) return null;
  assert.equal(candidates.length, 1, 'A unique title and receipt match is required');
  const [{section, titleId, receiptId}] = candidates;
  const station = await call('get_node_info', {nodeId: section.id});
  assert.equal(station.component, 'Frame');
  assert.equal(station.name, title);
  assert.equal(station.childCount, 5);
  const {children} = await call('get_children', {nodeId: section.id});
  const status = children.filter(row => row.name === 'status' && row.component === 'Text');
  const marker = children.filter(row => row.name === 'marker' && atlasKind(row) === 'rectangle');
  assert.equal(status.length, 1);
  assert.equal(marker.length, 1);
  return {section, titleId, receiptId, status: status[0].id, marker: marker[0].id};
}

function atlasEditRequests(plan, {section, status, marker}, values) {
  return [
      {name: 'set_text_content', arguments: {fileId: plan.fileId, updates: [{nodeId: status, html: escape(values.text)}]}},
      {name: 'update_styles', arguments: {fileId: plan.fileId, updates: [
        {nodeIds: [section.id], styles: {gap: `${values.gap}px`}},
        {nodeIds: [marker], styles: {borderRadius: `${values.radius}px`}},
      ]}},
  ];
}

export async function discoverAtlasEdit(read, plan, brief) {
  assert.ok(brief.title && brief.receipt && brief.status && Number.isInteger(brief.gap) && Number.isInteger(brief.radius));
  const station = await discoverAtlasStation(read, plan, brief);
  assert.ok(station, 'A unique title and receipt match is required');
  const {section, status, marker} = station;
  return {section, status, marker, requests: atlasEditRequests(plan, station, {...brief, text: brief.status})};
}

function px(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^-?\d+(\.\d+)?px$/.test(value)) return Number.parseFloat(value);
  return null;
}

export function paperAtlasModelHandlers(read, plan, fixture) {
  const {nodes, branches} = prepared(fixture);
  const expected = fixture.edit.find(row => row.field === 'gap');
  const parts = branches.get(expected.key);
  const query = {name: nodes.get(expected.key).name, receipt: parts.find(row => row.name === 'receipt').text};
  const starting = Object.fromEntries(fixture.edit.map(({field, from}) => [field, from]));
  const call = callWith(read, plan.fileId);
  let target;

  async function observe(station) {
    const {section, status, marker, titleId, receiptId} = station;
    const [frame, title, receipt, text, image, styles] = await Promise.all([
      ...[section.id, titleId, receiptId, status, marker].map(nodeId => call('get_node_info', {nodeId})),
      call('get_computed_styles', {nodeIds: [section.id, marker]}),
    ]);
    assert.equal(frame.id, section.id);
    assert.deepEqual([title.id, receipt.id, text.id, image.id], [titleId, receiptId, status, marker]);
    assert.ok([title, receipt, text, image].every(node => node.parentId === section.id && frame.childIds.includes(node.id)));
    assert.ok([frame, text, image].every(node => node.isLocked === false && node.isVisible === true));
    assert.ok(title.component === 'Text' && receipt.component === 'Text' && text.component === 'Text' && atlasKind(image) === 'rectangle');
    return {name: title.textContent, receipt: receipt.textContent, text: text.textContent,
      gap_px: px(styles.styles[section.id]?.gap), radius_px: px(styles.styles[marker]?.borderRadius)};
  }

  return {
    query,
    async find(selector) {
      const station = await discoverAtlasStation(read, plan, {title: selector.name, receipt: selector.receipt});
      if (!station) return null;
      const state = await observe(station);
      assert.equal(state.name, selector.name);
      assert.equal(state.receipt, selector.receipt);
      if (selector.name === query.name && selector.receipt === query.receipt) target = station;
      return state;
    },
    async edit(selector, values) {
      assert.deepEqual(selector, query);
      assert.ok(target, 'No live Paper target');
      const pages = await pageInventory(call, plan);
      assert.equal(pages.find(page => page.key === fixture.working_page)?.native_id, target.section.pageId);
      assert.deepEqual(await observe(target), {...query, text: starting.text,
        gap_px: starting.gap, radius_px: starting.radius}, 'Paper target changed before write');
      try {
        for (const request of atlasEditRequests(plan, target, values)) {
          const response = await read(request);
          const rows = response?.updates ?? response?.results ?? [];
          assert.ok(response && !response.error && !response.errors?.length && rows.every(row =>
            !row.error && row.result !== 'error' && !Object.keys(row.ignoredStyles ?? {}).length),
          `Paper ${request.name} recorded an in-band error`);
        }
        return await observe(target);
      } finally {
        await call('finish_working_on_nodes', {nodeIds: [target.section.id, target.status, target.marker]});
      }
    },
  };
}

export async function captureAtlas(read, fixture, plan) {
  const {branches} = prepared(fixture);
  const call = callWith(read, plan.fileId);
  const pages = await pageInventory(call, plan);
  const selection = await call('get_selection');
  assert.equal(selection.count, selection.selectedNodes.length);
  const nodes = [];
  const missingBounds = [];
  const raw = await readBatches(pages, async page => {
    const info = await call('get_basic_info', {pageId: page.native_id});
    assert.equal(info.fileName, plan.fileName);
    assert.ok(typeof info.rootNodeId === 'string' && info.rootNodeId);
    const {children} = await call('get_children', {nodeId: info.rootNodeId});
    return {page, info, rootIds: children.map(({id}) => id), entries: [], computed: {}};
  });

  const observedIds = new Set();
  let frontier = raw.map(state => ({state, parentId: state.info.rootNodeId,
    logicalParent: null, specs: branches.get(state.page.key), ids: state.rootIds}));
  while (frontier.length) {
    const requests = frontier.flatMap(group => {
      assert.equal(group.ids.length, group.specs.length, 'Incomplete or extra children in Paper page');
      return group.ids.map(id => ({group, id}));
    });
    const details = new Map(await readBatches(requests, async ({group, id}) => {
      assert.ok(!observedIds.has(id), 'Duplicate Paper layer ID');
      observedIds.add(id);
      const layer = await call('get_node_info', {nodeId: id});
      assert.equal(layer.id, id);
      assert.equal(layer.parentId, group.parentId);
      assert.ok(Array.isArray(layer.childIds));
      assert.equal(layer.childCount, layer.childIds.length);
      return [id, layer];
    }));
    frontier = frontier.flatMap(({state, logicalParent, specs, ids}) => {
      const siblings = ids.map(id => details.get(id));
      return specs.flatMap(spec => {
        const matches = siblings.filter(layer => layer.name === spec.name && atlasKind(layer) === spec.kind);
        assert.equal(matches.length, 1, `Unidentified or replaced layer ${spec.key}`);
        const [layer] = matches;
        const children = branches.get(spec.key) ?? [];
        assert.equal(layer.childIds.length, children.length);
        state.entries.push({layer, spec, logicalParent, order: siblings.indexOf(layer)});
        return children.length ? [{state, parentId: layer.id, logicalParent: spec.key,
          specs: children, ids: layer.childIds}] : [];
      });
    });
  }

  const styleBatches = raw.flatMap(state => {
    assert.equal(state.entries.length, 100);
    const nodeIds = state.entries.map(({layer}) => layer.id);
    return Array.from({length: Math.ceil(nodeIds.length / 25)}, (_, batch) =>
      ({state, ids: nodeIds.slice(batch * 25, (batch + 1) * 25)}));
  });
  await readBatches(styleBatches, async ({state, ids}) => {
    const {styles} = await call('get_computed_styles', {nodeIds: ids});
    Object.assign(state.computed, styles);
  });
  for (const {page, entries, computed} of raw) {
    for (const {layer,spec,logicalParent,order} of entries) {
      const {id} = layer;
      const css = computed[id];
      assert.ok(css, `Missing native computed style for ${spec.key}`);
      if (spec.kind === 'rectangle') {
        assert.match(css.backgroundColor ?? '', /^#[0-9a-f]{6}$/i);
        assert.notEqual(px(css.borderRadius), null, `Missing native radius for ${spec.key}`);
      }
      const bounds = [layer.worldX,layer.worldY,layer.width,layer.height];
      const hasBounds = bounds.every(value => typeof value === 'number' && Number.isFinite(value));
      if (!hasBounds) missingBounds.push(spec.key);
      nodes.push({
        key: spec.key, native_id: id, name: layer.name, page: page.key, parent: logicalParent,
        kind: atlasKind(layer), native_type: layer.component, editable: layer.isLocked === false && layer.isVisible === true, bounds: hasBounds ? bounds : null,
        ...(spec.order === undefined ? {} : {order}),
        ...(spec.text === undefined ? {} : {text: layer.textContent}),
        ...(spec.fill === undefined ? {} : {fill: css.backgroundColor?.toLowerCase()}),
        ...(spec.layout === undefined ? {} : {
          layout: css.display === 'flex' && css.flexDirection === 'column' ? 'vertical' : null,
          padding: px(css.padding), gap: px(css.gap),
        }),
        ...(spec.radius === undefined ? {} : {radius: px(css.borderRadius)}),
      });
    }
  }
  return {raw: raw.map(({page, info, entries, computed}) => ({page, info, computed,
    nodes: entries.map(({layer}) => layer)})), missingBounds, snapshot: {
    document_id: plan.fileId, pages, nodes: nodes.sort((a,b) => a.key.localeCompare(b.key)), styles: [],
    selected_native_ids: selection.selectedNodes.map(row => row.id),
  }};
}

export function checkProtectedAtlas(fixture, before, after) {
  assert.equal(before.document_id, after.document_id);
  assert.deepEqual(before.selected_native_ids, [], 'Starting selection was not empty');
  assert.deepEqual(before.pages, after.pages);
  const editableFields = new Map(fixture.edit.map(row => [row.key, row.field]));
  const station = fixture.edit.find(edit => edit.field === 'gap').key;
  const strip = node => {
    const copy = {...node};
    delete copy[editableFields.get(node.key)];
    if (node.parent === station) delete copy.bounds;
    return copy;
  };
  assert.equal(before.nodes.length, 1000);
  assert.equal(after.nodes.length, 1000);
  assert.deepEqual(before.nodes.map(strip), after.nodes.map(strip), 'Protected native content or identity changed');
  return fixture.edit.map(({key, field, from: expectedBefore, to: expectedAfter}) => {
    const from = before.nodes.find(row => row.key === key)?.[field];
    const to = after.nodes.find(row => row.key === key)?.[field];
    assert.equal(from, expectedBefore);
    assert.equal(to, expectedAfter);
    return {key, field, from, to};
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [fixture, source, runId] = process.argv.slice(2);
  assert.ok(fixture && source && runId, 'Usage: ld02-atlas.mjs FIXTURE.json APPROVED_FILE.json RUN_ID');
  const load = file => JSON.parse(readFileSync(file, 'utf8'));
  console.log(JSON.stringify(atlasPlan(load(fixture),load(source),runId)));
}
