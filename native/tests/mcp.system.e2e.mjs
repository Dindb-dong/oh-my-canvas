// Runs editable design-system workflows with one ordinary OMC stdio configuration.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const target = fileURLToPath(new URL('../target/debug/', import.meta.url));
const suffix = process.platform === 'win32' ? '.exe' : '';
const serviceBinary = process.env.OMC_SERVICE_BINARY ?? join(target, 'omc-service' + suffix);
const cliBinary = process.env.OMC_CLI_BINARY ?? join(target, 'omc-cli' + suffix);
const sdk = process.env.OMC_TEST_SDK_ROOT;
const sdkImport = name => import(sdk
  ? pathToFileURL(join(sdk, 'dist/esm/client', name + '.js')).href
  : '@modelcontextprotocol/sdk/client/' + name + '.js');
const { Client } = await sdkImport('index');
const { StdioClientTransport } = await sdkImport('stdio');

async function service(profile) {
  const child = spawn(serviceBinary, ['--profile', profile, '--port', '0'], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  const exited = once(child, 'exit').catch(error => error);
  let stderr = '';
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
  const stop = async () => {
    if (child.pid && child.exitCode === null && child.signalCode === null) child.kill();
    await exited;
  };
  try {
    for (let attempt = 0; attempt < 200; attempt++) {
      if (!child.pid || child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`service exited before becoming ready: ${stderr}`);
      }
      const descriptor = await readFile(join(profile, 'native-v1/service.json'), 'utf8')
        .then(JSON.parse).catch(() => undefined);
      if (descriptor) {
        const health = await fetch(descriptor.endpoint + '/health', {
          headers: { Authorization: `Bearer ${descriptor.token}` },
          signal: AbortSignal.timeout(250),
        }).catch(() => undefined);
        if (health?.ok) return { stop };
      }
      await delay(25);
    }
    throw new Error(`service startup deadline: ${stderr}`);
  } catch (error) {
    await stop();
    throw error;
  }
}

async function stdio(profile) {
  const client = new Client({ name: 'omc-design-system-e2e', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: cliBinary, args: ['--profile', profile, '--connect-only'], stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
  try {
    await client.connect(transport);
  } catch (error) {
    await transport.close();
    throw new Error(`stdio initialization failed: ${error.message} ${stderr}`, { cause: error });
  }
  async function call(name, args) {
    const result = await client.callTool({ name, arguments: args });
    const payload = result.structuredContent ?? JSON.parse(result.content.find(item => item.type === 'text').text);
    if (result.isError) throw Object.assign(new Error(payload.message ?? JSON.stringify(payload)), payload);
    return payload;
  }
  return { client, call };
}

const raw = result => result.rawIds[0];

test('default OMC stdio edits slots, swaps typed instances and refreshes durable library instances', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'omc-system-sdk-'));
  let runningService;
  let api;
  try {
    runningService = await service(profile);
    api = await stdio(profile);
    const { tools } = await api.client.listTools();
    const actions = name => tools.find(tool => tool.name === name).inputSchema.properties.action.enum;
    for (const action of ['slot_create', 'slot_list', 'slot_insert', 'slot_reset', 'swap']) {
      assert.ok(actions('component').includes(action), action);
    }
    for (const action of ['publish', 'publication', 'link_source', 'check_updates', 'refresh']) {
      assert.ok(actions('libraries').includes(action), action);
    }

    const { documentId: source } = await api.call('create_document', { title: 'Design system source' });
    const { documentId: consumer } = await api.call('create_document', { title: 'Design system consumer' });
    const component = (action, args) => api.call('component', { documentId: source, action, ...args });
    const library = (documentId, action, args) => api.call('libraries', { documentId, action, ...args });
    const frame = async parentId => raw(await api.call('create_shape', {
      documentId: source, type: 'frame', width: 200, height: 90, ...(parentId ? { parentId } : {}),
    }));
    const text = async (parentId, text, y = 0) => raw(await api.call('create_shape', {
      documentId: source, type: 'text', parentId, y, width: 190, height: 24, properties: { text },
    }));
    const definition = async name => raw(await component('create', { id: await frame(), name }));
    const svg = async (documentId, id) => {
      const result = await api.call('export_selection', { documentId, ids: [id], format: 'svg' });
      assert.match(result.content, /<svg[\s>]/);
      return result.content;
    };

    const card = await definition('Slot card');
    const slotFrame = await frame(card);
    await text(slotFrame, 'Default glyph');
    const glyph = await definition('Glyph');
    await text(glyph, 'Replacement glyph');
    const slot = await component('slot_create', { id: slotFrame, name: 'Leading', preferred: [glyph] });
    const cardInstance = raw(await component('instance', { source: card }));
    const slotBefore = (await component('slot_list', { id: cardInstance })).slots[0];
    assert.equal(slotBefore.property, slot.property);
    assert.match(await svg(source, cardInstance), /Default glyph/);
    await assert.rejects(component('slot_insert', {
      id: cardInstance, slot: slot.property, source: card, replace: true,
    }), /cycle/i);
    const replacement = await component('slot_insert', {
      id: cardInstance, slot: slot.property, source: glyph, replace: true,
    });
    assert.equal(replacement.slot, slotBefore.id);
    const slotted = await svg(source, cardInstance);
    assert.match(slotted, /Replacement glyph/);
    assert.doesNotMatch(slotted, /Default glyph/);
    await component('slot_reset', { id: slotBefore.id });
    assert.match(await svg(source, cardInstance), /Default glyph/);

    const typedComponent = async (name, marker) => {
      const id = await definition(name);
      const label = await text(id, 'Default label');
      const markerId = await text(id, marker, 35);
      const { property } = await component('bind', { id, layer: label, name: 'Label', propertyType: 'text' });
      return { id, property: property.id, markerId };
    };
    const first = await typedComponent('First template', 'First marker');
    const second = await typedComponent('Second template', 'Second marker');
    const instance = raw(await component('instance', { source: first.id }));
    await component('set_property', { id: instance, property: first.property, value: 'Typed override' });
    const before = await svg(source, instance);
    assert.match(before, /First marker/);
    assert.match(before, /Typed override/);
    await assert.rejects(component('swap', { id: instance, source: glyph }), { code: 'conflict' });
    assert.equal(await svg(source, instance), before);
    await component('swap', { id: instance, source: second.id });
    const swapped = await svg(source, instance);
    assert.match(swapped, /Second marker/);
    assert.match(swapped, /Typed override/);
    assert.doesNotMatch(swapped, /First marker/);

    const published = (await library(source, 'publish', { description: 'Local design tokens and components' })).publication;
    assert.equal(published.version, 1);
    assert.deepEqual((await library(source, 'publication')).publication, published);
    const linked = await library(consumer, 'link_source', { sourceDocumentId: source, expectedVersion: 1 });
    assert.equal(linked.installedVersion, 1);
    const installed = await library(consumer, 'insert', { id: linked.id, componentId: second.id });
    const libraryInstance = raw(installed);
    const initial = await svg(consumer, libraryInstance);
    assert.match(initial, /Second marker/);
    const check = () => library(consumer, 'check_updates', { id: linked.id });
    assert.equal((await check()).updateAvailable, false);

    await api.call('edit_text', { documentId: source, id: second.markerId, action: 'replace', text: 'Refreshed marker' });
    const next = (await library(source, 'publish')).publication;
    assert.equal(next.id, published.id);
    assert.equal(next.version, 2);
    assert.equal((await check()).updateAvailable, true);
    assert.equal(await svg(consumer, libraryInstance), initial);
    await assert.rejects(library(consumer, 'refresh', { id: linked.id, expectedVersion: 1 }), { code: 'conflict' });
    assert.equal(await svg(consumer, libraryInstance), initial);
    const refresh = await library(consumer, 'refresh', { id: linked.id, expectedVersion: 2 });
    assert.equal(refresh.id, linked.id);
    assert.equal(refresh.installedVersion, 2);
    const refreshed = await svg(consumer, libraryInstance);
    assert.match(refreshed, /Refreshed marker/);
    assert.doesNotMatch(refreshed, /Second marker/);
    await api.call('save_document', { id: consumer });

    await api.client.close();
    api = undefined;
    await runningService.stop();
    runningService = await service(profile);
    api = await stdio(profile);
    await api.call('open_document', { id: consumer });
    assert.equal(await svg(consumer, libraryInstance), refreshed);
    assert.equal((await check()).installedVersion, 2);
    assert.equal((await check()).updateAvailable, false);
  } finally {
    await api?.client.close();
    await runningService?.stop();
    await rm(profile, { recursive: true, force: true });
  }
});
