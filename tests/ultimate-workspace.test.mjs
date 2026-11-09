import {test} from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {Store,decodeFile} from '../core/storage.mjs';
import {createDocumentManager} from '../electron/document-manager.mjs';
import {createWorkspaceTools} from '../electron/workspace-tools.mjs';
import {readExplicitFile,writeExplicitFile,MAX_INLINE_BYTES} from '../electron/file-transfer.mjs';
import {documentFixture} from './helpers.mjs';

async function fixture(t){
  const directory=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'omc-ultimate-workspace-'))),profile=path.join(directory,'profile');await fs.mkdir(profile);
  const store=new Store(path.join(profile,'documents')),events=[],runtimeCalls=[];let manager,prefs={name:'Designer',starred:[]},busy=false;
  manager=createDocumentManager({store,createRuntime(entry){queueMicrotask(()=>manager.ready(entry,entry.generation));return {};},async disposeRuntime(){},async flushRuntime(){}});
  const runtimeRequest=async(entry,name,args)=>{runtimeCalls.push({id:entry.record.id,name,args});return name==='export-data'?{data:Buffer.from('<svg/>').toString('base64'),mimeType:'image/svg+xml'}:{};};
  const invoke=createWorkspaceTools({manager,store,profile,validateImportedDocument:()=>{},importCanvasJson:value=>value,exportCanvasJson:value=>value,runtimeRequest,
    async checkBusy(){if(busy)throw Object.assign(Error('Busy user'),{code:'busy'});},
    async preferences(data){if(data){prefs={...prefs,...data};if(data.starred!==undefined)prefs.starred=data.starred?[data.documentId]:[];}return structuredClone(prefs);},notifyPreferences(value){events.push(value);},
    connection:()=>({available:true,config:'public config'}),about:()=>({version:'0.1.0'}),windowState:()=>({visible:false}),capabilities:()=>({tools:[]}),requestQuit(){events.push('quit');},
    async join(data){events.push(data);return {documentId:data.documentId};},async host(entry){entry.collab={mode:'host',status:()=>({mode:'host',peers:[]}),invite:address=>'invitation:'+address};return {port:12345};},async stopSession(entry){entry.collab=null;},
    async context(entry){return {documentId:entry.record.id};},async editorTool(entry,call){events.push({id:entry.record.id,...call});return {structuredContent:{ok:true,asset:{id:'asset'}}};}
  });
  t.after(async()=>{for(const entry of manager.entries.values())entry.collab=null;await manager.disposeAll();await fs.rm(directory,{recursive:true,force:true});});
  return {directory,profile,store,manager,events,runtimeCalls,setBusy:value=>{busy=value;},call:(name,args,agent='agent')=>invoke({name,args,agent})};
}

test('explicit file exports never clobber an existing destination, including simultaneous writers',async t=>{
  const f=await fixture(t),file=path.join(f.directory,'export.svg');
  const results=await Promise.allSettled([writeExplicitFile(file,Buffer.from('first')),writeExplicitFile(file,Buffer.from('second'))]);
  assert.equal(results.filter(result=>result.status==='fulfilled').length,1);assert.ok(['first','second'].includes(await fs.readFile(file,'utf8')));
  const kept=await fs.readFile(file,'utf8');await assert.rejects(writeExplicitFile(file,Buffer.from('rejected')),/already exists/);assert.equal(await fs.readFile(file,'utf8'),kept);
  await writeExplicitFile(file,Buffer.from('replacement'),{overwrite:true});assert.equal(await fs.readFile(file,'utf8'),'replacement');
  assert.deepEqual((await fs.readdir(f.directory)).filter(name=>name.endsWith('.tmp')),[]);
});

test('file transfer rejects symlinks, non-files, protected profile paths, oversized and canceled input',async t=>{
  const f=await fixture(t),file=path.join(f.directory,'input.json'),link=path.join(f.directory,'link.json');await fs.writeFile(file,'{}');await fs.symlink(file,link);
  await assert.rejects(readExplicitFile(link,{limit:100}),/ELOOP/);await assert.rejects(writeExplicitFile(link,Buffer.from('bad'),{overwrite:true}),/regular file/);
  await assert.rejects(readExplicitFile(f.directory,{limit:100}),/regular file/);
  await assert.rejects(readExplicitFile(file,{limit:1}),/exceeds/);await assert.rejects(readExplicitFile('relative.json',{limit:100}),/absolute/);
  const privateFile=path.join(f.profile,'private');await fs.writeFile(privateFile,'private');
  await assert.rejects(readExplicitFile(privateFile,{limit:100,protectedDirectory:f.profile}),/protected application/);
  await assert.rejects(writeExplicitFile(privateFile,Buffer.from('bad'),{overwrite:true,protectedDirectory:f.profile}),/protected application/);
  const signal=AbortSignal.abort(Error('Canceled intentionally'));await assert.rejects(writeExplicitFile(path.join(f.directory,'canceled'),Buffer.from('bad'),{signal}),/Canceled intentionally/);
  assert.equal(await fs.readFile(privateFile,'utf8'),'private');
});

test('workspace close releases only the caller while another agent keeps the document usable',async t=>{
  const f=await fixture(t),a=await f.manager.create('A',documentFixture(),{agent:'agent',focus:true}),b=await f.manager.create('B',documentFixture(),{agent:'other',focus:true});f.manager.bind('other',a);
  const result=await f.call('workspace',{action:'close',documentId:a.record.id});
  assert.equal(result.boundDocumentId,null);assert.ok(a.agents.has('other'));assert.equal(a.agents.has('agent'),false);assert.ok(a.runtime);assert.equal(f.manager.state().activeTabId,b.record.id);
  await assert.rejects(f.call('delete_document',{id:a.record.id,expectedTitle:'A'}),{code:'busy'});
  await f.manager.releaseAgent('other',a.record.id);await f.call('delete_document',{id:a.record.id,expectedTitle:'A'});assert.equal((await f.store.list()).some(item=>item.id===a.record.id),false);assert.ok(b.runtime);
});

test('delete checks current title and rolls back a failed removal without disposing the document',async t=>{
  const f=await fixture(t),entry=await f.manager.create('Keep me',documentFixture());
  await assert.rejects(f.call('delete_document',{id:entry.record.id,expectedTitle:'Wrong'}),{code:'stale_title'});assert.ok(entry.runtime);
  const remove=f.store.remove.bind(f.store);f.store.remove=async()=>{throw Error('Disk failure');};
  await assert.rejects(f.call('delete_document',{id:entry.record.id,expectedTitle:'Keep me'}),/Disk failure/);
  assert.ok(entry.runtime);assert.equal(f.manager.deleting.has(entry.record.id),false);assert.equal(entry.holds,0);assert.ok(f.runtimeCalls.some(call=>call.name==='cancel-delete'));
  f.store.remove=remove;await f.call('delete_document',{id:entry.record.id,expectedTitle:'Keep me'});assert.equal(f.manager.entries.has(entry.record.id),false);
});

test('a pending deletion rejects new document loads and explicit targets',async t=>{
  const f=await fixture(t),entry=await f.manager.create('Delete',documentFixture());let finish,started;const waiting=new Promise(resolve=>{started=resolve;});
  const removing=f.manager.remove(entry.record.id,{expectedTitle:'Delete',beforeRemove:()=>{started();return new Promise(resolve=>{finish=resolve;});}});await waiting;
  await assert.rejects(f.manager.open(entry.record.id),{code:'busy'});assert.throws(()=>f.manager.resolve('agent',entry.record.id,true),{code:'busy'});finish();await removing;
});

test('document imports and exports roundtrip without stealing the visible tab',async t=>{
  const f=await fixture(t),a=await f.manager.create('Visible',documentFixture(),{focus:true});
  const imported=await f.call('import_document',{format:'json',payload:JSON.stringify(documentFixture()),title:'Imported'});assert.notEqual(imported.documentId,a.record.id);assert.equal(f.manager.state().activeTabId,a.record.id);
  const exported=await f.call('export_document',{id:imported.documentId,format:'omc'}),record=decodeFile(Buffer.from(exported.data,'base64').toString());
  try{assert.equal(record.title,'Imported');assert.equal(record.id,imported.documentId);assert.equal(record.replica.document.pagesById.page.objects.label.text,'Hello');}finally{record.replica.destroy();}
  const copied=await f.call('import_document',{format:'omc',payload:Buffer.from(exported.data,'base64').toString(),mode:'copy',title:'Copied file'});assert.notEqual(copied.documentId,imported.documentId);assert.equal(copied.document.title,'Copied file');
  const file=path.join(f.directory,'document.omc');await f.call('export_document',{id:imported.documentId,format:'omc',filePath:file});
  await assert.rejects(f.call('export_document',{id:imported.documentId,format:'omc',filePath:file}),/already exists/);
  await assert.rejects(f.call('import_document',{format:'omc',filePath:file}),{code:'busy'});
  await f.call('workspace',{action:'close',documentId:imported.documentId});const reopened=await f.call('import_document',{format:'omc',filePath:file});assert.equal(reopened.documentId,imported.documentId);assert.equal(f.manager.state().activeTabId,a.record.id);
});

test('imports reject malformed and ambiguous sources before creating a document',async t=>{
  const f=await fixture(t);
  for(const args of [{format:'json'},{format:'json',payload:'{}',filePath:'/a'},{format:'json',payload:'['},{format:'omc',payload:'{}'}])await assert.rejects(f.call('import_document',args));
  assert.equal(f.manager.entries.size,0);assert.deepEqual(await f.store.list(),[]);
});

test('save and rendered exports reject a human edit and keep explicit target identity',async t=>{
  const f=await fixture(t),a=await f.manager.create('A',documentFixture()),b=await f.manager.create('B',documentFixture(),{focus:true});f.setBusy(true);
  await assert.rejects(f.call('save_document',{id:a.record.id}),{code:'busy'});await assert.rejects(f.call('export_document',{id:a.record.id,format:'svg'}),{code:'busy'});
  f.setBusy(false);await f.call('save_document',{id:a.record.id});const exported=await f.call('export_document',{id:a.record.id,format:'svg',ids:['board']});assert.equal(Buffer.from(exported.data,'base64').toString(),'<svg/>');assert.equal(f.runtimeCalls.at(-1).id,a.record.id);assert.equal(f.runtimeCalls.at(-1).args.agent,'agent');assert.equal(f.manager.state().activeTabId,b.record.id);
});

test('preferences set favorites rather than toggle them and connection exposes only public configuration',async t=>{
  const f=await fixture(t),a=await f.manager.create('A',documentFixture());
  await f.call('preferences',{action:'set',name:'Agent',documentId:a.record.id,starred:true,view:'list'});await f.call('preferences',{action:'set',documentId:a.record.id,starred:true});
  assert.deepEqual((await f.call('preferences',{action:'get'})).preferences.starred,[a.record.id]);assert.equal(f.events.length,2);
  await assert.rejects(f.call('preferences',{action:'set',name:' '}),{code:'bad_args'});
  assert.deepEqual(await f.call('workspace',{action:'connection'}),{ok:true,available:true,config:'public config'});
});

test('resource file import routes through the agent editor queue and rejects mismatched kinds',async t=>{
  const f=await fixture(t),entry=await f.manager.create('Assets',documentFixture()),file=path.join(f.directory,'picture.png');await fs.writeFile(file,Buffer.from('synthetic decoded by editor'));
  const result=await f.call('import_resource',{documentId:entry.record.id,kind:'image',filePath:file,name:'Picture'});assert.equal(result.asset.id,'asset');const call=f.events.at(-1);assert.equal(call.id,entry.record.id);assert.equal(call.agent,'agent');assert.equal(call.name,'document_assets');assert.match(call.args.dataUrl,/^data:image\/png;base64,/);
  await assert.rejects(f.call('import_resource',{documentId:entry.record.id,kind:'font',filePath:file,family:'No'}),{code:'bad_args'});
});

test('collaboration is explicitly targeted and refuses replacing a running session',async t=>{
  const f=await fixture(t),a=await f.manager.create('A',documentFixture()),b=await f.manager.create('B',documentFixture(),{focus:true});
  assert.equal((await f.call('collaboration',{action:'status',documentId:a.record.id})).mode,'offline');await f.call('collaboration',{action:'host',documentId:a.record.id,port:0});
  assert.equal((await f.call('collaboration',{action:'invite',documentId:a.record.id,address:'127.0.0.1'})).invite,'invitation:127.0.0.1');
  await assert.rejects(f.call('collaboration',{action:'host',documentId:a.record.id}),{code:'busy'});assert.equal(b.collab,null);assert.equal(f.manager.state().activeTabId,b.record.id);
  await f.call('collaboration',{action:'leave',documentId:a.record.id});assert.equal(a.collab,null);
});

test('inline export budgets require a file destination for large content',async t=>{
  const f=await fixture(t),doc=documentFixture();doc.note='x'.repeat(MAX_INLINE_BYTES+1);const a=await f.manager.create('Large',doc);
  await assert.rejects(f.call('export_document',{id:a.record.id,format:'json'}),{code:'response_limit'});
  const file=path.join(f.directory,'large.json');await f.call('export_document',{id:a.record.id,format:'json',filePath:file});assert.ok((await fs.stat(file)).size>MAX_INLINE_BYTES);
});

test('screen sampling uses explicit display coordinates and never captures without macOS permission',async()=>{
  const {createScreenSampler}=await import('../electron/sample-color.mjs');let captures=0,cropped;
  const screen={getAllDisplays:()=>[{id:7,bounds:{x:-100,y:20,width:100,height:100},scaleFactor:2}]},image={isEmpty:()=>false,getSize:()=>({width:200,height:200}),crop(rect){cropped=rect;return {toBitmap:()=>Buffer.from([30,20,10,255])};}},desktopCapturer={async getSources(){captures++;return [{display_id:'7',thumbnail:image}];}};
  const denied=createScreenSampler({screen,desktopCapturer,systemPreferences:{getMediaAccessStatus:()=> 'denied'},platform:'darwin'});
  await assert.rejects(denied({x:-75,y:45}),{code:'unavailable'});assert.equal(captures,0);
  const sample=createScreenSampler({screen,desktopCapturer,systemPreferences:{getMediaAccessStatus:()=> 'granted'},platform:'darwin'});
  assert.deepEqual(await sample({x:-75,y:45,displayId:'7'}),{displayId:'7',x:-75,y:45,rgba:[10,20,30,255],color:'#0a141e'});assert.deepEqual(cropped,{x:50,y:50,width:1,height:1});
  await assert.rejects(sample({x:-75,y:45,displayId:'other'}),{code:'bad_args'});await assert.rejects(sample({x:NaN,y:45}),{code:'bad_args'});assert.equal(captures,1);
});

test('damaged unloaded documents can be deleted only with matching metadata confirmation',async t=>{
  const f=await fixture(t),id='11111111-1111-4111-8111-111111111111',file=f.store.file(id);await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,'malformed canvas');
  await assert.rejects(f.call('delete_document',{id,expectedTitle:'Wrong'}),{code:'stale_title'});assert.equal(await fs.readFile(file,'utf8'),'malformed canvas');assert.equal(f.manager.deleting.has(id),false);
  const result=await f.call('delete_document',{id,expectedTitle:'Damaged document'});assert.equal(result.deleted,true);await assert.rejects(fs.stat(file),{code:'ENOENT'});assert.equal(f.manager.entries.has(id),false);
});
