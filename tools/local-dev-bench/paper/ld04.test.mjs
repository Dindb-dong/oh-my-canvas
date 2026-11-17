import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';

import {compareLD04, planLD04, runLD04} from './ld04.mjs';

const scripts = fileURLToPath(new URL('../workloads/', import.meta.url));
const file={fileId:'synthetic-test',name:'OMC Benchmark • Synthetic CAP Probe • 2026-11-17'};
const runId='paper-ld04-test';
function build(variant, registered=true) {
  const py=`import json, synthetic; print(json.dumps(synthetic.fixture('LD04','${variant}',private_registration=${registered?"{'width':706,'nonce':'an independent testing nonce'}":"None"})))`;
  return JSON.parse(execFileSync('python3',['-c',py],{cwd:scripts,env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}}));
}

test('plans both registered variants with one responsive collection and an ordered width sequence',()=>{
  for(const variant of ['street-market','lab-queue']) {
    const spec=build(variant);
    const p=planLD04(spec,file,runId);
    assert.deepEqual(p.widthSteps,[768,390,706,1440]);
    assert.equal(p.updates.collection.flexWrap,'wrap');
    assert.equal(p.updates.collection.width,'100%');
    assert.equal(p.updates['card/0'].height,'fit-content');
    assert.equal(p.updates['card/0'].flex,variant==='street-market'?'1 1 270px':'1 1 248px');
    assert.doesNotMatch(p.markup,/706px/);
    assert.equal(Boolean(p.updates.footer),variant==='lab-queue');
  }
  assert.throws(()=>planLD04(build('street-market',false),file,runId));
});

test('reports unavailable native bounds distinctly from frame overflow and geometry differences',()=>{
  const spec=build('street-market').responsive_steps[1];
  const details=Object.fromEntries(spec.nodes.map(({key,bounds:[x,y,width,height]})=>
    [key,{worldX:x+30,worldY:y+40,width,height}]));
  details.title.width=null;
  details['card/0'].width=600;
  const result=compareLD04(spec,{details});
  assert.deepEqual(result.missingBounds,['title']);
  assert.deepEqual(result.overflows,['card/0']);
  assert.deepEqual(result.differences.map(row=>row.key),['card/0']);
});

test('guards one isolated page and uses only a board width write in each check',async()=>{
  const spec=build('lab-queue');
  const p=planLD04(spec,file,runId);
  const events=[];
  const output=new Map();
  const nodes=spec.start.nodes;
  const id=key=>nodes.findIndex(row=>row.key===key).toString();
  let created=false, board=false, responsive=false, width=1440;
  const read=async({name,arguments:args})=>{
    assert.equal(args.fileId,file.fileId);
    if(name==='get_basic_info'){
      if(args.pageId==='page')return {rootNodeId:'root',artboards:board?[{id:'0',name:p.boardName}]:[]};
      return {fileName:file.name,artboards:[{name:'CAP Editable Scene'}],
        pages:created?[{id:'page',name:p.pageName}]:[]};
    }
    if(name==='get_node_info'){
      const step=spec.responsive_steps.find(row=>row.width===width);
      const src=(responsive?(step??spec.expected):spec.start).nodes;
      const row=src[Number(args.nodeId)];
      const [worldX,worldY,w,height]=row.bounds;
      return {id:args.nodeId,parentId:row.parent===null?'root':id(row.parent),worldX,worldY,width:w,height,
        component:row.kind==='text'?'Text':'Frame',textContent:row.text,isVisible:true,isLocked:false,
        childIds:src.filter(child=>child.parent===row.key).map(child=>id(child.key))};
    }
    if(name==='get_font_family_info')return {Inter:'verified'};
    if(name==='create_page'){created=true;return {};}
    if(name==='create_artboard'){board=true;return {};}
    if(name==='update_styles'){
      responsive=true;
      if(args.updates.length===1) {
        assert.deepEqual(args.updates.map(up=>[up.nodeIds,Object.keys(up.styles)]),[[['0'],['width']]]);
        width=Number.parseInt(args.updates[0].styles.width,10);
      }
      return {updates:args.updates.map(up=>({nodeId:up.nodeIds[0]}))};
    }
    if(name==='get_computed_styles')return {styles:{}};
    if(name==='get_screenshot')return Buffer.from('mock evidence');
    return {};
  };
  const result=await runLD04(read,spec,file,runId,(name,data)=>output.set(name,data),event=>events.push(event));
  assert.equal(result.blocker,undefined);
  assert.deepEqual(result.comparedWidths.map(row=>row.actualWidth),p.widthSteps);
  assert.ok(result.comparedWidths.every(row=>!row.differences.length && !row.missingBounds.length));
  assert.equal(result.acceptedCompletionSeconds,null);
  assert.equal(events.filter(event=>event.tool==='create_page').length,1);
  assert.equal(events.at(-1).tool,'finish_working_on_nodes');
  assert.ok(output.has('width-3.jpg'));
  await assert.rejects(runLD04(read,spec,file,runId,()=>{},()=>{}),/already exists/);
});
