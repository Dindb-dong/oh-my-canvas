import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { inspect, mutate, seed } from './plugin.mjs';

const readSkill = 'resource:figma-use';
const nodeChunk = 24;
const imageChunk = 4096;
const maxCodeLength = 50_000;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

function payload(description, operation, input, write = false) {
  const code = `return await (${operation.toString()})(figma, ${JSON.stringify(input)});`;
  assert.ok(code.length <= maxCodeLength, `${description} exceeds Figma MCP's ${maxCodeLength}-character code limit`);
  return {
    description,
    code,
    skillNames: write ? `${readSkill},resource:figma-generate-design` : readSkill,
  };
}

function verifyFixture(fixture) {
  assert.equal(fixture.schema, 'omc-local-dev/workload-fixture/1');
  assert.ok(['LD01', 'LD03'].includes(fixture.workload), 'Expected LD01 or LD03');
}

const nativeStyleName = key => key.replaceAll('.', '/');

function logicalStyleKeys(styles) {
  const names = new Map(styles.map(({ key }) => [nativeStyleName(key), key]));
  assert.equal(names.size, styles.length, 'Figma variable names collide');
  return names;
}

function plannedNodes(workload, start) {
  const byKey = new Map(start.nodes.map(node => [node.key, node]));
  const children = new Map();
  return start.nodes.map(node => {
    const parent = byKey.get(node.parent);
    const index = children.get(node.parent) ?? 0;
    children.set(node.parent, index + 1);
    const flows = parent?.layout !== undefined;
    let localBounds;
    if (workload === 'LD01') {
      const [x, y, width, height] = node.bounds;
      localBounds = [x - (parent?.bounds[0] ?? 0), y - (parent?.bounds[1] ?? 0), width, height];
    } else if (node.key === 'board') {
      localBounds = [0, 0, 1440, 1710];
    } else if (node.kind === 'text') {
      localBounds = [12, 8 + index * 24, flows ? 124 : 300, 24];
    } else if (node.layout) {
      localBounds = [12 + (index - 1) % 2 * 158, 40 + Math.floor((index - 1) / 2) * 100, 148, 88];
    } else if (node.key.startsWith('board/')) {
      localBounds = [12, (index - 1) * 550 + 48, 1416, 546];
    } else if (node.key === 'keep' && byKey.has('board/editorial')) {
      localBounds = [12, 1150, 336, 520];
    } else {
      const slot = parent?.key === 'board' ? index - 1 : index;
      localBounds = [12 + slot % 4 * 348, 44 + Math.floor(slot / 4) * 526, 336, 520];
    }
    const { key, kind, parent: parentKey, layout, gap, fill, bindings, font_size, text, asset_rgba_sha256 } = node;
    return { key, kind, parent: parentKey, layout, gap, fill, bindings, font_size, text, asset_rgba_sha256, localBounds,
      flows: flows || undefined, lightText: (kind === 'text' && Boolean(parent?.fill)) || undefined };
  });
}

export function makePlan(fixture, original, copy, assetsDir) {
  verifyFixture(fixture);
  assert.match(original ?? '', /^[a-zA-Z0-9_-]{1,128}$/, 'Provide the exact approved original Figma file key');
  if (copy != null) {
    assert.match(copy, /^[a-zA-Z0-9_-]{1,128}$/, 'Provide the exact disposable verification copy Figma file key');
  }
  assert.notEqual(original, copy, 'Verification edits must target a separate copy');
  const initial = fixture.workload === 'LD01' ? fixture.expected : fixture.start;
  for (const state of [initial, fixture.expected, fixture.probe]) logicalStyleKeys(state.styles);
  const assets = fixture.assets.map(asset => {
    assert.ok(assetsDir && /^[a-zA-Z0-9_.-]+\.png$/.test(asset.name), 'Provide the generated fixture asset directory');
    const bytes = readFileSync(join(assetsDir, asset.name));
    assert.equal(sha256(bytes), asset.sha256, `Wrong fixture bytes for ${asset.name}`);
    return { asset, base64: bytes.toString('base64') };
  });
  const images = new Map(assets.map(({ asset, base64 }) => [asset.rgba_sha256, base64]));
  const styles = fixture.workload === 'LD03' ? fixture.expected.styles.filter((style, index) =>
    style.value !== initial.styles[index].value) : [];
  const mutation = action => action.op === 'set_style' ? { ...action, name: nativeStyleName(action.key) } : action;
  const candidate = payload(`Create named editable ${fixture.workload} fixture layers`, seed,
    { fileKey: original, nodes: plannedNodes(fixture.workload, initial),
      styles: initial.styles.map(style => ({ ...style, name: nativeStyleName(style.key) })), images: [...images] }, true);
  const commit = styles.length ? payload('Update the existing shared accent and spacing variables', mutate,
    { fileKey: original, actions: styles.map(({ key, value }) => mutation({ op: 'set_style', key, value })) }, true) : null;

  const capture = (fileKey, state) => ({
    header: payload('Read Figma identity, actual layer count and shared variable values', inspect, { fileKey, styles: true }),
    nodes: Array.from({ length: Math.ceil(state.nodes.length / nodeChunk) }, (_, index) =>
      payload(`Read Figma layer properties, batch ${index + 1}`, inspect,
        { fileKey, offset: index * nodeChunk, limit: nodeChunk })),
    images: state.nodes.filter(node => node.kind === 'image').flatMap(({ key, asset_rgba_sha256 }) => {
      const length = images.get(asset_rgba_sha256).length;
      return Array.from({ length: Math.ceil(length / imageChunk) }, (_, index) =>
        payload(`Read stored bytes for ${key}, part ${index + 1}`, inspect,
          { fileKey, image: key, offset: index * imageChunk, limit: imageChunk }));
    }),
  });

  return {
    workload: fixture.workload,
    fixture_sha256: fixture.fixture_sha256,
    setup: fixture.workload === 'LD03' ? candidate : null,
    candidate: commit ?? candidate,
    probe: copy ? payload('Apply registered independent verification edits to the disposable Figma copy', mutate,
      { fileKey: copy, actions: fixture.probe_actions.map(mutation) }, true) : null,
    captures: {
      before: capture(original, fixture.start),
      candidate: capture(original, fixture.expected),
      reopened: capture(original, fixture.expected),
      probe: copy ? capture(copy, fixture.probe) : null,
      after_probe_original: capture(original, fixture.expected),
    },
  };
}

function decode(response) {
  assert.notEqual(response?.isError, true, 'Figma MCP returned an error');
  assert.equal(response?.content?.length, 1, 'Expected one Figma result block');
  assert.equal(response.content[0].type, 'text', 'Expected a Figma text result');
  return JSON.parse(response.content[0].text);
}

function concat(parts, field) {
  const ordered = parts.slice().sort((a, b) => a.offset - b.offset);
  let offset = 0;
  for (const part of ordered) {
    assert.equal(part.offset, offset, 'Missing or overlapping MCP captures');
    offset += part[field].length;
  }
  return ordered.flatMap(part => part[field]);
}

function normalizeSnapshot(raw, assets, keys) {
  const { document_id, page_id, node_count, styles } = decode(raw.header);
  assert.equal(typeof document_id, 'string', 'Missing Figma file identity');
  assert.equal(typeof page_id, 'string', 'Missing Figma page identity');
  function scoped(fragment) {
    const row = decode(fragment);
    assert.equal(row.document_id, document_id, 'Mixed file captures');
    assert.equal(row.page_id, page_id, 'Mixed page captures');
    return row;
  }

  const nodes = concat(raw.nodes.map(scoped), 'nodes');
  assert.equal(nodes.length, node_count, 'Missing Figma layer captures');
  const parts = raw.images.map(scoped);
  for (const row of nodes) {
    if (row.kind !== 'image') continue;
    const chunks = parts.filter(part => part.native_id === row.native_id && part.key === row.key && part.hash === row.image_hash);
    assert.ok(chunks.length, `Missing the observed bytes for image ${row.key}`);
    const base64 = concat(chunks, 'base64').join('');
    assert.ok(chunks.every(chunk => chunk.length === base64.length), `Incomplete bytes for image ${row.key}`);
    const bytes = Buffer.from(base64, 'base64');
    assert.equal(bytes.toString('base64'), base64, `Invalid base64 for image ${row.key}`);
    const match = assets.find(asset => asset.sha256 === sha256(bytes));
    assert.ok(match, `Stored image bytes do not match a fixture PNG for ${row.key}`);
    row.asset_rgba_sha256 = match.rgba_sha256;
  }
  return { document_id, nodes, styles: styles.map(style => ({ ...style, key: keys.get(style.key) ?? style.key })) };
}

export function normalizeEvidence(fixture, raw) {
  verifyFixture(fixture);
  const phases = ['before', 'candidate', 'reopened', 'probe', 'after_probe_original'];
  const keys = logicalStyleKeys(fixture.expected.styles);
  const evidence = Object.fromEntries(phases.map(phase => [phase, normalizeSnapshot(raw[phase], fixture.assets, keys)]));
  const probe = decode(raw.probe_actions);
  assert.equal(probe.document_id, evidence.probe.document_id, 'Probe actions targeted a different file');
  assert.equal(probe.actions.length, probe.mutatedNativeIds.length, 'Missing observed mutation IDs');
  const actions = probe.actions.map(action => action.op === 'set_style' ? { ...action, key: keys.get(action.key) ?? action.key } : action);
  for (const [index, action] of actions.entries()) {
    const rows = action.op === 'set_style' ? evidence.probe.styles : evidence.probe.nodes;
    assert.equal(rows.find(row => row.key === action.key)?.native_id, probe.mutatedNativeIds[index],
      'Probe action targeted a different object');
  }
  return { ...evidence, probe_actions: actions };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [command, fixturePath, first, second, third, ...extra] = process.argv.slice(2);
  const read = path => JSON.parse(readFileSync(path, 'utf8'));
  if (command === 'plan' && fixturePath && first && second && !extra.length) {
    console.log(JSON.stringify(makePlan(read(fixturePath), first, second === '-' ? null : second, third)));
  } else if (command === 'normalize' && fixturePath && first && second === undefined) {
    console.log(JSON.stringify(normalizeEvidence(read(fixturePath), read(first))));
  } else {
    console.error('Usage: adapter.mjs plan FIXTURE ORIGINAL_FILE_KEY COPY_FILE_KEY_OR_DASH [ASSETS_DIR] | normalize FIXTURE CAPTURES');
    process.exitCode = 2;
  }
}
