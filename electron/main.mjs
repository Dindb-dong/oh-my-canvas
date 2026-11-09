import {createFileDialogs} from './file-dialogs.mjs';
import {app,BrowserWindow,WebContentsView,ipcMain,dialog,protocol,Menu,clipboard,screen,desktopCapturer,systemPreferences} from 'electron';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import os from 'node:os';
import {Store,atomicWrite,decodeFile,encodeFile,validId} from '../core/storage.mjs';
import {Replica} from '../core/replica.mjs';
import {exportFileData} from '../core/export-file.mjs';
import {assertDocument,same,MAX_ENVELOPE_BYTES} from '../core/document.mjs';
import {Collaboration,parseInvite} from '../core/collaboration.mjs';
import {startMcpBridge,MCP_PORT} from './mcp-bridge.mjs';
import {canvasTitle} from './document-actions.mjs';
import {createDocumentManager} from './document-manager.mjs';
import {createWorkspaceReplay} from './workspace-replay.mjs';
import {createWorkspaceTools,DESKTOP_TOOL_NAMES} from './workspace-tools.mjs';
import {createScreenSampler} from './sample-color.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
app.setName('oh-my-canvas');
const profile=process.argv.find(value=>value.startsWith('--profile='))?.slice(10);
if(profile)app.setPath('userData',path.resolve(profile));
const backgroundTest=!!profile&&process.env.OMC_TEST_BACKGROUND==='1';
if(backgroundTest&&process.platform==='darwin')app.setActivationPolicy('accessory');
if(!app.requestSingleInstanceLock()){app.quit();}else{
protocol.registerSchemesAsPrivileged([{scheme:'omc',privileges:{standard:true,secure:true,supportFetchAPI:true,corsEnabled:true,stream:true}}]);
app.whenReady().then(async()=>{
  const fileDialogs=createFileDialogs(dialog),dir=app.getPath('userData'),store=new Store(path.join(dir,'documents'));
  const {TOOLS,WORKSPACE_TOOLS,DOCUMENT_MUTATIONS,validateDesktopToolArgs}=await import('../dist/tool-defs.mjs');
  const {blankDocument,sampleDocument,importCanvasJson,exportCanvasJson,validateImportedDocument}=await import('../dist/document-factories.mjs');
  const workspaceNames=new Set(WORKSPACE_TOOLS.map(tool=>tool.name)),mutations=new Set(DOCUMENT_MUTATIONS);
  const pending=new Map(),senders=new Map(),contexts=new Map(),activeCalls=new Set(),replay=createWorkspaceReplay();
  let win,bridge,bridgeError,closing=false,quitting=false,prefsWork=Promise.resolve(),shellWork=Promise.resolve();
  let prefs={name:os.userInfo().username};
  try{prefs={...prefs,...JSON.parse(await fs.readFile(path.join(dir,'preferences.json'),'utf8'))};}catch{}
  const sendShell=message=>{if(win&&!win.isDestroyed())win.webContents.send('omc:event',message);};
  const sendRuntime=(entry,message)=>{const wc=entry.runtime?.sender;if(wc&&!wc.isDestroyed())wc.send('omc:event',{...message,documentId:entry.record.id,generation:entry.generation});};
  const metadata=entry=>({id:entry.record.id,title:entry.record.title,generation:entry.generation});
  function cancelRequests(reason,predicate=()=>true){for(const request of [...pending.values()])if(predicate(request))request.cancel(reason);}
  function layoutViews(){
    if(!win||win.isDestroyed())return;
    const [width,height]=win.getContentSize(),active=manager.state().activeTabId;
    for(const entry of manager.entries.values())if(entry.runtime){entry.runtime.view.setBounds({x:0,y:40,width:Math.max(1,width),height:Math.max(1,height-40)});entry.runtime.view.setVisible(active===entry.record.id);}
  }
  function secure(wc,url){
    wc.setWindowOpenHandler(()=>({action:'deny'}));
    wc.on('will-navigate',(event,next)=>{if(next!==url)event.preventDefault();});
  }
  function disposeRuntime(entry){
    const runtime=entry.runtime;if(!runtime)return;
    cancelRequests('Document runtime closed',request=>request.entry===entry);
    senders.delete(runtime.sender.id);entry.runtime=null;
    if(win&&!win.isDestroyed())win.contentView.removeChildView(runtime.view);
    if(!runtime.sender.isDestroyed())runtime.sender.close({waitForBeforeUnload:false});
  }
  function createRuntime(entry){
    const generation=entry.generation,url=`omc://canvas/document.html?documentId=${entry.record.id}&generation=${generation}`;
    const view=new WebContentsView({webPreferences:{preload:path.join(root,'dist/preload.cjs'),backgroundThrottling:false,contextIsolation:true,sandbox:true,nodeIntegration:false,webSecurity:true}});
    const runtime={view,sender:view.webContents,url,generation};
    senders.set(runtime.sender.id,{entry,generation,url});secure(runtime.sender,url);
    win.contentView.addChildView(view);const [width,height]=win.getContentSize();view.setBounds({x:0,y:40,width:Math.max(1,width),height:Math.max(1,height-40)});view.setVisible(false);
    const stopped=()=>{if(entry.runtime!==runtime)return;cancelRequests('Document renderer restarted; read fresh context before retrying',request=>request.entry===entry);senders.delete(runtime.sender.id);if(!win.isDestroyed())win.contentView.removeChildView(view);manager.runtimeGone(entry);if(!runtime.sender.isDestroyed())runtime.sender.close({waitForBeforeUnload:false});sendShell({type:'error',message:`${entry.record.title}: document renderer stopped. Reopen its tab to recover.`});};
    runtime.sender.on('render-process-gone',stopped);runtime.sender.on('destroyed',stopped);
    void runtime.sender.loadURL(url).catch(error=>manager.ready(entry,generation,error));
    return runtime;
  }
  const manager=createDocumentManager({store,createRuntime,disposeRuntime,flushRuntime:(entry,options={})=>runtimeRequest(entry,'flush',{guardBusy:options.guardBusy},options),canDispose:entry=>![...pending.values()].some(request=>request.entry===entry),onChange:state=>{layoutViews();sendShell({type:'workspace',...state});sendShell({type:'library-changed'});},onEvent:(entry,message)=>{sendRuntime(entry,message);if(message.type==='saved'||message.type==='metadata')sendShell({type:'library-changed'});}});
  function source(event){
    if(event.sender===win?.webContents&&event.senderFrame?.url==='omc://canvas/index.html')return {role:'shell'};
    const registered=senders.get(event.sender.id);
    if(!registered||registered.entry.runtime?.sender!==event.sender||registered.generation!==registered.entry.generation||event.senderFrame?.url!==registered.url)throw Error('Untrusted IPC sender');
    return {role:'document',...registered,sender:event.sender};
  }
  function checkIdentity(entry,data){if(data?.id!==undefined&&data.id!==entry.record.id||data?.documentId!==undefined&&data.documentId!==entry.record.id||data?.generation!==undefined&&data.generation!==entry.generation)throw Object.assign(Error('Renderer document identity mismatch'),{code:'document_changed'});}
  function requestRuntime(entry,message,{signal,agent}={}){
    if(!entry.runtime)throw Object.assign(Error('Document renderer is unavailable; reopen it'),{code:'runtime_restarted'});
    if(signal?.aborted)throw signal.reason;
    const runtime=entry.runtime,generation=entry.generation,id=randomUUID();
    return new Promise((resolve,reject)=>{
      const cleanup=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);pending.delete(id);};
      const cancel=reason=>{cleanup();if(!runtime.sender.isDestroyed())runtime.sender.send('omc:event',{type:'tool-cancel',id,documentId:entry.record.id,generation});reject(Object.assign(Error(reason),{code:'cancelled'}));};
      const abort=()=>cancel('MCP request cancelled; persisted changes are not rolled back. Inspect the addressed document before retrying.');
      const timer=setTimeout(()=>cancel('Document runtime timed out; inspect its context before retrying'),63000);
      pending.set(id,{id,entry,generation,sender:runtime.sender,agent,cancel,resolve:result=>{cleanup();resolve(result);}});
      signal?.addEventListener('abort',abort,{once:true});
      runtime.sender.send('omc:event',{...message,id,documentId:entry.record.id,generation});
    });
  }
  function runtimeRequest(entry,name,args={},options={}){return requestRuntime(entry,{type:'runtime-request',name,args},options).then(result=>{if(result?.ok===false)throw Object.assign(Error(result.error?.message??'Document operation failed'),{code:result.error?.code??'failed'});return result;});}
  async function tool(entry,call,signal){
    const generation=entry.generation,{documentId,...args}=call.args;
    const result=await requestRuntime(entry,{type:'tool',call:{...call,args,documentId:entry.record.id,generation}},{signal,agent:call.agent});
    if(entry.generation!==generation)throw Object.assign(Error('Document runtime restarted; read fresh context'),{code:'runtime_restarted'});
    const structuredContent={...result.structuredContent,documentId:entry.record.id,document:{id:entry.record.id,title:entry.record.title},generation,...call.name==='get_context'?{activeTabId:manager.state().activeTabId,visible:manager.state().activeTabId===entry.record.id}:{}};
    if(call.name==='get_context'&&!result.isError){if(!contexts.has(call.agent))contexts.set(call.agent,new Map());contexts.get(call.agent).set(entry.record.id,generation);}
    return {...result,content:[{type:'text',text:JSON.stringify(structuredContent)},...(result.content??[]).filter(content=>content.type!=='text')],structuredContent};
  }
  const response=value=>({content:[{type:'text',text:JSON.stringify(value)}],structuredContent:value});
  async function library(){const docs=await store.list();return docs.map(doc=>{const entry=manager.entries.get(doc.id);return {...doc,...entry?{title:entry.record.title,open:entry.tabOpen,inUse:!!(entry.agents.size||entry.collab||[...pending.values()].some(request=>request.entry===entry))}:{open:false,inUse:false}};});}
  async function workspaceTool(call,signal){
    if(DESKTOP_TOOL_NAMES.has(call.name))return replay.run(call.agent,call.context?.idempotencyKey,call.name,call.args,()=>{const work=shellWork.then(()=>desktopTools(call,signal));shellWork=work.catch(()=>{});return work;}).then(response);
    if(call.name==='list_documents'){
      const starred=new Set(prefs.starred??[]),docs=(await library()).map(doc=>({...doc,starred:starred.has(doc.id)})).filter(doc=>doc.title.toLocaleLowerCase().includes((call.args.query??'').toLocaleLowerCase())&&(!call.args.starredOnly||doc.starred)),offset=call.args.offset??0,limit=call.args.limit??50,state=manager.state();
      if(call.args.sort)docs.sort((a,b)=>(call.args.sort==='title'?a.title.localeCompare(b.title):call.args.sort==='oldest'?(a.updatedAt??'').localeCompare(b.updatedAt??''):(b.updatedAt??'').localeCompare(a.updatedAt??''))||a.id.localeCompare(b.id));
      signal?.throwIfAborted();return response({ok:true,documents:docs.slice(offset,offset+limit).map(({thumbnail,...doc})=>doc),total:docs.length,nextOffset:offset+limit<docs.length?offset+limit:null,...state,boundDocumentId:manager.bindings.get(call.agent)??null,view:state.libraryVisible?'library':'editor'});
    }
    return replay.run(call.agent,call.context?.idempotencyKey,call.name,call.args,async()=>{
      signal?.throwIfAborted();
      if(call.name==='rename_document'){
        const entry=manager.entries.get(call.args.id);
        if(entry?.runtime)await checkBusy(entry,call.agent,signal);
        const document=await manager.rename(call.args.id,call.args.title,{signal});signal?.throwIfAborted();return response({ok:true,document,documentId:document.id});
      }
      const options={agent:call.agent,focus:call.args.focus??false,signal};let entry;
      if(call.name==='open_document')entry=await manager.open(call.args.id,options);
      else if(call.name==='create_document')entry=await manager.create(call.args.title??(call.args.sample?'Studio 01':undefined),call.args.sample?sampleDocument():blankDocument(),options);
      else entry=await manager.duplicate(call.args.id,call.args.title,options);
      signal?.throwIfAborted();const context=await tool(entry,{name:'get_context',args:{},agent:call.agent},signal);
      if(context.isError)return context;
      return response({ok:true,revision:context.structuredContent.revision,document:{id:entry.record.id,title:entry.record.title},documentId:entry.record.id,generation:entry.generation,context:context.structuredContent});
    });
  }
  async function checkBusy(entry,agent,signal){
    signal?.throwIfAborted();if(entry.runtime){const inspection=await runtimeRequest(entry,'inspect',{}, {signal,agent});if(inspection.busy)throw Object.assign(Error('A user edit is in progress in this canvas'),{code:'busy'});}
  }
  const desktopTools=createWorkspaceTools({sampleColor:createScreenSampler({screen,desktopCapturer,systemPreferences}),manager,store,profile:dir,sourceRoot:root,importCanvasJson,exportCanvasJson,validateImportedDocument,runtimeRequest,preferences,checkBusy,
    notifyPreferences:value=>{sendShell({type:'preferences',preferences:value});for(const entry of manager.entries.values())sendRuntime(entry,{type:'preferences',preferences:value});},
    editorTool:(entry,call,signal)=>mcpDispatch({...call,args:{...call.args,documentId:entry.record.id}},{signal}),capabilities:()=>({tools:TOOLS,explicitDocumentMutations:DOCUMENT_MUTATIONS,protocol:{explicitTargets:true,implicitVisibleTabTarget:false,idempotency:'session-scoped',clipboard:'private-agent'},platform:{os:process.platform,windowControls:true,devTools:process.argv.includes('--debug-ui'),screenSampling:process.platform!=='darwin'||systemPreferences.getMediaAccessStatus('screen')==='granted'}}),requestQuit:()=>{setTimeout(()=>void closeApplication(),250).unref();},
    connection:mcpInfo,about:()=>({name:app.getName(),version:app.getVersion(),platform:process.platform,license:'MIT',notices:'omc://canvas/licenses/index.html',debugUi:process.argv.includes('--debug-ui')}),
    windowState:data=>{if(typeof data.devTools==='boolean'&&!process.argv.includes('--debug-ui'))throw Object.assign(Error('DevTools are available only when launched with --debug-ui'),{code:'unavailable'});if(typeof data.hideOthers==='boolean'&&process.platform!=='darwin')throw Object.assign(Error('Hide other applications is available only on macOS'),{code:'unavailable'});if(typeof data.fullscreen==='boolean')win.setFullScreen(data.fullscreen);if(typeof data.visible==='boolean'){if(data.visible)win.show();else win.hide();}if(typeof data.hideOthers==='boolean')Menu.sendActionToFirstResponder(data.hideOthers?'hideOtherApplications:':'unhideAllApplications:');if(typeof data.devTools==='boolean'){if(data.devTools)win.webContents.openDevTools();else win.webContents.closeDevTools();}return {fullscreen:win.isFullScreen(),visible:win.isVisible(),devTools:win.webContents.isDevToolsOpened()};},
    join,host:(entry,args)=>manager.enqueue(entry,()=>startHost(entry,{...args,replace:false})),stopSession:entry=>manager.enqueue(entry,()=>stopSession(entry)),context:async(entry,agent,signal)=>{const result=await tool(entry,{name:'get_context',args:{},agent},signal);if(result.isError)throw Object.assign(Error(result.structuredContent?.error?.message??'Could not inspect imported canvas'),{code:'failed'});return result.structuredContent;}
  });
  async function mcpDispatch(call,{signal}={}){
    if(closing||quitting)throw Error('Application is closing');
    const invalid=validateDesktopToolArgs(call.name,call.args);if(invalid)throw Object.assign(Error('Invalid tool arguments: '+invalid),{code:'bad_args'});
    if(workspaceNames.has(call.name)||DESKTOP_TOOL_NAMES.has(call.name))return workspaceTool(call,signal);
    const id=manager.resolve(call.agent,call.args.documentId,mutations.has(call.name));
    const admitted=manager.entries.get(id),admittedGeneration=admitted?.runtime||admitted?.starting?admitted.generation:null;
    const entry=await manager.load(id);
    signal?.throwIfAborted();
    if(call.name!=='get_context'&&entry.generation>0&&!entry.runtime&&!entry.starting)throw Object.assign(Error('Document runtime restarted; read get_context before retrying'),{code:'runtime_restarted'});
    try{await manager.ensureRuntime(entry);signal?.throwIfAborted();}catch(error){await manager.release(entry);throw error;}
    if(!entry.agents.has(call.agent)){entry.agents.add(call.agent);manager.changed();}
    const observed=contexts.get(call.agent)?.get(id);
    if(call.name!=='get_context'&&(admittedGeneration!==null&&entry.generation!==admittedGeneration||observed!==undefined&&observed!==entry.generation))throw Object.assign(Error('Document runtime restarted; read get_context before retrying'),{code:'runtime_restarted'});
    return tool(entry,call,signal);
  }
  async function endAgent(agent){cancelRequests('MCP session ended',request=>request.agent===agent);contexts.delete(agent);replay.end(agent);for(const entry of manager.entries.values())sendRuntime(entry,{type:'tool-session-end',agent});await manager.endAgent(agent);}
  async function preferences(data){
    const task=prefsWork.then(async()=>{if(data){const next={...prefs,name:String(data.name||prefs.name).slice(0,40)};if(typeof data.toggleStar==='string'&&/^[a-zA-Z0-9-]{1,64}$/.test(data.toggleStar)){const starred=new Set(next.starred||[]);if(starred.has(data.toggleStar))starred.delete(data.toggleStar);else if(starred.size<10000)starred.add(data.toggleStar);next.starred=[...starred];}if(typeof data.documentId==='string'&&typeof data.starred==='boolean'){const starred=new Set(next.starred||[]);if(data.starred)starred.add(data.documentId);else starred.delete(data.documentId);next.starred=[...starred].slice(0,10000);}if(['grid','list'].includes(data.view))next.view=data.view;await atomicWrite(path.join(dir,'preferences.json'),JSON.stringify(next));prefs=next;}return structuredClone(prefs);});prefsWork=task.catch(()=>{});return task;
  }
  async function stopSession(entry){const previous=entry.collab;entry.collab=null;await previous?.close();sendRuntime(entry,{type:'session',status:{mode:'offline',peers:[]}});manager.changed();}
  function bindSession(entry,collab){entry.collab=collab;collab.on('status',status=>{sendRuntime(entry,{type:'session',status});manager.changed();});collab.on('cursor',data=>sendRuntime(entry,{type:'cursor',...data}));collab.on('warning',message=>sendRuntime(entry,{type:'error',message}));}
  async function join(data){
    const invitation=parseInvite(data.invite);let entry,created=false;
    data.signal?.throwIfAborted();
    try{entry=await manager.load(invitation.room);}catch(error){if(error.code!=='ENOENT')throw error;entry=await manager.load(invitation.room,{id:invitation.room,title:canvasTitle(invitation.title??'Shared canvas'),createdAt:new Date().toISOString(),replica:new Replica()});created=true;}
    entry.holds=(entry.holds??0)+1;let collab,joined=false;
    try{if(data.replace===false){if(entry.collab||[...entry.agents].some(agent=>agent!==data.agent))throw Object.assign(Error('Canvas already has an active session; leave it first'),{code:'busy'});await checkBusy(entry,data.agent,data.signal);}if(entry.runtime)await runtimeRequest(entry,'flush');if(data.replace!==false)await stopSession(entry);collab=new Collaboration({replica:entry.record.replica,id:entry.record.id,title:entry.record.title,name:data.name??prefs.name});await collab.join(data.invite);joined=true;data.signal?.throwIfAborted();if(entry.collab||data.replace===false&&[...entry.agents].some(agent=>agent!==data.agent))throw Object.assign(Error('Canvas acquired another active session while connecting; leave it first'),{code:'busy'});bindSession(entry,collab);await manager.save(entry);await manager.ensureRuntime(entry);entry.tabOpen=true;manager.bind(data.agent,entry);if(data.focus!==false)manager.activate(entry.record.id);else manager.changed();return {documentId:entry.record.id,document:{id:entry.record.id,title:entry.record.title},...collab.status()};}
    catch(error){await collab?.close();if(entry.collab===collab)entry.collab=null;throw error;}
    finally{entry.holds--;if(created&&!joined&&!entry.runtime&&!entry.collab)manager.discard(entry);}
  }
  async function startHost(entry,data={}){
    if(data.replace===false&&entry.collab)throw Object.assign(Error('Leave the existing collaboration session first'),{code:'busy'});
    if(data.replace!==false)await stopSession(entry);const collab=new Collaboration({replica:entry.record.replica,id:entry.record.id,title:entry.record.title,name:data.name??prefs.name});bindSession(entry,collab);
    try{await collab.host({port:Number(data.port)||0});}catch(error){await stopSession(entry);throw error;}
    return {port:collab.port,addresses:Object.values(os.networkInterfaces()).flat().filter(address=>address?.family==='IPv4'&&!address.internal).map(address=>address.address)};
  }
  async function importFile(){
    const result=await fileDialogs.open({title:'Open canvas',filters:[{name:'Canvas documents',extensions:['omc','json']}],properties:['openFile']});if(result.canceled)return null;
    const stat=await fs.stat(result.filePaths[0]);if(stat.size>MAX_ENVELOPE_BYTES)throw Error('Document file exceeds 24 MiB');
    const raw=await fs.readFile(result.filePaths[0],'utf8');
    if(!result.filePaths[0].endsWith('.omc'))return {json:JSON.parse(raw),title:path.basename(result.filePaths[0],'.json')};
    const record=decodeFile(raw);let entry;
    if(manager.entries.has(record.id)){entry=await manager.load(record.id,record);}
    else {try{const existing=await store.load(record.id);try{record.replica.receive(existing.replica.state);}finally{existing.replica.destroy();}}catch(error){if(error.code!=='ENOENT'){record.replica.destroy();throw error;}}entry=await manager.load(record.id,record);}
    entry.holds=(entry.holds??0)+1;
    try{await manager.save(entry);await manager.ensureRuntime(entry);entry.tabOpen=true;manager.activate(entry.record.id);return {opened:metadata(entry)};}
    finally{entry.holds--;if(!entry.runtime&&!entry.tabOpen&&!entry.agents.size&&!entry.collab)await manager.release(entry);}
  }
  function mcpInfo(data){
    if(!bridge)return {available:false,error:bridgeError||'MCP is disabled',config:''};
    const entry=data?.transport==='stdio'?{command:process.execPath,args:[app.isPackaged?path.join(process.resourcesPath,'mcp-cli.cjs'):path.join(root,'dist/mcp-cli.cjs'),'--runtime',bridge.file],env:{ELECTRON_RUN_AS_NODE:'1'}}:{url:bridge.url,bearer_token_env_var:'OMC_MCP_TOKEN'};
    const config=JSON.stringify({mcpServers:{'oh-my-canvas':entry}},null,2);if(data?.copy)clipboard.writeText(config);return {available:true,config,port:bridge.port,url:bridge.url,runtime:bridge.file,certificatePath:bridge.certFile};
  }
  async function documentAction(entry,action,data){
    checkIdentity(entry,data);if(manager.deleting.has(entry.record.id)&&!['flush','snapshot','cursor'].includes(action))throw Object.assign(Error('Document is being deleted'),{code:'busy'});const generation=entry.generation;
    switch(action){
      case 'snapshot':return manager.snapshot(entry);
      case 'runtime-ready':manager.ready(entry,entry.generation,data?.ok===false||data?.error?data.error??Error('Document renderer failed'):null);return metadata(entry);
      case 'bootstrap':{
        if(entry.seq!==0||typeof data?.nonce!=='string'||data.nonce!==entry.bootstrapNonce)throw Error('Invalid canvas initialization');
        if(!same(entry.bootstrapBase,entry.record.replica.document)){entry.bootstrapNonce=randomUUID();entry.bootstrapBase=entry.record.replica.document;return {...manager.snapshot(entry),bootstrapRetry:true};}
        entry.bootstrapNonce=null;entry.bootstrapBase=null;entry.record.replica.patch(data.changes,'Initialize canvas',undefined,{recordHistory:false});await manager.save(entry);manager.confirmGeneration(entry,generation);return manager.snapshot(entry);
      }
      case 'commit':if(!Number.isSafeInteger(data.seq))throw Error('Invalid edit sequence');if(data.seq<=entry.seq)return manager.snapshot(entry);entry.record.replica.patch(data.changes,data.label,data.group);await manager.save(entry);manager.confirmGeneration(entry,generation);entry.seq=data.seq;return manager.snapshot(entry);
      case 'undo':
      case 'redo':{
        if(data?.requestId){const request=pending.get(data.requestId);if(!request||request.agent!==data.agent||request.entry!==entry)throw Error('MCP history request cancelled');}
        const history=entry.record.replica.undo,source=action==='undo'?history.undoStack:history.redoStack,label=source.at(-1)?.meta.get('label');
        if(data?.agent&&label!==`agent:${data.agent}`)return false;
        entry.record.replica.history(action);const target=action==='undo'?history.redoStack:history.undoStack;if(label!==undefined)target.at(-1)?.meta.set('label',label);
        await manager.save(entry);manager.confirmGeneration(entry,generation);return manager.snapshot(entry);
      }
      case 'flush':await manager.save(entry);return true;
      case 'rename':return manager.rename(entry.record.id,data.title);
      case 'thumbnail':if(typeof data.src==='string'&&data.src.startsWith('data:image/')&&data.src.length<500000){entry.record.thumbnail=data.src;await manager.save(entry);}return true;
      case 'host':return startHost(entry,data);
      case 'invite':return entry.collab?.invite(data.address);
      case 'leave':await stopSession(entry);return true;
      case 'cursor':entry.collab?.cursor(data);return true;
      case 'export-file':{const file=exportFileData(data),result=await fileDialogs.save({defaultPath:file.name,filters:[{name:file.format.toUpperCase(),extensions:[file.format]}]});if(result.canceled)return false;await atomicWrite(result.filePath,file.bytes);return true;}
      case 'export':{
        const format=data.format;if(!['omc','json','svg','png'].includes(format))throw Error('Unsupported export');
        const result=await fileDialogs.save({defaultPath:entry.record.title.replace(/[\\/:*?"<>|]/g,'-')+'.'+format,filters:[{name:format.toUpperCase(),extensions:[format]}]});if(result.canceled)return false;
        let content=format==='omc'?encodeFile(entry.record):data.content;if(typeof content!=='string'||content.length>100*1024*1024)throw Error('Invalid export data');if(format==='png')content=Buffer.from(content.replace(/^data:image\/png;base64,/,''),'base64');await atomicWrite(result.filePath,content);return true;
      }
      default:throw Error('Unknown document action');
    }
  }
  const runtimeActions=new Set(['snapshot','runtime-ready','bootstrap','commit','undo','redo','flush','rename','thumbnail','host','invite','leave','cursor','export','export-file']);
  ipcMain.handle('omc:invoke',async(event,action,data)=>{
    const sender=source(event);
    if(action==='preferences')return preferences(data);
    if(action==='mcp-info')return mcpInfo(data);
    if(action==='pick-files')return fileDialogs.pick(data);
    if(action==='join')return join(data);
    if(action==='show-library')return manager.showLibrary();
    if(sender.role==='document'){
      if(!runtimeActions.has(action))throw Error('Action is unavailable to a document renderer');
      if(action==='cursor'||action==='runtime-ready'||action==='snapshot')return documentAction(sender.entry,action,data);
      return manager.enqueue(sender.entry,()=>{manager.confirmGeneration(sender.entry,sender.generation);if(sender.entry.runtime?.sender!==sender.sender)throw Object.assign(Error('Document renderer sender changed before this operation could run'),{code:'runtime_restarted'});return documentAction(sender.entry,action,data);});
    }
    if(action==='workspace')return manager.state();
    if(action==='library')return library();
    if(action==='activate-document'){const entry=await manager.open(data.id,{focus:true});return {...metadata(entry),...manager.state()};}
    if(action==='close-document')return manager.closeTab(data.id);
    if(action==='runtime-command'){const id=data?.id??manager.state().activeTabId;if(!id)throw Error('Select a canvas first');const entry=manager.entries.get(id);if(!entry?.runtime)throw Error('Document renderer is unavailable');return runtimeRequest(entry,'command',{name:data.name});}
    const operation=shellWork.then(async()=>{
      if(action==='create'){const document=data?.document?assertDocument(data.document):data?.sample?sampleDocument():blankDocument();const entry=await manager.create(data?.title??(data?.sample?'Studio 01':'Untitled canvas'),document,{focus:data?.focus??true});return {...metadata(entry),...manager.state()};}
      if(action==='open'){const entry=await manager.open(data.id,{focus:data.focus??true});return {...metadata(entry),...manager.state()};}
      if(action==='rename')return manager.rename(data.id,data.title);
      if(action==='duplicate'){const entry=await manager.duplicate(data.id,data.title,{focus:data.focus??true});return {...metadata(entry),...manager.state()};}
      if(action==='import')return importFile();
      if(action==='delete'){
        const entry=manager.entries.get(data.id),metadata=entry?.record??(await store.list()).find(record=>record.id===data.id);if(!metadata)throw Error('Canvas was not found');
        await manager.remove(data.id,{expectedTitle:metadata.title,beforeRemove:entry=>entry.runtime?runtimeRequest(entry,'prepare-delete'):undefined,cancelRemove:entry=>entry.runtime?runtimeRequest(entry,'cancel-delete'):undefined});sendShell({type:'library-changed'});return true;
      }
      if(action==='cancel-close'){closing=false;bridge?.resumeAccepting?.();return true;}
      throw Error('Unknown app action');
    });shellWork=operation.catch(()=>{});return operation;
  });
  ipcMain.on('omc:tool-result',(event,id,result)=>{
    let sender;try{sender=source(event);}catch{return;}
    const request=pending.get(id);
    if(sender.role!=='document'||!request||request.sender!==event.sender||request.entry!==sender.entry||request.generation!==sender.generation)return;
    request.resolve(result);
  });
  if(!process.argv.includes('--mcp-disabled'))try{
    const override=process.argv.find(value=>value.startsWith('--mcp-port='))?.slice(11),port=override===undefined?(profile?0:MCP_PORT):Number(override);
    if(!Number.isInteger(port)||port<0||port>65535)throw Error('Invalid MCP port');
    bridge=await startMcpBridge({dir,port,endSession:endAgent,dispatch:(call,options)=>{const task=mcpDispatch(call,options);activeCalls.add(task);void task.then(()=>activeCalls.delete(task),()=>activeCalls.delete(task));return task;}});
  }catch(error){bridgeError=error.code==='EADDRINUSE'?'MCP port is already in use. Close the other listener or choose --mcp-port.':error.message;}
  const mime={'.html':'text/html','.js':'application/javascript','.mjs':'application/javascript','.css':'text/css','.wasm':'application/wasm','.woff2':'font/woff2','.png':'image/png','.svg':'image/svg+xml','.json':'application/json'};
  protocol.handle('omc',async request=>{
    const url=new URL(request.url);if(url.hostname!=='canvas')return new Response('Not found',{status:404});
    let name;try{name=decodeURIComponent(url.pathname);}catch{return new Response('Invalid path',{status:400});}
    const base=path.join(root,'dist'),file=path.resolve(base,'.'+name);if(!file.startsWith(base+path.sep))return new Response('Forbidden',{status:403});
    try{return new Response(await fs.readFile(file),{headers:{'Content-Type':mime[path.extname(file)]||'application/octet-stream','Content-Security-Policy':"default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data: blob:; connect-src 'self' data: blob:; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-src 'none'"}});}catch{return new Response('Not found',{status:404});}
  });
  win=new BrowserWindow({show:!backgroundTest,width:1500,height:980,minWidth:960,minHeight:640,title:'Oh My Canvas',backgroundColor:'#ffffff',titleBarStyle:'hiddenInset',trafficLightPosition:{x:18,y:10},webPreferences:{preload:path.join(root,'dist/preload.cjs'),backgroundThrottling:false,contextIsolation:true,sandbox:true,nodeIntegration:false,webSecurity:true}});
  secure(win.webContents,'omc://canvas/index.html');
  win.webContents.session.setPermissionRequestHandler((_,__,callback)=>callback(false));win.webContents.session.on('will-download',event=>event.preventDefault());
  win.on('resize',layoutViews);
  function activeCommand(name){const id=manager.state().activeTabId;if(id){const entry=manager.entries.get(id);if(entry)sendRuntime(entry,{type:'command',name});}else sendShell({type:'error',message:'Select a canvas first'});}
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {label:'Oh My Canvas',submenu:[{role:'about'},{type:'separator'},{role:'hide'},{role:'hideOthers'},{type:'separator'},{role:'quit'}]},
    {label:'File',submenu:[{label:'New canvas',accelerator:'CmdOrCtrl+N',click:()=>sendShell({type:'command',name:'new'})},{label:'Open…',accelerator:'CmdOrCtrl+O',click:()=>sendShell({type:'command',name:'import'})},{label:'Document library',accelerator:'CmdOrCtrl+Shift+L',click:()=>sendShell({type:'command',name:'library'})},{label:'Rename canvas',click:()=>activeCommand('rename')},{label:'Export canvas',click:()=>activeCommand('export')},{label:'Save',accelerator:'CmdOrCtrl+S',click:()=>activeCommand('save')}]},
    {label:'Edit',submenu:[{label:'Undo',accelerator:'CmdOrCtrl+Z',click:()=>activeCommand('undo')},{label:'Redo',accelerator:'CmdOrCtrl+Shift+Z',click:()=>activeCommand('redo')},{type:'separator'},{role:'cut'},{role:'copy'},{role:'paste'},{role:'selectAll'}]},
    {label:'View',submenu:[{role:'togglefullscreen'},...(process.argv.includes('--debug-ui')?[{role:'toggleDevTools'}]:[])]}
  ]));
  async function closeApplication(){
    if(closing||quitting)return;closing=true;bridge?.stopAccepting();cancelRequests('Application is closing');
    try{
      await shellWork;await Promise.allSettled([...activeCalls]);
      const results=await Promise.allSettled([...manager.entries.values()].filter(entry=>entry.runtime).map(async entry=>{try{await runtimeRequest(entry,'close');}catch(error){throw Error(entry.record.title+': '+error.message);}}));
      const failed=results.find(result=>result.status==='rejected');if(failed)throw failed.reason;
      for(const entry of manager.entries.values())await stopSession(entry);
      await manager.flushAll();await bridge?.close();await manager.disposeAll();quitting=true;win.close();app.quit();
    }catch(error){closing=false;bridge?.resumeAccepting?.();for(const entry of manager.entries.values())sendRuntime(entry,{type:'close-cancelled'});sendShell({type:'error',message:'Could not save before closing: '+error.message});const id=manager.state().activeTabId;if(id)sendRuntime(manager.entries.get(id),{type:'error',message:'Could not save before closing: '+error.message});}
  }
  win.on('close',event=>{if(!quitting){event.preventDefault();void closeApplication();}});
  app.on('before-quit',event=>{if(!quitting){event.preventDefault();void closeApplication();}});
  ipcMain.handle('omc:ready-to-close',async event=>{source(event);await closeApplication();});
  app.on('second-instance',()=>{if(!backgroundTest){win.show();win.focus();}});
  app.on('window-all-closed',()=>{if(quitting)app.quit();});
  await win.loadURL('omc://canvas/index.html');if(bridgeError)sendShell({type:'error',message:'MCP unavailable: '+bridgeError});
}).catch(error=>{console.error(error);dialog.showErrorBox('Oh My Canvas could not start',error.message);app.exit(1);});
}
