import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { inflateSync } from 'node:zlib';

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

function pngFirstRgb(base64) {
  const bytes = Buffer.from(base64, 'base64');
  const chunks = [];
  for (let offset = 8; offset < bytes.length;) {
    const length = bytes.readUInt32BE(offset);
    if (bytes.toString('ascii', offset + 4, offset + 8) === 'IDAT') {
      chunks.push(bytes.subarray(offset + 8, offset + 8 + length));
    }
    offset += length + 12;
  }
  // The first pixel has no neighboring samples regardless of the PNG row filter.
  return [...inflateSync(Buffer.concat(chunks)).subarray(1, 4)];
}

test('FigCraft design commands change native layout, appearance and rendered output', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'omc-figcraft-design-'));
  const service = spawn(binary, ['--profile', profile, '--port', '0'], { stdio: 'inherit' });
  const exited = once(service, 'exit');
  const client = new Client({ name: 'figcraft-design-contracts', version: '1.0.0' });
  const call = async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args });
    if (result.isError) throw new Error(result.content[0].text);
    return result.structuredContent ?? JSON.parse(result.content.find(item => item.type === 'text').text);
  };
  const run = (command, params = {}) => call('run_command', { command, params });
  const get = id => call('get_node', { id });
  const render = async id => (await call('export', { ids: [id], format: 'png' })).base64;
  const rect = async (x, y, parent) => (await run('shape.rectangle', { x, y, width: 30, height: 20, parent })).id;
  try {
    const { endpoint, token } = await serviceDescriptor(profile, service);
    await client.connect(new StreamableHTTPClientTransport(new URL(endpoint + '/mcp/figcraft'), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }));
    await run('file.new', { name: 'Profile command contract' });
    const swatch = (await run('shape.rectangle', { x: 0, y: 0, width: 16, height: 16,
      props: { fill: '#814E21' } })).id;
    const profileExport = (colorProfile, id = swatch) => run('file.export', { ids: [id], colorProfile });
    assert.deepEqual(await run('file.colorProfile'), { profile: 'srgb', changed: false });
    await assert.rejects(run('file.colorProfile', { profile: 'cmyk' }), /profile must/);
    const srgbPng = await profileExport('srgb');
    const nativeRgb = pngFirstRgb(srgbPng.data);
    assert.deepEqual(nativeRgb, [129, 78, 33]);
    const explicitP3 = pngFirstRgb((await profileExport('displayP3')).data);
    assert.notDeepEqual(explicitP3, nativeRgb);
    const originalFill = (await get(swatch)).fill;
    assert.ok(originalFill);
    assert.deepEqual(await run('file.colorProfile', { profile: 'displayP3', convert: false }),
      { profile: 'displayP3', changed: true });
    assert.deepEqual((await get(swatch)).fill, originalFill);
    const assigned = await profileExport('sameAsFile');
    assert.ok(Buffer.from(assigned.data, 'base64').includes(Buffer.from('iCCP')));
    assert.deepEqual(pngFirstRgb(assigned.data), nativeRgb);
    assert.notDeepEqual(pngFirstRgb((await profileExport('srgb')).data), nativeRgb);
    assert.equal((await call('inspect_document')).colorProfile, 'displayP3');
    await run('edit.undo');
    assert.equal((await run('file.colorProfile')).profile, 'srgb');
    assert.deepEqual(await run('file.colorProfile', { profile: 'displayP3' }),
      { profile: 'displayP3', changed: true });
    assert.notDeepEqual((await get(swatch)).fill, originalFill);
    const converted = pngFirstRgb((await profileExport('sameAsFile')).data);
    const near = (actual, expected) => actual.every((channel, i) => Math.abs(channel - expected[i]) <= 1);
    assert.ok(near(converted, explicitP3), `P3 expected ${explicitP3}, got ${converted}`);
    const convertedBack = pngFirstRgb((await profileExport('srgb')).data);
    assert.ok(near(convertedBack, nativeRgb), `sRGB expected ${nativeRgb}, got ${convertedBack}`);
    const profileArchive = await run('file.saveAs', { data: true });
    await run('file.open', { data: profileArchive.data, name: 'Converted profile.figcraft' });
    const profileReopened = await call('inspect_document');
    assert.equal(profileReopened.colorProfile, 'displayP3');
    assert.ok(near(pngFirstRgb((await profileExport('sameAsFile', profileReopened.layers[0].id)).data), converted));
    const image = await run('image.place', { x: 24, y: 0, data: srgbPng.data });
    const imageP3 = pngFirstRgb((await profileExport('sameAsFile', image.id)).data);
    assert.ok(near(imageP3, explicitP3), `sRGB asset should be independently converted to P3: ${imageP3}`);
    await run('file.new', { name: 'Design command contract' });
    const presets = await run('frame.presets');
    assert.ok(presets.some(preset => preset.name === 'iPhone 17' && preset.width === 402));
    const preset = (await run('frame.create', { preset: 'iPhone 17', x: 500, y: 0 })).id;
    assert.equal((await get(preset)).height, 874);
    await run('frame.swapOrientation', { ids: [preset] });
    assert.deepEqual([(await get(preset)).width, (await get(preset)).height], [874, 402]);
    const line = (await run('shape.line', { x: 30, y: 340, width: 45 })).id;
    const arrow = (await run('shape.arrow', { x: 30, y: 360, width: 45 })).id;
    assert.equal((await get(arrow)).arrowHead, true);
    const arrowSvg = await run('file.exportSvg', { ids: [arrow] });
    assert.notEqual(arrowSvg.content, (await run('file.exportSvg', { ids: [line] })).content);

    const svgLine = (await run('shape.line', { x: 0, y: 0, width: 30, props: { stroke: '#661122', strokeWeight: 3 } })).id;
    const strokeSvg = await run('file.exportSvg', { ids: [svgLine] });
    const outlinedSvg = await run('file.exportSvg', { ids: [svgLine], svgSimplifyStroke: false });
    assert.match(strokeSvg.content, /stroke=/);
    assert.doesNotMatch(outlinedSvg.content, /stroke=/);
    assert.match(outlinedSvg.content, /<path/);
    const svgText = (await call('create_node', { type: 'text', text: 'outline', width: 60, height: 20 })).id;
    assert.match((await run('file.exportSvg', { ids: [svgText], svgOutlineText: false })).content, /<text/);
    const outlinedText = (await run('file.exportSvg', { ids: [svgText], svgOutlineText: true })).content;
    assert.doesNotMatch(outlinedText, /<text/);
    assert.match(outlinedText, /<path/);
    const directXml = await run('file.export', { ids: [svgLine], format: 'xml', vdCompat: 'exact' });
    assert.match(Buffer.from(directXml.data, 'base64').toString(), /android:pathData/);
    assert.deepEqual(directXml.warnings, []);

    const a = await rect(10, 20);
    const b = await rect(100, 20);
    const c = await rect(160, 20);
    await run('distribute.horizontal', { ids: [a, b, c], spacing: 12 });
    assert.equal((await get(b)).x, 52);
    await run('arrange.packH', { ids: [a, b, c] });
    assert.equal((await get(c)).x, 70);
    await run('arrange.spacing', { ids: [a, b, c], horizontal: 10 });
    assert.equal((await get(c)).x, 90);
    await run('arrange.reorder', { ids: [a, b, c], source: a, target: c });
    assert.equal((await get(a)).x, 90);
    assert.equal((await get(b)).x, 10);
    await run('node.set', { ids: [a], props: { x: 10, y: 80 } });
    await run('node.set', { ids: [c], props: { x: 10, y: 145 } });
    await run('distribute.vertical', { ids: [b, a, c], spacing: 8 });
    assert.equal((await get(c)).y, 76);
    await run('arrange.packV', { ids: [b, a, c] });
    assert.equal((await get(a)).y, 40);

    const exp = (await run('shape.rectangle', {
      name: 'controls/새 버튼', x: 410, y: 240, width: 30, height: 20,
    })).id;
    await run('export.add', { ids: [exp] });
    await run('export.add', { ids: [exp] });
    await run('export.add', { ids: [exp], setting: { format: 'jpg', size: '15h', quality: 75 } });
    const outputs = await run('file.exportLayers', { ids: [exp, a] });
    assert.equal(outputs.skipped, 1);
    assert.deepEqual(outputs.files.map(file => file.name), ['controls/새 버튼.png', 'controls/새 버튼@2x.png', 'controls/새 버튼.jpg']);
    const sized = Buffer.from(outputs.files[1].data, 'base64');
    assert.deepEqual([sized.readUInt32BE(16), sized.readUInt32BE(20)], [60, 40]);
    assert.equal(Buffer.from(outputs.files[2].data, 'base64').readUInt16BE(0), 0xffd8);
    await run('export.update', { ids: [exp], index: 0, format: 'svg', suffix: '-icon', size: '15w' });
    await run('export.remove', { ids: [exp], index: 2 });
    await assert.rejects(run('export.update', { ids: [exp], index: 1, quality: 110 }), /quality/);
    const dir = join(profile, 'exported');
    const disk = await run('file.exportLayers', { ids: [exp], dir });
    assert.deepEqual(disk.files.map(file => file.name), ['controls/새 버튼-icon.svg', 'controls/새 버튼@2x.png']);
    const svg = await readFile(disk.files[0].path, 'utf8');
    assert.match(svg, /<svg[^>]+width="15"[^>]+height="10"/s);
    assert.equal(Buffer.byteLength(svg), disk.files[0].bytes);
    assert.deepEqual(await readFile(disk.files[1].path), sized);
    await assert.rejects(run('file.exportLayers', { ids: [exp], dir }), /exists/);
    const archive = await run('file.exportLayers', { ids: [exp], zip: true });
    assert.equal(Buffer.from(archive.data, 'base64').readUInt32LE(0), 0x04034b50);
    assert.ok(archive.files.every(file => !('data' in file)));
    const p3 = await run('file.exportLayers', { ids: [exp], colorProfile: 'displayP3' });
    assert.ok(Buffer.from(p3.files[1].data, 'base64').includes(Buffer.from('iCCP')));
    const lineAsset = await run('file.exportLayers', { ids: [line], assets: true });
    assert.match(lineAsset.files[0].name, /\.svg$/);
    assert.match(Buffer.from(lineAsset.files[0].data, 'base64').toString(), /<svg/);
    await run('export.add', { ids: [exp], setting: { format: 'xml' } });
    await run('fill.set', { ids: [exp], color: '#AA4433' });
    const drawable = (await run('file.exportLayers', { ids: [exp] })).files.find(file => file.name.endsWith('.xml'));
    const android = Buffer.from(drawable.data, 'base64').toString();
    assert.match(android, /<vector [^>]+android:viewportWidth="30"[^>]+>/);
    assert.match(android, /<path android:pathData="[^"]+" android:fillColor="#FFAA4433"/);
    assert.deepEqual(drawable.warnings, []);
    await run('export.remove', { ids: [exp], index: 2 });
    await run('export.add', { ids: [exp], setting: { format: 'pdf', bleed: '3pt', cropMarks: true } });
    const printed = (await run('file.exportLayers', { ids: [exp] })).files.find(file => file.name.endsWith('.pdf'));
    const pdf = Buffer.from(printed.data, 'base64').toString('latin1');
    assert.match(pdf, /^%PDF-/);
    assert.match(pdf, /\/TrimBox \[27 27 57 47\]/);
    assert.match(pdf, /\/BleedBox \[24 24 60 50\]/);
    const cmyk = (await run('file.exportLayers', { ids: [exp], cmyk: true, bleed: 3, cropMarks: true })).files.find(file => file.name.endsWith('.pdf'));
    const cmykPdf = Buffer.from(cmyk.data, 'base64').toString('latin1');
    assert.match(cmykPdf, /\/ColorSpace \/DeviceCMYK/);
    assert.match(cmykPdf, /1 1 1 1 K 0.25 w/);
    await run('export.remove', { ids: [exp], index: 2 });
    const surroundings = await render(exp);
    await run('export.update', { ids: [exp], index: 1, contentsOnly: false, size: '1x' });
    const overlaid = (await run('shape.rectangle', {
      x: 412, y: 241, width: 15, height: 14, props: { fill: 'red' },
    })).id;
    assert.ok(overlaid);
    const compoundExport = await run('file.exportLayers', { ids: [exp] });
    assert.notEqual(compoundExport.files[1].data, surroundings);

    const page = (await run('page.list')).find(page => page.current).id;
    const pageGuide = await run('guide.add', { page, offset: 23, vertical: false });
    assert.equal(pageGuide.index, 0);
    assert.deepEqual(await run('guide.select', { page, index: 0 }), { owner: page, index: 0 });
    await run('guide.move', { page, index: 0, offset: 48 });
    await run('guide.remove');
    await assert.rejects(run('guide.select', { page, index: 0 }), /no such guide/);
    assert.equal(await run('guide.select'), null);
    const frameGuide = await run('guide.add', { frame: preset, offset: 22 });
    assert.equal(frameGuide.index, 0);
    await run('guide.clear', { frame: preset });
    await assert.rejects(run('guide.move', { frame: preset, index: 0, offset: 10 }), /no such guide/);
    await assert.rejects(run('guide.add', { frame: a, offset: 9 }), /top-level frame/);

    const plain = await render(a);
    await run('fill.add', { ids: [a], color: '#336699' });
    await run('fill.add', { ids: [a], color: '#8822ff' });
    await run('fill.set', { ids: [a], index: 0, color: '#22aa44', opacity: '75%' });
    await run('fill.move', { ids: [a], from: 0, to: 1 });
    assert.equal((await get(a)).fills.at(-1).opacity, 0.75);
    await run('fill.copy', { id: a });
    await run('fill.paste', { ids: [b] });
    assert.equal((await get(b)).fills.at(-1).color, '#22AA44');
    assert.notEqual(await render(a), plain);
    await run('fill.remove', { ids: [a], index: 0 });
    assert.equal((await get(a)).fills.length, 1);
    await run('node.set', { ids: [a], props: { strokeWeight: 4 } });
    await run('stroke.add', { ids: [a], color: '#000000' });
    await run('stroke.add', { ids: [a], color: '#ff0000' });
    await run('stroke.set', { ids: [a], index: 0, color: '#112233', visible: true });
    await run('stroke.move', { ids: [a], from: 0, to: 1 });
    await run('stroke.copy', { id: a });
    await run('stroke.paste', { ids: [b] });
    assert.equal((await get(b)).strokeWeight, 4);
    assert.equal((await get(b)).strokes.at(-1).color, '#112233');
    await run('stroke.remove', { ids: [a], index: 0 });
    assert.equal((await get(a)).strokes.length, 1);
    const palette = (await run('paint.documentColors')).colors;
    assert.ok(palette.some(entry => entry.color === '#22AA44' && entry.count >= 2));

    const withStroke = await render(a);
    await run('effect.add', { ids: [a], type: 'dropShadow' });
    await run('effect.add', { ids: [a], type: 'layerBlur' });
    await run('effect.set', { ids: [a], index: 1, effect: { type: 'layerBlur', radius: 5 } });
    await run('effect.move', { ids: [a], from: 1, to: 0 });
    await run('effect.copy', { id: a, index: 0 });
    await run('effect.paste', { ids: [b] });
    assert.equal((await get(b)).effects.at(-1).radius, 5);
    assert.notEqual(await render(a), withStroke);
    await run('effect.remove', { ids: [a], index: 0 });
    assert.equal((await get(a)).effects.length, 1);

    const frame = (await run('frame.create', { x: 200, y: 100, width: 180, height: 150 })).id;
    const p = await rect(5, 5, frame);
    const q = await rect(55, 5, frame);
    await rect(5, 50, frame);
    await rect(55, 50, frame);
    await run('grid.add', { ids: [frame] });
    await run('grid.add', { ids: [frame], grid: { kind: 'columns', count: 3, gutter: 5 } });
    await run('grid.move', { ids: [frame], from: 1, to: 0 });
    assert.deepEqual((await get(frame)).layoutGrids.map(grid => grid.kind), ['columns', 'grid']);
    await run('grid.remove', { ids: [frame], index: 1 });
    assert.equal((await get(frame)).layoutGrids.length, 1);

    await run('layout.add', { ids: [frame], direction: 'grid' });
    await run('layout.setTrack', { ids: [frame], axis: 'columns', index: 0, sizing: 'fixed', value: 52 });
    assert.equal((await get(frame)).layout.columns[0], '52px');
    const hit = await run('select.layersAt', { x: 280, y: 112 });
    assert.ok(hit.layers.some(layer => layer.id === q), JSON.stringify(hit));
    await run('layout.remove', { ids: [frame] });
    assert.equal((await get(frame)).layout.type, 'none');
    assert.ok((await run('select.layersAt', { x: 280, y: 112 })).layers.some(layer => layer.id === q));
    const designed = await run('layout.suggest', { ids: [frame], direction: 'vertical' });
    assert.ok(Array.isArray(designed.warnings));
    assert.equal((await get(frame)).layout.direction, 'column');
    const nested = (await get(frame)).children.find(child => child.type === 'FRAME');
    assert.ok(nested);
    assert.ok((await get(nested.id)).children.some(child => child.id === p));
    const removed = (await run('layout.removeAll', { ids: [frame] })).removed;
    assert.ok(removed.includes(frame) && removed.includes(nested.id));
    assert.equal((await get(nested.id)).layout.type, 'none');

    const vectorFrame = (await run('frame.create', { x: 300, y: 320, width: 120, height: 100 })).id;
    const vector = (await run('shape.line', { x: 12, y: 45, width: 90, parent: vectorFrame,
      props: { stroke: '#222222', strokeWeight: 12 } })).id;
    const uniform = await render(vectorFrame);
    await run('stroke.widthProfile', { ids: [vector], preset: 'wedge' });
    const wedge = await render(vectorFrame);
    assert.notEqual(wedge, uniform);
    await run('stroke.widthProfile', { ids: [vector], points: [[0, 1, 0.3], [1, 0.2, 1]] });
    assert.notEqual(await render(vectorFrame), wedge);
    await run('stroke.widthProfile', { ids: [vector], preset: 'uniform' });
    assert.equal(await render(vectorFrame), uniform);
    await run('stroke.brush', { ids: [vector], preset: 'stars', spacing: 1, seed: 83, scatter: 0.3 });
    const brush = await render(vectorFrame);
    assert.notEqual(brush, uniform);
    await run('stroke.brush', { ids: [vector], preset: 'stars', spacing: 1, seed: 51, scatter: 0.3 });
    assert.notEqual(await render(vectorFrame), brush);
    await run('stroke.brush', { ids: [vector], preset: null });
    assert.equal(await render(vectorFrame), uniform);

    const tile = (await run('shape.rectangle', { x: 620, y: 50, width: 12, height: 12,
      props: { fill: '#EE2233' } })).id;
    const paper = (await run('shape.rectangle', { x: 650, y: 50, width: 96, height: 60,
      props: { fill: '#229944' } })).id;
    const solid = await render(paper);
    await run('fill.pattern', { ids: [paper], source: tile, spacing: [5, 4], tile: 'horizontalHex' });
    const pattern = await render(paper);
    assert.notEqual(pattern, solid);
    await run('fill.set', { ids: [tile], color: '#3355FF' });
    assert.notEqual(await render(paper), pattern, 'the pattern must follow the source layer');
    await assert.rejects(run('fill.pattern', { ids: [tile], source: paper }), /cycle/);
    await run('fill.copy', { id: paper });
    await run('fill.paste', { ids: [b], index: 0 });
    assert.equal((await get(b)).fills[0].type, 'pattern');

    await run('fill.set', { ids: [paper], paint: {
      type: 'gradient', kind: 'radial', from: [0.5, 0.5], to: [0.8, 0.5], width: [0.5, 1],
      stops: [{ position: 0, color: '#ffee22' }, { position: 1, color: '#663322' }],
    } });
    const gradient = await render(paper);
    assert.notEqual(gradient, solid);
    assert.equal((await get(paper)).fills[0].type, 'radial');
    await run('effect.add', { ids: [paper], effect: { type: 'innerShadow', radius: 5, offset: [4, 5] } });
    assert.notEqual(await render(paper), gradient);

    const backdropFrame = (await run('frame.create', { x: 650, y: 120, width: 100, height: 80 })).id;
    await run('shape.rectangle', { x: 15, y: 5, width: 20, height: 65, parent: backdropFrame, props: { fill: '#EE2233' } });
    const glass = (await run('shape.rectangle', { x: 5, y: 15, width: 60, height: 40, parent: backdropFrame,
      props: { fill: '#FFFFFF22' } })).id;
    const clear = await render(backdropFrame);
    await run('effect.add', { ids: [glass], effect: { type: 'backgroundBlur', radius: 8 } });
    assert.notEqual(await render(backdropFrame), clear);

    await run('file.new', { name: 'Design settings archive' });
    const portableFrame = (await run('frame.create', { width: 48, height: 24, props: { fill: '#663322' } })).id;
    await run('guide.add', { offset: 12, vertical: false });
    await run('guide.add', { frame: portableFrame, offset: 16 });
    await run('grid.add', { ids: [portableFrame], grid: { kind: 'columns', count: 3, align: 'start', color: '#F12E5570' } });
    await run('export.add', { ids: [portableFrame], setting: { size: '24w', colorProfile: 'displayP3' } });
    const portable = await run('file.saveAs', { data: true });
    await run('file.open', { data: portable.data, name: 'Reopened design.figcraft' });
    const [reopened] = (await call('inspect_document')).layers;
    const node = await get(reopened.id);
    assert.deepEqual(node.guides, [{ offset: 16, vertical: true }]);
    assert.equal(node.layoutGrids[0].align, 'min');
    assert.equal(node.exports[0].colorProfile, 'displayP3');
    const [reopenedFile] = (await run('file.exportLayers', { ids: [reopened.id] })).files;
    assert.equal(Buffer.from(reopenedFile.data, 'base64').readUInt32BE(16), 24);
    assert.deepEqual(await run('guide.select', { index: 0 }), {
      owner: (await run('page.list')).find(page => page.current).id,
      index: 0,
    });

    await run('file.newBoard', { name: 'MCP board' });
    assert.equal((await run('board.grid')).style, 'dots');
    const grid = await run('board.grid', { style: 'graph', spacing: 20, major: 4, size: 1.5, contrast: 2 });
    assert.deepEqual(await run('board.grid'), grid);
    assert.equal(JSON.parse(await readFile(join(profile, 'native-v1/board-grid.json'), 'utf8')).style, 'graph');
    await assert.rejects(run('board.grid', { style: 'unsupported' }), /dots/);

    const first = await run('board.shape', { shape: 'rectangle', x: 50, y: 80, width: 150, height: 100, text: 'First step' });
    const second = await run('board.addConnected', { id: first.id, side: 'right', edit: true });
    assert.ok(second.connector);
    await run('text.edit.insert', { text: '두 번째' });
    await run('text.edit.end');
    assert.match((await get(second.text)).characters, /두 번째/);
    const route = await run('board.connector', { from: first.id, fromSide: 'bottom', to: second.id, toSide: 'top', style: 'elbow', label: 'Next step' });
    assert.equal((await get(route.label)).characters, 'Next step');
    const routeSvg = async () => (await run('file.exportSvg', { ids: [route.id] })).content;
    const originalRoute = await routeSvg();
    assert.match(originalRoute, /<path/);
    assert.match(originalRoute, /Next step/);
    await run('node.set', { ids: [second.id], props: { y: 255 } });
    assert.notEqual(await routeSvg(), originalRoute, 'connector follows a moved target');
    const attached = await routeSvg();
    await run('board.reshape', { id: route.id, portion: 0, x: 212, y: 195 });
    assert.notEqual(await routeSvg(), attached, 'reshaping changes the route');
    await run('board.reattach', { id: route.id, end: 'to', target: { x: 520, y: 70 } });
    assert.notEqual(await routeSvg(), attached);
    assert.deepEqual(await run('board.label', { id: route.label, text: '' }), { id: route.id, label: null });
    assert.doesNotMatch(await routeSvg(), /Next step/);
    await run('board.setStyle', { ids: [route.id], style: 'curved', endCap: 'diamondFilled' });
    await run('board.setColor', { ids: [route.id], color: '#2355AA' });
    assert.match(await routeSvg(), /#2355aa/i);

    const table = await run('board.table', { x: 20, y: 440, cells: [['항목', '상태'], ['First issue', 'Done']] });
    assert.equal((await get(table.cells[0][0])).characters, '항목');
    assert.equal(table.rows, 2);
    const tableSvg = async () => (await run('file.exportSvg', { ids: [table.id] })).content;
    const baseTable = await tableSvg();
    const baseTablePixels = await render(table.id);
    assert.match(baseTable, /First issue/);
    const added = await run('board.tableEdit', { id: table.cells[0][0], action: 'addColumn', index: 1 });
    assert.equal(added.columns, 3);
    assert.equal(added.cells[0][2], table.cells[0][1]);
    const row = await run('board.tableEdit', { id: table.id, action: 'addRow', index: 0 });
    assert.equal(row.rows, 3);
    assert.equal(row.cells[1][0], table.cells[0][0]);
    await run('board.tableEdit', { id: table.id, action: 'removeColumn', index: 1 });
    await run('board.tableEdit', { id: table.id, action: 'removeRow', index: 0 });
    assert.equal(await render(table.id), baseTablePixels);
    await run('type_text', { id: table.cells[1][0], text: 'A long cell that wraps into several lines '.repeat(8) });
    assert.notEqual(await tableSvg(), baseTable);
    const templates = await run('board.templates');
    assert.deepEqual(templates.map(template => template.id), ['retrospective', 'brainstorm', 'weeklyPlanner', 'flowChart', 'kanban']);
    for (const [i, template] of templates.entries()) {
      const placed = await run('board.template', { name: template.id, x: 100 + 1600 * i, y: 900 });
      assert.ok(placed.ids.length >= 4);
      const svg = (await run('file.exportSvg', { ids: placed.ids })).content;
      assert.match(svg, /<svg/);
      if (template.id === 'flowChart') assert.match(svg.normalize('NFKC'), /Do the first step/);
      if (template.id === 'kanban') assert.match(svg, /Write the brief/);
      await run('edit.undo');
      await assert.rejects(get(placed.ids[0]), /layer not found/i);
    }
    const boardPath = join(profile, 'saved-board.omc');
    await run('file.saveAs', { path: boardPath });
    const boardArchive = JSON.parse(await readFile(boardPath, 'utf8'));
    assert.ok(JSON.stringify(boardArchive).includes('boardConnector'));
    await run('file.open', { path: boardPath });
    assert.deepEqual(await run('board.grid'), grid);
    const reopenedBoard = await call('inspect_document');
    assert.ok(reopenedBoard.layers.some(layer => layer.name === 'Connector'));
    assert.ok(reopenedBoard.layers.some(layer => layer.name === 'Table'));
    assert.equal((await run('board.grid', { reset: true })).style, 'dots');

    const starters = await run('template.list');
    assert.deepEqual(starters.map(starter => starter.id), ['mobile-app', 'landing-page', 'dashboard', 'design-system', 'wireframe-kit', 'social-posts', 'slides', 'icon-set']);
    assert.deepEqual(await run('file.newFromTemplate'), { templates: starters });
    await assert.rejects(run('file.newFromTemplate', { template: 'unavailable' }), /template.list/);
    for (const starter of starters) {
      const title = `Fixture ${starter.name}`;
      const created = await run('file.newFromTemplate', { template: starter.id, name: title });
      assert.equal(created.name, title);
      assert.equal(created.template, starter.id);
      const report = await call('inspect_document');
      assert.ok(report.layers.length > 0);
      const layer = report.layers.find(layer => layer.type === 'FRAME') ?? report.layers[0];
      const screenshot = await run('file.export', { ids: [layer.id], scale: 0.15 });
      const pixels = Buffer.from(screenshot.data, 'base64');
      assert.equal(pixels.readUInt32BE(16) > 2, true);
      assert.equal(pixels.readUInt32BE(20) > 2, true);
      assert.ok(pixels.byteLength > 200);
      const name = `${starter.name} editable`;
      await run('node.set', { ids: [layer.id], props: { name } });
      assert.equal((await get(layer.id)).name, name);
      if (starter.id === 'design-system') {
        const variableReport = await run('variable.list');
        assert.ok(variableReport.collections.some(collection => collection.name === 'Theme'));
      }
    }

  } finally {
    await client.close().catch(() => {});
    if (service.exitCode === null) service.kill();
    await exited;
    await rm(profile, { recursive: true, force: true });
  }
});
