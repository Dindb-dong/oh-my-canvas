import assert from 'node:assert/strict';
import test from 'node:test';

import {authoredDocument, plan, verifyCatalog} from './startup.mjs';

test('N-F varies saved count, document size, and target size independently', () => {
  for (const count of [0, 15, 100]) {
    const fixture = plan(count, 1000, 100);
    assert.equal(new Set(fixture.saved.map(doc => doc.title)).size, count);
    assert.ok(fixture.saved.every(doc => doc.nodes === 1000 && doc.title !== fixture.target.title));
    assert.equal(fixture.target.nodes, 100);
  }
  assert.throws(() => plan(16, 100, 100));
  const doc = authoredDocument(plan(0, 100, 100).target);
  assert.equal(Object.values(doc.nodes).filter(node => node.properties.figThumbnail === true).length, 1);
  assert.equal(doc.nodes[doc.pages[0].rootNodeId].properties.figThumbnail, true);
});

test('N-F preserves real library identity and its supported thumbnail cap', () => {
  const titles = plan(100, 100, 100).saved.map(doc => doc.title);
  const rows = titles.map((title, index) => ({title, id: 'doc-' + index}));
  assert.deepEqual(verifyCatalog(rows, titles, false), {count: 100, thumbnails: 0});
  const withThumbnails = rows.map((row, index) => index < 15 ? {...row, thumbnail: 'iVBORw0KGgo='} : row);
  assert.deepEqual(verifyCatalog(withThumbnails, titles, true), {count: 100, thumbnails: 15});
  assert.throws(() => verifyCatalog(rows, titles, true));
  assert.throws(() => verifyCatalog([{...rows[0], thumbnail: 'bm90LXBuZw=='}, ...withThumbnails.slice(1)], titles, true));
});
