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

test('FigCraft catalog commands render changes and persist components, styles, variables, and comments', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'omc-figcraft-catalog-'));
  const service = spawn(binary, ['--profile', profile, '--port', '0'], { stdio: 'inherit' });
  const exited = once(service, 'exit');
  const fig = new Client({ name: 'figcraft-catalog-contracts', version: '1.0.0' });
  const omc = new Client({ name: 'native-catalog-contracts', version: '1.0.0' });
  const call = async (client, name, args = {}) => {
    const result = await client.callTool({ name, arguments: args });
    if (result.isError) throw new Error(result.content[0].text);
    return result.structuredContent ?? JSON.parse(result.content.find(item => item.type === 'text').text);
  };
  const run = (command, params = {}) => call(fig, 'run_command', { command, params });
  const get = id => call(fig, 'get_node', { id });
  const svg = async id => (await run('file.exportSvg', { ids: [id] })).content;
  const create = (type, name, x, y, parent) =>
    call(fig, 'create_node', { type, name, x, y, width: 50, height: 35, parent, props: { fill: '#ff0000' } });

  try {
    const { endpoint, token } = await serviceDescriptor(profile, service);
    const connect = (client, path) => client.connect(new StreamableHTTPClientTransport(new URL(endpoint + path), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }));
    await connect(fig, '/mcp/figcraft');
    await connect(omc, '/mcp');
    const { id: documentId } = await run('file.new', { name: 'FigCraft catalogs' });
    const { id: rectangle } = await create('rectangle', 'Accent', 10, 20);

    const { id: style } = await run('style.create', { type: 'paint', name: 'Brand/Accent', value: '#142536' });
    await run('style.apply', { ids: [rectangle], style });
    assert.match(await svg(rectangle), /#142536/i);
    await run('style.update', { style, value: '#253647' });
    assert.match(await svg(rectangle), /#253647/i);
    const { id: copy } = await run('style.duplicate', { style });
    await run('style.renameFolder', { folder: 'Brand', name: 'Palette' });
    const styles = await run('style.list', { type: 'paint' });
    assert.equal(styles.find(entry => entry.id === copy).name, 'Palette/Accent copy');
    await run('style.detach', { ids: [rectangle], which: 'fill' });
    await run('style.apply', { ids: [rectangle], style: copy });
    await run('style.delete', { style: copy });
    assert.match(await svg(rectangle), /#253647/i);
    assert.equal((await run('style.list')).length, 1);

    const { id: collection } = await run('variable.createCollection', { name: 'Palette', modes: ['Day', 'Night'] });
    const { id: variable } = await run('variable.create', {
      collection, name: 'Accent', type: 'color', values: { Day: '#112233', Night: '#aabbcc' },
    });
    const { id: alias } = await run('variable.create', {
      collection, name: 'Alias', type: 'color', value: { alias: variable },
    });
    await assert.rejects(run('variable.set', { variable, value: { alias } }), /cycle/);
    await run('variable.bind', { ids: [rectangle], field: 'fill', variable: alias });
    assert.match(await svg(rectangle), /fill="#(?:112233|123)"/i);
    await run('variable.set', { variable, mode: 'Day', value: '#445566' });
    assert.match(await svg(rectangle), /fill="#(?:445566|456)"/i);
    const { id: dusk } = await run('variable.addMode', { collection, name: 'Dusk', from: 'Night' });
    await run('variable.renameMode', { collection, mode: dusk, name: 'Twilight' });
    await run('variable.renameCollection', { collection, name: 'Modes' });
    const { id: duplicate } = await run('variable.duplicate', { variable });
    await run('variable.update', { variable: duplicate, description: 'Copied modes' });
    const vars = await run('variable.list');
    assert.equal(vars.collections[0].name, 'Modes');
    assert.equal(vars.collections[0].modes.find(mode => mode.id === dusk).name, 'Twilight');
    assert.equal(vars.variables.find(entry => entry.id === duplicate).values[dusk], '#aabbcc');
    await run('variable.bind', { ids: [rectangle], field: 'fill', variable: null });
    await run('variable.set', { variable, value: '#123456' });
    assert.match(await svg(rectangle), /fill="#(?:445566|456)"/i);

    await run('style.bind', { style, field: 'fill', variable: alias });
    await run('style.apply', { ids: [rectangle], style });
    assert.match(await svg(rectangle), /fill="#(?:123456|123)"/i);
    await run('style.bind', { style, field: 'fill', variable: null });
    await run('variable.set', { variable, value: '#654321' });
    assert.match(await svg(rectangle), /#123456/i);
    const { id: orderedStyle } = await run('style.create', { type: 'paint', name: 'New', value: '#523414' });
    await run('style.move', { styles: [orderedStyle], before: style, folder: 'Palette' });
    assert.equal((await run('style.list'))[0].name, 'Palette/New');

    const { id: source } = await create('frame', 'Forms/Card', 100, 110);
    const { id: modeChild } = await create('rectangle', 'Modes', 3, 5, source);
    const { id: widthVariable } = await run('variable.create', {
      collection, name: 'Width', type: 'number', values: { Day: 50, Night: 85, Twilight: 70 },
    });
    await run('variable.bind', { ids: [modeChild], field: 'width', variable: widthVariable });
    assert.match(await svg(modeChild), /width="50"/);
    await run('variable.setMode', { ids: [source], collection, mode: 'Twilight' });
    assert.match(await svg(modeChild), /width="70"/);
    await run('variable.setMode', { ids: [source], collection, mode: null });
    await run('variable.moveMode', { collection, mode: 'Twilight', to: 0 });
    assert.match(await svg(modeChild), /width="70"/);
    await run('variable.removeMode', { collection, mode: 'Twilight' });
    assert.match(await svg(modeChild), /width="50"/);
    await run('variable.bind', { ids: [modeChild], field: 'width', variable: null });
    await run('variable.set', { variable: widthVariable, value: 64 });
    assert.match(await svg(modeChild), /width="50"/);
    await run('edit.delete', { ids: [modeChild] });
    const { id: child } = await create('rectangle', 'Inside', 3, 5, source);
    const { id: component } = await run('component.create', { ids: [source] });
    assert.equal((await get(component)).children[0].id, child);
    const { id: instance } = await run('instance.create', { component, x: 240, y: 110 });
    const { id: selectedMain } = await run('component.goToMain', { id: instance });
    assert.equal(selectedMain, component);
    assert.equal((await run('component.list')).find(entry => entry.id === component).instances, 1);
    const { ids: [replacement] } = await run('component.createMultiple', { ids: [rectangle] });
    await run('instance.swap', { ids: [instance], component: replacement });
    await run('component.resetInstance', { ids: [instance] });
    assert.equal((await run('component.goToMain', { id: instance })).id, replacement);
    await run('component.detach', { ids: [instance] });
    assert.equal((await get(instance)).children.length, 1);
    await assert.rejects(run('component.goToMain', { id: instance }), /no live component/);

    const { id: thread, link } = await run('comment.add', { x: 105, y: 120, anchor: component, text: '검토해 주세요' });
    assert.equal((await run('comment.link', { id: thread })).link, link);
    assert.equal((await run('comment.reply', { link, text: '수정했습니다' })).reply, 0);
    await run('comment.edit', { id: thread, reply: 0, text: '수정 완료' });
    assert.equal((await run('comment.react', { id: thread, emoji: '👍' })).on, true);
    assert.ok((await run('comment.people')).people.length);
    await run('comment.resolve', { id: thread });
    const resolved = (await run('comment.list', { filter: 'resolved', query: '완료' })).comments[0];
    assert.equal(resolved.id, thread);
    assert.equal(resolved.anchor, component);
    assert.equal(resolved.replies[0].text, '수정 완료');
    assert.equal(resolved.reactions[0].emoji, '👍');
    await run('comment.move', { id: thread, x: 51, y: 63, anchor: false });
    assert.equal((await run('comment.list')).comments[0].x, 51);
    await run('comment.delete', { id: thread, reply: 0 });
    assert.deepEqual((await run('comment.list')).comments[0].replies, []);
    await run('comment.delete', { id: thread });
    assert.deepEqual((await run('comment.list')).comments, []);

    const librarySnapshot = {
      name: 'Imported native library',
      version: 1,
      objects: {
        main: { id: 'main', type: 'frame', name: 'Library button', x: 0, y: 0, width: 80, height: 24, fills: [{ type: 'solid', color: '#435465' }] },
      },
      components: { button: { name: 'Library button', mainId: 'main' } },
    };
    const { id: library } = await call(omc, 'libraries', { documentId, action: 'add', snapshot: librarySnapshot });
    const list = await run('library.list', { assets: true });
    assert.equal(list.libraries[0].components.button.name, 'Library button');
    const { id: placed } = await run('library.place', { library, component: 'Library button', x: 170, y: 220 });
    assert.equal((await get(placed)).type, 'INSTANCE');
    await run('library.remove', { library });
    assert.deepEqual((await run('library.list')).libraries, []);
    assert.equal((await get(placed)).type, 'INSTANCE');
  } finally {
    await fig.close();
    await omc.close();
    service.kill();
    await exited;
    await rm(profile, { recursive: true, force: true });
  }
});
