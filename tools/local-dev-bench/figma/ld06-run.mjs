import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {withFigmaMCP} from './ld03-model.mjs';
import {publishCandidate} from '../publish-candidate.mjs';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const parse=async path=>JSON.parse(await readFile(path,'utf8'));
const save=(path,value)=>writeFile(path,JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});
const decode=response=>{assert.notEqual(response?.isError,true,'Official Figma operation failed');return JSON.parse(response.content[0].text);};
const seed=fileURLToPath(new URL('./plugin.mjs',import.meta.url));

export function uploadTargets(response,nodeIds) {
  const entries=response.uploads??response.uploadUrls??response.upload_urls;
  assert.ok(Array.isArray(entries)&&entries.length===nodeIds.length,'Unexpected official upload URL manifest');
  return entries.map((entry,index)=>{
    const url=typeof entry==='string'?entry:entry.submitUrl??entry.uploadUrl??entry.url??entry.upload_url;
    assert.ok(typeof url==='string'&&url.startsWith('https://'),'Missing official upload URL');
    if(entry.targetNodeId)assert.equal(entry.targetNodeId,nodeIds[index]);
    return url;
  });
}

export function normalizeAssetSnapshot(snapshot,fixture,stored) {
  const copy=structuredClone(snapshot),byKey=new Map(copy.nodes.map(row=>[row.key,row]));
  assert.equal(byKey.size,copy.nodes.length);
  const encloses=(outer,inner)=>outer&&inner&&inner[0]>=outer[0]-2&&inner[1]>=outer[1]-2&&
    inner[0]+inner[2]<=outer[0]+outer[2]+2&&inner[1]+inner[3]<=outer[1]+outer[3]+2;
  for(const row of copy.nodes) {
    if(row.kind==='text') {
      let current=row,visible=row.text_truncation==='DISABLED'&&encloses(row.bounds,row.render_bounds);
      while(current.parent&&visible) {current=byKey.get(current.parent);assert.ok(current);visible=encloses(current.bounds,row.render_bounds);}
      row.fully_visible=Boolean(visible);
      assert.equal(row.font_sha256,undefined,'Native font bytes must not be inferred from a fixture');
    }
    if(row.kind==='image') {
      const bytes=stored.get(row.image_hash);assert.ok(bytes,'Missing actual stored PNG bytes');
      const asset=fixture.assets.find(asset=>asset.media_type==='image/png'&&asset.sha256===hash(bytes));
      assert.ok(asset,'Stored native image differs from registered PNG bytes');
      row.asset_rgba_sha256=asset.rgba_sha256;row.stored_sha256=hash(bytes);
    }
  }
  return copy;
}

export async function executeAssets(planModule,fixture,assetsDir,scope,output,candidate,
  {connect=withFigmaMCP,post=fetch}={}) {
  assert.equal(fixture.workload,'LD06');assert.equal(scope.synthetic_benchmark,true);
  assert.equal(scope.fixture_sha256,fixture.fixture_sha256);
  assert.notEqual(scope.fileKey,'63YHvN658AM4ozSNGlM4hS','Occupied Atlas is not an LD06 fixture');
  assert.deepEqual(await parse(join(dirname(planModule),'fixture.json')),fixture,'Private native plan fixture differs');
  const planCommand=(...args)=>JSON.parse(execFileSync(process.execPath,[planModule,scope.fileKey,seed,...args],{maxBuffer:1024*1024}));
  const plan=planCommand(),bytesPrototype=planCommand('bytes','placeholder', '0','16384');
  const prefix=bytesPrototype.code.slice(0,bytesPrototype.code.lastIndexOf(')(figma, ')+9);
  const assets=new Map();
  for(const asset of fixture.assets) {const bytes=await readFile(join(assetsDir,asset.name));assert.equal(hash(bytes),asset.sha256);assets.set(asset.name,bytes);}
  await mkdir(output,{recursive:true,mode:0o700});
  await save(join(output,'source-byte-inputs.json'),[...assets].map(([name,bytes])=>({name,sha256:hash(bytes)})));
  return connect(async invoke=>{
    const response=await invoke({fileKey:scope.fileKey,description:'Synthetic LD06 local asset ingestion benchmark'},'create_session');
    assert.notEqual(response.isError,true);const text=response.content?.map(item=>item.text??'').join('\n')??'';
    let parsed;try{parsed=JSON.parse(text);}catch{}
    const sessionId=response.structuredContent?.sessionId??response.structuredContent?.session_id??parsed?.sessionId??parsed?.session_id??
      text.match(/session(?:[_ ]id)?[`"* ]*[:=][`"* ]*([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})/i)?.[1];
    assert.match(sessionId??'',/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i);
    const call=async(name,request)=>{
      assert.ok(typeof request.code==='string'&&request.code.length<=50_000,'Figma native payload exceeds supported size');
      const raw=await invoke({...request,fileKey:scope.fileKey,sessionId});await save(join(output,name+'.json'),raw);return decode(raw);
    };
    const inspect=async name=>{
      const value=await call(name,plan.inspect);assert.equal(value.document_id,scope.fileKey);
      if(scope.empty_page_id)assert.equal(value.page_id,scope.empty_page_id,'Synthetic page identity changed');
      return value;
    };
    const empty=await inspect('empty');assert.equal(empty.document_id,scope.fileKey);assert.equal(empty.nodes.length,0);assert.deepEqual(empty.styles,[]);
    await call('seed',plan.seed);const before=await inspect('before');
    await call('initialize',plan.initialize);const placeholders=await inspect('placeholders');
    const upload=async(name,rows)=>{
      const native=rows.map(row=>{const node=placeholders.nodes.find(node=>node.key===row.key);assert.ok(node);return node.native_id;});
      const raw=await invoke({fileKey:scope.fileKey,sessionId,currentPageId:empty.page_id,count:rows.length,nodeIds:native,scaleMode:'FILL'},'upload_assets');
      let manifest;try{manifest=decode(raw);}catch{throw new Error('Official upload response did not contain a valid JSON manifest');}
      const urls=uploadTargets(manifest,native);
      const results=await Promise.all(rows.map(async(row,index)=>{
        const asset=fixture.assets.find(asset=>asset.media_type==='image/png'&&asset.rgba_sha256===row.asset_rgba_sha256);assert.ok(asset);
        let reply;try{reply=await post(urls[index],{method:'POST',headers:{'Content-Type':'image/png'},body:assets.get(asset.name),redirect:'error'});}catch{throw new Error('Official asset POST failed for '+row.key);}
        assert.ok(reply.ok,'Official asset POST returned HTTP '+reply.status);
        const receipt=await reply.json();assert.equal(receipt.success,true);assert.ok(receipt.placedOnNodeId===native[index],'Official asset POST targeted another node');
        assert.match(receipt.imageHash??'',/^[a-zA-Z0-9_-]+$/);
        return {key:row.key,node_id:native[index],image_hash:receipt.imageHash,source_sha256:asset.sha256,size_bytes:receipt.sizeBytes};
      }));
      // Presigned URLs and untrusted response text never enter evidence or logs.
      await save(join(output,name+'-upload-receipts.json'),results);
    };
    const capture=async name=>{
      const observed=await inspect(name+'-native'),stored=new Map();
      await Promise.all([...new Set(observed.nodes.filter(row=>row.kind==='image').map(row=>row.image_hash))].map(async imageHash=>{
        let base64='',length;
        for(let offset=0;length===undefined||offset<length;offset+=16384) {
          const part=await call(name+'-bytes-'+imageHash+'-'+offset,{...bytesPrototype,
            code:prefix+JSON.stringify({fileKey:scope.fileKey,imageHash,offset,limit:16384})+');'});
          assert.equal(part.document_id,scope.fileKey);assert.equal(part.image_hash,imageHash);assert.equal(part.offset,offset);
          length??=part.length;assert.equal(part.length,length);assert.ok(length>0&&length<=15*1024*1024);
          assert.equal(part.b64.length,Math.min(16384,length-offset));base64+=part.b64;
        }
        const bytes=Buffer.from(base64,'base64');assert.equal(bytes.toString('base64'),base64);stored.set(imageHash,bytes);
      }));
      return normalizeAssetSnapshot(observed,fixture,stored);
    };
    const initialImages=fixture.loaded.nodes.filter(row=>row.kind==='image');
    await upload('initial',initialImages);const loaded=await capture('loaded');
    await call('text-update',plan.update);
    const replacements=fixture.expected.nodes.filter(row=>row.kind==='image'&&
      initialImages.find(initial=>initial.key===row.key)?.asset_rgba_sha256!==row.asset_rgba_sha256);
    await upload('replacement',replacements);const observed=await capture('candidate');
    assert.deepEqual(observed.nodes.map(row=>[row.key,row.native_id]),loaded.nodes.map(row=>[row.key,row.native_id]));
    const evidence={before,loaded,candidate:observed};await publishCandidate(candidate,evidence);return evidence;
  },{createSession:true,uploadAssets:true});
}

if(import.meta.url===pathToFileURL(process.argv[1]??'').href) {
  const [plan,fixture,assets,scope,output,candidate]=process.argv.slice(2);
  assert.ok(plan&&fixture&&assets&&scope&&output&&candidate,'Usage: ld06-run.mjs PLAN_MODULE FIXTURE ASSETS SYNTHETIC_EMPTY_SCOPE OUTPUT CANDIDATE');
  await executeAssets(plan,await parse(fixture),assets,await parse(scope),output,candidate);
}
