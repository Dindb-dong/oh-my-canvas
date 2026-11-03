import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {writeDistributionLicenses,collectDependencyEvidence} from '../scripts/license-inventory.mjs';

test('distribution includes intact Electron/Chromium notices and all locked npm runtime notice texts',async()=>{
  const temporary=await mkdtemp(path.join(os.tmpdir(),'omc-license-test-'));
  try{
    await writeDistributionLicenses(temporary);
    for(const file of ['LICENSE','LICENSES.chromium.html']){
      assert.deepEqual(await readFile(path.join(temporary,`electron-${file}`)),await readFile(`node_modules/electron/dist/${file}`));
    }
    const {evidence,text}=await collectDependencyEvidence();
    assert.equal(await readFile(path.join(temporary,'npm-runtime.txt'),'utf8'),text);
    for(const item of evidence.packages.filter(x=>!x.developmentOnly)){
      assert.ok(item.licenseFiles.length,`${item.location} has no license evidence`);
      for(const file of item.licenseFiles)assert.ok(text.includes(`${item.name}@${item.version} — ${item.location}/${file.file}`));
    }
  }finally{await rm(temporary,{recursive:true,force:true});}
});
