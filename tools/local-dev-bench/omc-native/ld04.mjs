import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {assetToolDocumentId} from './asset-pressure.mjs';
import {startService} from './profile-font.mjs';
import {publishCandidate} from '../publish-candidate.mjs';

const marker = 'LD04 ';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const nativeId = n => 'node_' + n.toString(16).padStart(32, '0');
const padding = value => Object.fromEntries(['top','right','bottom','left'].map(side=>['padding-'+side,value]));

// Read starting geometry and public semantic constraints only. No responsive results enter this plan.
export function planResponsive(fixture) {
  assert.equal(fixture.workload,'LD04');
  const rows = fixture.start.nodes;
  const byKey = new Map(rows.map(row=>[row.key,row]));
  const canvas = byKey.get('canvas'), collection = byKey.get('collection');
  const heading = byKey.get('heading') ?? byKey.get('title');
  const card = byKey.get('card/0'), first = byKey.get('card/0/line-0'), second = byKey.get('card/0/line-1');
  const pad = heading.bounds[0]-canvas.bounds[0];
  const cardPad = first.bounds[0]-card.bounds[0];
  const lineGap = second.bounds[1]-first.bounds[1]-first.bounds[3];
  const constraints = new Map(fixture.expected.nodes.filter(row=>row.parent==='collection')
    .map(({key,min_width,max_width,basis_width})=>[key,{min_width,max_width,basis_width}]));
  return rows.map((row,index)=>{
    const parent = byKey.get(row.parent);
    const [x,y,width,height] = row.bounds;
    const properties = {name:marker+row.key,x:x-(parent?.bounds[0]??0),y:y-(parent?.bounds[1]??0),width,height,
      fill:row.kind==='text'?'#17243a':'#ffffff'};
    if (row.kind==='text') Object.assign(properties,{text:row.text,fontFamily:row.font_family,fontSize:row.font_size,lineHeight:height+'px'});
    if (row.key==='collection') properties.style={gap:row.gap};
    const adapted = {width:'auto',height:'auto',style:{'flex-shrink':0}};
    if (row.key==='canvas') Object.assign(adapted,{width,style:{display:'flex','flex-direction':'column',...padding(pad)}});
    else if (row.key==='collection') adapted.style={display:'flex','flex-direction':'row','flex-wrap':'wrap',gap:collection.gap,
      'align-items':'flex-start','align-content':'flex-start','justify-content':'flex-start','flex-shrink':0,
      'margin-top':collection.bounds[1]-heading.bounds[1]-heading.bounds[3]};
    else if (constraints.has(row.key)) {
      const spec=constraints.get(row.key);
      for (const value of Object.values(spec)) assert.ok(Number.isFinite(value)&&value>0);
      adapted.style={display:'flex','flex-direction':'column',...padding(cardPad),gap:lineGap,
        'flex-grow':1,'flex-shrink':1,'flex-basis':spec.basis_width,'min-width':spec.min_width,'max-width':spec.max_width};
    } else if (row.key==='heading') {
      const title=byKey.get('title');
      adapted.height=height;
      adapted.style={display:'flex','flex-direction':'column','flex-shrink':0,
        'padding-left':title.bounds[0]-x,'padding-right':x+width-title.bounds[0]-title.bounds[2],
        'padding-top':title.bounds[1]-y,'padding-bottom':y+height-title.bounds[1]-title.bounds[3]};
    } else {
      assert.equal(row.kind,'text');
      adapted.height=height;
      if(row.key==='footer') adapted.style['margin-top']=y-collection.bounds[1]-collection.bounds[3];
    }
    return {key:row.key,parent:row.parent,kind:row.kind,id:nativeId(index+1),properties,adapted};
  });
}

export function normalizeResponsive(raw,scene) {
  assert.equal(raw.pages.length,1);
  assert.equal(scene.truncated,false);
  assert.equal(String(scene.revision),String(raw.sequence));
  const root=raw.pages[0].rootNodeId;
  const aliases=new Map(scene.nodes.map(row=>[row.id,row.rawId]));
  const diagnostic=new Map(scene.diagnostics.map(row=>[aliases.get(row.id),row]));
  const layers=Object.values(raw.nodes).filter(node=>node.id!==root);
  const keys=new Map(layers.map(node=>{
    assert.ok(node.properties.name.startsWith(marker));
    return [node.id,node.properties.name.slice(marker.length)];
  }));
  assert.equal(new Set(keys.values()).size,layers.length);
  const visible=node=>node.properties.locked!==true&&node.properties.visible!==false&&node.properties.hidden!==true;
  const nodes=layers.map(node=>{
    const p=node.properties, s=p.style??{}, d=diagnostic.get(node.id);
    assert.ok(d?.bounds,'Missing native computed layout');
    const {x,y,width,height}=d.bounds;
    const row={key:keys.get(node.id),native_id:node.id,kind:node.kind,parent:node.parentId===root?null:keys.get(node.parentId),
      bounds:[x,y,width,height],editable:visible(node)};
    let current=node, inside=d.clippedText===false;
    while(current.id!==root) {
      row.editable&&=visible(current);
      inside&&=diagnostic.get(current.id)?.overflowParent===false&&visible(current);
      current=raw.nodes[current.parentId];
      assert.ok(current,'Missing parent');
    }
    if(node.kind==='text') Object.assign(row,{text:p.text,font_family:p.fontFamily,font_size:p.fontSize,fully_visible:inside});
    if(node.kind==='frame') {
      row.height_rule=p.height==='auto'?'content':'fixed';
      if(s['min-width']!==undefined) row.min_width=Number(s['min-width']);
      if(s['max-width']!==undefined) row.max_width=Number(s['max-width']);
      if(s['flex-basis']!==undefined) row.basis_width=Number(s['flex-basis']);
      if(row.key==='collection') {
        row.layout=s.display==='flex'&&s['flex-direction']==='row'&&s['flex-wrap']==='wrap'?'horizontal-wrap':'fixed';
        row.gap=Number(s.gap);
        row.align=s['justify-content']===undefined||s['justify-content']==='flex-start'?'start':s['justify-content'];
        const children=layers.filter(child=>child.parentId===node.id);
        row.overflow_x=children.some(child=>{
          const b=diagnostic.get(child.id)?.bounds;
          assert.ok(b);
          return b.x<x-0.01||b.x+b.width>x+width+0.01;
        })?'present':'none';
      }
    }
    return row;
  });
  return {document_id:raw.id,nodes,styles:[]};
}

async function execute(fixture,registrationPath,save,report,profile,signal) {
  const plan=planResponsive(fixture);
  const binary=join(process.env.OMC_BENCH_BIN_DIR??'/Applications/Oh My Canvas.app/Contents/MacOS','omc-service');
  report.binarySha256=sha(await readFile(binary));
  let service=await startService(binary,profile,signal);
  const rpc=(...args)=>service.rpc(...args);
  const snapshot=documentId=>rpc('document.snapshot',{documentId});
  async function command(raw,body) {
    const requestId=randomUUID();
    const receipt=await rpc('document.command',{envelope:{protocol:'omc.engine/1',requestId,idempotencyKey:requestId,
      documentId:raw.id,targetEpoch:raw.epoch,preconditions:{revision:{epoch:raw.epoch,sequence:raw.sequence}},command:body}});
    assert.equal(receipt.status,'durable');
    return receipt;
  }
  async function capture(label,documentId) {
    await rpc('workspace.open',{documentId});
    const raw=await snapshot(documentId);
    const scene=await rpc('tool.call',{name:'get_tree',arguments:{documentId:assetToolDocumentId(documentId),depth:6,detail:'detailed'}});
    await save(label+'-native.json',{raw,scene});
    return normalizeResponsive(raw,scene);
  }
  try {
    const original=(await rpc('workspace.create',{title:'Synthetic LD04 '+fixture.source_family_id})).id;
    const initial=await snapshot(original), root=initial.nodes[initial.pages[0].rootNodeId];
    const ids=new Map(plan.map(row=>[row.key,row.id]));
    const ranks=new Map();
    const nodes=plan.map(row=>{
      const rank=(ranks.get(row.parent)??0)+1; ranks.set(row.parent,rank);
      return {id:row.id,parentId:ids.get(row.parent)??root.id,kind:row.kind,homeShard:root.homeShard,
        rank:rank.toString(16).padStart(8,'0')+'0'.repeat(24),properties:row.properties};
    });
    await command(initial,{type:'node.createMany',nodes});
    report.before=await capture('before',original);
    report.adaptReceipt=await command(await snapshot(original),{type:'batch',commands:plan.flatMap(row=>[
      {type:'node.unset',nodeId:row.id,properties:['x','y']},
      {type:'node.set',nodeId:row.id,properties:row.adapted}])});
    await rpc('document.save',{documentId:original});
    report.candidate=await capture('candidate',original);
    report.candidateFrozenSha256=sha(JSON.stringify(report.candidate));
    await service.stop(); assert.equal(service.child.exitCode,0);
    service=await startService(binary,profile,signal);
    report.reopened=await capture('reopened',original);
    const copy=await service.run('file.duplicate');
    const copyId='doc_'+copy.id.replaceAll('-',''); assert.notEqual(copyId,original);
    // The private width is first opened after adaptation, persistence and candidate freeze.
    const registration=JSON.parse(await readFile(registrationPath,'utf8'));
    assert.deepEqual(Object.keys(registration).sort(),['nonce','width']);
    const {width,nonce}=registration;
    assert.ok(Number.isInteger(width)&&width>390&&width<1440&&width!==768);
    assert.ok(typeof nonce==='string'&&nonce.trim().length>=16);
    const commitment=sha(JSON.stringify(['omc-ld04-width/1',fixture.source_family_id,nonce,width]));
    assert.equal(commitment,fixture.withheld_width_commitment);
    report.withheld_width_commitment=commitment;
    report.probe_actions=[]; report.width_observations=[];
    for(const target of [768,390,width,1440]) {
      const raw=await snapshot(copyId);
      const canvas=Object.values(raw.nodes).find(node=>node.properties.name===marker+'canvas');
      assert.ok(canvas);
      await command(raw,{type:'node.set',nodeId:canvas.id,properties:{width:target}});
      const observed=await capture('width-'+target,copyId);
      report.width_observations.push({width:target,...observed});
      report.probe_actions.push({op:'set_node',key:'canvas',property:'width',value:target});
      report.probe=observed;
    }
    report.after_probe_original=await capture('protected',original);
    report.status='awaiting-canonical-grade';
    if(process.env.OMC_BENCH_CANDIDATE) await publishCandidate(process.env.OMC_BENCH_CANDIDATE,report);
  } finally { await service.stop(); }
}

async function main() {
  const [fixturePath,registrationPath,output,...extra]=process.argv.slice(2);
  assert.ok(output&&!extra.length,'Supply canonical LD04 fixture, private registration and new output directory');
  const fixture=JSON.parse(await readFile(fixturePath,'utf8'));
  await mkdir(output,{mode:0o700});
  const save=(name,data)=>writeFile(join(output,name),JSON.stringify(data,null,2)+'\n',{flag:'wx',mode:0o600});
  const profile=await mkdtemp(join(tmpdir(),'omc-ld04-'));
  const controller=new AbortController();
  for(const event of ['SIGINT','SIGTERM']) process.once(event,()=>controller.abort(new Error(event)));
  const report={workload:'LD04',variant:fixture.source_family_id,fixtureSha256:fixture.fixture_sha256,
    measurementKind:'installed-native-responsive-flex',fontBytesVerified:false};
  try { await execute(fixture,registrationPath,save,report,profile,controller.signal); }
  catch(error) { Object.assign(report,{status:'failed',error:error.stack}); process.exitCode=1; }
  finally { await rm(profile,{recursive:true,force:true,maxRetries:10}); await save('observations.json',report); }
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) await main();
