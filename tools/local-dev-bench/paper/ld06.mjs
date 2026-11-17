import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {copyFile,mkdir,readFile,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {verifyInputs} from '../penpot/ld06.mjs';
import {publishCandidate} from '../publish-candidate.mjs';
import {inheritedDeadline} from '../figma/ld05-run.mjs';
import {awaitPaperNativeReopen,verifyImage,verifyPaperReopen} from './ld05.mjs';
import {withPaper} from './ld03.mjs';

const approvedName='OMC Benchmark • Synthetic CAP Probe • 2026-11-17';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const escape=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);

export function paperLD06Markup(row,parent,fixture,asset) {
  const [x,y,w,h]=row.bounds, [left,top]=parent.bounds;
  const style=`position:absolute;left:${x-left}px;top:${y-top}px;width:${w}px;height:${h}px;box-sizing:border-box;flex-shrink:0`;
  const name=`layer-name="${escape(row.key)}"`;
  if(row.kind==='image') {
    assert.ok(asset?.path);
    return `<img ${name} src="paper-asset://${escape(asset.path)}" width="${w}" height="${h}" style="${style};object-fit:cover">`;
  }
  if(row.kind==='text') return `<div ${name} style="${style};font-family:${escape(fixture.font.family)};font-size:${row.key==='header'?26:16}px;line-height:${h}px;color:#14233f">${escape(row.text)}</div>`;
  assert.equal(row.kind,'frame');
  return `<div ${name} style="${style};background-color:#f2f4f8"></div>`;
}

export function normalizePaperLD06(scope,details,styles,images={}) {
  const rows=Object.entries(details), byId=new Map(rows.map(([key,row])=>[row.id,key]));
  assert.equal(byId.size,rows.length);
  const root=details.canvas;
  assert.ok(root);
  const nodes=rows.map(([key,row])=>{
    const isImage=Boolean(images[key]);
    const kind=isImage?'image':row.component==='Text'?'text':'frame';
    const numeric=[row.worldX,row.worldY,row.width,row.height,root.worldX,root.worldY].every(Number.isFinite);
    const value={key,native_id:row.id,name:row.name,kind,parent:row.id===root.id?null:byId.get(row.parentId),
      native_type:row.component,editable:row.isLocked===false&&row.isVisible===true,
      bounds:numeric?[row.worldX-root.worldX,row.worldY-root.worldY,row.width,row.height]:null};
    assert.ok(value.parent!==undefined,'Native parent missing from observed subtree');
    if(kind==='text') {
      value.text=row.textContent;
      if(styles[row.id]?.fontFamily) value.font_family=styles[row.id].fontFamily.replaceAll('"','').replaceAll("'",'');
      // CSS font-family does not establish actual font bytes, glyph rendering or clipping.
    }
    if(isImage) {
      const image=images[key],css=styles[row.id]??{};
      value.asset_rgba_sha256=image.rgba_sha256;
      value.stored_sha256=image.stored_sha256;
      if(css.backgroundSize==='cover' && ['center','50% 50%','center center'].includes(css.backgroundPosition) &&
        [row.width,row.height,image.width,image.height].every(v=>Number.isFinite(v)&&v>0)) {
        const {width,height}=image;
        if(width*row.height>height*row.width){const cropped=height*row.width/row.height;value.crop_source_px=[(width-cropped)/2,0,cropped,height];}
        else {const cropped=width*row.height/row.width;value.crop_source_px=[0,(height-cropped)/2,width,cropped];}
      }
    }
    return value;
  });
  return {document_id:scope.fileId,nodes,styles:[]};
}

async function decodeImages(assets) {
  const paths=[...assets].filter(([,asset])=>asset.meta.media_type==='image/png').map(([name,asset])=>({name,path:asset.path}));
  const script=`import hashlib,json,sys\nfrom PIL import Image\nrows=json.load(sys.stdin);out={}\nfor row in rows:\n im=Image.open(row['path']).convert('RGBA');out[row['name']]={'width':im.width,'height':im.height,'rgba_sha256':hashlib.sha256(im.tobytes()).hexdigest()}\nprint(json.dumps(out))`;
  const result=JSON.parse(execFileSync(process.env.PAPER_LD06_PYTHON??'/opt/homebrew/opt/python@3.14/bin/python3.14',
    ['-B','-c',script],{input:JSON.stringify(paths),encoding:'utf8',timeout:5000}));
  for(const [name,decoded]of Object.entries(result)) assert.equal(decoded.rgba_sha256,assets.get(name).meta.rgba_sha256);
  return result;
}

export async function runPaperLD06(read,fixture,assetsDir,scope,runId,output,{nativeReopen=false}={}) {
  assert.equal(scope.fileName,approvedName);
  assert.match(runId,/^[a-z0-9][a-z0-9-]{7,63}$/);
  const {assets,content}=await verifyInputs(fixture,assetsDir);
  const decoded=await decodeImages(assets);
  const native=join(output,'native');await mkdir(native,{mode:0o700});
  const save=(name,value)=>writeFile(join(native,name),Buffer.isBuffer(value)?value:JSON.stringify(value),{flag:'wx',mode:0o600});
  const call=(name,args={})=>read({name,arguments:{...args,fileId:scope.fileId}});
  const home=await call('get_basic_info');assert.equal(home.fileName,approvedName);
  const pageName=`LD06 metro-stories / ${runId}`;
  assert.ok(!home.pages.some(page=>page.name===pageName));
  let marker=home.artboards.some(b=>b.name==='CAP Editable Scene');
  for(const page of home.pages){if(marker)break;marker=(await call('get_basic_info',{pageId:page.id})).artboards.some(b=>b.name==='CAP Editable Scene');}
  assert.ok(marker,'Approved synthetic CAP marker missing');
  await save('font-availability.json',await call('get_font_family_info',{familyNames:[fixture.font.family]}));
  const deadline=nativeReopen?inheritedDeadline():null;
  const nodes={},imageSources=new Map();
  let boardId,pageId;
  const observe=async phase=>{
    const details=Object.fromEntries(await Promise.all(Object.entries(nodes).map(async([key,nodeId])=>[key,await call('get_node_info',{nodeId})])));
    for(const [key,row]of Object.entries(details)){assert.equal(row.id,nodes[key]);assert.equal(row.name,key);}
    const {styles}=await call('get_computed_styles',{nodeIds:Object.values(nodes)});
    const images=Object.fromEntries(await Promise.all([...imageSources].map(async([key,name])=>{
      const stored_sha256=await verifyImage((name,args)=>call(name,args),nodes[key],assets.get(name).path);
      assert.equal(stored_sha256,sha(assets.get(name).bytes));
      return [key,{...decoded[name],stored_sha256}];
    })));
    const jsx=await call('get_jsx',{nodeId:boardId,format:'inline-styles',includeNodeIds:true});
    await save(phase+'-native.json',{details,styles,images,jsx});
    await save(phase+'.jpg',await call('get_screenshot',{nodeId:boardId,scale:1}));
    return {snapshot:normalizePaperLD06(scope,details,styles,images),nativeReadback:{styles,jsx}};
  };
  const insert=async(parentKey,rows,sourceAsset)=>{
    const parent=fixture.expected.nodes.find(row=>row.key===parentKey);
    const html=rows.map(row=>paperLD06Markup(row,parent,fixture,row.kind==='image'?assets.get(sourceAsset):undefined)).join('');
    await call('write_html',{targetNodeId:nodes[parentKey],mode:'insert-children',html});
    const {children}=await call('get_children',{nodeId:nodes[parentKey]});
    for(const row of rows){const matches=children.filter(child=>child.name===row.key);assert.equal(matches.length,1);nodes[row.key]=matches[0].id;}
  };
  const evidence={fixture_sha256:fixture.fixture_sha256,
    observation_gaps:['Actual native font bytes and Latin/Korean glyph/clip attribution unobserved','Two independent clean source checkout builds unobserved'],
    input_assets:[...assets].map(([name,asset])=>({name,sha256:sha(asset.bytes)}))};
  try {
    await call('create_page',{name:pageName});
    const current=await call('get_basic_info');const page=current.pages.filter(p=>p.name===pageName);assert.equal(page.length,1);pageId=page[0].id;
    assert.ok(!home.pages.some(p=>p.id===pageId));
    const empty=await call('get_basic_info',{pageId});assert.deepEqual(empty.artboards,[]);
    await call('create_artboard',{pageId,name:'canvas',styles:{width:'1040px',height:'920px',backgroundColor:'#ffffff'}});
    const seeded=await call('get_basic_info',{pageId});assert.equal(seeded.artboards.length,1);boardId=seeded.artboards[0].id;nodes.canvas=boardId;
    await call('update_styles',{updates:[{nodeIds:[boardId],styles:{left:'0px',top:'0px'}}]});
    await insert('canvas',fixture.start.nodes.filter(row=>row.parent==='canvas'));
    await call('finish_working_on_nodes',{nodeIds:[boardId]});
    evidence.before=(await observe('before')).snapshot;
    for(const entry of content.initial){
      const parentKey=`card/${entry.slot}`,sourceAsset=`initial-image-${entry.slot+1}.png`;
      const rows=fixture.loaded.nodes.filter(row=>row.parent===parentKey).map(row=>({...row,
        ...(row.key.endsWith('/name')?{text:entry.name}:row.key.endsWith('/caption')?{text:entry.caption}:{})}));
      await insert(parentKey,rows,sourceAsset);imageSources.set(parentKey+'/image',sourceAsset);
    }
    await call('finish_working_on_nodes',{nodeIds:[boardId]});
    evidence.loaded=(await observe('loaded')).snapshot;
    const replacements=content.updates.map(entry=>({key:`card/${entry.slot}`,entry,name:`replacement-image-${entry.slot+1}.png`}));
    await call('update_styles',{updates:replacements.map(({key,name})=>({nodeIds:[nodes[key+'/image']],styles:{backgroundImage:`url("paper-asset://${assets.get(name).path}")`}}))});
    await call('set_text_content',{updates:replacements.flatMap(({key,entry})=>[
      {nodeId:nodes[key+'/name'],html:escape(entry.name)},{nodeId:nodes[key+'/caption'],html:escape(entry.caption)}])});
    for(const {key,name}of replacements)imageSources.set(key+'/image',name);
    await call('finish_working_on_nodes',{nodeIds:[boardId]});
    const candidate=await observe('candidate');evidence.candidate=candidate.snapshot;
    if(nativeReopen){
      const lifecycle=await awaitPaperNativeReopen({output,runId,cycle:1,fileKey:scope.fileId,pageId,writtenAt:new Date().toISOString(),deadline});
      await verifyPaperReopen(read,scope,pageId,{boardId,nativeReadback:candidate.nativeReadback});
      evidence.reopened=(await observe('reopened')).snapshot;await save('lifecycle.json',lifecycle);
    }else evidence.observation_gaps.push('Normal native editor close/reopen unobserved');
    const handoff=join(native,'source-observation');await mkdir(handoff,{mode:0o700});
    await writeFile(join(handoff,'native.jsx'),candidate.nativeReadback.jsx,{flag:'wx',mode:0o600});
    for(const [name,asset]of assets)await copyFile(asset.path,join(handoff,name));
    await save('source-observation.json',{exported_native_jsx_sha256:sha(candidate.nativeReadback.jsx),
      native_font_file_attributed:false,clean_checkout_builds_observed:0});
  }catch(error){evidence.native_failure=error.message;await save('failure.json',{error:error.message,scope:{...scope,pageId,boardId},nodes});}
  finally{if(boardId)await call('finish_working_on_nodes',{nodeIds:[boardId]}).catch(error=>{evidence.release_error=error.message;});}
  await save('evidence.json',evidence);
  return evidence;
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const[fixturePath,assetsDir,fileId,runId,option,...extra]=process.argv.slice(2);
  assert.ok(fixturePath&&assetsDir&&fileId&&runId&&process.env.OMC_BENCH_OUTPUT_DIR&&process.env.OMC_BENCH_CANDIDATE);
  assert.ok(!extra.length&&(!option||option==='--native-reopen'));
  const fixture=JSON.parse(await readFile(resolve(fixturePath),'utf8'));
  const evidence=await withPaper({fileId,fileName:approvedName},read=>runPaperLD06(read,fixture,resolve(assetsDir),
    {fileId,fileName:approvedName},runId,process.env.OMC_BENCH_OUTPUT_DIR,{nativeReopen:option==='--native-reopen'}));
  await publishCandidate(process.env.OMC_BENCH_CANDIDATE,evidence);
  console.log(JSON.stringify({phases:['before','loaded','candidate','reopened'].filter(name=>evidence[name]),
    native_failure:evidence.native_failure??null,observation_gaps:evidence.observation_gaps}));
}
