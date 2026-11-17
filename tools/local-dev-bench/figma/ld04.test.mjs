import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { normalizeResponsive, planResponsive } from './ld04.mjs';

const synth = fileURLToPath(new URL('../workloads/synthetic.py', import.meta.url));
const run = (figma, request) => new (Object.getPrototypeOf(async function () {}).constructor)('figma', request.code)(figma);
const result = object => ({ content: [{ type: 'text', text: JSON.stringify(object) }] });

test('LD04 width steps act only on the isolated native canvas', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'figma-ld04-'));
  try {
    const registration = join(temp, 'registration.json');
    const hiddenWidth = 1001;
    writeFileSync(registration, JSON.stringify({ width: hiddenWidth, nonce: 'synthetic-mock-only-secret' }));
    const fixture = spawnSync('python3', [synth, 'fixture', 'LD04', '--variant', 'street-market', '--registration', registration],
      { encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
    assert.equal(fixture.status, 0, fixture.stderr);
    const spec = JSON.parse(fixture.stdout);
    assert.throws(() => planResponsive(spec, 'draft', 'draft'), /distinct/);
    const plan = planResponsive(spec, 'draft', 'copy');
    assert.ok(!JSON.stringify(plan.original).includes(String(hiddenWidth)), 'Withheld width leaked into candidate work');
    assert.match(plan.commitment, /^[a-f0-9]{64}$/);
    for (const step of [plan.original.seed, plan.original.adapt, plan.original.read, ...plan.copy.steps]) {
      assert.doesNotThrow(() => new (Object.getPrototypeOf(async function () {}).constructor)('figma', step.code));
    }
    const touched = [];
    const canvas = { id: 'canvas-id', name: 'canvas', type: 'FRAME', layoutMode: 'VERTICAL',
      width: 1440, height: 300, layoutSizingVertical: 'HUG' };
    canvas.resize = (width, height) => {
      assert.equal(height, canvas.height);
      touched.push(width);
      canvas.width = width;
    };
    const page = { children: [canvas] };
    const figma = { fileKey: 'copy', root: { children: [page] }, async setCurrentPageAsync() {} };
    await assert.rejects(run({ ...figma, fileKey: 'draft' }, plan.copy.steps[0]), /Unexpected test file/);
    for (const step of plan.copy.steps) {
      const trace = await run(figma, step);
      assert.equal(trace.canvas_id, canvas.id);
      assert.equal(trace.after.verticalMode, 'HUG');
    }
    assert.deepEqual(touched, [768, 390, hiddenWidth, 1440]);
  } finally {
    rmSync(temp, { recursive: true });
  }
});

test('LD04 normalizes observed bounds without inventing native flex basis', () => {
  const observed = { document_id: 'copy', styles: [], nodes: [
    { key: 'canvas', native_id: 'first', kind: 'frame', parent: null, bounds: [0, 0, 200, 100] },
    { key: 'card', native_id: 'card-id', kind: 'frame', parent: 'canvas', bounds: [0, 0, 180, 80],
      min_width: 230, max_width: 360 },
    { key: 'text', native_id: 'second', kind: 'text', parent: 'card', bounds: [14, 10, 100, 50],
      render_bounds: [14, 15, 90, 18], text_truncation: 'DISABLED' },
  ] };
  const copy = normalizeResponsive(result(observed));
  assert.equal(copy.nodes[2].fully_visible, true);
  assert.equal(copy.nodes[1].basis_width, undefined);
  observed.nodes[2].render_bounds = [14, 15, 195, 30];
  assert.equal(normalizeResponsive(result(observed)).nodes[2].fully_visible, false);
  observed.nodes[2].native_id = 'card-id';
  assert.throws(() => normalizeResponsive(result(observed)), /Duplicate node identities/);
});
