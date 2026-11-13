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
  ? pathToFileURL(join(sdk, 'dist/esm/client/index.js'))
  : '@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = await import(sdk
  ? pathToFileURL(join(sdk, 'dist/esm/client/streamableHttp.js'))
  : '@modelcontextprotocol/sdk/client/streamableHttp.js');
const binaryName = process.platform === 'win32' ? 'omc-service.exe' : 'omc-service';
const binary = process.env.OMC_SERVICE_BINARY
  ?? fileURLToPath(new URL('../target/debug/' + binaryName, import.meta.url));

async function descriptor(profile, service) {
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

test('FigCraft handoff, component, comment and board commands change the native document', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'omc-figcraft-handoff-'));
  const service = spawn(binary, ['--profile', profile, '--port', '0'], { stdio: 'inherit' });
  const exited = once(service, 'exit');
  const fig = new Client({ name: 'figcraft-handoff-contracts', version: '1.0.0' });
  const peer = new Client({ name: 'figcraft-board-peer', version: '1.0.0' });
  const call = async (name, arguments_ = {}, client = fig) => {
    const result = await client.callTool({ name, arguments: arguments_ });
    if (result.isError) throw new Error(result.content[0].text);
    return result.structuredContent ?? JSON.parse(result.content.find(item => item.type === 'text').text);
  };
  const run = (command, params = {}) => call('run_command', { command, params });

  try {
    const { endpoint, token } = await descriptor(profile, service);
    await fig.connect(new StreamableHTTPClientTransport(new URL(endpoint + '/mcp/figcraft'), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }));
    await run('file.new', { name: 'Handoff fixture' });
    const { id: frame } = await call('create_node', { type: 'frame', name: 'Payment', x: 10, y: 20, width: 120, height: 80 });
    const { id: category } = await run('annotation.addCategory', { name: '검토', color: '#147' });
    const added = await run('annotation.add', { id: frame, text: '최소 너비', properties: ['Width', 'top'], category });
    assert.deepEqual(added, { id: frame, index: 0 });
    const readNotes = async params => (await run('annotation.list', params)).annotations;
    let [note] = await readNotes({ page: 'all', category: '검토' });
    assert.equal(note.label, '최소 너비');
    assert.equal(note.category.color, '#114477');
    assert.deepEqual(note.properties.map(property => property.value), [120, 20]);
    await run('annotation.edit', { id: frame, index: 0, label: 'Spacing', properties: ['height'] });
    await run('annotation.editCategory', { id: category, name: 'Handoff', color: '#123456' });
    assert.equal((await run('annotation.categories')).categories.find(item => item.id === category).count, 1);
    assert.deepEqual(await run('annotation.removeCategory', { id: category }), { id: category, uncategorized: 1 });
    [note] = await readNotes({ id: frame, category: 'none' });
    assert.equal(note.label, 'Spacing');
    assert.equal(note.category, undefined);
    assert.equal(note.properties[0].value, 80);
    await run('annotation.remove', { id: frame, index: 0 });
    assert.deepEqual(await readNotes({ id: frame }), []);
    await call('undo');
    assert.equal((await readNotes({ id: frame }))[0].label, 'Spacing');

    assert.deepEqual(await run('devResource.add', { id: frame, url: 'https://www.example.com/' }), { id: frame, index: 0 });
    assert.deepEqual(await run('devResource.list', { id: frame }), [{ name: 'example.com', url: 'https://www.example.com/', index: 0 }]);
    await run('devResource.edit', { id: frame, index: 0, url: 'https://example.com/design', name: 'Design notes' });
    assert.deepEqual(await run('devResource.list', { id: frame }), [{ name: 'Design notes', url: 'https://example.com/design', index: 0 }]);
    await assert.rejects(run('devResource.add', { id: frame, url: 'file:///tmp/a' }), /HTTP or HTTPS/);
    assert.deepEqual(await run('devResource.remove', { id: frame, index: 0 }), { removed: 1 });
    assert.deepEqual(await run('devResource.list', { id: frame }), []);
    await call('undo');
    assert.equal((await run('devResource.list', { id: frame }))[0].url, 'https://example.com/design');

    const { id: destination } = await call('create_node', { type: 'frame', name: 'Receipt', x: 180, y: 20, width: 120, height: 80 });
    const { id: button } = await call('create_node', { type: 'rectangle', parent: frame, name: 'Pay', x: 10, y: 15, width: 40, height: 20 });
    const pages = await run('page.list');
    const currentPage = pages[0].id;
    assert.deepEqual(await run('inspect.readyForDev'), { items: [] });
    await assert.rejects(run('node.set', { ids: [button], props: { devStatus: 'readyForDev' } }), /top-level frame/);
    await run('node.set', { ids: [frame], props: { devStatus: 'readyForDev' } });
    assert.equal((await call('get_node', { id: frame })).devStatus, 'readyForDev');
    assert.deepEqual((await run('inspect.readyForDev', { page: currentPage })).items, [
      { id: frame, name: 'Payment', page: currentPage, status: 'readyForDev', changed: false },
    ]);
    await run('node.set', { ids: [button], props: { width: 55 } });
    assert.equal((await run('inspect.readyForDev', { status: 'changed' })).items[0].changed, true);
    await call('undo');
    assert.deepEqual((await run('inspect.readyForDev', { status: 'changed' })).items, []);
    const version = await run('file.saveVersion', { name: 'Handoff baseline' });
    const removedLayer = await run('shape.rectangle', { parent: frame, name: 'Remove this', x: 3, y: 4, width: 8, height: 8 });
    await run('node.set', { ids: [frame], props: { devStatus: 'readyForDev' } });
    await run('edit.delete', { ids: [removedLayer.id] });
    const addedLayer = await run('shape.rectangle', { parent: frame, name: 'New design', x: 8, y: 4, width: 6, height: 8 });
    await run('node.set', { ids: [button], props: { width: 64 } });
    const comparison = await run('dev.compare', { id: frame });
    assert.equal(comparison.snapshot, true);
    assert.equal(comparison.changed, true);
    assert.equal(comparison.added, 1);
    assert.equal(comparison.removed, 1);
    assert.ok(comparison.changes.find(row => row.id === button).properties.some(property => property.property === 'width' && property.before === '40' && property.after === '64'));
    assert.ok(comparison.changes.some(row => row.id === removedLayer.id && row.change === 'removed'));
    assert.ok(comparison.changes.some(row => row.id === addedLayer.id && row.change === 'added'));
    const previousVersion = await run('dev.compare', { id: frame, version: version.id });
    assert.equal(previousVersion.version.name, 'Handoff baseline');
    assert.equal(previousVersion.added, 1);
    assert.equal(previousVersion.removed, 0);
    assert.deepEqual(await run('dev.resolveChange', { ids: [frame], reason: 'Revised dimensions' }), { ids: [frame], resolved: 1, reason: 'Revised dimensions' });
    assert.equal((await run('dev.compare', { id: frame })).changed, false);
    assert.equal((await run('dev.compare', { id: frame, version: version.id })).changed, true);
    await call('undo');
    assert.equal((await run('dev.compare', { id: frame })).changed, true);
    await run('edit.delete', { ids: [addedLayer.id] });

    await run('node.set', { ids: [frame], props: { devStatus: 'completed' } });
    assert.equal((await run('inspect.readyForDev', { status: 'any' })).items[0].status, 'completed');
    assert.equal((await run('inspect.readyForDev', { status: 'completed' })).items[0].changed, false);
    await run('node.set', { ids: [frame], props: { devStatus: 'none' } });
    assert.deepEqual((await run('inspect.readyForDev', { status: 'any' })).items, []);
    assert.deepEqual(await run('proto.interaction.add', { id: button, dest: destination }), { index: 0 });
    await assert.rejects(run('proto.interaction.set', { id: button, index: 0, trigger: { type: 'invalid' } }), /Unknown prototype trigger/);
    await run('proto.interaction.set', { id: button, index: 0, action: { type: 'navigate', dest: destination } });
    await run('proto.interaction.remove', { id: button, index: 0 });
    await assert.rejects(run('proto.interaction.remove', { id: button, index: 0 }), /No interaction/);
    await run('proto.interaction.add', { id: button, action: { type: 'navigate', dest: destination } });
    await run('proto.interaction.clear', { ids: [button] });
    await run('proto.interaction.add', { id: button, dest: destination });
    assert.deepEqual(await run('proto.flow.add', { start: frame }), { start: frame, name: 'Flow 1' });
    await run('proto.flow.rename', { start: frame, name: 'Purchase', description: 'Finish payment' });
    await run('proto.flow.add', { start: destination, name: 'Receipt Flow' });
    await run('proto.flow.remove', { start: destination });
    assert.deepEqual(await run('proto.flow.add', { start: destination }), { start: destination, name: 'Flow 2' });
    await run('node.set', { ids: [frame, destination], props: { devStatus: 'readyForDev' } });
    await run('node.set', { ids: [button], props: { width: 57 } });
    await run('proto.settings', { width: 501, height: 252, background: '#445566', responsive: true });
    await run('proto.action.add', { id: button, index: 0, action: { type: 'closeOverlay' } });
    const saved = await run('file.saveAs', { data: true });
    await run('file.open', { data: saved.data, name: 'Reopened handoff.figcraft' });
    const [reopened, reopenedDestination] = (await call('inspect_document')).layers;
    const reopenedSettings = await run('proto.settings');
    assert.deepEqual(reopenedSettings.screen, { width: 501, height: 252 });
    assert.equal(reopenedSettings.background, '#445566');
    assert.equal(reopenedSettings.responsive, true);
    assert.deepEqual((await run('inspect.readyForDev')).items.map(({ name, changed }) => [name, changed]), [
      ['Payment', true], ['Receipt', false],
    ]);
    assert.equal((await readNotes({ id: reopened.id }))[0].label, 'Spacing');
    assert.equal((await run('devResource.list', { id: reopened.id }))[0].url, 'https://example.com/design');
    assert.deepEqual(await run('proto.flow.add', { start: reopened.id }), { start: reopened.id, name: 'Purchase' });
    const [reopenedButton] = (await call('get_node', { id: reopened.id })).children;
    const reopenedActions = (await call('get_node', { id: reopenedButton.id })).interactions[0].actions;
    assert.deepEqual(reopenedActions, [{ type: 'navigate', dest: reopenedDestination.id }, { type: 'closeOverlay' }]);
    await run('proto.interaction.remove', { id: reopenedButton.id, index: 0 });
    await assert.rejects(run('proto.interaction.remove', { id: reopenedButton.id, index: 0 }), /No interaction/);

    await run('file.new', { name: 'Prototype expressions' });
    const { id: theme } = await run('variable.createCollection', { name: 'Theme', modes: ['Light', 'Dark'] });
    const { id: count } = await run('variable.create', {
      name: 'count', collection: theme, type: 'number', values: { Light: 1, Dark: 8 },
    });
    const { id: expressionFrame } = await run('frame.create', { name: 'Checkout', x: 0, y: 0, width: 80, height: 80 });
    const { id: other } = await run('frame.create', { name: 'Thanks', x: 90, y: 0, width: 80, height: 80 });
    await run('variable.setMode', { ids: [expressionFrame], collection: theme, mode: 'Dark' });
    const { id: textVariable } = await run('variable.create', {
      name: 'banner', collection: theme, type: 'string', values: { Light: 'Default banner', Dark: 'Night banner' },
    });
    const { id: boundText } = await run('text.create', {
      parent: expressionFrame, characters: 'Authored text', width: 180, props: { fontSize: 16, fill: '#111111' },
    });
    await run('variable.bind', { ids: [boundText], field: 'characters', variable: textVariable });
    assert.equal((await call('get_node', { id: boundText })).characters, 'Authored text');
    assert.match((await run('file.exportSvg', { ids: [expressionFrame] })).content, /Night banner/);
    await run('variable.bind', { ids: [boundText], field: 'characters', variable: null });
    assert.equal((await call('get_node', { id: boundText })).characters, 'Night banner');
    await run('variable.set', { variable: textVariable, mode: 'Dark', value: 'New mode banner' });
    assert.match((await run('file.exportSvg', { ids: [expressionFrame] })).content, /Night banner/);

    assert.deepEqual(await run('proto.evaluate', { expression: 'count * 2 + 3' }), { value: { type: 'number', value: 5 }, type: 'number', text: '(count * 2) + 3' });
    assert.deepEqual(await run('proto.evaluate', { expression: 'count * 2 + 3', id: expressionFrame }), { value: { type: 'number', value: 19 }, type: 'number', text: '(count * 2) + 3' });
    assert.deepEqual((await run('proto.evaluate', { expression: 'count[Dark] >= 8 and not (mode(Theme) == "Dark")' })).value, { type: 'boolean', value: true });
    const ast = { op: { op: 'add', args: [{ value: { type: 'alias', value: count } }, { value: { type: 'number', value: 3 } }] } };
    assert.equal((await run('proto.evaluate', { expr: ast })).value.value, 4);
    const colorExpression = await run('proto.evaluate', { expression: '#0abc' });
    assert.equal(colorExpression.text, '#00AABBCC');
    assert.equal(colorExpression.value.type, 'color');
    assert.equal(Math.round(colorExpression.value.value.a * 255), 204);
    await assert.rejects(run('proto.evaluate', { expression: 'count / 0' }), /could not be evaluated/);
    await assert.rejects(run('proto.evaluate', { expression: '"text" * 2' }), /operands/);
    assert.deepEqual(await run('proto.interaction.add', {
      id: expressionFrame, action: { type: 'setVariable', variable: 'count', expression: 'count + 1' },
    }), { index: 0 });
    const interaction = { id: expressionFrame, index: 0 };
    const condition = {
      type: 'conditional',
      blocks: [{ expression: 'count >= 8', actions: [{ type: 'navigate', dest: other }] }],
    };
    assert.deepEqual(await run('proto.action.add', { ...interaction, action: condition }), { path: [1] });
    assert.deepEqual(await run('proto.conditional.addBlock', { ...interaction, path: [1], else: true }), { block: 1 });
    assert.deepEqual(await run('proto.conditional.addBlock', { ...interaction, path: [1], expression: 'count > 4' }), { block: 1 });
    await run('proto.conditional.setCondition', { ...interaction, path: [1], block: 1, expression: 'count > 3' });
    assert.deepEqual(await run('proto.action.add', {
      ...interaction, path: [1, 2, 0], action: { type: 'setVariableMode', collection: theme, mode: 'Light' },
    }), { path: [1, 2, 0] });
    await run('proto.action.set', { ...interaction, path: [1, 2, 0], action: { type: 'back' } });
    assert.deepEqual(await run('proto.action.move', { ...interaction, path: [1], to: 0 }), { path: [0] });
    let stored = (await call('get_node', { id: expressionFrame })).interactions[0].actions;
    assert.equal(stored[0].blocks[0].actions[0].dest, other);
    assert.equal(stored[0].blocks[2].actions[0].type, 'back');
    await assert.rejects(run('proto.conditional.setCondition', {
      ...interaction, path: [0], block: 0, expression: 'count + 1',
    }), /true or false/);
    await run('proto.action.remove', { ...interaction, path: [0, 2, 0] });
    assert.deepEqual(await run('proto.conditional.removeBlock', { ...interaction, path: [0], block: 0 }), { removedAction: false });
    assert.deepEqual(await run('proto.conditional.removeBlock', { ...interaction, path: [0], block: 0 }), { removedAction: true });
    stored = (await call('get_node', { id: expressionFrame })).interactions[0].actions;
    assert.equal(stored.length, 1);
    assert.equal(stored[0].variable, count);
    await assert.rejects(run('proto.action.remove', { ...interaction, path: [0] }), /must keep one action/);
    await run('edit.undo');
    assert.equal((await call('get_node', { id: expressionFrame })).interactions[0].actions[0].type, 'conditional');
    assert.equal((await run('proto.settings')).device, 'None');
    const portrait = await run('proto.settings', { device: 'iphone 17 pro', rotation: 0, color: 'silver' });
    assert.deepEqual(portrait.screen, { width: 402, height: 874 });
    assert.equal(portrait.color, 'Silver');
    assert.deepEqual((await run('proto.settings', { rotation: 'landscape' })).screen, { width: 874, height: 402 });
    await assert.rejects(run('proto.settings', { device: 'unknown phone' }), /Unknown device/);
    assert.equal((await run('proto.settings')).device, 'iPhone 17 Pro');
    assert.deepEqual((await run('proto.settings', {
      width: 500, height: 250, responsive: true, background: '#123456',
    })).screen, { width: 500, height: 250 });
    assert.equal((await run('proto.settings')).responsive, true);
    assert.deepEqual(await run('proto.linkNotice', { show: false }), { shown: false });
    assert.deepEqual(await run('proto.linkNotice'), { shown: true });
    assert.deepEqual(await run('proto.presentOptions', { scale: 'actual', hideUi: true }), { ok: true });

    await run('file.new', { name: 'Component property fixture' });
    const card = async (name, x, fill) => {
      const { id: frame } = await call('create_node', { type: 'frame', name, x, y: 20, width: 90, height: 60, props: { fill } });
      const { id: text } = await call('create_node', { type: 'text', name: 'Label', text: name, parent: frame, x: 10, y: 10, width: 70, height: 20 });
      const { id } = await run('component.create', { ids: [frame] });
      return { id, text };
    };
    const normal = await card('Normal', 0, '#dd0000');
    const pressed = await card('Pressed', 100, '#0044dd');
    const { id: variants } = await run('component.combineVariants', { ids: [normal.id, pressed.id] });
    assert.equal((await call('get_node', { id: normal.id })).name, 'Property 1=Default');
    assert.deepEqual((await run('component.properties', { id: variants })).properties[0].options, ['Default', 'Variant2']);
    const { id: third } = await run('component.addVariant', { id: variants, property: 'Property 1', value: 'Loading' });
    assert.equal((await call('get_node', { id: third })).name, 'Property 1=Loading');
    const { id: instance } = await run('instance.create', { component: variants, x: 300, y: 20 });
    await run('instance.setProperties', { ids: [instance], properties: { 'Property 1': 'Variant2' } });
    assert.equal((await run('component.goToMain', { id: instance })).id, pressed.id);
    assert.match((await run('file.exportSvg', { ids: [instance] })).content, /#(?:04d|0044dd)/i);
    await run('component.hideWhenPublishing', { ids: [variants], on: true });
    assert.match((await call('get_node', { id: variants })).name, /^\./);
    await run('component.hideWhenPublishing', { ids: [variants], on: false });

    await run('component.addProperty', { id: pressed.id, name: 'Caption', type: 'text', default: 'Default caption', layer: pressed.text });
    await run('component.addProperty', { id: pressed.id, name: 'Visible', type: 'boolean', default: true });
    await run('component.bindProperty', { layer: pressed.text, property: 'Visible', field: 'visible' });
    await run('component.editProperty', { id: pressed.id, name: 'Caption', newName: 'Headline', default: 'Starting text' });
    await run('instance.setProperties', { ids: [instance], properties: { Headline: 'MCP live text', Visible: false } });
    const settings = async () => (await run('component.properties', { id: instance })).properties;
    assert.equal((await settings()).find(property => property.name === 'Headline').value, 'MCP live text');
    assert.equal((await settings()).find(property => property.name === 'Visible').value, false);
    assert.doesNotMatch((await run('file.exportSvg', { ids: [instance] })).content, /MCP live/);
    await run('instance.setProperties', { ids: [instance], properties: { Visible: true } });
    assert.match((await run('file.exportSvg', { ids: [instance] })).content, /MCP live/);
    await assert.rejects(run('instance.setProperties', { ids: [instance], properties: { Headline: 'Rollback', Visible: 'invalid' } }), /boolean/);
    assert.equal((await settings()).find(property => property.name === 'Headline').value, 'MCP live text');
    const css = await run('inspect.code', { id: pressed.text, unit: 'rem', rootFontSize: 10 });
    assert.equal(css.language, 'css');
    assert.equal(css.connected, false);
    assert.match(css.code, /width: 7rem/);
    const htmlCode = await run('inspect.code', { id: instance, language: 'html' });
    assert.match(htmlCode.code, /<p[^>]*>.*MCP live text.*<\/p>/);
    const tailwindCode = await run('inspect.code', { id: instance, language: 'tailwind' });
    assert.match(tailwindCode.code, /className="[^"]*\[width:/);
    const generated = await run('inspect.componentCode', { id: instance });
    assert.match(generated.definition, /props\["headline"\]/);
    assert.match(generated.definition, /props\["visible"\]/);
    assert.match(generated.usage, /headline=\{"MCP live text"\}/);
    assert.equal(generated.properties.find(property => property.name === 'Headline').value, 'MCP live text');
    assert.equal(generated.connected, null);
    const frameworkOutput = [
      ['leptos', /view!/, /prop_headline/, /MCP live text/],
      ['vue', /<template>/, /v-text=/, /MCP live text/],
      ['swiftui', /import SwiftUI/, /property_headline/, /MCP live text/],
      ['compose', /@Composable/, /property_headline/, /MCP live text/],
      ['arkui', /@Component/, /this.property_headline/, /MCP live text/],
      ['flutter', /extends StatelessWidget/, /property_headline/, /MCP live text/],
    ];
    for (const [language, implementation, binding, value] of frameworkOutput) {
      const snippet = await run('inspect.code', { id: pressed.id, language });
      assert.equal(snippet.connected, false);
      assert.match(snippet.code, implementation);
      const componentCode = await run('inspect.componentCode', { id: instance, language });
      assert.match(componentCode.definition, implementation);
      assert.match(componentCode.definition, binding);
      assert.match(componentCode.usage, value);
      if (language === 'swiftui' && process.env.OMC_TEST_SWIFT_CODE) {
        await writeFile(process.env.OMC_TEST_SWIFT_CODE, componentCode.definition);
      }
    }
    const { id: mobile } = await run('frame.create', { name: 'Mobile', width: 190, height: 330 });
    const { id: desktop } = await run('frame.create', { name: 'Desktop', width: 700, height: 450 });
    await run('shape.rectangle', { name: 'Hero', parent: mobile, width: 80, height: 60 });
    await run('shape.rectangle', { name: 'Hero', parent: desktop, width: 400, height: 120 });
    const responsive = await run('inspect.code', { id: desktop, language: 'tailwind', mobile });
    assert.match(responsive.code, /\[width:190(?:.0)?px\]/);
    assert.match(responsive.code, /lg:\[width:700(?:.0)?px\]/);
    assert.match(responsive.code, /\[width:80(?:.0)?px\]/);
    assert.match(responsive.code, /lg:\[width:400(?:.0)?px\]/);

    const playgroundPath = join(profile, 'playground-preview.png');
    const initialInstance = await call('get_node', { id: instance });
    const playground = await run('component.playground', {
      id: variants, properties: { 'Property 1': 'Variant2', Headline: 'Temporary playground content', Visible: true },
      language: 'html', path: playgroundPath, scale: 1,
    });
    assert.equal(playground.language, 'html');
    assert.equal(playground.width, 90);
    assert.equal(playground.height, 60);
    assert.equal(playground.properties.find(property => property.name === 'Headline').value, 'Temporary playground content');
    assert.match(playground.code, /Temporary playground content/);
    const playgroundPng = await readFile(playgroundPath);
    assert.deepEqual([...playgroundPng.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    assert.equal(playgroundPng.readUInt32BE(16), 90);
    assert.equal(playgroundPng.readUInt32BE(20), 60);
    assert.deepEqual(await call('get_node', { id: instance }), initialInstance);
    await assert.rejects(run('component.playground', {
      id: instance, properties: { Headline: 'Do not persist', Visible: 'invalid' }, language: 'html',
    }), /boolean/);
    assert.deepEqual(await call('get_node', { id: instance }), initialInstance);

    const { id: exposedHostFrame } = await run('frame.create', { name: 'Exposed host', x: 800, y: 25, width: 130, height: 110 });
    const { id: exposedHost } = await run('component.create', { ids: [exposedHostFrame] });
    const { id: nestedMain } = await run('instance.create', { component: pressed.id, parent: exposedHost, x: 5, y: 10 });
    const { id: outer } = await run('instance.create', { component: exposedHost, x: 950, y: 25 });
    const { id: otherOuter } = await run('instance.create', { component: exposedHost, x: 1100, y: 25 });
    assert.deepEqual(await run('instance.exposed', { id: outer }), { instances: [] });
    await assert.rejects(run('component.exposeInstance', { id: outer }), /nested instances/);
    assert.deepEqual(await run('component.exposeInstance', { id: nestedMain }), { id: nestedMain, exposed: true });
    const [exposed] = (await run('instance.exposed', { id: outer })).instances;
    assert.ok(exposed.id !== nestedMain);
    const [otherExposed] = (await run('instance.exposed', { id: otherOuter })).instances;
    assert.ok(otherExposed.id !== exposed.id);
    const exposedHeadline = async id => (await run('component.properties', { id })).properties.find(property => property.name === 'Headline').value;
    assert.equal(await exposedHeadline(exposed.id), 'Starting text');
    await run('instance.setProperties', { ids: [exposed.id], properties: { Headline: 'Nested only' } });
    assert.equal(await exposedHeadline(exposed.id), 'Nested only');
    assert.equal(await exposedHeadline(otherExposed.id), 'Starting text');
    assert.match((await run('file.exportSvg', { ids: [outer] })).content, /Nested[\s\S]*only/);
    await run('component.exposeInstance', { id: nestedMain, exposed: false });
    assert.deepEqual(await run('instance.exposed', { id: outer }), { instances: [] });
    await assert.rejects(run('instance.setProperties', { ids: [exposed.id], properties: { Headline: 'Rejected' } }), /exposed nested instance/);
    await run('edit.undo');
    assert.deepEqual((await run('instance.exposed', { id: outer })).instances, [exposed]);
    assert.equal(await exposedHeadline(exposed.id), 'Nested only');
    const connection = await run('codeConnect.set', {
      id: instance, importPath: '@/components', name: 'AppButton',
      template: '<AppButton text={Headline} hidden={Visible ? "shown" : "hidden"} {unknown} />',
    });
    assert.equal(connection.component, variants);
    assert.match(connection.code, /import \{ AppButton \} from "@\/components";/);
    assert.match(connection.code, /text="MCP live text" hidden="shown" \{unknown\}/);
    assert.deepEqual(connection.unknown, ['unknown']);
    const connectedCode = await run('inspect.code', { id: instance, language: 'react' });
    assert.equal(connectedCode.connected, true);
    assert.equal(connectedCode.code, connection.code);
    const connectedComponent = await run('inspect.componentCode', { id: instance });
    assert.match(connectedComponent.connected.import, /AppButton/);
    assert.match(connectedComponent.connected.code, /MCP live text/);
    assert.match(connectedComponent.usage, /^<AppButton/);
    assert.equal(connectedComponent.connected.code, connection.code);
    const update = await run('codeConnect.set', { id: pressed.id, name: 'RenamedButton' });
    assert.match(update.code, /import \{ RenamedButton \} from "@\/components";/);
    const { text: connectionText, links } = await run('codeConnect.export');
    assert.equal(links, 1);
    const exportedLink = JSON.parse(connectionText).links[0];
    assert.equal(exportedLink.name, 'RenamedButton');
    const connectionPath = join(profile, 'figcraft.connect.json');
    assert.equal((await run('codeConnect.export', { path: connectionPath })).path, connectionPath);
    assert.equal(await readFile(connectionPath, 'utf8'), connectionText);
    await assert.rejects(run('codeConnect.export', { path: connectionPath }), /exists/);
    assert.equal((await run('codeConnect.remove', { id: instance, language: 'react' })).removed, 1);
    assert.equal((await run('codeConnect.export')).links, 0);
    assert.deepEqual(await run('codeConnect.import', { path: connectionPath }), { linked: 1, warnings: [] });
    const imported = await run('codeConnect.import', {
      json: { version: 1, links: [
        { ...exportedLink, component: 'Missing' },
        { ...exportedLink, language: 'vue', template: '<AppButton :text="{Headline}" />' },
      ] },
    });
    assert.equal(imported.linked, 1);
    assert.match(imported.warnings[0], /Unknown component Missing/);
    assert.equal((await run('codeConnect.export')).links, 2);
    await call('undo');
    assert.equal((await run('codeConnect.export')).links, 1);
    await run('component.resetOverride', { id: instance, group: 'props' });
    assert.equal((await settings()).find(property => property.name === 'Headline').value, 'Starting text');
    await run('component.bindProperty', { layer: pressed.text, property: null, field: 'visible' });
    await run('component.deleteProperty', { id: pressed.id, name: 'Visible' });
    assert.ok(!(await settings()).some(property => property.name === 'Visible'));

    const { id: slotHostFrame } = await run('frame.create', { name: 'Slot host', x: 540, y: 25, width: 140, height: 100 });
    const { id: slotFrame } = await run('frame.create', { name: 'Leading', parent: slotHostFrame, width: 40, height: 35 });
    const { id: slotHost } = await run('component.create', { ids: [slotHostFrame] });
    await run('component.makeSlot', { id: slotFrame, name: 'Leading', preferred: [normal.id] });
    const { id: slotInstance } = await run('instance.create', { component: slotHost, x: 720, y: 25 });
    const slotProperty = async () => (await run('component.properties', { id: slotInstance })).properties.find(item => item.name === 'Leading');
    assert.deepEqual((await slotProperty()).preferred, [normal.id]);
    assert.equal((await slotProperty()).layer, slotFrame);
    assert.equal((await slotProperty()).value, false);
    await run('instance.slotInsert', { id: slotInstance, slot: 'Leading', component: normal.id, replace: true });
    assert.equal((await slotProperty()).value, true);
    await run('component.resetOverride', { id: slotInstance, group: 'slot' });
    assert.equal((await slotProperty()).value, false);
    await run('edit.undo');
    assert.equal((await slotProperty()).value, true);

    const { id: variantFrame } = await run('frame.create', { name: 'Property variant fixture', x: 1550, y: 10, width: 45, height: 34 });
    const { id: initialVariant } = await run('component.create', { ids: [variantFrame] });
    const { id: propertySet } = await run('component.addProperty', { id: initialVariant, name: 'Style', type: 'variant', default: 'Base' });
    assert.notEqual(propertySet, initialVariant);
    await run('component.addProperty', { id: propertySet, name: 'Size', type: 'variant', default: 'Small' });
    const { id: selectedVariant } = await run('component.addVariant', { id: propertySet, property: 'Style', value: 'Alt' });
    await run('component.editProperty', { id: propertySet, name: 'Style', newName: 'Theme', value: 'Alt', newValue: 'Bold', default: 'Bold', index: 1 });
    assert.equal((await call('get_node', { id: selectedVariant })).name, 'Size=Small, Theme=Bold');
    const propertyOrder = (await run('component.properties', { id: propertySet })).properties;
    assert.deepEqual(propertyOrder.map(p => p.name), ['Size', 'Theme']);
    assert.equal(propertyOrder[1].default, 'Bold');
    const { id: defaultInstance } = await run('instance.create', { component: propertySet, x: 1600, y: 10 });
    assert.equal((await run('component.goToMain', { id: defaultInstance })).id, selectedVariant);
    await run('component.deleteProperty', { id: propertySet, name: 'Size' });
    assert.equal((await call('get_node', { id: selectedVariant })).name, 'Theme=Bold');
    const { id: swapTarget } = await run('instance.create', { component: normal.id, parent: slotHost, x: 20, y: 25 });
    await run('component.addProperty', { id: slotHost, layer: swapTarget, name: 'Icon', type: 'instanceSwap', default: normal.id, preferred: [variants, normal.id] });
    const swapProperty = async () => (await run('component.properties', { id: slotHost })).properties.find(item => item.name === 'Icon');
    assert.deepEqual((await swapProperty()).preferred, [variants, normal.id]);
    assert.equal((await swapProperty()).default, normal.id);
    await run('component.editProperty', { id: slotHost, name: 'Icon', preferred: [pressed.id] });
    assert.deepEqual((await swapProperty()).preferred, [pressed.id]);
    const { id: trailingFrame } = await run('frame.create', { name: 'Trailing content', parent: slotHost, width: 30, height: 28 });
    await run('component.addProperty', { id: slotHost, name: 'Trailing', type: 'slot', layer: trailingFrame, preferred: [variants] });
    await run('component.editProperty', { id: slotHost, name: 'Trailing', newName: 'End', preferred: [pressed.id] });
    const endSlot = async () => (await run('component.properties', { id: slotHost })).properties.find(item => item.name === 'End');
    assert.deepEqual((await endSlot()).preferred, [pressed.id]);
    await run('component.bindProperty', { layer: trailingFrame, field: 'slot', property: null });
    assert.equal((await endSlot()).layer, null);
    await run('component.bindProperty', { layer: trailingFrame, field: 'slot', property: 'End' });
    assert.equal((await endSlot()).layer, trailingFrame);
    await run('component.deleteProperty', { id: slotHost, name: 'End' });
    assert.equal(await endSlot(), undefined);

    const { id: a } = await run('comment.add', { x: 310, y: 30, anchor: instance, text: 'Check contrast with @Dana' });
    const { id: b, link } = await run('comment.add', { x: 320, y: 35, anchor: instance, text: 'Other review item', author: 'Dana' });
    const review = (await run('comment.list', { frame: instance, mentions: 'Dana' })).comments;
    assert.deepEqual(review.map(item => item.id), [a]);
    assert.deepEqual(await run('comment.markRead', { id: a, read: false }), { changed: 1 });
    assert.deepEqual((await run('comment.list', { filter: 'unread' })).comments.map(item => item.id), [a]);
    assert.equal((await run('comment.open', { link, view: 'fit' })).id, b);
    const next = await run('comment.next', { filter: 'unread' });
    assert.equal(next.id, a);
    assert.equal(next.unread, false);
    assert.deepEqual((await run('comment.list', { filter: 'unread' })).comments, []);
    assert.ok((await run('comment.zoom', { ids: [a, b] })).zoom > 1);
    const brief = await run('comment.prompt', { ids: [a] });
    assert.equal(brief.count, 1);
    assert.equal(brief.comments[0].id, a);
    assert.match(brief.text, /> Check contrast with @Dana/);
    assert.doesNotMatch(brief.text, /Other review item/);

    const { id: boardDocument } = await run('file.new', { name: 'Board fixture' });
    const sticky = await run('board.sticky', { x: 30, y: 35, text: 'Sprint note', color: 'yellow', author: 'Dana' });
    assert.equal((await call('get_node', { id: sticky.text })).characters, 'Sprint note');
    assert.match((await run('file.exportSvg', { ids: [sticky.id] })).content, /#ffe78a/i);
    const nextSticky = await run('board.nextSticky', { id: sticky.id, side: 'right' });
    assert.equal((await call('get_node', { id: nextSticky.id })).x, 254);
    assert.equal((await call('get_node', { id: nextSticky.text })).characters, '');
    const shape = await run('board.shape', { shape: 'diamond', x: 40, y: 260, width: 90, height: 60, text: 'Approve', color: 'blue' });
    const svg = async id => (await run('file.exportSvg', { ids: [id] })).content;
    const diamond = await svg(shape.id);
    assert.match(diamond, /#acd3fa/i);
    await run('board.setColor', { ids: [shape.id], color: '#443399' });
    await run('board.setStyle', { ids: [shape.id], shape: 'ellipse', fontSize: 21 });
    const ellipse = await svg(shape.id);
    assert.match(ellipse, /#(?:439|443399)/i);
    assert.match(ellipse, /font-size="21"/);
    assert.notEqual(ellipse, diamond);
    const marker = await run('board.ink', { points: [[20, 360], [80, 380], [130, 370]], color: '#992233' });
    assert.match(await svg(marker.id), /#(?:923|992233)/i);
    await run('board.setColor', { ids: [marker.id], color: '#114488' });
    assert.match(await svg(marker.id), /#(?:148|114488)/i);
    const stamp = await run('board.stamp', { x: 290, y: 450, stamp: 'question' });
    const stampLayer = await call('get_node', { id: stamp.id });
    assert.equal(stampLayer.x, 270);
    assert.equal(stampLayer.y, 430);
    assert.equal(stampLayer.children.length, 2);
    const stampSvg = await svg(stamp.id);
    assert.match(stampSvg, /fill="#845ed8" d="[^"]*[CQ]/i);
    assert.match(stampSvg, /stroke="(?:white|#fff(?:fff)?)"/i);
    assert.match(stampSvg, /fill="(?:white|#fff(?:fff)?)"/i);
    await call('undo');
    await assert.rejects(call('get_node', { id: stamp.id }), /not found/);
    assert.deepEqual(await run('board.timerState'), { state: 'off', left: 0, text: '0:00', ends: null });
    await assert.rejects(run('board.timer', { action: 'add' }), /Start a timer/);
    await assert.rejects(run('board.timer', { action: 'start', minutes: 0 }), /1 second/);
    await assert.rejects(run('board.timer', { action: 'pause' }), /not running/);
    assert.equal((await run('board.timer', { action: 'start', minutes: 61 })).text, '1:01:00');
    await assert.rejects(run('board.timer', { action: 'resume' }), /not paused/);
    const started = await run('board.timer', { action: 'start', minutes: 1 });
    assert.equal(started.state, 'running');
    assert.ok(started.ends > Date.now());
    const paused = await run('board.timer', { action: 'pause' });
    assert.equal(paused.state, 'paused');
    assert.equal((await run('board.timerState')).left, paused.left);
    assert.equal((await run('board.timer', { action: 'add', minutes: 2 })).left, paused.left + 120000);
    assert.equal((await run('board.timer', { action: 'resume' })).state, 'running');
    assert.equal((await run('board.timer', { action: 'stop' })).state, 'off');
    await peer.connect(new StreamableHTTPClientTransport(new URL(endpoint + '/mcp/figcraft'), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }));
    const peerRun = (command, params = {}) => call('run_command', { command, params, document: boardDocument }, peer);
    assert.deepEqual(await run('board.voteResults'), { state: 'off', sessions: [] });
    const vote = (action, params = {}) => run('board.vote', { action, voter: 'Dana', ...params });
    assert.equal((await vote('start', { on: 'stickies', votes: 2 })).left, 2);
    await assert.rejects(vote('start'), /already running/);
    await assert.rejects(vote('cast', { id: shape.id }), /not on that object/);
    assert.equal((await vote('cast', { id: sticky.id })).left, 1);
    assert.equal((await vote('cast', { id: nextSticky.id })).left, 0);
    await assert.rejects(vote('cast', { id: sticky.id }), /No votes left/);
    assert.equal((await vote('retract', { id: nextSticky.id })).left, 1);
    const peerView = await call('inspect_document', { document: boardDocument }, peer);
    const peerSticky = peerView.layers.find(layer => layer.x === 30);
    const peerVote = await peerRun('board.vote', { action: 'cast', id: peerSticky.id, voter: 'Robin' });
    assert.deepEqual(peerVote.mine, [{ id: peerSticky.id, votes: 1 }]);
    assert.equal(peerVote.voters, 2);
    assert.equal(peerVote.results, undefined);
    const ended = await vote('end');
    assert.equal(ended.state, 'ended');
    assert.equal(ended.results[0].votes, 2);
    assert.equal(ended.results[0].name, 'Sprint note');
    assert.deepEqual(ended.results[0].voters.map(item => item.name), ['Dana', 'Robin']);
    assert.equal((await peerRun('board.voteResults')).sessions[0].results[0].id, peerSticky.id);
    assert.equal((await vote('clear')).sessions[0].onBoard, false);
    assert.deepEqual(await vote('delete', { index: 0 }), { state: 'off', sessions: [] });
  } finally {
    await peer.close();
    await fig.close();
    service.kill();
    await exited;
    for (let i = 0; i < 20; i++) {
      try {
        await rm(profile, { recursive: true, force: true });
        break;
      } catch (error) {
        if (!['EBUSY', 'ENOTEMPTY', 'EPERM'].includes(error.code) || i === 19) throw error;
        await delay(50);
      }
    }
  }
});
