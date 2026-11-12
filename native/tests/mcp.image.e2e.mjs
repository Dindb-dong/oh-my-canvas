import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { inflateSync } from 'node:zlib';
import { createMcpFetch } from '../../core/mcp-fetch.mjs';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const sdk = process.env.OMC_TEST_SDK_ROOT;
const { Client } = await import(sdk
  ? pathToFileURL(join(sdk, 'dist/esm/client/index.js')).href
  : '@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = await import(sdk
  ? pathToFileURL(join(sdk, 'dist/esm/client/streamableHttp.js')).href
  : '@modelcontextprotocol/sdk/client/streamableHttp.js');
const binary = process.env.OMC_SERVICE_BINARY ?? join(
  root, 'native/target/debug', process.platform === 'win32' ? 'omc-service.exe' : 'omc-service',
);
const model = process.env.OMC_BACKGROUND_MODEL;
const size = 128;
// Synthetic opaque portrait with a flat green background and a purple shirt.
const source = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAIAAAACACAYAAADDPmHLAAAB8UlEQVR42u3cMU7DQBRF0b8EKpqUsAmyq6wlHRujoaRkD9BFkWIkxzHjGb9TvDYj+Z4ihT319f3xY7krDwEADwIAA8AAMAAMAAPAADAADAADwAAwAAwAA8AAMACG3cvz0+wBEBg9EUOJn42ghM+GUOJnIyjxsxGU+NkISvxsBCV+NgIAABA/GcHQAD7fT5cBEAbgOv5fgyAcQGsUAHQevwUKAAYEsCYKAHYCYCkKAHYa/x4UAAQBmBoAAACwJYDj6+FmS0Iu/R0AAAAAAAD8BwAAAAAAAAAAAAAAAAAAAAAAAAAAAGC/CLwPAAAAAAAQicBbwQAAkIrAl0EAAJCKwNfBAACQisANIcEI3BEUjMAtYR3t7Xi+rEX86/MA6Ch+CwRT5wHQSfj/hDDnPAA6ir8mgnvOA6Cj+I9geOQcADoLv9UACI4/CoISPxtBiZ+NoMTPRgAAAOInIyjxsxGU+NkIAABA/GQEJX42AgAAED8ZQYmfjQAAAMRPRgAAAOInIwAAAAAAED8WAQAAiJ+MAAAAAABA/FgEAAAAAADixyIAAAAAAAAAAPEzEQAAAAAAAAAAAACIH4gAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAYHcAv9wrSrA6jRHYAAAAASUVORK5CYII=',
  'base64',
);

function paeth(left, above, diagonal) {
  const target = left + above - diagonal;
  const distances = [left, above, diagonal].map(value => Math.abs(target - value));
  return [left, above, diagonal][distances.indexOf(Math.min(...distances))];
}

function alphaChannel(png) {
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.equal(png.toString('ascii', 12, 16), 'IHDR');
  assert.equal(png.readUInt32BE(16), size);
  assert.equal(png.readUInt32BE(20), size);
  assert.deepEqual([...png.subarray(24, 29)], [8, 6, 0, 0, 0]);
  const chunks = [];
  for (let offset = 8; offset < png.length;) {
    const length = png.readUInt32BE(offset);
    if (png.toString('ascii', offset + 4, offset + 8) === 'IDAT') {
      chunks.push(png.subarray(offset + 8, offset + 8 + length));
    }
    offset += length + 12;
  }
  const rowBytes = size * 4 + 1;
  const pixels = inflateSync(Buffer.concat(chunks), { maxOutputLength: size * rowBytes });
  assert.equal(pixels.length, size * rowBytes);
  const alpha = new Uint8Array(size * size);
  for (let y = 0; y < size; y++) {
    const filter = pixels[y * rowBytes];
    assert.ok(filter <= 4);
    for (let x = 0; x < size; x++) {
      const position = y * size + x;
      const left = x ? alpha[position - 1] : 0;
      const above = y ? alpha[position - size] : 0;
      const diagonal = x && y ? alpha[position - size - 1] : 0;
      const predictors = [0, left, above, (left + above) >> 1, paeth(left, above, diagonal)];
      alpha[position] = pixels[y * rowBytes + (x + 1) * 4] + predictors[filter];
    }
  }
  return alpha;
}

async function withImage(modelPath, verify) {
  await access(binary);
  const profile = await mkdtemp(join(tmpdir(), 'omc-native-image-'));
  const child = spawn(binary, ['--profile', profile, '--port', '0', '--legacy-mcp-port', '0'], {
    env: { ...process.env, OMC_BACKGROUND_MODEL: modelPath ?? join(profile, 'missing.onnx') },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  const exited = once(child, 'exit');
  const client = new Client({ name: 'native-image-sdk-contract', version: '1.0.0' });
  try {
    let runtime;
    for (let attempt = 0; attempt < 240 && !runtime; attempt++) {
      assert.equal(child.exitCode, null, 'native service exited before publishing the HTTPS descriptor');
      runtime = await readFile(join(profile, 'mcp-runtime.json'), 'utf8').then(JSON.parse, () => undefined);
      if (!runtime) await delay(25);
    }
    assert.ok(runtime, 'native service did not publish the HTTPS descriptor');
    const token = await readFile(join(profile, 'mcp-token-v2'), 'utf8');
    const cert = await readFile(runtime.certFile, 'utf8');
    await client.connect(new StreamableHTTPClientTransport(new URL(`https://127.0.0.1:${runtime.port}/mcp`), {
      fetch: createMcpFetch(cert),
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }));

    async function call(name, args) {
      const response = await client.callTool({ name, arguments: args }, undefined, { timeout: 180_000 });
      const value = response.structuredContent ?? JSON.parse(response.content.find(item => item.type === 'text').text);
      if (response.isError) throw Object.assign(new Error(value.message), value);
      return value;
    }
    const { documentId } = await call('create_document', { title: 'Native image integration fixture' });
    const asset = await call('document_assets', {
      documentId, action: 'add', kind: 'image', name: 'Test portrait',
      dataUrl: 'data:image/png;base64,' + source.toString('base64'),
    });
    const { id } = await call('document_assets', {
      documentId, action: 'place', id: asset.id, width: size, height: size,
    });
    const inspect = async () => {
      const { nodes, revision } = await call('get_tree', { documentId, id, detail: 'detailed' });
      return { revision, ...nodes[0] };
    };
    await verify({
      documentId, call, inspect,
      image: (action, revision) => call('image', { documentId, id, action, revision }),
      assetBytes: hash => readFile(join(profile, 'native-v1/assets/sha256', hash.slice(0, 2), hash)),
    });
  } finally {
    try {
      await client.close();
    } finally {
      child.kill();
      await exited;
      await rm(profile, { recursive: true, force: true });
    }
  }
}

test('pinned HTTPS MCP removes a background, restores the original and supports Undo', async () => {
  assert.ok(model, 'Set OMC_BACKGROUND_MODEL to the pinned U²-Netp file. See native/README.md.');
  await access(model);
  await withImage(resolve(model), async ({ documentId, call, inspect, image, assetBytes }) => {
    const before = await inspect();
    await assert.rejects(image('remove_background', before.revision - 1), { code: 'stale_revision' });
    assert.equal((await image('restore', before.revision)).changed, false);

    const removed = await image('remove_background', before.revision);
    assert.equal(removed.receipt.status, 'durable');
    const cutout = await inspect();
    assert.notEqual(cutout.properties.assetHash, before.properties.assetHash);
    assert.equal(cutout.properties.originalImage.assetHash, before.properties.assetHash);
    const alpha = alphaChannel(await assetBytes(cutout.properties.assetHash));
    assert.ok(alpha.filter(value => value >= 250).length > 20, 'foreground needs opaque pixels');
    assert.ok(alpha.filter(value => value <= 5).length > 20, 'background needs transparent pixels');
    assert.deepEqual(await assetBytes(before.properties.assetHash), source);

    const restored = await image('restore', cutout.revision);
    assert.equal(restored.receipt.status, 'durable');
    const after = await inspect();
    assert.equal(after.properties.assetHash, before.properties.assetHash);
    assert.equal(after.properties.originalImage, undefined);
    await call('undo', { documentId });
    const undone = await inspect();
    assert.equal(undone.properties.assetHash, cutout.properties.assetHash);
    assert.equal(undone.properties.originalImage.assetHash, before.properties.assetHash);
  });
});

test('pinned HTTPS MCP reports missing model without modifying the image layer', async () => {
  await withImage(undefined, async ({ inspect, image }) => {
    const before = await inspect();
    await assert.rejects(image('remove_background', before.revision), { code: 'background_model_unavailable' });
    assert.deepEqual(await inspect(), before);
  });
});
