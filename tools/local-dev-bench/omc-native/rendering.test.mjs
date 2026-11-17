import assert from 'node:assert/strict';
import test from 'node:test';

import {parseMetalPhases, viewportSchedule} from './rendering.mjs';

test('N-D distinguishes the present command submission from physical presentation', () => {
  assert.deepEqual(parseMetalPhases('Metal phases acquire_ms=0.100 wrap_ms=0.200 paint_ms=1.000 flush_ms=0.300 present_ms=0.010'), {
    drawableAcquireMs: 0.1,
    surfaceWrapMs: 0.2,
    canvasPaintMs: 1,
    skiaFlushAndSubmitMs: 0.3,
    presentCommandSubmitMs: 0.01,
  });
  assert.equal(parseMetalPhases('Native presentation: Metal'), null);
  assert.equal(parseMetalPhases('Metal phases acquire_ms=0.1'), null);
});

test('N-D uses equivalent pan and zoom round trips for each sample', () => {
  const [pan, returnPan, zoom, returnZoom, ...second] = [...viewportSchedule(2)];
  assert.deepEqual([pan.command, returnPan.command, zoom.command, returnZoom.command],
    ['view.pan', 'view.pan', 'view.zoomIn', 'view.zoomOut']);
  assert.deepEqual(pan.params, {dx: 1, dy: 1});
  assert.deepEqual(returnPan.params, {dx: -1, dy: -1});
  assert.deepEqual(pan.expected, {cx: 92, cy: 116, zoom: 1});
  assert.deepEqual(zoom.expected, {cx: 72, cy: 96, zoom: 1.25});
  assert.deepEqual(returnPan.expected, {cx: 72, cy: 96, zoom: 1});
  assert.deepEqual(returnZoom.expected, returnPan.expected);
  assert.deepEqual(second.map(step => ({...step, sample: 1})), [pan, returnPan, zoom, returnZoom]);
});
