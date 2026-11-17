import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import test from 'node:test';

import {createPaperLd03ModelHandlers} from './ld03-model.mjs';

const fixture = JSON.parse(execFileSync('python3', [
  'tools/local-dev-bench/workloads/synthetic.py','fixture','LD03','--variant','field-relay',
],{env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}}));
const prefix = 'omc-ld03-field-relay-cap-01';
const originalScope = {fileId:'mock-approved-original'};
const scope = {fileId:'mock-approved-copy',fileName:'OMC Benchmark LD03 verification / ld03-copy-cap-01',
  prefix,pageId:'p-copy-17',boardId:'L-copy-board',
  nodes:Object.fromEntries(fixture.start.nodes.map((row,index)=>[row.key,index===0?'L-copy-board':`L-${index}`]))};
const cloneReceipt = {status:'copied-background-readable',copy:{fileId:scope.fileId,name:scope.fileName},
  candidatePage:{id:scope.pageId,name:'LD03 preflight / field-relay-cap-01'}};
const start = {target:{accent:'#2864dc',spacing_px:12},archive:{accent:'#2864dc',spacing_px:12}};
const requested = {accent:'#136b62',spacing_px:20};
const tokens = fixture.start.styles.map(row=>{
  const type=row.kind==='color'?'color':'spacing';
  const name=`--${type}-${prefix}-${row.key.replace('.','-')}`;
  return {name,type,value:type==='color'?row.value.toUpperCase():`${row.value}px`};
});
const baseline = {document_id:scope.fileId,style_identity:'paper-file-scoped-custom-property-name',
  raster_sha256:'a'.repeat(64),nodes:Object.entries(scope.nodes).map(([key,native_id])=>({key,native_id})),
  styles:fixture.start.styles.map((row,index)=>({...row,native_id:JSON.stringify([scope.fileId,tokens[index].name])}))};

function registered({partial = false, drift = false, duplicate = false, wrongBoard = false} = {}) {
  const current=structuredClone(tokens);
  const actions=[];
  const audit=[];
  if (drift) current[0].value='#843f80';
  if (duplicate) current.push({...current[0],value:'#ffffff'});
  async function read({name,arguments:args}) {
    assert.equal(args.fileId,scope.fileId);
    actions.push({name,args});
    if (name==='get_basic_info') return {fileName:scope.fileName,
      pages:[cloneReceipt.candidatePage],artboards:[{id:wrongBoard?'wrong':scope.boardId,name:'Field relay roster'}]};
    if (name==='get_tokens') return {tokens:current.filter(row=>args.types.includes(row.type))};
    if (name==='set_tokens') {
      assert.equal(args.tokens.length,2);
      for(const [index,entry] of args.tokens.entries()) {
        assert.equal(entry.name,tokens[index].name);
        current.find(row=>row.name===entry.name).value=entry.value;
        if (partial && index===0) throw Error('not acknowledged');
      }
      return {tokens:args.tokens.map(row=>({name:row.name,result:'updated'}))};
    }
    throw Error(`Unexpected native action ${name}`);
  }
  const setup={scope,originalScope,cloneReceipt,baseline,fixture,connect:task=>task(read),audit:event=>audit.push(event)};
  return {setup,handlers:createPaperLd03ModelHandlers(setup),actions,audit};
}

test('records only two scoped target writes and returns compact common values', async () => {
  const {handlers,actions}=registered();
  assert.deepEqual(await handlers.inspect(),start);
  const first=await handlers.apply({...requested,accent:'#136B62'});
  assert.deepEqual(first,{target:requested,archive:start.archive});
  assert.deepEqual(await handlers.inspect(),first);
  const second=await handlers.apply({accent:'#843f80',spacing_px:24});
  assert.deepEqual(second,{target:{accent:'#843f80',spacing_px:24},archive:start.archive});
  const writes=actions.filter(row=>row.name==='set_tokens');
  assert.equal(writes.length,2);
  assert.deepEqual(writes[0].args.tokens,[
    {name:tokens[0].name,value:'#136b62'},{name:tokens[1].name,value:'20px'},
  ]);
  assert.ok(!JSON.stringify(first).includes('mock-approved-copy'));
});

test('rejects wrong scope, duplicate tokens and changed initial values without mutation', async () => {
  for (const options of [{drift:true},{duplicate:true},{wrongBoard:true}]) {
    const {handlers,actions}=registered(options);
    await assert.rejects(handlers.apply(requested),/did not match the approved target/);
    assert.ok(!actions.some(row=>row.name==='set_tokens'));
    await assert.rejects(handlers.inspect(),/paused/);
  }
  const {setup}=registered();
  assert.throws(()=>createPaperLd03ModelHandlers({...setup,originalScope:{fileId:scope.fileId}}));
});

test('reconciles an ambiguous partial binding update without retrying', async () => {
  const {handlers,actions,audit}=registered({partial:true});
  await assert.rejects(handlers.apply(requested),/Further writes are disabled/);
  assert.equal(actions.filter(row=>row.name==='set_tokens').length,1);
  assert.deepEqual(audit.at(-1),{action:'reconcile-set-tokens',
    observed:{target:{accent:requested.accent,spacing_px:12},archive:start.archive},
    targetMatchesRequest:false,archiveUnchanged:true});
  await assert.rejects(handlers.apply(requested),/paused/);
  assert.equal(actions.filter(row=>row.name==='set_tokens').length,1);
});

test('validates model inputs before selecting any product scope', async ()=>{
  const {handlers,actions}=registered();
  for (const bad of [{...requested,fileId:'other'},{...requested,spacing_px:129},
    {...requested,spacing_px:2.5},{...requested,accent:'var(--target)'},{}]){
    await assert.rejects(handlers.apply(bad),/Invalid Paper shared value inputs/);
  }
  assert.deepEqual(actions,[]);
});
