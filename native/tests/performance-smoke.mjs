// A reproducible service-path regression probe. This is not W1-W7 qualification.
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {performance} from 'node:perf_hooks';

const root=resolve(fileURLToPath(new URL('../..',import.meta.url)));
const sdk=process.env.OMC_TEST_SDK_ROOT;
const {Client}=await import(sdk?pathToFileURL(join(sdk,'dist/esm/client/index.js')).href:'@modelcontextprotocol/sdk/client/index.js');
const {StreamableHTTPClientTransport}=await import(sdk?pathToFileURL(join(sdk,'dist/esm/client/streamableHttp.js')).href:'@modelcontextprotocol/sdk/client/streamableHttp.js');
const binary=process.env.OMC_SERVICE_BINARY??join(root,'native/target/debug',process.platform==='win32'?'omc-service.exe':'omc-service');
const count=Number(process.env.OMC_PROBE_NODES??100000);
assert.ok(Number.isInteger(count)&&count>=2&&count<=100000);
const temporary=await mkdtemp(join(tmpdir(),'omc-native-performance-'));
let child,client;
try{
 const id=(kind,n)=>`${kind}_${n.toString(16).padStart(32,'0')}`;
 const rootId=id('node',0);const shard=id('shard',1);
 const nodes={};
 for(let i=0;i<count;i++){
  const nodeId=id('node',i);
  nodes[nodeId]={id:nodeId,kind:i===0?'frame':'rect',parentId:i===0?null:rootId,homeShard:shard,rank:(BigInt(i+1)*((1n<<128n)/BigInt(count+2))).toString(16).padStart(32,'0'),properties:i===0?{name:'Probe page',width:1440,height:900}:{name:`Probe ${i}`,x:i%1000,y:Math.floor(i/1000),width:10,height:10,fill:'#cc5533'}};
 }
 const source=JSON.stringify({title:`${count} node service probe`,pages:[{id:id('page',1),title:'Probe',rootNodeId:rootId,rank:'80000000000000000000000000000000'}],nodes,metadata:{}});
 const filePath=join(temporary,'probe.json');await writeFile(filePath,source);
 child=spawn(binary,['--profile',temporary,'--port','0'],{stdio:['ignore','ignore','pipe']});
 let errors='';child.stderr.on('data',value=>{errors=(errors+value.toString()).slice(-3000);});
 let descriptor;
 for(let i=0;i<200;i++){
  if(child.exitCode!==null||child.signalCode!==null)throw Error(`service exited: ${errors}`);
  try{descriptor=JSON.parse(await readFile(join(temporary,'native-v1/service.json'),'utf8'));break;}catch{await delay(25);}
 }
 assert.ok(descriptor,'service startup deadline');
 client=new Client({name:'native-performance-probe',version:'1.0.0'});
 await client.connect(new StreamableHTTPClientTransport(new URL(descriptor.endpoint+'/mcp'),{requestInit:{headers:{Authorization:`Bearer ${descriptor.token}`}}}));
 async function call(name,args){
  const result=await client.callTool({name,arguments:args},undefined,{timeout:120000});
  const value=result.structuredContent??JSON.parse(result.content.find(c=>c.type==='text').text);
  if(result.isError)throw Object.assign(Error(value.message??JSON.stringify(value)),value);
  return value;
 }
 const importStart=performance.now();let imported=await call('import_document',{format:'json',filePath});
 if(imported.jobId){
  const jobId=imported.jobId;let lastProgress=performance.now();
  while(performance.now()-importStart<180000){
   const status=await call('native_job',{version:'1',action:'status',jobId});
   if(status.state==='completed'){imported=status.result;break;}
   if(['failed','cancelled','interrupted'].includes(status.state))throw Error(JSON.stringify(status));
   if(performance.now()-lastProgress>5000){console.log(JSON.stringify({phase:'import',elapsedMs:Math.round(performance.now()-importStart),state:status.state,progress:status.progress}));lastProgress=performance.now();}
   await delay(100);
  }
 }
 assert.ok(imported.documentId,'import deadline');
 const importMs=performance.now()-importStart;
 assert.equal(imported.boardsTruncated,count>201);
 let page=await call('native_query',{version:'1',documentId:imported.documentId,limit:200});
 const target=page.nodes.find(n=>n.kind==='rect');assert.ok(target);
 if(page.cursor)await call('native_query',{version:'1',action:'release',documentId:imported.documentId,cursor:page.cursor});
 for(let i=0;i<10;i++)await call('edit_shapes',{documentId:imported.documentId,action:'patch',ids:[target.id],properties:{x:i}});
 const times=[];
 for(let i=0;i<100;i++){
  const start=performance.now();const result=await call('edit_shapes',{documentId:imported.documentId,action:'patch',ids:[target.id],properties:{x:i+10}});
  assert.equal(result.receipt.status,'durable');times.push(performance.now()-start);
 }
 const ordered=[...times].sort((a,b)=>a-b);
 const report={kind:'service-regression-probe',qualification:'NOT_W1_W7',build:'debug',nodes:count,inputBytes:Buffer.byteLength(source),importMs,updates:times.length,medianMs:ordered[50],p95Ms:ordered[94],maxMs:ordered.at(-1),samplesMs:times};
 console.log(JSON.stringify(report,null,2));
 if(process.env.OMC_PROBE_REPORT)await writeFile(process.env.OMC_PROBE_REPORT,JSON.stringify(report,null,2)+'\n');
}finally{
 await client?.close().catch(()=>{});
 if(child&&child.exitCode===null&&child.signalCode===null){child.kill();await new Promise(resolve=>child.once('exit',resolve));}
 await rm(temporary,{recursive:true,force:true});
}
