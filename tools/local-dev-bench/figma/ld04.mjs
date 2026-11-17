import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { seed } from './plugin.mjs';

const skill = 'resource:figma-use';

function payload(description, operation, input, write = false) {
  const code = `return await (${operation.toString()})(figma, ${JSON.stringify(input)});`;
  assert.ok(code.length <= 50_000);
  return { description, code, skillNames: write ? skill + ',resource:figma-generate-design' : skill };
}

async function adapt(figma, input) {
  const [page] = figma.root.children;
  if (figma.fileKey !== input.fileKey || figma.root.children.length !== 1) throw new Error('Unexpected synthetic file');
  await figma.setCurrentPageAsync(page);
  const byName = name => {
    const matches = page.findAll(node => node.name === name);
    if (matches.length !== 1) throw new Error('Expected one native layer named ' + name);
    return matches[0];
  };
  const canvas = byName('canvas');
  const collection = byName('collection');
  const title = byName('title');
  const heading = input.footer ? byName('heading') : null;
  const footer = input.footer ? byName('footer') : null;
  if (page.children.length !== 1 || canvas.children.length !== (footer ? 3 : 2) ||
      canvas.type !== 'FRAME' || collection.type !== 'FRAME' || title.type !== 'TEXT' ||
      title.parent !== (heading ?? canvas) || collection.parent !== canvas ||
      canvas.layoutMode !== 'NONE' || collection.layoutMode !== 'NONE') {
    throw new Error('Expected the registered responsive desktop starting hierarchy');
  }
  if (heading && (heading.type !== 'FRAME' || heading.layoutMode !== 'NONE' || heading.parent !== canvas ||
      heading.children.length !== 1 || footer.type !== 'TEXT' || footer.parent !== canvas)) {
    throw new Error('Expected the lab-queue heading and footer');
  }

  const cards = input.cards.map(spec => ({ node: byName(spec.key), spec }));
  if (collection.children.length !== cards.length ||
      cards.some(({ node }) => node.type !== 'FRAME' || node.parent !== collection || node.layoutMode !== 'NONE' ||
        node.children.some(child => child.type !== 'TEXT'))) throw new Error('Unexpected card hierarchy');

  canvas.layoutMode = 'VERTICAL';
  canvas.primaryAxisSizingMode = 'AUTO';
  canvas.counterAxisSizingMode = 'FIXED';
  canvas.paddingTop = canvas.paddingRight = canvas.paddingBottom = canvas.paddingLeft = input.canvasPad;
  canvas.itemSpacing = input.headingGap;
  if (heading) {
    heading.layoutSizingHorizontal = 'FILL';
    title.constraints = { horizontal: 'STRETCH', vertical: 'MIN' };
    // Reserve the footer's separate gap and height in the content-hugging canvas.
    footer.layoutPositioning = 'ABSOLUTE';
    canvas.paddingBottom = input.canvasPad + input.footer.gap + input.footer.height;
  } else {
    title.layoutSizingHorizontal = 'FILL';
  }

  collection.layoutMode = 'HORIZONTAL';
  collection.layoutWrap = 'WRAP';
  collection.primaryAxisSizingMode = 'FIXED';
  collection.counterAxisSizingMode = 'AUTO';
  collection.primaryAxisAlignItems = 'MIN';
  collection.counterAxisAlignItems = 'MIN';
  collection.itemSpacing = input.gap;
  collection.counterAxisSpacing = input.gap;
  collection.layoutSizingHorizontal = 'FILL';

  for (const { node, spec } of cards) {
    node.layoutMode = 'VERTICAL';
    node.primaryAxisSizingMode = 'AUTO';
    node.counterAxisSizingMode = 'FIXED';
    node.paddingTop = node.paddingRight = node.paddingBottom = node.paddingLeft = input.cardPad;
    node.itemSpacing = input.lineGap;
    node.minWidth = spec.min_width;
    node.maxWidth = spec.max_width;
    node.resize(spec.basis_width, node.height);
    node.layoutSizingVertical = 'HUG';
    node.layoutSizingHorizontal = 'FILL';
    for (const line of node.children) line.layoutSizingHorizontal = 'FILL';
  }
  if (footer) {
    footer.resize(canvas.width - 2 * input.canvasPad, input.footer.height);
    footer.x = input.canvasPad;
    footer.y = canvas.height - input.canvasPad - input.footer.height;
    footer.constraints = { horizontal: 'STRETCH', vertical: 'MAX' };
  }
  return { document_id: figma.fileKey, canvas_id: canvas.id, collection_id: collection.id,
    card_ids: cards.map(({ node }) => node.id), ...(footer && { heading_id: heading.id, footer_id: footer.id }) };
}

async function changeWidth(figma, { fileKey, width }) {
  const [page] = figma.root.children;
  if (figma.fileKey !== fileKey || figma.root.children.length !== 1) throw new Error('Unexpected test file');
  await figma.setCurrentPageAsync(page);
  const [canvas] = page.children;
  if (page.children.length !== 1 || canvas.name !== 'canvas' || canvas.type !== 'FRAME' ||
      canvas.layoutMode !== 'VERTICAL') throw new Error('Expected one responsive canvas');
  const before = { width: canvas.width, height: canvas.height, verticalMode: canvas.layoutSizingVertical };
  canvas.resize(width, before.height);
  return { document_id: figma.fileKey, canvas_id: canvas.id, from: before.width, to: canvas.width,
    before, after: { width: canvas.width, height: canvas.height, verticalMode: canvas.layoutSizingVertical } };
}

async function inspectResponsive(figma, { fileKey }) {
  const [page] = figma.root.children;
  if (figma.fileKey !== fileKey || figma.root.children.length !== 1) throw new Error('Unexpected diagnostic file');
  await figma.setCurrentPageAsync(page);
  const nodes = [];
  function visit(parent, parentKey, editable) {
    for (const item of parent.children) {
      const { name: key, id: native_id, type, absoluteBoundingBox } = item;
      const bounds = absoluteBoundingBox ? [absoluteBoundingBox.x, absoluteBoundingBox.y,
        absoluteBoundingBox.width, absoluteBoundingBox.height] : null;
      const row = { key, native_id, parent: parentKey, editable: editable && item.visible && !item.locked,
        kind: type.toLowerCase(), bounds };
      if (type === 'TEXT') {
        const render = item.absoluteRenderBounds;
        Object.assign(row, { text: item.characters, font_family: item.fontName?.family, font_size: item.fontSize,
          editable: row.editable && !item.hasMissingFont, render_bounds: render &&
            [render.x, render.y, render.width, render.height], text_truncation: item.textTruncation });
      }
      if (type === 'FRAME') {
        const layout = item.layoutMode;
        const wrapping = layout === 'HORIZONTAL' && item.layoutWrap === 'WRAP';
        const verticalSizing = layout === 'NONE' ? 'FIXED' : item.layoutSizingVertical;
        const children = item.children;
        Object.assign(row, { layout: wrapping ? 'horizontal-wrap' : layout.toLowerCase().replace('none', 'fixed'),
          height_rule: verticalSizing === 'HUG' ? 'content' : 'fixed', vertical_sizing: verticalSizing,
          clips_content: item.clipsContent, native_layout_horizontal: layout === 'NONE' ? 'FIXED' : item.layoutSizingHorizontal,
          min_width: item.minWidth, max_width: item.maxWidth,
          gap: layout === 'NONE' && children.length > 1 ? children[1].x - children[0].x - children[0].width : item.itemSpacing,
          align: layout === 'NONE' || item.primaryAxisAlignItems === 'MIN' ? 'start' : item.primaryAxisAlignItems,
          overflow_x: children.some(child => child.x < -0.01 || child.x + child.width > item.width + 0.01) ? 'present' : 'none' });
      }
      nodes.push(row);
      if ('children' in item) visit(item, key, row.editable);
    }
  }
  visit(page, null, true);
  const styles = (await figma.variables.getLocalVariablesAsync()).map(style => ({ key: style.name, native_id: style.id }));
  return { document_id: figma.fileKey, nodes, styles };
}

export function planResponsive(fixture, original, copy) {
  assert.equal(fixture.workload, 'LD04');
  assert.ok(['street-market', 'lab-queue'].includes(fixture.source_family_id));
  assert.equal(fixture.private_width_registered, true, 'Freeze a private width before planning');
  assert.match(original ?? '', /^[a-zA-Z0-9_-]{1,128}$/);
  if (copy != null) assert.match(copy, /^[a-zA-Z0-9_-]{1,128}$/);
  assert.notEqual(original, copy, 'Width verification requires a distinct test file');
  const start = new Map(fixture.start.nodes.map(node => [node.key, node]));
  const nodes = [...start.values()].map(({ key, kind, parent, text, font_size, bounds }) => {
    const [x, y, w, h] = bounds;
    const p = start.get(parent)?.bounds;
    return { key, kind, parent, text, font_size, localBounds: [x - (p?.[0] ?? 0), y - (p?.[1] ?? 0), w, h] };
  });
  const cards = fixture.expected.nodes.filter(node => node.parent === 'collection' && node.kind === 'frame')
    .map(({ key, min_width, max_width, basis_width }) => ({ key, min_width, max_width, basis_width }));
  const [first, second] = [...start.values()].filter(node => node.parent === 'card/0');
  const firstCard = start.get('card/0');
  const collection = start.get('collection');
  const heading = start.get('heading') ?? start.get('title');
  const footer = start.get('footer');
  const footerLayout = footer && { height: footer.bounds[3],
    gap: footer.bounds[1] - collection.bounds[1] - collection.bounds[3] };
  const layout = { cards, gap: collection.gap, canvasPad: heading.bounds[0], footer: footerLayout,
    headingGap: collection.bounds[1] - heading.bounds[1] - heading.bounds[3],
    cardPad: first.bounds[0] - firstCard.bounds[0], lineGap: second.bounds[1] - first.bounds[1] - first.bounds[3] };
  const makeFilePlan = fileKey => ({
    seed: payload('Create independent editable responsive baseline', seed, { fileKey, nodes, styles: [], images: [] }, true),
    adapt: payload('Enable native wrapping Auto Layout on the existing frames', adapt, { fileKey, ...layout }, true),
    read: payload('Observe actual native responsive tree, geometry and sizing modes', inspectResponsive, { fileKey }),
  });
  return { fixture_sha256: fixture.fixture_sha256, commitment: fixture.withheld_width_commitment,
    original: makeFilePlan(original), copy: copy ? { ...makeFilePlan(copy), steps: fixture.responsive_steps.map(({ width }) =>
      payload('Change only the native canvas width on the isolated verification file', changeWidth, { fileKey: copy, width }, true)),
    } : null };
}

export function normalizeResponsive(raw) {
  assert.notEqual(raw?.isError, true, 'MCP failed');
  assert.equal(raw?.content?.length, 1, 'Missing Figma result');
  assert.equal(raw.content[0].type, 'text');
  const snapshot = JSON.parse(raw.content[0].text);
  assert.ok(typeof snapshot.document_id === 'string' && snapshot.document_id);
  const ids = snapshot.nodes.map(node => node.native_id);
  assert.ok(ids.every(id => typeof id === 'string' && id));
  assert.equal(new Set(ids).size, ids.length, 'Duplicate node identities');
  const nodes = new Map(snapshot.nodes.map(node => [node.key, node]));
  assert.equal(nodes.size, snapshot.nodes.length, 'Duplicate logical layer names');
  const encloses = (outer, inner) => outer && inner &&
    inner[0] >= outer[0] - 2 && inner[1] >= outer[1] - 2 &&
    inner[0] + inner[2] <= outer[0] + outer[2] + 2 && inner[1] + inner[3] <= outer[1] + outer[3] + 2;
  for (const node of snapshot.nodes.filter(node => node.kind === 'text')) {
    let current = node;
    let inside = node.text_truncation === 'DISABLED' && encloses(node.bounds, node.render_bounds);
    while (current.parent !== null && inside) {
      const parent = nodes.get(current.parent);
      assert.ok(parent, 'Missing native parent');
      inside = encloses(parent.bounds, node.render_bounds);
      current = parent;
    }
    node.fully_visible = inside;
  }
  return snapshot;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [command, data, original, copy, ...extra] = process.argv.slice(2);
  const read = path => JSON.parse(readFileSync(path, 'utf8'));
  if (command === 'plan' && data && original && !extra.length) {
    console.log(JSON.stringify(planResponsive(read(data), original, copy === '-' ? null : copy)));
  } else if (command === 'normalize' && data && original === undefined) {
    console.log(JSON.stringify(normalizeResponsive(read(data))));
  } else {
    console.error('Usage: ld04.mjs plan FIXTURE ORIGINAL_KEY [COPY_KEY] | normalize RAW_MCP_RESPONSE');
    process.exitCode = 2;
  }
}
