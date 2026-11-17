import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';

const syntheticName = 'OMC Benchmark • Synthetic CAP Probe • 2026-11-17';
const pageIdentity = pages => pages.map(({id, name}) => ({id, name})).sort((a, b) => a.id.localeCompare(b.id));
const pageNames = pages => pages.map(page => page.name).sort();

export function clonePlan(source, inventory, scope, runId) {
  assert.equal(source.name, syntheticName);
  assert.equal(scope.fileName, source.name);
  assert.equal(scope.fileId, source.fileId);
  assert.equal(inventory.fileNameMatched, true);
  assert.equal(inventory.fileName, source.name);
  assert.match(runId, /^[a-z0-9][a-z0-9-]{7,31}$/);
  assert.match(source.fileId, /^[-\w]+$/);
  assert.match(source.parentId, /^[-\w]+$/);
  assert.equal(inventory.pages.length, 43, 'Unexpected approved canvas page count');
  assert.equal(new Set(inventory.pages.map(page => page.id)).size, inventory.pages.length);
  const legacy = inventory.pages.filter(page => page.name.startsWith('LD02 '));
  assert.equal(legacy.length, 40, 'Unexpected legacy fixture pages');
  assert.deepEqual(pageNames(inventory.pages.filter(page => !page.name.startsWith('LD02 '))),
    ['CAP source/export / paper-cap-next-01', 'LD03 preflight / field-relay-cap-01', 'Page 1']);
  const found = inventory.pages.filter(page => page.id === scope.pageId);
  assert.equal(found.length, 1);
  assert.equal(found[0].name, 'LD03 preflight / field-relay-cap-01');
  assert.equal(scope.prefix, 'omc-ld03-field-relay-cap-01');
  return {
    sourceFileId: source.fileId, sourceFileName: source.name, sourcePages: pageIdentity(inventory.pages),
    candidatePageName: found[0].name,
    destination: {cloneFileId: source.fileId, parentId: source.parentId, name: `OMC Benchmark LD03 verification / ${runId}`},
  };
}

export async function createVerificationCopy(call, plan) {
  const original = await call('get_basic_info', {fileId: plan.sourceFileId});
  assert.equal(original.fileName, plan.sourceFileName);
  assert.deepEqual(pageIdentity(original.pages), plan.sourcePages, 'Source page inventory changed since approval');
  const copy = await call('create_file', plan.destination);
  assert.match(copy.fileId, /^[-\w]+$/);
  assert.notEqual(copy.fileId, plan.sourceFileId, 'Paper did not return a separate file');
  assert.equal(copy.name, plan.destination.name);
  assert.equal(copy.parentId, plan.destination.parentId);
  try {
    const home = await call('get_basic_info', {fileId: copy.fileId});
    assert.equal(home.fileName, copy.name);
    assert.deepEqual(pageNames(home.pages), pageNames(plan.sourcePages), 'Copied pages differ from source catalog');
    const candidate = home.pages.filter(page => page.name === plan.candidatePageName);
    assert.equal(candidate.length, 1);
    return {copy, candidatePage: candidate[0], status: 'copied-background-readable'};
  } catch (error) {
    return {copy, status: 'copied-background-unverified', blocker: error.message};
  }
}

async function live(plan) {
  const {Client, StreamableHTTPClientTransport} = await import('../replays/mcp.mjs');
  const client = new Client({name: 'paper-ld03-background-verification-copy', version: '1'});
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:29979/mcp')), {timeout: 10000});
    const listing = await client.listTools();
    const tool = listing.tools.find(row => row.name === 'create_file');
    assert.equal(tool?.inputSchema?.properties?.cloneFileId?.type, 'string');
    const guide = await client.callTool({name: 'get_guide', arguments: {topic: 'paper-mcp-instructions'}},
      undefined, {timeout: 15000});
    assert.ok(!guide.isError);
    return await createVerificationCopy(async (name, args) => {
      const response = await client.callTool({name, arguments: args}, undefined, {timeout: 30000});
      const blocks = response.content.filter(row => row.type === 'text').map(row => row.text);
      assert.ok(!response.isError, `Paper ${name} could not complete: ${blocks.at(-1) ?? 'no text'}`);
      if (name === 'get_basic_info') assert.ok(blocks.slice(0, -1).some(text => text.includes(args.fileId)));
      const body = JSON.parse(blocks.at(-1));
      assert.ok(!body.error, `Paper returned an in-band error for ${name}`);
      return body;
    }, plan);
  } finally {
    await client.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [action, sourcePath, inventoryPath, scopePath, runId] = process.argv.slice(2);
  assert.ok(['plan', 'clone'].includes(action) && sourcePath && inventoryPath && scopePath && runId,
    'Usage: ld03-clone.mjs plan|clone APPROVED_FILE.json PAGE_INVENTORY.json SCOPE.json RUN_ID');
  const load = file => JSON.parse(readFileSync(file, 'utf8'));
  const plan = clonePlan(load(sourcePath), load(inventoryPath), load(scopePath), runId);
  const output = action === 'plan' ? plan : await live(plan);
  console.log(JSON.stringify(output));
  if (output.blocker) process.exitCode = 1;
}
