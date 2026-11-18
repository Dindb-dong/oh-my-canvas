import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const sdk = process.env.OMC_TEST_SDK_ROOT;
const { Client } = await import(sdk
  ? pathToFileURL(join(sdk, 'dist/esm/client/index.js')).href
  : '@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = await import(sdk
  ? pathToFileURL(join(sdk, 'dist/esm/client/stdio.js')).href
  : '@modelcontextprotocol/sdk/client/stdio.js');
const target = fileURLToPath(new URL('../target/debug/', import.meta.url));
const extension = process.platform === 'win32' ? '.exe' : '';
const serviceBinary = process.env.OMC_SERVICE_BINARY ?? join(target, 'omc-service' + extension);
const cliBinary = process.env.OMC_CLI_BINARY ?? join(target, 'omc-cli' + extension);

async function withService(profile, check) {
  const child = spawn(serviceBinary, ['--profile', profile, '--port', '0'], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  const closed = once(child, 'close');
  let stderr = '';
  child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-2000); });
  const clients = [];
  try {
    let ready = false;
    for (let attempt = 0; attempt < 200 && child.exitCode === null; attempt++) {
      try {
        const descriptor = JSON.parse(await readFile(join(profile, 'native-v1/service.json'), 'utf8'));
        const response = await fetch(descriptor.endpoint + '/health', {
          headers: { Authorization: `Bearer ${descriptor.token}` },
          signal: AbortSignal.timeout(1000),
        });
        ready = response.ok;
        if (ready) break;
      } catch {}
      await delay(25);
    }
    assert.ok(ready, `Native service startup failed ${stderr}`);
    const connect = async name => {
      const client = new Client({ name, version: '1.0.0' });
      clients.push(client);
      await client.connect(new StdioClientTransport({
        command: cliBinary,
        args: ['--profile', profile, '--connect-only'],
        stderr: 'inherit',
      }));
      return {
        client,
        async call(tool, args) {
          const response = await client.callTool({ name: tool, arguments: args });
          const value = response.structuredContent
            ?? JSON.parse(response.content.find(item => item.type === 'text').text);
          if (response.isError) {
            throw Object.assign(new Error(`${tool} ${value.message ?? JSON.stringify(value)}`), value);
          }
          return value;
        },
      };
    };
    return await check(connect);
  } finally {
    await Promise.allSettled(clients.map(client => client.close()));
    child.kill();
    await closed;
  }
}

const solid = color => [{ type: 'solid', color }];

test('default OMC stdio replays fixed-clock prototypes and exports a persistent deck with a live layout', async () => {
  await Promise.all([access(serviceBinary), access(cliBinary)]);
  const profile = await mkdtemp(join(tmpdir(), 'omc-native-presentation-'));
  try {
    const fixture = await withService(profile, async connect => {
      const { client, call } = await connect('presentation-author');
      const { tools } = await client.listTools();
      const names = new Set(tools.map(tool => tool.name));
      for (const name of ['prototype', 'component', 'export_document', 'native_result']) {
        assert.ok(names.has(name), name);
      }
      assert.ok(!names.has('run_command'));
      const { documentId } = await call('create_document', { title: 'OMC presentation SDK fixture' });
      const board = async (name, width, height) => {
        const { rawIds: [id] } = await call('create_board', { documentId, name, width, height });
        assert.ok(id);
        return id;
      };
      const home = await board('Opening', 160, 90);
      const overlay = await board('Details overlay', 200, 120);
      const next = await board('Next steps', 240, 140);
      const template = await board('Layout source', 150, 80);
      const { id: variable } = await call('native_tokens', {
        version: '1', action: 'create', documentId, name: 'Show details', type: 'boolean', value: false,
      });
      assert.ok(variable);
      const prototype = args => call('prototype', { documentId, ...args });
      const { flow } = await prototype({ action: 'set_flow', frameId: home, name: 'Open the deck' });
      assert.equal(flow.start, home);
      const interactions = async (sourceId, entries) => {
        const result = await prototype({ action: 'set_interactions', sourceId, interactions: entries });
        assert.equal(result.receipt.status, 'durable');
        return result.interactions;
      };
      const stored = await interactions(home, [{
        trigger: 'onClick', transition: 'dissolve', durationMs: 120, delayMs: 20,
        actions: [
          { type: 'setVariable', variable, value: true },
          { type: 'conditional', blocks: [
            { condition: { value: { type: 'alias', value: variable } },
              actions: [{ type: 'openOverlay', dest: overlay, anchor: 'screen' }] },
            { actions: [{ type: 'navigate', dest: next }] },
          ] },
        ],
      }]);
      await interactions(overlay, [{ trigger: 'onClick', actions: [{ type: 'navigate', dest: next }] }]);
      await interactions(next, [{ trigger: { type: 'afterDelay', ms: 40 }, actions: [{ type: 'back' }] }]);

      await call('create_shape', {
        documentId, type: 'rect', parentId: template, width: 100, height: 10,
        properties: { fills: solid('#cc3366') },
      });
      const { rawIds: [layout, layoutBar] } = await call('component', {
        documentId, action: 'create', id: template, name: 'Shared layout',
      });
      assert.ok(layout && layoutBar);
      const applied = await prototype({
        action: 'set_deck', frameIds: [home, overlay, next], layoutComponentId: layout,
      });
      assert.equal(applied.receipt.status, 'durable');
      assert.equal(Object.keys(applied.layoutInstanceIds).length, 3);
      const reordered = await prototype({ action: 'set_deck', frameIds: [next, home, overlay] });
      assert.deepEqual(reordered.layoutInstanceIds, applied.layoutInstanceIds);

      const ref = from => ({ from, field: 'id' });
      const { documentId: batchDocument } = await call('create_document', { title: 'Named prototype targets' });
      const batch = await call('batch', { documentId: batchDocument, ops: [
        { tool: 'create_shape', as: 'firstSlide', args: { type: 'frame', width: 100, height: 100 } },
        { tool: 'create_shape', as: 'lastSlide', args: { type: 'frame', width: 100, height: 100 } },
        { tool: 'prototype', args: { action: 'set_deck', frameIds: [ref('firstSlide'), ref('lastSlide')] } },
        { tool: 'prototype', args: { action: 'set_interactions', sourceId: ref('firstSlide'), interactions: [
          { trigger: 'onClick', actions: [{ type: 'conditional', blocks: [
            { expression: 'true', actions: [{ type: 'navigate', dest: ref('lastSlide') }] },
            { actions: [{ type: 'navigate', dest: ref('lastSlide') }] },
          ] }] },
        ] } },
      ] });
      const firstSlide = batch.namedResults.firstSlide.id;
      const lastSlide = batch.namedResults.lastSlide.id;
      const batchInteractions = (await call('prototype', {
        documentId: batchDocument, action: 'inspect', sourceId: firstSlide,
      })).interactions;
      assert.equal(batchInteractions[0].actions[0].blocks[0].actions[0].dest, lastSlide);
      const batchDeck = await call('prototype', { documentId: batchDocument, action: 'inspect_deck' });
      assert.deepEqual(batchDeck.frameIds, [firstSlide, lastSlide]);

      await call('edit_shapes', {
        documentId, action: 'patch', ids: [layoutBar], properties: { fills: solid('#6633cc') },
      });
      return { documentId, home, overlay, next, variable, flow, stored, layout, layoutInstances: applied.layoutInstanceIds };
    });

    await withService(profile, async connect => {
      const { documentId, home, overlay, next, variable, flow, stored, layout, layoutInstances } = fixture;
      const { call } = await connect('presentation-reviewer');
      await call('open_document', { id: documentId });
      const prototype = args => call('prototype', { documentId, ...args });
      const { flows, interactions } = await prototype({ action: 'inspect', sourceId: home });
      assert.deepEqual(flows, [flow]);
      assert.deepEqual(interactions, stored);
      const click = (atMs, sourceId) => ({ atMs, sourceId, trigger: 'onClick' });
      const play = (events, options = {}) => prototype({
        action: 'preview_playback', frameId: home, events, ...options,
      });
      const input = [click(0, home), { atMs: 19 }, { atMs: 20 }];
      const before = await call('get_tree', { documentId });
      const preview = await play(input, { untilMs: 25, render: true });
      assert.equal(preview.steps[1].overlayId, null);
      assert.equal(preview.steps[2].overlayId, overlay);
      assert.equal(preview.frameId, home);
      assert.equal(preview.variables[variable], true);
      for (const [image, width, height] of [[preview.frameImage, 160, 90], [preview.overlayImage, 200, 120]]) {
        const png = await call('native_result', { version: '1', resultId: image.resultId });
        assert.equal(png.mimeType, 'image/png');
        const bytes = Buffer.from(png.base64, 'base64');
        assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
        assert.equal(bytes.readUInt32BE(16), width);
        assert.equal(bytes.readUInt32BE(20), height);
      }
      const completed = await play([...input, click(25, overlay), { atMs: 64 }, { atMs: 65 }]);
      assert.deepEqual(completed.steps[4].history, [home]);
      assert.equal(completed.steps[4].frameId, next);
      assert.equal(completed.steps[5].frameId, home);
      assert.equal(completed.overlayId, null);
      assert.deepEqual(completed.history, []);
      const fresh = await play([], { untilMs: 65 });
      assert.equal(fresh.frameId, home);
      assert.equal(fresh.overlayId, null);
      assert.deepEqual(fresh.variables, {});
      assert.deepEqual(fresh.documentRevision, preview.documentRevision);
      assert.equal((await call('get_tree', { documentId })).revision, before.revision);

      const deck = await prototype({ action: 'inspect_deck' });
      assert.deepEqual(deck.frameIds, [next, home, overlay]);
      assert.deepEqual(deck.layoutInstanceIds, layoutInstances);
      assert.equal(deck.layoutComponentId, layout);
      for (const id of deck.frameIds) {
        const { content } = await call('export_selection', { documentId, format: 'svg', ids: [id] });
        assert.match(content, /fill="#(?:63c|6633cc)"/i);
        assert.doesNotMatch(content, /fill="#(?:c36|cc3366)"/i);
      }
      const pdf = await call('export_document', { id: documentId, format: 'pdf', pdfFrameIds: deck.frameIds });
      assert.equal(pdf.mimeType, 'application/pdf');
      assert.equal(pdf.pages, 3);
      const contents = Buffer.from(pdf.base64, 'base64').toString('latin1');
      assert.match(contents, /^%PDF-/);
      assert.deepEqual([...contents.matchAll(/\/MediaBox \[0 0 (\d+) (\d+)\]/g)]
        .map(match => match.slice(1).map(Number)), [[240, 140], [160, 90], [200, 120]]);
    });
  } finally {
    await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
