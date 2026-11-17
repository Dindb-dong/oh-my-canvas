import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { withLD02Broker } from '../ld02-model.mjs';
import { withFigmaMCP } from './ld03-model.mjs';

const readSkill = 'resource:figma-use';
const writeSkills = readSkill + ',resource:figma-generate-design';
const phases = ['before', 'candidate', 'reopened', 'after_probe_original', 'copy_before', 'copy_edited', 'copy_undo', 'copy_redo'];

function payload(description, operation, input, write = false) {
  return { description, skillNames: write ? writeSkills : readSkill,
    code: `return await (${operation.toString()})(figma, ${JSON.stringify(input)});` };
}

async function createPages(figma, { fileKey, names }) {
  if (figma.fileKey !== fileKey || figma.root.children.length !== 1) throw new Error('Expected a fresh test file');
  const first = figma.root.children[0];
  await figma.setCurrentPageAsync(first);
  if (first.children.length) throw new Error('Expected an empty test file');
  first.name = names[0];
  const pages = [first];
  for (const name of names.slice(1)) {
    const page = figma.createPage();
    page.name = name;
    pages.push(page);
  }
  return { document_id: figma.fileKey, pages: pages.map(page => ({ id: page.id, name: page.name })) };
}

async function seedPage(figma, { fileKey, pageName, nodes }) {
  if (figma.fileKey !== fileKey) throw new Error('Unexpected test file');
  const pages = figma.root.children.filter(page => page.name === pageName);
  if (pages.length !== 1) throw new Error('Unexpected test page');
  const page = pages[0];
  await figma.setCurrentPageAsync(page);
  if (page.children.length) throw new Error('Expected an empty test page');
  const font = { family: 'Inter', style: 'Regular' };
  await figma.loadFontAsync(font);
  const made = new Map();
  for (const spec of nodes) {
    const parent = spec.parent == null ? page : made.get(spec.parent);
    if (!parent) throw new Error('Invalid fixture order');
    let node;
    if (spec.kind === 'frame') {
      node = figma.createFrame();
      node.clipsContent = false;
      if (spec.layout) {
        node.layoutMode = 'VERTICAL';
        node.primaryAxisSizingMode = 'FIXED';
        node.counterAxisSizingMode = 'FIXED';
        node.itemSpacing = spec.gap;
        node.paddingTop = node.paddingRight = node.paddingBottom = node.paddingLeft = spec.padding;
      }
    } else if (spec.kind === 'text') {
      node = figma.createText();
      node.fontName = font;
      node.fontSize = 13;
      node.textAutoResize = 'NONE';
      node.characters = spec.text;
    } else if (spec.kind === 'rectangle') {
      node = figma.createRectangle();
      node.cornerRadius = spec.radius;
    } else {
      throw new Error('Unknown fixture node kind');
    }
    if (spec.fill) {
      const [r, g, b] = [1, 3, 5].map(i => parseInt(spec.fill.slice(i, i + 2), 16) / 255);
      node.fills = [{ type: 'SOLID', color: { r, g, b } }];
    }
    node.name = spec.name;
    parent.appendChild(node);
    const [x, y, w, h] = spec.localBounds;
    node.resize(w, h);
    if (parent.type !== 'FRAME' || parent.layoutMode === 'NONE') {
      node.x = x;
      node.y = y;
    }
    made.set(spec.key, node);
  }
  page.selection = [];
  return { document_id: figma.fileKey, page_id: page.id, createdNodeIds: [...made.values()].map(node => node.id) };
}

async function inspect(figma, { fileKey, pageName, start, limit }) {
  if (figma.fileKey !== fileKey) throw new Error('Unexpected test file');
  const inventory = figma.root.children;
  if (pageName == null) {
    const styles = (await Promise.all([
      figma.variables.getLocalVariablesAsync(), figma.getLocalPaintStylesAsync(), figma.getLocalTextStylesAsync(),
      figma.getLocalEffectStylesAsync(), figma.getLocalGridStylesAsync(),
    ])).flat().map(style => ({ key: style.name, native_id: style.id }));
    return { document_id: figma.fileKey, pages: inventory.map(page => ({ id: page.id, name: page.name })), styles };
  }
  const pages = inventory.filter(page => page.name === pageName);
  if (pages.length !== 1) throw new Error('Unexpected test page');
  const page = pages[0];
  await figma.setCurrentPageAsync(page);
  const rows = [];
  function collect(parent, path, editable) {
    for (const [index, node] of parent.children.entries()) {
      const unlocked = editable && node.visible && !node.locked;
      const position = [...path, index];
      rows.push({ node, position, unlocked });
      if ('children' in node) collect(node, position, unlocked);
    }
  }
  collect(page, [], true);
  const hex = color => '#' + ['r', 'g', 'b'].map(channel =>
    Math.round(color[channel] * 255).toString(16).padStart(2, '0')).join('');
  const nodes = rows.slice(start, start + limit).map(({ node, position, unlocked }) => {
    const kind = node.type.toLowerCase();
    const bounds = node.absoluteBoundingBox;
    const row = { path: position, native_id: node.id, name: node.name, kind, editable: unlocked,
      order: position.at(-1), bounds: bounds && [bounds.x, bounds.y, bounds.width, bounds.height] };
    if (node.type === 'TEXT') {
      row.text = node.characters;
      row.editable = row.editable && !node.hasMissingFont;
    }
    if (['frame', 'text', 'rectangle'].includes(kind)) {
      row.bindings = node.boundVariables ?? {};
      if (node.fillStyleId) row.bindings = { ...row.bindings, fillStyle: true };
      if (node.type === 'TEXT' && node.textStyleId) row.bindings = { ...row.bindings, textStyle: true };
    }
    if (node.type === 'FRAME' || node.type === 'RECTANGLE') {
      const fills = node.fills;
      if (Array.isArray(fills) && fills.length === 1 && fills[0].type === 'SOLID' &&
          fills[0].visible !== false && (fills[0].opacity ?? 1) === 1) row.fill = hex(fills[0].color);
    }
    if (node.type === 'FRAME' && node.layoutMode !== 'NONE') {
      row.layout = node.layoutMode.toLowerCase();
      row.gap = node.itemSpacing;
      const padding = [node.paddingTop, node.paddingRight, node.paddingBottom, node.paddingLeft];
      row.padding = padding.every(value => value === padding[0]) ? padding[0] : padding;
    }
    if (node.type === 'RECTANGLE' && typeof node.cornerRadius === 'number') row.radius = node.cornerRadius;
    if (!['frame', 'text', 'rectangle'].includes(kind)) row.editable = false;
    return row;
  });
  return { document_id: figma.fileKey, page_id: page.id, page_name: page.name, start, count: rows.length,
    selected_native_ids: page.selection.map(node => node.id), nodes };
}

async function edit(figma, { fileKey, query, changes, native }) {
  if (figma.fileKey !== fileKey) throw new Error('Unexpected test file');
  const matches = [];
  for (const page of figma.root.children) {
    await figma.setCurrentPageAsync(page);
    for (const frame of page.findAll(node => node.type === 'FRAME' && node.name === query.name)) {
      if (frame.children.some(node => node.type === 'TEXT' && node.name === 'receipt' && node.characters === query.receipt)) {
        matches.push({ page, frame });
      }
    }
  }
  if (!changes && !matches.length) return null;
  if (matches.length !== 1) throw new Error('Semantic target did not match precisely one station');
  const [{ page, frame }] = matches;
  await figma.setCurrentPageAsync(page);
  const fields = {
    text: ['status', 'TEXT', 'characters'],
    gap: [null, 'FRAME', 'itemSpacing'],
    radius: ['marker', 'RECTANGLE', 'cornerRadius'],
  };
  const nodes = {};
  for (const [field, [name, type, prop]] of Object.entries(fields)) {
    const targets = name == null ? [frame] : frame.children.filter(node => node.type === type && node.name === name);
    const [node] = targets;
    if (targets.length !== 1 || !node.visible || node.locked || node.type !== type ||
        (native && (page.id !== native.page || node.id !== native[field]))) {
      throw new Error('Station identity differs for ' + field);
    }
    nodes[field] = { node, type, prop };
  }
  const read = () => ({ found: true, name: query.name, receipt: query.receipt,
    text: nodes.text.node.characters, gap_px: frame.itemSpacing, radius_px: nodes.radius.node.cornerRadius });
  if (!changes) return read();
  const operations = [];
  for (const change of changes) {
    const { node, type, prop } = nodes[change.field];
    if (node[prop] !== change.from) throw new Error('Starting edit state differs for ' + change.field);
    if (type === 'TEXT') {
      for (const { fontName } of node.getStyledTextSegments(['fontName'])) await figma.loadFontAsync(fontName);
    }
    operations.push({ node, prop, field: change.field, from: node[prop], value: change.to });
  }
  const writes = operations.map(({ node, prop, field, from, value }) => {
    node[prop] = value;
    return { native_id: node.id, field, from, to: node[prop] };
  });
  return { document_id: figma.fileKey, page_id: page.id, writes, ...(native ? { state: read() } : {}) };
}

function fixtureIndex(fixture) {
  assert.equal(fixture.schema, 'omc-local-dev/workload-fixture/1');
  assert.equal(fixture.workload, 'LD02');
  assert.equal(fixture.source_family_id, 'conservation-atlas');
  const byKey = new Map(fixture.start.nodes.map(node => [node.key, node]));
  const pages = new Map(fixture.start.pages.map(page => [page.name, { ...page, nodes: [], pathKeys: new Map() }]));
  const pageByKey = new Map([...pages.values()].map(page => [page.key, page]));
  const pathByKey = new Map();
  const counts = new Map();
  for (const node of fixture.start.nodes) {
    const page = pageByKey.get(node.page);
    const parentScope = node.parent ?? page.key;
    const index = counts.get(parentScope) ?? 0;
    counts.set(parentScope, index + 1);
    const path = [...(pathByKey.get(node.parent) ?? []), index];
    pathByKey.set(node.key, path);
    page.pathKeys.set(path.join('.'), node.key);
    const [x, y, w, h] = node.bounds;
    const parent = byKey.get(node.parent);
    page.nodes.push({ ...node, localBounds: [x - (parent?.bounds[0] ?? 0), y - (parent?.bounds[1] ?? 0), w, h] });
  }
  return { byKey, pages };
}

export function planAtlas(fixture, original, copy) {
  assert.match(original ?? '', /^[a-zA-Z0-9_-]{1,128}$/, 'Provide the approved original file key');
  if (copy != null) assert.match(copy, /^[a-zA-Z0-9_-]{1,128}$/, 'Provide the real verification copy file key');
  assert.notEqual(original, copy, 'The verification document must be distinct');
  const { byKey, pages } = fixtureIndex(fixture);
  const names = [...pages.keys()];
  const target = byKey.get(fixture.edit.find(change => change.field === 'gap').key);
  const query = { name: target.name, receipt: byKey.get(target.key + '/receipt').text };
  const changes = fixture.edit.map(({ field, from, to }) => ({ field, from, to }));
  const read = fileKey => ({
    inventory: payload('Read the real test file and native page inventory', inspect, { fileKey }),
    pages: names.flatMap(pageName => [0, 50].map(start => payload(
      `Read ${pageName} nodes at offset ${start}`, inspect, { fileKey, pageName, start, limit: 50 }))),
  });
  const change = fileKey => payload('Find the station by visible name and receipt, then edit its three properties',
    edit, { fileKey, query, changes }, true);
  return { fixture_sha256: fixture.fixture_sha256,
    createPages: payload('Create the ten synthetic pages in the approved file', createPages, { fileKey: original, names }, true),
    seedPages: names.map(pageName => payload(`Seed ${pageName}`, seedPage, { fileKey: original, pageName, nodes: pages.get(pageName).nodes }, true)),
    original: { read: read(original), edit: change(original) },
    copy: copy ? { read: read(copy), edit: change(copy) } : null };
}

function decode(envelope) {
  assert.notEqual(envelope?.isError, true, 'MCP call failed');
  assert.equal(envelope?.content?.length, 1, 'Missing native MCP result');
  assert.equal(envelope.content[0].type, 'text');
  return JSON.parse(envelope.content[0].text);
}

function snapshot(raw, fixturePages) {
  const inventory = decode(raw.inventory);
  assert.equal(typeof inventory.document_id, 'string', 'Missing native document identity');
  assert.equal(inventory.pages.length, fixturePages.size, 'Unexpected native page count');
  assert.deepEqual(inventory.pages.map(page => page.name), [...fixturePages.keys()], 'Unexpected native page order');
  const batches = raw.pages.map(decode);
  const pages = [];
  const nodes = [];
  const selection = [];
  let consumed = 0;
  for (const page of inventory.pages) {
    const spec = fixturePages.get(page.name);
    assert.ok(spec, 'Unexpected native page name');
    pages.push({ key: spec.key, name: page.name, native_id: page.id });
    const parts = batches.filter(item => item.page_id === page.id).sort((a, b) => a.start - b.start);
    assert.ok(parts.length === 2 || parts.length === 1 && parts[0].nodes.length === spec.nodes.length,
      'Missing page capture batches');
    consumed += parts.length;
    assert.ok(Array.isArray(parts[0].selected_native_ids), 'Missing native selection observation');
    let start = 0;
    for (const part of parts) {
      assert.equal(part.document_id, inventory.document_id, 'Mixed document captures');
      assert.equal(part.page_name, page.name, 'Mixed page captures');
      assert.equal(part.count, spec.nodes.length, 'Unexpected native layer count');
      assert.equal(part.start, start, 'Missing or overlapping native layer capture');
      assert.deepEqual(part.selected_native_ids, parts[0].selected_native_ids, 'Selection changed during capture');
      start += part.nodes.length;
      for (const { path, ...row } of part.nodes) {
        const key = spec.pathKeys.get(path.join('.'));
        assert.ok(key, 'Unexpected native layer path');
        const parent = path.length > 1 ? spec.pathKeys.get(path.slice(0, -1).join('.')) : null;
        assert.ok(parent || path.length === 1, 'Unexpected native parent');
        nodes.push({ ...row, key, parent, page: spec.key });
      }
    }
    assert.equal(start, spec.nodes.length, 'Incomplete native layer capture');
    selection.push(...parts[0].selected_native_ids);
  }
  assert.equal(batches.length, consumed, 'Additional unexpected capture batches');
  assert.ok(Array.isArray(inventory.styles), 'Missing native style inventory');
  return { document_id: inventory.document_id, pages, nodes, styles: inventory.styles, selected_native_ids: selection };
}

function mutations(raw, captured) {
  const byId = new Map(captured.nodes.map(node => [node.native_id, node]));
  return raw.flatMap(envelope => {
    const event = decode(envelope);
    assert.equal(event.document_id, captured.document_id, 'Write trace targeted a different file');
    const page = captured.pages.find(item => item.native_id === event.page_id);
    assert.ok(page, 'Write trace targeted a different page');
    return event.writes.map(({ native_id, ...change }) => {
      const node = byId.get(native_id);
      assert.ok(node && node.page === page.key, 'Write trace targeted an unobserved node');
      return { ...change, key: node.key };
    });
  });
}

export function atlasSnapshot(fixture, capture) {
  return snapshot(capture, fixtureIndex(fixture).pages);
}

export function atlasFullPageReads(plan) {
  assert.equal(plan.pages.length, 20);
  const pages = plan.pages.filter((_, index) => index % 2 === 0).map(row => {
    const code = row.code.replace(/,"start":0,"limit":50\}\);$/, ',"start":0,"limit":100});');
    assert.notEqual(code, row.code);
    return {...row, code};
  });
  return {inventory:plan.inventory, pages};
}

export function planAtlasReset(fixture, after) {
  const {byKey} = fixtureIndex(fixture);
  const target = byKey.get(fixture.edit.find(change => change.field === 'gap').key);
  const query = {name:target.name, receipt:byKey.get(target.key + '/receipt').text};
  const native = {page:after.pages.find(page => page.key === target.page)?.native_id};
  for (const {field, key, to} of fixture.edit) {
    const row = after.nodes.find(node => node.key === key);
    assert.ok(row && row.editable && row[field] === to, 'Reset requires the prior recorded edited values');
    native[field] = row.native_id;
  }
  assert.ok(Object.values(native).every(id => typeof id === 'string' && id.length));
  const changes = fixture.edit.map(({field, to, from}) => ({field, from:to, to:from}));
  return payload('Restore only the guarded Atlas fields in the approved synthetic Draft', edit,
    {fileKey:after.document_id, query, native, changes}, true);
}

// The trusted runner supplies an independently graded starting capture and the approved Draft.
export function figmaAtlasModelDriver(fixture, { fileKey, sessionId, before }, invoke, edits = []) {
  assert.match(fileKey ?? '', /^[A-Za-z0-9_-]{1,128}$/);
  assert.match(sessionId ?? '', /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i);
  const {byKey} = fixtureIndex(fixture);
  assert.equal(before.document_id, fileKey);
  const target = byKey.get(fixture.edit.find(change => change.field === 'gap').key);
  const query = {name: target.name, receipt: byKey.get(target.key + '/receipt').text};
  const native = {page: before.pages.find(page => page.key === target.page)?.native_id};
  for (const {field, key, from} of fixture.edit) {
    const row = before.nodes.find(node => node.key === key);
    assert.ok(row && row.editable && row[field] === from, `Wrong prepared edit value for ${field}`);
    native[field] = row.native_id;
  }
  assert.ok(Object.values(native).every(id => typeof id === 'string' && id.length));
  assert.equal(new Set(Object.values(native)).size, 4);
  let written = false;
  async function call(selector, values) {
    const changes = values ? fixture.edit.map(({field, from}) => ({field, from, to: values[field]})) : null;
    const pinned = selector.name === query.name && selector.receipt === query.receipt ? native : undefined;
    if (changes) {
      assert.ok(pinned && !written, 'Only one registered Figma Atlas edit is allowed');
      written = true;
    }
    const request = payload(changes ? 'Apply the scoped Atlas edit' : 'Find the station by name and receipt',
      edit, {fileKey, query: selector, changes, native: pinned}, Boolean(changes));
    const result = await invoke({...request, fileKey, sessionId});
    const observed = decode(result);
    if (!changes) return observed;
    assert.equal(observed.document_id, fileKey);
    assert.equal(observed.page_id, native.page);
    assert.deepEqual(observed.writes, changes.map(change => ({...change, native_id: native[change.field]})));
    edits.push(result);
    return observed.state;
  }
  return {query, find: selector => call(selector), edit: (selector, values) => call(selector, values)};
}

export function withOfficialFigmaAtlasModel(fixture, scope, socketPath, events, edits, run, options) {
  return withFigmaMCP((invoke) => withLD02Broker(socketPath,
    figmaAtlasModelDriver(fixture, scope, invoke, edits), events, run), options);
}

export function normalizeAtlas(fixture, raw) {
  const { pages } = fixtureIndex(fixture);
  const observed = Object.fromEntries(phases.map(phase => [phase, snapshot(raw[phase], pages)]));
  assert.notEqual(observed.before.document_id, observed.copy_before.document_id, 'Undo and redo require a distinct document');
  const originalEdits = mutations(raw.edit_trace, observed.before);
  const copyEdits = mutations(raw.copy_edit_trace, observed.copy_before);
  const compareWrite = (a, b) => a.key.localeCompare(b.key) || a.field.localeCompare(b.field);
  assert.deepEqual(copyEdits.sort(compareWrite), [...originalEdits].sort(compareWrite),
    'Verification copy replay differs from the original edit');
  const { reopened_at, closed_at, document_id } = raw.editor_lifecycle.reopen;
  assert.equal(document_id, observed.reopened.document_id, 'Normal reopen observation belongs to another document');
  assert.ok(Date.parse(closed_at) < Date.parse(reopened_at), 'Missing ordered normal editor close and reopen');
  const events = raw.editor_lifecycle.copy_history;
  assert.ok(Array.isArray(events) && events.length, 'Missing native editor history events');
  for (const [index, item] of events.entries()) {
    assert.equal(item.document_id, observed.copy_before.document_id, 'History observation belongs to another document');
    assert.ok(Number.isFinite(Date.parse(item.at)), 'Missing history observation timestamp');
    if (index) assert.ok(Date.parse(events[index - 1].at) < Date.parse(item.at), 'Out-of-order history observations');
  }
  const undo_count = events.filter(item => item.action === 'undo').length;
  const redo_count = events.filter(item => item.action === 'redo').length;
  assert.ok(undo_count > 0 && undo_count === redo_count &&
    events.every((item, i) => item.action === (i < undo_count ? 'undo' : 'redo')), 'Missing ordered native Undo and Redo');
  return { ...observed, edit: originalEdits, copy_history: { undo_count, redo_count } };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [command, fixturePath, target, copy, ...extra] = process.argv.slice(2);
  const read = path => JSON.parse(readFileSync(path, 'utf8'));
  if (command === 'plan' && fixturePath && target && !extra.length) {
    console.log(JSON.stringify(planAtlas(read(fixturePath), target, copy === '-' ? null : copy)));
  } else if (command === 'normalize' && fixturePath && target && copy === undefined) {
    console.log(JSON.stringify(normalizeAtlas(read(fixturePath), read(target))));
  } else {
    console.error('Usage: ld02-atlas.mjs plan FIXTURE ORIGINAL_KEY [COPY_KEY] | normalize FIXTURE RAW_OBSERVATIONS');
    process.exitCode = 2;
  }
}
