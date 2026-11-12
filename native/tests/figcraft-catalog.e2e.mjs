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

    const jsonExport = await run('variable.export', { collections: [collection], format: 'json' });
    const exported = JSON.parse(jsonExport.text);
    assert.equal(Object.values(exported.meta.variableCollections)[0].name, 'Modes');
    assert.ok(Object.values(exported.meta.variables).find(row => row.name === 'Alias').valuesByMode);
    assert.match((await run('variable.export', { collections: [collection], format: 'css' })).text, /--width: 64px/);
    assert.match((await run('variable.export', { collections: [collection], format: 'tailwind' })).text, /--spacing-width: 64px/);
    assert.match((await run('variable.export', { collections: [collection], format: 'dart' })).text, /static const double width = 64/);
    await run('variable.update', { variable: duplicate, scopes: ['SHAPE_FILL'], hiddenFromPublishing: true, codeSyntax: { WEB: 'var(--brand)' } });
    const updated = (await run('variable.list')).variables.find(row => row.id === duplicate);
    assert.deepEqual(updated.scopes, ['SHAPE_FILL']);
    assert.equal(updated.hiddenFromPublishing, true);
    assert.equal(updated.codeSyntax.WEB, 'var(--brand)');
    const { id: materialized } = await create('rectangle', 'Materialized alias', 350, 10);
    await run('variable.bind', { ids: [materialized], field: 'fill', variable: alias });
    assert.match(await svg(materialized), /#654321/i);
    await run('variable.delete', { variable });
    assert.match(await svg(materialized), /#654321/i);
    assert.equal((await run('variable.list')).variables.find(row => row.id === alias).value, '#654321');
    await run('variable.deleteCollection', { collection });
    assert.match(await svg(materialized), /#654321/i);
    assert.equal((await run('variable.list')).collections.length, 0);
    const imported = await run('variable.import', { variables: jsonExport.text });
    assert.equal(imported.collections, 1);
    assert.equal(imported.variables, 4);
    const importedVars = await run('variable.list');
    const importedAlias = importedVars.variables.find(row => row.name === 'Alias');
    await run('variable.bind', { ids: [materialized], field: 'fill', variable: importedAlias.id });
    assert.match(await svg(materialized), /#654321/i);

    const { id: formulas } = await run('variable.createCollection', { name: 'Formulas', modes: ['Light', 'Dark'] });
    const { id: formulaBase } = await run('variable.create', { collection: formulas, name: 'Formula base', type: 'color', values: { Light: '#ff0000', Dark: '#00ff00' } });
    const { id: mixed } = await run('variable.create', { collection: formulas, name: 'Mixed', type: 'color', value: { mix: { from: { variable: formulaBase }, to: { literal: '#0000ff' }, t: 0.5 } } });
    const { id: translucent } = await run('variable.create', { collection: formulas, name: 'Translucent', type: 'color', value: { alpha: { variable: formulaBase, opacity: 0.25 } } });
    await run('variable.bind', { ids: [materialized], field: 'fill', variable: mixed });
    assert.match(await svg(materialized), /fill="(?:#800080|purple)"/i);
    await assert.rejects(run('variable.set', { variable: formulaBase, value: { alias: mixed } }), /cycle/);
    const calc = JSON.parse((await run('variable.export', { collections: [formulas] })).text);
    const modeLight = Object.values(calc.meta.variableCollections)[0].defaultModeId;
    assert.equal(calc.meta.variables[translucent].valuesByMode[modeLight].a, 64 / 255);
    const { id: extension } = await run('variable.extendCollection', { collection: formulas, name: 'Extended formulas' });
    const derived = (await run('variable.list')).variables.find(row => row.collection === extension && row.name === 'Formula base');
    await run('variable.set', { variable: derived.id, value: '#222233' });
    await run('variable.bind', { ids: [materialized], field: 'fill', variable: derived.id });
    assert.match(await svg(materialized), /#(?:222233|223)/i);
    await run('variable.set', { variable: formulaBase, value: '#116699' });
    assert.match(await svg(materialized), /#(?:222233|223)/i);
    await run('variable.resetOverride', { variable: derived.id });
    assert.match(await svg(materialized), /#(?:116699|169)/i);
    await run('variable.addMode', { collection: formulas, name: 'Other' });
    assert.equal((await run('variable.list')).collections.find(row => row.id === extension).modes.length, 3);
    const { id: stackedPaint } = await create('rectangle', 'Paint stack binding', 450, 10);
    await run('fill.add', { ids: [stackedPaint], color: '#224466' });
    await run('variable.bind', { ids: [stackedPaint], field: 'fills/1/color', variable: formulaBase });
    assert.match(await svg(stackedPaint), /#(?:116699|169)/i);
    await run('variable.bind', { ids: [stackedPaint], field: 'fills/1/color', variable: null });
    await run('variable.set', { variable: formulaBase, value: '#335577' });
    assert.match(await svg(stackedPaint), /#(?:116699|169)/i);
    const { id: textBound } = await call(fig, 'create_node', { type: 'text', name: 'Bound text', text: 'Initial', x: 450, y: 55, width: 200, height: 32 });
    const { id: words } = await run('variable.create', { collection: formulas, name: 'Bound words', type: 'string', value: 'Final bound text' });
    await run('variable.bind', { ids: [textBound], field: 'characters', variable: words });
    assert.match(await svg(textBound), /Final bound text/);
    await run('variable.delete', { variable: words });
    assert.match(await svg(textBound), /Final bound text/);

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
    await run('file.new', { name: 'Source kit' });
    const { id: libCollection } = await run('variable.createCollection', { name: 'Kit palette', modes: ['Day', 'Night'] });
    const { id: libWidth } = await run('variable.create', {
      collection: libCollection, name: 'Kit width', type: 'number', values: { Day: 56, Night: 72 },
    });
    const { id: libStyle } = await run('style.create', { type: 'paint', name: 'Kit paint', value: '#155066' });
    const { id: baseLayer } = await create('rectangle', 'Published badge', 10, 20);
    await run('style.apply', { style: libStyle, ids: [baseLayer] });
    const { id: badge } = await run('component.create', { ids: [baseLayer] });
    const publication = await run('library.publish', { description: 'Portable native kit' });
    assert.equal(publication.version, 1);
    const publicationFile = join(profile, 'kit.figcraft');
    await run('file.saveAs', { path: publicationFile });
    const { id: destination } = await run('file.new', { name: 'Consumer' });
    const linked = await run('library.add', { path: publicationFile });
    assert.equal(linked.id, publication.id);
    assert.ok(linked.components.some(row => row.name === 'Published badge'));
    const { component: linkedComponent } = await run('library.import', { library: linked.id, component: 'Published badge' });
    assert.equal((await get(linkedComponent)).type, 'COMPONENT');
    await assert.rejects(run('node.set', { ids: [linkedComponent], props: { width: 99 } }), /read-only/);
    const { id: badgeInstance } = await run('library.place', { library: linked.id, component: 'Published badge', x: 100, y: 120 });
    assert.match(await svg(badgeInstance), /#155066/i);
    const { id: target } = await create('rectangle', 'Consumer rectangle', 160, 10);
    await run('library.applyStyle', { library: linked.id, style: 'Kit paint', ids: [target] });
    await run('library.bindVariable', { library: linked.id, variable: 'Kit width', field: 'width', ids: [target] });
    assert.match(await svg(target), /width="56"/);
    assert.match(await svg(target), /#155066/i);
    await run('library.setVariableMode', { library: linked.id, collection: 'Kit palette', mode: 'Night' });
    assert.match(await svg(target), /width="72"/);
    const linkedVariable = await run('library.importVariable', { library: linked.id, variable: 'Kit width' });
    await assert.rejects(run('variable.set', { variable: linkedVariable.variable, value: 99 }), /read-only/);
    const { id: localCollection } = await run('variable.createCollection', { name: 'Local sizing' });
    const { id: localVariable } = await run('variable.create', { collection: localCollection, name: 'Alias width', type: 'number', value: 1 });
    await run('library.aliasVariable', { library: linked.id, alias: 'Kit width', variable: localVariable });
    await run('variable.bind', { variable: localVariable, field: 'width', ids: [target] });
    assert.match(await svg(target), /width="72"/);
    const { id: libExtension } = await run('library.extendCollection', { library: linked.id, collection: 'Kit palette' });
    const extensionWidth = (await run('variable.list')).variables.find(row => row.collection === libExtension);
    const { id: extensionLayer } = await create('rectangle', 'Extended width', 160, 80);
    await run('select.none');
    await run('variable.setMode', { collection: libExtension, mode: 'Night' });
    await run('variable.bind', { ids: [extensionLayer], field: 'width', variable: extensionWidth.id });
    assert.match(await svg(extensionLayer), /width="72"/);

    await run('doc.previousTab');
    await run('style.update', { style: libStyle, value: '#862255' });
    await run('variable.set', { variable: libWidth, mode: 'Night', value: 94 });
    assert.equal((await run('library.publish')).version, 2);
    await run('file.save');
    await run('doc.nextTab');
    assert.equal((await call(fig, 'inspect_document')).id, destination);
    const pending = await run('library.updates');
    assert.ok(pending.count >= 2);
    const accepted = await run('library.acceptUpdates', { ids: [linked.id] });
    assert.equal(accepted.styles, 1);
    assert.equal(accepted.variables, 1);
    assert.match(await svg(target), /width="94"/);
    assert.match(await svg(extensionLayer), /width="94"/);
    assert.match(await svg(target), /#862255/i);
    assert.match(await svg(badgeInstance), /#862255/i);

    const { id: secondBadgeInstance } = await run('library.place', { library: linked.id, component: 'Published badge', x: 250, y: 120 });
    const usage = await run('library.usage', { library: linked.id, days: 14 });
    assert.equal(usage.scope, 'local');
    assert.equal(usage.instances, 2);
    assert.equal(usage.days, 14);
    assert.equal(usage.actionsKnown, false);
    assert.ok(usage.files.some(row => row.name === 'Consumer' && row.instances === 2));
    assert.equal((await run('library.usage', { library: linked.id, days: 0 })).days, 1);
    await run('file.new', { name: 'Replacement kit' });
    const { id: newPalette } = await run('variable.createCollection', { name: 'Kit palette', modes: ['Day', 'Night'] });
    await run('variable.create', { collection: newPalette, name: 'Kit width', type: 'number', values: { Day: 65, Night: 105 } });
    const { id: replacementStyle } = await run('style.create', { type: 'paint', name: 'Kit paint', value: '#3b44aa' });
    const { id: replacementBadge } = await create('rectangle', 'Published badge', 10, 20);
    await run('style.apply', { style: replacementStyle, ids: [replacementBadge] });
    await run('component.create', { ids: [replacementBadge] });
    const replacementLibrary = await run('library.publish');
    const replacementPath = join(profile, 'replacement.figcraft');
    await run('file.saveAs', { path: replacementPath });
    await run('doc.previousTab');
    assert.equal((await call(fig, 'inspect_document')).id, destination);
    await run('library.add', { path: replacementPath });
    const at = await run('library.swapAt', { library: replacementLibrary.id, component: 'Published badge', x: 105, y: 125 });
    assert.equal(at.id, badgeInstance);
    assert.match(await svg(badgeInstance), /#3b44aa/i);
    const swapped = await run('library.swap', { from: linked.id, to: replacementLibrary.id });
    assert.equal(swapped.components, 1);
    assert.equal(swapped.styles, 1);
    assert.equal(swapped.variables, 1);
    assert.equal(swapped.removed, true);
    assert.match(await svg(secondBadgeInstance), /#3b44aa/i);
    assert.match(await svg(target), /width="105"/);
    assert.match(await svg(extensionLayer), /width="105"/);
    assert.match(await svg(target), /#3b44aa/i);

    await run('page.add', { name: 'Selected catalog page' });
    await run('page.select', { index: 1 });
    await create('rectangle', 'Second page marker', 12, 18);
    const archived = await run('file.saveAs', { data: true });
    assert.equal(archived.nativeCatalog, true);
    await run('file.open', { data: archived.data, name: 'Reopened kit consumer.figcraft' });
    assert.ok((await call(fig, 'inspect_document')).layers.some(layer => layer.name === 'Second page marker'));
    await run('page.select', { index: 0 });
    const reopened = (await call(fig, 'inspect_document')).layers.find(layer => layer.name === 'Consumer rectangle');
    assert.match(await svg(reopened.id), /width="105"/);
    assert.match(await svg(reopened.id), /#3b44aa/i);

    await run('file.new', { name: 'Native instance placement' });
    const { id: sourceA } = await create('rectangle', 'Source A', 0, 0);
    const { id: sourceB } = await create('rectangle', 'Source B', 75, 0);
    await run('node.set', { ids: [sourceB], props: { fill: '#2244cc' } });
    const { id: componentA } = await run('component.create', { ids: [sourceA] });
    const { id: componentB } = await run('component.create', { ids: [sourceB] });
    const { id: placeFrame } = await call(fig, 'create_node', { type: 'frame', name: 'Placement frame', x: 200, y: 100, width: 300, height: 200 });
    const { id: placedAt } = await run('instance.place', { component: componentA, x: 300, y: 175 });
    const placedLayer = (await get(placeFrame)).children.find(layer => layer.id === placedAt);
    assert.ok(placedLayer);
    assert.equal(placedLayer.x, 75);
    assert.equal(placedLayer.y, 57.5);
    assert.match(await svg(placedAt), /fill="(?:#ff0000|#f00|red)"/i);
    assert.equal((await run('instance.swapAt', { component: componentB, x: 300, y: 175 })).id, placedAt);
    assert.match(await svg(placedAt), /#(?:2244cc|24c)/i);
    await call(fig, 'undo');
    assert.match(await svg(placedAt), /fill="(?:#ff0000|#f00|red)"/i);
    const { id: autoFrame } = await call(fig, 'create_node', { type: 'frame', name: 'Auto placement frame', x: 600, y: 100, width: 300, height: 200 });
    const { id: autoFirst } = await create('rectangle', 'First flow child', 10, 10, autoFrame);
    const { id: autoSecond } = await create('rectangle', 'Second flow child', 70, 10, autoFrame);
    await run('layout.add', { ids: [autoFrame], direction: 'horizontal' });
    const autoBounds = await get(autoFrame);
    const { id: flowPlaced } = await run('instance.place', { component: componentA, x: autoBounds.x + 2, y: autoBounds.y + 2 });
    assert.deepEqual((await get(autoFrame)).children.map(layer => layer.id), [flowPlaced, autoFirst, autoSecond]);
  } finally {
    await fig.close();
    await omc.close();
    service.kill();
    await exited;
    await rm(profile, { recursive: true, force: true });
  }
});
