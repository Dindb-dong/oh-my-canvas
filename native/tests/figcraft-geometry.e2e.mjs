import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const sdk = process.env.OMC_TEST_SDK_ROOT;
const { Client } = await import(sdk
  ? pathToFileURL(join(sdk, 'dist/esm/client/index.js'))
  : '@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = await import(sdk
  ? pathToFileURL(join(sdk, 'dist/esm/client/streamableHttp.js'))
  : '@modelcontextprotocol/sdk/client/streamableHttp.js');
const binaryName = process.platform === 'win32' ? 'omc-service.exe' : 'omc-service';
const binary = process.env.OMC_SERVICE_BINARY
  ?? fileURLToPath(new URL('../target/debug/' + binaryName, import.meta.url));

async function serviceDescriptor(profile, service) {
  for (let attempt = 0; attempt < 200 && service.exitCode === null; attempt++) {
    try {
      return JSON.parse(await readFile(join(profile, 'native-v1/service.json'), 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await delay(25);
  }
  throw new Error('Timed out waiting for the native service descriptor');
}

test('FigCraft geometry commands change the native document through MCP', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'omc-figcraft-geometry-'));
  const service = spawn(binary, ['--profile', profile, '--port', '0'], { stdio: 'inherit' });
  const exited = once(service, 'exit');
  const client = new Client({ name: 'figcraft-geometry-contracts', version: '1.0.0' });
  const call = async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args });
    if (result.isError) throw new Error(result.content[0].text);
    return result.structuredContent ?? JSON.parse(result.content.find(item => item.type === 'text').text);
  };
  const run = (command, params = {}) => call('run_command', { command, params });
  const get = id => call('get_node', { id });
  const approx = (actual, expected) => assert.ok(Math.abs(actual-expected) < 1e-5, `${actual} != ${expected}`);
  try {
    const { endpoint, token } = await serviceDescriptor(profile, service);
    await client.connect(new StreamableHTTPClientTransport(new URL(endpoint + '/mcp/figcraft'), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }));
    await run('file.new', { name: 'Geometry MCP tests' });
    const rect = async (x, y, width = 30, height = 30) =>
      (await call('create_node', {type:'rectangle',x,y,width,height,props:{fill:'#ff0000'}})).id;
    const hits = async (x,y) => (await run('select.layersAt',{x,y})).layers.map(layer=>layer.id);
    const vector = (await run('vector.create', {
      path:'M 2 3 L 12 3 L 12 13 Z M 4 5 L 5 7 L 7 6 Z', x:40,y:50,width:20,
      name:'compound',props:{fill:'#cc4400'},
    })).id;
    const original = await get(vector);
    assert.equal(original.type,'VECTOR');
    assert.equal(original.x,42);
    assert.equal(original.y,53);
    assert.equal(original.width,20);
    assert.equal(original.height,20);
    assert.match(original.path,/^M/);
    await run('vector.fillRule',{id:vector,rule:'evenOdd',region:0});
    assert.equal((await get(vector)).fillRule,'evenodd');
    await run('vector.reverseLoop',{id:vector,region:0,loop:1});
    assert.notEqual((await get(vector)).path,original.path);
    const reverseOne = (await get(vector)).path;
    await run('vector.reverse',{ids:[vector]});
    assert.notEqual((await get(vector)).path,reverseOne);
    await call('undo');
    assert.equal((await get(vector)).path,reverseOne);
    const a=await rect(10,10);
    const b=await rect(30,10);
    const group=(await run('bool.union',{ids:[a,b]})).id;
    assert.equal((await get(group)).booleanOperation,'union');
    assert.ok((await hits(47,20)).includes(group));
    await run('bool.subtract',{ids:[b]});
    assert.equal((await get(b)).booleanOperandOperation,'subtract');
    assert.ok(!(await hits(47,20)).includes(group));
    await run('bool.intersect',{ids:[group]});
    assert.equal((await get(group)).booleanOperation,'intersect');
    assert.equal((await get(b)).booleanOperandOperation,undefined);
    assert.ok((await hits(35,20)).includes(group));
    assert.ok(!(await hits(15,20)).includes(group));
    await run('bool.exclude',{ids:[group]});
    assert.ok(!(await hits(35,20)).includes(group));
    assert.ok((await hits(15,20)).includes(group));
    const flat=(await run('bool.flatten',{ids:[group]})).id;
    assert.ok((await get(flat)).path);
    assert.equal((await get(group)).visible,false);
    const raw=(await run('vector.flatten',{ids:[await rect(100,20)]})).id;
    assert.ok((await get(raw)).path);
    const line=(await run('vector.create',{points:[[10,140],[60,140]],props:{stroke:'#020202',strokeWeight:5}})).id;
    const outlined=(await run('vector.outlineStroke',{ids:[line]})).id;
    assert.ok((await get(outlined)).path);
    assert.equal((await get(line)).visible,false);

    const noisy=(await run('vector.create',{points:[[0,0],[10,0.02],[20,0],[30,5]],x:200,y:190})).id;
    const noisyBefore=(await get(noisy)).path;
    await run('vector.simplify',{ids:[noisy],tolerance:0.1});
    assert.ok((await get(noisy)).path.length<noisyBefore.length);
    const base=await rect(100,100,20,20);
    const offset=(await run('vector.offset',{ids:[base],offset:5})).id;
    assert.equal((await get(offset)).width,30);
    assert.ok((await hits(97,110)).includes(offset));
    const open=(await run('vector.create',{points:[[0,0],[10,0],[15,5]]})).id;
    const other=(await run('vector.create',{points:[[16,5],[25,10],[30,6]]})).id;
    await run('vector.join',{ids:[open,other]});
    assert.match((await get(open)).path,/30 6/);
    await assert.rejects(get(other));
    await run('vector.smoothJoin',{ids:[open]});
    assert.match((await get(open)).path,/C.*Z/);

    const back=await rect(10,310,40,30);
    const front=await rect(30,310,40,30);
    const regions=await run('shapeBuilder.regions',{ids:[front,back]});
    assert.deepEqual(regions.sources,[back,front]);
    assert.equal(regions.regions.length,3);
    const common=regions.regions.find(region=>region.sources.length===2);
    assert.deepEqual(common.sources,[front,back]);
    assert.deepEqual(common.bounds,[30,310,20,30]);
    assert.equal((await run('shapeBuilder.mode',{mode:'merge'})).mode,'merge');
    const merge=await run('shapeBuilder.merge',{ids:[back,front],regions:[common.index]});
    assert.ok((await hits(35,320)).includes(merge.id));
    assert.equal((await get(back)).visible,false);
    const remaining=merge.changed.find(Boolean);
    assert.ok(remaining);
    const remove=await run('shapeBuilder.remove',{ids:[merge.id],points:[[35,320]]});
    assert.deepEqual(remove.removed,[merge.id]);
    assert.ok(!(await hits(35,320)).includes(merge.id));
    const liveStroke=(await run('vector.create',{points:[[100,340],[130,340]],props:{stroke:'#222222',strokeWeight:4}})).id;
    const lineRegion=(await run('shapeBuilder.regions',{ids:[liveStroke]})).regions;
    assert.equal(lineRegion[0].parts[0].stroke,true);

    const autoFrame=(await call('create_node',{type:'frame',x:500,y:60,width:160,height:60})).id;
    const autoChild=async (x)=>
      (await call('create_node',{type:'rectangle',parent:autoFrame,x,y:10,width:30,height:20})).id;
    const leftChild=await autoChild(10);
    const rightChild=await autoChild(60);
    await run('layout.add',{ids:[autoFrame],direction:'horizontal'});
    assert.deepEqual((await get(autoFrame)).children.map(child=>child.id),[leftChild,rightChild]);
    await run('select.set',{ids:[leftChild]});
    await run('transform.nudge',{dx:1});
    assert.deepEqual((await get(autoFrame)).children.map(child=>child.id),[rightChild,leftChild]);
    await run('transform.nudge',{dx:1});
    assert.deepEqual((await get(autoFrame)).children.map(child=>child.id),[rightChild,leftChild]);

    const shape=await rect(180,70,20,30);
    await run('transform.move',{ids:[shape],dx:10,dy:5});
    assert.deepEqual([(await get(shape)).x,(await get(shape)).y],[190,75]);
    await run('transform.moveTo',{ids:[shape],x:200,y:90});
    assert.deepEqual([(await get(shape)).x,(await get(shape)).y],[200,90]);
    await run('select.set',{ids:[shape]});
    await run('transform.nudge',{dx:1,dy:-1,big:true});
    assert.deepEqual([(await get(shape)).x,(await get(shape)).y],[210,80]);
    await run('transform.nudgeSize',{dw:1,dh:2});
    assert.deepEqual([(await get(shape)).width,(await get(shape)).height],[21,32]);
    await run('transform.resize',{ids:[shape],width:31,height:42,anchor:'br'});
    assert.deepEqual([(await get(shape)).x,(await get(shape)).y],[200,70]);
    approx((await get(shape)).width,31);
    approx((await get(shape)).height,42);
    assert.equal((await run('transform.rotationOrigin',{on:true})).on,true);
    assert.deepEqual((await run('transform.setRotationOrigin',{x:200,y:70})).point,[200,70]);
    await run('transform.rotate',{ids:[shape],degrees:90});
    assert.ok((await hits(190,75)).includes(shape));
    assert.ok(!(await hits(205,75)).includes(shape));
    await run('transform.setRotationOrigin',{reset:true});
    await run('transform.scale',{ids:[shape],factor:2,cx:200,cy:70});
    assert.ok((await hits(130,100)).includes(shape));
    await assert.rejects(run('transform.scale',{ids:[shape],factor:0}));

    const p=(await run('vector.create',{points:[[5,5],[15,15],[25,5],[35,25]],x:290,y:190})).id;
    const q=(await run('vector.create',{points:[[5,5],[15,15],[25,5]],x:390,y:190})).id;
    const begin=await run('vector.edit.begin',{ids:[p,q]});
    assert.deepEqual(begin.ids,[p,q]);
    const edit=()=>run('vector.edit.state');
    const point=async i=>(await edit()).vertices[i].point;
    assert.deepEqual(await point(0),[295,195]);
    assert.equal((await run('vector.edit.tool',{tool:'bend'})).tool,'bend');
    assert.equal((await edit()).tool,'bend');
    await run('vector.edit.select',{vertices:[0,1]});
    assert.equal((await run('vector.edit.bounds')).points,2);
    await run('vector.edit.moveVertices',{vertices:[0],dx:2,dy:3});
    assert.deepEqual(await point(0),[297,198]);
    await run('vector.edit.nudge',{dx:1,dy:0});
    assert.deepEqual(await point(0),[298,198]);
    await run('vector.edit.position',{x:300});
    assert.deepEqual(await point(0),[300,198]);
    await run('vector.edit.mirroring',{mode:'angleAndLength',vertices:[1]});
    assert.equal((await edit()).vertices[1].mirroring,'angleAndLength');
    await run('vector.edit.setHandle',{segment:0,start:false,x:11,y:9});
    assert.deepEqual((await edit()).network.segments[0].endHandle,[11,9]);
    await run('vector.edit.moveHandles',{handles:[[0,false]],dx:2,dy:-3,independent:true});
    assert.deepEqual((await edit()).network.segments[0].endHandle,[13,6]);
    await run('vector.edit.smooth',{vertices:[1]});
    assert.notDeepEqual((await edit()).network.segments[0].endHandle,[13,6]);
    await run('vector.edit.addVertex',{segment:1,t:0.5});
    assert.equal((await edit()).vertices.length,5);
    await run('vector.deleteHeal',{vertices:[2]});
    assert.equal((await edit()).vertices.length,4);
    assert.equal((await run('vector.edit.lasso',{points:[[295,190],[306,190],[306,205],[295,205]]})).selected,1);
    await run('vector.edit.select',{vertices:[0,1]});
    await run('vector.edit.resize',{width:35,height:15});
    const bounds=await run('vector.edit.bounds');
    approx(bounds.width,35);
    approx(bounds.height,15);
    await run('vector.edit.transform',{matrix:[1,0,0,1,3,4],vertices:[0]});
    assert.deepEqual(await point(0),[303,202]);
    await run('vector.edit.rotate',{angle:90,cx:300,cy:200});
    const rotated=await point(0);
    approx(rotated[0],302);
    approx(rotated[1],197);
    await run('vector.edit.selectAll');
    await run('vector.edit.nudge',{dx:3,dy:0});
    await run('vector.edit.select',{id:q,vertices:[0]});
    assert.deepEqual(await point(0),[398,195]);
    await run('vector.edit.delete',{segments:[0]});
    assert.equal((await edit()).segments.length,1);
    await run('vector.edit.select',{id:p,vertices:[0]});
    await run('vector.edit.bend',{segment:0,t:0.5,x:325,y:185});
    const bent=await edit();
    const [v0,v1]=bent.vertices;
    const {startHandle,endHandle}=bent.segments[0];
    for(const [axis,target] of [[0,325],[1,185]]) {
      approx((v0.point[axis]+3*startHandle[axis]+3*endHandle[axis]+v1.point[axis])/8,target);
    }
    const lastVertex=(await edit()).vertices.length-1;
    await run('vector.edit.connect',{a:lastVertex,b:0});
    assert.equal((await edit()).segments.at(-1).end,0);
    await run('vector.edit.pen',{x:350,y:270});
    const pen=(await run('vector.edit.pen',{x:365,y:285,dx:5,dy:0})).pen;
    assert.deepEqual((await edit()).vertices[pen].point,[365,285]);
    assert.equal((await run('vector.edit.penEnd')).pen,null);
    const cutter=(await run('vector.create',{points:[[0,0],[40,0],[40,40],[0,40]],closed:true,x:450,y:270,props:{fill:'#123456'}})).id;
    await run('vector.edit.begin',{id:cutter});
    await run('vector.edit.paint',{x:465,y:285});
    assert.deepEqual((await get(cutter)).fills,[]);
    await run('vector.edit.paint',{points:[[465,285],[468,290]]});
    assert.equal((await get(cutter)).fills[0].color,'#123456');
    await run('vector.edit.cut',{from:[470,260],to:[470,320]});
    assert.equal((await get(cutter)).path.match(/M/g).length,2);
    const openCut=(await run('vector.create',{points:[[0,0],[20,0],[40,20]],x:490,y:200})).id;
    await run('vector.edit.begin',{id:openCut});
    await run('vector.edit.cut',{segment:0,t:0.5});
    assert.equal((await get(openCut)).path.match(/M/g).length,2);
    const erased=(await run('vector.create',{points:[[0,0],[60,20]],x:500,y:210})).id;
    await run('vector.edit.begin',{id:erased});
    await run('vector.edit.erase',{points:[[530,220]],radius:5});
    assert.equal((await get(erased)).path.match(/M/g).length,2);
    const round=(await run('vector.create',{points:[[0,0],[40,0],[40,40],[0,40]],closed:true,x:550,y:270,props:{fill:'#ff0000'}})).id;
    await run('vector.edit.begin',{id:round});
    assert.ok((await hits(552,272)).includes(round));
    await run('vector.edit.cornerRadius',{vertices:[0],radius:12});
    assert.ok(!(await hits(552,272)).includes(round));
    assert.ok((await hits(570,290)).includes(round));
    const stroke=(await run('vector.create',{points:[[0,0],[25,35],[50,0]],x:580,y:150,props:{stroke:'#102030',strokeWeight:6}})).id;
    await run('vector.edit.begin',{id:stroke});
    const renderStroke=async()=> (await call('export',{ids:[stroke],format:'png'})).base64;
    const basicStroke=await renderStroke();
    assert.ok(basicStroke?.length>100);
    await run('vector.edit.strokeCap',{vertices:[0],cap:'circleFilled'});
    const capped=await renderStroke();
    assert.notEqual(capped,basicStroke);
    await run('vector.edit.strokeJoin',{vertices:[1],join:'bevel'});
    assert.notEqual(await renderStroke(),capped);
    await run('vector.edit.strokeCap',{vertices:[0],cap:null});
    await run('vector.edit.strokeJoin',{vertices:[1],join:null});
    assert.equal(await renderStroke(),basicStroke);
    await run('vector.edit.widthPoint',{t:0.5,width:18,side:'left'});
    const variable=await renderStroke();
    assert.notEqual(variable,basicStroke);
    await run('vector.edit.widthPoint',{action:'set',index:0,scale:1.5});
    assert.notEqual(await renderStroke(),variable);
    await run('vector.edit.widthPoint',{action:'remove',index:0});
    assert.equal(await renderStroke(),basicStroke);
    assert.equal((await run('vector.edit.end')).editing,false);
    assert.equal((await edit()).editing,false);
    await assert.rejects(run('vector.edit.nudge',{dx:1,dy:1}));
    await run('file.new',{name:'Thumbnail source'});
    const thumbnailFrame=(await call('create_node',{
      type:'frame',name:'Preview frame',width:100,height:60,props:{fill:'#884422'},
    })).id;
    await run('object.setThumbnail',{id:thumbnailFrame});
    const rpc=async (method,params={},session)=> {
      const response=await fetch(endpoint+'/rpc',{
        method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json',
          ...(session?{'X-OMC-Session':session}:{})},body:JSON.stringify({id:'thumbnail',method,params}),
      });
      const body=await response.json();
      assert.ok(!body.error,JSON.stringify(body.error));
      return body.result;
    };
    const rpcSession=(await rpc('session.open')).sessionId;
    const thumbnail=async()=> (await rpc('workspace.list',{thumbnails:true},rpcSession))
      .documents.find(doc=>doc.title==='Thumbnail source').thumbnail;
    const thumbnailPng=Buffer.from(await thumbnail(),'base64');
    assert.equal(thumbnailPng.subarray(1,4).toString(),'PNG');
    assert.equal(thumbnailPng.readUInt32BE(16),128);
    const archive=Buffer.from((await run('file.saveAs',{data:true})).data,'base64');
    assert.ok(archive.includes(Buffer.from('thumbnail.png')));
    assert.ok(archive.includes(thumbnailPng));
    await run('fill.set',{ids:[thumbnailFrame],index:0,color:'#008811'});
    assert.notEqual(await thumbnail(),thumbnailPng.toString('base64'));
    await call('undo');
    assert.equal(await thumbnail(),thumbnailPng.toString('base64'));
    await call('undo');
    assert.equal(await thumbnail(),undefined);
    for (const tool of ['tool.pen','tool.pencil','tool.shapeBuilder']) {
      const polling=rpc('desktop.poll',{},rpcSession);
      await delay(40);
      const pending=run(tool);
      const job=await polling;
      assert.equal(job.method,tool);
      await rpc('desktop.complete',{id:job.id,result:{tool:tool.split('.')[1]}},rpcSession);
      assert.equal((await pending).tool,tool.split('.')[1]);
    }
    for (const [name,x] of [['Desktop left',70],['Desktop right',90]]) {
      await call('create_node',{type:'rectangle',name,x,y:90,width:40,height:35,props:{fill:'#5544aa'}});
    }
    const document=(await rpc('workspace.list',{},rpcSession)).documents.find(doc=>doc.title==='Thumbnail source');
    const desktop=await rpc('workspace.open',{documentId:document.id},rpcSession);
    const shapeLayers=Object.values(desktop.nodes).filter(node=>['Desktop left','Desktop right'].includes(node.properties.name));
    const gesture={documentId:desktop.id,epoch:desktop.epoch,sequence:String(desktop.sequence),
      page:desktop.pages[0].id,layers:shapeLayers.map(layer=>layer.id),points:[[100,100]],remove:false};
    const result=await rpc('document.shapeBuilder',gesture,rpcSession);
    assert.equal(result.nativeSelection.length,1);
    const mergedDoc=await rpc('document.snapshot',{documentId:desktop.id},rpcSession);
    const mergedNode=mergedDoc.nodes[result.nativeSelection[0]];
    assert.equal(mergedNode.properties.name,'Shape builder');
    assert.deepEqual([mergedNode.properties.x,mergedNode.properties.y,mergedNode.properties.width,mergedNode.properties.height],[90,90,20,35]);
    await assert.rejects(rpc('document.shapeBuilder',gesture,rpcSession),/stale_revision/);
    const removedRegion=await rpc('document.shapeBuilder',{
      ...gesture,sequence:String(mergedDoc.sequence),layers:result.nativeSelection,remove:true,
    },rpcSession);
    assert.deepEqual(removedRegion.nativeSelection,[]);
    const removedDoc=await rpc('document.snapshot',{documentId:desktop.id},rpcSession);
    assert.equal(removedDoc.nodes[mergedNode.id].properties.visible,false);
    await rpc('session.close',{},rpcSession);

    const first=await rect(20,150);
    const second=await rect(70,150);
    await run('object.rename',{ids:[first],name:'카드 41'});
    await run('object.rename',{ids:[second],name:'카드 42'});
    await run('stroke.add',{ids:[first],color:'#0000ff'});
    assert.equal((await get(first)).name,'카드 41');
    const renamed=await run('object.batchRename',{
      ids:[second,first],find:'(카드) (4)(.)',regex:true,replace:'$1-$3',name:'$nn/$NN $& $$',start:7,
    });
    assert.deepEqual(renamed.names,[{id:first,name:'07/08 카드-1 $'},{id:second,name:'08/07 카드-2 $'}]);
    assert.equal((await get(second)).name,'08/07 카드-2 $');
    await call('undo');
    assert.equal((await get(first)).name,'카드 41');
    const paintPng=async id=> (await call('export',{ids:[id],format:'png'})).base64;
    const beforeSwap=await paintPng(first);
    await run('object.swapFillStroke',{ids:[first]});
    const swapped=await get(first);
    assert.equal(swapped.fills[0].color.toLowerCase(),'#0000ff');
    assert.equal(swapped.strokes[0].color.toLowerCase(),'#ff0000');
    assert.notEqual(await paintPng(first),beforeSwap);
    await call('undo');
    assert.equal(await paintPng(first),beforeSwap);

    const colored=(await call('create_node',{type:'frame',x:120,y:240,width:160,height:60})).id;
    const colorChild=(await call('create_node',{
      type:'rectangle',parent:colored,x:10,y:10,width:20,height:20,props:{fill:'#ff0000'},
    })).id;
    const colorResult=await run('selection.colors',{ids:[colored,colorChild,first,second]});
    const red=colorResult.colors.find(group=>group.paint.color?.toLowerCase()==='#ff0000');
    assert.deepEqual(red.targets.map(target=>target.id),[colorChild,first,second]);
    const chosen=await run('selection.selectColor',{targets:red.targets});
    assert.deepEqual(chosen.ids,[first,second,colorChild]);
    assert.deepEqual((await run('selection.colors')).colors.find(group=>group.paint.color?.toLowerCase()==='#ff0000')
      .targets.map(target=>target.id),chosen.ids);
    await assert.rejects(run('selection.selectColor',{targets:[{...red.targets[0],index:500}]}));

    const style=(await run('selection.createColorStyle',{
      targets:red.targets,name:'Accent selection',description:'Selection style test',
    })).id;
    assert.ok(style);
    assert.equal((await run('selection.colors',{ids:[colorChild]})).colors[0].style,style);
    await assert.rejects(run('selection.createColorStyle',{targets:red.targets,name:'Accent selection'}));
    await run('style.update',{style,value:'#22aa88'});
    assert.equal((await run('selection.colors',{ids:[colorChild]})).colors[0].paint.color,'#22AA88');
    const alternate=(await run('style.create',{type:'paint',name:'Alternate selection',value:'#224466'})).id;
    const firstFill=red.targets.find(target=>target.id===first);
    await run('selection.applyColorStyle',{targets:[firstFill],style:'Alternate selection'});
    assert.equal((await run('selection.colors',{ids:[first]})).colors.find(group=>group.targets[0].fills).style,alternate);
    const collection=(await run('variable.createCollection',{name:'Selection tokens'})).id;
    const accentVariable=(await run('variable.create',{collection,name:'Accent variable',type:'color',value:'#c45c30'})).id;
    const linkedPng=await paintPng(first);
    await run('selection.bindColorVariable',{targets:[firstFill],variable:'Accent variable'});
    const bound=(await run('selection.colors',{ids:[first]})).colors.find(group=>group.targets[0].fills);
    assert.equal(bound.style,null);
    assert.equal(bound.variable,accentVariable);
    assert.notEqual(await paintPng(first),linkedPng);
    await run('variable.set',{variable:accentVariable,value:'#714523'});
    const variablePng=await paintPng(first);
    await run('selection.detachColor',{targets:[firstFill]});
    const detached=(await run('selection.colors',{ids:[first]})).colors.find(group=>group.targets[0].fills);
    assert.equal(detached.style,null);
    assert.equal(detached.variable,null);
    assert.equal(await paintPng(first),variablePng);
    await run('variable.set',{variable:accentVariable,value:'#229999'});
    assert.equal(await paintPng(first),variablePng);

    const rich=(await call('create_node',{type:'text',text:'한글🙂ABC',x:330,y:100,width:120,height:50})).id;
    await run('text.style',{id:rich,start:0,end:3,fontSize:24,
      textFills:[{type:'solid',color:'#a44444'}]});
    const richColors=(await run('selection.colors',{ids:[rich]})).colors;
    const paintedRange=richColors.find(group=>group.targets[0].range?.join(',')==='0,3').targets;
    const richBefore=await paintPng(rich);
    await run('selection.applyColorStyle',{targets:paintedRange,style:alternate});
    assert.notEqual(await paintPng(rich),richBefore);
    const richRun=(await get(rich)).textRuns.find(run=>run.text==='한글🙂');
    assert.equal(richRun.attributes.fontSize,24);
    assert.match(richRun.attributes.fill,/rgba\(34, 68, 102,/);
    await run('selection.bindColorVariable',{targets:paintedRange,variable:accentVariable});
    const rangeAfterBind=await paintPng(rich);
    await run('variable.set',{variable:accentVariable,value:'#772244'});
    assert.equal(await paintPng(rich),rangeAfterBind);

    const imageSource=await rect(120,160,80,40);
    await run('node.set',{id:imageSource,props:{fill:'#112255'}});
    const pngData=await paintPng(imageSource);
    const placed=(await run('image.place',{data:pngData,x:240,y:190,width:60,height:60,mode:'fit'})).id;
    const fit=await paintPng(placed);
    const crop=await run('image.crop',{id:placed});
    assert.equal(crop.index,0);
    assert.deepEqual(crop.crop,[0,0.25,1,0.5]);
    assert.deepEqual((await get(placed)).imageCrop,crop.crop);
    assert.equal(await paintPng(placed),fit);
    await run('image.crop',{ids:[placed],crop:[0,0,1,1]});
    assert.notEqual(await paintPng(placed),fit);
    await call('undo');
    assert.equal(await paintPng(placed),fit);
    const imageFill=await rect(360,190,60,60);
    await run('image.place',{target:imageFill,data:pngData,mode:'fit'});
    const fitFill=await paintPng(imageFill);
    assert.equal((await run('image.crop',{ids:[imageFill]})).index,1);
    assert.equal((await get(imageFill)).fills[1].mode,'crop');
    assert.equal(await paintPng(imageFill),fitFill);
    await run('image.crop',{id:imageFill,index:1,crop:[0,0,1,1]});
    assert.notEqual(await paintPng(imageFill),fitFill);
    await assert.rejects(run('image.crop',{ids:[imageFill],index:0}));

    await run('file.new',{name:'Object geometry tests'});
    const triangle=(await run('vector.create',{points:[[0,0],[40,0],[0,40]],closed:true,x:10,y:10})).id;
    assert.ok((await hits(15,45)).includes(triangle));
    await run('object.flipH',{ids:[triangle]});
    assert.ok(!(await hits(15,45)).includes(triangle));
    assert.ok((await hits(45,45)).includes(triangle));
    await run('object.flipV',{ids:[triangle]});
    assert.ok(!(await hits(15,15)).includes(triangle));
    assert.ok((await hits(45,15)).includes(triangle));
    await run('object.rotate180',{ids:[triangle]});
    assert.ok((await hits(15,15)).includes(triangle));
    await run('object.rotateRight',{ids:[triangle]});
    assert.ok((await hits(45,15)).includes(triangle));
    await run('object.rotateLeft',{ids:[triangle]});
    assert.ok((await hits(15,15)).includes(triangle));
    const frame=(await call('create_node',{type:'frame',name:'Fit frame',x:100,y:100,width:100,height:100})).id;
    const kid=(await call('create_node',{type:'rectangle',parent:frame,x:20,y:30,width:40,height:20,props:{fill:'#228844'}})).id;
    await run('object.resizeToFit',{ids:[frame]});
    const fitted=await get(frame);
    assert.deepEqual([fitted.x,fitted.y,fitted.width,fitted.height],[120,130,40,20]);
    assert.deepEqual([(await get(kid)).x,(await get(kid)).y],[0,0]);
    assert.ok((await hits(125,135)).includes(kid));
    await run('object.convertToSection',{ids:[frame]});
    assert.equal((await get(frame)).type,'SECTION');
    await run('object.convertToFrame',{ids:[frame]});
    assert.equal((await get(frame)).type,'FRAME');
    await run('object.convertToGroup',{ids:[frame]});
    assert.equal((await get(frame)).type,'GROUP');
    assert.ok((await hits(125,135)).includes(kid));
    await run('object.convertToFrame',{ids:[frame]});
    assert.equal((await get(frame)).type,'FRAME');
    assert.deepEqual((await get(frame)).children.map(n=>n.id),[kid]);
    const aSection=await rect(260,130,20,20);
    const bSection=await rect(290,135,25,25);
    const section=(await run('object.wrapInSection',{ids:[aSection,bSection],name:'Section wrapper'})).id;
    assert.equal((await get(section)).type,'SECTION');
    assert.deepEqual((await get(section)).children.map(n=>n.id),[aSection,bSection]);
    assert.ok((await hits(265,135)).includes(aSection));
    await run('section.toggleContents',{ids:[section],hidden:true});
    assert.ok(!(await hits(265,135)).includes(aSection));
    assert.ok((await hits(265,135)).includes(section));
    await run('section.toggleContents',{ids:[section]});
    assert.ok((await hits(265,135)).includes(aSection));
    const rasterSource=await rect(180,300,20,30);
    const rasterBefore=(await call('export',{ids:[rasterSource],format:'png'})).base64;
    const raster=(await run('object.rasterize',{ids:[rasterSource],scale:2})).id;
    assert.equal((await get(raster)).type,'IMAGE');
    await assert.rejects(get(rasterSource));
    assert.equal((await call('export',{ids:[raster],format:'png'})).base64,rasterBefore);
    await call('undo');
    assert.equal((await get(rasterSource)).type,'RECTANGLE');
    const home=(await run('page.list')).find(page=>page.current).id;
    const next=(await run('page.add',{name:'Destination'})).id;
    await run('page.select',{id:home});
    await run('object.moveToPage',{ids:[section,aSection],page:next});
    assert.ok(!(await hits(265,135)).includes(section));
    await run('page.select',{id:next});
    assert.ok((await hits(265,135)).includes(aSection));
    assert.deepEqual((await get(section)).children.map(n=>n.id),[aSection,bSection]);

    await run('file.new',{name:'Published selection palette'});
    await run('style.create',{type:'paint',name:'Published green',value:'#338866'});
    await run('library.publish');
    const paletteFile=join(profile,'palette.figcraft');
    await run('file.saveAs',{path:paletteFile});
    await run('file.new',{name:'Selection palette consumer'});
    const palette=(await run('library.add',{path:paletteFile})).id;
    const consumer=await rect(10,20);
    const consumerTargets=(await run('selection.colors',{ids:[consumer]})).colors[0].targets;
    const consumerBefore=await paintPng(consumer);
    await run('selection.applyColorStyle',{library:palette,style:'Published green',targets:consumerTargets});
    const linked=(await run('selection.colors',{ids:[consumer]})).colors[0];
    assert.equal(linked.paint.color,'#338866');
    assert.ok(linked.style);
    assert.notEqual(await paintPng(consumer),consumerBefore);

    await run('file.new',{name:'Component slots'});
    const template=(await call('create_node',{type:'frame',name:'Card',x:10,y:20,width:140,height:80})).id;
    const slotFrame=(await call('create_node',{type:'frame',name:'Media',parent:template,x:10,y:10,width:60,height:55})).id;
    const fallback=(await call('create_node',{type:'rectangle',name:'Default content',parent:slotFrame,
      x:0,y:0,width:30,height:25,props:{fill:'#aa3311'}})).id;
    const card=(await run('component.create',{ids:[template]})).id;
    const artFrame=(await call('create_node',{type:'frame',name:'Artwork',x:10,y:140,width:35,height:25,
      props:{fill:'#0044dd'}})).id;
    const art=(await run('component.create',{ids:[artFrame]})).id;
    const slotMade=await run('component.makeSlot',{id:slotFrame,name:'Photo',preferred:[art]});
    assert.equal(slotMade.name,'Photo');
    assert.equal((await get(slotFrame)).slotName,'Photo');
    const cardCopy=(await run('instance.create',{component:card,x:230,y:20})).id;
    const mediaCopy=async()=> (await get(cardCopy)).children.find(node=>node.slotName==='Photo');
    const originalMedia=await mediaCopy();
    assert.equal(originalMedia.children,undefined);
    const copyDefaults=await get(originalMedia.id);
    assert.deepEqual(copyDefaults.children.map(node=>node.name),['Default content']);
    const defaultPng=await paintPng(cardCopy);
    const inserted=await run('instance.slotInsert',{id:cardCopy,slot:'Photo',component:art,index:0});
    assert.equal(inserted.slot,originalMedia.id);
    const withMedia=await get(originalMedia.id);
    assert.deepEqual(withMedia.children.map(node=>node.name),['Artwork','Default content']);
    assert.equal(withMedia.children[0].id,inserted.id);
    assert.notEqual(await paintPng(cardCopy),defaultPng);
    const replacement=await run('instance.slotInsert',{id:originalMedia.id,component:art,replace:true});
    assert.deepEqual((await get(originalMedia.id)).children.map(node=>node.id),[replacement.id]);
    assert.equal((await run('instance.resetSlot',{id:originalMedia.id})).changed,true);
    assert.equal((await run('instance.resetSlot',{id:cardCopy,slot:'Photo'})).changed,false);
    assert.equal(await paintPng(cardCopy),defaultPng);
    await assert.rejects(run('instance.slotInsert',{id:cardCopy,slot:'Photo',component:card}),/cycle/);
    const cleanup=await run('instance.slotInsert',{id:cardCopy,slot:'Photo',component:art,replace:true});
    await run('component.removeSlot',{id:slotFrame});
    assert.equal((await get(slotFrame)).slotName,undefined);
    assert.equal((await get(slotFrame)).children[0].id,fallback);
    await assert.rejects(get(cleanup.id));
    await assert.rejects(run('instance.resetSlot',{id:cardCopy,slot:'Photo'}));
    await call('undo');
    assert.equal((await mediaCopy()).id,originalMedia.id);
    assert.deepEqual((await get(originalMedia.id)).children.map(node=>node.id),[cleanup.id]);

    const outerFrame=(await call('create_node',{type:'frame',name:'Outer',x:450,y:120,width:160,height:100})).id;
    await run('instance.create',{component:card,parent:outerFrame,x:0,y:0});
    const outer=(await run('component.create',{ids:[outerFrame]})).id;
    const outerA=(await run('instance.create',{component:outer,x:450,y:250})).id;
    const outerB=(await run('instance.create',{component:outer,x:630,y:250})).id;
    const nestedA=(await get(outerA)).children.find(child=>child.type==='INSTANCE').id;
    const nestedB=(await get(outerB)).children.find(child=>child.type==='INSTANCE').id;
    const nestedSlot=async id=> (await get(id)).children.find(node=>node.slotName==='Photo').id;
    const photoA=await nestedSlot(nestedA);
    const photoB=await nestedSlot(nestedB);
    assert.notEqual(photoA,photoB);
    const outerDefault=await paintPng(outerA);
    const nestedArt=await run('instance.slotInsert',{id:nestedA,slot:'Photo',component:art,replace:true});
    assert.equal(nestedArt.slot,photoA);
    assert.deepEqual((await get(photoA)).children.map(node=>node.id),[nestedArt.id]);
    assert.deepEqual((await get(photoB)).children.map(node=>node.name),['Default content']);
    assert.notEqual(await paintPng(outerA),outerDefault);
    await assert.rejects(run('instance.slotInsert',{id:nestedA,slot:'Photo',component:outer}),/cycle/);
    await run('edit.delete',{ids:[outer]});
    await assert.rejects(run('component.restoreMain',{id:outerA}),/customized slots in nested instances/);
    await assert.rejects(get(outer));
    assert.equal((await get(outerA)).type,'INSTANCE');
    await call('undo');
    assert.deepEqual((await get(photoA)).children.map(node=>node.id),[nestedArt.id]);
    assert.equal((await run('instance.resetSlot',{id:photoA})).changed,true);
    assert.equal(await paintPng(outerA),outerDefault);
    const selectedCard=await paintPng(cardCopy);
    await run('edit.delete',{ids:[card]});
    assert.equal((await run('component.restoreMain',{id:cardCopy})).id,card);
    assert.deepEqual((await get(slotFrame)).children.map(node=>node.id),[cleanup.id]);
    assert.equal(await paintPng(card),selectedCard);

    await run('file.new',{name:'Component recovery'});
    const designFrame=(await call('create_node',{type:'frame',name:'Reusable Card',x:10,y:15,width:120,height:80})).id;
    const masterPaint=(await call('create_node',{type:'rectangle',name:'Accent',parent:designFrame,x:10,y:20,width:40,height:30,
      props:{fill:'#aa2211'}})).id;
    const master=(await run('component.create',{ids:[designFrame]})).id;
    const edited=(await run('instance.create',{component:master,x:190,y:15})).id;
    const sibling=(await run('instance.create',{component:master,x:380,y:15})).id;
    const instanceLayer=(await get(edited)).children[0].id;
    const initialSibling=await paintPng(sibling);
    await run('node.set',{ids:[instanceLayer],props:{fill:'#2255cc',width:65}});
    assert.equal((await get(instanceLayer)).width,65);
    assert.notEqual(await paintPng(edited),initialSibling);
    assert.equal(await paintPng(sibling),initialSibling);
    assert.equal((await run('component.pushChanges',{id:instanceLayer})).layers,1);
    assert.equal((await get(masterPaint)).width,40);
    assert.equal((await get(instanceLayer)).width,65);
    assert.notEqual(await paintPng(sibling),initialSibling);
    assert.equal((await run('component.pushChanges',{id:edited})).layers,0);
    await call('undo');
    assert.equal(await paintPng(sibling),initialSibling);
    assert.equal((await get(instanceLayer)).width,65);
    await run('component.pushChanges',{id:edited});
    const updatedSibling=await paintPng(sibling);
    await assert.rejects(run('component.restoreMain',{id:edited}),/still exists/);
    await run('node.set',{ids:[instanceLayer],props:{fill:'#9c44cc'}});
    const preservedAppearance=await paintPng(edited);
    await run('edit.delete',{ids:[master]});
    await assert.rejects(get(master));
    await assert.rejects(run('component.pushChanges',{id:edited}),/deleted/);
    const restored=await run('component.restoreMain',{id:edited});
    assert.equal(restored.id,master);
    assert.equal((await get(master)).x,190);
    assert.equal((await get(master)).children[0].id,masterPaint);
    assert.equal((await get(masterPaint)).width,65);
    assert.equal((await run('component.goToMain',{id:sibling})).id,master);
    assert.equal(await paintPng(master),preservedAppearance);
    assert.equal(await paintPng(sibling),preservedAppearance);
    assert.notEqual(await paintPng(sibling),updatedSibling);
    await assert.rejects(get(edited));
    await call('undo');
    await assert.rejects(get(master));
    assert.equal((await get(edited)).type,'INSTANCE');
    await call('redo');
    assert.equal((await get(master)).children[0].id,masterPaint);
    assert.equal(await paintPng(sibling),preservedAppearance);
    await run('file.new', { name: 'Align, arrange and matching fixture' });
    const alignA = await rect(20, 10, 40, 20);
    const alignB = await rect(120, 60, 20, 40);
    const positions = [
      ['align.left', node => node.x, 20],
      ['align.right', node => node.x + node.width, 140],
      ['align.hcenter', node => node.x + node.width / 2, 80],
      ['align.bottom', node => node.y + node.height, 100],
      ['align.vcenter', node => node.y + node.height / 2, 55],
    ];
    for (const [command, position, expected] of positions) {
      await run(command, { ids: [alignA, alignB] });
      approx(position(await get(alignA)), expected);
      approx(position(await get(alignB)), expected);
      await run('edit.undo');
    }
    const stackFrame = (await run('frame.create', { x: 300, y: 100, width: 50, height: 50 })).id;
    const overlay = async () => (await run('shape.rectangle', {
      parent: stackFrame, x: 0, y: 0, width: 30, height: 30,
    })).id;
    const below = await overlay();
    const above = await overlay();
    const stack = async () => (await hits(310, 110)).filter(id => [below, above].includes(id));
    const beforeOrder = await stack();
    assert.equal(beforeOrder.length, 2);
    await run('arrange.back', { ids: [above] });
    assert.deepEqual(await stack(), beforeOrder.slice().reverse());
    await run('arrange.forward', { ids: [above] });
    assert.deepEqual(await stack(), beforeOrder);

    await run('effect.add', { ids: [alignA, alignB], type: 'dropShadow' });
    await run('select.set', { ids: [alignA] });
    assert.deepEqual(new Set((await run('select.sameEffect')).selection), new Set([alignA, alignB]));
    const box = (await run('component.create', { ids: [below] })).id;
    const firstInstance = (await run('instance.create', { component: box, x: 50, y: 150 })).id;
    const secondInstance = (await run('instance.create', { component: box, x: 90, y: 150 })).id;
    await run('select.set', { ids: [firstInstance] });
    assert.deepEqual(new Set((await run('select.sameInstance')).selection), new Set([firstInstance, secondInstance]));

    await run('stroke.add', { ids: [above], color: '#CC2222', weight: 5 });
    const render = async () => (await run('file.exportSvg', { ids: [above] })).content;
    assert.match(await render(), /#(?:c22|cc2222)/i);
    await run('object.removeStroke', { ids: [above] });
    assert.doesNotMatch(await render(), /#(?:c22|cc2222)/i);
    await run('edit.undo');
    assert.match(await render(), /#(?:c22|cc2222)/i);

    const polygon = await run('shape.polygon', { x: 360, y: 100, width: 60, height: 80, props: { pointCount: 5, fill: '#CC7722' } });
    assert.equal((await get(polygon.id)).pointCount, 5);
    assert.match((await run('file.exportSvg', { ids: [polygon.id] })).content, /<path/);
  } finally {
    await client.close().catch(() => {});
    if (service.exitCode === null && service.signalCode === null) service.kill();
    await exited;
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
