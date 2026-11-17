import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createHash, randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {mkdir, mkdtemp, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';
import {crc32, deflateSync, inflateSync} from 'node:zlib';

const signature = Buffer.from('89504e470d0a1a0a', 'hex');
const atlas = {x: 0, y: 0, width: 736, height: 480};
const dimensions = {'2mp': [1600, 1250], '1mp': [1152, 900], small: [160, 125]};
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

function chunk(type, bytes) {
  const packet = Buffer.alloc(bytes.length + 12);
  packet.writeUInt32BE(bytes.length);
  packet.write(type, 4, 'ascii');
  bytes.copy(packet, 8);
  packet.writeUInt32BE(crc32(packet.subarray(4, -4)), packet.length - 4);
  return packet;
}

function sourcePng(width, height, colors) {
  const stride = width * 4 + 1;
  const rows = [0, 2].map(first => {
    const row = Buffer.alloc(stride);
    const split = Math.floor(width / 2) * 4 + 1;
    row.fill(Buffer.from(colors[first]), 1, split);
    row.fill(Buffer.from(colors[first + 1]), split);
    return row;
  });
  const bytes = Buffer.allocUnsafe(stride * height);
  for (let y = 0; y < height; y++) rows[Number(y >= Math.floor(height / 2))].copy(bytes, y * stride);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([signature, chunk('IHDR', header), chunk('IDAT', deflateSync(bytes)), chunk('IEND', Buffer.alloc(0))]);
}

export function makePressureFixture(condition, size = '2mp') {
  assert.ok(['shared', 'distinct'].includes(condition));
  assert.ok(Object.hasOwn(dimensions, size));
  const [width, height] = dimensions[size];
  const assets = Array.from({length: condition === 'shared' ? 1 : 20}, (_, index) => {
    const colors = [
      [32 + 9 * index, 36, 98, 255], [172, 38 + 9 * index, 52, 255],
      [48, 142, 52 + 9 * index, 255], [201 - 9 * index, 164, 31, 255],
    ];
    const bytes = sourcePng(width, height, colors);
    return {index, width, height, colors, bytes, hash: sha256(bytes)};
  });
  const placements = Array.from({length: 20}, (_, index) => ({
    x: 16 + 144 * (index % 5), y: 16 + 116 * Math.floor(index / 5), width: 128, height: 100,
    hash: assets[condition === 'shared' ? 0 : index].hash,
  }));
  assert.equal(new Set(assets.map(asset => asset.hash)).size, assets.length);
  return {assets, placements, width, height};
}

function paeth(left, above, corner) {
  const value = left + above - corner;
  const a = Math.abs(value - left);
  const b = Math.abs(value - above);
  const c = Math.abs(value - corner);
  return a <= b && a <= c ? left : b <= c ? above : corner;
}

export function pngPixels(png, expectedWidth, expectedHeight) {
  assert.ok(png.subarray(0, 8).equals(signature));
  assert.equal(png.readUInt32BE(8), 13);
  assert.equal(png.toString('ascii', 12, 16), 'IHDR');
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  assert.deepEqual([width, height], [expectedWidth, expectedHeight]);
  const format = png[25];
  assert.deepEqual([...png.subarray(24, 29)], [8, format, 0, 0, 0]);
  assert.ok([2, 6].includes(format), 'Expected true-color 8-bit PNG');
  const idat = [];
  let ended = false;
  for (let cursor = 8; cursor + 12 <= png.length;) {
    const length = png.readUInt32BE(cursor);
    const end = cursor + 12 + length;
    assert.ok(end <= png.length);
    const name = png.toString('ascii', cursor + 4, cursor + 8);
    assert.equal(crc32(png.subarray(cursor + 4, end - 4)), png.readUInt32BE(end - 4));
    if (name === 'IDAT') idat.push(png.subarray(cursor + 8, end - 4));
    if (name === 'IEND') {
      assert.equal(length, 0);
      assert.equal(end, png.length);
      ended = true;
      break;
    }
    cursor = end;
  }
  assert.ok(ended && idat.length > 0);
  const channels = format === 6 ? 4 : 3;
  const stride = width * channels;
  const data = inflateSync(Buffer.concat(idat), {maxOutputLength: height * (stride + 1)});
  assert.equal(data.length, height * (stride + 1));
  const pixels = Buffer.allocUnsafe(height * stride);
  for (let y = 0; y < height; y++) {
    const offset = y * (stride + 1);
    const filter = data[offset];
    assert.ok(filter <= 4);
    for (let x = 0; x < stride; x++) {
      const i = y * stride + x;
      const left = x >= channels ? pixels[i - channels] : 0;
      const above = y ? pixels[i - stride] : 0;
      const corner = y && x >= channels ? pixels[i - stride - channels] : 0;
      let predictor = 0;
      switch (filter) {
        case 1: predictor = left; break;
        case 2: predictor = above; break;
        case 3: predictor = (left + above) >> 1; break;
        case 4: predictor = paeth(left, above, corner); break;
      }
      pixels[i] = data[offset + x + 1] + predictor;
    }
  }
  return {
    sha256: sha256(pixels),
    at(x, y) {
      assert.ok(Number.isInteger(x) && Number.isInteger(y) && x >= 0 && x < width && y >= 0 && y < height);
      const start = (y * width + x) * channels;
      const pixel = [...pixels.subarray(start, start + channels)];
      return channels === 4 ? pixel : [...pixel, 255];
    },
  };
}

export function verifyAtlas(png, fixture) {
  const pixels = pngPixels(png, atlas.width, atlas.height);
  const checkedPixels = [];
  const assets = new Map(fixture.assets.map(asset => [asset.hash, asset]));
  for (const tile of fixture.placements) {
    const {colors} = assets.get(tile.hash);
    for (const [index, wanted] of colors.entries()) {
      const x = tile.x + (index % 2 ? 96 : 32);
      const y = tile.y + (index >= 2 ? 75 : 25);
      const actual = pixels.at(x, y);
      assert.ok(actual.every((channel, channelIndex) => Math.abs(channel - wanted[channelIndex]) <= 2),
        `Unexpected pixel at ${x},${y}: got ${actual}, expected ${wanted}`);
      checkedPixels.push({x, y, actual, expected: wanted});
    }
  }
  return {sha256: pixels.sha256, checkedPixels};
}

async function run(fixture, report, signal, artifactDir) {
  const binary = join(process.env.OMC_BENCH_BIN_DIR ?? '/Applications/Oh My Canvas.app/Contents/MacOS', 'omc-service');
  report.binarySha256 = sha256(await readFile(binary));
  const profile = await mkdtemp(join(tmpdir(), 'omc-ng-pressure-'));
  let service;
  let sessionId;
  try {
    const started = performance.now();
    service = spawn(binary, ['--profile', profile, '--port', '0'], {stdio: ['ignore', 2, 2]});
    await once(service, 'spawn');
    let descriptor;
    while (!descriptor && performance.now() - started < 10_000) {
      signal.throwIfAborted();
      assert.ok(service.exitCode === null && service.signalCode === null);
      try {
        const seen = JSON.parse(await readFile(join(profile, 'native-v1/service.json'), 'utf8'));
        if (seen.pid === service.pid) descriptor = seen;
      } catch (error) {
        if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
      }
      if (!descriptor) await delay(25, undefined, {signal});
    }
    assert.ok(descriptor, 'Missing isolated service descriptor');
    const url = new URL('/rpc', descriptor.endpoint);
    assert.equal(url.hostname, '127.0.0.1');
    report.stages.serviceDescriptorMs = performance.now() - started;

    async function rpc(method, params = {}, allowError = false) {
      const before = performance.now();
      const response = await fetch(url, {
        method: 'POST',
        headers: {Authorization: `Bearer ${descriptor.token}`, 'Content-Type': 'application/json',
          ...(sessionId && {'X-OMC-Session': sessionId})},
        body: JSON.stringify({id: randomUUID(), method, params}),
        signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
      });
      const raw = await response.arrayBuffer();
      const payload = JSON.parse(Buffer.from(raw).toString('utf8'));
      assert.ok(response.ok, `${method}: HTTP ${response.status}`);
      if (payload.error) {
        assert.ok(allowError, `${method}: ${payload.error.code} ${payload.error.message}`);
        return {error: payload.error, elapsedMs: performance.now() - before, responseBytes: raw.byteLength};
      }
      return {result: payload.result, elapsedMs: performance.now() - before, responseBytes: raw.byteLength};
    }

    ({result: {sessionId}} = await rpc('session.open'));
    const {result: base, ...creation} = await rpc('workspace.create', {title: 'Synthetic 20-image native atlas'});
    report.stages.create = creation;
    const documentId = base.id;
    const assetCall = arguments_ => rpc('tool.call', {name: 'document_assets', arguments: {documentId, ...arguments_}});
    const ids = new Map();
    for (const asset of fixture.assets) {
      const {result, ...metrics} = await assetCall({action: 'add', kind: 'image',
        name: `N-G source ${asset.index + 1}`, dataUrl: 'data:image/png;base64,' + asset.bytes.toString('base64')});
      assert.equal(result.receipt.status, 'durable');
      assert.equal(result.asset.hash, asset.hash);
      assert.equal(result.asset.byteLength, asset.bytes.length);
      ids.set(asset.hash, result.id);
      report.ingest.push({hash: asset.hash, inputBytes: asset.bytes.length, ...metrics});
    }
    assert.equal(new Set(ids.values()).size, fixture.assets.length);

    for (const {hash, ...dimensions} of fixture.placements) {
      const {result, ...metrics} = await assetCall({action: 'place', id: ids.get(hash), ...dimensions});
      assert.equal(result.receipt.status, 'durable');
      report.place.push({hash, ...dimensions, ...metrics});
    }
    const {result: snapshot, ...metrics} = await rpc('document.snapshot', {documentId});
    assert.equal(snapshot.id, documentId);
    assert.equal(snapshot.pages.length, 1);
    const images = Object.values(snapshot.nodes).filter(node => node.kind === 'image')
      .sort((a, b) => a.properties.y - b.properties.y || a.properties.x - b.properties.x);
    assert.equal(Object.keys(snapshot.nodes).length, 21);
    assert.equal(images.length, fixture.placements.length);
    assert.ok(images.every(image => image.parentId === snapshot.pages[0].rootNodeId));
    assert.deepEqual(images.map(({properties: {x, y, width, height, assetHash: hash}}) => ({x, y, width, height, hash})),
      fixture.placements);
    assert.equal(BigInt(snapshot.sequence) - BigInt(base.sequence), BigInt(fixture.assets.length + images.length));
    report.stages.snapshot = {...metrics, checkedImageNodes: images.length, epoch: snapshot.epoch, sequence: snapshot.sequence};

    if (artifactDir) await mkdir(artifactDir, {recursive: true});
    for (const phase of ['first', 'repeat', 'repeat-2']) {
      const {result: exportResult, error, ...timing} = await rpc('document.export', {
        documentId, pageId: snapshot.pages[0].id, format: 'png', bounds: atlas,
      }, true);
      if (error) {
        report.exports.push({phase, ...timing, rejection: {code: error.code, message: error.message}});
        assert.match(error.message, /exceed the render reservation|render requires at least .* reserved bytes/i);
        assert.equal(phase, 'first', 'Repeat export failed after an accepted first render');
        report.rasterRejectedByBudget = true;
        break;
      }
      assert.equal(exportResult.mediaType, 'image/png');
      assert.deepEqual(exportResult.revision, {epoch: snapshot.epoch, sequence: snapshot.sequence});
      assert.deepEqual(exportResult.diagnostics, []);
      const png = Buffer.from(exportResult.contentBase64, 'base64');
      if (artifactDir) await writeFile(join(artifactDir, `${report.size}-${report.condition}-${phase}.png`), png, {flag: 'wx', mode: 0o600});
      const verification = verifyAtlas(png, fixture);
      report.exports.push({phase, pngBytes: png.length, pngSha256: sha256(png), diagnostics: exportResult.diagnostics,
        ...timing, verification});
    }
    if (!report.rasterRejectedByBudget) {
      assert.equal(new Set(report.exports.map(row => row.verification.sha256)).size, 1, 'Raster changed between repeated exports');
    }
    assert.deepEqual((await rpc('document.snapshot', {documentId})).result, snapshot, 'Raster mutated the source document');
    report.stages.sourceUnchangedAfterExport = true;

    // Read the store only after the raster series so this verifier does not prewarm its input bytes.
    const store = join(profile, 'native-v1/assets/sha256');
    const observed = (await Promise.all((await readdir(store)).map(prefix => readdir(join(store, prefix))))).flat().sort();
    assert.deepEqual(observed, [...ids.keys()].sort());
    for (const asset of fixture.assets) {
      const original = await readFile(join(store, asset.hash.slice(0, 2), asset.hash));
      assert.equal(sha256(original), asset.hash);
      assert.deepEqual(original, asset.bytes);
      report.store.push({hash: asset.hash, bytes: original.length, width: original.readUInt32BE(16), height: original.readUInt32BE(20)});
    }
    await rpc('session.close');
  } finally {
    if (service?.pid && service.exitCode === null && service.signalCode === null) {
      const exited = once(service, 'exit');
      const deadline = setTimeout(() => service.kill('SIGKILL'), 4000);
      service.kill('SIGINT');
      try {
        await exited;
      } finally {
        clearTimeout(deadline);
      }
    }
    await rm(profile, {recursive: true, force: true, maxRetries: 10});
  }
}

async function main() {
  const {values} = parseArgs({options: {condition: {type: 'string'}, size: {type: 'string', default: '2mp'},
    'fixture-only': {type: 'boolean'}, 'artifact-dir': {type: 'string'}}});
  const {condition, size} = values;
  const fixtureStarted = performance.now();
  const fixture = makePressureFixture(condition, size);
  const report = {
    measurementKind: 'installed-headless-image-pressure-diagnostic', experiment: 'N-G', extension: 'LD06 image pressure',
    condition, size, dimensions: [fixture.width, fixture.height], placedImages: fixture.placements.length,
    uniqueImages: fixture.assets.length, geometrySha256: sha256(JSON.stringify(fixture.placements.map(({hash, ...rect}) => rect))),
    sourceAssets: fixture.assets.map(({hash, bytes, colors}) => ({hash, bytes: bytes.length, colors})),
    stages: {fixtureGenerationMs: performance.now() - fixtureStarted}, ingest: [], place: [], exports: [], store: [],
    unavailable: {
      hashCopyDecodeBreakdown: 'Asset ingest and headless export expose combined wall time only.',
      cache: 'Repeated exports are observed without a cache-hit or decoder-residency counter.',
      gpuUploadGpuCompletionPresentation: 'The headless export exercises the native software raster path.',
      otherContent: 'This image extension does not exercise text, fonts, masks, blurs or gradients.',
    },
  };
  const controller = new AbortController();
  for (const name of ['SIGINT', 'SIGTERM']) process.once(name, () => controller.abort(new Error(name)));
  try {
    if (!values['fixture-only']) {
      const started = performance.now();
      try {
        await run(fixture, report, controller.signal, values['artifact-dir']);
      } finally {
        report.stages.runMs = performance.now() - started;
      }
    }
    report.status = values['fixture-only'] ? 'fixture-only' : report.rasterRejectedByBudget ? 'rejected-budget' : 'verified';
    if (report.rasterRejectedByBudget) process.exitCode = 2;
  } catch (error) {
    report.status = 'failed';
    report.error = error.message;
    process.exitCode = 1;
  }
  console.log(JSON.stringify(report, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
