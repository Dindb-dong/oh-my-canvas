import assert from 'node:assert/strict';
import {readFileSync, writeFileSync} from 'node:fs';
import {mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';

import {withPaper} from './ld03.mjs';

const approvedCanvas = 'OMC Benchmark • Synthetic CAP Probe • 2026-11-17';
const approvedControl = 'CAP Editable Scene';
const px = size => size + 'px';
const escape = value => value.replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[c]);

export function planLD04(fixture, file, runId) {
  assert.equal(fixture.workload, 'LD04');
  assert.ok(['street-market', 'lab-queue'].includes(fixture.source_family_id));
  assert.equal(fixture.private_width_registered, true);
  assert.match(fixture.withheld_width_commitment, /^[a-f0-9]{64}$/);
  assert.equal(file.name, approvedCanvas);
  assert.match(file.fileId, /^[-\w]+$/);
  assert.match(runId, /^[a-z0-9][a-z0-9-]{7,31}$/);
  const source = fixture.start.nodes;
  const expected = fixture.expected.nodes;
  const cards = expected.filter(node => node.parent === 'collection');
  const [desktop, collection] = ['canvas', 'collection'].map(key => expected.find(n => n.key === key));
  const inset = collection.bounds[0];
  const title = expected.find(n => n.key === 'title');
  const updates = {
    canvas: {height: 'fit-content', display: 'flex', flexDirection: 'column',
      boxSizing:'border-box', padding: px(inset)},
    collection: {position:'relative', width: '100%', height:'fit-content', display:'flex',
      flexDirection:'row', flexWrap:'wrap', gap:px(collection.gap), alignItems:'flex-start',
      justifyContent:'flex-start', marginTop:px(collection.bounds[1] - inset - (fixture.source_family_id === 'lab-queue' ? 48 : 30))},
  };
  if (fixture.source_family_id === 'lab-queue') {
    updates.heading = {position:'relative', width:'100%', height:'48px'};
    updates.footer = {position:'relative', width:'100%', height:'20px', marginTop:'16px'};
  } else {
    updates.title = {position:'relative', width:'100%', height:'30px'};
  }
  for (const card of cards) {
    updates[card.key] = {position:'relative', width:'auto', height:'fit-content',
      display:'flex', flexDirection:'column', boxSizing:'border-box', padding:'12px', gap:'4px',
      flex:`1 1 ${px(card.basis_width)}`, minWidth:px(card.min_width), maxWidth:px(card.max_width)};
    for (const line of source.filter(n => n.parent === card.key)) {
      updates[line.key] = {position:'relative', width:'100%', height:'20px'};
    }
  }
  for (const [key, style] of Object.entries(updates)) {
    if (key !== 'canvas') Object.assign(style, {left:'auto', top:'auto'});
  }
  const children = key => source.filter(row => row.parent === key);
  const render = (row, parent) => {
    const [x,y,w,h] = row.bounds;
    const [parentX,parentY] = parent.bounds;
    const bounds = `position:absolute;left:${px(x-parentX)};top:${px(y-parentY)};width:${px(w)};height:${px(h)}`;
    if (row.kind === 'text') {
      return `<div style="${bounds};font-family:Inter;font-size:${px(row.font_size)};line-height:${px(h)};color:#172030">${escape(row.text)}</div>`;
    }
    const color = row.parent === 'collection' ? '#e8edf4' : '#f7f9fc';
    return `<div style="${bounds};background-color:${color}">${children(row.key).map(n=>render(n,row)).join('')}</div>`;
  };
  const widthSteps = fixture.probe_actions.map(({op,key,property,value}, i) => {
    assert.equal(op, 'set_node');
    assert.equal(key, 'canvas');
    assert.equal(property, 'width');
    assert.equal(value, fixture.responsive_steps[i].width);
    return value;
  });
  assert.deepEqual([widthSteps[0],widthSteps[1],widthSteps[3]],[768,390,1440]);
  assert.ok(Number.isInteger(widthSteps[2]) && widthSteps[2]>390 && widthSteps[2]<1440 && widthSteps[2]!==768);
  return {pageName:`LD04 ${fixture.source_family_id} / ${runId}`, boardName:title.text,
    boardStyles:{width:px(desktop.bounds[2]), height:px(desktop.bounds[3]), backgroundColor:'#f7f9fc'},
    markup:children(desktop.key).map(row=>render(row,desktop)).join(''), updates, widthSteps};
}

function observedBounds(detail, root) {
  const values = [detail.worldX,detail.worldY,detail.width,detail.height];
  if (!values.every(Number.isFinite)||!Number.isFinite(root.worldX)||!Number.isFinite(root.worldY)) return null;
  return [values[0]-root.worldX,values[1]-root.worldY,values[2],values[3]];
}

export function compareLD04(expected, snapshot) {
  const root = snapshot.details.canvas;
  const differences = [];
  const missingBounds = [];
  const overflows = [];
  for (const row of expected.nodes) {
    const bounds = observedBounds(snapshot.details[row.key], root);
    if (!bounds) {
      missingBounds.push(row.key);
    } else {
      if (row.bounds.some((value,index)=>Math.abs(value-bounds[index])>1)) {
        differences.push({key:row.key,observed:bounds,expected:row.bounds});
      }
      if (bounds[0]+bounds[2]>root.width+1||bounds[1]+bounds[3]>root.height+1) overflows.push(row.key);
    }
  }
  return {actualWidth:root.width??null, differences, missingBounds, overflows};
}

export async function runLD04(read, fixture, file, runId, save, record) {
  const plan = planLD04(fixture, file, runId);
  const scope = {fileId:file.fileId, fileName:file.name, nodes:{}};
  const call = async (name, fields = {}) => {
    const args = {...fields,fileId:file.fileId};
    const start = performance.now();
    try {
      const answer = await read({name,arguments:args});
      record({tool:name,arguments:args, durationMs:performance.now()-start,
        response:Buffer.isBuffer(answer)?{bytes:answer.length}:answer});
      return answer;
    } catch (error) {
      record({tool:name,arguments:args,durationMs:performance.now()-start,error:error.message});
      throw error;
    }
  };
  const original = await call('get_basic_info');
  assert.equal(original.fileName, approvedCanvas);
  assert.ok(!original.pages.some(page => page.name === plan.pageName), 'LD04 page already exists');
  let control = original.artboards.some(row=>row.name===approvedControl);
  for (const page of original.pages) {
    if (control) break;
    control = (await call('get_basic_info',{pageId:page.id})).artboards.some(row=>row.name===approvedControl);
  }
  assert.ok(control, 'Approved synthetic control board missing');
  const font = await call('get_font_family_info',{familyNames:['Inter']});
  save('font.json',font);
  const result = {scope, comparedWidths:[], withheldWidthCommitment:fixture.withheld_width_commitment,
    acceptedCompletionSeconds:null, normalEditorReopenObserved:false, distinctVerificationCopyObserved:false};
  const readPhase = async (phase, expected) => {
    const page = await call('get_basic_info',{pageId:scope.pageId});
    assert.deepEqual(page.artboards.map(board=>[board.id,board.name]),[[scope.nodes.canvas,plan.boardName]]);
    const details = {};
    async function visit(row,id,parentId) {
      const detail = await call('get_node_info',{nodeId:id});
      assert.equal(detail.id,id);
      assert.equal(detail.parentId,parentId);
      assert.equal(detail.component,row.kind==='text'?'Text':'Frame');
      assert.equal(detail.isLocked,false);
      assert.equal(detail.isVisible,true);
      if (row.kind==='text') assert.equal(detail.textContent,row.text);
      if (scope.nodes[row.key]) assert.equal(scope.nodes[row.key],id, `Native identity changed for ${row.key}`);
      scope.nodes[row.key] = id;
      details[row.key] = detail;
      const children = fixture.start.nodes.filter(n=>n.parent===row.key);
      assert.equal(detail.childIds.length,children.length);
      await Promise.all(children.map((child,index)=>visit(child,detail.childIds[index],id)));
    }
    await visit(fixture.start.nodes[0],scope.nodes.canvas,page.rootNodeId);
    assert.equal(Object.keys(details).length,fixture.logical_objects);
    assert.equal(new Set(Object.values(scope.nodes)).size,fixture.logical_objects);
    const {styles} = await call('get_computed_styles',{nodeIds:Object.values(scope.nodes)});
    const snapshot = {details,styles};
    save(phase+'-observed.json',snapshot);
    const screenshot = await call('get_screenshot',{nodeId:scope.nodes.canvas,scale:1});
    save(phase+'.jpg',screenshot);
    return compareLD04(expected,snapshot);
  };
  try {
    await call('create_page',{name:plan.pageName});
    const home = await call('get_basic_info');
    assert.equal(home.fileName,approvedCanvas);
    const pages = home.pages.filter(page=>page.name===plan.pageName);
    assert.equal(pages.length,1);
    scope.pageId = pages[0].id;
    assert.ok(!original.pages.some(page=>page.id===scope.pageId));
    const empty = await call('get_basic_info',{pageId:scope.pageId});
    assert.deepEqual(empty.artboards,[]);
    await call('create_artboard',{pageId:scope.pageId,name:plan.boardName,styles:plan.boardStyles});
    const page = await call('get_basic_info',{pageId:scope.pageId});
    assert.equal(page.artboards.length,1);
    assert.equal(page.artboards[0].name,plan.boardName);
    scope.nodes.canvas=page.artboards[0].id;
    await call('write_html',{html:plan.markup,mode:'insert-children',targetNodeId:scope.nodes.canvas});
    result.before = await readPhase('before',fixture.start);
    assert.equal(result.before.actualWidth,1440);
    const updates = Object.entries(plan.updates).map(([key,styles])=>({nodeIds:[scope.nodes[key]],styles}));
    const started = performance.now();
    result.layoutAcknowledgement = await call('update_styles',{updates});
    result.layoutWriteMs = performance.now()-started;
    assert.deepEqual(result.layoutAcknowledgement.updates.map(row=>row.nodeId).sort(),
      updates.flatMap(row=>row.nodeIds).sort());
    result.candidate = await readPhase('candidate',fixture.expected);
    for (const [index,width] of plan.widthSteps.entries()) {
      const begin = performance.now();
      const ack = await call('update_styles',{updates:[{nodeIds:[scope.nodes.canvas],styles:{width:px(width)}}]});
      const widthWriteMs = performance.now()-begin;
      assert.deepEqual(ack.updates.map(row=>row.nodeId),[scope.nodes.canvas]);
      const observation = await readPhase(`width-${index+1}`,fixture.responsive_steps[index]);
      result.comparedWidths.push({requestedWidth:width,widthWriteMs,...observation});
    }
  } catch (error) {
    result.blocker = error.message;
  } finally {
    if (scope.nodes.canvas) await call('finish_working_on_nodes',{nodeIds:Object.values(scope.nodes)})
      .catch(error=>{result.releaseError=error.message;});
  }
  return result;
}

if (process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  const [mode,fixturePath,filePath,runId,output] = process.argv.slice(2);
  assert.ok(['plan','run'].includes(mode)&&fixturePath&&filePath&&runId);
  const fixture = JSON.parse(readFileSync(fixturePath,'utf8'));
  const file = JSON.parse(readFileSync(filePath,'utf8'));
  const plan = planLD04(fixture,file,runId);
  if (mode==='plan') {
    console.log(JSON.stringify(plan,null,2));
  } else {
    assert.ok(output);
    await mkdir(output,{mode:0o700});
    const save = (name,data) => writeFileSync(join(output,name),Buffer.isBuffer(data)?data:JSON.stringify(data,null,2)+'\n',
      {flag:'wx',mode:0o600});
    save('plan.json',plan);
    const events = [];
    const result = await withPaper(file,read=>runLD04(read,fixture,file,runId,save,event=>events.push(event)))
      .catch(error=>({blocker:error.message,acceptedCompletionSeconds:null}));
    save('tool-events.json',events);
    save('result.json',result);
    console.log(JSON.stringify({widths:result.comparedWidths?.length??0,blocker:result.blocker??null}));
    if (result.blocker) process.exitCode=1;
  }
}
