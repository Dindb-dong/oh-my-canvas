import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

import {fixture, target as edit} from './ld02-fixture.mjs';
import {Client, StreamableHTTPClientTransport} from './mcp.mjs';

const [mode, extra] = process.argv.slice(2);
assert.ok(extra === undefined && [undefined, '--seed-only', '--verify-only'].includes(mode),
  'Usage: node paper-ld02.mjs [--seed-only | --verify-only]');
const fileId = process.env.PAPER_BENCH_FILE_ID;
const expectedName = process.env.PAPER_BENCH_FILE_NAME;
const runId = process.env.PAPER_BENCH_RUN_ID ?? randomUUID();
assert.ok(fileId?.trim() && expectedName?.trim(), 'Set PAPER_BENCH_FILE_ID and PAPER_BENCH_FILE_NAME');
assert.ok(mode !== '--verify-only' || process.env.PAPER_BENCH_RUN_ID, 'Verification requires PAPER_BENCH_RUN_ID');
assert.match(runId, /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}$/);
const endpoint = new URL(process.env.PAPER_BENCH_URL ?? 'http://127.0.0.1:29979/mcp');
assert.ok(endpoint.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname),
  'Paper replay requires the local HTTP MCP endpoint');
assert.ok(!endpoint.username && !endpoint.password && !endpoint.search && !endpoint.hash,
  'Paper endpoint must not carry credentials or selectors');

const pagePrefix = `LD02 ${runId} / `;
const client = new Client({name: 'paper-ld02-replay', version: '1'});
const workingNodes = new Set();
const toolCalls = [];

async function call(name, args = {}) {
  const started = performance.now();
  const result = await client.callTool({name, arguments: {...args, fileId}}, undefined, {timeout: 30_000});
  const raw = result.content.filter(block => block.type === 'text').at(-1)?.text ?? '';
  toolCalls.push({name, durationMs: performance.now() - started, responseTextBytes: Buffer.byteLength(raw)});
  let data = raw;
  try {
    data = JSON.parse(raw);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
  }
  assert.ok(!result.isError && !data?.error, `Paper tool failed: ${name}`);
  return data;
}

const inlineCard = card => {
  const [label, reference, swatch] = card.children;
  const textStyle = 'font-family:Inter;font-size:16px;line-height:20px';
  const position = `position:absolute;left:${card.x}px;top:${card.y}px`;
  const size = `box-sizing:border-box;width:${card.width}px;height:${card.height}px`;
  const layout = `padding:${card.padding}px;display:flex;flex-direction:column;align-items:flex-start;gap:${card.gap}px`;
  return `<div style="${position};${size};${layout};background-color:#ffffff"><div style="${textStyle}">${label.text}</div><div style="${textStyle}">${reference.text}</div><div style="width:${swatch.width}px;height:${swatch.height}px;flex-shrink:0;background-color:${swatch.fill}"></div></div>`;
};

async function locate() {
  const {pages} = await call('get_basic_info');
  const page = pages.find(candidate => candidate.name === pagePrefix + edit.page);
  assert.ok(page, 'Paper target page is absent');
  const {rootNodeId} = await call('get_basic_info', {pageId: page.id});
  const {children: cards} = await call('get_children', {nodeId: rootNodeId});
  const matches = cards.filter(card => card.name === edit.card);
  assert.equal(matches.length, 1, 'Expected exactly one target card');
  const [card] = matches;
  const {children} = await call('get_children', {nodeId: card.id});
  assert.equal(children.length, 3);
  const [label, reference, swatch] = children;
  return {card, label, reference, swatch};
}

async function verify({card, label, reference, swatch}, expected) {
  const labelNode = await call('get_node_info', {nodeId: label.id});
  const referenceNode = await call('get_node_info', {nodeId: reference.id});
  const {styles} = await call('get_computed_styles', {nodeIds: [card.id, swatch.id]});
  assert.equal(labelNode.textContent, expected.text);
  assert.equal(referenceNode.textContent, edit.before.reference);
  assert.equal(styles[card.id].gap, `${expected.gap}px`);
  assert.equal(styles[swatch.id].backgroundColor.toLowerCase(), expected.fill);
}

try {
  await client.connect(new StreamableHTTPClientTransport(endpoint), {timeout: 10_000});
  await call('get_guide', {topic: 'paper-mcp-instructions'});
  const home = await call('get_basic_info');
  assert.equal(home.fileName === expectedName, true, 'Paper file name does not match the designated synthetic canvas');
  // The active page can change while this client targets a file by ID.
  let hasControlScene = home.artboards.some(board => board.name === 'CAP Editable Scene');
  for (const page of home.pages) {
    if (hasControlScene) break;
    const {artboards} = await call('get_basic_info', {pageId: page.id});
    hasControlScene = artboards.some(board => board.name === 'CAP Editable Scene');
  }
  assert.ok(hasControlScene, 'Designated file lacks the synthetic CAP Editable Scene');

  if (mode !== '--verify-only') {
    assert.ok(!home.pages.some(page => page.name.startsWith(pagePrefix)),
      'Run ID already exists in Paper; choose a fresh run ID');
    await call('get_font_family_info', {familyNames: ['Inter']});
    for (const page of fixture.pages) {
      const created = await call('create_page', {name: pagePrefix + page.name});
      const pageId = created.id ?? created.pageId;
      assert.ok(pageId, 'Paper did not return a page ID');
      const {rootNodeId} = await call('get_basic_info', {pageId});
      assert.ok(rootNodeId, 'Paper did not return a page root');
      await call('write_html', {
        targetNodeId: rootNodeId, mode: 'insert-children', html: page.children.map(inlineCard).join(''),
      });
      const {children} = await call('get_children', {nodeId: rootNodeId});
      assert.equal(children.length, page.children.length);
      children.forEach(node => workingNodes.add(node.id));
      await call('rename_nodes', {
        updates: children.map((node, index) => ({nodeId: node.id, name: page.children[index].name})),
      });
      const {children: renamed} = await call('get_children', {nodeId: rootNodeId});
      assert.deepEqual(renamed.map(node => node.name), page.children.map(card => card.name));
    }
  }

  let editReadbackMs = null;
  if (mode !== '--seed-only') {
    const started = performance.now();
    const found = await locate();
    if (mode === '--verify-only') {
      await verify(found, edit.after);
    } else {
      await verify(found, edit.before);
      const {card, label, swatch} = found;
      for (const node of [card, label, swatch]) workingNodes.add(node.id);
      await call('set_text_content', {updates: [{nodeId: label.id, html: edit.after.text}]});
      await call('update_styles', {updates: [
        {nodeIds: [card.id], styles: {gap: `${edit.after.gap}px`}},
        {nodeIds: [swatch.id], styles: {backgroundColor: edit.after.fill}},
      ]});
      await verify(found, edit.after);
      editReadbackMs = performance.now() - started;
    }
  }
  console.log(JSON.stringify({
    workload: fixture.workload,
    measurement: mode === '--seed-only' ? 'seed-only' : mode === '--verify-only' ? 'scoped-verification' : 'deterministic-replay',
    pagePrefix,
    editReadbackMs,
    pages: fixture.pages.length,
    logicalObjects: fixture.logicalObjects,
    toolCalls,
  }));
} finally {
  try {
    if (workingNodes.size) {
      await call('finish_working_on_nodes', {nodeIds: [...workingNodes]});
    }
  } finally {
    await client.close();
  }
}
