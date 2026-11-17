import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { normalizeAtlas, planAtlas } from './ld02-atlas.mjs';

const synth = fileURLToPath(new URL('../workloads/synthetic.py', import.meta.url));
const python = (...args) => spawnSync('python3', [synth, ...args], { encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
const execute = (figma, { code }) => new (Object.getPrototypeOf(async function () {}).constructor)('figma', code)(figma);
const wrap = data => ({ content: [{ type: 'text', text: JSON.stringify(data) }] });

function figmaMock(fileKey) {
  let nextID = 0;
  const id = () => fileKey + ':' + (++nextID);
  const root = { children: [] };
  const rows = new Map();
  const empty = async () => [];
  const figma = { fileKey, root, async loadFontAsync() {},
    async setCurrentPageAsync(page) { assert.ok(root.children.includes(page)); this.currentPage = page; },
    variables: { getLocalVariablesAsync: empty }, getLocalPaintStylesAsync: empty, getLocalTextStylesAsync: empty,
    getLocalEffectStylesAsync: empty, getLocalGridStylesAsync: empty,
  };
  function appendChild(node) {
    if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1);
    this.children.push(node);
    node.parent = this;
  }
  function createPage() {
    const result = { id: id(), type: 'PAGE', name: 'Page', children: [], selection: [], appendChild,
      findAll(predicate) {
        const descendants = node => node.children.flatMap(child => [child, ...(child.children ? descendants(child) : [])]);
        return descendants(this).filter(predicate);
      } };
    root.children.push(result);
    return result;
  }
  function createNode(type) {
    const node = { id: id(), type, x: 0, y: 0, width: 100, height: 100, layoutMode: 'NONE',
      visible: true, locked: false, fills: [], getStyledTextSegments() { return [{ fontName: this.fontName }]; },
      resize(w, h) { this.width = w; this.height = h; },
      get absoluteBoundingBox() {
        const p = this.parent;
        const origin = p.absoluteBoundingBox ?? { x: 0, y: 0 };
        const stack = p.layoutMode === 'VERTICAL';
        const before = p.children.slice(0, p.children.indexOf(this));
        const offset = stack ? before.reduce((sum, child) => sum + child.height + p.itemSpacing, 0) : 0;
        return { x: origin.x + (stack ? p.paddingLeft : this.x),
          y: origin.y + (stack ? p.paddingTop + offset : this.y), width: this.width, height: this.height };
      },
    };
    if (type === 'FRAME') Object.assign(node, { children: [], appendChild });
    figma.currentPage.appendChild(node);
    rows.set(node.id, node);
    return node;
  }
  figma.currentPage = createPage();
  figma.createPage = createPage;
  figma.createFrame = () => createNode('FRAME');
  figma.createText = () => createNode('TEXT');
  figma.createRectangle = () => createNode('RECTANGLE');
  figma.editorHistory = (trace, direction) => {
    for (const change of trace.writes) {
      const props = { text: 'characters', gap: 'itemSpacing', radius: 'cornerRadius' };
      rows.get(change.native_id)[props[change.field]] = change[direction === 'undo' ? 'from' : 'to'];
    }
  };
  return figma;
}

async function capture(figma, plan) {
  const inventory = wrap(await execute(figma, plan.inventory));
  const pages = [];
  for (const request of plan.pages) pages.push(wrap(await execute(figma, request)));
  return { inventory, pages };
}

async function seed(figma, plan) {
  await execute(figma, plan.createPages);
  for (const request of plan.seedPages) await execute(figma, request);
}

test('Atlas generated requests and independent snapshots pass the shared oracle', async () => {
  const generated = python('fixture', 'LD02', '--variant', 'conservation-atlas');
  assert.equal(generated.status, 0, generated.stderr);
  const fixture = JSON.parse(generated.stdout);
  const plan = planAtlas(fixture, 'original', 'copy');
  const copySeed = planAtlas(fixture, 'copy', null);
  assert.throws(() => planAtlas(fixture, 'original', 'original'), /distinct/);
  const original = figmaMock('original');
  const copy = figmaMock('copy');
  await seed(original, plan);
  await seed(copy, copySeed);
  const before = await capture(original, plan.original.read);
  const copy_before = await capture(copy, plan.copy.read);
  await assert.rejects(execute(original, plan.copy.edit), /Unexpected test file/);
  const edit_trace = [wrap(await execute(original, plan.original.edit))];
  const candidate = await capture(original, plan.original.read);
  const reopened = await capture(original, plan.original.read);
  const copyWrite = await execute(copy, plan.copy.edit);
  const copy_edited = await capture(copy, plan.copy.read);
  copy.editorHistory(copyWrite, 'undo');
  const copy_undo = await capture(copy, plan.copy.read);
  copy.editorHistory(copyWrite, 'redo');
  const copy_redo = await capture(copy, plan.copy.read);
  const after_probe_original = await capture(original, plan.original.read);
  const editor_lifecycle = {
    reopen: { document_id: 'original', closed_at: '2026-01-01T00:00:01Z', reopened_at: '2026-01-01T00:00:02Z' },
    copy_history: [{ document_id: 'copy', action: 'undo', at: '2026-01-01T00:00:03Z' },
      { document_id: 'copy', action: 'redo', at: '2026-01-01T00:00:04Z' }],
  };
  const transcript = { before, candidate, reopened, after_probe_original, copy_before, copy_edited, copy_undo, copy_redo,
    edit_trace, copy_edit_trace: [wrap(copyWrite)], editor_lifecycle };
  const evidence = normalizeAtlas(fixture, transcript);
  assert.equal(evidence.before.nodes.length, 1_000);
  assert.deepEqual(evidence.edit, fixture.edit);
  const temp = mkdtempSync(join(tmpdir(), 'figma-atlas-'));
  try {
    const path = join(temp, 'observed.json');
    const grade = value => {
      writeFileSync(path, JSON.stringify(value));
      return python('grade', 'LD02', path, '--variant', 'conservation-atlas');
    };
    const passing = grade(evidence);
    assert.equal(passing.status, 0, passing.stderr + passing.stdout);
    const missingPage = { ...before, pages: before.pages.slice(1) };
    assert.throws(() => normalizeAtlas(fixture, { ...transcript, before: missingPage }), /Missing page capture batches/);
    const fakeRedo = normalizeAtlas(fixture, { ...transcript, copy_redo: copy_undo });
    assert.equal(grade(fakeRedo).status, 1);
    const changed = structuredClone(evidence);
    changed.candidate.nodes.find(node => node.page === 'reserve' && node.name === 'receipt').text = 'unexpected write';
    assert.equal(grade(changed).status, 1);
    assert.throws(() => normalizeAtlas(fixture, { ...transcript, editor_lifecycle: {
      ...editor_lifecycle, copy_history: editor_lifecycle.copy_history.slice(1),
    } }), /Missing ordered native Undo and Redo/);
    const write = JSON.parse(edit_trace[0].content[0].text);
    write.writes[0].native_id = evidence.before.nodes.find(node => node.page !== fixture.working_page).native_id;
    assert.throws(() => normalizeAtlas(fixture, { ...transcript, edit_trace: [wrap(write)] }), /unobserved node/);
  } finally {
    rmSync(temp, { recursive: true });
  }
});
