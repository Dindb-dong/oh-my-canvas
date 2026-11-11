import './style.css';
import {icon} from './icons.js';
import {mountEditor,installLvMcp,screenToWorld,worldToScreen} from '../editor';
import {changesBetween,changesFromPatches} from '../core/document.mjs';
import {DocumentProjection} from '../core/projection.mjs';
import fontFaces from './fonts.json';
import {removeBackground} from '../editor/images/background';
import {embedImageSource,isExternalImageSource} from '../editor/images/assets';
import {drainPendingCommits,createDocumentWriteQueue,createSnapshotResync,commitErrorMessage} from './document-sync.mjs';
import {createThumbnailScheduler} from './document-thumbnail.mjs';

const $=s=>document.querySelector(s), api=window.omc;
const resolveImageSource=src=>/^omc-asset:sha256:[a-f0-9]{64}$/.test(src)?`omc://canvas/assets/${src.slice(-64)}`:src;
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let handle,mcp,active,lastDoc,nextSeq=0,mounting=false,unsubscribe;
let session={mode:'offline',peers:[]},prefs={},toastTimer,dialogFocus,hosting,sessionTab='host';
let lastRejected,closing=false,titleEdit=null,ready=false,saveFailed=false;
let projection;
const params=new URLSearchParams(location.search),documentId=params.get('documentId'),generation=Number(params.get('generation'));
if(!documentId||!Number.isSafeInteger(generation)||generation<1)throw Error('Invalid document runtime identity');
const startupDiagnostics=params.get('startupDiagnostics')==='1',startupAt=performance.now();
let startupReports=0,startupComplete=false;
function startupTiming(value,ms){
  if(!startupDiagnostics||startupComplete||startupReports>=128)return;
  const phase=typeof value==='string'?value:value?.phase,duration=typeof value==='string'?ms:value?.ms;
  if(typeof phase!=='string'||phase.length>80||!/^[-.\w]+$/.test(phase)||!Number.isFinite(duration))return;
  startupReports++;
  console.info('[omc-startup]',JSON.stringify({phase,ms:Math.round(duration*100)/100,elapsedMs:Math.round((performance.now()-startupAt)*100)/100}));
}
function startupSync(phase,run){
  if(!startupDiagnostics)return run();
  const start=performance.now();startupTiming(phase+'.start',0);
  try{return run();}finally{startupTiming(phase,performance.now()-start);}
}
async function startupStep(phase,run){
  if(!startupDiagnostics)return run();
  const start=performance.now();startupTiming(phase+'.start',0);
  try{return await run();}finally{startupTiming(phase,performance.now()-start);}
}
function assertIdentity(value){
  if(!value||(value.documentId??value.id)!==documentId||value.generation!==generation)throw Error('Document runtime identity mismatch');
}
const cursors=new Map(),colors=['#1d4ed8','#0369a1','#6d28d9','#475569'];
const thumbnails=createThumbnailScheduler({
  current:()=>handle&&active&&ready&&!mounting&&!closing?{id:active.id,view:handle.view,pageId:handle.editor.pageId,objects:handle.editor.page.objects,assets:handle.editor.doc.assets,viewport:handle.editor.viewport}:null,
  save:shot=>api.invoke('thumbnail',{src:`data:${shot.mimeType};base64,${shot.data}`}),
});
window.addEventListener('pagehide',()=>thumbnails.reset());

function toast(message,error=false){clearTimeout(toastTimer);$('#toast').textContent=commitErrorMessage(message);$('#toast').classList.toggle('error-toast',error);$('#toast').hidden=false;toastTimer=setTimeout(()=>{$('#toast').hidden=true;},error?8000:3500);}
const run=fn=>async(...args)=>{try{return await fn(...args);}catch(e){toast(e.message,true);return undefined;}};
function modal(title,body){dialogFocus=document.activeElement;const d=$('#dialog');if(d.open)d.close();$('#dialog-content').innerHTML=`<div class="dialog-heading"><h2>${esc(title)}</h2><button class="close" aria-label="Close dialog">${icon('close')}</button></div>${body}`;$('.close').onclick=()=>d.close();d.showModal();}
$('#dialog').addEventListener('close',()=>dialogFocus?.focus?.());
$('#dialog').addEventListener('click',e=>{if(e.target===$('#dialog')){const b=e.target.getBoundingClientRect();if(e.clientX<b.left||e.clientX>b.right||e.clientY<b.top||e.clientY>b.bottom)e.target.close();}});
function setTitle(){
  const file=$('#editor .file-name b');if(file&&active)file.textContent=active.title;
  $('#document-name').textContent=active?.title||'Untitled canvas';
  const editing=!!titleEdit&&titleEdit.id===active?.id;
  $('#document-title').hidden=editing;$('#title-form').hidden=!editing;
  $('#document-title').disabled=!active;$('#document-title').setAttribute('aria-label','Rename canvas: '+(active?.title||''));
  updateSaveState();document.title=(active?.title||'Oh My Canvas')+' — Oh My Canvas';
}
function updateSaveState(){
  const stored=!!projection&&projection.ack>=nextSeq&&!projection.pending.length;
  $('#save-state').textContent=stored?'Stored on this computer':saveFailed?'Save failed':'Saving…';
}
const resync=createSnapshotResync({
  snapshot:()=>api.invoke('snapshot'),getRevision:()=>projection?.revision??0,
  accept:snap=>{assertIdentity(snap);return acceptProjection(snap);},
});
async function drain(through){
  if(projection.pending.some(item=>item.seq<=through)){saveFailed=false;updateSaveState();}
  try{await drainPendingCommits({
    getProjection:()=>projection,commit:item=>api.invoke('commit',{id:documentId,...item}),project,
    refresh:revision=>resync.request(revision??projection.revision,{force:true}),
    onRejected:(seq,error)=>{lastRejected={seq,message:commitErrorMessage(error)};toast('Could not persist edit: '+lastRejected.message,true);},
  },through);}catch(error){saveFailed=true;updateSaveState();throw error;}
}
const writes=createDocumentWriteQueue({drain,wait:()=>resync.wait(),flush:()=>api.invoke('flush'),invokeHistory:(action,args)=>api.invoke(action,args),project});
async function settle(flushEditor=true){
  if(mounting&&flushEditor)throw Error('Wait for the canvas to finish opening');
  if(flushEditor)await handle?.flush?.();
  await writes.flush(nextSeq);
}
function history(action,agent,signal,requestId){
  return writes.history(action,{agent,requestId},nextSeq,signal);
}
function acceptProjection(snap){
  const result=projection.accept(snap);
  if(result.ignored||result.resync)return result;
  updateSaveState();
  const doc=result.document;
  // The durable baseline excludes an active local preview retained by receiveDocument.
  lastDoc=doc;
  if(result.redundant||doc===handle.editor.doc)return result;
  handle.editor.receiveDocument(doc,{incremental:!snap.document});
  paintCursors();
  return result;
}
function project(snap){
  if(snap.id!==documentId||snap.generation!==generation)return;
  if(!handle||mounting){resync.note(snap.revision??0);return;}
  const result=acceptProjection(snap);
  if(result.resync)return resync.request(snap.revision);
}
async function openSnapshot(snap){
  assertIdentity(snap);
  mounting=true;$('#editor').inert=true;
  try {thumbnails.reset();mcp?.dispose?.();unsubscribe?.();await handle?.destroy();handle=null;cursors.clear();$('#remote-cursors').replaceChildren();
  projection=startupSync('startup.projection',()=>new DocumentProjection(snap));nextSeq=0;lastRejected=null;saveFailed=false;active={id:snap.id,title:snap.title};setTitle();
  let candidate=snap;
  for(let attempt=0;attempt<8;attempt++){
    handle=await startupStep('startup.mount',()=>mountEditor($('#editor'),{
      onTiming:startupDiagnostics?startupTiming:undefined,
      removeBackground:async(src,signal)=>removeBackground(isExternalImageSource(src)?await embedImageSource(src,resolveImageSource,{left:16*1024*1024},signal):src,signal),
      resolveImageSource,
      importDesignFile:(bytes,format)=>api.invoke('import-design',{bytes,format}),
      pickFiles:async options=>{const files=await api.invoke('pick-files',options);const mime={svg:'image/svg+xml',png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',gif:'image/gif',webp:'image/webp',avif:'image/avif',bmp:'image/bmp',ico:'image/x-icon',json:'application/json',woff:'font/woff',woff2:'font/woff2',ttf:'font/ttf',otf:'font/otf'};return files.map(file=>new File([file.bytes],file.name,{type:mime[file.name.split('.').pop().toLowerCase()]||'application/octet-stream'}));},
      exportFile:async(blob,name)=>api.invoke('export-file',{name,mime:blob.type,bytes:new Uint8Array(await blob.arrayBuffer())}),
      document:candidate.document,title:candidate.title,subtitle:'Oh My Canvas',faces:fontFaces.map(face=>({...face,url:new URL(face.url,location.href).href})),defaultFamily:'IBM Plex Sans',fallbacks:['Noto Sans KR','sans-serif'],wasmUrl:new URL('/canvaskit.wasm',location.href).href,
    }));
    const initialization=startupSync('startup.diff',()=>changesBetween(candidate.document,handle.editor.doc));
    if(candidate.bootstrapNonce){
      const initialized=await startupStep('startup.bootstrap',()=>api.invoke('bootstrap',{id:snap.id,nonce:candidate.bootstrapNonce,changes:initialization}));assertIdentity(initialized);
      if(initialized.bootstrapRetry){await handle.destroy();handle=null;candidate=initialized;continue;}
      // Keep the runtime inert until the mandatory fresh snapshot below. That
      // snapshot includes bootstrap and any intervening host edits, so applying
      // this intermediate document would repeat a full validation needlessly.
    }else if(initialization.length){throw Error('Canvas initialization token is missing');}
    break;
  }
  if(!handle)throw Error('Canvas changed repeatedly while opening. Please retry.');
  lastDoc=handle.editor.doc;
  handle.editor.undoStep=()=>{if(handle.editor.undo.blocked)return false;void run(()=>history('undo'))();return true;};
  handle.editor.redoStep=()=>{if(handle.editor.undo.blocked)return false;void run(()=>history('redo'))();return true;};
  mcp=installLvMcp(handle.editor,handle.view,{services:handle.services,afterWrite:()=>settle(false),fonts:()=>handle.fonts.catalog(),editing:()=>titleEdit?'canvas name':handle.editingText(),onHighlight:handle.highlightAgent,undo:(agent,signal,requestId)=>history('undo',agent,signal,requestId),redo:(agent,signal,requestId)=>history('redo',agent,signal,requestId)});
  unsubscribe=handle.editor.on(event=>{
    if(event.projection){thumbnails.schedule();return;}
    if(event.changes){
      const changes=changesFromPatches(lastDoc,handle.editor.doc,event.changes);lastDoc=handle.editor.doc;
      if(changes.length){
        const seq=++nextSeq,label=event.operation?.label,group=event.operation?.id;projection.enqueue({seq,changes,label,group});
        saveFailed=false;updateSaveState();
        void writes.commit(seq).catch(error=>toast('Could not persist edit: '+commitErrorMessage(error),true));
        thumbnails.schedule();
      }
    }
    if(event.viewport||event.page){paintCursors();thumbnails.schedule();}
    if(event.selection)sendCursor();
  });
  $('#editor button[aria-label="Collapse sidebar"]')?.remove();
  $('#editor button[aria-label="Comment (not available)"]')?.remove();
  $('#toggle-layers').setAttribute('aria-expanded','true');
  const latest=await startupStep('startup.finalSnapshot',()=>api.invoke('snapshot'));assertIdentity(latest);
  active.title=latest.title;projection=startupSync('startup.finalProjection',()=>new DocumentProjection(latest));lastDoc=latest.document;startupSync('startup.finalReceive',()=>handle.editor.receiveDocument(latest.document));
  setTitle();
  thumbnails.schedule();if(snap.recovered)toast('Recovered the last valid backup. Save a portable copy.',true);
  }catch(error){mcp?.dispose?.();unsubscribe?.();await handle?.destroy().catch(()=>{});handle=null;throw error;}finally{mounting=false;$('#editor').inert=false;}
  await startupStep('startup.resync',()=>resync.wait());
}
async function applyRename(id,title){const result=await api.invoke('rename',{id,title});if(active?.id===id){active.title=result.title;setTitle();}return result;}
function editTitle(){
  if(!active||mounting||closing)return;
  if(!titleEdit){titleEdit={id:active.id};$('#title-input').value=active.title;$('#title-input').readOnly=false;}
  setTitle();$('#title-input').focus();$('#title-input').select();
}
function cancelTitleEdit(){if(!titleEdit||titleEdit.saving)return;titleEdit=null;setTitle();$('#document-title').focus();}
async function saveTitleEdit(){
  const edit=titleEdit;if(!edit)return;if(edit.saving)return edit.saving;
  if(edit.id!==active?.id){titleEdit=null;setTitle();throw Error('Canvas changed; select its current title to rename it');}
  const input=$('#title-input'),value=input.value.trim();
  if(edit.composing||edit.composingKey){input.focus();throw Error('Finish composing the canvas name first');}
  if(!value||value.length>120){input.focus();throw Error('Use a canvas name with 1–120 characters');}
  input.readOnly=true;
  edit.saving=(async()=>{try{
    if(value!==active?.title)await applyRename(edit.id,value);
    const focused=document.activeElement===input;
    if(titleEdit===edit){titleEdit=null;setTitle();if(focused)$('#document-title').focus();}
  }catch(error){if(titleEdit===edit){input.readOnly=false;input.focus();}throw error;}finally{edit.saving=null;}})();
  return edit.saving;
}
function exportDialog(){
  if(!handle)return;
  modal('Export canvas',`<p>A portable .omc file includes the full editable document, embedded images and merge history.</p><div class="export-options"><button data-format="omc">Oh My Canvas <small>Editable .omc document, for backup and sharing</small></button><button data-format="json">Canvas JSON <small>Open interchange format</small></button><button data-format="svg">SVG <small>Vector export of the selected board</small></button><button data-format="png">PNG <small>Raster preview of the selected board</small></button></div>`);
  for(const b of document.querySelectorAll('[data-format]'))b.onclick=run(async()=>{
    await settle();const format=b.dataset.format;let content;
    if(format==='svg'){
      const id=handle.editor.selection[0]||handle.editor.page.objects.root.childIds[0];
      if(!id)throw Error('Create a board or select an element first');
      content=await handle.export.svg([id]);
    }else if(format==='png'){
      const id=handle.editor.selection[0]||handle.editor.page.objects.root.childIds[0];
      const shot=await handle.view.screenshot(id,{mode:'overview'});
      if(shot.mimeType==='image/png')content='data:image/png;base64,'+shot.data;
      else{const img=new Image();img.src=`data:${shot.mimeType};base64,${shot.data}`;await img.decode();const c=document.createElement('canvas');c.width=img.width;c.height=img.height;c.getContext('2d').drawImage(img,0,0);content=c.toDataURL('image/png');}
    }
    if(await api.invoke('export',{format,content})){toast('Export saved');$('#dialog').close();}
  });
}
const toolRequests=new Map(),toolTasks=new Map();
const toolResponse=value=>({content:[{type:'text',text:JSON.stringify(value)}],structuredContent:value});
async function mcpDialog(){
  const info=await api.invoke('mcp-info');
  if(!info.available){toast('MCP unavailable: '+info.error,true);return;}
  modal('Connect your agent',`<p>Use a local MCP client to find, open, create and edit canvases. No account, API key or credits are needed.</p><label for="mcp-config">MCP client configuration</label><textarea id="mcp-config" readonly rows="9">${esc(info.config)}</textarea><p class="hint">The HTTPS server talks only on loopback. Trust this profile's public certificate in your client before connecting; never disable TLS verification. Supply OMC_MCP_TOKEN from the private mcp-token-v2 file in your app data directory to your client environment, then restart the client. The configuration contains no secret. Public certificate: ${esc(info.certificatePath)}. Keep this app open. Start with list_documents, then open_document or create_document and read get_context before editing. Each canvas stays open in its own tab. Use the intended documentId for every edit; background tabs remain available to agents. Do not automatically retry writes.</p><div class="actions right"><button id="copy-mcp" class="primary">Copy configuration</button></div>`);
  $('#copy-mcp').onclick=run(async()=>{await api.invoke('mcp-info',{copy:true});toast('MCP configuration copied');});
}
function slots(){return Array.from({length:4},(_,i)=>{const p=session.peers?.[i];return `<div class="slot ${p?'active':''}" title="${esc(p?.name||'Available')}">${esc(p?p.name:'Available')}${p?.host?'<br><small>Host</small>':''}</div>`;}).join('');}
function renderPeers(){
  $('#peers').innerHTML=(session.peers||[]).map(p=>`<span class="avatar" title="${esc(p.name)}${p.host?' · Host':''}">${esc(p.name.slice(0,2).toUpperCase())}</span>`).join('');
  if($('#session-slots'))$('#session-slots').innerHTML=slots();
  if($('#connection-state'))$('#connection-state').textContent=session.mode==='host'?'Hosting this canvas':session.mode==='guest'?(session.connected?'Connected to host':'Offline · Reconnecting'):'Local editing';
  for(const [id,c] of cursors)if(!(session.peers||[]).some(p=>p.id===id)){c.node.remove();cursors.delete(id);handle?.highlightAgent('peer:'+id,[]);}
}
async function collaborationDialog(){
  modal('Collaborate',`<p>Up to four people. Everyone keeps a local copy.</p><label for="peer-name">Your name</label><input id="peer-name" value="${esc(prefs.name||'Designer')}" maxlength="40"><div id="session-slots" class="slots">${slots()}</div><div class="connection"><strong id="connection-state"></strong>${session.mode!=='offline'?'<button id="leave-session">Leave session</button>':''}</div><div class="tabs" role="tablist"><button id="tab-host" role="tab" aria-selected="${sessionTab==='host'}">Host a canvas</button><button id="tab-join" role="tab" aria-selected="${sessionTab==='join'}">Join a canvas</button></div><div id="session-panel"></div>`);
  $('#peer-name').onchange=run(async()=>{prefs=await api.invoke('preferences',{name:$('#peer-name').value});});
  $('#tab-host').onclick=()=>{sessionTab='host';sessionPanel();};$('#tab-join').onclick=()=>{sessionTab='join';sessionPanel();};
  if($('#leave-session'))$('#leave-session').onclick=run(async()=>{await settle();await api.invoke('leave');hosting=null;$('#dialog').close();toast('Session ended on this computer. Your document is saved.');});
  renderPeers();sessionPanel();
}
function sessionPanel(){
  $('#tab-host').setAttribute('aria-selected',String(sessionTab==='host'));$('#tab-join').setAttribute('aria-selected',String(sessionTab==='join'));
  if(sessionTab==='host'){
    if(!active){$('#session-panel').innerHTML='<p>Open a canvas before hosting a session.</p>';return;}
    if(session.mode==='guest'){$('#session-panel').innerHTML='<p>Leave the current session before hosting your local replica.</p>';return;}
    if(session.mode==='host'){
      $('#session-panel').innerHTML=`<label for="host-address">Address teammates can reach</label><input id="host-address" placeholder="192.168.1.20:${hosting?.port||session.port}" value="${esc(hosting?.address||(hosting?.addresses?.[0]||'127.0.0.1')+':'+(hosting?.port||session.port))}"><p class="hint">On the same network, use your LAN address. Over the internet, forward this collaboration port and enter your public address. MCP stays private.</p><div class="actions right"><button id="make-invite" class="primary">Create invitation</button></div><div id="invite-result"></div>`;
      $('#make-invite').onclick=run(async()=>{const address=$('#host-address').value.trim();const invite=await api.invoke('invite',{address});if(hosting)hosting.address=address;$('#invite-result').innerHTML=`<label for="invite-text">Private invitation</label><textarea id="invite-text" readonly rows="4">${esc(invite)}</textarea><p class="hint">Share privately. Anyone with this invitation can edit this session. Ending hosting invalidates it.</p><button id="copy-invite">Copy invitation</button>`;$('#copy-invite').onclick=run(async()=>{await navigator.clipboard.writeText(invite);toast('Invitation copied');});});
    }else{
      $('#session-panel').innerHTML='<label for="host-port">Collaboration port</label><input id="host-port" type="number" min="0" max="65535" value="0"><p class="hint">0 chooses an available port. Use a fixed port for router forwarding. Hosting opens a TLS-encrypted port for invited teammates.</p><div class="actions right"><button id="start-host" class="primary">Start hosting</button></div>';
      $('#start-host').onclick=run(async()=>{await settle();prefs=await api.invoke('preferences',{name:$('#peer-name').value});const b=$('#start-host');b.disabled=true;try{hosting=await api.invoke('host',{port:Number($('#host-port').value)});session.mode='host';session.port=hosting.port;await collaborationDialog();}finally{if(b.isConnected)b.disabled=false;}});
    }
  }else{
    $('#session-panel').innerHTML='<label for="join-invite">Private invitation</label><textarea id="join-invite" placeholder="omc://join/…" rows="4" spellcheck="false"></textarea><p class="hint">Only open invitations from people you trust. Collaborators can change the shared document. The host must be online and reachable.</p><div class="actions right"><button id="join-session" class="primary">Join canvas</button></div>';
    $('#join-session').onclick=run(async()=>{await settle();prefs=await api.invoke('preferences',{name:$('#peer-name').value});const b=$('#join-session');b.disabled=true;b.textContent='Connecting…';try{await api.invoke('join',{invite:$('#join-invite').value.trim()});$('#dialog').close();toast('Joined the canvas');}finally{if(b.isConnected){b.disabled=false;b.textContent='Join canvas';}}});
  }
}
function paintCursors(){
  if(!handle)return;
  const stage=$('#editor #stage'),bounds=stage.getBoundingClientRect(),base=$('#workspace').getBoundingClientRect();
  for(const c of cursors.values()){
    const visible=c.cursor&&c.cursor.page===handle.editor.pageId;
    c.node.hidden=!visible;if(!visible)continue;
    const p=worldToScreen(handle.editor.viewport,c.cursor);
    c.node.style.transform=`translate(${p.x+bounds.x-base.x}px,${p.y+bounds.y-base.y}px)`;
  }
}
let pointer,lastCursor=0;
function sendCursor(){
  if(!handle||session.mode==='offline'||Date.now()-lastCursor<60)return;
  lastCursor=Date.now();const c=pointer||{x:0,y:0};void api.invoke('cursor',{...c,page:handle.editor.pageId,selection:[...handle.editor.selection]}).catch(()=>{});
}
$('#workspace').addEventListener('pointermove',e=>{if(!handle)return;const b=$('#editor #stage').getBoundingClientRect();pointer=screenToWorld(handle.editor.viewport,{x:e.clientX-b.x,y:e.clientY-b.y});sendCursor();});
$('#workspace').addEventListener('pointerleave',()=>{if(session.mode!=='offline')void api.invoke('cursor',null);});
function nativeHistory(redo){
  if(handle?.session?.active){handle.session.key({key:'z',metaKey:true,ctrlKey:true,shiftKey:redo});return;}
  if(document.activeElement?.matches('input,textarea,[contenteditable=true]')){document.execCommand(redo?'redo':'undo');return;}
  if(redo)handle?.editor.redoStep();else handle?.editor.undoStep();
}
api.on(message=>{
  if(message.documentId!==undefined&&(message.documentId!==documentId||message.generation!==generation))return;
  if(message.type==='document'||message.type==='document-delta')void Promise.resolve().then(()=>project(message)).catch(error=>toast('Could not synchronize canvas: '+error.message,true));
  else if(message.type==='saved'){if(message.id===active?.id)updateSaveState();}
  else if(message.type==='error')toast(message.message,true);
  else if(message.type==='session'){session=message.status;renderPeers();}
  else if(message.type==='cursor'){
    let c=cursors.get(message.id);
    if(!message.cursor){c?.node.remove();cursors.delete(message.id);handle?.highlightAgent('peer:'+message.id,[]);return;}
    if(!c){const color=colors[cursors.size%colors.length],node=document.createElement('div');node.className='remote-cursor';node.innerHTML=`<svg viewBox="0 0 20 24"><path d="M2 1 L2 19 L7 14 L11 22 L15 20 L11 12 L18 12 Z" fill="${color}" stroke="white"/></svg><span style="background:${color}">${esc(message.name)}</span>`;$('#remote-cursors').append(node);c={node};cursors.set(message.id,c);}
    c.cursor=message.cursor;handle?.highlightAgent('peer:'+message.id,message.cursor.selection||[]);paintCursors();
  }else if(message.type==='tool-cancel'){
    toolRequests.get(message.id)?.abort();
  }else if(message.type==='tool-session-end'){
    mcp?.endSession(message.agent);
  }else if(message.type==='tool'){
    const controller=new AbortController();toolRequests.set(message.id,controller);
    const task=(async()=>{try{
      assertIdentity(message.call);
      if(closing)throw Error('Editor is closing');
      if(!ready||mounting||!mcp)throw Error('Canvas is busy opening');
      const before=nextSeq;
      let result=await mcp.handleToolCall(message.call.agent,message.call.name,message.call.args,{...message.call.context,signal:controller.signal,requestId:message.id});
      await settle(false);if(lastRejected?.seq>before)throw Error(lastRejected.message);
      if(result.structuredContent){
        const context={...result.structuredContent,documentId,document:{...active},generation};
        result=message.call.name==='get_context'?{...result,...toolResponse(context)}:{...result,structuredContent:context};
      }
      controller.signal.throwIfAborted();api.toolResult(message.id,result);
    }catch(e){api.toolResult(message.id,{isError:true,content:[{type:'text',text:e.message}],structuredContent:{ok:false,revision:null,error:{code:/busy|opening/i.test(e.message)?'busy':/identity mismatch/i.test(e.message)?'document_mismatch':/invalid|exceeds|too large/i.test(e.message)?'bad_args':controller.signal.aborted?'cancelled':'failed',message:controller.signal.aborted?'MCP request cancelled; persisted changes are not rolled back. Read this document before retrying.':e.message},documentId,document:{...active},generation,durableSequence:projection?.ack??0}});}finally{toolRequests.delete(message.id);}})();
    toolTasks.set(message.id,task);void task.finally(()=>toolTasks.delete(message.id));
  }else if(message.type==='preferences'){prefs=message.preferences;
  }else if(message.type==='metadata'){
    if(message.document?.id===documentId&&active){active.title=message.document.title;setTitle();}
  }else if(message.type==='runtime-request'){
    void runtimeRequest(message);
  }else if(message.type==='command'){
    void run(()=>command(message.name))();
  }else if(message.type==='close-cancelled'){
    closing=false;$('#editor').inert=false;
  }
});
async function command(name){
  if(name==='rename')editTitle();
  else if(name==='export')exportDialog();
  else if(name==='save'){await saveTitleEdit();await settle();}
  else if(name==='undo'||name==='redo'){nativeHistory(name==='redo');await settle();}
  else throw Error('Unknown document command: '+name);
}
async function runtimeRequest(message){
  try{
    assertIdentity(message);
    if(!ready||mounting)throw Error('Canvas is busy opening');
    let result={};
    if(message.name==='inspect')result={busy:!!(closing||titleEdit||handle.editor.undo.blocked||handle.editor.activeSession||handle.editingText())};
    else if(message.name==='prepare-delete'){
      if(closing||titleEdit||handle.editor.undo.blocked||handle.editor.activeSession||handle.editingText()||toolTasks.size)throw Error('Canvas is busy editing');
      closing=true;$('#editor').inert=true;await settle();
    }else if(message.name==='cancel-delete'){closing=false;$('#editor').inert=false;}
    else if(message.name==='export-data'){
      const args=message.args??{},controller=new AbortController();toolRequests.set(message.id,controller);
      const task=mcp.exportData(args.agent,args,{signal:controller.signal});toolTasks.set(message.id,task);
      try{
        const {bytes,mime}=await task;let binary='';for(let index=0;index<bytes.length;index+=32768)binary+=String.fromCharCode(...bytes.subarray(index,index+32768));
        result={data:btoa(binary),mimeType:mime};
      }finally{toolRequests.delete(message.id);toolTasks.delete(message.id);}
    }else if(message.name==='command')await command(message.args?.name);
    else if(message.name==='flush'||message.name==='close'){
      if(message.name==='close'){closing=true;$('#editor').inert=true;for(const controller of toolRequests.values())controller.abort();}
      await Promise.all([...toolTasks.values()]);if(message.args?.guardBusy&&(titleEdit||handle.editor.undo.blocked||handle.editor.activeSession||handle.editingText()))throw Error('Canvas is busy editing');await saveTitleEdit();await settle();
    }else throw Error('Unknown runtime request: '+message.name);
    api.toolResult(message.id,{ok:true,...result,documentId,generation});
  }catch(error){
    if(message.name==='close'){closing=false;$('#editor').inert=false;}
    api.toolResult(message.id,{ok:false,error:{code:/busy|opening/i.test(error.message)?'busy':'failed',message:error.message},documentId,generation});
  }
}
$('#toggle-layers').onclick=()=>{$('#editor').classList.toggle('collapsed');$('#toggle-layers').setAttribute('aria-expanded',String(!$('#editor').classList.contains('collapsed')));};
$('#components').onclick=()=>{$('#editor').classList.remove('collapsed');$('#toggle-layers').setAttribute('aria-expanded','true');[...document.querySelectorAll('#editor .ltabs button')].find(b=>b.textContent==='Assets')?.click();};
$('#home').onclick=run(async()=>{await saveTitleEdit();await settle();await api.invoke('show-library');});$('#document-title').onclick=editTitle;$('#export').onclick=exportDialog;$('#mcp').onclick=run(mcpDialog);$('#collaborate').onclick=run(collaborationDialog);
$('#title-form').noValidate=true;
$('#title-form').onsubmit=run(async event=>{event.preventDefault();if(!titleEdit?.composing&&!titleEdit?.composingKey)await saveTitleEdit();});
$('#title-input').onblur=()=>{void run(saveTitleEdit)();};
$('#title-input').oncompositionstart=()=>{if(titleEdit)titleEdit.composing=true;};
$('#title-input').oncompositionend=()=>{if(titleEdit)titleEdit.composing=false;};
$('#title-input').onkeydown=event=>{const composing=event.isComposing||titleEdit?.composing||event.keyCode===229;if(titleEdit)titleEdit.composingKey=composing;if(composing)return;if(event.key==='Escape'){event.preventDefault();event.stopPropagation();cancelTitleEdit();}};
$('#title-input').onkeyup=()=>{if(titleEdit)titleEdit.composingKey=false;};
for(const el of document.querySelectorAll('[data-icon]'))el.innerHTML=icon(el.dataset.icon);
try{
  prefs=await startupStep('startup.preferences',()=>api.invoke('preferences'));
  await openSnapshot(await startupStep('startup.snapshot',()=>api.invoke('snapshot')));
  // The host only dispatches document calls after this mount and bootstrap have completed.
  ready=true;assertIdentity(await startupStep('startup.ready',()=>api.invoke('runtime-ready')));startupComplete=true;thumbnails.schedule();
}catch(error){
  startupTiming('startup.failure',performance.now()-startupAt);startupComplete=true;
  ready=false;toast('Could not open canvas: '+error.message,true);
  await api.invoke('runtime-ready',{ok:false,error:{message:error.message}}).catch(()=>{});
}
