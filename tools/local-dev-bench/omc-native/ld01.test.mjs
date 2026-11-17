import assert from 'node:assert/strict';
import test from 'node:test';
import {dashboardNodes,normalizeDashboard} from './ld01.mjs';

test('dashboard preserves nested local placement and requires registered image bytes',()=>{
  const fixture={workload:'LD01',logical_objects:2,expected:{nodes:[
    {key:'dashboard',kind:'frame',parent:null,bounds:[40,30,400,300]},
    {key:'photo',kind:'image',parent:'dashboard',bounds:[56,54,120,80],asset_rgba_sha256:'pixel-hash'},
  ]}};
  const root={id:'root',homeShard:'shard'};
  const nodes=dashboardNodes(fixture,root,new Map([['pixel-hash','a'.repeat(64)]]));
  assert.equal(nodes[1].parentId,nodes[0].id);
  assert.deepEqual([nodes[1].properties.x,nodes[1].properties.y],[16,24]);
  assert.throws(()=>dashboardNodes(fixture,root,new Map()));
});

test('dashboard reports native geometry and stored asset identity and rejects stale scenes',()=>{
  const raw={id:'doc',sequence:7,pages:[{rootNodeId:'root'}],nodes:{
    root:{id:'root'},
    image:{id:'image',kind:'image',parentId:'root',properties:{name:'LD01 photo',
      x:1,y:2,width:3,height:4,assetHash:'stored-hash',locked:true}},
  }};
  const scene={revision:7,truncated:false,nodes:[{id:'alias',rawId:'image'}],
    diagnostics:[{id:'alias',bounds:{x:21,y:22,width:23,height:24}}]};
  const pixels=new Map([['stored-hash','observed-pixels']]);
  const result=normalizeDashboard(raw,scene,pixels);
  assert.deepEqual(result.nodes[0].bounds,[21,22,23,24]);
  assert.equal(result.nodes[0].asset_rgba_sha256,'observed-pixels');
  assert.equal(result.nodes[0].editable,false);
  assert.throws(()=>normalizeDashboard(raw,{...scene,revision:6},pixels));
  assert.throws(()=>normalizeDashboard(raw,{...scene,truncated:true},pixels));
  assert.throws(()=>normalizeDashboard(raw,{...scene,diagnostics:[]},pixels));
});
