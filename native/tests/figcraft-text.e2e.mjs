import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
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


test('FigCraft typography and editing commands change native text over the MCP SDK', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'omc-figcraft-text-'));
  const service = spawn(binary, ['--profile', profile, '--port', '0'], { stdio: 'inherit' });
  const exited = once(service, 'exit');
  const client = new Client({ name: 'figcraft-text-contracts', version: '1.0.0' });
  const call = async (name, arguments_ = {}) => {
    const result = await client.callTool({ name, arguments: arguments_ });
    const value = result.structuredContent ?? JSON.parse(result.content.find(item => item.type === 'text').text);
    if (result.isError) throw new Error(value.message);
    return value;
  };
  const run = (command, params = {}) => call('run_command', { command, params });
  const get = id => call('get_node', { id });
  try {
    const { endpoint, token } = await serviceDescriptor(profile, service);
    await client.connect(new StreamableHTTPClientTransport(new URL(endpoint + '/mcp/figcraft'), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }));
    const { id: documentId } = await run('file.new', { name: 'Text MCP fixture' });
    const create = (text, props = {}) => call('create_node', {
      type: 'text', text, x: 10, y: 20, width: 130, height: 95, props,
    });
    const { id } = await create('한글 😀 alpha beta\nnext line', { fontSize: 20, fontFamily: 'sans-serif' });
    await run('text.edit.begin', { id });
    assert.equal((await run('text.edit.selection')).text, '한글 😀 alpha beta\nnext line');
    await run('text.edit.selectWord', { index: 5 });
    assert.equal((await run('text.edit.selection')).text, 'alpha');
    await run('text.bold');
    await run('text.edit.selectLine', { index: 19 });
    assert.equal((await run('text.edit.selection')).text, 'next line');
    await run('text.edit.caret', { index: 3 });
    await run('text.edit.caret', { index: 4, extend: true });
    assert.equal((await run('text.edit.selection')).text, '😀');
    await run('text.edit.preedit', { text: '한글', cursor: 1 });
    assert.deepEqual((await run('text.edit.selection')).preedit, { text: '한글', cursor: 1 });
    assert.match((await get(id)).characters, /😀/);
    await run('text.edit.insert', { text: '친구' });
    assert.equal((await get(id)).characters, '한글 친구 alpha beta\nnext line');
    assert.equal((await run('text.edit.selection')).preedit, null);
    await run('text.edit.key', { key: 'Backspace' });
    assert.equal((await get(id)).characters, '한글 친 alpha beta\nnext line');
    await run('text.edit.key', { key: 'Home' });
    await run('text.edit.key', { key: 'Down' });
    assert.equal((await run('text.edit.selection')).caret, 16);
    await run('text.edit.key', { key: 'End' });
    await run('text.edit.key', { key: 'Enter' });
    assert.match((await get(id)).characters, /next line\n$/);
    await run('text.edit.end');
    assert.equal(await run('text.edit.selection'), null);

    await run('text.set', { id, characters: 'Test שלום 123! Text with enough words to wrap over multiple lines.' });
    for (const [name, expected] of [['alignCenter', 'center'], ['alignRight', 'right'], ['alignJustify', 'justified'], ['alignLeft', 'left']]) {
      await run('text.' + name, { ids: [id] });
      assert.equal((await get(id)).textAlign, expected);
    }
    await run('text.bold', { ids: [id] });
    assert.equal((await get(id)).fontWeight, 700);
    await run('text.bold', { ids: [id] });
    assert.equal((await get(id)).fontWeight, 400);
    await run('text.italic', { ids: [id] });
    assert.equal((await get(id)).fontStyle, 'italic');
    await run('text.italic', { ids: [id] });
    assert.equal((await get(id)).fontStyle, 'normal');
    await run('text.underline', { ids: [id] });
    assert.equal((await get(id)).textDecoration, 'underline');
    await run('text.strikethrough', { ids: [id] });
    assert.equal((await get(id)).textDecoration, 'line-through');
    await run('text.decoration', { ids: [id], decoration: 'none' });
    assert.equal((await get(id)).textDecoration, 'none');
    await run('text.link', { ids: [id], url: 'https://example.com/design' });
    await run('text.edit.begin', { id, caret: 3 });
    assert.deepEqual(await run('text.openLink'), { url: 'https://example.com/design' });
    await run('text.edit.end');
    await run('text.link', { ids: [id], url: 'javascript:alert(1)' });
    await run('text.edit.begin', { id, caret: 3 });
    await assert.rejects(run('text.openLink'), /only web and mail links/);
    await run('text.edit.end');
    await run('text.link', { ids: [id], url: '' });
    await run('text.sizeUp', { ids: [id] });
    assert.equal((await get(id)).fontSize, 21);
    await run('text.sizeDown', { ids: [id] });
    assert.equal((await get(id)).fontSize, 20);
    await run('text.weightUp', { ids: [id] });
    assert.ok((await get(id)).fontWeight >= 400);
    await run('text.weightDown', { ids: [id] });
    await run('text.lineHeightUp', { ids: [id] });
    assert.equal((await get(id)).lineHeight, 25);
    await run('text.lineHeightDown', { ids: [id] });
    assert.equal((await get(id)).lineHeight, 24);
    await run('text.trackingUp', { ids: [id] });
    assert.equal((await get(id)).letterSpacing, '0.01em');
    await run('text.trackingDown', { ids: [id] });
    assert.equal((await get(id)).letterSpacing, '0em');
    const png = async () => createHash('sha256').update((await call('screenshot', { ids: [id] })).base64).digest('hex');
    const beforeRange = await png();
    await run('text.style', { id, start: 5, end: 13, fontSize: 35, textDecoration: 'underline', textDecorationColor: '#ff0000' });
    assert.notEqual(await png(), beforeRange);
    assert.equal((await get(id)).fontSize, 20);
    await call('undo');
    assert.equal(await png(), beforeRange);
    await run('text.directionRtl', { ids: [id] });
    const rtl = await png();
    await run('text.directionLtr', { ids: [id] });
    const ltr = await png();
    assert.notEqual(rtl, ltr);
    await run('text.direction', { ids: [id], direction: 'rtl' });
    assert.equal(await png(), rtl);
    await run('text.directionAuto', { ids: [id] });
    assert.equal(await png(), ltr);
    await run('text.maxLines', { ids: [id], lines: 1 });
    assert.notEqual(await png(), ltr);
    await run('text.maxLines', { ids: [id], lines: 0 });
    assert.equal(await png(), ltr);
    await run('text.setFeatures', { id, features: { liga: false }, replace: true });
    const families = await run('text.fonts');
    assert.ok(families.length > 0);
    const family = families.find(name => name === 'Arial') ?? families[0];
    const styles = await run('text.fonts', { family });
    assert.ok(styles.length > 0);
    const features = await run('text.fonts', { family, style: styles[0], features: true });
    assert.ok(Array.isArray(features));
    const axes = await run('text.fonts', { family, style: styles[0], axes: true });
    assert.ok(axes && Array.isArray(axes.axes));
    await run('text.set', { id, text: 'aB straße' });
    const originalCase = await png();
    await run('text.caseUpper', { ids: [id] });
    const uppercase = await png();
    assert.notEqual(uppercase, originalCase);
    await run('text.caseLower', { ids: [id] });
    assert.notEqual(await png(), uppercase);
    await run('text.caseTitle', { ids: [id] });
    assert.notEqual(await png(), uppercase);
    await run('text.caseSmallCaps', { ids: [id] });
    assert.notEqual(await png(), originalCase);
    await run('text.caseOriginal', { ids: [id] });
    assert.equal(await png(), originalCase);
    await run('text.case', { ids: [id], case: 'upper' });
    assert.equal(await png(), uppercase);
    assert.equal((await get(id)).characters, 'aB straße');
    await run('text.setVariations', { id, variations: { wght: 700 }, replace: true });
    await run('text.setVariations', { id, variations: { wght: null } });
    const { id: fitId } = await create('A fixed-width box with a long headline', { fontSize: 36 });
    const fitted = (await run('text.fit', { ids: [fitId], maxLines: 2, minSize: 8, orphans: false })).fitted[0];
    assert.ok(fitted.fits && fitted.lines <= 2 && fitted.fontSize < 36);
    assert.equal((await get(fitId)).fontSize, fitted.fontSize);
    await call('undo');
    assert.equal((await get(fitId)).fontSize, 36);
    const { id: listId } = await create('First line\nSecond line\nThird line', { fontSize: 14 });
    const listPng = async () => createHash('sha256').update((await call('screenshot', { ids: [listId] })).base64).digest('hex');
    const plainList = await listPng();
    await run('text.bulletList', { ids: [listId] });
    const bullets = await listPng();
    assert.notEqual(bullets, plainList);
    await run('text.bulletList', { ids: [listId] });
    assert.equal(await listPng(), plainList);
    await run('text.numberList', { ids: [listId] });
    const numbered = await listPng();
    assert.notEqual(numbered, bullets);
    await run('text.edit.begin', { id: listId, caret: 15 });
    assert.equal((await run('text.listIndent')).changed, true);
    assert.notEqual(await listPng(), numbered);
    assert.equal((await run('text.listOutdent')).changed, true);
    assert.equal(await listPng(), numbered);
    await run('text.edit.end');
    await run('text.listStyle', { ids: [listId], style: 'none' });
    assert.equal(await listPng(), plainList);
    await run('text.paragraphIndent', { ids: [listId], indent: 12 });
    const indented = await listPng();
    assert.notEqual(indented, plainList);
    await run('text.paragraphSpacing', { ids: [listId], spacing: 18 });
    assert.notEqual(await listPng(), indented);
    assert.equal((await get(listId)).characters, 'First line\nSecond line\nThird line');
    const { id: pathText } = await create('Curve along a circle', { fontSize: 18 });
    const { id: curve } = await call('create_node', { type: 'ellipse', x: 20, y: 40, width: 250, height: 130, props: { fill: '#e94f64' } });
    assert.equal((await run('text.onPath', { text: pathText, path: curve, start: 0.15 })).id, pathText);
    await assert.rejects(get(curve), /layer not found/);
    assert.equal((await get(pathText)).characters, 'Curve along a circle');
    assert.equal((await get(pathText)).width, 250);
    assert.equal((await get(pathText)).fill, '#e94f64');
    const curvePng = async () => createHash('sha256').update((await call('screenshot', { ids: [pathText] })).base64).digest('hex');
    const firstCurve = await curvePng();
    await run('text.pathOptions', { ids: [pathText], start: 0.3, flip: true });
    assert.notEqual(await curvePng(), firstCurve);
    await call('undo');
    assert.equal(await curvePng(), firstCurve);
    await run('text.removeFromPath', { ids: [pathText] });
    assert.notEqual(await curvePng(), firstCurve);
    const { id: wrapId } = await create('one two three four five six seven eight nine ten', { fontSize: 17 });
    const wrapPng = async () => createHash('sha256').update((await call('screenshot', { ids: [wrapId] })).base64).digest('hex');
    let changedWrapping = false;
    for (const width of [112, 130, 148, 165, 182]) {
      await run('node.set', { ids: [wrapId], props: { width } });
      await run('text.wrapStyle', { ids: [wrapId], style: 'auto' });
      const normalWrap = await wrapPng();
      await run('text.wrapStyle', { ids: [wrapId], style: 'balance' });
      if (await wrapPng() !== normalWrap) {
        changedWrapping = true;
        break;
      }
    }
    assert.ok(changedWrapping, 'At least one width must show balanced wrapping in the output');
    await run('text.wrapStyle', { ids: [wrapId], style: 'pretty' });
    assert.equal((await get(wrapId)).textWrapStyle, 'pretty');

    const rawFont = await readFile(new URL('../crates/omc-text/fonts/Inter-Regular.ttf', import.meta.url));
    const font = Buffer.from(rawFont);
    const familyTag = 'Omctt';
    for (const encoding of ['ascii', 'utf16le']) {
      const old = Buffer.from('Inter', encoding);
      const replacement = Buffer.from(familyTag, encoding);
      if (encoding === 'utf16le') { old.swap16(); replacement.swap16(); }
      for (let at = font.indexOf(old); at !== -1; at = font.indexOf(old, at + old.length)) replacement.copy(font, at);
    }
    const { id: custom } = await call('create_node', { type: 'text', text: 'Custom face rendered in this MCP session', x: 20, y: 150, props: { fontFamily: familyTag, fontSize: 20 } });
    const customPng = async () => createHash('sha256').update((await call('screenshot', { ids: [custom] })).base64).digest('hex');
    await assert.rejects(customPng(), /font_substitution/);
    assert.ok((await run('text.missingFonts')).families.some(item => item.family === familyTag));
    await run('text.refit', { ids: [custom] });
    const installed = await run('text.loadFont', { data: font.toString('base64') });
    assert.deepEqual(installed.families, [familyTag]);
    assert.ok(Array.isArray(installed.refitted));
    assert.match(await customPng(), /^[a-f0-9]{64}$/);
    assert.ok(!(await run('text.missingFonts')).families.some(item => item.family === familyTag));
    assert.ok((await run('text.fonts')).includes(familyTag));
    assert.deepEqual(await run('text.refit', { ids: [custom] }), { refitted: [] });
    const rescan = await run('text.rescanFonts');
    assert.ok(Array.isArray(rescan.added) && Array.isArray(rescan.refitted));
    await assert.rejects(run('text.loadFont', { data: Buffer.from('invalid font').toString('base64') }), /cannot be decoded/);
    const observer = new Client({ name: 'font-isolation-check', version: '1.0.0' });
    try {
      await observer.connect(new StreamableHTTPClientTransport(new URL(endpoint + '/mcp/figcraft'), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      }));
      const observe = async (command, params = {}) => {
        const result = await observer.callTool({ name: 'run_command', arguments: { command, params } });
        assert.ok(!result.isError, result.content[0].text);
        return result.structuredContent ?? JSON.parse(result.content[0].text);
      };
      assert.ok(!(await observe('text.fonts')).includes(familyTag));
      assert.deepEqual(await observe('text.loadFont', { data: font.toString('base64') }), {
        families: [familyTag], refitted: [],
      });
      assert.ok((await observe('text.fonts')).includes(familyTag));
      assert.deepEqual(await observe('text.rescanFonts'), { added: [], refitted: [] });
    } finally { await observer.close(); }
    const shape = (await call('create_node', {
      type: 'rectangle', name: 'Preview fixture', x: 10, y: 10, width: 90, height: 48, props: { fill: '#224466', stroke: '#110022', strokeWeight: 3 },
    })).id;
    const shapePng = async () => (await call('screenshot', { ids: [shape] })).sha256;
    const baseShape = await shapePng();
    const textBase = await png();
    const selectionTarget = { id: shape, fills: true, index: 0, range: null };
    const style = (await run('style.create', { type: 'paint', name: 'Preview/Test', value: '#ff0000' })).id;
    const expected = [
      ['node.set', { ids: [shape], props: { fill: '#ff0000' } }, shapePng, baseShape],
      ['fill.set', { ids: [shape], index: 0, color: '#ff0000' }, shapePng, baseShape],
      ['stroke.set', { ids: [shape], index: 0, color: '#ff0000' }, shapePng, baseShape],
      ['selection.setPaint', { targets: [selectionTarget], paint: '#ff0000' }, shapePng, baseShape],
      ['style.apply', { ids: [shape], style }, shapePng, baseShape],
      ['text.style', { id, start: 0, end: 4, fontSize: 46 }, png, textBase],
      ['selection.setPaint', { targets: [{ id, fills: true, index: 0, range: [0, 4] }], paint: '#ff0000' }, png, textBase],
    ];
    for (const [command, params, image, original] of expected) {
      assert.deepEqual(await run('text.preview', { command, params }), { previewing: true }, command);
      assert.notEqual(await image(), original, command);
      assert.deepEqual(await run('text.endPreview'), { ended: true }, command);
      assert.equal(await image(), original, command);
    }
    assert.deepEqual(await run('text.endPreview'), { ended: false });
    const observerPreview = new Client({ name: 'preview-isolation-check', version: '1.0.0' });
    try {
      await observerPreview.connect(new StreamableHTTPClientTransport(new URL(endpoint + '/mcp/figcraft'), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      }));
      const observe = async (name, arguments_) => {
        const result = await observerPreview.callTool({ name, arguments: { ...arguments_, document: documentId } });
        assert.ok(!result.isError, result.content[0].text);
        return result.structuredContent ?? JSON.parse(result.content[0].text);
      };
      const [foreignId] = (await observe('run_command', {
        command: 'node.find', params: { name: 'Preview fixture' },
      })).ids;
      await run('text.preview', { command: 'fill.set', params: { ids: [shape], color: '#ffffff' } });
      assert.notEqual(await shapePng(), baseShape);
      assert.equal((await observe('screenshot', { ids: [foreignId] })).sha256, baseShape);
      await observe('run_command', { command: 'node.set', params: { ids: [foreignId], props: { name: 'Preview modified' } } });
      assert.equal(await shapePng(), baseShape);
      assert.deepEqual(await run('text.endPreview'), { ended: false });
    } finally { await observerPreview.close(); }
    await run('style.apply', { ids: [shape], style });
    const styledShape = await shapePng();
    await run('text.preview', { command: 'style.update', params: { style, value: '#00ff00' } });
    const previewStyle = await shapePng();
    assert.notEqual(previewStyle, styledShape);
    await run('text.preview', { command: 'style.update', params: { style, value: '#0000ff' } });
    assert.notEqual(await shapePng(), previewStyle);
    assert.ok((await get(shape)).id === shape);
    assert.equal(await shapePng(), styledShape);
    await assert.rejects(run('text.preview', { command: 'edit.delete', params: { ids: [shape] } }), /cannot be used/);
    await run('text.preview', { command: 'style.update', params: { style, value: '#00ff00' } });
    await run('style.update', { style, value: '#00ff00' });
    assert.equal(await shapePng(), previewStyle);
    await call('undo');
    assert.equal(await shapePng(), styledShape);
    await run('selection.setPaint', { targets: [selectionTarget], paint: '#00ff00' });
    assert.equal(await shapePng(), previewStyle);
    await call('undo');
    assert.equal(await shapePng(), styledShape);

    await run('file.new', { name: 'Preview paint library' });
    await run('style.create', { type: 'paint', name: 'Library paint', value: '#aa8c2b' });
    const published = await run('library.publish');
    const libraryPath = join(profile, 'preview-paint-library.figcraft');
    await run('file.saveAs', { path: libraryPath });
    const previousTab = (await run('doc.list')).find(tab => tab.id === documentId).index;
    await run('doc.switch', { index: previousTab });
    const library = await run('library.add', { path: libraryPath });
    assert.equal(library.id, published.id);
    const libraryParams = { library: library.id, style: 'Library paint', ids: [shape] };
    assert.deepEqual(await run('text.preview', { command: 'library.applyStyle', params: libraryParams }), { previewing: true });
    const libraryPreview = await shapePng();
    assert.notEqual(libraryPreview, styledShape);
    assert.deepEqual(await run('text.endPreview'), { ended: true });
    assert.equal(await shapePng(), styledShape);
    await run('library.applyStyle', libraryParams);
    assert.equal(await shapePng(), libraryPreview);
    await call('undo');
    assert.equal(await shapePng(), styledShape);

    const template = (await run('frame.create', { name: 'Card', x: 210, y: 300, width: 120, height: 100 })).id;
    const headline = (await call('create_node', {
      type: 'text', name: 'Headline', text: 'Template title', parent: template,
      x: 8, y: 8, width: 75, height: 28, props: { fontSize: 20 },
    })).id;
    await call('create_node', {
      type: 'text', name: 'Headline', text: 'Another title', parent: template,
      x: 8, y: 40, width: 75, height: 28, props: { fontSize: 20 },
    });
    await call('create_node', {
      type: 'rectangle', name: 'Badge', parent: template,
      x: 92, y: 10, width: 18, height: 18, props: { fill: '#111111' },
    });
    const outputDir = join(profile, 'data-exports');
    await mkdir(outputDir);
    const { ids: copies, missing: dataMissing, files } = await run('data.fill', {
      id: template,
      rows: [
        { name: 'Daily/Note', Headline: { text: 'A longer headline must fit', fill: '#841234', fit: { minSize: 8 } }, Badge: { visible: false }, Unknown: 'missing' },
        { name: 'Daily/Note', Headline: true, Badge: { fill: '#2468ac' }, Unknown: 'still missing' },
      ],
      formats: [{ name: 'Square', width: 144, height: 144 }, { width: 200, height: 108 }],
      gap: 32, dir: outputDir, format: 'png',
    });
    assert.deepEqual(dataMissing, ['Unknown']);
    assert.equal(copies.length, 4);
    assert.equal(files.length, 4);
    assert.equal(new Set(files).size, 4);
    assert.ok(files[2].endsWith('Daily-Note-Square 2.png'));
    assert.deepEqual((await readFile(files[0])).subarray(0, 8), Buffer.from([137,80,78,71,13,10,26,10]));
    const first = await call('get_node', { id: copies[0], depth: 1 });
    const secondFormat = await call('get_node', { id: copies[1], depth: 1 });
    const secondRow = await call('get_node', { id: copies[2], depth: 1 });
    assert.deepEqual([first.width, first.height, secondFormat.width, secondFormat.height], [144, 144, 200, 108]);
    assert.deepEqual([first.x, first.y, secondFormat.x, secondFormat.y, secondRow.x], [442, 300, 442, 476, 674]);
    assert.equal(first.name, 'Daily/Note-Square');
    assert.ok(first.children.filter(node => node.name === 'Headline').every(node => node.characters === 'A longer headline must fit' && node.fontSize < 20));
    assert.equal(first.children.find(node => node.name === 'Badge').visible, false);
    assert.ok(secondRow.children.filter(node => node.name === 'Headline').every(node => node.characters === 'true'));
    assert.equal(secondRow.children.find(node => node.name === 'Badge').fill.toLowerCase(), '#2468ac');

    assert.equal((await get(headline)).characters, 'Template title');
    await call('undo');
    for (const copy of copies) await assert.rejects(get(copy), /layer|node/i);
    assert.equal((await readdir(outputDir)).length, 4);
    await assert.rejects(run('data.fill', {
      id: template, rows: [{ name: 'Atomic data test' }, { Headline: { fit: { minSize: 200 } } }],
    }), /minSize/);
    assert.equal((await run('node.find', { name: 'Atomic data test' })).total, 0);

    const rejectedExport = await run('data.fill', {
      id: template, rows: [{ name: 'Invalid output' }], dir: join(profile, 'nonexistent-output'),
    });
    assert.equal(rejectedExport.ids.length, 1);
    assert.deepEqual(rejectedExport.files, []);
    assert.equal(rejectedExport.errors[0].id, rejectedExport.ids[0]);
    assert.equal((await get(rejectedExport.ids[0])).name, 'Invalid output');
    await call('undo');
    await assert.rejects(get(rejectedExport.ids[0]), /layer|node/i);

    const emptyFrame = (await run('frame.create', { name: 'Limit', x: 100, y: 100, width: 12, height: 12 })).id;
    const many = await run('data.fill', { id: emptyFrame, rows: Array.from({ length: 500 }, () => ({})), gap: 0 });
    assert.equal(many.ids.length, 500);
    assert.equal((await get(many.ids[499])).name, 'Limit 500');
    await call('undo');
    await assert.rejects(get(many.ids[0]), /layer|node/i);
    await assert.rejects(get(many.ids[499]), /layer|node/i);

    const drawingSource = (await call('create_node', {
      type: 'rectangle', x: 350, y: 360, width: 70, height: 35,
      props: { fill: '#2468ac', stroke: '#987654', strokeWeight: 4, opacity: 0.6, cornerRadius: 5 },
    })).id;
    const shapeDefaults = await run('edit.setDefaultProperties');
    assert.equal(shapeDefaults.for, 'shapes');
    assert.equal(shapeDefaults.properties.fill, '#2468ac');
    assert.equal(shapeDefaults.properties.opacity, 0.6);
    await run('tool.rectangle');
    const drawRect = async () => (await run('tool.place', { x: 600, y: 450 })).id;
    const firstPlaced = await drawRect();
    assert.deepEqual([(await get(firstPlaced)).fill, (await get(firstPlaced)).cornerRadius], ['#2468ac', 5]);
    await call('undo');
    await assert.rejects(get(firstPlaced), /layer|node/i);
    assert.equal((await get(await drawRect())).fill, '#2468ac');
    const direct = (await call('create_node', { type: 'rectangle', x: 630, y: 480 })).id;
    assert.notEqual((await get(direct)).fill, '#2468ac');
    const plainFrame = (await run('tool.place', { tool: 'frame', x: 800, y: 500 })).id;
    assert.notEqual((await get(plainFrame)).fill, '#2468ac');
    const styledText = (await create('Styled sample', { fill: '#895522', fontFamily: 'Inter', fontSize: 21, fontWeight: 700 })).id;
    assert.equal((await run('edit.setDefaultProperties', { id: styledText })).for, 'text');
    const textPlaced = (await run('tool.place', { tool: 'text', x: 940, y: 500 })).id;
    assert.deepEqual([(await get(textPlaced)).fill, (await get(textPlaced)).fontSize, (await get(textPlaced)).fontWeight], ['#895522', 21, 700]);
    const ellipsePlaced = (await run('tool.place', { tool: 'ellipse', x: 1050, y: 500 })).id;
    assert.equal((await get(ellipsePlaced)).fill, '#2468ac');
    assert.equal((await get(drawingSource)).width, 70);

    const downloadedFamily = 'Zen Loop';
    assert.deepEqual(await run('font.downloads'), { allowed: false, downloads: [] });
    await assert.rejects(run('font.download', { family: downloadedFamily }), /turned off|are off/);
    await assert.rejects(run('font.download', { family: 'No Catalog Family' }), /absent from the pinned catalog/);
    if (process.env.OMC_TEST_FONT_DOWNLOAD === '1') {
      const { id: fontTarget } = await call('create_node', {
        type: 'text', text: 'Live pinned font', x: 20, y: 25, props: { fontFamily: downloadedFamily, fontSize: 22 },
      });
      const rendered = async () => (await call('screenshot', { ids: [fontTarget] })).sha256;
      assert.ok((await run('text.missingFonts')).families.some(item => item.family === downloadedFamily && item.source === 'Google Fonts'));
      await assert.rejects(rendered(), /font_substitution/);
      await writeFile(join(profile, 'native-v1', 'allow-font-downloads'), 'unexpected file');
      assert.equal((await run('font.downloads')).allowed, false);
      await writeFile(join(profile, 'native-v1', 'allow-font-downloads'), 'OMC_USER_ALLOWED_FONT_DOWNLOADS_V1\n');
      assert.equal((await run('font.downloads')).allowed, true);
      const started = await run('font.download', { family: downloadedFamily });
      assert.equal(started.state, 'downloading');
      assert.equal(started.total, 92870);
      const waitForInstalled = async family => {
        let download;
        for (let attempt = 0; attempt < 200; attempt++) {
          download = (await run('font.downloads')).downloads.find(entry => entry.family === family);
          if (download?.state !== 'downloading') break;
          await delay(50);
        }
        assert.equal(download?.state, 'installed', JSON.stringify(download));
      };
      await waitForInstalled(downloadedFamily);
      const installed = await run('font.download', { family: downloadedFamily });
      assert.equal(installed.state, 'installed');
      assert.ok(installed.refitted.includes(fontTarget));
      assert.ok((await run('text.fonts')).includes(downloadedFamily));
      assert.match(await rendered(), /^[a-f0-9]{64}$/);
      const store = join(profile, 'native-v1', 'font-store');
      const folders = await readdir(store);
      assert.equal(folders.length, 1);
      assert.deepEqual((await readdir(join(store, folders[0]))).sort(), ['0.ttf', '1.ttf', 'LICENSE.txt', 'verified']);
      assert.match(await readFile(join(store, folders[0], 'LICENSE.txt'), 'utf8'), /SIL OPEN FONT LICENSE/);
      const notoFamily = 'Noto Sans Tifinagh Adrar';
      assert.equal((await run('font.download', { family: notoFamily })).source, 'Noto');
      await waitForInstalled(notoFamily);
      assert.ok((await run('text.fonts')).includes(notoFamily));

      const variableFamily = 'Ballet';
      assert.equal((await run('font.download', { family: variableFamily })).source, 'Google Fonts');
      await waitForInstalled(variableFamily);
      const { id: variableText } = await create('Variable preview', { fontFamily: variableFamily, fontSize: 24 });
      const variablePng = async () => (await call('screenshot', { ids: [variableText] })).sha256;
      const beforeVariation = await variablePng();
      const axis = (await run('text.fonts', { family: variableFamily, axes: true })).axes.find(axis => axis.tag === 'opsz');
      assert.ok(axis);
      assert.deepEqual(await run('text.preview', {
        command: 'text.setVariations', params: { id: variableText, variations: { opsz: axis.max } },
      }), { previewing: true });
      assert.notEqual(await variablePng(), beforeVariation);
      assert.deepEqual(await run('text.endPreview'), { ended: true });
      assert.equal(await variablePng(), beforeVariation);
    }

    const { id: missing } = await create('Absent face', { fontFamily: 'OMC-No-Such-Test-Font' });
    const missingFonts = await run('text.missingFonts');
    assert.ok(missingFonts.families.some(item => item.family === 'OMC-No-Such-Test-Font' && item.layers.includes(missing)));
    if (process.env.OMC_TEST_FONT_DOWNLOAD === '1') {
      await client.close();
      service.kill();
      await exited;
      await rm(join(profile, 'native-v1', 'service.json'), { force: true });
      const restarted = spawn(binary, ['--profile', profile, '--port', '0'], { stdio: 'inherit' });
      const restartExited = once(restarted, 'exit');
      const restartClient = new Client({ name: 'persistent-font-check', version: '1.0.0' });
      try {
        const descriptor = await serviceDescriptor(profile, restarted);
        await restartClient.connect(new StreamableHTTPClientTransport(new URL(descriptor.endpoint + '/mcp/figcraft'), {
          requestInit: { headers: { Authorization: `Bearer ${descriptor.token}` } },
        }));
        const result = await restartClient.callTool({ name: 'run_command', arguments: { command: 'font.download', params: { family: downloadedFamily } } });
        assert.ok(!result.isError, result.content[0].text);
        assert.deepEqual(result.structuredContent, { family: downloadedFamily, state: 'installed', refitted: [] });
      } finally {
        await restartClient.close();
        restarted.kill();
        await restartExited;
      }
    }
  } finally {
    await client.close();
    service.kill();
    await exited;
    await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
