import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {makePlan,normalizeSnapshot} from './adapter.mjs';
import {withFigmaMCP} from './ld03-model.mjs';
import {publishCandidate} from '../publish-candidate.mjs';

const parse=async path=>JSON.parse(await readFile(path,'utf8'));
const save=(path,value)=>writeFile(path,JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});
const decode=response=>{
  assert.notEqual(response?.isError,true,response?.content?.[0]?.text);
  assert.equal(response.content?.length,1);
  return JSON.parse(response.content[0].text);
};
async function session(invoke,fileKey) {
  const response=await invoke({fileKey,description:'Synthetic LD01 empty-file dashboard creation benchmark'},'create_session');
  assert.notEqual(response.isError,true,'Figma rejected synthetic LD01 session');
  const text=response.content?.map(item=>item.text??'').join('\n')??'';
  let parsed;try{parsed=JSON.parse(text);}catch{}
  const id=response.structuredContent?.sessionId??response.structuredContent?.session_id??parsed?.sessionId??parsed?.session_id??
    text.match(/session(?:[_ ]id)?[`"* ]*[:=][`"* ]*([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})/i)?.[1];
  assert.match(id??'',/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i);
  return id;
}

export async function executeDashboard(fixture,assetsDir,scope,output,candidate,{connect=withFigmaMCP}={}) {
  assert.equal(fixture.workload,'LD01');
  assert.equal(scope.fixture_sha256,fixture.fixture_sha256);
  assert.equal(scope.synthetic_benchmark,true,'Explicit synthetic benchmark scope required');
  assert.ok(typeof scope.empty_page_id==='string'&&scope.empty_page_id.length,'Observed empty page identity required');
  assert.notEqual(scope.fileKey,'63YHvN658AM4ozSNGlM4hS','Occupied Atlas must not be used as an empty fixture');
  const plan=makePlan(fixture,scope.fileKey,null,assetsDir);
  const styleKeys=new Map(fixture.expected.styles.map(row=>[row.key.replaceAll('.','/'),row.key]));
  await mkdir(output,{recursive:true,mode:0o700});
  return connect(async invoke=>{
    const sessionId=await session(invoke,scope.fileKey);
    const call=async(name,request)=>{
      const response=await invoke({...request,fileKey:scope.fileKey,sessionId});
      await save(join(output,name+'-raw.json'),response);
      decode(response);
      return response;
    };
    const capture=async phase=>{
      const requests=plan.captures[phase];
      const raw={header:await call(phase+'-header',requests.header),nodes:[],images:[]};
      assert.equal(decode(raw.header).page_id,scope.empty_page_id,'Synthetic empty page identity changed');
      for(const kind of ['nodes','images'])for(const [index,request]of requests[kind].entries()) {
        raw[kind].push(await call(phase+'-'+kind+'-'+index,request));
      }
      const observed=normalizeSnapshot(raw,fixture.assets,styleKeys);
      assert.equal(observed.document_id,scope.fileKey);
      await save(join(output,phase+'-observed.json'),observed);
      return observed;
    };
    const before=await capture('before');
    assert.deepEqual(before.nodes,[],'LD01 requires an actual empty starting file');
    assert.deepEqual(before.styles,[],'LD01 requires an actual empty shared-style inventory');
    const created=decode(await call('create',plan.candidate));
    const observed=await capture('candidate');
    assert.deepEqual([...created.createdNodeIds].sort(),observed.nodes.map(row=>row.native_id).sort(),
      'Actual candidate readback differs from native creation receipt');
    assert.equal(new Set(created.createdNodeIds).size,fixture.expected.nodes.length);
    // Actual stored PNG byte proofs are checked by normalizeSnapshot; other phases remain absent.
    const evidence={before,candidate:observed};
    await publishCandidate(candidate,evidence);
    return evidence;
  },{createSession:true});
}

if(import.meta.url===pathToFileURL(process.argv[1]??'').href) {
  const [fixture,assets,scope,output,candidate]=process.argv.slice(2);
  assert.ok(fixture&&assets&&scope&&output&&candidate,
    'Usage: ld01-run.mjs FIXTURE ASSETS SYNTHETIC_EMPTY_SCOPE OUTPUT CANDIDATE');
  await executeDashboard(await parse(fixture),assets,await parse(scope),output,candidate);
}
