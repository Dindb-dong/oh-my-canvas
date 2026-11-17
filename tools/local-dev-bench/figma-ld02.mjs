import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fixture, target } from './replays/ld02-fixture.mjs';

const expectedEdit = { label: target.after.text, gap: target.after.gap, fill: target.after.fill };
const readSkill = 'resource:figma-use';
const writeSkills = `${readSkill},resource:figma-generate-design`;

function useFigma(description, code, skillNames = readSkill) {
  return { description, code, skillNames };
}

function openPage(name) {
  return `const pages = figma.root.children.filter(page => page.name === ${JSON.stringify(name)});
if (pages.length !== 1) throw new Error('Expected a single page with the trial name');
await figma.setCurrentPageAsync(pages[0]);`;
}

function makePlan(trial) {
  assert.match(trial ?? '', /^[a-zA-Z0-9_-]{1,48}$/, 'Use a fresh, short trial ID');
  const pageNames = fixture.pages.map(page => `LD02 ${trial} / ${page.name}`);
  const pageName = pageNames[fixture.pages.findIndex(page => page.name === target.page)];
  const findTarget = `${openPage(pageName)}
const frames = figma.currentPage.children.filter(node => node.type === 'FRAME' && node.name === ${JSON.stringify(target.card)});
if (frames.length !== 1) throw new Error('Expected a single target frame');
const frame = frames[0];
const [label, reference, swatch] = frame.children;
if (frame.layoutMode !== 'VERTICAL' || frame.children.length !== 3 || label.type !== 'TEXT' || reference.type !== 'TEXT' || swatch.type !== 'RECTANGLE') {
  throw new Error('Unexpected target structure');
}
const fill = () => {
  const [paint] = swatch.fills;
  if (swatch.fills.length !== 1 || paint?.type !== 'SOLID') throw new Error('Unexpected swatch fill');
  return '#' + ['r', 'g', 'b'].map(key => Math.round(paint.color[key] * 255).toString(16).padStart(2, '0')).join('');
};`;
  const readback = ids => `return { pageName: figma.currentPage.name, targetName: frame.name,
  ${ids}: [frame.id, label.id, swatch.id], referenceId: reference.id, reference: reference.characters,
  label: label.characters, gap: frame.itemSpacing, fill: fill() };`;

  return {
    trial,
    workload: fixture.workload,
    logicalObjects: fixture.logicalObjects,
    inspect: useFigma('List Figma pages before seeding the synthetic trial',
      'return figma.root.children.map(page => ({ name: page.name, id: page.id }));'),
    createPages: useFigma('Create fresh synthetic LD02 pages', `const names = ${JSON.stringify(pageNames)};
if (figma.root.children.some(page => names.includes(page.name))) throw new Error('Trial pages already exist');
const createdNodeIds = [];
for (const name of names) {
  const page = figma.createPage();
  page.name = name;
  createdNodeIds.push(page.id);
}
return { createdNodeIds, pageNames: names };`, writeSkills),
    seedPages: fixture.pages.map((page, index) => useFigma(`Seed ${pageNames[index]}`, `${openPage(pageNames[index])}
if (figma.currentPage.children.length !== 0) throw new Error('Expected an empty trial page');
const font = { family: 'Inter', style: 'Regular' };
await figma.loadFontAsync(font);
const createdNodeIds = [];
for (const card of ${JSON.stringify(page.children)}) {
  const frame = figma.createAutoLayout('VERTICAL', { name: card.name, itemSpacing: card.gap,
    paddingTop: card.padding, paddingRight: card.padding, paddingBottom: card.padding, paddingLeft: card.padding });
  frame.resize(card.width, card.height);
  frame.x = card.x;
  frame.y = card.y;
  frame.fills = [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }];
  createdNodeIds.push(frame.id);
  for (const child of card.children.slice(0, 2)) {
    const label = figma.createText();
    label.fontName = font;
    label.fontSize = 16;
    label.lineHeight = { unit: 'PIXELS', value: 20 };
    label.characters = child.text;
    frame.appendChild(label);
    createdNodeIds.push(label.id);
  }
  const shape = card.children[2];
  const swatch = figma.createRectangle();
  swatch.resize(shape.width, shape.height);
  const [r, g, b] = [1, 3, 5].map(offset => parseInt(shape.fill.slice(offset, offset + 2), 16) / 255);
  swatch.fills = [{ type: 'SOLID', color: { r, g, b } }];
  frame.appendChild(swatch);
  createdNodeIds.push(swatch.id);
}
return { pageId: figma.currentPage.id, cards: figma.currentPage.children.length, createdNodeIds };`, writeSkills)),
    edit: useFigma('Replay the scoped LD02 text, gap, and swatch change', `${findTarget}
if (label.characters !== ${JSON.stringify(target.before.text)} || frame.itemSpacing !== ${target.before.gap} ||
    reference.characters !== ${JSON.stringify(target.before.reference)} || fill() !== ${JSON.stringify(target.before.fill)}) {
  throw new Error('Unexpected starting values');
}
for (const { fontName } of label.getStyledTextSegments(['fontName'])) await figma.loadFontAsync(fontName);
label.characters = ${JSON.stringify(expectedEdit.label)};
frame.itemSpacing = ${expectedEdit.gap};
const [r, g, b] = [1, 3, 5].map(offset => parseInt(${JSON.stringify(expectedEdit.fill)}.slice(offset, offset + 2), 16) / 255);
swatch.fills = [{ type: 'SOLID', color: { r, g, b } }];
${readback('mutatedNodeIds')}`, writeSkills),
    readback: useFigma('Independently read the edited Figma target', `${findTarget}\n${readback('nodeIds')}`),
    expected: { pageName, targetName: target.card, reference: target.before.reference, ...expectedEdit },
  };
}

function decode(response) {
  assert.notEqual(response?.isError, true, 'Figma MCP returned an error');
  assert.equal(response?.content?.length, 1, 'Expected one Figma result block');
  const block = response.content[0];
  assert.equal(block.type, 'text');
  return JSON.parse(block.text);
}

function verify(plan, editResponse, readbackResponse) {
  const { mutatedNodeIds, ...edit } = decode(editResponse);
  const { nodeIds, ...readback } = decode(readbackResponse);
  assert.ok(Array.isArray(nodeIds) && nodeIds.length === 3);
  const ids = [...nodeIds, readback.referenceId];
  assert.ok(ids.every(id => typeof id === 'string' && id.length > 0) && new Set(ids).size === ids.length);
  assert.deepEqual(mutatedNodeIds, nodeIds, 'Target identities changed');
  assert.deepEqual(edit, readback, 'Separate readback disagrees with edit response');
  assert.deepEqual(readback, { ...plan.expected, referenceId: readback.referenceId });
  return { verified: true, boundary: 'figma_remote_mcp_scoped_readback', nodeIds, ...readback };
}

async function selfCheck() {
  const plan = makePlan('offline-check');
  assert.equal(plan.seedPages.length, 10);
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  for (const { code } of [plan.inspect, plan.createPages, ...plan.seedPages, plan.edit, plan.readback]) {
    assert.doesNotThrow(() => new AsyncFunction('figma', code));
  }
  assert.throws(() => makePlan('invalid\ntrial'));

  const fontName = { family: 'Inter', style: 'Regular' };
  const label = { id: '1:2', type: 'TEXT', characters: target.before.text, getStyledTextSegments: () => [{ fontName }] };
  const reference = { id: '1:4', type: 'TEXT', characters: target.before.reference };
  const swatch = { id: '1:3', type: 'RECTANGLE', fills: [{ type: 'SOLID', color: { r: 40 / 255, g: 100 / 255, b: 220 / 255 } }] };
  const frame = { id: '1:1', type: 'FRAME', name: target.card, layoutMode: 'VERTICAL', itemSpacing: target.before.gap,
    children: [label, reference, swatch] };
  const page = { name: plan.expected.pageName, children: [frame] };
  const figma = { root: { children: [page] }, loadFontAsync: async font => assert.deepEqual(font, fontName),
    async setCurrentPageAsync(active) { this.currentPage = active; } };
  const result = data => ({ content: [{ type: 'text', text: JSON.stringify(data) }] });
  const run = step => new AsyncFunction('figma', step.code)(figma);
  const edit = result(await run(plan.edit));
  const readback = await run(plan.readback);
  assert.equal(verify(plan, edit, result(readback)).verified, true);
  await assert.rejects(() => run(plan.edit), /Unexpected starting values/);
  assert.throws(() => verify(plan, edit, result({ ...readback, gap: 12 })));
  assert.throws(() => verify(plan, edit, result({ ...readback, nodeIds: ['1:1', '1:2', '1:5'] })));
  assert.throws(() => verify(plan, edit, { ...result(readback), isError: true }));
}

const [command, trial, editPath, readbackPath, ...extra] = process.argv.slice(2);
if (command === '--self-test' && trial === undefined) {
  await selfCheck();
  console.log('Figma LD02 payloads and result checks passed');
} else if (command === 'plan' && trial && editPath === undefined) {
  console.log(JSON.stringify(makePlan(trial)));
} else if (command === 'verify' && trial && editPath && readbackPath && !extra.length) {
  const read = path => JSON.parse(readFileSync(path, 'utf8'));
  console.log(JSON.stringify(verify(makePlan(trial), read(editPath), read(readbackPath))));
} else {
  console.error('Usage: figma-ld02.mjs plan TRIAL_ID | verify TRIAL_ID EDIT.json READBACK.json | --self-test');
  process.exitCode = 2;
}
