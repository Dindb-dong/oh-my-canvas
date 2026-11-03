import {app,BrowserWindow,ipcMain,dialog,protocol,Menu,clipboard} from 'electron';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import os from 'node:os';
import {Store,atomicWrite,decodeFile,encodeFile} from '../core/storage.mjs';
import {Replica} from '../core/replica.mjs';
import {exportFileData} from '../core/export-file.mjs';
import {assertDocument,same,MAX_ENVELOPE_BYTES} from '../core/document.mjs';
import {Collaboration,parseInvite} from '../core/collaboration.mjs';
import {startMcpBridge} from './mcp-bridge.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
app.setName('oh-my-canvas');
const profile=process.argv.find(x=>x.startsWith('--profile='))?.slice(10);
if(profile)app.setPath('userData',path.resolve(profile));
// Separate profiles permit independent local clients for collaborative acceptance tests.
if(!app.requestSingleInstanceLock()){app.quit();}else{
protocol.registerSchemesAsPrivileged([{scheme:'omc',privileges:{standard:true,secure:true,supportFetchAPI:true,corsEnabled:true,stream:true}}]);
app.whenReady().then(async()=>{
const dir=app.getPath('userData'),store=new Store(path.join(dir,'documents'));
let win,current,collab,bridge,saveTimer,quitting=false,seq=0;
let prefs={name:os.userInfo().username},prefsWork=Promise.resolve();
try{prefs={...prefs,...JSON.parse(await fs.readFile(path.join(dir,'preferences.json'),'utf8'))};}catch{}
const pendingTools=new Map();
const send=m=>{if(win&&!win.isDestroyed())win.webContents.send('omc:event',m);};
const snapshot=ack=>current&&({id:current.id,title:current.title,document:current.replica.document,ack:ack??seq});
let saveWork=Promise.resolve();
async function save(){clearTimeout(saveTimer);if(current){const record=current;saveWork=store.save(record);await saveWork;send({type:'saved',id:record.id,at:Date.now()});}}
function dirty(){clearTimeout(saveTimer);saveTimer=setTimeout(()=>save().catch(e=>send({type:'error',message:'Save failed: '+e.message})),400);}
async function stopSession(){if(collab){const previous=collab;collab=null;await previous.close();}send({type:'session',status:{mode:'offline',peers:[]}});}
async function open(record){
  const recovered=!!record.recovered;
  await save();await stopSession();current?.unsubscribe?.();current?.replica.destroy();
  current=record;seq=0;current.bootstrapNonce=randomUUID();current.bootstrapBase=current.replica.document;
  current.unsubscribe=current.replica.onUpdate(()=>{dirty();send({type:'document',...snapshot()});});
  await save();return {...snapshot(),recovered,bootstrapNonce:current.bootstrapNonce};
}
function bindSession(c){
  collab=c;c.on('status',status=>send({type:'session',status}));c.on('cursor',data=>send({type:'cursor',...data}));
  c.on('warning',message=>send({type:'error',message}));
}
function requireCurrent(){if(!current)throw Error('Open a document first');return current;}
function trusted(event){if(event.sender!==win?.webContents||event.senderFrame?.url!=='omc://canvas/index.html')throw Error('Untrusted IPC sender');}
const limitedTitle=s=>String(s||'Untitled canvas').trim().slice(0,120)||'Untitled canvas';
const dispatch=async(action,data)=>{
  switch(action){
    case 'library':return store.list();
    case 'snapshot':requireCurrent();return snapshot();
    case 'preferences':{
      const task=prefsWork.then(async()=>{
        if(data){
          const next={...prefs,name:String(data.name||prefs.name).slice(0,40)};
          if(typeof data.toggleStar==='string'&&/^[a-zA-Z0-9-]{1,64}$/.test(data.toggleStar)){
            const starred=new Set(next.starred||[]);if(starred.has(data.toggleStar))starred.delete(data.toggleStar);else if(starred.size<10000)starred.add(data.toggleStar);next.starred=[...starred];
          }
          if(['grid','list'].includes(data.view))next.view=data.view;
          await atomicWrite(path.join(dir,'preferences.json'),JSON.stringify(next));prefs=next;
        }
        return structuredClone(prefs);
      });prefsWork=task.catch(()=>{});return task;
    }
    case 'create':{assertDocument(data.document);const record={id:randomUUID(),title:limitedTitle(data.title),createdAt:new Date().toISOString(),replica:new Replica({document:data.document})};return open(record);}
    case 'open':return open(await store.load(data.id));
    case 'rename':{requireCurrent();current.title=limitedTitle(data.title);await save();return snapshot();}
    case 'duplicate':{const original=await store.load(data.id);const record={id:randomUUID(),title:original.title+' copy',createdAt:new Date().toISOString(),replica:new Replica({document:original.replica.document}),thumbnail:original.thumbnail};original.replica.destroy();return open(record);}
    case 'delete':{if(current?.id===data.id){await save();await stopSession();current.unsubscribe?.();current.replica.destroy();current=null;}await store.remove(data.id);return true;}
    case 'bootstrap':{
      requireCurrent();
      if(data.id!==current.id||seq!==0||typeof data.nonce!=='string'||data.nonce!==current.bootstrapNonce)throw Error('Invalid canvas initialization');
      if(!same(current.bootstrapBase,current.replica.document)){
        current.bootstrapNonce=randomUUID();current.bootstrapBase=current.replica.document;
        return {...snapshot(),bootstrapNonce:current.bootstrapNonce,bootstrapRetry:true};
      }
      current.bootstrapNonce=null;current.bootstrapBase=null;
      current.replica.patch(data.changes,'Initialize canvas',undefined,{recordHistory:false});
      await save();return snapshot();
    }
    case 'commit':{requireCurrent();if(data.id!==current.id)throw Error('Document changed');if(!Number.isSafeInteger(data.seq))throw Error('Invalid edit sequence');if(data.seq<=seq)return snapshot();current.replica.patch(data.changes,data.label,data.group);await save();seq=data.seq;return snapshot();}
    case 'undo':{const r=requireCurrent().replica;if(data?.agent&&r.undo.undoStack.at(-1)?.meta.get('label')!==`agent:${data.agent}`)return false;r.history('undo');await save();return snapshot();}
    case 'redo':requireCurrent().replica.history('redo');await save();return snapshot();
    case 'flush':await save();return true;
    case 'thumbnail':{requireCurrent();if(typeof data.src==='string'&&data.src.startsWith('data:image/')&&data.src.length<500000){current.thumbnail=data.src;dirty();}return true;}
    case 'import':{
      const result=await dialog.showOpenDialog(win,{title:'Open canvas',filters:[{name:'Canvas documents',extensions:['omc','json']}],properties:['openFile']});
      if(result.canceled)return null;
      const stat=await fs.stat(result.filePaths[0]);if(stat.size>MAX_ENVELOPE_BYTES)throw Error('Document file exceeds 24 MiB');
      const raw=await fs.readFile(result.filePaths[0],'utf8');
      if(result.filePaths[0].endsWith('.omc')){
        const f=decodeFile(raw);
        // Opening an older portable copy must not erase this device's newer offline edits.
        try{const existing=await store.load(f.id);try{f.replica.receive(existing.replica.state);}finally{existing.replica.destroy();}}catch(e){if(e.code!=='ENOENT'){f.replica.destroy();throw e;}}
        return {opened:await open(f)};
      }
      return {json:JSON.parse(raw),title:path.basename(result.filePaths[0],'.json')};
    }
    case 'export-file':{
      requireCurrent();const file=exportFileData(data);
      const result=await dialog.showSaveDialog(win,{defaultPath:file.name,filters:[{name:file.format.toUpperCase(),extensions:[file.format]}]});
      if(result.canceled)return false;
      await atomicWrite(result.filePath,file.bytes);return true;
    }
    case 'export':{
      requireCurrent();const format=data.format;
      if(!['omc','json','svg','png'].includes(format))throw Error('Unsupported export');
      const result=await dialog.showSaveDialog(win,{defaultPath:current.title.replace(/[\\/:*?"<>|]/g,'-')+'.'+format,filters:[{name:format.toUpperCase(),extensions:[format]}]});
      if(result.canceled)return false;
      let content=format==='omc'?encodeFile(current):data.content;
      if(typeof content!=='string'||content.length>100*1024*1024)throw Error('Invalid export data');
      if(format==='png')content=Buffer.from(content.replace(/^data:image\/png;base64,/,''),'base64');
      await atomicWrite(result.filePath,content);return true;
    }
    case 'mcp-info':{
      const config={mcpServers:{'oh-my-canvas':{command:process.execPath,args:[app.isPackaged?path.join(process.resourcesPath,'mcp-cli.cjs'):path.join(root,'dist/mcp-cli.cjs'),'--runtime',bridge.file],env:{ELECTRON_RUN_AS_NODE:'1'}}}};
      const text=JSON.stringify(config,null,2);if(data?.copy)clipboard.writeText(text);return {config:text,port:bridge.port,runtime:bridge.file};
    }
    case 'host':{
      requireCurrent();await stopSession();const c=new Collaboration({replica:current.replica,id:current.id,title:current.title,name:prefs.name});bindSession(c);
      try{await c.host({port:Number(data?.port)||0});}catch(e){await stopSession();throw e;}
      const addresses=Object.values(os.networkInterfaces()).flat().filter(a=>a?.family==='IPv4'&&!a.internal).map(a=>a.address);
      return {port:c.port,addresses};
    }
    case 'invite':return collab?.invite(data.address);
    case 'join':{
      const invitation=parseInvite(data.invite);await save();await stopSession();
      let record;
      try{record=await store.load(invitation.room);}catch(e){if(e.code!=='ENOENT')throw e;}
      if(!record){
        // Join a new replica with no seed history. Welcome supplies the host's state.
        record={id:invitation.room,title:limitedTitle(invitation.title),createdAt:new Date().toISOString(),replica:new Replica()};
      }
      const c=new Collaboration({replica:record.replica,id:record.id,title:record.title,name:prefs.name});
      try{
        // Do not expose an uninitialized replica to the renderer or autosave.
        await c.join(data.invite);
        await save();current?.unsubscribe?.();current?.replica.destroy();current=record;seq=0;current.bootstrapNonce=randomUUID();current.bootstrapBase=current.replica.document;
        current.unsubscribe=current.replica.onUpdate(()=>{dirty();send({type:'document',...snapshot()});});bindSession(c);await save();send({type:'session',status:c.status()});return {...snapshot(),bootstrapNonce:current.bootstrapNonce};
      }catch(e){await c.close();record.replica.destroy();throw e;}
    }
    case 'leave':await stopSession();return true;
    case 'cursor':collab?.cursor(data);return true;
    default:throw Error('Unknown app action');
  }
};
let operations=Promise.resolve();
ipcMain.handle('omc:invoke',async(event,action,data)=>{trusted(event);if(action==='cursor')return dispatch(action,data);const result=operations.then(()=>dispatch(action,data));operations=result.catch(()=>{});return result;});
ipcMain.on('omc:tool-result',(event,id,result)=>{trusted(event);const pending=pendingTools.get(id);if(pending){clearTimeout(pending.timer);pendingTools.delete(id);pending.resolve(result);}});
bridge=await startMcpBridge({dir,dispatch:call=>{
  if(!current)throw Error('Open a document in Oh My Canvas first');
  if(pendingTools.size>=8)throw Error('Too many pending MCP requests');
  return new Promise((resolve,reject)=>{const id=randomUUID();const timer=setTimeout(()=>{pendingTools.delete(id);reject(Error('Editor tool timed out'));},63000);pendingTools.set(id,{resolve,reject,timer});send({type:'tool',id,call});});
}});
const mime={'.html':'text/html','.js':'application/javascript','.css':'text/css','.wasm':'application/wasm','.woff2':'font/woff2','.png':'image/png','.svg':'image/svg+xml','.json':'application/json'};
protocol.handle('omc',async req=>{
  const u=new URL(req.url);if(u.hostname!=='canvas')return new Response('Not found',{status:404});
  let name;try{name=decodeURIComponent(u.pathname);}catch{return new Response('Invalid path',{status:400});}
  const base=path.join(root,'dist'),file=path.resolve(base,'.'+name);
  if(!file.startsWith(base+path.sep))return new Response('Forbidden',{status:403});
  try{return new Response(await fs.readFile(file),{headers:{'Content-Type':mime[path.extname(file)]||'application/octet-stream','Content-Security-Policy':"default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data: blob:; connect-src 'self' data: blob:; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-src 'none'"}});}catch{return new Response('Not found',{status:404});}
});
win=new BrowserWindow({width:1500,height:980,minWidth:960,minHeight:640,title:'Oh My Canvas',backgroundColor:'#ffffff',titleBarStyle:'hiddenInset',trafficLightPosition:{x:18,y:20},webPreferences:{preload:path.join(root,'dist/preload.cjs'),backgroundThrottling:false,contextIsolation:true,sandbox:true,nodeIntegration:false,webSecurity:true}});
win.webContents.setWindowOpenHandler(()=>({action:'deny'}));
win.webContents.on('will-navigate',(event,url)=>{if(url!=='omc://canvas/index.html')event.preventDefault();});
win.webContents.session.setPermissionRequestHandler((_,__,cb)=>cb(false));
win.webContents.session.on('will-download',event=>event.preventDefault());
Menu.setApplicationMenu(Menu.buildFromTemplate([
  {label:'Oh My Canvas',submenu:[{role:'about'},{type:'separator'},{role:'hide'},{role:'hideOthers'},{type:'separator'},{role:'quit'}]},
  {label:'File',submenu:[{label:'New canvas',accelerator:'CmdOrCtrl+N',click:()=>send({type:'command',name:'new'})},{label:'Open…',accelerator:'CmdOrCtrl+O',click:()=>send({type:'command',name:'import'})},{label:'Document library',accelerator:'CmdOrCtrl+Shift+L',click:()=>send({type:'command',name:'library'})},{label:'Save',accelerator:'CmdOrCtrl+S',click:()=>save().catch(e=>send({type:'error',message:e.message}))}]},
  {label:'Edit',submenu:[{label:'Undo',accelerator:'CmdOrCtrl+Z',click:()=>send({type:'command',name:'undo'})},{label:'Redo',accelerator:'CmdOrCtrl+Shift+Z',click:()=>send({type:'command',name:'redo'})},{type:'separator'},{role:'cut'},{role:'copy'},{role:'paste'},{role:'selectAll'}]},
  {label:'View',submenu:[{role:'togglefullscreen'},...(process.argv.includes('--debug-ui')?[{role:'toggleDevTools'}]:[])]}
]));
await win.loadURL('omc://canvas/index.html');
app.on('second-instance',()=>{win?.show();win?.focus();});
win.on('close',event=>{if(!quitting){event.preventDefault();send({type:'closing'});}});
ipcMain.handle('omc:ready-to-close',async event=>{trusted(event);if(quitting)return;quitting=true;try{await operations;await save();await stopSession();await bridge.close();app.quit();}catch(e){quitting=false;send({type:'error',message:'Could not save before closing: '+e.message});}});
app.on('window-all-closed',()=>app.quit());
}).catch(error=>{console.error(error);dialog.showErrorBox('Oh My Canvas could not start',error.message);app.exit(1);});
}
