import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {mkdir,mkdtemp,readFile,rename,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {assetToolDocumentId,pngPixels} from './asset-pressure.mjs';
import {inkShape,startService} from './profile-font.mjs';
import {publishCandidate} from '../publish-candidate.mjs';

const marker='LD06 ';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');

export async function verifyInputs(fixture,directory) {
  assert.equal(fixture.workload,'LD06');
  assert.equal(fixture.font_registered,true);
  assert.equal(fixture.font.license,'OFL-1.1');
  const assets=new Map();
  for(const meta of fixture.assets) {
    assert.match(meta.name,/^[a-z0-9-]+\.(png|json|ttf)$/);
    const bytes=await readFile(join(directory,meta.name));
    assert.equal(sha(bytes),meta.sha256,'Changed source '+meta.name);
    if(meta.name.endsWith('.png')) assert.equal(pngPixels(bytes,meta.width,meta.height).sha256,meta.rgba_sha256);
    assets.set(meta.name,{meta,bytes});
  }
  const content=JSON.parse(assets.get('content.json').bytes);
  return {assets,content};
}

export function planAssets(fixture,content,assets) {
  const rows=fixture.loaded.nodes, originals=new Set(fixture.start.nodes.map(row=>row.key));
  const ids=new Map(rows.map((row,i)=>[row.key,'node_'+(i+1).toString(16).padStart(32,'0')]));
  const byKey=new Map(rows.map(row=>[row.key,row]));
  const ranks=new Map();
  const nodes=rows.map(row=>{
    const [x,y,width,height]=row.bounds,parent=byKey.get(row.parent);
    const properties={name:marker+row.key,x:x-(parent?.bounds[0]??0),y:y-(parent?.bounds[1]??0),width,height,
      fill:row.kind==='text'?'#1a60a1':'#ffffff'};
    if(row.kind==='text') Object.assign(properties,{text:row.text,fontFamily:fixture.font.family,fontSize:row.key==='header'?26:16,lineHeight:height+'px'});
    if(row.kind==='image') {
      const slot=Number(row.key.split('/')[1]),asset=assets.get(`initial-image-${slot+1}.png`);
      assert.equal(asset.meta.rgba_sha256,row.asset_rgba_sha256);
      Object.assign(properties,{assetHash:asset.meta.sha256,imageFit:'cover'});
    }
    const rank=(ranks.get(row.parent)??0)+1; ranks.set(row.parent,rank);
    return {key:row.key,id:ids.get(row.key),parentId:ids.get(row.parent),kind:row.kind,
      rank:rank.toString(16).padStart(8,'0')+'0'.repeat(24),properties};
  });
  for(const item of content.initial) for(const role of ['name','caption']) {
    assert.equal(byKey.get(`card/${item.slot}/${role}`).text,item[role]);
  }
  const expected=new Map(fixture.expected.nodes.map(row=>[row.key,row]));
  const changes=content.updates.flatMap(item=>{
    const base=`card/${item.slot}`,asset=assets.get(`replacement-image-${item.slot+1}.png`);
    assert.equal(asset.meta.rgba_sha256,expected.get(base+'/image').asset_rgba_sha256);
    for(const role of ['name','caption']) assert.equal(item[role],expected.get(base+'/'+role).text);
    return [{type:'node.set',nodeId:ids.get(base+'/image'),properties:{assetHash:asset.meta.sha256}},
      ...['name','caption'].map(role=>({type:'text.replace',nodeId:ids.get(base+'/'+role),text:item[role]}))];
  });
  return {nodes,before:nodes.filter(row=>originals.has(row.key)),loaded:nodes.filter(row=>!originals.has(row.key)),changes};
}

export function coverCrop(sourceWidth,sourceHeight,width,height) {
  assert.ok([sourceWidth,sourceHeight,width,height].every(v=>Number.isFinite(v)&&v>0));
  if(sourceWidth/sourceHeight>width/height) {
    const cropWidth=sourceHeight*width/height;
    return [(sourceWidth-cropWidth)/2,0,cropWidth,sourceHeight];
  }
  const cropHeight=sourceWidth*height/width;
  return [0,(sourceHeight-cropHeight)/2,sourceWidth,cropHeight];
}

export function normalizeAssets(raw,scene,images,font) {
  assert.equal(raw.pages.length,1); assert.equal(scene.truncated,false);
  assert.equal(String(scene.revision),String(raw.sequence));
  const root=raw.pages[0].rootNodeId,aliases=new Map(scene.nodes.map(row=>[row.id,row.rawId]));
  const diagnostics=new Map(scene.diagnostics.map(row=>[aliases.get(row.id),row]));
  const layers=Object.values(raw.nodes).filter(row=>row.id!==root);
  const keys=new Map(layers.map(node=>{
    assert.ok(node.properties.name.startsWith(marker)); return [node.id,node.properties.name.slice(marker.length)];
  }));
  const nodes=layers.map(node=>{
    const p=node.properties,d=diagnostics.get(node.id),b=d?.bounds;
    assert.ok(b,'Missing computed native bounds');
    const row={key:keys.get(node.id),native_id:node.id,kind:node.kind,parent:node.parentId===root?null:keys.get(node.parentId),
      bounds:[b.x,b.y,b.width,b.height],editable:true};
    let current=node,visible=d.clippedText===false;
    while(current.id!==root) {
      const props=current.properties;
      row.editable&&=props.locked!==true&&props.hidden!==true&&props.visible!==false;
      visible&&=diagnostics.get(current.id)?.overflowParent===false&&props.hidden!==true&&props.visible!==false;
      current=raw.nodes[current.parentId]; assert.ok(current);
    }
    if(node.kind==='text') Object.assign(row,{text:p.text,font_family:p.fontFamily,
      font_sha256:font?.family===p.fontFamily?font.sha256:null,fully_visible:visible});
    if(node.kind==='image') {
      const image=images.get(p.assetHash); assert.ok(image,'Missing stored image byte proof');
      row.asset_rgba_sha256=image.rgba_sha256;
      // Match the observed native cover mode; never take crop coordinates from the fixture.
      const fit=p.style?.['object-fit']??p.imageFit??'cover';
      row.crop_source_px=fit==='cover'&&!p.imageCrop?coverCrop(image.width,image.height,b.width,b.height):null;
    }
    return row;
  });
  return {document_id:raw.id,nodes,styles:[]};
}

export function glyphScreenshotId(view,raw,key) {
  assert.equal(view.id,assetToolDocumentId(raw.id));
  assert.equal(String(view.revision),String(raw.sequence));
  assert.equal(view.truncated,false);
  const matches=[];
  const visit=node=>{
    if(node.name===marker+key) matches.push(node);
    for(const child of node.children??[]) visit(child);
  };
  for(const node of view.layers) visit(node);
  assert.equal(matches.length,1,'Expected one scoped glyph layer');
  const [layer]=matches;
  const native=Object.values(raw.nodes).find(node=>node.properties.name===marker+key);
  assert.equal(native?.kind,'text');
  assert.equal(layer.type,'TEXT');
  assert.equal(layer.characters,native.properties.text);
  // FigCraft's numeric aliases are separate from get_tree's string aliases (n1, n2, ...).
  assert.ok(Number.isSafeInteger(layer.id)&&layer.id>0,'Screenshot requires a native numeric alias');
  return layer.id;
}

async function execute(fixture,inputs,save,report,profile,signal) {
  const {assets,content}=inputs,plan=planAssets(fixture,content,assets),font=assets.get(fixture.font.name);
  const fontStore=join(profile,'native-v1','font-store'),stage=join(fontStore,'.ld06-stage');
  await mkdir(stage,{recursive:true,mode:0o700});
  await writeFile(join(stage,'0.ttf'),font.bytes,{flag:'wx',mode:0o600});
  await rename(stage,join(fontStore,font.meta.sha256));
  const fontPath=join(fontStore,font.meta.sha256,'0.ttf');
  const binary=join(process.env.OMC_BENCH_BIN_DIR??'/Applications/Oh My Canvas.app/Contents/MacOS','omc-service');
  report.binarySha256=sha(await readFile(binary));
  let service=await startService(binary,profile,signal);
  const rpc=(...args)=>service.rpc(...args),snapshot=documentId=>rpc('document.snapshot',{documentId});
  async function command(raw,body) {
    const requestId=randomUUID();
    const receipt=await rpc('document.command',{envelope:{protocol:'omc.engine/1',requestId,idempotencyKey:requestId,
      documentId:raw.id,targetEpoch:raw.epoch,preconditions:{revision:{epoch:raw.epoch,sequence:raw.sequence}},command:body}});
    assert.equal(receipt.status,'durable'); return receipt;
  }
  async function capture(label,documentId) {
    await rpc('workspace.open',{documentId});
    const raw=await snapshot(documentId);
    const scene=await rpc('tool.call',{name:'get_tree',arguments:{documentId:assetToolDocumentId(documentId),depth:6,detail:'detailed'}});
    await save(label+'-native.json',{raw,scene});
    const images=new Map();
    for(const node of Object.values(raw.nodes).filter(node=>node.kind==='image')) {
      const hash=node.properties.assetHash;
      const registered=[...assets.values()].find(asset=>asset.meta.sha256===hash); assert.ok(registered);
      const stored=await readFile(join(profile,'native-v1','assets','sha256',hash.slice(0,2),hash));
      assert.equal(sha(stored),hash); assert.deepEqual(stored,registered.bytes);
      const {width,height}=registered.meta,pixels=pngPixels(stored,width,height);
      images.set(hash,{width,height,rgba_sha256:pixels.sha256});
    }
    const storedFontSha256=sha(await readFile(fontPath)); assert.equal(storedFontSha256,font.meta.sha256);
    const families=await service.run('text.fonts'),missing=await service.run('text.missingFonts');
    const registered=families.includes(font.meta.family)&&!missing.families.some(row=>row.family===font.meta.family);
    report.fontReadbacks.push({phase:label,storedFontSha256,registered,missing});
    const observed=normalizeAssets(raw,scene,images,registered?font.meta:null);
    if(label!=='before') {
      try {
        const image=await rpc('document.export',{documentId,pageId:raw.pages[0].id,format:'png',
          bounds:{x:0,y:0,width:fixture.viewport.width,height:fixture.viewport.height}});
        assert.deepEqual(image.revision,{epoch:raw.epoch,sequence:raw.sequence});
        const bytes=Buffer.from(image.contentBase64,'base64');
        pngPixels(bytes,fixture.viewport.width,fixture.viewport.height);
        await save(label+'.png',bytes);
        report.rasters[label]={sha256:sha(bytes),diagnostics:image.diagnostics};
      } catch(error) { report.rasters[label]={error:error.message}; }
      // Two actual text rasters diagnose Latin/Hangul ink. They do not certify every registered glyph.
      report.glyphDiagnostics[label]=[];
      let glyphView,glyphViewError;
      try {
        glyphView=await service.call('inspect_document',{depth:6});
        await save(label+'-glyph-tree.json',glyphView);
      } catch(error) { glyphViewError=error; }
      for(const key of ['card/0/name','card/0/caption']) {
        try {
          if(glyphViewError) throw glyphViewError;
          const node=Object.values(raw.nodes).find(node=>node.properties.name===marker+key);
          const alias=glyphScreenshotId(glyphView,raw,key);
          const image=await service.call('screenshot',{ids:[alias],scale:1});
          const bytes=Buffer.from(image.base64,'base64'),width=bytes.readUInt32BE(16),height=bytes.readUInt32BE(20);
          const pixels=pngPixels(bytes,width,height),artifact=label+'-'+key.replaceAll('/','-')+'.png';
          await save(artifact,bytes);
          report.glyphDiagnostics[label].push({key,text:node.properties.text,artifact,sha256:sha(bytes),...inkShape(pixels,width,height)});
        } catch(error) { report.glyphDiagnostics[label].push({key,error:error.message}); }
      }
    }
    return observed;
  }
  try {
    const original=(await rpc('workspace.create',{title:'Synthetic LD06 '+fixture.source_family_id})).id;
    const raw=await snapshot(original),root=raw.nodes[raw.pages[0].rootNodeId];
    const native=rows=>rows.map(({key,...node})=>({...node,parentId:node.parentId??root.id,homeShard:root.homeShard}));
    await command(raw,{type:'node.createMany',nodes:native(plan.before)});
    report.before=await capture('before',original);
    for(const asset of assets.values()) if(asset.meta.name.endsWith('.png')) {
      const added=await rpc('tool.call',{name:'document_assets',arguments:{action:'add',documentId:assetToolDocumentId(original),
        kind:'image',name:asset.meta.name,dataUrl:'data:image/png;base64,'+asset.bytes.toString('base64')}});
      assert.equal(added.receipt.status,'durable'); assert.equal(added.asset.hash,asset.meta.sha256);
    }
    await command(await snapshot(original),{type:'node.createMany',nodes:native(plan.loaded)});
    await rpc('document.save',{documentId:original}); report.loaded=await capture('loaded',original);
    await command(await snapshot(original),{type:'batch',commands:plan.changes});
    await rpc('document.save',{documentId:original}); report.candidate=await capture('candidate',original);
    try {
      const exported=await rpc('document.export',{documentId:original,format:'html'});
      const bytes=Buffer.from(exported.contentBase64,'base64'); await save('candidate.html',bytes);
      report.sourceExport={sha256:sha(bytes),diagnostics:exported.diagnostics,cleanCheckoutBuildsObserved:0};
    } catch(error) { report.sourceExport={error:error.message,cleanCheckoutBuildsObserved:0}; }
    await service.stop(); assert.equal(service.child.exitCode,0);
    service=await startService(binary,profile,signal);
    report.reopened=await capture('reopened',original);
    report.status='awaiting-canonical-grade';
    if(process.env.OMC_BENCH_CANDIDATE) await publishCandidate(process.env.OMC_BENCH_CANDIDATE,report);
  } finally { await service.stop(); }
}

async function main() {
  const [fixturePath,assetDirectory,output,...extra]=process.argv.slice(2);
  assert.ok(output&&!extra.length,'Supply registered LD06 fixture, original assets directory and new output directory');
  const fixture=JSON.parse(await readFile(fixturePath,'utf8'));
  await mkdir(output,{mode:0o700});
  const save=(name,data)=>writeFile(join(output,name),Buffer.isBuffer(data)?data:JSON.stringify(data,null,2)+'\n',{flag:'wx',mode:0o600});
  const profile=await mkdtemp(join(tmpdir(),'omc-ld06-assets-')),controller=new AbortController();
  for(const event of ['SIGINT','SIGTERM']) process.once(event,()=>controller.abort(new Error(event)));
  const report={workload:'LD06',variant:fixture.source_family_id,fixtureSha256:fixture.fixture_sha256,
    measurementKind:'installed-native-assets-font-reopen',fontReadbacks:[],rasters:{},glyphDiagnostics:{},
    limitations:['Complete registered-glyph rendering has not been independently certified.',
      'HTML export is not evidence of two clean-checkout builds with offline rendered asset provenance.']};
  try { await execute(fixture,await verifyInputs(fixture,assetDirectory),save,report,profile,controller.signal); }
  catch(error) { Object.assign(report,{status:'failed',error:error.stack}); process.exitCode=1; }
  finally { await rm(profile,{recursive:true,force:true,maxRetries:10}); await save('observations.json',report); }
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) await main();
