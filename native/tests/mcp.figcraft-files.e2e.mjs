// Run against a locally built omc-service with node --test.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const sdk = process.env.OMC_TEST_SDK_ROOT;
const { Client } = await import(sdk
  ? pathToFileURL(join(sdk, 'dist/esm/client/index.js')).href
  : '@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = await import(sdk
  ? pathToFileURL(join(sdk, 'dist/esm/client/streamableHttp.js')).href
  : '@modelcontextprotocol/sdk/client/streamableHttp.js');
const executable = process.platform === 'win32' ? 'omc-service.exe' : 'omc-service';
const binary = process.env.OMC_SERVICE_BINARY
  ?? fileURLToPath(new URL(`../target/debug/${executable}`, import.meta.url));

async function endpoint(profile, child) {
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString()).slice(-2000); });
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`omc-service exited during startup: ${stderr}`);
    }
    try {
      const descriptor = JSON.parse(await readFile(join(profile, 'native-v1', 'service.json'), 'utf8'));
      const headers = { Authorization: `Bearer ${descriptor.token}` };
      const health = await fetch(descriptor.endpoint + '/health', { headers });
      if (health.ok) return new StreamableHTTPClientTransport(
        new URL(descriptor.endpoint + '/mcp/figcraft'), { requestInit: { headers } },
      );
    } catch {
      // The descriptor and listener become available during startup.
    }
    await delay(25);
  }
  throw new Error(`omc-service startup deadline: ${stderr}`);
}

test('FigCraft file and page commands persist edits and keep imported layers editable', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'omc-figcraft-files-'));
  const child = spawn(binary, ['--profile', profile, '--port', '0'], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  const fig = new Client({ name: 'figcraft-file-contracts', version: '1.0.0' });
  const call = async (name, args = {}) => {
    const result = await fig.callTool({ name, arguments: args });
    const value = result.structuredContent ?? JSON.parse(result.content[0].text);
    if (result.isError) throw new Error(value.message ?? JSON.stringify(value));
    return value;
  };
  const run = (command, params = {}) => call('run_command', { command, params });
  const inspect = () => call('inspect_document');
  const get = (id) => call('get_node', { id });
  try {
    await fig.connect(await endpoint(profile, child));
    const original = await run('file.new', { name: 'Original' });
    const page = (await run('page.list'))[0];
    await run('file.rename', { name: 'Saved document' });
    const color = await run('page.setBackground', { id: page.id, color: '#CBD5E1' });
    assert.equal(color.color, '#CBD5E1');
    assert.equal((await get(page.id)).fill, '#CBD5E1');
    const path = join(profile, 'roundtrip.figcraft');
    await run('file.saveAs', { path });
    assert.equal((await inspect()).dirty, false);
    assert.equal((await run('file.openRecent')).files[0].path, path);

    await run('file.rename', { name: 'Unsaved document' });
    assert.equal((await inspect()).dirty, true);
    assert.equal((await run('file.openRecent', { index: 0 })).document, original.id);
    await run('file.revert');
    const reverted = await inspect();
    assert.equal(reverted.id, original.id);
    assert.equal(reverted.name, 'Saved document');
    assert.equal(reverted.dirty, false);
    assert.equal((await get(reverted.currentPage)).fill, '#CBD5E1');

    const copy = await run('file.duplicate');
    assert.notEqual(copy.id, original.id);
    assert.equal((await inspect()).name, 'Saved document (Copy)');
    assert.equal((await inspect()).path, null);
    await run('file.markSaved');
    assert.equal((await inspect()).dirty, false);
    const replacement = await run('file.saveAs', { data: true });
    const recovered = await run('file.recover', { data: replacement.data });
    assert.notEqual(recovered.document, copy.id);
    assert.equal((await inspect()).dirty, true);
    assert.equal((await inspect()).path, null);
    await assert.rejects(run('file.save'), /file has no path/);
    await writeFile(path, Buffer.from(replacement.data, 'base64'));

    await run('file.openRecent', { path });
    await run('file.rename', { name: 'Local changes' });
    await assert.rejects(run('file.open', { path, reload: true }), /unsaved changes/);
    assert.equal((await inspect()).name, 'Local changes');
    await run('file.markSaved');
    assert.equal((await run('file.open', { path, reload: true })).reloaded, true);
    assert.equal((await inspect()).name, 'Saved document (Copy)');

    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="80" height="50"><g><rect width="40" height="20" fill="#123456"/></g></svg>').toString('base64');
    const imported = await run('file.import', {
      name: 'Editable artwork.svg', data: svg, x: 100, y: 90, center: true,
    });
    const artwork = (await call('get_node', { id: imported.ids[0], depth: 4 }));
    assert.equal(artwork.name, 'Editable artwork');
    assert.equal(artwork.x, 60);
    assert.equal(artwork.y, 65);
    assert.equal(artwork.children[0].children[0].type, 'RECTANGLE');
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==';
    const placed = await run('file.placeImage', { data: png, x: 8, y: 14, parent: artwork.id });
    assert.equal(placed.width, 1);
    assert.equal(placed.height, 1);
    assert.equal((await get(placed.id)).x, 8);
    assert.ok((await fig.callTool({
      name: 'screenshot', arguments: { ids: [artwork.id] },
    })).content.some((item) => item.type === 'image' && item.mimeType === 'image/png'));
    const opened = await run('file.open', { name: 'Inline SVG.svg', data: svg });
    assert.notEqual(opened.document, original.id);
    assert.ok((await inspect()).layers.length);
    await run('text.create', { name: 'Known font', characters: 'Example', props: { fontFamily: 'sans-serif' } });
    await run('text.create', { name: 'Missing font', characters: '한글', props: { fontFamily: 'OMC Fixture Missing Font' } });
    const fonts = await run('file.fontReport');
    assert.deepEqual(fonts.fonts.find((font) => font.family === 'sans-serif'), {
      family: 'sans-serif', available: true, layers: ['Known font'],
    });
    assert.deepEqual(fonts.fonts.find((font) => font.family === 'OMC Fixture Missing Font').layers, ['Missing font']);

    const fixturePath = process.env.OMC_TEST_FIGCRAFT_ARCHIVE;
    if (fixturePath) {
      await run('file.open', { path: fixturePath });
      const layers = (await inspect()).layers;
      const line = layers.find((layer) => layer.type === 'LINE');
      const ellipse = layers.find((layer) => layer.type === 'ELLIPSE');
      const text = layers.flatMap((layer) => layer.children).find((layer) => layer.type === 'TEXT');
      assert.equal(line.width, 20);
      assert.equal(ellipse.opacity, 0.5);
      assert.equal(text.characters, '한글');
      assert.equal(text.fontSize, 18);
      await call('type_text', { id: text.id, text: '저장 후 다시 열기' });
      const target = join(profile, 'edited.figcraft');
      await run('file.saveAs', { path: target });
      const edited = await readFile(target);
      await run('file.open', { name: 'Reopened.figcraft', data: edited.toString('base64') });
      const reopened = (await inspect()).layers;
      assert.equal(reopened.find((layer) => layer.type === 'LINE').width, 20);
      assert.equal(reopened.find((layer) => layer.type === 'ELLIPSE').opacity, 0.5);
      assert.equal(reopened.flatMap((layer) => layer.children).find((layer) => layer.type === 'TEXT').characters, '저장 후 다시 열기');
      assert.match((await run('file.exportSvg', { ids: [reopened.find((layer) => layer.type === 'LINE').id] })).content, /<svg/);
    }
    const bare = Buffer.from(JSON.stringify({
      format: 'figcraft', version: 1, name: 'Bare file', pages: [1], current_page: 1,
      nodes: { 1: { id: 1, name: 'Bare page', type: 'page' } },
    })).toString('base64');
    await run('file.open', { name: 'Bare file.json', data: bare });
    assert.equal((await inspect()).name, 'Bare file');
    assert.equal((await run('page.list'))[0].name, 'Bare page');
    await run('file.new', { name: 'Frames to PDF' });
    await run('frame.create', { x: 150, y: 50, width: 100, height: 80, props: { fill: '#112233' } });
    await run('frame.create', { x: 10, y: 50, width: 70, height: 50, props: { fill: '#445566' } });
    const pdf = await run('file.exportFramesPdf');
    const pdfBytes = Buffer.from(pdf.data, 'base64');
    assert.equal(pdf.pages, 2);
    assert.match(pdfBytes.toString('latin1'), /%PDF-[\s\S]*\/Count 2/);
    const pdfPath = join(profile, 'frames.pdf');
    assert.equal((await run('file.exportFramesPdf', { path: pdfPath })).pages, 2);
    assert.match((await readFile(pdfPath)).toString('latin1'), /\/Count 2/);
  } finally {
    await fig.close();
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    }
    await rm(profile, { recursive: true, force: true });
  }
});
