import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';

const approvedName = 'OMC Benchmark • Synthetic CAP Probe • 2026-11-17';
const escapes = {'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'};
const escape = value => value.replace(/[&<>"']/g, symbol => escapes[symbol]);
const callWith = (read, fileId) => (name, args = {}) => read({name, arguments: {...args, fileId}});
const kind = {Frame: 'frame', Text: 'text', Rectangle: 'rectangle'};

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
    return {key: page.key, name, neutral_name: page.name, zoneFragments: sourceZones.map(markup),
      create: {name: 'create_page', arguments: {fileId: source.fileId, name}}};
  });
  return {fileId: source.fileId, fileName: source.name, prefix, logicalObjects: nodes.size, pages};
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

export async function discoverAtlasEdit(read, plan, brief) {
  assert.ok(brief.title && brief.receipt && brief.status && Number.isInteger(brief.gap) && Number.isInteger(brief.radius));
  const call = callWith(read, plan.fileId);
  const pages = await pageInventory(call, plan);
  const candidates = [];
  for (const page of pages) {
    const [titles, receipts] = await Promise.all([brief.title, brief.receipt].map(textValue =>
      call('find_nodes', {pageId: page.native_id, textValue})));
    if (!titles.nodes.length || !receipts.nodes.length) continue;
    const details = async rows => await Promise.all(rows.map(({id}) => call('get_node_info', {nodeId: id})));
    const named = (await details(titles.nodes)).filter(row => row.component === 'Text' && row.textContent === brief.title);
    const coded = (await details(receipts.nodes)).filter(row => row.component === 'Text' && row.textContent === brief.receipt);
    for (const text of named) {
      if (coded.some(row => row.parentId === text.parentId)) candidates.push({id: text.parentId, pageId: page.native_id});
    }
  }
  assert.equal(candidates.length, 1, 'A unique title and receipt match is required');
  const [section] = candidates;
  const station = await call('get_node_info', {nodeId: section.id});
  assert.equal(station.component, 'Frame');
  assert.equal(station.name, brief.title);
  assert.equal(station.childCount, 5);
  const {children} = await call('get_children', {nodeId: section.id});
  const status = children.filter(row => row.name === 'status' && row.component === 'Text');
  const marker = children.filter(row => row.name === 'marker' && row.component === 'Rectangle');
  assert.equal(status.length, 1);
  assert.equal(marker.length, 1);
  return {
    section, status: status[0].id, marker: marker[0].id,
    requests: [
      {name: 'set_text_content', arguments: {fileId: plan.fileId, updates: [{nodeId: status[0].id, html: escape(brief.status)}]}},
      {name: 'update_styles', arguments: {fileId: plan.fileId, updates: [
        {nodeIds: [section.id], styles: {gap: `${brief.gap}px`}},
        {nodeIds: [marker[0].id], styles: {borderRadius: `${brief.radius}px`}},
      ]}},
    ],
  };
}

function px(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^-?\d+(\.\d+)?px$/.test(value)) return Number.parseFloat(value);
  return null;
}

export async function captureAtlas(read, fixture, plan) {
  const {branches} = prepared(fixture);
  const call = callWith(read, plan.fileId);
  const pages = await pageInventory(call, plan);
  const selection = await call('get_selection');
  assert.equal(selection.count, selection.selectedNodes.length);
  const nodes = [];
  const raw = [];
  const missingBounds = [];
  for (const page of pages) {
    const info = await call('get_basic_info', {pageId: page.native_id});
    assert.equal(info.fileName, plan.fileName);
    assert.ok(typeof info.rootNodeId === 'string' && info.rootNodeId);
    const observed = new Map();
    async function descend(parentId, logicalParent, siblingSpecs) {
      if (!siblingSpecs.length) return;
      const {children} = await call('get_children', {nodeId: parentId});
      assert.equal(children.length, siblingSpecs.length, 'Incomplete or extra children in Paper page');
      const matches = await Promise.all(siblingSpecs.map(async spec => {
        const matching = children.filter(row => row.name === spec.name && kind[row.component] === spec.kind);
        assert.equal(matching.length, 1, `Unidentified or replaced layer ${spec.key}`);
        const layer = await call('get_node_info', {nodeId: matching[0].id});
        assert.equal(layer.id, matching[0].id);
        assert.equal(layer.parentId, parentId);
        assert.equal(layer.childCount, (branches.get(spec.key) ?? []).length);
        assert.ok(!observed.has(layer.id));
        observed.set(layer.id, {layer, spec, logicalParent, order: children.indexOf(matching[0])});
        return {layer, spec};
      }));
      for (const {layer, spec} of matches) await descend(layer.id, spec.key, branches.get(spec.key) ?? []);
    }
    await descend(info.rootNodeId, null, branches.get(page.key));
    assert.equal(observed.size, 100);
    const computed = {};
    const ids = [...observed.keys()];
    for (let offset = 0; offset < ids.length; offset += 25) {
      Object.assign(computed, (await call('get_computed_styles', {nodeIds: ids.slice(offset, offset + 25)})).styles);
    }
    for (const [id,{layer,spec,logicalParent,order}] of observed) {
      const css = computed[id];
      assert.ok(css, `Missing native computed style for ${spec.key}`);
      const bounds = [layer.worldX,layer.worldY,layer.width,layer.height];
      const hasBounds = bounds.every(value => typeof value === 'number' && Number.isFinite(value));
      if (!hasBounds) missingBounds.push(spec.key);
      nodes.push({
        key: spec.key, native_id: id, name: layer.name, page: page.key, parent: logicalParent,
        kind: kind[layer.component], editable: layer.isLocked === false && layer.isVisible === true, bounds: hasBounds ? bounds : null,
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
    raw.push({page, info, nodes: [...observed.values()].map(item => item.layer), computed});
  }
  return {raw, missingBounds, snapshot: {
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
  for (const edit of fixture.edit) {
    assert.equal(before.nodes.find(row => row.key === edit.key)?.[edit.field], edit.from);
    assert.equal(after.nodes.find(row => row.key === edit.key)?.[edit.field], edit.to);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [fixture, source, runId] = process.argv.slice(2);
  assert.ok(fixture && source && runId, 'Usage: ld02-atlas.mjs FIXTURE.json APPROVED_FILE.json RUN_ID');
  const load = file => JSON.parse(readFileSync(file, 'utf8'));
  console.log(JSON.stringify(atlasPlan(load(fixture),load(source),runId)));
}
