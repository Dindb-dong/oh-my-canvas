import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {adaptationCommands,normalizeResponsive,planResponsive} from './ld04.mjs';

const generator=fileURLToPath(new URL('../workloads/synthetic.py',import.meta.url));
const fixture=variant=>JSON.parse(execFileSync('python3',[generator,'fixture','LD04','--variant',variant],
  {encoding:'utf8',env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}}));

test('adaptation uses public constraints, never expected positions or private widths',()=>{
  for(const variant of ['street-market','lab-queue']) {
    const source=fixture(variant), baseline=planResponsive(source);
    for(const field of ['responsive_steps','probe_actions','probe']) Object.defineProperty(source,field,{get(){throw Error('Private field read: '+field);}});
    for(const row of source.expected.nodes) Object.defineProperty(row,'bounds',{get(){throw Error('Expected coordinate read');}});
    assert.deepEqual(planResponsive(source),baseline);
    assert.equal(baseline.length,source.logical_objects);
    for(const row of baseline) {
      assert.ok(!('x' in row.adapted)&&!('y' in row.adapted));
      if(row.kind==='text') assert.match(row.properties.lineHeight,/^\d+px$/);
      if(row.parent==='collection') {
        assert.equal(row.adapted.style.width,'auto');
        assert.equal(row.adapted.style.height,'auto');
        assert.ok(row.adapted.style['flex-basis']>0);
        assert.equal(row.adapted.style['flex-grow'],1);
      }
    }
    assert.equal(baseline.find(row=>row.key==='collection').adapted.style['flex-wrap'],'wrap');
  }
});

test('native boundary keeps geometry numeric and unsets baseline dimensions before CSS auto',()=>{
  for(const variant of ['street-market','lab-queue']) {
    const plan=planResponsive(fixture(variant));
    const state=new Map(plan.map(row=>[row.id,structuredClone(row.properties)]));
    for(const command of adaptationCommands(plan)) {
      const properties=state.get(command.nodeId);
      if(command.type==='node.unset') for(const key of command.properties) delete properties[key];
      else Object.assign(properties,command.properties);
      // Mirrors omc-model::validate_properties' native geometry boundary.
      for(const key of ['x','y','width','height']) if(key in properties) assert.ok(Number.isFinite(properties[key]),key);
    }
    for(const row of plan) {
      const p=state.get(row.id);
      if(row.key==='canvas') assert.equal(p.width,1440);
      else { assert.equal(p.width,undefined); assert.equal(p.style.width,'auto'); }
      if(row.kind==='text'||row.key==='heading') assert.ok(Number.isFinite(p.height));
      else { assert.equal(p.height,undefined); assert.equal(p.style.height,'auto'); }
    }
  }
});

function observed() {
  const raw={id:'original',sequence:4,pages:[{rootNodeId:'root'}],nodes:{
    root:{id:'root',properties:{}},
    canvas:{id:'canvas',kind:'frame',parentId:'root',properties:{name:'LD04 canvas',width:390,style:{height:'auto'}}},
    collection:{id:'collection',kind:'frame',parentId:'canvas',properties:{name:'LD04 collection',style:{height:'auto',display:'flex','flex-direction':'row','flex-wrap':'wrap',gap:16}}},
    card:{id:'card',kind:'frame',parentId:'collection',properties:{name:'LD04 card/0',style:{height:'auto','flex-basis':270,'min-width':230,'max-width':360}}},
    text:{id:'text',kind:'text',parentId:'card',properties:{name:'LD04 card/0/line-0',text:'Actual',fontFamily:'Inter',fontSize:14}},
  }};
  const scene={revision:4,truncated:false,nodes:Object.keys(raw.nodes).map(id=>({id:'alias-'+id,rawId:id})),
    diagnostics:Object.keys(raw.nodes).map(id=>({id:'alias-'+id,bounds:{x:0,y:0,width:300,height:20},clippedText:false,overflowParent:false,diagnostics:[]}))};
  return {raw,scene};
}

test('normalization preserves actual geometry and refuses stale or missing layout',()=>{
  const {raw,scene}=observed();
  scene.diagnostics.find(d=>d.id==='alias-card').bounds.x=333;
  const result=normalizeResponsive(raw,scene);
  assert.equal(result.nodes.find(n=>n.key==='card/0').bounds[0],333);
  assert.equal(result.nodes.find(n=>n.key==='collection').overflow_x,'present');
  assert.equal(result.nodes.find(n=>n.key==='card/0').basis_width,270);
  assert.equal(result.nodes.find(n=>n.key==='card/0').height_rule,'content');
  raw.nodes.card.properties.height=80;
  assert.equal(normalizeResponsive(raw,scene).nodes.find(n=>n.key==='card/0').height_rule,'fixed');
  assert.throws(()=>normalizeResponsive(raw,{...scene,revision:3}));
  assert.throws(()=>normalizeResponsive(raw,{...scene,diagnostics:[]}));
});

test('clipping, ancestor overflow and locks cannot become invented visible/editable passes',()=>{
  for(const mutate of [
    ({scene})=>{scene.diagnostics.find(d=>d.id==='alias-text').clippedText=true;},
    ({scene})=>{scene.diagnostics.find(d=>d.id==='alias-card').overflowParent=true;},
    ({raw})=>{raw.nodes.card.properties.hidden=true;},
  ]) {
    const state=observed(); mutate(state);
    assert.equal(normalizeResponsive(state.raw,state.scene).nodes.find(n=>n.kind==='text').fully_visible,false);
  }
  const state=observed(); state.raw.nodes.card.properties.locked=true;
  assert.equal(normalizeResponsive(state.raw,state.scene).nodes.find(n=>n.kind==='text').editable,false);
});
