// Uses the project's official MCP SDK. Runtime applications remain Rust-only.
import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,readFile,rm,writeFile,copyFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {createMcpFetch} from '../../core/mcp-fetch.mjs';

const root=resolve(fileURLToPath(new URL('../..',import.meta.url)));
const sdk=process.env.OMC_TEST_SDK_ROOT;
const {Client}=await import(sdk?pathToFileURL(join(sdk,'dist/esm/client/index.js')).href:'@modelcontextprotocol/sdk/client/index.js');
const {StreamableHTTPClientTransport}=await import(sdk?pathToFileURL(join(sdk,'dist/esm/client/streamableHttp.js')).href:'@modelcontextprotocol/sdk/client/streamableHttp.js');
const {StdioClientTransport}=await import(sdk?pathToFileURL(join(sdk,'dist/esm/client/stdio.js')).href:'@modelcontextprotocol/sdk/client/stdio.js');
const binary=process.env.OMC_SERVICE_BINARY??join(root,'native/target/debug',process.platform==='win32'?'omc-service.exe':'omc-service');
const temporary=await mkdtemp(join(tmpdir(),'omc-native-sdk-'));const children=[];
async function start(profile,options=[]){
 const child=spawn(binary,['--profile',profile,'--port','0',...options],{stdio:['ignore','ignore','pipe']});children.push(child);let errors='';child.stderr.on('data',d=>{errors=(errors+d.toString()).slice(-2000);});
 for(let i=0;i<200;i++){if((child.exitCode!==null||child.signalCode!==null))throw Error(`service exited ${child.exitCode}: ${errors}`);try{const descriptor=JSON.parse(await readFile(join(profile,'native-v1/service.json'),'utf8'));const health=await fetch(descriptor.endpoint+'/health',{headers:{Authorization:`Bearer ${descriptor.token}`}});if(health.ok)return{child,profile,...descriptor};}catch{}await delay(25);}throw Error('service startup deadline');
}
async function stop(service){if(service.child.exitCode!==null||service.child.signalCode!==null)return;service.child.kill();await new Promise(resolve=>service.child.once('exit',resolve));}
async function connect(service,identity={action:'register'}){
 let registration;
 const transport=new StreamableHTTPClientTransport(new URL(service.endpoint+'/mcp'),{requestInit:{headers:{Authorization:`Bearer ${service.token}`}},fetch:async(input,init)=>{
  if(init?.body){const body=JSON.parse(init.body);if(body.method==='initialize'){body.params._meta={'oh-my-canvas/identity':identity};init={...init,body:JSON.stringify(body)};const response=await fetch(input,init);const value=await response.clone().json();registration=value.result?._meta?.['oh-my-canvas/identity']?.registration;return response;}}
  return fetch(input,init);
 }});
 const client=new Client({name:'native-sdk-contracts',version:'1.0.0'});await client.connect(transport);
 return{client,transport,registration,async call(name,args={},meta={}){const result=await client.callTool({name,arguments:args,_meta:meta});const value=result.structuredContent??JSON.parse(result.content.find(c=>c.type==='text').text);if(result.isError)throw Object.assign(Error(value.message??JSON.stringify(value)),value);return value;}};
}
async function rpc(service,session,method,params={}){const response=await fetch(service.endpoint+'/rpc',{method:'POST',headers:{Authorization:`Bearer ${service.token}`,'Content-Type':'application/json',...(session?{'X-OMC-Session':session}:{})},body:JSON.stringify({id:'contract',method,params})});const body=await response.json();if(body.error)throw Object.assign(Error(body.error.message),body.error);return body.result;}
function native(external){return 'doc_'+external.replaceAll('-','');}

try{
 await test('legacy HTTPS SDK calls persist pinned identity and real edits across restarts',async()=>{
  const profile=join(temporary,'legacy-https');
  let service=await start(profile,['--legacy-mcp-port','0']);
  const identity=async()=>{
   const runtime=JSON.parse(await readFile(join(profile,'mcp-runtime.json'),'utf8'));
   assert.equal(runtime.version,2);assert.equal(runtime.token,undefined);
   return {
    endpoint:new URL(`https://127.0.0.1:${runtime.port}/mcp`),
    cert:await readFile(runtime.certFile,'utf8'),
    token:await readFile(join(profile,'mcp-token-v2'),'utf8')
   };
  };
  const legacy=await identity();
  const pinned=createMcpFetch(legacy.cert);
  const headers={Authorization:`Bearer ${legacy.token}`,'Content-Type':'application/json'};
  const client=new Client({name:'old-omc-https-contract',version:'1.0.0'});
  const connectLegacy=endpoint=>client.connect(new StreamableHTTPClientTransport(endpoint,{fetch:pinned,requestInit:{headers}}));
  const request={method:'POST',headers,body:JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-06-18'}})};
  assert.equal((await pinned(legacy.endpoint,{...request,headers:{...headers,Authorization:'Bearer rejected'}})).status,403);
  assert.equal((await pinned(legacy.endpoint,{...request,headers:{...headers,Origin:legacy.endpoint.origin}})).status,403);
  assert.equal((await pinned(new URL('/rpc',legacy.endpoint),request)).status,404);
  const other=await start(join(temporary,'other-pin'),['--legacy-mcp-port','0']);
  const otherRuntime=JSON.parse(await readFile(join(other.profile,'mcp-runtime.json'),'utf8'));
  await assert.rejects(pinned(new URL(`https://127.0.0.1:${otherRuntime.port}/mcp`),request),{code:'DEPTH_ZERO_SELF_SIGNED_CERT'});
  await stop(other);
  await connectLegacy(legacy.endpoint);
  const invoke=async(name,args)=>{
   const result=await client.callTool({name,arguments:args});
   assert.equal(result.isError,false,JSON.stringify(result.content));
   return result.structuredContent;
  };
  const doc=await invoke('create_document',{title:'HTTPS persisted document'});
  const shape=await invoke('create_shape',{documentId:doc.documentId,type:'rect',width:50,height:20,properties:{name:'Pinned edit'}});
  assert.equal(shape.receipt.status,'durable');
  await client.transport.terminateSession();await client.close();
  await stop(service);
  service=await start(profile,['--legacy-mcp-port',legacy.endpoint.port]);
  const restarted=await identity();
  assert.equal(restarted.endpoint.href,legacy.endpoint.href);
  assert.equal(restarted.token===legacy.token,true);
  assert.equal(restarted.cert===legacy.cert,true);
  await connectLegacy(restarted.endpoint);
  const tree=await invoke('get_tree',{documentId:doc.documentId,detail:'detailed'});
  assert.equal(tree.nodes.find(node=>node.name==='Pinned edit').width,50);
  await client.transport.terminateSession();await client.close();
  await stop(service);
 });
 await test('official MCP SDK + independent native services',async t=>{
  let service=await start(join(temporary,'primary'));let client=await connect(service);const identity=client.registration;assert.ok(identity?.credential);
  const initial=await client.call('create_document',{title:'SDK contract canvas'});const documentId=initial.documentId;const doc=native(documentId);
  await t.test('pinned tools and shared native command authority',async()=>{
   const {tools}=await client.client.listTools();assert.equal(tools.filter(t=>!t.name.startsWith('native_')).length,50);
   const result=await client.call('create_shape',{documentId,type:'rect',x:12,y:18,width:80,height:40,properties:{name:'Red box',fills:[{type:'solid',color:'#ff0000'}]}});
   assert.equal(result.receipt.status,'durable');assert.equal(result.createdIds.length,1);
   const tree=await client.call('get_tree',{documentId,detail:'detailed'});assert.equal(tree.nodes.find(n=>n.name==='Red box').width,80);
  });
  await t.test('failed batch leaves no first-operation mutation',async()=>{
   const tree=await client.call('get_tree',{documentId,detail:'detailed'});const box=tree.nodes.find(n=>n.name==='Red box');
   await assert.rejects(client.call('batch',{documentId,ops:[{tool:'update',args:{id:box.id,attrs:{name:'Should roll back'}}},{tool:'update',args:{id:'missing',attrs:{name:'Invalid'}}}]}));
   const after=await client.call('get_tree',{documentId,detail:'detailed'});assert.equal(after.nodes.find(n=>n.rawId===box.rawId).name,'Red box');
  });
  let repeatArgs,repeatMeta,created;
  await t.test('idempotent generated IDs and digest conflict',async()=>{
   repeatArgs={documentId,type:'text',x:20,y:70,width:200,height:40,properties:{name:'Retry-safe text',text:'A😀한글'}};repeatMeta={'oh-my-canvas/idempotency-key':'sdk-restart-text'};
   created=await client.call('create_shape',repeatArgs,repeatMeta);const replay=await client.call('create_shape',repeatArgs,repeatMeta);assert.equal(replay.receipt.replayed,true);assert.deepEqual(replay.rawIds,created.rawIds);
   await assert.rejects(client.call('create_shape',{...repeatArgs,width:201},repeatMeta),error=>error.code==='idempotency_conflict');
  });
  await t.test('comments use relative text anchors and independent Undo',async()=>{
   const comment=await client.call('native_comments',{version:'1',action:'create',documentId,nodeId:created.rawIds[0],start:1,end:3,body:'Emoji review'});
   let listing=await client.call('native_comments',{version:'1',action:'list',documentId});assert.equal(listing.items[0].id,comment.id);assert.ok(listing.items[0].anchor);
   await client.call('native_comments',{version:'1',action:'undo',documentId});listing=await client.call('native_comments',{version:'1',action:'list',documentId});assert.equal(listing.items.length,0);
   const tree=await client.call('get_tree',{documentId,detail:'detailed'});assert.ok(tree.nodes.some(n=>n.rawId===created.rawIds[0]));
  });
  await t.test('fixed revision query remains stable through later edits',async()=>{
   let page=await client.call('native_query',{version:'1',documentId,limit:1});const revision=page.revision;const before=[];before.push(...page.nodes);
   await client.call('create_shape',{documentId,type:'ellipse',properties:{name:'After query cut'}});
   while(page.cursor){page=await client.call('native_query',{version:'1',documentId,cursor:page.cursor,limit:1});assert.deepEqual(page.revision,revision);before.push(...page.nodes);}
   assert.ok(!before.some(n=>n.properties.name==='After query cut'));
  });
  await t.test('native PNG/SVG/PDF and editable copy output',async()=>{
   for(const format of ['png','svg','pdf','omc']){const output=await client.call('export_document',{id:documentId,format});assert.equal(output.ok,true);assert.ok(output.byteLength>20);if(format==='png')assert.equal(Buffer.from(output.base64,'base64').subarray(1,4).toString(),'PNG');if(format==='pdf')assert.equal(Buffer.from(output.base64,'base64').subarray(0,4).toString(),'%PDF');if(format==='omc'){const parsed=JSON.parse(output.content);assert.equal(parsed.format,'omc.native/1');const copy=await client.call('import_document',{format:'omc',payload:output.content});assert.notEqual(copy.documentId,documentId);}}
  });
  await t.test('agent HTML and CSS import returns editable layers',async()=>{
   const imported=await client.call('import_document',{
    format:'html',title:'Agent HTML card',
    payload:'<style>.card { width: 140px; background: #eef2ff; }</style><div class="card" data-name="Card"><p data-name="Label">참가 신청</p></div>',
   });
   const tree=await client.call('get_tree',{documentId:imported.documentId,detail:'detailed'});
   const card=tree.nodes.find(node=>node.name==='Card');
   assert.ok(card);
   const styles=await client.call('get_styles',{documentId:imported.documentId,ids:[card.id]});
   assert.equal(styles.styles[0].styles.width,'140px');
   const label=tree.nodes.find(node=>node.name==='Label');
   assert.ok(label);
   await client.call('update',{documentId:imported.documentId,id:label.id,attrs:{name:'Edited label'}});
   const edited=await client.call('get_tree',{documentId:imported.documentId});
   assert.ok(edited.nodes.some(node=>node.name==='Edited label'));
  });
  await t.test('resumed principal replays original receipt after service restart',async()=>{
   await client.client.close();await stop(service);service=await start(service.profile);client=await connect(service,identity);await client.call('open_document',{id:documentId});
   const replay=await client.call('create_shape',repeatArgs,repeatMeta);assert.equal(replay.receipt.replayed,true);assert.deepEqual(replay.rawIds,created.rawIds);const tree=await client.call('get_tree',{documentId,detail:'detailed'});assert.equal(tree.nodes.filter(n=>n.name==='Retry-safe text').length,1);
  });
  await t.test('authenticated transport and duplicate JSON boundary',async()=>{
   const response=await fetch(service.endpoint+'/rpc',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});assert.equal(response.status,401);
   const duplicate=await fetch(service.endpoint+'/rpc',{method:'POST',headers:{Authorization:`Bearer ${service.token}`,'Content-Type':'application/json'},body:'{"id":1,"id":2,"method":"session.open","params":{}}'});assert.ok((await duplicate.json()).error);
   const unsupported=await fetch(service.endpoint+'/mcp',{method:'POST',headers:{Authorization:`Bearer ${service.token}`,'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'extension-probe',version:'1'},_meta:{'oh-my-canvas/required-extensions':['not-implemented/999']}}})});assert.ok((await unsupported.json()).error);
  });
  await t.test('four snapshot limit applies across documents in one session',async()=>{
   const other=await client.call('create_document',{title:'Snapshot scope'});await client.call('create_shape',{documentId:other.documentId,type:'rect'});
   const cursors=[];for(let i=0;i<4;i++){const id=i%2?other.documentId:documentId;const page=await client.call('native_query',{version:'1',documentId:id,limit:1});assert.ok(page.cursor);cursors.push({id,cursor:page.cursor});}
   await assert.rejects(client.call('native_query',{version:'1',documentId:other.documentId,limit:1}),error=>error.code==='resource_limit');
   for(const {id,cursor}of cursors)await client.call('native_query',{version:'1',action:'release',documentId:id,cursor});
  });
  await t.test('background export has a durable terminal result and cancellation boundary',async()=>{
   const ticket=await client.call('native_job',{version:'1',action:'submit',kind:'export',arguments:{id:documentId,format:'svg'}});let status;
   for(let i=0;i<100;i++){status=await client.call('native_job',{version:'1',action:'status',jobId:ticket.jobId});if(['completed','failed','cancelled'].includes(status.state))break;await delay(10);}
   assert.equal(status.state,'completed');assert.ok(status.result.content.includes('<svg'));
   const cancelled=await client.call('native_job',{version:'1',action:'cancel',jobId:ticket.jobId});assert.equal(cancelled.cancellation,'already_finished');
  });
  await t.test('official SDK uses the Rust stdio bridge',async()=>{
   const cli=process.env.OMC_CLI_BINARY??join(root,'native/target/debug',process.platform==='win32'?'omc-cli.exe':'omc-cli');
   const transport=new StdioClientTransport({command:cli,args:['--profile',service.profile,'--connect-only'],stderr:'pipe'});
   const stdio=new Client({name:'stdio-contracts',version:'1.0.0'});
   try{await stdio.connect(transport);const listed=await stdio.listTools();assert.equal(listed.tools.filter(t=>!t.name.startsWith('native_')).length,50);const result=await stdio.callTool({name:'create_document',arguments:{title:'Rust stdio document'}});assert.notEqual(result.isError,true);assert.ok(result.structuredContent.documentId);}finally{await stdio.close();}
  });
  await t.test('legacy page duplication, reordering and guides persist and support undo',async()=>{
   const doc=await client.call('create_document',{title:'Page action fixture'});
   const documentId=doc.documentId;
   const page=(action,args={})=>client.call('page',{action,documentId,...args});
   await client.call('create_shape',{documentId,type:'text',properties:{name:'Original',text:'원본'}});
   const guides=[{axis:'x',position:20},{axis:'y',position:45}];
   await page('update',{pageId:doc.page.id,properties:{guides}});
   const duplicate=await page('duplicate',{pageId:doc.page.id,name:'Copy'});
   assert.notEqual(duplicate.pageId,doc.page.id);
   const copied=await client.call('get_tree',{documentId,detail:'detailed'});
   assert.equal(copied.nodes.find(node=>node.name==='Original').text,'원본');
   const copyPageId=duplicate.pageId;
   await page('reorder',{pageId:copyPageId,index:0});
   assert.deepEqual((await page('list')).pages.map(p=>p.id),[copyPageId,doc.page.id]);
   assert.deepEqual((await page('list')).pages[0].guides,guides);
   await client.call('undo',{documentId});
   assert.deepEqual((await page('list')).pages.map(p=>p.id),[doc.page.id,copyPageId]);
   await page('delete',{pageId:copyPageId});
   assert.equal((await page('list')).pageId,doc.page.id);
   await assert.rejects(page('delete',{pageId:doc.page.id}),/last page/);
  });
  await t.test('legacy vector actions edit world-space path geometry and support undo',async()=>{
   const {documentId}=await client.call('create_document',{title:'Vector editing fixture'});
   await client.call('write_svg',{documentId,target:'root',position:'last',svg:'<svg width="100" height="100"><path id="first" fill="#222222" d="M10 10 C20 10 30 30 40 30 L60 45"/><path id="second" fill="#222222" d="M70 60 L80 60"/></svg>'});
   const {nodes}=await client.call('get_tree',{documentId,detail:'detailed'});
   const paths=nodes.filter(n=>n.kind==='path');
   assert.equal(paths.length,2);
   const candidates=await Promise.all(paths.map(node=>client.call('get_path',{documentId,id:node.rawId})));
   const id=candidates.find(path=>path.segments.length===3).rawId;
   const otherId=candidates.find(path=>path.segments.length===2).rawId;
   const inspect=(layer=id)=>client.call('get_path',{documentId,id:layer});
   const edit=async(action,fields={})=>client.call('edit_path',{documentId,id,revision:(await inspect()).revision,action,...fields});
   const original=await inspect();
   assert.equal(original.coordinateSpace,'world');
   assert.equal(original.segments.length,3);
   await edit('move_nodes',{indices:[1],dx:3,dy:4});
   let current=await inspect();
   assert.equal(current.segments[1].x,original.segments[1].x+3);
   assert.equal(current.segments[1].y2,original.segments[1].y2+4);
   await edit('insert_node',{index:1,t:0.5});
   assert.equal((await inspect()).segments.length,4);
   const point=(await inspect()).segments[1];
   await edit('set_handle',{index:1,handle:'in',point:{x:point.x-5,y:point.y},mode:'symmetric'});
   current=await inspect();
   assert.ok(Math.abs(current.segments[1].x2-(point.x-5))<0.001);
   assert.ok(Math.abs(current.segments[2].x1-(point.x+5))<0.001);
   await edit('convert_node',{index:1,nodeKind:'corner'});
   assert.equal((await inspect()).segments[1].handleMode,'corner');
   await edit('delete_nodes',{indices:[1]});
   assert.equal((await inspect()).segments.length,3);
   await edit('close');
   assert.equal((await inspect()).segments.at(-1).command,'close');
   await edit('open');
   assert.equal((await inspect()).segments.at(-1).command,'line');
   await edit('join',{otherId});
   assert.equal((await inspect()).segments.length,5);
   await assert.rejects(inspect(otherId));
   await client.call('undo',{documentId});
   assert.equal((await inspect(otherId)).segments.length,2);
   await edit('merge',{otherId,firstStart:true,secondEnd:true});
   assert.equal((await inspect()).segments.length,4);
   await edit('primitive',{primitive:{kind:'star',count:5,ratio:0.45}});
   current=await inspect();
   assert.equal(current.segments.length,11);
   assert.equal(current.segments.at(-1).command,'close');
   const svg=await client.call('export_document',{id:documentId,format:'svg'});
   assert.match(svg.content,/<path/);
  });
  await t.test('legacy spacing and tidy move actual layers with one undo per operation',async()=>{
   const {documentId}=await client.call('create_document',{title:'Arrangement fixture'});
   const ids=[];
   for(const [x,y,name] of [[10,5,'A'],[70,12,'B'],[150,25,'C']]) {
    const shape=await client.call('create_shape',{documentId,type:'rect',x,y,width:20,height:10,properties:{name}});
    ids.push(shape.rawIds[0]);
   }
   const coords=async()=>{
    const {nodes}=await client.call('get_tree',{documentId,detail:'detailed'});
    return ids.map(id=>{const {x,y}=nodes.find(n=>n.rawId===id);return [x,y];});
   };
   await client.call('edit_shapes',{documentId,action:'distribute',ids,axis:'h',gap:10});
   assert.deepEqual(await coords(),[[10,5],[40,12],[70,25]]);
   await client.call('edit_shapes',{documentId,action:'tidy',ids,columns:2,gap:5});
   assert.deepEqual(await coords(),[[10,5],[35,5],[10,20]]);
   await client.call('undo',{documentId});
   assert.deepEqual(await coords(),[[10,5],[40,12],[70,25]]);
  });
  await t.test('FigCraft-compatible stdio works on the same native document',async()=>{
   const cli=process.env.OMC_CLI_BINARY??join(root,'native/target/debug',process.platform==='win32'?'omc-cli.exe':'omc-cli');
   const transport=new StdioClientTransport({command:cli,args:['--profile',service.profile,'--connect-only','--dialect','figcraft'],stderr:'pipe'});
   const fig=new Client({name:'figcraft-compatibility-contracts',version:'1.0.0'});
   async function call(name,args={}) {
    const result=await fig.callTool({name,arguments:args});
    const value=result.structuredContent??JSON.parse(result.content.find(item=>item.type==='text').text);
    if(result.isError)throw Object.assign(Error(value.message??JSON.stringify(value)),value);
    return value;
   }
   try {
    await fig.connect(transport);
    const {tools}=await fig.listTools();
    assert.ok(tools.find(tool=>tool.name==='batch').inputSchema.properties.commands);
    assert.ok((await client.client.listTools()).tools.find(tool=>tool.name==='batch').inputSchema.properties.ops);
    const doc=await call('run_command',{command:'file.new',params:{name:'FigCraft dialect'}});
    const created=await call('batch',{commands:[
     {command:'node.create',as:'card',params:{type:'frame',name:'Card'}},
     {command:'node.create',params:{type:'text',parent:{$ref:'card'},name:'Korean label',text:'한글 편집'}},
     {command:'node.set',params:{ids:[{$step:1}],props:{fontSize:18,fill:'#312e81'}}},
    ]});
    assert.equal(created[2].nodes[0].fontSize,18);
    assert.equal((await call('get_node',{id:created[0].id})).children[0].characters,'한글 편집');
    await assert.rejects(call('batch',{commands:[
     {command:'node.create',params:{type:'rectangle',name:'Rolled back'}},
     {command:'node.set',params:{ids:[99999],props:{opacity:0.5}}},
    ]}),/Step 1/);
    assert.equal((await call('inspect_document')).layers.length,1);
    await call('undo');
    assert.equal((await call('inspect_document')).layers.length,0);
    await call('redo');
    assert.equal((await client.call('get_tree',{documentId:doc.id,detail:'detailed'})).nodes.find(n=>n.name==='Korean label').text,'한글 편집');
    const image=await fig.callTool({name:'screenshot',arguments:{ids:[created[0].id]}});
    assert.ok(image.content.some(item=>item.type==='image'&&item.mimeType==='image/png'));
    const run=(command,params={})=>call('run_command',{command,params});
    const docList=await run('doc.list');
    assert.ok(docList.some(entry=>entry.id===doc.id));
    const card=created[0].id,label=created[1].id;
    await call('type_text',{id:label,text:'두 번째 문장'});
    assert.deepEqual(await run('node.get',{id:label,fields:['characters']}),{characters:'두 번째 문장'});
    assert.deepEqual((await run('select.set',{ids:[card]})).selection,[card]);
    assert.deepEqual((await run('select.children')).selection,[label]);
    assert.deepEqual((await run('select.parent')).selection,[card]);
    assert.deepEqual((await run('select.byName',{query:'label'})).selection,[label]);
    assert.deepEqual((await run('select.add',{ids:[card]})).selection,[label,card]);
    assert.deepEqual((await run('select.remove',{ids:[label]})).selection,[card]);
    const rect=await run('shape.rectangle',{x:4,y:7,width:70,height:20});
    assert.equal(rect.node.type,'RECTANGLE');
    const ellipse=await run('shape.ellipse',{x:20,y:30,width:15,height:10});
    assert.equal(ellipse.node.type,'ELLIPSE');
    assert.equal((await run('shape.line',{x:0,y:0,width:30})).node.type,'LINE');
    assert.equal((await run('frame.create',{name:'Frame alias'})).node.type,'FRAME');
    assert.equal((await run('text.create',{characters:'문구',name:'Text alias'})).node.characters,'문구');
    assert.deepEqual((await run('select.next')).selection,[card]);
    assert.equal((await run('select.previous')).selection.length,1);
    assert.equal((await run('select.all')).selection.length,6);
    assert.deepEqual((await run('select.inverse')).selection,[]);
    const first=(await run('page.list'))[0];
    const second=await run('page.add',{name:'Second'});
    assert.notEqual(second.id,first.id);
    assert.equal((await run('page.rename',{id:second.id,name:'Renamed'})).name,'Renamed');
    const third=await run('page.duplicate',{id:first.id});
    await run('page.move',{id:third.id,index:0});
    assert.deepEqual((await run('page.list')).map(page=>page.id),[third.id,first.id,second.id]);
    await run('page.delete',{id:third.id});
    await run('page.select',{id:first.id});
    assert.equal((await call('get_node',{id:label})).characters,'두 번째 문장');
    assert.deepEqual((await run('select.none')).selection,[]);
    assert.match((await run('file.export',{format:'svg'})).content,/<svg/);
    await run('edit.delete',{ids:[ellipse.id]});
    await assert.rejects(call('get_node',{id:ellipse.id}),/layer not found/);
    await run('edit.undo');
    assert.equal((await call('get_node',{id:ellipse.id})).type,'ELLIPSE');
    await run('edit.redo');
    await assert.rejects(call('get_node',{id:ellipse.id}),/layer not found/);
    const simple=await run('file.new',{name:'Archive fixture'});
    const frame=await call('create_node',{type:'frame',name:'Archive frame',width:180,height:80,props:{fill:'#E8E8E8'}});
    const text=await call('create_node',{type:'text',parent:frame.id,name:'Archive text',text:'한글 아카이브',x:10,y:12,props:{fontSize:18,fill:'#312E81'}});
    const data=await run('file.saveAs',{data:true});
    assert.equal(Buffer.from(data.data,'base64').subarray(0,2).toString(),'PK');
    const path=join(temporary,'sdk-archive.figcraft');
    assert.equal((await call('save_file',{path})).path,path);
    assert.deepEqual(await readFile(path),Buffer.from(data.data,'base64'));
    await call('type_text',{id:text.id,text:'재저장'});
    await run('file.save');
    const reloaded=join(temporary,'reloaded-archive.figcraft');
    await copyFile(path,reloaded);
    const opened=await call('open_file',{path:reloaded});
    assert.notEqual(opened.document,simple.id);
    assert.equal((await call('inspect_document')).layers[0].children[0].characters,'재저장');
    await assert.rejects(call('save_file',{path}),/output exists/);
    await writeFile(reloaded,'outside edit');
    assert.equal((await run('file.open',{path:reloaded})).stale,true);
    await assert.rejects(call('save_file'),/file changed on disk/);
   } finally {await fig.close();}
  });
  await t.test('native collaboration exchanges durable edits over a dedicated pinned TLS room',async()=>{
   const peer=await start(join(temporary,'room-guest'));
   const guest=await connect(peer);
   try {
    const hostDocument=await client.call('create_document',{title:'Collaborate TLS fixture'});
    const documentId=hostDocument.documentId;
    const host=action=>client.call('collaboration',{action,documentId});
    const guestAction=action=>guest.call('collaboration',{action,documentId});
    const layer=await client.call('create_shape',{documentId,type:'rect',properties:{name:'Before join'}});
    const pixel='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS9sAAAAASUVORK5CYII=';
    await client.call('document_assets',{action:'add',documentId,kind:'image',name:'Room image',dataUrl:'data:image/png;base64,'+pixel});
    const {assets}=await client.call('document_assets',{action:'list',documentId});
    const hash=assets.find(a=>a.name==='Room image').hash;
    const hosting=await host('host');
    assert.equal(hosting.mode,'hosting');
    const {invite}=await client.call('collaboration',{action:'invite',documentId,address:hosting.address});
    const invitation=JSON.parse(Buffer.from(invite.split('/').at(-1),'base64url'));
    await assert.rejects(guest.call('collaboration',{action:'join',documentId,invite:'omc-native://join/invalid'}));
    assert.equal((await guest.call('collaboration',{action:'join',documentId,invite,name:'Guest'})).mode,'connected');
    assert.equal((await host('status')).participants.length,2);
    await client.call('collaboration',{action:'cursor',documentId,cursor:{x:17,y:30,page:hostDocument.page.id}});
    let remoteCursor;
    for(let i=0;i<20;i++){
     const {participants}=await guestAction('status');
     remoteCursor=participants.find(person=>person.host&&person.isSelf===false)?.cursor;
     if(remoteCursor?.x===17)break;
     await delay(150);
    }
    assert.equal(remoteCursor?.x,17);
    assert.deepEqual(await readFile(join(peer.profile,'native-v1/assets/sha256',hash.slice(0,2),hash)),Buffer.from(pixel,'base64'));
    assert.ok((await guest.call('get_tree',{documentId})).nodes.some(n=>n.rawId===layer.rawIds[0]));
    await client.call('update',{documentId,id:layer.rawIds[0],attrs:{name:'Edited by host'}});
    await guest.call('create_shape',{documentId,type:'ellipse',properties:{name:'Edited by guest'}});
    async function converge(connection,name) {
     for(let i=0;i<40;i++){
      const {nodes}=await connection.call('get_tree',{documentId});
      if(nodes.some(n=>n.name===name))return;
      await delay(150);
     }
     assert.fail('a remote edit did not become visible');
    }
    await converge(client,'Edited by guest');
    await converge(guest,'Edited by host');
    await guest.call('undo',{documentId});
    for(let i=0;i<40;i++){
     if(!(await client.call('get_tree',{documentId})).nodes.some(n=>n.name==='Edited by guest'))break;
     await delay(150);
    }
    const final=(await client.call('get_tree',{documentId})).nodes;
    assert.ok(final.some(n=>n.name==='Edited by host'));
    assert.ok(!final.some(n=>n.name==='Edited by guest'));
    assert.equal((await guestAction('leave')).mode,'offline');
    assert.equal((await host('status')).participants.length,1);
    await guest.call('create_shape',{documentId,type:'rect',properties:{name:'Edited while offline'}});
    await client.call('create_shape',{documentId,type:'rect',properties:{name:'Edited while guest away'}});
    assert.equal((await guest.call('collaboration',{action:'join',documentId,invite,name:'Guest'})).mode,'connected');
    await converge(client,'Edited while offline');
    await converge(guest,'Edited while guest away');
    await guestAction('leave');
    assert.equal((await host('leave')).mode,'offline');
    assert.ok((await guest.call('get_tree',{documentId})).nodes.some(n=>n.name==='Edited by host'));
    assert.ok(invitation.address.startsWith('127.0.0.1:'));
   } finally {await guest.client.close();await stop(peer);}
  });
  await t.test('single-step layer order preserves blocks, parents, and Undo',async()=>{
   const {documentId}=await client.call('create_document',{title:'Layer order'});
   const add=async(name,type='rect',parentId)=>{
    const result=await client.call('create_shape',{documentId,type,parentId,properties:{name}});
    return result.rawIds[0];
   };
   const group=await add('Group','group');
   await add('X','rect',group);const y=await add('Y','rect',group);await add('Z','rect',group);
   await add('A');const b=await add('B');const c=await add('C');await add('D');await add('E');
   const order=(mode,ids)=>client.call('edit_shapes',{documentId,action:'order',mode,ids});
   const siblings=async(id)=>{
    const tree=await client.call('get_tree',{documentId,id,depth:1});
    return tree.nodes.slice(1).map(node=>node.name);
   };
   const original=['Group','A','B','C','D','E'];
   const advanced=['Group','A','D','B','C','E'];
   assert.equal((await order('forward',[c,y,b])).receipt.status,'durable');
   assert.deepEqual(await siblings(),advanced);
   assert.deepEqual(await siblings(group),['X','Z','Y']);
   assert.equal((await order('backward',[b,c,y])).receipt.status,'durable');
   assert.deepEqual(await siblings(),original);
   assert.deepEqual(await siblings(group),['X','Y','Z']);
   assert.equal((await order('backward',[y,group])).changed,false);
   await client.call('undo',{documentId});
   assert.deepEqual(await siblings(),advanced);
   assert.deepEqual(await siblings(group),['X','Z','Y']);
  });
  await t.test('mask release preserves children and Undo restores the exported pixels',async()=>{
   const {documentId}=await client.call('create_document',{title:'Mask round trip'});
   const content=(await client.call('create_shape',{documentId,type:'rect',x:10,y:10,width:60,height:60,properties:{fills:[{type:'solid',color:'#0000ff'}]}})).rawIds[0];
   const source=(await client.call('create_shape',{documentId,type:'ellipse',x:30,y:20,width:20,height:20,properties:{fills:[{type:'solid',color:'#ffffff'}]}})).rawIds[0];
   const {receipt,rawIds:[group]}=await client.call('edit_shapes',{documentId,action:'mask',ids:[content,source],maskId:source});
   assert.equal(receipt.status,'durable');
   const inspect=()=>client.call('get_tree',{documentId,id:group,detail:'detailed'});
   const png=async()=> (await client.call('export_document',{id:documentId,format:'png',bounds:{x:0,y:0,width:100,height:80}})).base64;
   const before=await inspect();
   const clipped=await png();
   assert.equal(Buffer.from(clipped,'base64').subarray(1,4).toString(),'PNG');
   assert.equal(before.nodes[0].properties.maskId,source);
   const release=()=>client.call('edit_shapes',{documentId,action:'unmask',ids:[group]});
   const result=await release();
   assert.equal(result.receipt.status,'durable');
   assert.deepEqual(new Set(result.changedIds),new Set([group,source]));
   const after=await inspect();
   assert.equal(after.nodes[0].properties.maskId,undefined);
   assert.equal(after.nodes[2].properties.isMask,undefined);
   assert.deepEqual(after.nodes.map(node=>[node.rawId,node.parent,node.x,node.y]),before.nodes.map(node=>[node.rawId,node.parent,node.x,node.y]));
   assert.notEqual(await png(),clipped);
   assert.equal((await release()).changed,false);
   await client.call('undo',{documentId});
   assert.equal((await inspect()).nodes[0].properties.maskId,source);
   assert.equal(await png(),clipped);
  });
  await t.test('four processes with separate profiles converge',async()=>{
   const session=(await rpc(service,null,'session.open')).sessionId;
   const packageData=await rpc(service,session,'sync.package',{documentId:doc});const peers=[{service,session}];
   for(let i=1;i<4;i++){const peer=await start(join(temporary,`replica-${i}`));const session=(await rpc(peer,null,'session.open')).sessionId;await rpc(peer,session,'sync.fork',{package:packageData});peers.push({service:peer,session});}
   for(let i=0;i<4;i++){const {service,session}=peers[i];await rpc(service,session,'document.command',{envelope:{protocol:'omc.engine/1',requestId:`peer-${i}`,documentId:doc,targetEpoch:initial.targetEpoch,idempotencyKey:`peer-edit-${i}`,preconditions:{basis:'latest'},command:{type:'node.set',nodeId:created.rawIds[0],properties:{[`peer${i}`]:i}}}});}
   const histories=[];for(const {service,session}of peers)histories.push(await rpc(service,session,'sync.transactions',{documentId:doc,afterSequence:0}));
   for(const {service,session}of peers)for(const history of histories.toReversed())for(const transaction of history.toReversed()){await rpc(service,session,'sync.receive',{documentId:doc,transaction});await rpc(service,session,'sync.receive',{documentId:doc,transaction});}
   const snapshots=[];for(const {service,session}of peers)snapshots.push(await rpc(service,session,'document.snapshot',{documentId:doc}));for(const snapshot of snapshots.slice(1))assert.deepEqual(snapshot.nodes,snapshots[0].nodes);
   assert.equal(new Set(peers.map(p=>p.service.pid)).size,4);
  });
  await client.client.close();
 });
}finally{
 for(const child of children)await stop({child});
 // Windows can still report a transient SQLite file lock after child exit.
 await rm(temporary,{recursive:true,force:true,maxRetries:10});
}
