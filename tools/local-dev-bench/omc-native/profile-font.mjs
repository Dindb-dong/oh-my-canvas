import assert from 'node:assert/strict';
import {execFileSync, spawn} from 'node:child_process';
import {createHash, randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';
import {pngPixels} from './asset-pressure.mjs';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const marker = 'LD06 font ';
const fill = '#1a60a1';
const fontSha256 = '194018e6b2b293a7964f037b25c0249ce1418bc9ab3c971060a03aa57861e252';
const licenseSha256 = '1c05c68c34f9708415aada51f17e1b0092d2cea709bf4a94cd38114f9e73d7d9';

export function planFontFixture(spec) {
  assert.equal(spec.workload, 'LD06');
  assert.equal(spec.font?.family, 'Noto Sans KR');
  assert.equal(spec.font.sha256, fontSha256);
  const phrases = [...new Set([spec.loaded, spec.expected].flatMap(state =>
    state.nodes.filter(node => node.font_sha256 === spec.font.sha256).map(node => node.text)))];
  const latin = spec.font.registered_glyphs.filter(glyph => /^[A-Za-z]$/.test(glyph)).slice(0, 2);
  const hangul = spec.font.registered_glyphs.filter(glyph => /^[가-힣]$/.test(glyph)).slice(0, 2);
  assert.equal(latin.length, 2);
  assert.equal(hangul.length, 2);
  assert.ok(phrases.length >= 12);
  assert.ok(phrases.every(phrase => [...phrase].every(glyph => /\s/u.test(glyph)
    || spec.font.registered_glyphs.includes(glyph))));
  return [
    ...phrases.map(text => ({kind: 'phrase', text})),
    ...latin.map(text => ({kind: 'latin-glyph', text})),
    ...hangul.map(text => ({kind: 'hangul-glyph', text})),
  ].map((probe, index) => ({...probe, key: `${probe.kind}-${index + 1}`}));
}

export function inkShape(pixels, width, height) {
  const points = [];
  let left = width;
  let right = -1;
  let top = height;
  let bottom = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b, alpha] = pixels.at(x, y);
      if (alpha > 0 && g - r > 20 && b - g > 20) {
        points.push([x, y]);
        left = Math.min(left, x);
        right = Math.max(right, x);
        top = Math.min(top, y);
        bottom = Math.max(bottom, y);
      }
    }
  }
  assert.ok(points.length >= 10, 'No visible foreground text ink');
  const inkWidth = right - left + 1;
  const inkHeight = bottom - top + 1;
  const normalized = Buffer.alloc(inkWidth * inkHeight);
  for (const [x, y] of points) normalized[(y - top) * inkWidth + x - left] = 1;
  return {
    inkPixels: points.length, inkBounds: [left, top, inkWidth, inkHeight],
    inkShapeSha256: sha256(Buffer.concat([Buffer.from(`${inkWidth}x${inkHeight}\n`), normalized])),
  };
}

function storedId(id) {
  assert.match(id, /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/);
  return 'doc_' + id.replaceAll('-', '');
}

async function startService(binary, profile, signal) {
  const {Client, StreamableHTTPClientTransport} = await import('../replays/mcp.mjs');
  const child = spawn(binary, ['--profile', profile, '--port', '0'], {stdio: ['ignore', 2, 2]});
  let client;
  async function stop() {
    try {
      await client?.close();
    } finally {
      if (child.pid && child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit');
        const watchdog = setTimeout(() => child.kill('SIGKILL'), 5000);
        child.kill('SIGINT');
        try {
          await exited;
        } finally {
          clearTimeout(watchdog);
        }
      }
    }
  }
  try {
    await once(child, 'spawn');
    let descriptor;
    for (let attempt = 0; attempt < 200 && !descriptor; attempt++) {
      signal.throwIfAborted();
      assert.ok(child.exitCode === null && child.signalCode === null);
      try {
        const value = JSON.parse(await readFile(join(profile, 'native-v1/service.json'), 'utf8'));
        if (value.pid === child.pid) descriptor = value;
      } catch (error) {
        if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
      }
      if (!descriptor) await delay(25, undefined, {signal});
    }
    assert.ok(descriptor, 'Missing isolated OMC service descriptor');
    const url = new URL(descriptor.endpoint);
    assert.equal(url.hostname, '127.0.0.1');
    const headers = {Authorization: `Bearer ${descriptor.token}`};
    client = new Client({name: 'omc-profile-font', version: '1'});
    const transport = new StreamableHTTPClientTransport(new URL('/mcp/figcraft', url), {
      requestInit: {headers},
    });
    await client.connect(transport, {signal, timeout: 10_000});
    assert.ok(transport.sessionId);
    async function call(name, args = {}) {
      const response = await client.callTool({name, arguments: args}, undefined, {signal, timeout: 15_000});
      const content = response.structuredContent ?? JSON.parse(response.content.find(row => row.type === 'text').text);
      assert.ok(!response.isError, `${args.command ?? name}: ${JSON.stringify(content)}`);
      return content;
    }
    async function rpc(method, id) {
      const response = await fetch(new URL('/rpc', url), {
        method: 'POST',
        headers: {...headers, 'Content-Type': 'application/json', 'X-OMC-Session': transport.sessionId},
        body: JSON.stringify({id: randomUUID(), method, params: {documentId: storedId(id)}}),
        signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
      });
      const body = await response.json();
      assert.ok(response.ok && !body.error, `${method}: ${body.error?.message ?? response.status}`);
      return body.result;
    }
    return {child, call, rpc, stop, run: (command, params = {}) => call('run_command', {command, params})};
  } catch (error) {
    await stop();
    throw error;
  }
}

async function capture(api, documentId, spec, probes, output, phase) {
  const fonts = await api.run('text.fonts');
  const missing = await api.run('text.missingFonts');
  assert.ok(fonts.includes(spec.font.family));
  assert.ok(!missing.families.some(row => row.family === spec.font.family));
  const raw = await api.rpc('document.snapshot', documentId);
  const view = await api.call('inspect_document', {depth: 1});
  assert.equal(raw.id, storedId(documentId));
  assert.equal(view.id, documentId);
  assert.equal(view.layers.length, probes.length);
  const records = [];
  for (const probe of probes) {
    const name = marker + probe.key;
    const node = Object.values(raw.nodes).find(row => row.properties.name === name);
    const layer = view.layers.find(row => row.name === name);
    assert.ok(node && layer);
    assert.equal(node.kind, 'text');
    assert.equal(node.properties.text, probe.text);
    assert.equal(layer.characters, probe.text);
    assert.equal(layer.fontFamily, spec.font.family);
    const screenshot = await api.call('screenshot', {ids: [layer.id], scale: 1});
    const png = Buffer.from(screenshot.base64, 'base64');
    assert.ok(png.length >= 33);
    const width = png.readUInt32BE(16);
    const height = png.readUInt32BE(20);
    assert.ok(width > 0 && width <= 2048 && height > 0 && height <= 2048);
    const raster = pngPixels(png, width, height);
    const artifact = `${phase}-${probe.key}.png`;
    await writeFile(join(output, artifact), png, {flag: 'wx', mode: 0o600});
    records.push({
      ...probe, nativeId: node.id, requestedFamily: layer.fontFamily, artifact, width, height,
      pngSha256: sha256(png), rasterSha256: raster.sha256, ...inkShape(raster, width, height),
    });
  }
  for (const kind of ['latin-glyph', 'hangul-glyph']) {
    assert.equal(new Set(records.filter(row => row.kind === kind).map(row => row.inkShapeSha256)).size, 2,
      `Expected distinct normalized ink shapes for ${kind}`);
  }
  return {epoch: raw.epoch, sequence: raw.sequence, records};
}

async function confirmMissing(api, family, documentId) {
  await api.rpc('workspace.open', documentId);
  const fonts = await api.run('text.fonts');
  const missing = await api.run('text.missingFonts');
  if (fonts.includes(family)) return {familyAlreadyAvailable: true};
  assert.ok(missing.families.some(row => row.family === family));
  const view = await api.call('inspect_document', {depth: 1});
  await assert.rejects(() => api.call('screenshot', {ids: [view.layers[0].id]}), /font_substitution/);
  return {familyAlreadyAvailable: false, missingReported: true, screenshotRejectedWithoutFont: true};
}

async function run(report, spec, probes, fontPath, font, license, output, signal) {
  const binary = join(process.env.OMC_BENCH_BIN_DIR ?? '/Applications/Oh My Canvas.app/Contents/MacOS', 'omc-service');
  report.binarySha256 = sha256(await readFile(binary));
  const profile = await mkdtemp(join(tmpdir(), 'omc-ld06-profile-font-'));
  let service;
  async function start(label) {
    const begin = performance.now();
    report.currentPhase = label;
    service = await startService(binary, profile, signal);
    report.processes.push({label, pid: service.child.pid, readyMs: performance.now() - begin});
  }
  async function stop() {
    await service.stop();
    assert.equal(service.child.exitCode, 0, 'Isolated service failed normal exit');
    service = undefined;
  }
  try {
    await start('session-load');
    const {id} = await service.run('file.new', {name: 'Synthetic LD06 profile font'});
    report.documentId = id;
    for (const [index, row] of probes.entries()) {
      await service.call('create_node', {
        type: 'text', name: marker + row.key, text: row.text,
        x: 10, y: 10 + index * 65, width: 380, height: 56, select: false,
        props: {fontFamily: spec.font.family, fontSize: 34, fill},
      });
    }
    report.beforeLoad = await confirmMissing(service, spec.font.family, id);
    const begin = performance.now();
    const loaded = await service.run('text.loadFont', {path: fontPath});
    report.localLoad = {...loaded, elapsedMs: performance.now() - begin};
    assert.ok(loaded.families.includes(spec.font.family));
    await service.rpc('document.save', id);
    report.loaded = await capture(service, id, spec, probes, output, 'loaded');
    await stop();

    await start('unseeded-reopen');
    report.unseededReopen = await confirmMissing(service, spec.font.family, id);
    await stop();

    report.currentPhase = 'seed-profile-store';
    const store = join(profile, 'native-v1', 'font-store');
    const stage = join(store, '.ld06-stage');
    const destination = join(store, fontSha256);
    await mkdir(stage, {recursive: true, mode: 0o700});
    await writeFile(join(stage, '0.ttf'), font, {flag: 'wx', mode: 0o600});
    await writeFile(join(stage, 'LICENSE.txt'), license, {flag: 'wx', mode: 0o600});
    await rename(stage, destination);
    report.profileStore = {fontSha256: sha256(await readFile(join(destination, '0.ttf'))),
      licenseSha256: sha256(await readFile(join(destination, 'LICENSE.txt')))};
    assert.deepEqual(report.profileStore, {fontSha256, licenseSha256});

    await start('seeded-reopen');
    await service.rpc('workspace.open', id);
    report.reopened = await capture(service, id, spec, probes, output, 'reopened');
    const withoutArtifact = ({artifact, ...row}) => row;
    assert.deepEqual(report.reopened.records.map(withoutArtifact), report.loaded.records.map(withoutArtifact),
      'Text identity, content, or actual raster changed after a fresh process reopened');
    assert.equal(report.reopened.epoch, report.loaded.epoch);
    assert.equal(report.reopened.sequence, report.loaded.sequence);
    await stop();
    assert.equal(new Set(report.processes.map(row => row.pid)).size, 3);
  } finally {
    try {
      await service?.stop();
    } finally {
      await rm(profile, {recursive: true, force: true, maxRetries: 10});
    }
  }
}

async function main() {
  const {values} = parseArgs({options: {
    font: {type: 'string'}, license: {type: 'string'}, output: {type: 'string'},
    variant: {type: 'string', default: 'metro-stories'}, 'fixture-only': {type: 'boolean'},
  }});
  assert.ok(values.font && values.license && (values['fixture-only'] || values.output),
    'Pass --font and --license, plus --output for an installed run');
  const fontPath = await realpath(values.font);
  const font = await readFile(fontPath);
  const license = await readFile(await realpath(values.license));
  assert.equal(sha256(font), fontSha256);
  assert.equal(sha256(license), licenseSha256);
  assert.match(license.toString('utf8'), /SIL OPEN FONT LICENSE Version 1\.1/i);
  const generator = fileURLToPath(new URL('../workloads/synthetic.py', import.meta.url));
  const spec = JSON.parse(execFileSync('python3', [generator, 'fixture', 'LD06', '--variant', values.variant,
    '--font-file', fontPath, '--font-license', 'OFL-1.1'], {
    env: {...process.env, PYTHONDONTWRITEBYTECODE: '1'}, timeout: 15_000,
  }));
  const probes = planFontFixture(spec);
  const report = {
    measurementKind: 'installed-headless-profile-font-diagnostic', workload: 'LD06', extension: 'W7 text raster',
    fixtureSha256: spec.fixture_sha256, variant: values.variant, font: spec.font, licenseSha256,
    coverage: {cmapVerifiedGlyphs: spec.font.registered_glyphs, probes},
    limits: {
      persistence: 'Session font load and explicit isolated profile seeding are separate operations.',
      perGlyphAttribution: 'Requested family and strict native raster are observed. Resolved per-glyph typeface IDs are unobservable.',
      workload: 'Font and text diagnostic only. LD06 assets, source handoff and complete W7 are outside scope.',
    },
    processes: [],
  };
  const controller = new AbortController();
  for (const name of ['SIGINT', 'SIGTERM']) process.once(name, () => controller.abort(new Error(name)));
  try {
    if (!values['fixture-only']) {
      const output = resolve(values.output);
      await mkdir(output, {mode: 0o700});
      await run(report, spec, probes, fontPath, font, license, output, controller.signal);
    }
    report.status = values['fixture-only'] ? 'fixture-only' : 'verified';
  } catch (error) {
    report.status = 'failed';
    report.error = error.message;
    process.exitCode = 1;
  }
  console.log(JSON.stringify(report, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
