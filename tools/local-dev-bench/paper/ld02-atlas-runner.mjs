import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {withLD02Broker} from '../ld02-model.mjs';
import {runLD03Agent} from '../ld03-model.mjs';
import {publishCandidate} from '../publish-candidate.mjs';
import {atlasPlan, captureAtlas, checkProtectedAtlas, paperAtlasModelHandlers, seedAtlasPage} from './ld02-atlas.mjs';
import {withPaper} from './ld03.mjs';

const fileName = 'OMC Benchmark • Synthetic CAP Probe • 2026-11-17';
const save = (path, value) => writeFile(path, JSON.stringify(value) + '\n', {mode: 0o600, flag: 'wx'});
const graderPath = fileURLToPath(new URL('../workloads/', import.meta.url));

function checkObservedStart(fixture, baseline) {
  const check = `import json, sys, synthetic
payload = json.load(sys.stdin)
expected, observed = payload['expected'], payload['observed']
missing = {row['key'] for row in observed['nodes'] if row['bounds'] is None}
for row in expected['nodes']:
    if row['key'] in missing:
        row.pop('bounds', None)
failures = []
synthetic._phase('before', expected, observed, failures)
assert not failures, failures`;
  execFileSync('python3', ['-B', '-c', check], {cwd: graderPath,
    input: JSON.stringify({expected: fixture.start, observed: baseline.snapshot})});
  assert.deepEqual(baseline.snapshot.selected_native_ids, [], 'Starting Paper selection is not empty');
}

async function prepare(read, fixture, plan) {
  const call = (name, args = {}) => read({name, arguments: {...args, fileId: plan.fileId}});
  const original = await call('get_basic_info');
  assert.equal(original.fileName, fileName);
  assert.ok(!original.pages.some(page => page.name.startsWith(plan.prefix)), 'Paper run prefix already exists');
  let approved = original.artboards.some(board => board.name === 'CAP Editable Scene');
  for (const page of original.pages) {
    if (approved) break;
    approved = (await call('get_basic_info', {pageId: page.id})).artboards.some(board => board.name === 'CAP Editable Scene');
  }
  assert.ok(approved, 'Missing approved Paper test canvas marker');
  const ownedPages = new Set();
  for (const page of plan.pages) {
    await read(page.create);
    const current = await call('get_basic_info');
    const pages = current.pages.filter(row => row.name === page.name);
    assert.equal(pages.length, 1);
    const [created] = pages;
    assert.ok(!original.pages.some(row => row.id === created.id) && !ownedPages.has(created.id));
    ownedPages.add(created.id);
    await seedAtlasPage(read, plan, page, created.id);
  }
  const home = await call('get_basic_info');
  assert.deepEqual(home.pages.filter(page => !ownedPages.has(page.id)), original.pages);
  const baseline = await captureAtlas(read, fixture, plan);
  checkObservedStart(fixture, baseline);
  return baseline;
}

async function attempt(read, fixture, plan, baseline, command, output) {
  const root = await mkdtemp(join(tmpdir(), 'paper-ld02-atlas-'));
  const modelTools = [];
  try {
    const handlers = paperAtlasModelHandlers(read, plan, fixture);
    try {
      await withLD02Broker(join(root, 'broker.sock'), handlers, modelTools, () =>
        runLD03Agent(command, join(root, 'broker.sock')));
    } finally {
      await save(join(output, 'native-model-events.json'), modelTools);
    }
    assert.ok(modelTools.some(event => event.name === 'edit_section' && event.status === 'ok'),
      'The model did not make the guarded native edit');
    const candidate = await captureAtlas(read, fixture, plan);
    const edit = checkProtectedAtlas(fixture, baseline.snapshot, candidate.snapshot);
    await publishCandidate(process.env.OMC_BENCH_CANDIDATE, {before: baseline.snapshot, candidate: candidate.snapshot, edit});
    await save(join(output, 'candidate-native.json'), candidate);
    console.log(JSON.stringify({nodes: candidate.snapshot.nodes.length, missingBounds: candidate.missingBounds.length,
      nativeReopenObserved: false, nativeUndoRedoObserved: false}));
  } finally {
    await rm(root, {recursive: true, force: true});
  }
}

const [mode, fixturePath, fileId, runId, baselinePath, command] = process.argv.slice(2);
assert.ok(['prepare', 'attempt'].includes(mode) && fixturePath && fileId && runId && baselinePath);
const fixture = JSON.parse(await readFile(fixturePath, 'utf8'));
const plan = atlasPlan(fixture, {name: fileName, fileId}, runId);
const scope = {fileId, fileName};
if (mode === 'prepare') {
  assert.equal(command, undefined);
  const baseline = await withPaper(scope, read => prepare(read, fixture, plan));
  await save(baselinePath, baseline);
  console.log(JSON.stringify({nodes: baseline.snapshot.nodes.length, missingBounds: baseline.missingBounds.length}));
} else {
  const output = process.env.OMC_BENCH_OUTPUT_DIR;
  assert.ok(command && output && process.env.OMC_BENCH_CANDIDATE);
  const baseline = JSON.parse(await readFile(baselinePath, 'utf8'));
  assert.equal(baseline.snapshot.document_id, fileId);
  assert.deepEqual(baseline.snapshot.selected_native_ids, []);
  assert.equal(baseline.snapshot.nodes.length, 1000);
  assert.deepEqual(baseline.raw.map(({page}) => page.name), plan.pages.map(page => page.neutral_name));
  checkObservedStart(fixture, baseline);
  await withPaper(scope, read => attempt(read, fixture, plan, baseline, command, output));
}
