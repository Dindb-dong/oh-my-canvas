// Uses the project's official MCP SDK. Runtime applications remain Rust-only.
import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';

const root=resolve(fileURLToPath(new URL('../..',import.meta.url)));
const sdk=process.env.OMC_TEST_SDK_ROOT;
const {Client}=await import(sdk?pathToFileURL(join(sdk,'dist/esm/client/index.js')).href:'@modelcontextprotocol/sdk/client/index.js');
const {StreamableHTTPClientTransport}=await import(sdk?pathToFileURL(join(sdk,'dist/esm/client/streamableHttp.js')).href:'@modelcontextprotocol/sdk/client/streamableHttp.js');
const {StdioClientTransport}=await import(sdk?pathToFileURL(join(sdk,'dist/esm/client/stdio.js')).href:'@modelcontextprotocol/sdk/client/stdio.js');
const binary=process.env.OMC_SERVICE_BINARY??join(root,'native/target/debug',process.platform==='win32'?'omc-service.exe':'omc-service');
const temporary=await mkdtemp(join(tmpdir(),'omc-native-sdk-'));const children=[];
async function start(profile){
 const child=spawn(binary,['--profile',profile,'--port','0'],{stdio:['ignore','ignore','pipe']});children.push(child);let errors='';child.stderr.on('data',d=>{errors=(errors+d.toString()).slice(-2000);});
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
