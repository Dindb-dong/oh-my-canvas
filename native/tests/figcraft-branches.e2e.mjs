import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const sdk = process.env.OMC_TEST_SDK_ROOT;
const { Client } = await import(sdk
  ? pathToFileURL(join(sdk, 'dist/esm/client/index.js'))
  : '@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = await import(sdk
  ? pathToFileURL(join(sdk, 'dist/esm/client/streamableHttp.js'))
  : '@modelcontextprotocol/sdk/client/streamableHttp.js');
const binaryName = process.platform === 'win32' ? 'omc-service.exe' : 'omc-service';
const binary = process.env.OMC_SERVICE_BINARY
  ?? fileURLToPath(new URL('../target/debug/' + binaryName, import.meta.url));

async function serviceDescriptor(profile, service) {
  for (let attempt = 0; attempt < 200 && service.exitCode === null; attempt++) {
    try {
      return JSON.parse(await readFile(join(profile, 'native-v1/service.json'), 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await delay(25);
  }
  throw new Error('Timed out waiting for the native service descriptor');
}

test('FigCraft branches resolve conflicts in durable native documents and merge as one Undo', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'omc-figcraft-branches-'));
  let service;
  let exited;
  let client;
  const start = async () => {
    service = spawn(binary, ['--profile', profile, '--port', '0'], { stdio: 'inherit' });
    exited = once(service, 'exit');
    const { endpoint, token } = await serviceDescriptor(profile, service);
    client = new Client({ name: 'figcraft-branches', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(endpoint + '/mcp/figcraft'), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }));
  };
  const stop = async () => {
    await client?.close();
    if (service?.exitCode === null && service?.signalCode === null) service.kill();
    if (exited) await exited;
    await rm(join(profile, 'native-v1/service.json'), { force: true });
  };
  const call = async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args });
    if (result.isError) throw new Error(result.content[0].text);
    return result.structuredContent ?? JSON.parse(result.content.find(item => item.type === 'text').text);
  };
  const run = (command, params = {}, document) =>
    call('run_command', { command, params, ...(document ? { document } : {}) });
  const create = (name, x = 10) =>
    call('create_node', { type: 'rectangle', name, x, y: 20, width: 40, height: 20, props: { fill: '#336699' } });
  const find = async name => (await call('inspect_document')).layers.find(layer => layer.name === name);
  const set = (id, props) => run('node.set', { ids: [id], props });
  try {
    await start();
    const { id: main } = await run('file.new', { name: 'Main design' });
    const { id: shared } = await create('Shared');
    await create('To delete', 140);
    const branch = await run('branch.create', { name: 'Experiment' });
    assert.equal(branch.index, 1);
    assert.equal((await run('doc.list'))[1].name, 'Experiment');
    assert.equal((await run('branch.list'))[0].state, 'active');
    await set((await find('Shared')).id, { width: 80 });
    await create('Branch addition', 100);
    await run('edit.delete', { ids: [(await find('To delete')).id] });
    await run('doc.switch', { index: 0 });
    await set(shared, { width: 100, x: 34 });
    const review = await run('branch.review', { id: branch.id });
    const [conflict] = review.conflicts;
    assert.equal(conflict.property, 'width');
    assert.equal(conflict.branch, 80);
    assert.equal(conflict.main, 100);
    assert.equal(review.branch.layers.length, 3);
    assert.equal(review.main.layers.length, 1);
    const blocked = await run('branch.updateFromMain', { id: branch.id });
    assert.equal(blocked.updated, false);
    assert.equal(blocked.conflicts[0].key, conflict.key);
    assert.equal((await find('Shared')).width, 100);
    assert.equal(await find('Branch addition'), undefined);
    const updated = await run('branch.updateFromMain', {
      id: branch.id, resolutions: { [conflict.key]: 'branch' },
    });
    assert.equal(updated.updated, true);
    assert.equal((await run('branch.review', { id: branch.id })).conflicts.length, 0);
    const opened = await run('branch.open', { id: branch.id });
    assert.equal(opened.index, 1);
    assert.equal((await find('Shared')).width, 80);
    assert.equal((await find('Shared')).x, 34);
    assert.ok(await find('Branch addition'));
    assert.equal(await find('To delete'), undefined);
    assert.equal((await run('version.list'))[0].name, 'Update from main');
    await assert.rejects(call('undo'), /no Undo history/);
    const merged = await run('branch.merge');
    assert.equal(merged.merged, true);
    assert.equal(merged.index, 0);
    assert.deepEqual((await run('doc.list')).map(tab => tab.id), [main]);
    assert.equal((await find('Shared')).width, 80);
    assert.equal((await find('Shared')).x, 34);
    assert.ok(await find('Branch addition'));
    assert.equal(await find('To delete'), undefined);
    await call('undo');
    assert.equal((await find('Shared')).width, 100);
    assert.equal(await find('Branch addition'), undefined);
    assert.ok(await find('To delete'));
    await call('redo');
    assert.equal((await find('Shared')).width, 80);
    assert.ok(await find('Branch addition'));

    const abandoned = await run('branch.create', { name: 'Abandoned' });
    await create('Draft only', 300);
    await run('branch.archive');
    assert.deepEqual((await run('branch.list')).map(item => item.state), ['merged', 'archived']);
    assert.equal(await find('Draft only'), undefined);
    await stop();
    await start();
    const rows = await run('branch.list', {}, main);
    assert.deepEqual(rows.map(({ id, state }) => [id, state]), [
      [branch.id, 'merged'], [abandoned.id, 'archived'],
    ]);
    await run('branch.open', { id: abandoned.id }, main);
    assert.ok(await find('Draft only'));
    assert.ok(await find('Branch addition'));
  } finally {
    await stop();
    await rm(profile, { recursive: true, force: true });
  }
});
