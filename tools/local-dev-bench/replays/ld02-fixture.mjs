import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

export const target = {
  page: 'Wednesday afternoon',
  card: 'Returns · North Harbor',
  before: {text: 'Awaiting pickup', reference: 'Route 13', gap: 12, fill: '#2864dc'},
  after: {text: 'Ready for pickup', gap: 20, fill: '#336699'},
};

const pages = Array.from({length: 10}, (_, batch) => ({
  name: batch === 7 ? target.page : `Returns batch ${String(batch + 1).padStart(2, '0')}`,
  children: Array.from({length: 25}, (_, slot) => {
    const key = `returns-${String(batch).padStart(2, '0')}-${String(slot).padStart(2, '0')}`;
    const location = slot === 12 ? 'North Harbor' : `North Harbor ${slot + 1}`;
    return {
      key,
      type: 'frame',
      name: `Returns · ${location}`,
      layout: 'vertical',
      gap: target.before.gap,
      padding: 16,
      x: (slot % 5) * 256,
      y: Math.floor(slot / 5) * 168,
      width: 224,
      height: 144,
      children: [
        {key: `${key}/label`, type: 'text', text: target.before.text},
        {key: `${key}/reference`, type: 'text', text: `Route ${String(slot + 1).padStart(2, '0')}`},
        {key: `${key}/swatch`, type: 'rectangle', width: 64, height: 32, fill: target.before.fill},
      ],
    };
  }),
}));

export const fixture = {workload: 'LD02-pilot-01', logicalObjects: 1_000, pages};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const cards = pages.flatMap(page => page.children);
  assert.equal(cards.length + cards.flatMap(card => card.children).length, fixture.logicalObjects);
  assert.equal(pages.find(page => page.name === target.page).children.filter(card => card.name === target.card).length, 1);
  console.log(JSON.stringify(fixture));
}
