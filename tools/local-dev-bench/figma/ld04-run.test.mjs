import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {executeResponsive} from './ld04-run.mjs';

const fixture=(()=>{
  const root=mkdtempSync(join(tmpdir(),'figma-ld04-fixture-test-'));
  try {
    const registration=join(root,'width.json');
    writeFileSync(registration,JSON.stringify({width:1001,nonce:'test-only-private-width'}));
    return JSON.parse(execFileSync('python3',['-B',fileURLToPath(new URL('../workloads/synthetic.py',import.meta.url)),
      'fixture','LD04','--variant','street-market','--registration',registration]));
  } finally {rmSync(root,{recursive:true,force:true});}
})();
const wrap=value=>({content:[{type:'text',text:JSON.stringify(value)}]});
const before={document_id:'synthetic-single-page',page_id:'1:1',styles:[],nodes:[
  {key:'canvas',native_id:'1:2',kind:'frame',parent:null,bounds:[0,0,1200,500],gap:0},
]};
const after={...before,nodes:before.nodes.map(row=>({...row,gap:20}))};
const scope={fileKey:before.document_id,fixture_sha256:fixture.fixture_sha256,synthetic_benchmark:true,before};

test('LD04 publishes only fresh observed native states and keeps missing full-oracle evidence absent',async()=>{
  const output=await mkdtemp(join(tmpdir(),'figma-ld04-run-test-'));
  let calls=0,adapted=false;
  const connect=async run=>run(async(args,tool)=>{
    calls++;
    if(tool==='create_session')return wrap({sessionId:'5bd636ba-7048-4fad-a896-46207a0bac92'});
    assert.equal(args.fileKey,scope.fileKey);
    if(args.description.startsWith('Enable native')) {adapted=true;return wrap({document_id:scope.fileKey});}
    return wrap(adapted?after:before);
  });
  try {
    const path=join(output,'candidate.json');
    const evidence=await executeResponsive(fixture,scope,output,path,{connect});
    assert.equal(calls,4);assert.equal(adapted,true);
    assert.deepEqual(evidence,{before,candidate:after});
    assert.deepEqual(JSON.parse(await readFile(path,'utf8')),evidence);
    assert.equal(evidence.reopened,undefined);assert.equal(evidence.responsive_steps,undefined);
  } finally {await rm(output,{recursive:true,force:true});}
});

test('LD04 refuses changed baseline and occupied Atlas before any edit',async()=>{
  const output=await mkdtemp(join(tmpdir(),'figma-ld04-guard-test-'));
  let writes=0;
  const connect=async run=>run(async(args,tool)=>{
    if(tool==='create_session')return wrap({sessionId:'5bd636ba-7048-4fad-a896-46207a0bac92'});
    if(args.description.startsWith('Enable native'))writes++;
    return wrap(after);
  });
  try {
    await assert.rejects(executeResponsive(fixture,scope,output,join(output,'candidate.json'),{connect}),/baseline differs/);
    assert.equal(writes,0);
    await assert.rejects(executeResponsive(fixture,{...scope,fileKey:'63YHvN658AM4ozSNGlM4hS'},output,
      join(output,'candidate.json'),{connect}),/Occupied Atlas/);
    await assert.rejects(executeResponsive(fixture,{...scope,synthetic_benchmark:false},output,
      join(output,'candidate.json'),{connect}),/synthetic benchmark/);
  } finally {await rm(output,{recursive:true,force:true});}
});
