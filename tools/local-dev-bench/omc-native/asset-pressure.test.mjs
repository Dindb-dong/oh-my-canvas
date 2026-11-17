import assert from 'node:assert/strict';
import test from 'node:test';
import {makePressureFixture, pngPixels} from './asset-pressure.mjs';

test('N-G passes equal geometry and genuinely distinct pixel bytes to the two arms', () => {
  const shared = makePressureFixture('shared', 'small');
  const distinct = makePressureFixture('distinct', 'small');
  const rects = fixture => fixture.placements.map(({hash, ...rect}) => rect);
  assert.deepEqual(rects(shared), rects(distinct));
  assert.equal(shared.placements.length, 20);
  assert.equal(new Set(shared.placements.map(row => row.hash)).size, 1);
  assert.equal(new Set(distinct.placements.map(row => row.hash)).size, 20);
  assert.equal(shared.placements[0].hash, distinct.placements[0].hash);
  const pixelDigests = distinct.assets.map(asset => {
    const pixels = pngPixels(asset.bytes, distinct.width, distinct.height);
    assert.deepEqual([pixels.at(40, 30), pixels.at(120, 30), pixels.at(40, 95), pixels.at(120, 95)], asset.colors);
    return pixels.sha256;
  });
  assert.equal(new Set(pixelDigests).size, 20);
});

test('N-G generates the standard two million pixels and detects corrupted raster evidence', () => {
  const standard = makePressureFixture('shared');
  assert.equal(standard.width * standard.height, 2_000_000);
  const corrupt = Buffer.from(standard.assets[0].bytes);
  assert.deepEqual(pngPixels(corrupt, standard.width, standard.height).at(400, 300), standard.assets[0].colors[0]);
  corrupt[42] ^= 1;
  assert.throws(() => pngPixels(corrupt, standard.width, standard.height));
});
