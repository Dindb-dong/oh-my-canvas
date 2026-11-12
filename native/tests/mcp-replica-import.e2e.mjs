import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createMcpFetch } from '../../core/mcp-fetch.mjs';

const sdk = process.env.OMC_TEST_SDK_ROOT;
const { Client } = await import(sdk
  ? pathToFileURL(join(sdk, 'dist/esm/client/index.js'))
  : '@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = await import(sdk
  ? pathToFileURL(join(sdk, 'dist/esm/client/streamableHttp.js'))
  : '@modelcontextprotocol/sdk/client/streamableHttp.js');
const executable = process.platform === 'win32' ? 'omc-service.exe' : 'omc-service';
const binary = process.env.OMC_SERVICE_BINARY
  ?? fileURLToPath(new URL('../target/debug/' + executable, import.meta.url));

test('legacy MCP merges native OMC history atomically and migrates Electron canvas JSON', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'omc-replica-import-'));
  const services = [];
  async function start(name) {
    const profile = join(temporary, name);
    const process = spawn(binary, ['--profile', profile, '--port', '0', '--legacy-mcp-port', '0'], { stdio: 'inherit' });
    const exited = once(process, 'exit');
    const client = new Client({ name, version: '1.0.0' });
    services.push({ process, exited, client });
    let descriptor;
    for (let attempt = 0; attempt < 200 && process.exitCode === null; attempt++) {
      try {
        const runtime = JSON.parse(await readFile(join(profile, 'mcp-runtime.json'), 'utf8'));
        const certificate = await readFile(runtime.certFile, 'utf8');
        const token = await readFile(join(profile, 'mcp-token-v2'), 'utf8');
        descriptor = { endpoint: `https://127.0.0.1:${runtime.port}/mcp`, certificate, token };
        break;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        await delay(25);
      }
    }
    assert.ok(descriptor, 'native service did not start');
    await client.connect(new StreamableHTTPClientTransport(new URL(descriptor.endpoint), {
      fetch: createMcpFetch(descriptor.certificate),
      requestInit: { headers: { Authorization: `Bearer ${descriptor.token}` } },
    }));
    return async (name, args) => {
      const result = await client.callTool({ name, arguments: args });
      const value = result.structuredContent ?? JSON.parse(result.content.find(item => item.type === 'text').text);
      if (result.isError) throw Object.assign(new Error(value.message), value);
      return value;
    };
  }
  try {
    const source = await start('source');
    const peer = await start('peer');
    const { documentId } = await source('create_document', { title: 'Shared history' });
    const shape = (call, name) => call('create_shape', { documentId, type: 'rect', width: 40, height: 20, properties: { name } });
    const close = call => call('workspace', { action: 'close', documentId });
    const read = call => call('get_tree', { documentId, detail: 'detailed' });
    const names = tree => tree.nodes.map(node => node.name);
    const importWith = (call, payload, mode = 'merge') => call('import_document', { format: 'omc', payload, mode });
    const exportWith = (call, mode = 'merge') => call('export_document', { id: documentId, format: 'omc', mode });

    await shape(source, 'Base layer');
    const base = await exportWith(source);
    assert.equal(JSON.parse(base.content).format, 'omc.history/1');
    const fork = await importWith(peer, base.content);
    assert.equal(fork.documentId, documentId);
    assert.equal(fork.nativeRevision.epoch, base.revision.epoch);
    assert.ok(names(await read(peer)).includes('Base layer'));

    await shape(peer, 'Peer-only layer');
    const raster = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS9sAAAAASUVORK5CYII=', 'base64');
    const resource = await source('document_assets', {
      documentId, action: 'add', kind: 'image', name: 'Historical asset', dataUrl: `data:image/png;base64,${raster.toString('base64')}`,
    });
    await source('document_assets', { documentId, action: 'remove', id: resource.id });
    await shape(source, 'Remote first');
    await shape(source, 'Remote second');
    await shape(source, 'Remote third');
    const remote = await exportWith(source);
    const rasterHash = createHash('sha256').update(raster).digest('hex');
    assert.equal(JSON.parse(remote.content).assets[0].hash, rasterHash);
    await assert.rejects(importWith(peer, remote.content), { code: 'busy' });
    await close(peer);

    const incomplete = JSON.parse(remote.content);
    incomplete.replica.transactions.splice(-2, 1);
    incomplete.historySha256 = createHash('sha256').update(JSON.stringify(incomplete.replica)).digest('hex');
    await assert.rejects(importWith(peer, JSON.stringify(incomplete)), { code: 'dependency_unavailable' });
    const afterFailed = await read(peer);
    assert.ok(names(afterFailed).includes('Peer-only layer'));
    assert.ok(!names(afterFailed).includes('Remote first'), 'early replay must be rolled back');
    await close(peer);

    const imported = await importWith(peer, remote.content);
    assert.equal(imported.documentId, documentId);
    assert.equal(imported.mode, 'merge');
    assert.deepEqual(names(await read(peer)).filter(name => /layer|Remote/.test(name)).sort(),
      ['Base layer', 'Peer-only layer', 'Remote first', 'Remote second', 'Remote third']);
    assert.deepEqual(await readFile(join(temporary, 'peer', 'native-v1/assets/sha256', rasterHash.slice(0, 2), rasterHash)), raster);
    await close(peer);
    const retried = await importWith(peer, remote.content);
    assert.deepEqual(retried.revision, imported.revision);

    const independent = await exportWith(source, 'copy');
    assert.equal(JSON.parse(independent.content).format, 'omc.native/1');
    await assert.rejects(importWith(peer, independent.content), /no causal operation history/);
    const copy = await importWith(peer, independent.content, 'copy');
    assert.notEqual(copy.documentId, documentId);

    const legacyFile = new URL('../../docs/design/oh-my-canvas-ui-kit.omc', import.meta.url);
    const original = await readFile(legacyFile);
    await assert.rejects(importWith(peer, original.toString()), /contains Yjs history/);
    const canvasPayload = await readFile(new URL('../crates/omc-import/tests/fixtures/electron-canvas-ui-kit.json', import.meta.url), 'utf8');
    const canvas = JSON.parse(canvasPayload);
    const migrated = await peer('import_document', {
      format: 'json', payload: canvasPayload, strict: false, title: 'Migrated Electron canvas',
    });
    const migratedTree = await peer('get_tree', { documentId: migrated.documentId, detail: 'detailed' });
    assert.equal(migrated.pages.length, canvas.editorPages.length);
    assert.ok(migratedTree.nodes.some(node => node.text === 'OH MY CANVAS / DESIGN SYSTEM / 01'));
    assert.ok(migratedTree.nodes.some(node => node.kind === 'rect'));
    assert.deepEqual(await readFile(legacyFile), original);
  } finally {
    await Promise.all(services.map(async service => {
      await service.client.close();
      service.process.kill('SIGINT');
      await service.exited;
    }));
    await rm(temporary, { recursive: true, force: true });
  }
});
