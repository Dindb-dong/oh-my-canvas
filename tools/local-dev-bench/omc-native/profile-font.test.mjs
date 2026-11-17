import assert from 'node:assert/strict';
import test from 'node:test';
import {inkShape, planFontFixture} from './profile-font.mjs';

const hash = '194018e6b2b293a7964f037b25c0249ce1418bc9ab3c971060a03aa57861e252';
const blue = [26, 96, 161, 255];
const clear = [0, 0, 0, 0];

test('font probes cover the registered loaded and replacement phrases', () => {
  const initial = [
    'A Aa', 'A Ab', 'A Ba', 'A Bb', 'B Aa', 'B Ab', 'B Ba', 'B Bb',
    '가 가', '가 나', '나 가', '나 나',
  ].map(text => ({text, font_sha256: hash}));
  const replacement = {...initial[0], text: 'B B'};
  const spec = {
    workload: 'LD06',
    font: {family: 'Noto Sans KR', sha256: hash, registered_glyphs: ['A', 'B', 'a', 'b', '가', '나']},
    loaded: {nodes: initial},
    expected: {nodes: [replacement, ...initial.slice(1)]},
  };
  const probes = planFontFixture(spec);
  assert.equal(probes.filter(row => row.kind === 'phrase').length, 13);
  assert.ok(probes.some(row => row.text === replacement.text));
  assert.deepEqual(probes.filter(row => row.kind !== 'phrase').map(row => row.text), ['A', 'B', '가', '나']);
  replacement.text = '다';
  assert.throws(() => planFontFixture(spec));
});

test('ink check rejects empty renders and distinguishes normalized shapes', () => {
  const rectangle = (left, top) => ({
    at(x, y) {
      return x >= left && x < left + 3 && y >= top && y < top + 4 ? blue : clear;
    },
  });
  const first = inkShape(rectangle(1, 2), 10, 12);
  assert.deepEqual(first.inkBounds, [1, 2, 3, 4]);
  assert.equal(first.inkPixels, 12);
  assert.equal(inkShape(rectangle(3, 6), 10, 12).inkShapeSha256, first.inkShapeSha256);
  const changed = {at: (x, y) => x === 1 && y === 2 ? clear : rectangle(1, 2).at(x, y)};
  assert.notEqual(inkShape(changed, 10, 12).inkShapeSha256, first.inkShapeSha256);
  assert.throws(() => inkShape({at: () => clear}, 10, 12), /No visible foreground text ink/);
});
