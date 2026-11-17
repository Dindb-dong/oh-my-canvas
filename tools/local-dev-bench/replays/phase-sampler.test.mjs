import assert from 'node:assert/strict';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {openPhaseSampler} from './phase-sampler.mjs';

test('phase-sampler driver keeps ordered replies and surfaces a rejected phase', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'omc-phase-driver-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const mock = join(directory, 'driver.mjs');
  await writeFile(mock, `
    import {createInterface} from 'node:readline';
    for await (const line of createInterface({input: process.stdin})) {
      const request = JSON.parse(line);
      console.log(JSON.stringify(request.command === 'reject'
        ? {ok: false, error: 'invalid phase'} : {ok: true, state: request.command}));
    }
  `);
  const driver = await openPhaseSampler(directory, {python: process.execPath, program: mock});
  try {
    assert.equal((await driver.send({command: 'start', root_pids: [123]})).state, 'start');
    assert.equal((await driver.send({command: 'baseline'})).state, 'baseline');
    await assert.rejects(driver.send({command: 'reject'}), /invalid phase/);
  } finally {
    await driver.close();
  }
});
