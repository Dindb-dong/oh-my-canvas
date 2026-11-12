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
    await assert.rejects(run('edit.repeat'),/nothing to repeat/);
    const create = (type, name, x, y, width = 40, height = 20) =>
      call('create_node', { type, name, x, y, width, height, props: { fill: '#336699' } });
    const original=(await call('inspect_document')).id;
    const extra=await run('file.new',{name:'Second native tab'});
    await run('file.markSaved');
    const continued=await run('command.batch',{onError:'continue',commands:[
      {command:'node.create',as:'frame',params:{type:'frame',name:'Atomic parent'}},
      {command:'node.set',as:'bad',params:{ids:[900000],props:{name:'Wrong ID'}}},
      {command:'node.create',params:{type:'text',parent:{$ref:'bad'},text:'Skipped'}},
      {command:'node.create',params:{type:'text',parent:{$ref:'frame'},text:'Kept'}},
    ]});
    assert.deepEqual(continued.map(step=>step.ok),[true,false,false,true]);
    assert.equal((await get(continued[0].result.id)).children[0].characters,'Kept');
    const latest=await run('collab.diff');
    assert.ok(latest.count>1);
    assert.equal(latest.count,latest.changes.length);
    assert.ok(latest.bytes>0);
    assert.deepEqual(await run('collab.diff',{against:'saved'}),latest);
    await run('file.markSaved');
    assert.equal((await run('collab.diff',{against:'saved'})).count,0);
    await call('undo');
    assert.equal((await call('inspect_document')).layers.length,0);
    assert.deepEqual((await run('doc.list')).map(tab=>tab.id),[original,extra.id]);
    assert.equal((await run('doc.previousTab')).id,original);
    assert.equal((await run('doc.nextTab')).id,extra.id);
    await run('file.moveTab',{from:1,to:0});
    assert.equal((await run('doc.switch',{index:1})).id,original);
    await assert.rejects(run('file.close',{index:0}),/unsaved changes/);
    await run('file.close',{index:0,force:true});
    assert.deepEqual((await run('doc.list')).map(tab=>tab.id),[original]);
    assert.equal((await call('inspect_document')).id,original);
    const { id: first } = await run('node.create', {
      type: 'rectangle', name: 'First', x: 20, y: 25, width: 40, height: 20,
      props: { fill: '#336699' },
    });
    assert.equal((await get(first)).name, 'First');
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
    const matching=await create('text','Typography',370,55);
    await run('node.set',{ids:[matching.id],props:{characters:'한글 한글',fontSize:19,fontStyle:'Bold Italic'}});
    const otherFont=await create('text','Other',450,55);
    await run('node.set',{ids:[otherFont.id],props:{characters:'Other',fontFamily:'serif'}});
    await run('select.set',{ids:[label.id]});
    assert.deepEqual((await run('select.matching')).selection,[label.id,matching.id]);
    assert.deepEqual((await run('select.sameFont')).selection,[label.id,matching.id]);
    assert.deepEqual((await run('select.sameText')).selection,[label.id]);
    assert.deepEqual((await run('edit.findReplace',{find:'한글',replace:'한국어'})).matches,[label.id,matching.id]);
    assert.equal((await get(matching.id)).characters,'한국어 한국어');
    assert.equal((await get(label.id)).fontWeight,700);
    await call('undo');
    assert.equal((await get(matching.id)).characters,'한글 한글');
    await run('select.set',{ids:[label.id]});
    await run('object.hideOthers');
    assert.equal((await get(otherFont.id)).visible,false);
    await call('undo');
    assert.notEqual((await get(otherFont.id)).visible,false);
    await run('select.set',{ids:[second]});
    assert.ok((await run('select.sameFill')).selection.includes(first));
    assert.ok((await run('select.sameProperties')).selection.includes(first));
    await run('node.set',{ids:[first,second],props:{stroke:'#112233',strokeWeight:2}});
    await run('select.set',{ids:[second]});
    assert.deepEqual(new Set((await run('select.sameStroke')).selection),new Set([first,second]));
    const source=await create('rectangle','Clipboard source',400,100,20,30);
    await run('node.set',{ids:[source.id],props:{opacity:0.35}});
    await run('edit.copyProperties',{id:source.id});
    await run('edit.pasteProperties',{ids:[otherFont.id]});
    assert.equal((await get(otherFont.id)).opacity,0.35);
    assert.equal((await get(otherFont.id)).name,'Other');
    await run('edit.copy',{ids:[source.id]});
    const pasted=(await run('edit.paste',{x:450,y:160})).ids[0];
    assert.equal((await get(pasted)).x,450);
    assert.equal((await get(pasted)).y,160);
    const duplicated=await run('edit.duplicate',{ids:[pasted],dx:15,dy:25,map:true});
    assert.equal(duplicated.map[pasted],duplicated.ids[0]);
    assert.equal((await get(duplicated.ids[0])).x,465);
    assert.equal((await get((await run('edit.duplicate')).ids[0])).x,480);
    await run('select.set',{ids:[pasted]});
    const over=(await run('edit.pasteOver')).ids[0];
    assert.equal((await get(over)).x,450);
    const replaced=(await run('edit.pasteReplace',{ids:[over]})).ids[0];
    await assert.rejects(get(over),/layer not found/);
    assert.equal((await get(replaced)).x,450);
    await run('edit.cut',{ids:[replaced]});
    await assert.rejects(get(replaced),/layer not found/);
    assert.equal((await get((await run('edit.paste')).ids[0])).x,450);
    // Synthetic Kiwi paint fixture from omc-import/tests/fig_paints.rs.
    const designCopy=[
      'ZmlnLWtpd2lqAAAAYAEAAHWR3U7jMBCFz7hp2C4IoRUvwV27b+BtQhWRpqh/tyuTmq5FYke2QYWnX02K',
      'Im64sv3pzMyZ46vKHfT2vdOAmMtqLzcAaJ3Pt7JalDkA8aiMjWfJeLMqiwwAFmuZFXm1/VsWVS7XXDQg',
      'PmXJpQOS1WJX9rLRwLJCLlcVd0sKG7XvXKOicXbuGuc3narZU5bfy1255ZGrh1L+6Qftigwkgg7BOFtk',
      'uAA1rlZNfxWPymsbC3vQJ5A4vpoDUlDnguHuuITY6zo6DxInTEDvmEAsVfTmBErb6ZRhO50xbqe/McGo',
      'nTFM2hnDcTtjmPY+QYln/ZHVT6xVrDzvEF0HEnWvu/5iYfIZKkQaOVcBcp2qTWQrozcTzFOjQUhCdF3A',
      'DaXRKxuenW9xhQvzTVoJ7vg35/+UPWqIdFj9SyA/IPqRwCiYD42fSJ5N0/R2An7ROETvXvTwTpc6BMXt',
      'yA69A26J/gNIAAAAnY87DoAwDEP9klDOyT1QwwJzj8yvAyu1ZA+WnixjgCMwg0VucUhtvzwFeJW2Yqlb',
      '9Unlx3P2fqU3EjZEvVuhv1yMcYWxd9IJ',
    ].join('');
    const imported=await run('edit.pasteDesignLayers',{html:`<span data-buffer="<!--(figma)${designCopy.slice(0,8)}
${designCopy.slice(8).replace(/=+$/,'')}(/figma)-->"></span>`,x:240,y:300});
    assert.deepEqual(imported.missingImages,[]);
    assert.equal(imported.ids.length,1);
    assert.equal((await get(imported.ids[0])).x,240);
    assert.equal((await get(imported.ids[0])).y,300);
    await run('edit.undo');
    await assert.rejects(get(imported.ids[0]),/layer not found/);
    assert.equal((await run('edit.paste')).ids.length,1);
    await assert.rejects(run('edit.pasteDesignLayers',{html:'<p>Plain text</p>'}),/no copied design layers/);
    assert.equal((await run('edit.pasteDesignLayers',{data:designCopy})).ids.length,1);
    const repeatBase=await run('shape.rectangle',{x:260,y:320,width:25,height:30});
    await assert.rejects(run('node.set',{ids:[987654],props:{width:75}}),/unknown FigCraft layer ID/);
    await call('inspect_document');
    const repeated=await run('edit.repeat');
    assert.notEqual(repeated.id,repeatBase.id);
    assert.equal((await get(repeated.id)).width,25);
    await run('edit.undo');
    await assert.rejects(get(repeated.id),/layer not found/);
    assert.equal((await get(repeatBase.id)).width,25);

    // FigCraft ABI fixtures create two layers, then one per callback. The trapping copy must roll back.
    const wasmPlugin=[
      'AGFzbQEAAAABHQVgBH9/f38Bf2AAAX9gAn9/AX9gAn9/AGABfwF/AmUFCGZpZ2NyYWZ0BGNhbGwAAAhm',
      'aWdjcmFmdAlyZXBseV9sZW4AAQhmaWdjcmFmdApyZXBseV9yZWFkAAIIZmlnY3JhZnQKc2V0X291dHB1',
      'dAADCGZpZ2NyYWZ0B3VpX3Nob3cAAgMCAQQFAwEAAQYGAX8BQQALBxkCBm1lbW9yeQIADGZpZ2NyYWZ0',
      'X3J1bgAFCkwBSgBBAEEPQcAAQdwAEAAEQEEBDwsjAEUEQEEAQQ9BwABB3AAQAARAQQEPC0GAAkHQABAE',
      'GgsjAEEBaiQAQYAIQYAIEAEQAhADQQALC80BAwBBAAsPc2hhcGUucmVjdGFuZ2xlAEHAAAtceyJ4Ijox',
      'MiwieSI6MTgsIndpZHRoIjozNSwiaGVpZ2h0IjoyMiwibmFtZSI6Ildhc20gZWRpdGVkIGxheWVyIiwi',
      'cHJvcHMiOnsiZmlsbCI6IiM3QzNBRUQifX0AQYACC1B7InRpdGxlIjoiV2FzbSBwYW5lbCIsImNvbnRy',
      'b2xzIjpbeyJuYW1lIjoiYWRkIiwibGFiZWwiOiJBZGQiLCJ0eXBlIjoiYnV0dG9uIn1dfQA9BG5hbWUB',
      'LAUABGNhbGwBCXJlcGx5X2xlbgIKcmVwbHlfcmVhZAMGb3V0cHV0BARzaG93BwgBAAVjb3VudA==',
    ].join('');
    const wasmTrap=[
      'AGFzbQEAAAABHQVgBH9/f38Bf2AAAX9gAn9/AX9gAn9/AGABfwF/AmUFCGZpZ2NyYWZ0BGNhbGwAAAhm',
      'aWdjcmFmdAlyZXBseV9sZW4AAQhmaWdjcmFmdApyZXBseV9yZWFkAAIIZmlnY3JhZnQKc2V0X291dHB1',
      'dAADCGZpZ2NyYWZ0B3VpX3Nob3cAAgMCAQQFAwEAAQYGAX8BQQALBxkCBm1lbW9yeQIADGZpZ2NyYWZ0',
      'X3J1bgAFCk0BSwBBAEEPQcAAQdwAEAAEQEEBDwsjAEUEQEEAQQ9BwABB3AAQAARAQQEPC0GAAkHQABAE',
      'GgsjAEEBaiQAQYAIQYAIEAEQAhADAEEACwvNAQMAQQALD3NoYXBlLnJlY3RhbmdsZQBBwAALXHsieCI6',
      'MTIsInkiOjE4LCJ3aWR0aCI6MzUsImhlaWdodCI6MjIsIm5hbWUiOiJXYXNtIGVkaXRlZCBsYXllciIs',
      'InByb3BzIjp7ImZpbGwiOiIjN0MzQUVEIn19AEGAAgtQeyJ0aXRsZSI6Ildhc20gcGFuZWwiLCJjb250',
      'cm9scyI6W3sibmFtZSI6ImFkZCIsImxhYmVsIjoiQWRkIiwidHlwZSI6ImJ1dHRvbiJ9XX0APQRuYW1l',
      'ASwFAARjYWxsAQlyZXBseV9sZW4CCnJlcGx5X3JlYWQDBm91dHB1dAQEc2hvdwcIAQAFY291bnQ=',
    ].join('');
    const pluginId='org.omc.test.layout';
    const manifest={id:pluginId,name:'Test layout',main:'layout.wasm',api:2,
      permissions:{access:'write',commands:['shape.rectangle']}};
    const countLayers=async ()=>(await call('inspect_document')).layers.filter(layer=>layer.name==='Wasm edited layer').length;
    await run('plugin.import',{manifest,wasm:wasmPlugin});
    assert.equal((await run('plugin.list')).plugins[0].id,pluginId);
    const plugin=await run('plugin.run',{id:pluginId});
    assert.equal(plugin.panel.title,'Wasm panel');
    assert.equal((await get(plugin.output.id)).fill,'#7C3AED');
    assert.equal(await countLayers(),2);
    assert.equal((await run('plugin.ui')).controls[0].name,'add');
    await run('plugin.event',{id:pluginId,control:'add'});
    assert.equal(await countLayers(),3);
    await run('edit.undo');
    assert.equal(await countLayers(),2);
    await run('edit.undo');
    assert.equal(await countLayers(),0);
    assert.equal((await run('plugin.close',{id:pluginId})).closed,true);
    assert.equal(await run('plugin.ui'),null);
    await run('plugins.runLast');
    assert.equal(await countLayers(),2);
    await run('edit.undo');
    await run('plugin.import',{manifest,wasm:wasmTrap});
    await assert.rejects(run('plugin.run',{id:pluginId}),/crashed/);
    assert.equal(await countLayers(),0);
    await run('plugin.import',{manifest:{...manifest,permissions:{access:'read'}},wasm:wasmPlugin});
    await assert.rejects(run('plugin.run',{id:pluginId}));
    assert.equal(await countLayers(),0);
    assert.equal((await run('plugin.remove',{id:pluginId})).removed,true);
    assert.deepEqual((await run('plugin.list')).plugins,[]);
    // A Wasm widget returns different paints on insertion and callbacks, with a hover style.
    const widgetWasm=[
      'AGFzbQEAAAABDAJgAn9/AX9gAX8BfwIwAghmaWdjcmFmdApyZXBseV9yZWFkAAAIZmlnY3JhZnQNd2lk',
      'Z2V0X3JlbmRlcgAAAwMCAQEFAwEAAQcZAgZtZW1vcnkCAAxmaWdjcmFmdF9ydW4AAwp6AlYBAn8DQCAB',
      'QQxqIABLBEBBAA8LQQAhAgJAA0BBgCAgASACamotAABBgBAgAmotAABHDQEgAkEBaiECIAJBDEYEQEEB',
      'DwsMAAsLIAFBAWohAQwAC0EACyEAQYAgIAAQABogABACBH9BAEGqAxABBUGACEGqAxABCwsL9AYDAEEA',
      'C6oDeyJyb290Ijp7InR5cGUiOiJmcmFtZSIsIm5hbWUiOiJDYW52YXMgd2lkZ2V0Iiwid2lkdGgiOjEz',
      'MiwiaGVpZ2h0Ijo0OCwiZmlsbCI6IiM3QzNBRUQiLCJob3ZlciI6eyJmaWxsIjoiI0ZGMDAwMCJ9LCJj',
      'aGlsZHJlbiI6W3sidHlwZSI6InRleHQiLCJuYW1lIjoiTGFiZWwiLCJmaWVsZCI6ImxhYmVsIiwidGV4',
      'dCI6IlRlc3QiLCJ4IjoxMCwieSI6MTAsIndpZHRoIjo4MCwiaGVpZ2h0IjoyMCwic2l6ZSI6MTQsImNv',
      'bG9yIjoiI0ZGRkZGRiJ9LHsidHlwZSI6InJlY3RhbmdsZSIsIm5hbWUiOiJCdXR0b24iLCJ0YXJnZXQi',
      'OiJjaGFuZ2UiLCJ4Ijo5NCwieSI6MTAsIndpZHRoIjoyOCwiaGVpZ2h0IjoyOCwiZmlsbCI6IiNGRkZG',
      'RkYifV19LCJtZW51IjpbeyJpdGVtIjoiZW5hYmxlZCIsInR5cGUiOiJ0b2dnbGUiLCJsYWJlbCI6IkVu',
      'YWJsZWQifV19AEGACAuqA3sicm9vdCI6eyJ0eXBlIjoiZnJhbWUiLCJuYW1lIjoiQ2FudmFzIHdpZGdl',
      'dCIsIndpZHRoIjoxMzIsImhlaWdodCI6NDgsImZpbGwiOiIjMTE5OTZFIiwiaG92ZXIiOnsiZmlsbCI6',
      'IiNGRjAwMDAifSwiY2hpbGRyZW4iOlt7InR5cGUiOiJ0ZXh0IiwibmFtZSI6IkxhYmVsIiwiZmllbGQi',
      'OiJsYWJlbCIsInRleHQiOiJUZXN0IiwieCI6MTAsInkiOjEwLCJ3aWR0aCI6ODAsImhlaWdodCI6MjAs',
      'InNpemUiOjE0LCJjb2xvciI6IiNGRkZGRkYifSx7InR5cGUiOiJyZWN0YW5nbGUiLCJuYW1lIjoiQnV0',
      'dG9uIiwidGFyZ2V0IjoiY2hhbmdlIiwieCI6OTQsInkiOjEwLCJ3aWR0aCI6MjgsImhlaWdodCI6Mjgs',
      'ImZpbGwiOiIjRkZGRkZGIn1dfSwibWVudSI6W3siaXRlbSI6ImVuYWJsZWQiLCJ0eXBlIjoidG9nZ2xl',
      'IiwibGFiZWwiOiJFbmFibGVkIn1dfQBBgBALDCJldmVudCI6bnVsbABWBG5hbWUBHwMACnJlcGx5X3Jl',
      'YWQBBnJlbmRlcgIIY29udGFpbnMCFQICAwADbGVuAQFpAgFqAwEAA2xlbgMXAQIDAAVvdXRlcgIEbWlz',
      'cwMFaW5uZXI=',
    ].join('');
    const widgetPlugin='org.omc.test.widget';
    await run('plugin.import',{manifest:{id:widgetPlugin,name:'Widget plugin',main:'widget.wasm',api:4,widget:true},wasm:widgetWasm});
    const widget=await run('widget.insert',{plugin:widgetPlugin,x:200,y:360});
    assert.equal(widget.name,'Canvas widget');
    assert.deepEqual(widget.targets,['change']);
    assert.deepEqual(widget.fields,['label']);
    const widgetPng=async()=> (await client.callTool({name:'screenshot',arguments:{ids:[widget.id],maxSize:200}})).content.find(item=>item.type==='image')?.data;
    const initialWidget=await widgetPng();
    assert.ok(initialWidget);
    assert.deepEqual((await run('widget.hover',{ids:[widget.id]})).hovering,[widget.id]);
    assert.notEqual(await widgetPng(),initialWidget);
    await run('widget.hover');
    assert.equal(await widgetPng(),initialWidget);
    const button=(await get(widget.id)).children.find(child=>child.name==='Button');
    await run('widget.click',{id:button.id,target:'change'});
    assert.equal((await get(widget.id)).fill,'#11996E');
    await run('edit.undo');
    assert.equal(await widgetPng(),initialWidget);
    const updatedWidget=await run('widget.setText',{id:widget.id,field:'label',value:'한글'});
    assert.equal(updatedWidget.state.label,'한글');
    assert.equal((await run('widget.menu',{id:widget.id,item:'enabled'})).state.label,'한글');
    assert.ok((await run('widget.list')).widgets.some(entry=>entry.id===widget.id&&entry.menu[0].item==='enabled'));
    await run('plugin.remove',{id:widgetPlugin});
    assert.equal((await get(widget.id)).name,'Canvas widget');
    await assert.rejects(run('widget.click',{id:widget.id,target:'change'}),/plugin is not installed/);
    const measureFrame=await run('frame.create',{x:40,y:360,width:180,height:80});
    const measureA=await run('shape.rectangle',{x:15,y:20,width:30,height:20,parent:measureFrame.id,props:{fill:'#FF0000'}});
    const measureB=await run('shape.rectangle',{x:55,y:20,width:30,height:20,parent:measureFrame.id});
    const distances=await run('measure.distances',{ids:[measureA.id],to:measureB.id});
    assert.deepEqual(distances.lines.map(line=>line.label),['10']);
    assert.ok((await run('measure.distances',{ids:[measureA.id]})).lines.some(line=>line.label==='15'));
    const tracked=await run('devMode.addMeasurement',{from:measureA.id,to:measureB.id});
    assert.equal(tracked.lines[0].label,'10');
    assert.equal((await run('devMode.addMeasurement',{from:measureA.id,side:'top'})).lines[0].label,'30');
    await run('node.set',{ids:[measureB.id],props:{x:65}});
    const measurements=await run('devMode.measurements',{id:measureB.id,page:0});
    assert.deepEqual(measurements.map(({from,to,labels})=>({from,to,labels})),[{from:measureA.id,to:measureB.id,labels:['20']}]);
    assert.equal((await run('devMode.removeMeasurement',{from:measureA.id,index:tracked.index})).removed,1);
    assert.equal((await run('devMode.measurements',{id:measureB.id})).length,0);
    await run('edit.undo');
    assert.equal((await run('devMode.measurements',{id:measureB.id}))[0].labels[0],'20');
    await run('node.set',{ids:[measureB.id],props:{x:55}});
    await run('layout.add',{ids:[measureFrame.id],direction:'horizontal'});
    const padding=await run('measure.padding',{id:measureA.id});
    assert.equal(padding.frame,measureFrame.id);
    assert.ok(padding.lines.some(line=>line.label==='10'));
    const sections=(await run('inspect.properties',{id:measureA.id,colorFormat:'hsl'})).sections;
    assert.ok(sections.find(section=>section.title==='Layout').rows.some(row=>row.value==='30px'));
    assert.equal(sections.find(section=>section.title==='Fills').rows[0].value,'hsl(0, 100%, 50%)');
    const exportedIcon=await run('shape.star',{x:50,y:480,width:40,height:40});
    const inspected=(await run('inspect.assets',{ids:[exportedIcon.id,measureA.id]})).assets;
    assert.deepEqual(inspected.map(({id,kind,exports})=>({id,kind,exports})),[
      {id:exportedIcon.id,kind:'icon',exports:['SVG 1x']},
    ]);
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
