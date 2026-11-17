import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';

import {planLD01, runLD01} from './ld01.mjs';

const script=fileURLToPath(new URL('../workloads/synthetic.py',import.meta.url));
const file={fileId:'fixture-id',name:'OMC Benchmark • Synthetic CAP Probe • 2026-11-17'};
const runId='paper-ld01-test';
function prepare(t,variant='reading-room') {
  const temp=mkdtempSync(join(tmpdir(),'paper-ld01-'));
  t.after(()=>rmSync(temp,{recursive:true}));
  const assets=join(temp,'assets');
  const fixture=JSON.parse(execFileSync('python3',[script,'fixture','LD01','--variant',variant,'--assets-dir',assets],
    {env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}}));
  return {fixture,assets};
}

test('keeps registered hierarchy and editable text, embeds only verified local originals',t=>{
  const {fixture,assets}=prepare(t);
  const plan=planLD01(fixture,file,assets,runId);
  assert.equal(plan.boardName,'Reading room service');
  assert.equal(plan.fragments.length,6);
  const all=plan.fragments.join('');
  assert.match(all,/<img layer-name="nav\/brand" src="paper-asset:\/\/\/.*\/badge.png" alt="[^"]+" width="32" height="32"/);
  assert.match(all,/<img layer-name="detail\/map" src="paper-asset:\/\/\/.*\/detail-map.png" alt="[^"]+" width="288" height="144"/);
  assert.match(all,/layer-name="filters"[^>]*gap:12px/);
  assert.match(all,/layer-name="table\/row-9\/4"[^>]*>Queued</);
  fixture.expected.nodes.find(n=>n.key==='header/title').text='<script>&"';
  assert.match(planLD01(fixture,file,assets,runId).fragments.join(''),/&lt;script&gt;&amp;&quot;/);
  writeFileSync(join(assets,'badge.png'),'other');
  assert.throws(()=>planLD01(fixture,file,assets,runId),/checksum differs/);
});

test('creates only a new isolated dashboard and preserves honest image and lifecycle observations',async t=>{
  const {fixture,assets}=prepare(t);
  const plan=planLD01(fixture,file,assets,runId);
  const nodes=fixture.expected.nodes;
  const layers=Map.groupBy(nodes,n=>n.parent);
  const id=key=>String(nodes.findIndex(n=>n.key===key));
  let created=false,board=false;
  const output=new Map();
  const events=[];
  const read=async({name,arguments:args})=>{
    assert.equal(args.fileId,file.fileId);
    let data=null,images=[];
    if(name==='get_basic_info')data=args.pageId
      ?{artboards:board?[{name:plan.boardName,id:'0'}]:[],rootNodeId:'page-root'}
      :{fileName:file.name,artboards:[{name:'CAP Editable Scene'}],
        pages:created?[{name:plan.pageName,id:'new'}]:[]};
    if(name==='create_page'){assert.equal(args.name,plan.pageName);created=true;}
    if(name==='create_artboard'){assert.equal(args.pageId,'new');board=true;}
    if(name==='write_html')assert.equal(args.targetNodeId,'0');
    if(name==='get_node_info'){
      const row=nodes[Number(args.nodeId)];
      const [worldX,worldY,width,height]=row.bounds;
      data={id:args.nodeId,parentId:row.parent===null?'page-root':id(row.parent),worldX,worldY,width,height,
        component:row.kind==='text'?'Text':'Frame',isVisible:true,isLocked:false,
        textContent:row.text,childIds:(layers.get(row.key)??[]).map(n=>id(n.key))};
    }
    if(name==='get_computed_styles')data={styles:{}};
    if(name==='get_fill_image')data={mimeType:'image/jpeg'};
    if(name==='get_fill_image'||name==='get_screenshot')images=[{mime:'image/jpeg',bytes:Buffer.from(name)}];
    return {data,images};
  };
  const capture=async()=>runLD01(read,fixture,file,plan,(k,v)=>output.set(k,v),row=>events.push(row));
  const result=await capture();
  assert.equal(result.blocker,undefined);
  assert.ok(result.structureAndExactTextObserved);
  assert.deepEqual(result.geometry,{missing:[],different:[]});
  assert.equal(result.assetCanonicalRgbaObserved,false);
  assert.equal(result.acceptedCompletionMs,null);
  assert.deepEqual(Object.keys(result.assets),['nav/brand','detail/map']);
  assert.ok(output.has('candidate-0.jpg')&&output.has('nav-brand-0.jpg'));
  assert.equal(events.at(-1).name,'finish_working_on_nodes');
  await assert.rejects(capture(),/already exists/);
});
