import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {makeCase} from './ld09.mjs';
import {prepareFixture} from './seed.mjs';

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.equal(process.argv.length, 4, 'Use seed-small.mjs LOOPBACK_ORIGIN NEW_PRIVATE_DIRECTORY');
  await prepareFixture(process.argv[2], process.argv[3], makeCase('small', 0));
}
