import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';

import {readStructure, submitImport, ToolError} from './d-real.mjs';

const id = 'e2487336-62d5-4d5a-aed8-9fab07724397';
const revision = {epoch: 'fixture-epoch', sequence: '7'};

function surface(nodes, secondRevision = revision) {
  let index = 0;
  return async (name, args) => {
    if (name === 'open_document') {
      assert.equal(args.id, id);
      return {documentId: id, nativeRevision: revision, pages: [{id: 'a', name: 'Cover'}]};
    }
    assert.equal(name, 'native_query');
    assert.equal(args.limit, 200);
    assert.equal(args.cursor, index === 0 ? undefined : `offset-${index}`);
    const complete = index + 1 === nodes.length;
    return {
      nodes: nodes[index++], revision: index === 1 ? revision : secondRevision,
      complete, cursor: complete ? null : `offset-${index}`,
    };
  };
}

test('checks bounded revision pages and verifies referenced file digests', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'omc-d-real-fixture-'));
  try {
    const bytes = Buffer.from('fake bitmap fixture bytes');
    const hash = createHash('sha256').update(bytes).digest('hex');
    const directory = join(profile, 'native-v1/assets/sha256', hash.slice(0, 2));
    await mkdir(directory, {recursive: true});
    await writeFile(join(directory, hash), bytes);
    const nodes = [
      [{id: 'root', parentId: null, kind: 'frame', properties: {}}],
      [{id: 'leaf', parentId: 'root', kind: 'rect', properties: {fills: [{image: {hash}}]}}],
    ];
    const result = await readStructure(surface(nodes), id, profile);
    assert.deepEqual(result.counts, {pages: 1, objects: 2, bitmapHashes: 1});
    assert.equal(result.differences.objects.delta, 2 - 39_363);
    assert.equal(result.boundedQuery.batches, 2);
    assert.deepEqual(result.verifiedAssetHashes, [hash]);
    assert.equal(result.verifiedAssetBytes, bytes.length);
    assert.equal((await readStructure(surface(nodes), id, profile)).nodeDigest, result.nodeDigest);
  } finally {
    await rm(profile, {recursive: true});
  }
});

test('rejects changed revisions, cycles and duplicate IDs', async () => {
  await assert.rejects(readStructure(surface([
    [{id: 'root', parentId: null, kind: 'frame', properties: {}}],
    [{id: 'leaf', parentId: 'root', kind: 'rect', properties: {}}],
  ], {...revision, sequence: '8'}), id, '/unused'), /changed revision/);
  await assert.rejects(readStructure(surface([
    [{id: 'root', parentId: 'leaf', kind: 'frame', properties: {}}],
    [{id: 'leaf', parentId: 'root', kind: 'rect', properties: {}}],
  ]), id, '/unused'), /Cyclic/);
  await assert.rejects(readStructure(surface([
    [{id: 'root', parentId: null, kind: 'frame', properties: {}}],
    [{id: 'root', parentId: null, kind: 'frame', properties: {}}],
  ]), id, '/unused'), /Duplicate/);
});

test('preserves synchronous resource rejection and async failed job independently', async () => {
  const capacity = {code: 'resource_limit', message: 'background reservation exceeds compute budget'};
  const tooLarge = {code: 'resource_limit', message: 'input must be a bounded regular file'};
  const imports = [];
  const filePath = '/fixture.fig';
  const call = async (name, args) => {
    if (name === 'import_document') {
      assert.deepEqual(args, {format: 'fig', filePath});
      throw new ToolError(name, capacity);
    }
    assert.equal(name, 'native_job');
    if (args.action === 'submit') {
      assert.deepEqual(args.arguments, {format: 'fig', filePath});
      return {jobId: 'fixture-job'};
    }
    assert.equal(args.action, 'status');
    assert.equal(args.jobId, 'fixture-job');
    return {state: 'failed', error: tooLarge, result: null, createdAtMs: 10, finishedAtMs: 12};
  };
  assert.equal(await submitImport(call, filePath, imports, 'import_document'), null);
  assert.equal(await submitImport(call, filePath, imports, 'native_job'), null);
  assert.deepEqual(imports.map(({state, error}) => [state, error]), [
    ['rejected_before_ticket', capacity], ['failed', tooLarge],
  ]);
  assert.equal(imports[1].jobClockMs, 2);
  assert.ok(imports.every(entry => entry.elapsedMs >= 0));
});
