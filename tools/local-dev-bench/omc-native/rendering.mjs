import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createInterface} from 'node:readline';
import {setTimeout as delay} from 'node:timers/promises';

const phaseLine = /^Metal phases acquire_ms=(\d+\.\d+) wrap_ms=(\d+\.\d+) paint_ms=(\d+\.\d+) flush_ms=(\d+\.\d+) present_ms=(\d+\.\d+)$/;

export function parseMetalPhases(line) {
  const phases = phaseLine.exec(line);
  if (!phases) return null;
  const [drawableAcquireMs, surfaceWrapMs, canvasPaintMs, skiaFlushAndSubmitMs, presentCommandSubmitMs] =
    phases.slice(1).map(Number);
  return {drawableAcquireMs, surfaceWrapMs, canvasPaintMs, skiaFlushAndSubmitMs, presentCommandSubmitMs};
}

export function collectDesktopTrace(stderr) {
  let backend = null;
  const phases = [];
  const lines = createInterface({input: stderr});
  lines.on('line', line => {
    process.stderr.write(line + '\n');
    const selected = /^Native presentation: (.+)$/.exec(line);
    if (selected) backend = selected[1];
    const sample = parseMetalPhases(line);
    if (sample) phases.push(sample);
  });
  return {phases, get backend() { return backend; }};
}

const origin = {cx: 72, cy: 96, zoom: 1};

export function* viewportSchedule(samples) {
  for (let i = 0; i < samples; i++) {
    const sample = i + 1;
    yield {sample, command: 'view.pan', params: {dx: 1, dy: 1}, expected: {cx: 92, cy: 116, zoom: 1}};
    yield {sample, command: 'view.pan', params: {dx: -1, dy: -1}, expected: origin};
    yield {sample, command: 'view.zoomIn', params: {}, expected: {...origin, zoom: 1.25}};
    yield {sample, command: 'view.zoomOut', params: {}, expected: origin};
  }
}

function camera(state) {
  const {cx, cy, zoom, vw, vh} = state;
  assert.ok([cx, cy, zoom, vw, vh].every(Number.isFinite));
  assert.ok(zoom > 0 && vw > 0 && vh > 0);
  return {cx, cy, zoom, vw, vh};
}

function verifyCamera(actual, expected) {
  for (const key of ['cx', 'cy', 'zoom']) {
    assert.ok(Math.abs(actual[key] - expected[key]) < 1e-7, `Camera ${key} differs from scheduled value`);
  }
}

export async function measureRendering({call, documentId, report, sampleCount, trace, signal}) {
  const selection = report.rendering;

  async function inspect() {
    const state = await call('inspect_ui', {});
    assert.equal(state.attached, true);
    assert.equal(state.documentId, documentId);
    assert.ok(state.windows.length > 0 && state.windows.every(window => window.focused === false));
    assert.ok(Number.isInteger(state.framesDrawn) && state.framesDrawn >= 0);
    return {
      camera: camera(state.view),
      framesDrawn: state.framesDrawn,
      lastSuccessfulDrawMs: state.frameMs,
    };
  }

  async function runCommand(command, params) {
    const start = performance.now();
    const response = await call('run_command', {command, params});
    return {roundTripMs: performance.now() - start, camera: camera(response)};
  }

  selection.before = await inspect();
  const initial = await runCommand('view.set', origin);
  verifyCamera(initial.camera, origin);
  selection.cameraSetup = initial;
  selection.beforeViewportSteps = await inspect();

  const traceStart = trace.phases.length;
  for (const {sample, command, params, expected} of viewportSchedule(sampleCount)) {
    signal.throwIfAborted();
    const state = await runCommand(command, params);
    verifyCamera(state.camera, expected);
    report.samples.push({sample, command, params, ...state});
  }
  await delay(100, undefined, {signal});
  selection.afterViewportSteps = await inspect();
  verifyCamera(selection.afterViewportSteps.camera, origin);
  selection.backend = trace.backend;
  selection.desktopDrawCountDelta = selection.afterViewportSteps.framesDrawn - selection.beforeViewportSteps.framesDrawn;
  selection.metalPhaseSamples = trace.phases.slice(traceStart);

  async function capture() {
    const started = performance.now();
    const screenshot = await call('screenshot', {window: true});
    const roundTripMs = performance.now() - started;
    assert.equal(screenshot.mimeType, 'image/png');
    const bytes = Buffer.from(screenshot.base64, 'base64');
    assert.ok(bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')));
    assert.equal(bytes.readUInt32BE(16), screenshot.width);
    assert.equal(bytes.readUInt32BE(20), screenshot.height);
    return {
      roundTripMs, width: screenshot.width, height: screenshot.height, pngBytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
  }

  selection.offscreenPng = [];
  selection.offscreenPng.push({condition: 'first', ...await capture()});
  selection.offscreenPng.push({condition: 'repeated-static', ...await capture()});
  verifyCamera((await runCommand('view.zoomIn', {})).camera, {...origin, zoom: 1.25});
  selection.offscreenPng.push({condition: 'zoomed', ...await capture()});
  verifyCamera((await runCommand('view.zoomOut', {})).camera, origin);
  selection.final = await inspect();
  verifyCamera(selection.final.camera, origin);
}
