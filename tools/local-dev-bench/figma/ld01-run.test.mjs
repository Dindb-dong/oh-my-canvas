import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {executeDashboard} from './ld01-run.mjs';

const synth=fileURLToPath(new URL('../workloads/synthetic.py',import.meta.url));
const wrap=value=>({content:[{type:'text',text:JSON.stringify(value)}]});

for(const family of ['harbor-ops','reading-room'])test(`LD01 ${family} captures complete actual asset bytes and omits unobserved lifecycle`,async()=>{
  const output=await mkdtemp(join(tmpdir(),'figma-ld01-run-test-'));
  try {
    const assets=join(output,'assets');
    const fixture=JSON.parse(execFileSync('python3',['-B',synth,'fixture','LD01','--variant',family,'--assets-dir',assets]));
    const scope={synthetic_benchmark:true,fileKey:'synthetic-empty-file',fixture_sha256:fixture.fixture_sha256,empty_page_id:'native-page'};
    const images=new Map(await Promise.all(fixture.assets.map(async asset=>[asset.rgba_sha256,await readFile(join(assets,asset.name))])));
    const rows=fixture.expected.nodes.map((row,index)=>{
      const result={...row,native_id:'native-'+index};
      if(row.kind==='image') {
        result.image_hash=createHash('sha256').update(images.get(row.asset_rgba_sha256)).digest('hex');
        delete result.asset_rgba_sha256;
      }
      return result;
    });
    let created=false,writes=0,tamper=false;
    const connect=async run=>run(async(request,tool)=>{
      if(tool==='create_session')return wrap({sessionId:'5bd636ba-7048-4fad-a896-46207a0bac92'});
      assert.equal(request.fileKey,scope.fileKey);
      if(request.description.startsWith('Create named editable')) {
        assert.equal(created,false);created=true;writes++;
        return wrap({createdNodeIds:rows.map(row=>row.native_id),createdVariableIds:[]});
      }
      const input=JSON.parse(request.code.slice(request.code.lastIndexOf(')(figma, ')+9,-2));
      const common={document_id:scope.fileKey,page_id:'native-page'};
      if(input.styles)return wrap({...common,node_count:created?rows.length:0,styles:[]});
      if(input.image) {
        const spec=fixture.expected.nodes.find(row=>row.key===input.image);
        const row=rows.find(row=>row.key===input.image);
        const bytes=Buffer.from(images.get(spec.asset_rgba_sha256));if(tamper)bytes[0]^=1;
        const base64=bytes.toString('base64');
        return wrap({...common,native_id:row.native_id,key:row.key,hash:row.image_hash,
          offset:input.offset,length:base64.length,base64:base64.slice(input.offset,input.offset+input.limit)});
      }
      return wrap({...common,offset:input.offset,nodes:rows.slice(input.offset,input.offset+input.limit)});
    });
    const evidence=await executeDashboard(fixture,assets,scope,join(output,'good'),join(output,'candidate.json'),{connect});
    assert.equal(writes,1);assert.equal(evidence.candidate.nodes.length,fixture.expected.nodes.length);
    assert.deepEqual(evidence.before.nodes,[]);assert.equal(evidence.reopened,undefined);assert.equal(evidence.probe,undefined);
    for(const image of fixture.expected.nodes.filter(row=>row.kind==='image')) {
      assert.equal(evidence.candidate.nodes.find(row=>row.key===image.key).asset_rgba_sha256,image.asset_rgba_sha256);
    }
    created=false;tamper=true;
    await assert.rejects(executeDashboard(fixture,assets,scope,join(output,'bad'),join(output,'tampered.json'),{connect}),/Stored image bytes/);
    assert.equal(writes,2);
    // A nonempty header is rejected before another native creation call.
    created=true;
    await assert.rejects(executeDashboard(fixture,assets,scope,join(output,'occupied'),join(output,'occupied.json'),{connect}),/Missing Figma layer captures/);
    assert.equal(writes,2);
    await assert.rejects(executeDashboard(fixture,assets,{...scope,empty_page_id:'other-page'},join(output,'wrong-page'),
      join(output,'wrong-page.json'),{connect}),/page identity changed/);
    assert.equal(writes,2);
  } finally {await rm(output,{recursive:true,force:true});}
});
