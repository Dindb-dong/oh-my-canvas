import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, connect } from 'node:net';
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
const { WebSocketServer } = await import(sdk
  ? pathToFileURL(join(sdk, '../../ws/wrapper.mjs'))
  : 'ws');
const executable = process.platform === 'win32' ? 'omc-service.exe' : 'omc-service';
const binary = process.env.OMC_SERVICE_BINARY
  ?? fileURLToPath(new URL('../target/debug/' + executable, import.meta.url));

async function descriptor(profile, service) {
  for (let attempt = 0; attempt < 200 && service.exitCode === null; attempt++) {
    try {
      return JSON.parse(await readFile(join(profile, 'native-v1/service.json'), 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await delay(25);
  }
  throw new Error('Native service failed to start');
}

async function withClient(work, existingProfile) {
  const profile = existingProfile ?? await mkdtemp(join(tmpdir(), 'omc-server-info-'));
  if (existingProfile) await rm(join(profile, 'native-v1/service.json'), { force: true });
  const service = spawn(binary, ['--profile', profile, '--port', '0'], { stdio: 'inherit' });
  const exited = once(service, 'exit');
  const client = new Client({ name: 'figcraft-server-contract', version: '1.0.0' });
  try {
    const { endpoint, token } = await descriptor(profile, service);
    await client.connect(new StreamableHTTPClientTransport(new URL(endpoint + '/mcp/figcraft'), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }));
    const call = async (name, args = {}) => {
      const result = await client.callTool({ name, arguments: args });
      const output = result.structuredContent
        ?? JSON.parse(result.content.find(item => item.type === 'text').text);
      if (result.isError) throw Object.assign(new Error(output.message), output);
      return output;
    };
    const run = (command, params = {}) => call('run_command', { command, params });
    await work((server) => run('collab.serverInfo', { server }), run, call, profile);
  } finally {
    await client.close().catch(() => {});
    if (service.exitCode === null) service.kill();
    await exited;
    if (!existingProfile) await rm(profile, { recursive: true, force: true });
  }
}

function unsignedVarint(value) {
  const bytes = [];
  let n = value;
  while (n >= 128) {
    bytes.push((n % 128) + 128);
    n = Math.floor(n / 128);
  }
  bytes.push(n);
  return Buffer.from(bytes);
}

function postcardString(text) {
  const bytes = Buffer.from(text);
  return Buffer.concat([unsignedVarint(bytes.length), bytes]);
}

test('Authenticated SDK calls FigCraft v0.17.0 hosting protocol through a pinned wire fixture', async () => {
  const seen = [];
  const fixture = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  fixture.on('connection', (socket, request) => socket.once('message', (message, binary) => {
    seen.push({ path: request.url, binary, message });
    if (request.url === '/refused/') {
      socket.send(Buffer.concat([Buffer.from([1, 6]), postcardString('fixture refused this request')]));
    } else if (request.url === '/oversized/') {
      socket.send(Buffer.alloc(65537));
    } else {
      socket.ping('keepalive');
      socket.send(Buffer.from([1, 7]));
      socket.send(Buffer.concat([
        Buffer.from([1, 12, 0]), // wire version, Hosting variant, open=false
        postcardString('figcraft-test@example.invalid'),
        postcardString('https://example.invalid/terms'),
        Buffer.from([0, 64, 1]), // idle seconds, max file MB, Some(expires)
        unsignedVarint(1740000000),
      ]));
    }
  }));
  await once(fixture, 'listening');
  const local = `ws://127.0.0.1:${fixture.address().port}`;
  try {
    await withClient(async info => {
      assert.deepEqual(await info(local + '/proxy-prefix'), {
        open: false, operator: 'figcraft-test@example.invalid', terms: 'https://example.invalid/terms',
        idleDays: null, maxFileMb: 64, expires: 1740000000,
      });
      assert.equal(seen[0].path, '/proxy-prefix/');
      assert.equal(seen[0].binary, true);
      const message = seen[0].message;
      assert.deepEqual([...message.subarray(0, 3)], [1, 12, 2]); // wire, OpenHosting, protocol
      const versionEnd = 4 + message[3];
      assert.match(message.toString('ascii', 4, versionEnd), /^\d+\.\d+\.\d+/);
      assert.deepEqual([...message.subarray(versionEnd)], [0, 0]); // no file or owner token
      await assert.rejects(info(local + '/refused'), /fixture refused/);
      await assert.rejects(info(local + '/oversized'), error => error.code === 'resource_limit');
      await assert.rejects(info(local.replace('ws:', 'http:')), error => error.code === 'invalid_argument');
      await assert.rejects(info(local + '/?token=discarded'), error => error.code === 'invalid_argument');
      assert.equal(seen.length, 3);
    });
  } finally {
    for (const client of fixture.clients) client.terminate();
    await new Promise((resolve, reject) => fixture.close(error => error ? reject(error) : resolve()));
  }
});

const official = process.env.OMC_TEST_FIGCRAFT_SERVER;
test('Authenticated SDK reads an official local FigCraft v0.17.0 server', {
  skip: !official && 'set OMC_TEST_FIGCRAFT_SERVER to the isolated release binary endpoint',
}, async () => {
  assert.match(official, /^ws:\/\/127\.0\.0\.1:\d+\/$/);
  await withClient(async info => {
    assert.deepEqual(await info(official), {
      open: true,
      operator: 'figcraft-test@example.invalid',
      terms: 'https://example.invalid/terms',
      idleDays: 2.5,
      maxFileMb: 12,
      expires: null,
    });
  });
});

const keyFile = process.env.OMC_TEST_FIGCRAFT_SERVER_KEY_FILE;
test('Authenticated SDK publishes, browses, installs, runs, updates and removes a plugin on the official local server', {
  skip: !(official && keyFile) && 'set the isolated release binary endpoint and publisher key file',
}, async () => {
  assert.match(official, /^ws:\/\/127\.0\.0\.1:\d+\/$/);
  const directory = await mkdtemp(join(tmpdir(), 'omc-server-plugin-'));
  const plugin = `org.omc.directory.${randomUUID()}`;
  const publisher = official + '?key=' + (await readFile(keyFile, 'utf8')).trim();
  const module = Buffer.from([
    '0061736d01000000', '01060160017f017f', '03020100', '0503010001',
    '071902066d656d6f727902000c66696763726166745f72756e0000', '0a0601040041000b',
  ].join(''), 'hex');
  const manifest = version => ({
    id: plugin, name: 'Directory contract fixture', main: 'plugin.wasm', api: 1, version,
    permissions: { access: 'read' },
  });
  const writeManifest = version =>
    writeFile(join(directory, 'figcraft-plugin.json'), JSON.stringify(manifest(version)));
  try {
    await writeFile(join(directory, 'plugin.wasm'), module);
    await mkdir(join(directory, 'assets'));
    await writeFile(join(directory, 'assets', 'license.txt'), 'Test fixture');
    await writeManifest('1.0.0');
    await withClient(async (_info, run) => {
      try {
        const first = await run('plugin.directory.publish', { server: publisher, path: directory });
        assert.equal(first.server, official);
        assert.equal(first.published.id, plugin);
        assert.equal(first.published.version, '1.0.0');
        assert.equal(first.published.access, 'read');
        assert.match(first.published.sha256, /^[a-f0-9]{64}$/);
        assert.equal((await run('pref.publishServer', { url: official })).url, official);
        const listed = await run('plugin.directory.list', { query: plugin });
        assert.deepEqual(listed.plugins.map(row => row.id), [plugin]);
        assert.equal(listed.plugins[0].installed, null);
        await assert.rejects(run('plugin.directory.install', { id: plugin }), /confirm: true/);
        await assert.rejects(run('plugin.directory.install', { id: plugin, confirm: true, sha256: '0'.repeat(64) }), /SHA-256/);
        const installed = await run('plugin.directory.install', {
          id: plugin, confirm: true, version: '1', sha256: first.published.sha256,
        });
        assert.equal(installed.installed, plugin);
        assert.equal(installed.version, '1.0.0');
        assert.equal(installed.source, official);
        assert.equal(installed.replaced, false);
        assert.equal((await run('plugin.list')).plugins[0].version, '1.0.0');
        await run('file.new', { name: 'Directory plugin run fixture' });
        const result = await run('plugin.run', { id: plugin });
        assert.equal(result.plugin, plugin);

        await writeManifest('2.0.0');
        const second = await run('plugin.directory.publish', { server: publisher, path: directory });
        assert.equal(second.published.version, '2.0.0');
        const update = (await run('plugin.directory.list', { query: plugin })).plugins[0];
        assert.deepEqual(update.versions, ['2.0.0', '1.0.0']);
        assert.equal(update.installed, '1.0.0');
        assert.equal(update.update, true);
        const updated = await run('plugin.directory.install', { id: plugin, confirm: true });
        assert.equal(updated.replaced, true);
        assert.equal(updated.version, '2.0.0');
        await assert.rejects(run('plugin.directory.unpublish', { server: official + '?key=invalid', id: plugin }));
        const removed = await run('plugin.directory.unpublish', { server: publisher, id: plugin, version: '2.0.0' });
        assert.deepEqual(removed, { id: plugin, removed: ['2.0.0'] });
        const republished = await run('plugin.directory.publish', { server: publisher, plugin });
        assert.equal(republished.published.sha256, second.published.sha256);
        const all = await run('plugin.directory.unpublish', { server: publisher, id: plugin });
        assert.deepEqual(all.removed.sort(), ['1.0.0', '2.0.0']);
        assert.deepEqual((await run('plugin.directory.list', { query: plugin })).plugins, []);
      } finally {
        await run('plugin.directory.unpublish', { server: publisher, id: plugin }).catch(() => {});
      }
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('The credential-free online server preference persists and supplies a directory default after restart', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'omc-publish-server-pref-'));
  const fixture = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  const requests = [];
  fixture.on('connection', (socket, request) => {
    socket.once('message', (opening, binary) => {
      requests.push({ path: request.url, opening, binary });
      socket.send(Buffer.from([1, 11, 0, 0])); // Plugins: Ready without publisher privileges
      socket.once('message', query => {
        requests.at(-1).query = query;
        socket.send(Buffer.from([1, 11, 1, 0])); // Plugins: empty list
      });
    });
  });
  await once(fixture, 'listening');
  const address = `ws://127.0.0.1:${fixture.address().port}/directory/`;
  const builtIn = 'wss://collab.craftapps.dev/';
  try {
    await withClient(async (_info, run) => {
      assert.deepEqual(await run('pref.publishServer', { url: address.slice(0, -1) }), {
        url: address, default: builtIn,
      });
      await assert.rejects(run('pref.publishServer', { url: address + '?key=invalid' }), /endpoint/);
      const saved = JSON.parse(await readFile(join(profile, 'native-v1/profile-preferences.json'), 'utf8'));
      assert.equal(saved.publishServer, address);
      assert.equal(JSON.stringify(saved).includes('?key='), false);
    }, profile);
    await withClient(async (_info, run) => {
      assert.deepEqual(await run('plugin.directory.list', { query: 'fixture' }), {
        server: address, plugins: [],
      });
      assert.equal(requests.length, 1);
      assert.equal(requests[0].path, '/directory/');
      assert.equal(requests[0].binary, true);
      assert.deepEqual([...requests[0].opening.subarray(0, 4)], [1, 10, 2, 0]);
      assert.deepEqual([...requests[0].query.subarray(0, 3)], [1, 11, 0]);
      assert.equal(requests[0].query.toString('ascii', 4), 'fixture');
      assert.deepEqual(await run('pref.publishServer', { url: '' }), { url: '', default: builtIn });
    }, profile);
    await withClient(async (_info, run) => {
      await assert.rejects(run('plugin.directory.list'), /disabled/);
      assert.equal(requests.length, 1);
      assert.deepEqual(await run('pref.publishServer'), { url: builtIn, default: builtIn });
    }, profile);
  } finally {
    for (const client of fixture.clients) client.terminate();
    await new Promise((resolve, reject) => fixture.close(error => error ? reject(error) : resolve()));
    await rm(profile, { recursive: true, force: true });
  }
});

const nativePlugin = {
  manifest: { id: 'org.omc.plugin-manager', name: 'Manager fixture', version: '1.0', main: 'plugin.wasm', api: 1 },
  wasm: Buffer.from([
    '0061736d01000000', '01060160017f017f', '03020100', '0503010001',
    '071902066d656d6f727902000c66696763726166745f72756e0000', '0a0601040041000b',
  ].join(''), 'hex').toString('base64'),
};

test('plugins.manage returns the real session plugin list without an attached desktop', async () => {
  await withClient(async (_info, run) => {
    await run('plugin.import', nativePlugin);
    const listing = await run('plugins.manage');
    assert.deepEqual(listing, await run('plugin.list'));
    assert.deepEqual(listing.plugins.map(plugin => plugin.id), [nativePlugin.manifest.id]);
  });
});

const desktopEnabled = process.env.OMC_TEST_PLUGIN_MANAGER_BACKGROUND === '1';
test('plugins.manage opens the native hidden editor and its controls run and remove a plugin', {
  skip: !desktopEnabled && 'set OMC_TEST_PLUGIN_MANAGER_BACKGROUND=1 to test a hidden native editor',
}, async () => {
  const executable = process.platform === 'win32' ? 'omc-desktop.exe' : 'omc-desktop';
  const desktopBinary = process.env.OMC_DESKTOP_BINARY
    ?? fileURLToPath(new URL('../target/debug/' + executable, import.meta.url));
  await withClient(async (_info, run, call, profile) => {
    const pluginId = nativePlugin.manifest.id;
    const document = await run('file.new', { name: 'Background plugin manager fixture' });
    await run('plugin.import', nativePlugin);
    const desktop = spawn(desktopBinary, [
      '--profile', profile, '--automation-background', '--smoke-exit-ms', '45000', '--smoke-size', '1280x800',
    ], { stdio: 'inherit' });
    const exited = once(desktop, 'exit');
    const guard = process.env.OMC_TEST_DESKTOP_FOCUS_GUARD;
    const watcher = guard ? spawn('python3', [guard, String(desktop.pid)], { stdio: 'inherit' }) : null;
    const watched = watcher ? once(watcher, 'exit') : null;
    const until = async (predicate, message) => {
      for (let attempt = 0; attempt < 80 && desktop.exitCode === null; attempt++) {
        const ui = await call('inspect_ui');
        if (ui.attached) assert.equal(ui.windows[0].focused, false);
        if (predicate(ui)) return ui;
        await delay(40);
      }
      assert.fail(message);
    };
    try {
      await until(ui => ui.attached && ui.documentId === document.id, 'background desktop did not attach');
      const before = await call('screenshot', { window: true });
      assert.deepEqual(await run('plugins.manage'), await run('plugin.list'));
      let ui = await until(state => state.pluginManager?.plugins.length === 1, 'native manager did not render');
      assert.equal(ui.dialog, 'Plugins');
      assert.equal(ui.pluginManager.plugins[0].id, pluginId);
      const image = await call('screenshot', { window: true });
      const png = Buffer.from(image.base64, 'base64');
      assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
      assert.notEqual(image.base64, before.base64, 'native plugin overlay should change rendered pixels');
      if (process.env.OMC_TEST_PLUGIN_MANAGER_PNG) {
        await writeFile(process.env.OMC_TEST_PLUGIN_MANAGER_PNG, png);
      }

      const activate = async operation => {
        for (let index = 0; index < 10; index++) {
          const button = ui.pluginManager.controls.find(control => control.operation === operation);
          assert.ok(button, 'native plugin action button missing');
          if (ui.pluginManager.focusedControl === button.id) {
            await call('key', { key: 'Enter' });
            return;
          }
          await call('key', { key: 'Tab' });
          ui = await call('inspect_ui');
          assert.equal(ui.windows[0].focused, false);
        }
        assert.fail('manager keyboard focus did not reach the action');
      };
      await activate('run');
      ui = await until(state => state.pluginManager?.message === 'Plugin ran successfully.', 'native run did not finish');
      assert.equal((await run('plugin.list')).last.id, pluginId);
      await activate('remove');
      ui = await until(state => state.pluginManager?.plugins.length === 0, 'native removal did not refresh');
      assert.deepEqual((await run('plugin.list')).plugins, []);
      await call('key', { key: 'Escape' });
      await until(state => state.pluginManager === null, 'native manager did not close');
    } finally {
      if (desktop.exitCode === null) desktop.kill();
      await exited;
      if (watched) {
        const [code] = await watched;
        assert.equal(code, 0, 'OS foreground watcher found a focus violation');
      }
    }
  });
});

async function until(check) {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (await check()) return;
    await delay(120);
  }
  assert.fail('online collaboration did not converge');
}

test('Authenticated SDK edits an online file in both directions and revokes real share links', {
  skip: !official && 'set the isolated release binary endpoint',
}, async () => {
  const profile = await mkdtemp(join(tmpdir(), 'omc-online-owner-'));
  let file;
  try {
    await withClient(async (_info, owner) => {
      await owner('pref.publishServer', { url: official });
      await owner('file.new', { name: '온라인 검증' });
      await owner('shape.rectangle', { x: 10, y: 20, width: 50, height: 70, name: 'Online box' });
      const hosted = await owner('collab.publish', { server: official });
      file = hosted.published.file;
      assert.equal(hosted.status, 'live');
      assert.equal((await owner('collab.files', { refresh: true })).files[0].state, 'online');
      const shared = await owner('collab.share', { via: 'online', access: 'edit' });
      assert.equal(shared.share.shared, true);
      assert.ok(shared.share.viewLink);
      assert.ok(shared.code);
      await withClient(async (_info, guest) => {
        await guest('pref.publishServer', { url: official });
        const joined = await guest('collab.join', { code: shared.code });
        assert.equal(joined.status, 'live');
        assert.equal((await guest('collab.cursor', { x: 14, y: 22 })).cursor.x, 14);
        await guest('collab.cursorChat', { text: '커서 채팅' });
        await guest('collab.spotlight', { on: true });
        await until(async () => (await owner('collab.peers')).peers.some(
          peer => peer.cursor?.x === 14 && peer.chat === '커서 채팅' && peer.spotlighting
        ));
        assert.equal((await owner('collab.follow', { client: joined.me })).follow, joined.me);
        const changed = await guest('text.create', { x: 80, y: 20, text: '게스트 편집', name: 'Guest edit' });
        assert.ok(changed.id);
        await until(async () => {
          for (const client of [guest, owner]) {
            const state = await client('collab.peers');
            assert.equal(state.status, 'live', state.reason);
          }
          return (await owner('select.byName', { query: 'Guest edit' })).selection?.length === 1;
        });
        await owner('text.create', { x: 100, y: 40, text: '호스트 편집', name: 'Owner edit' });
        await until(async () => (await guest('select.byName', { query: 'Owner edit' })).selection?.length === 1);
        const ownerBox = (await owner('select.byName', { query: 'Online box' })).selection[0];
        const guestText = (await guest('select.byName', { query: 'Guest edit' })).selection[0];
        await Promise.all([
          owner('node.set', { ids: [ownerBox], props: { width: 101 } }),
          guest('node.set', { ids: [guestText], props: { characters: '동시 편집' } }),
        ]);
        await until(async () => {
          const [hostState, guestState] = await Promise.all([owner('collab.peers'), guest('collab.peers')]);
          assert.equal(hostState.status, 'live', hostState.reason);
          assert.equal(guestState.status, 'live', guestState.reason);
          const hostText = (await owner('select.byName', { query: 'Guest edit' })).selection[0];
          const guestBox = (await guest('select.byName', { query: 'Online box' })).selection[0];
          return (await owner('node.get', { id: hostText })).characters === '동시 편집'
            && (await guest('node.get', { id: guestBox })).width === 101;
        });
        assert.equal((await guest('collab.report', { reason: 'Local integration fixture' })).sent, true);
        assert.deepEqual(await owner('collab.stop'), { ended: false, shared: false });
        await until(async () => (await guest('collab.peers')).status === 'failed');
        assert.ok((await guest('select.byName', { query: 'Owner edit' })).selection?.length);
      });
      await withClient(async (_info, guest) => {
        const joined = await guest('collab.join', { link: hosted.published.view });
        assert.equal(joined.readOnly, true);
        await assert.rejects(guest('shape.rectangle', { x: 0, y: 0, width: 5, height: 5 }), { code: 'permission_denied' });
        const link = await owner('collab.manageFile', { file, action: 'createLink', access: 'view', label: 'Temporary' });
        assert.ok((await owner('collab.manageFile', { file, action: 'links' })).links.some(item => item.id === link.id));
        await owner('collab.manageFile', { file, action: 'revoke', link: link.id });
        await assert.rejects(guest('collab.join', { link: link.link }));
      });
      const commentShare = await owner('collab.share', { via: 'online', access: 'comment' });
      await withClient(async (_info, guest) => {
        const joined = await guest('collab.join', { link: commentShare.share.commentLink });
        assert.equal(joined.access, 'comment');
        await assert.rejects(guest('shape.rectangle', { x: 0, y: 0, width: 2, height: 2 }), { code: 'permission_denied' });
        await guest('comment.add', { x: 25, y: 37, text: '댓글 전용 검증' });
        await until(async () => {
          for (const [who, client] of [['commenter', guest], ['owner', owner]]) {
            const state = await client('collab.peers');
            assert.equal(state.status, 'live', who + ': ' + state.reason);
          }
          return JSON.stringify(await owner('comment.list')).includes('댓글 전용 검증');
        });
      });
      await owner('collab.stop');
      await owner('collab.manageFile', { file, action: 'rename', name: 'Renamed server file' });
      assert.equal((await owner('collab.files', { refresh: true })).files[0].name, 'Renamed server file');
      await owner('collab.leave');
    }, profile);
    await withClient(async (_info, owner) => {
      const record = (await owner('collab.files')).files.find(item => item.file === file);
      assert.equal(record.hasOwnerToken, true);
      assert.equal(record.owner, undefined);
      assert.equal(record.edit, undefined);
      const reopened = await owner('collab.openFile', { file });
      assert.equal(reopened.alreadyOpen, false);
      assert.equal((await owner('collab.openFile', { file })).alreadyOpen, true);
      assert.ok((await owner('select.byName', { query: 'Guest edit' })).selection?.length);
      await owner('collab.manageFile', { file, action: 'remove' });
      file = undefined;
      assert.equal((await owner('collab.files')).files.length, 0);
      await owner('file.new', { name: 'Forget fixture' });
      const second = (await owner('collab.publish', { server: official })).published;
      await owner('collab.leave');
      try {
        assert.equal((await owner('collab.forgetFile', { file: second.file })).onServer, true);
        assert.equal((await owner('collab.files')).files.length, 0);
        await withClient(async (_info, guest) => {
          assert.equal((await guest('collab.join', { link: second.view })).status, 'live');
        });
      } finally {
        await owner('collab.manageFile', { file: second.file, server: official, owner: second.owner, action: 'remove' });
      }
    }, profile);
  } finally {
    if (file) {
      await withClient(async (_info, owner) => {
        await owner('collab.manageFile', { file, action: 'remove' });
      }, profile).catch(() => {});
    }
    await rm(profile, { recursive: true, force: true });
  }
});

for (const method of ['hosted', 'keyed']) {
  test(`Online ${method} share grants survive leave and restart and remain revocable`, {
    skip: !(official && (method !== 'keyed' || keyFile)) && 'set the isolated release binary endpoint and publisher key file',
  }, async () => {
    const profile = await mkdtemp(join(tmpdir(), 'omc-online-share-'));
    let file;
    let shared;
    let unrelated;
    const protectedList = record => {
      assert.equal(record.shared, true);
      assert.equal(record.hasOwnerToken, method === 'hosted');
      for (const field of ['key', 'owner', 'edit', 'view', 'code', 'editCode', 'viewCode', 'commentCode', 'share']) {
        assert.equal(Object.hasOwn(record, field), false, `the file list exposed ${field}`);
      }
    };
    try {
      await withClient(async (_info, owner) => {
        await owner('pref.publishServer', { url: official });
        await owner('file.new', { name: `Restart share fixture (${method})` });
        const auth = method === 'keyed' ? { key: (await readFile(keyFile, 'utf8')).trim() } : {};
        const published = (await owner('collab.publish', { server: official, ...auth })).published;
        file = published.file;
        assert.equal(Object.hasOwn(published, 'key'), false);
        shared = await owner('collab.share', { via: 'online', access: 'comment' });
        assert.equal(shared.code, shared.share.commentCode);
        assert.equal(shared.share.shared, true);
        unrelated = await owner('collab.manageFile', {
          file, action: 'createLink', access: 'view', label: 'Independent fixture link',
        });
        await owner('collab.leave');
        protectedList((await owner('collab.files')).files.find(item => item.file === file));
        await owner('collab.openFile', { file });
        assert.equal((await owner('collab.peers')).code, shared.code);
        await owner('collab.leave');
        if (process.platform !== 'win32') {
          const ledger = await stat(join(profile, 'native-v1/figcraft-online-files.json'));
          assert.equal(ledger.mode & 0o777, 0o600);
        }
      }, profile);
      await withClient(async (_info, owner) => {
        const record = (await owner('collab.files', { refresh: true })).files.find(item => item.file === file);
        protectedList(record);
        assert.equal(record.state, 'online');
        await owner('collab.openFile', { file });
        const restored = await owner('collab.peers');
        assert.equal(restored.code, shared.code);
        assert.deepEqual(restored.share, shared.share);
        await withClient(async (_info, guest) => {
          await guest('pref.publishServer', { url: official });
          assert.equal((await guest('collab.join', { link: shared.share.commentLink })).access, 'comment');
          assert.deepEqual(await owner('collab.stop'), { ended: false, shared: false });
          await until(async () => (await guest('collab.peers')).status === 'failed');
          for (const prefix of ['edit', 'view', 'comment']) {
            await assert.rejects(guest('collab.join', { link: shared.share[prefix + 'Link'] }));
          }
          if (method === 'hosted') await assert.rejects(guest('collab.join', { code: shared.share.commentCode }));
          assert.equal((await guest('collab.join', { link: unrelated.link })).access, 'view');
        });
        const links = (await owner('collab.manageFile', { file, action: 'links' })).links;
        assert.equal(links.some(link => link.label === 'Oh My Canvas share'), false);
        assert.equal((await owner('collab.peers')).share.shared, false);
        assert.equal((await owner('collab.files')).files.find(item => item.file === file).shared, false);
        await owner('collab.manageFile', { file, action: 'remove' });
        file = undefined;
      }, profile);
    } finally {
      if (file) {
        await withClient(async (_info, owner) => {
          await owner('collab.manageFile', { file, action: 'remove' });
        }, profile).catch(() => {});
      }
      await rm(profile, { recursive: true, force: true });
    }
  });
}

test('Online reconnect keeps offline edits and preserves a local copy on concurrent changes', {
  skip: !official && 'set the isolated release binary endpoint',
}, async () => {
  const connections = new Set();
  const proxy = createServer(client => {
    const upstream = connect({ host: '127.0.0.1', port: Number(new URL(official).port) });
    connections.add(client);
    client.pipe(upstream).pipe(client);
    client.once('close', () => {
      connections.delete(client);
      upstream.destroy();
    });
    upstream.once('close', () => client.destroy());
    upstream.on('error', () => client.destroy());
    client.on('error', () => upstream.destroy());
  });
  proxy.listen(0, '127.0.0.1');
  await once(proxy, 'listening');
  const address = 'ws://127.0.0.1:' + proxy.address().port + '/';
  const disconnect = () => {
    for (const connection of connections) connection.destroy();
  };
  try {
    await withClient(async (_info, owner) => {
      await owner('file.new', { name: 'Reconnect fixture' });
      const hosted = (await owner('collab.publish', { server: official })).published;
      try {
        await withClient(async (_info, guest) => {
          const opened = await guest('collab.join', { link: hosted.edit.replace(official, address) });
          disconnect();
          await until(async () => (await guest('collab.peers')).status === 'failed');
          await guest('text.create', { x: 1, y: 2, text: 'offline draft', name: 'Offline draft' });
          const resumed = await guest('collab.reconnect');
          assert.equal(resumed.document, opened.document);
          assert.equal(resumed.localCopy, null);
          await until(async () => (await owner('select.byName', { query: 'Offline draft' })).selection.length === 1);
          disconnect();
          await until(async () => (await guest('collab.peers')).status === 'failed');
          await guest('text.create', { x: 3, y: 4, text: 'unsent draft', name: 'Unsent draft' });
          await owner('text.create', { x: 5, y: 6, text: 'remote draft', name: 'Remote draft' });
          await delay(850);
          const second = await guest('collab.reconnect');
          assert.equal(second.localCopy, opened.document);
          assert.notEqual(second.document, opened.document);
          assert.equal((await guest('select.byName', { query: 'Remote draft' })).selection.length, 1);
          await guest('doc.switch', { index: 0 });
          assert.equal((await guest('select.byName', { query: 'Unsent draft' })).selection.length, 1);
        });
      } finally {
        await owner('collab.manageFile', { file: hosted.file, action: 'remove' });
      }
    });
  } finally {
    disconnect();
    await new Promise(resolve => proxy.close(resolve));
  }
});

test('Online recovery opens a divergent local archive beside the server document', {
  skip: !official && 'set the isolated release binary endpoint',
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omc-online-recovery-'));
  const path = join(directory, 'recovery.figcraft');
  try {
    await withClient(async (_info, owner) => {
      await owner('file.new', { name: 'Recovery source' });
      const hosted = await owner('collab.publish', { server: official });
      const file = hosted.published.file;
      try {
        await owner('collab.leave');
        await owner('text.create', { x: 10, y: 25, text: '복구 원본', name: 'Local recovery change' });
        await owner('file.saveAs', { path });
        const bytes = await readFile(path);
        const recovered = await owner('collab.recoverFile', {
          path, file, session: hosted.session, client: hosted.me, seq: 0,
        });
        assert.equal(recovered.recovery, 'separateCopy');
        assert.equal((await owner('select.byName', { query: 'Local recovery change' })).selection.length, 0);
        const tabs = await owner('doc.list');
        const copy = tabs.find(item => item.id === recovered.copy);
        assert.match(copy.name, /recovered copy/);
        await owner('doc.switch', { index: copy.index });
        assert.equal((await owner('select.byName', { query: 'Local recovery change' })).selection.length, 1);
        assert.deepEqual(await readFile(path), bytes);
      } finally {
        await owner('collab.manageFile', { file, action: 'remove' });
      }
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('The official server team list opens a token-free read-only invite', {
  skip: !(official && process.env.OMC_TEST_FIGCRAFT_TEAM) && 'use the official fixture with team_files = "view"',
}, async () => {
  await withClient(async (_info, owner) => {
    await owner('pref.publishServer', { url: official });
    await owner('file.new', { name: 'Team list fixture' });
    const file = (await owner('collab.publish', { server: official })).published.file;
    try {
      await owner('collab.share', { via: 'online', access: 'view' });
      const team = (await owner('collab.files', { refresh: true })).team;
      assert.equal(team.state, 'listed');
      const listed = team.files.find(item => item.file === file);
      assert.equal(listed.access, 'view');
      assert.equal(new URL(listed.link).searchParams.get('token'), null);
      assert.deepEqual((await owner('collab.files')).team, team);
      await withClient(async (_info, guest) => {
        assert.equal((await guest('collab.join', { link: listed.link })).access, 'view');
        await owner('collab.stop');
        await assert.rejects(guest('collab.join', { link: listed.link }));
      });
    } finally {
      await owner('collab.manageFile', { file, action: 'remove' });
    }
  });
});
