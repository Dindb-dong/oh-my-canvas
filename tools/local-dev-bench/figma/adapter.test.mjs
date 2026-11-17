import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { makePlan, normalizeEvidence } from './adapter.mjs';

const fixtures = fileURLToPath(new URL('../workloads/synthetic.py', import.meta.url));
const runCode = Object.getPrototypeOf(async function () {}).constructor;
const response = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
const python = (...args) => spawnSync('python3', [fixtures, ...args], {
  encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
});

function mockFigma(fileKey) {
  const variables = [];
  const collections = [];
  const images = new Map();
  let index = 0;
  const id = () => fileKey + ':' + (++index);
  const currentPage = {
    id: id(), children: [],
    findAll(predicate) {
      function walk(root) { return root.children.flatMap(node => [node, ...(node.children ? walk(node) : [])]); }
      return walk(this).filter(predicate);
    },
  };
  const figma = {
    fileKey, currentPage, root: { children: [currentPage] },
    async setCurrentPageAsync(page) { assert.equal(page, currentPage); },
    async loadFontAsync() {},
    base64Decode: value => Buffer.from(value, 'base64'),
    base64Encode: value => Buffer.from(value).toString('base64'),
    createImage(bytes) {
      const hash = createHash('sha256').update(bytes).digest('hex');
      images.set(hash, { hash, async getBytesAsync() { return bytes; } });
      return images.get(hash);
    },
    getImageByHash: hash => images.get(hash),
    variables: {
      async getLocalVariablesAsync() { return variables; },
      async getLocalVariableCollectionsAsync() { return collections; },
      async getVariableCollectionByIdAsync(key) { return collections.find(item => item.id === key); },
      createVariableCollection() {
        const item = { id: id(), defaultModeId: id() };
        collections.push(item);
        return item;
      },
      createVariable(name, collection, resolvedType) {
        const item = { name, id: id(), resolvedType, variableCollectionId: collection.id, valuesByMode: {},
          setValueForMode(mode, value) { this.valuesByMode[mode] = value; } };
        variables.push(item);
        return item;
      },
      setBoundVariableForPaint(paint, prop, variable) {
        return { ...paint, boundVariables: { [prop]: { id: variable.id } } };
      },
    },
  };
  function attach(node) {
    if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1);
    this.children.push(node);
    node.parent = this;
  }
  currentPage.appendChild = attach;

  function create(type) {
    let fills = [];
    let spacing = 0;
    const resolve = key => Object.values(variables.find(item => item.id === key).valuesByMode)[0];
    const node = {
      id: id(), type, x: 0, y: 0, width: 100, height: 100, layoutMode: 'NONE', visible: true, locked: false,
      boundVariables: {}, get fills() {
        return fills.map(paint => ({ ...paint, color: paint.boundVariables?.color ? resolve(paint.boundVariables.color.id) : paint.color }));
      },
      set fills(value) { fills = value; },
      get itemSpacing() { return this.boundVariables.itemSpacing ? resolve(this.boundVariables.itemSpacing.id) : spacing; },
      set itemSpacing(value) { spacing = value; },
      resize(width, height) { this.width = width; this.height = height; },
      setBoundVariable(key, variable) { this.boundVariables[key] = { id: variable.id }; },
      getStyledTextSegments() { return [{ fontName: this.fontName }]; },
      get absoluteBoundingBox() {
        const parent = this.parent.absoluteBoundingBox ?? { x: 0, y: 0 };
        const stack = this.parent.layoutMode;
        const preceding = this.parent.children.slice(0, this.parent.children.indexOf(this));
        const distance = dimension => preceding.reduce((sum, entry) => sum + entry[dimension] + this.parent.itemSpacing, 0);
        const x = stack === 'HORIZONTAL' ? distance('width') : this.x;
        const y = stack === 'VERTICAL' ? distance('height') : stack === 'HORIZONTAL' ?
          (this.parent.height - this.height) / 2 : this.y;
        return { x: parent.x + x, y: parent.y + y, width: this.width, height: this.height };
      },
    };
    if (type === 'FRAME') Object.assign(node, { children: [], appendChild: attach });
    currentPage.appendChild(node);
    return node;
  }
  figma.createFrame = () => create('FRAME');
  figma.createText = () => create('TEXT');
  figma.createRectangle = () => create('RECTANGLE');
  return figma;
}

const run = (figma, payload) => new runCode('figma', payload.code)(figma);
async function capture(figma, steps) {
  const header = response(await run(figma, steps.header));
  const result = { header };
  for (const key of ['nodes', 'images']) {
    result[key] = await Promise.all(steps[key].map(async step => response(await run(figma, step))));
  }
  return result;
}

for (const [workload, variant] of [
  ['LD01', 'harbor-ops'], ['LD01', 'reading-room'], ['LD03', 'field-relay'], ['LD03', 'edition-grid'],
]) {
  test(workload + ' ' + variant + ' passes common grader from native mock state', async () => {
    const temp = mkdtempSync(join(tmpdir(), 'figma-adapter-'));
    try {
      const assets = join(temp, 'assets');
      const args = workload === 'LD01' ? ['--assets-dir', assets] : [];
      const result = python('fixture', workload, '--variant', variant, ...args);
      assert.equal(result.status, 0, result.stderr);
      const fixture = JSON.parse(result.stdout);
      const plan = makePlan(fixture, 'original', 'copy', assets);
      assert.throws(() => makePlan(fixture, 'original', 'original', assets), /separate copy/);
      const original = mockFigma('original');
      const copy = mockFigma('copy');
      if (plan.setup) await run(original, plan.setup);
      const before = await capture(original, plan.captures.before);
      await run(original, plan.candidate);
      await assert.rejects(run(original, plan.probe), /Unexpected synthetic Figma file/);
      const candidate = await capture(original, plan.captures.candidate);
      const reopened = await capture(original, plan.captures.reopened);
      // Prepare the simulated duplicate with its own native identity space.
      const copyPlan = makePlan(fixture, 'copy', 'original', assets);
      if (copyPlan.setup) await run(copy, copyPlan.setup);
      await run(copy, copyPlan.candidate);
      const probe_actions = response(await run(copy, plan.probe));
      const probe = await capture(copy, plan.captures.probe);
      const after_probe_original = await capture(original, plan.captures.after_probe_original);
      const transcript = { before, candidate, reopened, probe, after_probe_original, probe_actions };
      const evidence = normalizeEvidence(fixture, transcript);
      const output = join(temp, 'evidence.json');
      writeFileSync(output, JSON.stringify(evidence));
      const grade = python('grade', workload, output, '--variant', variant);
      assert.equal(grade.status, 0, grade.stderr + grade.stdout);

      const changed = structuredClone(transcript);
      changed.reopened.nodes.pop();
      assert.throws(() => normalizeEvidence(fixture, changed), /Missing Figma layer captures/);
      changed.reopened = transcript.probe;
      const wrongDocument = normalizeEvidence(fixture, changed);
      writeFileSync(output, JSON.stringify(wrongDocument));
      assert.equal(python('grade', workload, output, '--variant', variant).status, 1);
      if (workload === 'LD01') {
        const altered = structuredClone(transcript);
        const image = JSON.parse(altered.candidate.images[0].content[0].text);
        image.base64 = (image.base64[0] === 'A' ? 'B' : 'A') + image.base64.slice(1);
        altered.candidate.images[0] = response(image);
        assert.throws(() => normalizeEvidence(fixture, altered), /Stored image bytes do not match/);
      }
    } finally {
      rmSync(temp, { recursive: true });
    }
  });
}
