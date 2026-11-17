import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {appendFileSync, readFileSync, realpathSync, writeFileSync} from 'node:fs';
import {mkdir} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const approvedCanvas='OMC Benchmark • Synthetic CAP Probe • 2026-11-17';
const controlBoard='CAP Editable Scene';
const sha=value=>createHash('sha256').update(value).digest('hex');
const quote=value=>value.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);

export function planLD01(fixture, file, assetsDir, runId) {
  assert.equal(fixture.workload,'LD01');
  assert.ok(['reading-room','harbor-ops'].includes(fixture.source_family_id));
  assert.equal(file.name,approvedCanvas);
  assert.match(file.fileId,/^[-\w]+$/);
  assert.match(runId,/^[a-z0-9][a-z0-9-]{7,31}$/);
  assert.deepEqual(fixture.start,{nodes:[],styles:[]});
  const nodes=fixture.expected.nodes;
  assert.equal(nodes.length,fixture.logical_objects);
  const children=Map.groupBy(nodes,row=>row.parent);
  const [root]=children.get(null);
  assert.equal(root.key,'dashboard');
  assert.deepEqual(root.bounds,[0,0,1440,960]);
  const assetRoot=realpathSync(assetsDir);
  const assets=new Map(fixture.assets.map(spec=>{
    assert.ok(['badge.png','detail-map.png'].includes(spec.name));
    const path=realpathSync(join(assetRoot,spec.name));
    assert.equal(dirname(path),assetRoot,'Synthetic asset is outside the fixture directory');
    assert.equal(sha(readFileSync(path)),spec.sha256,'Synthetic asset checksum differs');
    return [spec.rgba_sha256,path];
  }));
  function render(row,parent) {
    assert.ok(row.bounds.length===4&&row.bounds.every(Number.isInteger));
    const [x,y,width,height]=row.bounds;
    const isFlow=parent.layout==='horizontal';
    const base=`width:${width}px;height:${height}px;box-sizing:border-box;flex-shrink:0`;
    const position=isFlow?'':`;position:absolute;left:${x-parent.bounds[0]}px;top:${y-parent.bounds[1]}px`;
    const style=base+position;
    const name=`layer-name="${quote(row.key)}"`;
    if(row.kind==='text'){
      assert.ok(Number.isInteger(row.font_size)&&row.font_family==='Inter');
      return `<div ${name} style="${style};font-family:Inter;font-size:${row.font_size}px;line-height:${height}px;color:#292234">${quote(row.text)}</div>`;
    }
    if(row.kind==='image'){
      const path=assets.get(row.asset_rgba_sha256);
      assert.ok(path);
      const alt=row.key==='nav/brand'?'Library service emblem':'Selected service location diagram';
      return `<img ${name} src="paper-asset://${quote(path)}" alt="${alt}" width="${width}" height="${height}" style="${style};object-fit:fill">`;
    }
    assert.equal(row.kind,'frame');
    assert.ok(!row.layout||row.layout==='horizontal');
    const layout=row.layout?`;display:flex;flex-direction:row;align-items:center;gap:${row.gap}px`:'';
    if(row.layout) assert.ok(Number.isInteger(row.gap));
    const color=row.key==='nav'?'#ece4ee':row.key.startsWith('table/row-')?'#f7f3f7':'#ffffff';
    return `<div ${name} style="${style}${layout};background-color:${color}">${(children.get(row.key)??[]).map(n=>render(n,row)).join('')}</div>`;
  }
  return {pageName:`LD01 ${fixture.source_family_id} / ${runId}`,
    boardName:nodes.find(n=>n.key==='header/title').text,
    styles:{width:'1440px',height:'960px',backgroundColor:'#f2eef4'},
    fragments:children.get(root.key).map(row=>render(row,root))};
}

export async function runLD01(read, fixture, file, plan, save, record) {
  const call=async(name,fields={},mediaName)=>{
    const args={...fields,fileId:file.fileId};
    const start=performance.now();
    try {
      const {data,images=[]}=await read({name,arguments:args});
      const media=images.map(({mime,bytes},index)=>{
        assert.ok(mediaName, 'Unexpected media response');
        const extension=mime==='image/png'?'png':'jpg';
        const filename=`${mediaName}-${index}.${extension}`;
        save(filename,bytes);
        return {filename,mime,sha256:sha(bytes),size:bytes.length};
      });
      record({name,arguments:args,wallMs:performance.now()-start,data,media});
      return {data,media};
    } catch(error) {
      record({name,arguments:args,wallMs:performance.now()-start,error:error.message});
      throw error;
    }
  };
  const body=async(...args)=>(await call(...args)).data;
  const scope={fileId:file.fileId,fileName:file.name,pageName:plan.pageName,nodes:{}};
  const result={scope,acceptedCompletionMs:null,normalEditorReopenObserved:false,
    distinctVerificationCopyObserved:false};
  const home=await body('get_basic_info');
  assert.equal(home.fileName,approvedCanvas);
  assert.ok(!home.pages.some(row=>row.name===plan.pageName),'Synthetic run page already exists');
  let found=home.artboards.some(row=>row.name===controlBoard);
  for(const page of home.pages) {
    if(found) break;
    found=(await body('get_basic_info',{pageId:page.id})).artboards.some(row=>row.name===controlBoard);
  }
  assert.ok(found,'Approved control artboard is missing');
  save('font-availability.json',await body('get_font_family_info',{familyNames:['Inter']}));
  try {
    await body('create_page',{name:plan.pageName});
    const after=await body('get_basic_info');
    assert.equal(after.fileName,file.name);
    const pages=after.pages.filter(page=>page.name===plan.pageName);
    assert.equal(pages.length,1);
    assert.ok(!home.pages.some(page=>page.id===pages[0].id));
    scope.pageId=pages[0].id;
    const empty=await body('get_basic_info',{pageId:scope.pageId});
    assert.deepEqual(empty.artboards,[]);
    result.beforePage={pageId:scope.pageId,artboards:empty.artboards};
    const start=performance.now();
    await body('create_artboard',{pageId:scope.pageId,name:plan.boardName,styles:plan.styles});
    const page=await body('get_basic_info',{pageId:scope.pageId});
    assert.equal(page.artboards.length,1);
    const [board]=page.artboards;
    assert.equal(board.name,plan.boardName);
    scope.boardId=board.id;
    for(const html of plan.fragments) {
      await body('write_html',{targetNodeId:scope.boardId,mode:'insert-children',html});
    }
    result.candidateMutationWallMs=performance.now()-start;
    result.screenshot=(await call('get_screenshot',{nodeId:scope.boardId,scale:1},'candidate')).media;
    const expected=fixture.expected.nodes;
    const expectedChildren=Map.groupBy(expected,row=>row.parent);
    const details={};
    const visit=async(row,id,parentId)=>{
      const detail=await body('get_node_info',{nodeId:id});
      assert.equal(detail.id,id);
      assert.equal(detail.parentId,parentId);
      assert.equal(detail.isLocked,false);
      assert.equal(detail.isVisible,true);
      const options=row.kind==='image'?['Frame','Image']:[row.kind==='text'?'Text':'Frame'];
      assert.ok(options.includes(detail.component),`Unexpected native type for ${row.key}: ${detail.component}`);
      if(row.kind==='text') assert.equal(detail.textContent,row.text);
      scope.nodes[row.key]=id;
      details[row.key]=detail;
      const children=expectedChildren.get(row.key)??[];
      assert.equal(detail.childIds.length,children.length,row.key);
      for(const [index,child] of children.entries()) {
        await visit(child,detail.childIds[index],id);
      }
    };
    await visit(expected[0],scope.boardId,page.rootNodeId);
    assert.equal(new Set(Object.values(scope.nodes)).size,fixture.logical_objects);
    save('native-details.json',details);
    const styles={};
    const nodeIds=Object.values(scope.nodes);
    for(let start=0;start<nodeIds.length;start+=25) {
      Object.assign(styles,(await body('get_computed_styles',{nodeIds:nodeIds.slice(start,start+25)})).styles);
    }
    save('native-styles.json',styles);
    result.assets={};
    for(const row of expected.filter(row=>row.kind==='image')) {
      result.assets[row.key]=await call('get_fill_image',{nodeId:scope.nodes[row.key]},row.key.replace('/','-'));
    }
    result.structureAndExactTextObserved=true;
    result.geometry={missing:[],different:[]};
    const origin=details.dashboard;
    for(const row of expected) {
      const d=details[row.key];
      if(![d.worldX,d.worldY,d.width,d.height,origin.worldX,origin.worldY].every(Number.isFinite)){
        result.geometry.missing.push(row.key);
        continue;
      }
      const bounds=[d.worldX-origin.worldX,d.worldY-origin.worldY,d.width,d.height];
      if(bounds.some((value,i)=>Math.abs(value-row.bounds[i])>fixture.geometry_tolerance_px)) {
        result.geometry.different.push({key:row.key,bounds,expected:row.bounds});
      }
    }
    result.assetCanonicalRgbaObserved=false;
  } catch(error) {
    result.blocker=error.message;
  } finally {
    if(scope.boardId) await body('finish_working_on_nodes',{nodeIds:[...new Set([scope.boardId,...Object.values(scope.nodes)])]})
      .catch(error=>{result.releaseError=error.message;});
  }
  return result;
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  const [mode,fixturePath,filePath,assets,runId,output]=process.argv.slice(2);
  assert.ok(['plan','run'].includes(mode)&&runId);
  const load=path=>JSON.parse(readFileSync(path,'utf8'));
  const fixture=load(fixturePath);
  const file=load(filePath);
  const plan=planLD01(fixture,file,assets,runId);
  if(mode==='plan') {
    console.log(JSON.stringify(plan,null,2));
  } else {
    const dest=resolve(output);
    await mkdir(dest,{mode:0o700});
    const save=(name,data)=>writeFileSync(join(dest,name),Buffer.isBuffer(data)?data:JSON.stringify(data,null,2)+'\n',
      {flag:'wx',mode:0o600});
    const record=event=>appendFileSync(join(dest,'tool-events.jsonl'),JSON.stringify(event)+'\n',{mode:0o600});
    const endpoint=new URL(process.env.PAPER_BENCH_URL??'http://127.0.0.1:29979/mcp');
    assert.ok(endpoint.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(endpoint.hostname));
    assert.ok(!endpoint.username&&!endpoint.password&&!endpoint.search&&!endpoint.hash);
    const {Client,StreamableHTTPClientTransport}=await import('../replays/mcp.mjs');
    const client=new Client({name:'paper-ld01-diagnostic',version:'1'});
    try {
      await client.connect(new StreamableHTTPClientTransport(endpoint),{timeout:10000});
      const read=async command=>{
        const answer=await client.callTool(command,undefined,{timeout:30000});
        const raw=answer.content.filter(row=>row.type==='text').map(row=>row.text);
        assert.ok(!answer.isError,raw.at(-1));
        assert.ok(raw.some(header=>header.includes(file.fileId)), 'Paper response omitted approved file identity');
        let data=null;
        if(raw.length>1){
          try {data=JSON.parse(raw.at(-1));} catch {data=raw.at(-1);}
        }
        const images=answer.content.filter(row=>row.type==='image').map(row=>({mime:row.mimeType,bytes:Buffer.from(row.data,'base64')}));
        return {data,images};
      };
      save('plan.json',plan);
      const result=await runLD01(read,fixture,file,plan,save,record).catch(error=>({blocker:error.message,acceptedCompletionMs:null}));
      save('result.json',result);
      console.log(JSON.stringify({verifiedNativeObjects:Object.keys(result.scope?.nodes??{}).length,
        tookMs:result.candidateMutationWallMs,blocker:result.blocker??null}));
      if(result.blocker) process.exitCode=1;
    } finally {
      await client.close();
    }
  }
}
