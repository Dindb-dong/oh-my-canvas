import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {planResponsive,normalizeResponsive} from './ld04.mjs';
import {withFigmaMCP} from './ld03-model.mjs';
import {publishCandidate} from '../publish-candidate.mjs';

const parse=async path=>JSON.parse(await readFile(path,'utf8'));
const save=(path,value)=>writeFile(path,JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});
const decode=response=>{
  assert.notEqual(response?.isError,true,response?.content?.[0]?.text);
  return JSON.parse(response.content[0].text);
};
async function session(invoke,fileKey) {
  const response=await invoke({fileKey,description:'Synthetic LD04 responsive layout benchmark'},'create_session');
  assert.notEqual(response.isError,true,'Figma rejected synthetic LD04 session');
  const text=response.content?.map(item=>item.text??'').join('\n')??'';
  let parsed;try{parsed=JSON.parse(text);}catch{}
  const id=response.structuredContent?.sessionId??response.structuredContent?.session_id??parsed?.sessionId??parsed?.session_id??
    text.match(/session(?:[_ ]id)?[`"* ]*[:=][`"* ]*([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})/i)?.[1];
  assert.match(id??'',/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i);
  return id;
}

export async function executeResponsive(fixture,scope,output,candidate,{prepare=false,connect=withFigmaMCP}={}) {
  assert.equal(fixture.workload,'LD04');
  assert.equal(scope.fixture_sha256,fixture.fixture_sha256);
  assert.equal(scope.synthetic_benchmark,true,'Explicit synthetic benchmark scope required');
  assert.notEqual(scope.fileKey,'63YHvN658AM4ozSNGlM4hS','Occupied Atlas must not be used as a single-page fixture');
  const plan=planResponsive(fixture,scope.fileKey,null);
  await mkdir(output,{recursive:true,mode:0o700});
  return connect(async invoke=>{
    const sessionId=await session(invoke,scope.fileKey);
    const call=async(name,request)=>{
      const response=await invoke({...request,fileKey:scope.fileKey,sessionId});
      await save(join(output,name+'-raw.json'),response);
      decode(response);
      return response;
    };
    if(prepare)await call('seed',plan.original.seed);
    const before=normalizeResponsive(await call('before',plan.original.read));
    assert.equal(before.document_id,scope.fileKey);
    await save(join(output,'before.json'),before);
    if(prepare) {
      const prepared={...scope,before};
      await save(candidate,prepared);
      return prepared;
    }
    assert.deepEqual(before,scope.before,'Native baseline differs from independently prepared synthetic scope');
    await call('adapt',plan.original.adapt);
    const observed=normalizeResponsive(await call('candidate',plan.original.read));
    assert.equal(observed.document_id,scope.fileKey);
    assert.deepEqual(observed.nodes.map(row=>[row.key,row.native_id]),before.nodes.map(row=>[row.key,row.native_id]),
      'Responsive edit replaced native identities');
    await save(join(output,'candidate-observed.json'),observed);
    // Missing lifecycle/copy/width evidence remains absent for the unchanged full oracle.
    const evidence={before,candidate:observed};
    await publishCandidate(candidate,evidence);
    return evidence;
  },{createSession:true});
}

if(import.meta.url===pathToFileURL(process.argv[1]??'').href) {
  const [mode,fixturePath,scopePath,output,candidate]=process.argv.slice(2);
  assert.ok(['prepare','run'].includes(mode)&&fixturePath&&scopePath&&output&&candidate,
    'Usage: ld04-run.mjs prepare|run FIXTURE SYNTHETIC_SCOPE OUTPUT PREPARED_SCOPE|CANDIDATE');
  await executeResponsive(await parse(fixturePath),await parse(scopePath),output,candidate,{prepare:mode==='prepare'});
}
