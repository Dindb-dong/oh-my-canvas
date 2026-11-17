import assert from 'node:assert/strict';
import test from 'node:test';
import {clonePlan, createVerificationCopy} from './ld03-clone.mjs';

const source = {fileId: 'original', parentId: 'synthetic-folder',
  name: 'OMC Benchmark • Synthetic CAP Probe • 2026-11-17'};
const scope = {fileId: source.fileId, fileName: source.name, pageId: 'candidate',
  prefix: 'omc-ld03-field-relay-cap-01'};
const pages = [
  {id: 'page-1', name: 'Page 1'},
  {id: 'page-cap', name: 'CAP source/export / paper-cap-next-01'},
  {id: scope.pageId, name: 'LD03 preflight / field-relay-cap-01'},
  ...Array.from({length: 40}, (_, index) => ({id: `legacy-${index}`, name: `LD02 ${index}`})),
];
const inventory = {fileNameMatched: true, fileName: source.name, pages};
const plan = clonePlan(source, inventory, scope, 'atlas-clone-01');
const copied = {fileId: 'verified-copy', name: plan.destination.name, parentId: source.parentId};

test('copies only the approved source to its explicit folder and reads a distinct document', async () => {
  const actions = [];
  const result = await createVerificationCopy(async (name, args) => {
    actions.push([name, args]);
    if (name === 'create_file') return copied;
    const original = args.fileId === source.fileId;
    return {fileName: original ? source.name : copied.name, pages: original ? pages :
      pages.map(row => ({...row, id: 'copy-' + row.id}))};
  }, plan);
  assert.equal(result.status, 'copied-background-readable');
  assert.equal(result.candidatePage.id, 'copy-candidate');
  assert.deepEqual(actions, [
    ['get_basic_info', {fileId: source.fileId}], ['create_file', plan.destination],
    ['get_basic_info', {fileId: copied.fileId}],
  ]);
});

test('does not call create_file after page metadata changed', async () => {
  const actions = [];
  await assert.rejects(createVerificationCopy(async name => {
    actions.push(name);
    return {fileName: source.name, pages: pages.slice(1)};
  }, plan), /inventory changed/);
  assert.deepEqual(actions, ['get_basic_info']);
});

test('keeps the created copy identity on a blocked background read without opening it', async () => {
  const actions = [];
  const result = await createVerificationCopy(async (name, args) => {
    actions.push([name, args]);
    if (name === 'create_file') return copied;
    if (args.fileId === source.fileId) return {fileName: source.name, pages};
    throw Error('File is not open');
  }, plan);
  assert.equal(result.status, 'copied-background-unverified');
  assert.equal(result.copy.fileId, copied.fileId);
  assert.equal(result.blocker, 'File is not open');
  assert.equal(actions.length, 3);
});
