import './style.css';
import {icon} from './icons.js';
import {mountEditor,importCanvasJson,exportCanvasJson,installLvMcp,screenToWorld,worldToScreen} from '../editor';
import {changesBetween,applyPending,same,assertDocument} from '../core/document.mjs';
import {sampleCanvas,blankCanvas} from './sample';
import fontFaces from './fonts.json';
import {removeBackground} from '../editor/images/background';
import {WORKSPACE_TOOLS,validateToolArgs} from '../editor/mcp/defs';
import {createWorkspaceReplay} from './workspace-mcp';

const $=s=>document.querySelector(s), api=window.omc;
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let handle,mcp,active,lastDoc,pending=[],nextSeq=0,queue=Promise.resolve(),mounting=false,unsubscribe;
let session={mode:'offline',peers:[]},prefs={},toastTimer,thumbnailTimer,libraryVisible=true,dialogFocus,hosting,sessionTab='host';
let lastRejected,navigating=false,closing=false;
const workspaceNames=new Set(WORKSPACE_TOOLS.map(tool=>tool.name)),workspaceReplay=createWorkspaceReplay();
async function navigate(task){
  if(navigating)throw Error('Wait for the current canvas navigation to finish');
  navigating=true;const wasInert=$('#editor').inert;$('#editor').inert=true;
  try{return await task();}finally{navigating=false;$('#editor').inert=wasInert;}
}
let libraryDocs=[],section='recent';
const cursors=new Map(),colors=['#1d4ed8','#0369a1','#6d28d9','#475569'];

function toast(message,error=false){clearTimeout(toastTimer);$('#toast').textContent=message;$('#toast').classList.toggle('error-toast',error);$('#toast').hidden=false;toastTimer=setTimeout(()=>{$('#toast').hidden=true;},error?8000:3500);}
const run=fn=>async(...args)=>{try{return await fn(...args);}catch(e){toast(e.message,true);return undefined;}};
function modal(title,body){dialogFocus=document.activeElement;const d=$('#dialog');if(d.open)d.close();$('#dialog-content').innerHTML=`<div class="dialog-heading"><h2>${esc(title)}</h2><button class="close" aria-label="Close dialog">${icon('close')}</button></div>${body}`;$('.close').onclick=()=>d.close();d.showModal();}
$('#dialog').addEventListener('close',()=>dialogFocus?.focus?.());
$('#dialog').addEventListener('click',e=>{if(e.target===$('#dialog')){const b=e.target.getBoundingClientRect();if(e.clientX<b.left||e.clientX>b.right||e.clientY<b.top||e.clientY>b.bottom)e.target.close();}});
function setTitle(){ const file=$('#editor .file-name b');if(file&&active)file.textContent=active.title;($('#document-name')||$('#document-title')).textContent=libraryVisible?'Your canvases':active?.title||'Untitled canvas';$('#document-title').disabled=libraryVisible;$('#document-title').setAttribute('aria-label',libraryVisible?'Your canvases':'Rename canvas: '+active?.title);if($('#rename-canvas'))$('#rename-canvas').hidden=libraryVisible;$('#export').hidden=libraryVisible;$('#components').hidden=libraryVisible;$('#toggle-layers').hidden=libraryVisible;$('#save-state').textContent=libraryVisible?'Local workspace':'Stored on this computer'; }
async function settle(flushEditor=true){if(mounting&&flushEditor)throw Error('Wait for the canvas to finish opening');if(flushEditor)await handle?.flush?.();await queue;for(const item of [...pending])project(await api.invoke('commit',{id:active.id,...item}));await api.invoke('flush');}
function history(action,agent,signal,requestId){const task=queue.then(()=>{signal?.throwIfAborted();return api.invoke(action,{agent,requestId});}).then(snap=>{if(snap)project(snap);return !!snap;});queue=task.catch(()=>{});return task;}
function project(snap){
  if(!handle||snap.id!==active?.id||mounting)return;
  pending=pending.filter(p=>p.seq>snap.ack);
  const doc=applyPending(snap.document,pending.map(p=>p.changes));
  // The durable baseline excludes an active local preview retained by receiveDocument.
  lastDoc=doc;
  if(same(doc,handle.editor.doc))return;
  handle.editor.receiveDocument(doc);
  paintCursors();
}
async function openSnapshot(snap){
  mounting=true;$('#editor').inert=true;
  try {mcp?.dispose?.();unsubscribe?.();await handle?.destroy();handle=null;clearTimeout(thumbnailTimer);cursors.clear();$('#remote-cursors').replaceChildren();
  pending=[];nextSeq=0;lastRejected=null;active={id:snap.id,title:snap.title};libraryVisible=false;$('#library').hidden=true;$('#workspace').hidden=false;setTitle();
  let candidate=snap;
  for(let attempt=0;attempt<8;attempt++){
    handle=await mountEditor($('#editor'),{
      removeBackground,
      pickFiles:async options=>{const files=await api.invoke('pick-files',options);const mime={svg:'image/svg+xml',png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',gif:'image/gif',webp:'image/webp',avif:'image/avif',bmp:'image/bmp',ico:'image/x-icon',json:'application/json',woff:'font/woff',woff2:'font/woff2',ttf:'font/ttf',otf:'font/otf'};return files.map(file=>new File([file.bytes],file.name,{type:mime[file.name.split('.').pop().toLowerCase()]||'application/octet-stream'}));},
      exportFile:async(blob,name)=>api.invoke('export-file',{name,mime:blob.type,bytes:new Uint8Array(await blob.arrayBuffer())}),
      document:candidate.document,title:candidate.title,subtitle:'Oh My Canvas',faces:fontFaces.map(face=>({...face,url:new URL(face.url,location.href).href})),defaultFamily:'IBM Plex Sans',fallbacks:['Noto Sans KR','sans-serif'],wasmUrl:new URL('/canvaskit.wasm',location.href).href,
    });
    const initialization=changesBetween(candidate.document,handle.editor.doc);
    if(candidate.bootstrapNonce){
      const initialized=await api.invoke('bootstrap',{id:snap.id,nonce:candidate.bootstrapNonce,changes:initialization});
      if(initialized.bootstrapRetry){await handle.destroy();handle=null;candidate=initialized;continue;}
      handle.editor.receiveDocument(initialized.document);
    }else if(initialization.length){throw Error('Canvas initialization token is missing');}
    break;
  }
  if(!handle)throw Error('Canvas changed repeatedly while opening. Please retry.');
  lastDoc=handle.editor.doc;
  handle.editor.undoStep=()=>{if(handle.editor.undo.blocked)return false;void run(()=>history('undo'))();return true;};
  handle.editor.redoStep=()=>{if(handle.editor.undo.blocked)return false;void run(()=>history('redo'))();return true;};
  mcp=installLvMcp(handle.editor,handle.view,{services:handle.services,afterWrite:()=>settle(false),fonts:()=>handle.fonts.catalog(),editing:()=>navigating?'navigation':handle.editingText(),onHighlight:handle.highlightAgent,undo:(agent,signal,requestId)=>history('undo',agent,signal,requestId)});
  unsubscribe=handle.editor.on(event=>{
    if(event.projection)return;
    if(event.changes){
      const changes=changesBetween(lastDoc,handle.editor.doc);lastDoc=handle.editor.doc;
      if(changes.length){
        const id=active.id,seq=++nextSeq,label=event.operation?.label,group=event.operation?.id;pending.push({seq,changes,label,group});
        queue=queue.then(async()=>{
          try{const snap=await api.invoke('commit',{id,seq,changes,label,group});if(active?.id===id)project(snap);}
          catch(e){
            toast('Could not persist edit: '+e.message,true);
            if(/exceeds?|Invalid|16 MiB|24 MiB|too large/i.test(e.message)){
              lastRejected={seq,message:e.message};
              pending=pending.filter(p=>p.seq!==seq);project(await api.invoke('snapshot'));
            }
            throw e;
          }
        }).catch(()=>{});
        clearTimeout(thumbnailTimer);thumbnailTimer=setTimeout(()=>void updateThumbnail(),1200);
      }
    }
    if(event.viewport||event.page)paintCursors();
    if(event.selection)sendCursor();
  });
  $('#editor button[aria-label="Collapse sidebar"]')?.remove();
  $('#editor button[aria-label="Comment (not available)"]')?.remove();
  $('#toggle-layers').setAttribute('aria-expanded','true');
  const latest=await api.invoke('snapshot');
  lastDoc=latest.document;handle.editor.receiveDocument(latest.document);
  setTitle();
  void updateThumbnail();if(snap.recovered)toast('Recovered the last valid backup. Save a portable copy.',true);
  }catch(error){mcp?.dispose?.();unsubscribe?.();await handle?.destroy().catch(()=>{});handle=null;libraryVisible=true;$('#workspace').hidden=true;$('#library').hidden=false;setTitle();try{libraryDocs=await api.invoke('library');renderLibrary();}catch(refreshError){toast('Could not refresh the library: '+refreshError.message,true);}throw error;}finally{mounting=false;$('#editor').inert=false;}
}
async function updateThumbnail(){
  if(!handle||!active)return;const id=active.id;
  try{const shot=await handle.view.screenshot(undefined,{mode:'overview'});if(active?.id===id&&shot?.data)await api.invoke('thumbnail',{src:`data:${shot.mimeType};base64,${shot.data}`});}catch{}
}
async function newCanvas(sample=false){return navigate(async()=>{await settle();const doc=importCanvasJson(sample?sampleCanvas():blankCanvas());await openSnapshot(await api.invoke('create',{title:sample?'Studio 01':'Untitled canvas',document:doc}));});}
async function library(){
  if(navigating)throw Error('Wait for the current canvas navigation to finish');
  await settle();libraryVisible=true;$('#workspace').hidden=true;$('#library').hidden=false;setTitle();
  const docs=await api.invoke('library');
  libraryDocs=docs;renderLibrary();
}
function renderLibrary(){
  const search=$('#search').value.trim().toLowerCase();
  const docs=libraryDocs.filter(d=>(section!=='starred'||(prefs.starred||[]).includes(d.id))&&d.title.toLowerCase().includes(search)).sort((a,b)=>$('#sort').value==='title'?a.title.localeCompare(b.title):new Date(b.updatedAt)-new Date(a.updatedAt));
  $('#section-title').textContent=section==='starred'?'Starred':section==='all'?'All canvases':'Recents';
  $('#document-count').textContent=`${docs.length} canvas${docs.length===1?'':'es'}`;
  $('#documents').classList.toggle('list-view',prefs.view==='list');
  if(!docs.length){$('#documents').innerHTML=libraryDocs.length?`<div class="empty-library"><h2>${search?'No matching canvases':'Your favorites, gathered here.'}</h2><p>${search?'Try another name.':'Star a canvas to keep it close.'}</p></div>`:`<div class="empty-library"><div class="empty-symbol" aria-hidden="true">${icon('plus')}</div><h2>Your first idea starts here.</h2><p>Create a canvas, or explore a working sample.</p><div class="actions"><button id="start-blank" class="primary">Create a canvas</button><button id="start-sample">Explore a sample</button></div></div>`;if($('#start-blank'))$('#start-blank').onclick=run(()=>newCanvas());if($('#start-sample'))$('#start-sample').onclick=run(()=>newCanvas(true));return;}
  $('#documents').innerHTML=docs.map(d=>`<article class="document-card"><button class="preview" data-open="${d.id}" aria-label="Open ${esc(d.title)}">${d.thumbnail?`<img src="${esc(d.thumbnail)}" alt="Canvas preview">`:`<span class="empty-preview">${d.damaged?'!':icon('plus')}</span>`}</button><div class="card-meta"><span class="file-icon" aria-hidden="true">${icon('file')}</span><div><h3>${esc(d.title)}</h3><p>${d.damaged?'Could not read file':d.recovered?'Backup available':'Edited '+new Date(d.updatedAt).toLocaleString(undefined,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'})}</p></div><button class="star" data-star="${d.id}" aria-label="Star ${esc(d.title)}" aria-pressed="${(prefs.starred||[]).includes(d.id)}">${icon('star')}</button><button class="more" data-more="${d.id}" aria-label="Actions for ${esc(d.title)}">${icon('more')}</button></div></article>`).join('');
  for(const b of document.querySelectorAll('[data-star]'))b.onclick=run(async()=>{prefs=await api.invoke('preferences',{toggleStar:b.dataset.star});renderLibrary();});
  for(const b of document.querySelectorAll('[data-open]'))b.onclick=run(()=>navigate(async()=>{await settle();await openSnapshot(await api.invoke('open',{id:b.dataset.open}));}));
  for(const b of document.querySelectorAll('[data-more]'))b.onclick=()=>{
    const d=docs.find(x=>x.id===b.dataset.more);
    modal(d.title,`<div class="export-options"><button id="rename-doc" ${d.damaged?'disabled':''}>Rename canvas</button><button id="duplicate-doc" ${d.damaged?'disabled':''}>Duplicate canvas</button><button id="delete-doc" class="danger">Delete from this computer…</button></div>`);
    $('#rename-doc').onclick=()=>rename(d);
    $('#duplicate-doc').onclick=run(()=>navigate(async()=>{await settle();$('#dialog').close();await openSnapshot(await api.invoke('duplicate',{id:d.id}));}));
    $('#delete-doc').onclick=()=>{modal('Delete canvas?',`<p>Delete “${esc(d.title)}” and its local backup from this computer? Copies on other computers are kept.</p><div class="actions right"><button id="cancel-delete">Cancel</button><button id="confirm-delete" class="danger">Delete canvas</button></div>`);$('#cancel-delete').onclick=()=>$('#dialog').close();$('#confirm-delete').onclick=run(async()=>{await settle();await api.invoke('delete',{id:d.id});if(active?.id===d.id){mcp?.dispose?.();unsubscribe?.();await handle?.destroy();handle=null;active=null;}$('#dialog').close();await library();});};
  };
}
async function importFile(){return navigate(async()=>{
  await settle();const f=await api.invoke('import');if(!f)return;
  if(f.opened){await openSnapshot(f.opened);return;}
  const doc=f.json.pagesById?assertDocument(f.json):importCanvasJson(f.json);
  await openSnapshot(await api.invoke('create',{document:doc,title:f.title}));
});}
async function applyRename(id,title){const result=await api.invoke('rename',{id,title});if(active?.id===id){active.title=result.title;setTitle();}if(libraryVisible){libraryDocs=await api.invoke('library');renderLibrary();}return result;}
function rename(target){const doc=target?.id?target:(!libraryVisible?active:null);if(!doc)return;modal('Rename canvas',`<form id="rename-form"><label for="name">Canvas name</label><input id="name" value="${esc(doc.title)}" maxlength="120" required><div class="actions right"><button type="button" id="cancel-rename">Cancel</button><button class="primary">Rename</button></div></form>`);$('#name').select();$('#cancel-rename').onclick=()=>$('#dialog').close();$('#rename-form').onsubmit=run(async e=>{e.preventDefault();await applyRename(doc.id,$('#name').value);$('#dialog').close();});}
function exportDialog(){
  if(!handle)return;
  modal('Export canvas',`<p>A portable .omc file includes the full editable document, embedded images and merge history.</p><div class="export-options"><button data-format="omc">Oh My Canvas <small>Editable .omc document, for backup and sharing</small></button><button data-format="json">Canvas JSON <small>Open interchange format</small></button><button data-format="svg">SVG <small>Vector export of the selected board</small></button><button data-format="png">PNG <small>Raster preview of the selected board</small></button></div>`);
  for(const b of document.querySelectorAll('[data-format]'))b.onclick=run(async()=>{
    await settle();const format=b.dataset.format;let content;
    if(format==='json')content=JSON.stringify(exportCanvasJson(handle.editor.doc),null,2);
    else if(format==='svg'){
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
const toolRequests=new Map();
const toolResponse=value=>({content:[{type:'text',text:JSON.stringify(value)}],structuredContent:value});
async function workspaceTool(call,id,signal){
  const invalid=validateToolArgs(call.name,call.args);if(invalid)throw Error('Invalid tool arguments: '+invalid);
  signal.throwIfAborted();
  if(call.name==='list_documents'){
    const query=(call.args.query??'').toLocaleLowerCase(),offset=call.args.offset??0,limit=call.args.limit??50;
    const docs=(await api.invoke('library')).filter(doc=>doc.title.toLocaleLowerCase().includes(query));signal.throwIfAborted();
    return toolResponse({ok:true,documents:docs.slice(offset,offset+limit).map(({thumbnail,...doc})=>doc),total:docs.length,nextOffset:offset+limit<docs.length?offset+limit:null,activeDocument:active?{...active}:null,view:libraryVisible?'library':'editor'});
  }
  return workspaceReplay.run(call.agent,call.context?.idempotencyKey,call.name,call.args,async()=>{
    signal.throwIfAborted();
    if(mounting||navigating||$('#dialog').open||handle?.editingText()||handle?.editor.undo.blocked)throw Error('Canvas is busy; finish the current edit or dialog first');
    if(call.name==='rename_document'){
      await settle();signal.throwIfAborted();const document=await applyRename(call.args.id,call.args.title);signal.throwIfAborted();return toolResponse({ok:true,document});
    }
    return navigate(async()=>{
      await settle();signal.throwIfAborted();
      const request={...call.args,mcpRequestId:id};
      if(call.name==='open_document'&&active?.id===call.args.id&&handle){libraryVisible=false;$('#library').hidden=true;$('#workspace').hidden=false;setTitle();}
      else {
        if(call.name==='create_document'){request.document=importCanvasJson(blankCanvas());request.title=call.args.title??'Untitled canvas';}
        const action={open_document:'open',create_document:'create',duplicate_document:'duplicate'}[call.name];
        const snap=await api.invoke(action,request);signal.throwIfAborted();await openSnapshot(snap);
      }
      signal.throwIfAborted();const result=await mcp.handleToolCall(call.agent,'get_context',{}, {signal});
      if(result.isError)throw Error('Canvas opened but context is unavailable; inspect the library before retrying');
      const document={...active},context={...result.structuredContent,document};
      return toolResponse({ok:true,revision:context.revision,document,context});
    });
  });
}
async function mcpDialog(){
  const info=await api.invoke('mcp-info');
  if(!info.available){toast('MCP unavailable: '+info.error,true);return;}
  modal('Connect your agent',`<p>Use a local MCP client to find, open, create and edit canvases. No account, API key or credits are needed.</p><label for="mcp-config">MCP client configuration</label><textarea id="mcp-config" readonly rows="9">${esc(info.config)}</textarea><p class="hint">The HTTPS server talks only on loopback. Trust this profile's public certificate in your client before connecting; never disable TLS verification. Supply OMC_MCP_TOKEN from the private mcp-token-v2 file in your app data directory to your client environment, then restart the client. The configuration contains no secret. Public certificate: ${esc(info.certificatePath)}. Keep this app open. Start with list_documents, then open_document or create_document and read get_context before editing. Agent navigation keeps its initiating connection; other clients reconnect. Do not automatically retry writes.</p><div class="actions right"><button id="copy-mcp" class="primary">Copy configuration</button></div>`);
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
    if(!active||libraryVisible){$('#session-panel').innerHTML='<p>Open a canvas before hosting a session.</p>';return;}
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
    $('#join-session').onclick=run(()=>navigate(async()=>{await settle();prefs=await api.invoke('preferences',{name:$('#peer-name').value});const b=$('#join-session');b.disabled=true;b.textContent='Connecting…';try{const snap=await api.invoke('join',{invite:$('#join-invite').value.trim()});await openSnapshot(snap);$('#dialog').close();toast('Joined the canvas');}finally{if(b.isConnected){b.disabled=false;b.textContent='Join canvas';}}}));
  }
}
function paintCursors(){
  if(!handle||libraryVisible)return;
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
  if(!handle||session.mode==='offline'||libraryVisible||Date.now()-lastCursor<60)return;
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
  if(message.type==='document')project(message);
  else if(message.type==='saved'){if(message.id===active?.id&&!libraryVisible)$('#save-state').textContent='Stored on this computer';}
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
    workspaceReplay.end(message.agent);
  }else if(message.type==='tool'){
    const controller=new AbortController();toolRequests.set(message.id,controller);
    void (async()=>{try{
      if(closing)throw Error('Editor is closing');
      let result;
      if(workspaceNames.has(message.call.name))result=await workspaceTool(message.call,message.id,controller.signal);
      else {
        if(mounting||navigating)throw Error('Canvas is busy opening');if(!mcp||libraryVisible)throw Error('Use list_documents, then open_document or create_document first');
        if(message.call.documentId!==active?.id)throw Error('Document changed; read get_context before retrying');
        const before=nextSeq;
        result=await mcp.handleToolCall(message.call.agent,message.call.name,message.call.args,{...message.call.context,signal:controller.signal,requestId:message.id});
        await settle(false);if(lastRejected?.seq>before)throw Error(lastRejected.message);
        if(message.call.name==='get_context'&&!result.isError)result=toolResponse({...result.structuredContent,document:{...active}});
      }
      controller.signal.throwIfAborted();api.toolResult(message.id,result);
    }catch(e){api.toolResult(message.id,{isError:true,content:[{type:'text',text:e.message}],structuredContent:{ok:false,revision:null,error:{code:/busy|opening/i.test(e.message)?'busy':/invalid|exceeds|too large/i.test(e.message)?'bad_args':controller.signal.aborted?'cancelled':'failed',message:controller.signal.aborted?'MCP request cancelled; persisted changes are not rolled back. Inspect the library before retrying.':e.message},documentId:active?.id??null,durableSequence:nextSeq}});}finally{toolRequests.delete(message.id);}})();
  }else if(message.type==='command'){
    const actions={new:()=>newCanvas(),import:importFile,library,rename:()=>rename(),undo:()=>nativeHistory(false),redo:()=>nativeHistory(true)};void run(actions[message.name]||(()=>{}))();
  }else if(message.type==='close-cancelled'){
    closing=false;
  }else if(message.type==='closing'){
    closing=true;
    for(const controller of toolRequests.values())controller.abort();
    void run(async()=>{try{await settle();await api.readyToClose();}catch(error){await api.invoke('cancel-close');throw error;}})();
  }
});
$('#toggle-layers').onclick=()=>{$('#editor').classList.toggle('collapsed');$('#toggle-layers').setAttribute('aria-expanded',String(!$('#editor').classList.contains('collapsed')));};
$('#components').onclick=()=>{$('#editor').classList.remove('collapsed');$('#toggle-layers').setAttribute('aria-expanded','true');[...document.querySelectorAll('#editor .ltabs button')].find(b=>b.textContent==='Assets')?.click();};
$('#home').onclick=run(library);$('#document-title').onclick=rename;$('#new').onclick=run(()=>newCanvas());$('#import').onclick=run(importFile);$('#export').onclick=exportDialog;$('#mcp').onclick=run(mcpDialog);$('#collaborate').onclick=run(collaborationDialog);
if($('#rename-canvas'))$('#rename-canvas').onclick=()=>rename();
for(const el of document.querySelectorAll('[data-icon]'))el.innerHTML=icon(el.dataset.icon);
prefs=await api.invoke('preferences');
$('#search').oninput=renderLibrary;$('#sort').onchange=renderLibrary;
for(const b of document.querySelectorAll('[data-section]'))b.onclick=()=>{section=b.dataset.section;for(const n of document.querySelectorAll('[data-section]')){if(n===b)n.setAttribute('aria-current','page');else n.removeAttribute('aria-current');}renderLibrary();};
function setView(){for(const value of ['grid','list'])$('#view-'+value).setAttribute('aria-pressed',String((prefs.view||'grid')===value));}
for(const value of ['grid','list'])$('#view-'+value).onclick=run(async()=>{prefs=await api.invoke('preferences',{view:value});setView();renderLibrary();});
setView();await library();
