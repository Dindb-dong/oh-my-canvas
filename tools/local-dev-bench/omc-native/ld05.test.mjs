import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

import {mergeExtraCard, mergeStyles, sourceProbe} from './ld05.mjs';

const scriptDirectory = fileURLToPath(new URL('..', import.meta.url));
const env = {...process.env, PYTHONDONTWRITEBYTECODE:'1'};
const readJSON = (name,...args) => JSON.parse(execFileSync('python3',[join(scriptDirectory,name),...args],{env}));

test('all three browser/source cycles preserve the same card component and registered behavior', async t => {
  const parent = await mkdtemp(join(tmpdir(),'omc-ld05-source-offline-'));
  t.after(()=>rm(parent,{recursive:true,force:true}));
  for (const family of ['route-board','supply-ledger']) {
    const root = join(parent,family);
    const fixture = readJSON('ld05_contract.py',family);
    const command = (action,...args) => readJSON('ld05_source.py',action,family,root,...args);
    const initial = command('prepare');
    for (const [index, item] of fixture.cycles.entries()) {
      const cycle = index+1;
      const manifest = command('patch','--cycle',String(cycle));
      const before = await sourceProbe(root,fixture,manifest,cycle,item.source_state);
      assert.equal(before.states.length,3);
      const {result} = item;
      const values = cycle===1
        ? {gap:result.gap+'px',radius:result.radius+'px',heading_size:result.heading_size+'px'}
        : cycle===2 ? {accent:result.accent,wrap:'wrap',direction:'row',flex:'1 1 14rem'}
          : {variant_border:result.variant_border};
      const stylesheet = join(root,'theme.css');
      await writeFile(stylesheet,mergeStyles(await readFile(stylesheet,'utf8'),cycle,values));
      if (cycle===3) {
        const data = join(root,'data.mjs');
        await writeFile(data,mergeExtraCard(await readFile(data,'utf8'),result.variant,result.asset,result.copy));
      }
      const next = command('manifest');
      assert.notEqual(next.source_sha256,manifest.source_sha256);
      assert.equal(next.files['card.mjs'],initial.files['card.mjs']);
      const after = await sourceProbe(root,fixture,next,cycle,result);
      assert.deepEqual(after.states.map(state=>state.width),fixture.widths);
      if (cycle===3) {
        assert.ok(after.states.every(state=>state.conditional.keyboardHides && state.conditional.keyboardShows));
        assert.ok(after.states.every(state=>state.cards.at(-1).detail===result.copy));
      }
    }
  }
});
