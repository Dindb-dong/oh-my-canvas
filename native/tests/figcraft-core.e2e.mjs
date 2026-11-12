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

test('FigCraft editing commands persist actual layer changes in the native service', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'omc-figcraft-core-'));
  const service = spawn(binary, ['--profile', profile, '--port', '0'], { stdio: 'inherit' });
  const exited = once(service, 'exit');
  const client = new Client({ name: 'figcraft-core-contracts', version: '1.0.0' });
  const call = async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args });
    if (result.isError) throw new Error(result.content[0].text);
    return result.structuredContent ?? JSON.parse(result.content.find(item => item.type === 'text').text);
  };
  const run = (command, params = {}) => call('run_command', { command, params });
  const get = id => call('get_node', { id });
  try {
    const { endpoint, token } = await serviceDescriptor(profile, service);
    await client.connect(new StreamableHTTPClientTransport(new URL(endpoint + '/mcp/figcraft'), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }));
    await run('file.new', { name: 'FigCraft native edits' });
    const create = (type, name, x, y, width = 40, height = 20) =>
      call('create_node', { type, name, x, y, width, height, props: { fill: '#336699' } });
    const { id: first } = await create('rectangle', 'First', 20, 25);
    const { id: second } = await create('rectangle', 'Second', 80.2, 25.4);
    const { id: frame } = await create('frame', 'Destination', 100, 100, 200, 100);
    const layers = async () => (await call('inspect_document')).layers.map(layer => layer.id);
    assert.deepEqual((await run('node.find', { type: 'RECTANGLE', limit: 1 })), {
      ids: [first], total: 2,
    });
    assert.deepEqual((await run('select.area', { x: 10, y: 20, width: 120, height: 35 })).selection, [first, second]);
    assert.deepEqual((await run('select.layersAt', { x: 25, y: 30 })).layers.map(layer => layer.id), [first]);

    await run('node.reorder', { id: second, index: 0 });
    assert.deepEqual(await layers(), [second, first, frame]);
    await run('arrange.front', { ids: [second] });
    assert.deepEqual(await layers(), [first, frame, second]);
    await run('arrange.backward', { ids: [second] });
    assert.deepEqual(await layers(), [first, second, frame]);
    await run('align.top', { ids: [first, second] });
    assert.ok(Math.abs((await get(second)).y - 25) < 0.001);
    await run('arrange.roundToPixels', { ids: [second] });
    assert.equal((await get(second)).x, 80);

    const [group] = (await run('object.group', { ids: [first, second], name: 'Pair' })).selection;
    assert.deepEqual((await get(group)).children.map(layer => layer.id), [first, second]);
    await run('object.ungroup', { ids: [group] });
    assert.deepEqual(await layers(), [first, second, frame]);
    assert.equal((await get(second)).x, 80);
    await call('undo');
    assert.equal((await get(group)).type, 'GROUP');
    await call('redo');
    await assert.rejects(get(group), /layer not found/);
    const [wrapper] = (await run('object.frameSelection', { ids: [first], name: 'Wrapper' })).selection;
    assert.equal((await get(wrapper)).type, 'FRAME');
    await run('object.removeFrame', { ids: [wrapper] });
    await assert.rejects(get(wrapper), /layer not found/);

    await run('node.reparent', { ids: [first], parent: frame });
    assert.equal((await get(frame)).children[0].id, first);
    assert.equal((await get(first)).x, -80);
    assert.ok((await run('select.layersAt', { x: 25, y: 30 })).layers.some(layer => layer.id === first));
    await assert.rejects(run('node.reparent', { ids: [frame], parent: first }), /cannot contain itself/);

    await run('object.rename', { ids: [second], name: '검증 레이어' });
    await run('object.opacityKeys', { ids: [second], digits: '35' });
    await run('object.toggleVisible', { ids: [second] });
    assert.equal((await get(second)).visible, false);
    await run('object.toggleVisible', { ids: [second] });
    await run('object.toggleLock', { ids: [second] });
    assert.equal((await get(second)).locked, true);
    await run('object.toggleLock', { ids: [second] });
    const after = await get(second);
    assert.equal(after.name, '검증 레이어');
    assert.equal(after.opacity, 0.35);
    assert.equal(after.visible, true);
    assert.equal(after.locked, false);

    const mask = await create('rectangle', 'Mask', 320, 70, 30, 30);
    const content = await create('ellipse', 'Clipped artwork', 330, 75, 50, 25);
    const [maskedGroup] = (await run('object.mask', { ids: [mask.id, content.id] })).selection;
    const masked = await get(maskedGroup);
    assert.equal(masked.isMaskGroup, true);
    assert.equal(masked.children.find(layer => layer.id === mask.id).isMask, true);
    await run('object.releaseMask', { ids: [maskedGroup] });
    assert.equal((await get(maskedGroup)).isMaskGroup, undefined);
    await run('object.ungroup', { ids: [maskedGroup] });
    await run('arrange.tidy', { ids: [mask.id, content.id], spacing: 10 });
    assert.equal((await get(content.id)).x, (await get(mask.id)).x + 60);
    await run('object.removeFill', { ids: [mask.id] });
    assert.equal((await get(mask.id)).fill, 'transparent');

    const label = await create('text', 'Typography', 300, 25);
    await run('node.set', { ids: [label.id], props: {
      characters: '한글 조판', fontSize: 19, fontStyle: 'Bold Italic', lineHeight: 24,
      textAlign: 'justified', textDecoration: 'strikethrough', opacity: '65%',
    } });
    const text = await get(label.id);
    assert.equal(text.characters, '한글 조판');
    assert.equal(text.fontSize, 19);
    assert.equal(text.fontWeight, 700);
    assert.equal(text.fontStyle, 'italic');
    assert.equal(text.lineHeight, 24);
    assert.equal(text.textAlign, 'justified');
    assert.equal(text.textDecoration, 'line-through');
    assert.equal(text.opacity, 0.65);
    const star = await run('shape.star', { x: 300, y: 100, width: 40, height: 40,
      props: { pointCount: 6, innerRadius: 0.55, fill: '#336699' },
    });
    assert.equal(star.node.type, 'STAR');
    assert.equal(star.node.pointCount, 6);
    await run('node.set', { ids: [star.id], props: { pointCount: 7, stroke: '#FF0000', strokeWeight: 2 } });
    assert.equal((await get(star.id)).pointCount, 7);
    assert.equal((await get(star.id)).strokeWeight, 2);
    const starSvg = await run('file.exportSvg', { ids: [star.id] });
    assert.match(Buffer.from(starSvg.data, 'base64').toString(), /<path[\s>]/);
    assert.match(starSvg.content, /fill="(?:#369|#336699)"/i);
    assert.match(starSvg.content, /stroke="(?:red|#f00|#ff0000)" stroke-width="2"/i);

    const path = join(profile, 'actual.svg');
    const exported = await run('file.exportSvg', { ids: [second], path, size: '2x' });
    assert.equal(exported.path, path);
    assert.match(await readFile(path, 'utf8'), /<svg[\s\S]*width="80"/);
    const png = await run('file.export', { ids: [second], format: 'png', size: { by: 'width', value: 96 } });
    assert.equal(Buffer.from(png.data, 'base64').readUInt32BE(16), 96);
    const screenshot = await client.callTool({ name: 'screenshot', arguments: { ids: [second], maxSize: 20 } });
    const image = screenshot.content.find(item => item.type === 'image');
    assert.equal(Buffer.from(image.data, 'base64').readUInt32BE(16), 20);
  } finally {
    await client.close();
    service.kill();
    await exited;
    await rm(profile, { recursive: true, force: true });
  }
});
