import './style.css';
import {icon} from './icons.js';
import {importCanvasJson} from '../editor/formats/canvas';
import {sampleCanvas,blankCanvas} from './sample';

const $=selector=>document.querySelector(selector),api=window.omc;
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let prefs={},documents=[],section='recent',workspace={tabs:[],activeTabId:null},toastTimer,dialogFocus,libraryLoad,libraryDirty=false;
function toast(message,error=false){clearTimeout(toastTimer);$('#toast').textContent=message;$('#toast').classList.toggle('error-toast',error);$('#toast').hidden=false;toastTimer=setTimeout(()=>{$('#toast').hidden=true;},error?8000:3500);}
const run=fn=>async(...args)=>{try{return await fn(...args);}catch(error){toast(error.message,true);}};
function modal(title,body){dialogFocus=document.activeElement;if($('#dialog').open)$('#dialog').close();$('#dialog-content').innerHTML=`<div class="dialog-heading"><h2>${esc(title)}</h2><button class="close" aria-label="Close dialog">${icon('close')}</button></div>${body}`;$('.close').onclick=()=>$('#dialog').close();$('#dialog').showModal();}
$('#dialog').addEventListener('close',()=>dialogFocus?.focus?.());
$('#dialog').addEventListener('click',event=>{if(event.target!==$('#dialog'))return;const b=event.target.getBoundingClientRect();if(event.clientX<b.left||event.clientX>b.right||event.clientY<b.top||event.clientY>b.bottom)event.target.close();});

async function refreshLibrary(){
  libraryDirty=true;if(libraryLoad)return libraryLoad;
  libraryLoad=(async()=>{do{libraryDirty=false;documents=await api.invoke('library');renderLibrary();}while(libraryDirty);})().finally(()=>{libraryLoad=null;});
  return libraryLoad;
}
function renderWorkspace(state){
  workspace=state;
  const library=workspace.activeTabId==null;
  $('#topbar').hidden=!library;$('#library').hidden=!library;
  renderTabs();if(library)void run(refreshLibrary)();
}
function renderTabs(){
  const focused=document.activeElement,tabFocus=focused?.dataset.tab,closeFocus=focused?.dataset.closeTab;
  const selected=workspace.activeTabId??'library';
  $('#document-tabs').innerHTML=`<button class="document-tab library-tab" role="tab" id="tab-library" data-tab="library" aria-selected="${selected==='library'}" tabindex="${selected==='library'?0:-1}">${icon('grid')}<span>Your canvases</span></button>`+(workspace.tabs??[]).map(tab=>`<div class="tab-item" role="presentation"><button class="document-tab" role="tab" id="tab-${tab.id}" data-tab="${tab.id}" aria-selected="${selected===tab.id}" tabindex="${selected===tab.id?0:-1}" title="${esc(tab.title)}"><span>${esc(tab.title)}</span>${tab.inUse?'<small title="In use by an agent or collaborator">Active</small>':''}</button><button class="close-tab" data-close-tab="${tab.id}" aria-label="Close ${esc(tab.title)} tab">${icon('close')}</button></div>`).join('');
  for(const button of document.querySelectorAll('[data-tab]'))button.onclick=run(()=>selectTab(button.dataset.tab));
  for(const button of document.querySelectorAll('[data-close-tab]'))button.onclick=run(async()=>{await api.invoke('close-document',{id:button.dataset.closeTab});});
  if(tabFocus||closeFocus){
    const same=[...document.querySelectorAll(tabFocus?'[data-tab]':'[data-close-tab]')].find(button=>(button.dataset.tab??button.dataset.closeTab)===(tabFocus??closeFocus));
    (same??document.getElementById('tab-'+selected))?.focus({preventScroll:true});
  }
}
async function selectTab(id){if(id==='library')await api.invoke('show-library');else await api.invoke('activate-document',{id});}
$('#document-tabs').onkeydown=event=>{
  if(!event.target.matches('[data-tab]')||!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
  event.preventDefault();const tabs=[...document.querySelectorAll('[data-tab]')],index=tabs.indexOf(event.target);
  const next=event.key==='Home'?0:event.key==='End'?tabs.length-1:(index+(event.key==='ArrowRight'?1:-1)+tabs.length)%tabs.length;
  const id=tabs[next].dataset.tab;void run(async()=>{await selectTab(id);document.querySelector(`[data-tab="${id}"]`)?.focus();})();
};
async function newCanvas(sample=false){await api.invoke('create',{title:sample?'Studio 01':'Untitled canvas',document:importCanvasJson(sample?sampleCanvas():blankCanvas()),focus:true});}
async function importFile(){const file=await api.invoke('import');if(!file||file.opened)return;if(file.json)await api.invoke('create',{title:file.title,document:file.json.pagesById?file.json:importCanvasJson(file.json),focus:true});}
function renderLibrary(){
  const query=$('#search').value.trim().toLocaleLowerCase();
  const docs=documents.filter(doc=>(section!=='starred'||(prefs.starred??[]).includes(doc.id))&&doc.title.toLocaleLowerCase().includes(query)).sort((a,b)=>$('#sort').value==='title'?a.title.localeCompare(b.title):(b.updatedAt??'').localeCompare(a.updatedAt??''));
  $('#section-title').textContent=section==='starred'?'Starred':section==='all'?'All canvases':'Recents';$('#document-count').textContent=`${docs.length} canvas${docs.length===1?'':'es'}`;
  $('#documents').classList.toggle('list-view',prefs.view==='list');
  if(!docs.length){$('#documents').innerHTML=documents.length?`<div class="empty-library"><h2>${query?'No matching canvases':'Your favorites, gathered here.'}</h2><p>${query?'Try another name.':'Star a canvas to keep it close.'}</p></div>`:`<div class="empty-library"><div class="empty-symbol" aria-hidden="true">${icon('plus')}</div><h2>Your first idea starts here.</h2><p>Create a canvas, or explore a working sample.</p><div class="actions"><button id="start-blank" class="primary">Create a canvas</button><button id="start-sample">Explore a sample</button></div></div>`;if($('#start-blank'))$('#start-blank').onclick=run(()=>newCanvas());if($('#start-sample'))$('#start-sample').onclick=run(()=>newCanvas(true));return;}
  $('#documents').innerHTML=docs.map(doc=>`<article class="document-card"><button class="preview" data-open="${doc.id}" aria-label="Open ${esc(doc.title)}">${doc.thumbnail?`<img src="${esc(doc.thumbnail)}" alt="Canvas preview">`:`<span class="empty-preview">${doc.damaged?'!':icon('plus')}</span>`}</button><div class="card-meta"><span class="file-icon" aria-hidden="true">${icon('file')}</span><div><h3>${esc(doc.title)}</h3><p>${doc.damaged?'Could not read file':doc.inUse?'Open · Agent or collaborator active':doc.recovered?'Backup available':'Edited '+new Date(doc.updatedAt).toLocaleString(undefined,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'})}</p></div><button class="star" data-star="${doc.id}" aria-label="Star ${esc(doc.title)}" aria-pressed="${(prefs.starred??[]).includes(doc.id)}">${icon('star')}</button><button class="more" data-more="${doc.id}" aria-label="Actions for ${esc(doc.title)}">${icon('more')}</button></div></article>`).join('');
  for(const button of document.querySelectorAll('[data-open]'))button.onclick=run(()=>api.invoke('open',{id:button.dataset.open,focus:true}));
  for(const button of document.querySelectorAll('[data-star]'))button.onclick=run(async()=>{prefs=await api.invoke('preferences',{toggleStar:button.dataset.star});renderLibrary();});
  for(const button of document.querySelectorAll('[data-more]'))button.onclick=()=>documentActions(docs.find(doc=>doc.id===button.dataset.more));
}
function documentActions(doc){
  modal(doc.title,`<div class="export-options"><button id="rename-doc" ${doc.damaged?'disabled':''}>Rename canvas</button><button id="duplicate-doc" ${doc.damaged?'disabled':''}>Duplicate canvas</button><button id="delete-doc" class="danger">Delete from this computer…</button></div>`);
  $('#rename-doc').onclick=()=>renameDocument(doc);
  $('#duplicate-doc').onclick=run(async()=>{await api.invoke('duplicate',{id:doc.id,focus:true});$('#dialog').close();});
  $('#delete-doc').onclick=()=>{modal('Delete canvas?',`<p>Delete “${esc(doc.title)}” and its local backup from this computer? Copies on other computers are kept.</p><div class="actions right"><button id="cancel-delete">Cancel</button><button id="confirm-delete" class="danger">Delete canvas</button></div>`);$('#cancel-delete').onclick=()=>$('#dialog').close();$('#confirm-delete').onclick=run(async()=>{await api.invoke('delete',{id:doc.id});$('#dialog').close();await refreshLibrary();});};
}
function renameDocument(doc){
  modal('Rename canvas',`<form id="rename-form"><label for="name">Canvas name</label><input id="name" value="${esc(doc.title)}" maxlength="120" required><div class="actions right"><button type="button" id="cancel-rename">Cancel</button><button class="primary">Rename</button></div></form>`);$('#name').select();$('#cancel-rename').onclick=()=>$('#dialog').close();
  $('#rename-form').onsubmit=run(async event=>{event.preventDefault();await api.invoke('rename',{id:doc.id,title:$('#name').value});$('#dialog').close();await refreshLibrary();});
}
async function mcpDialog(){
  const info=await api.invoke('mcp-info');if(!info.available){toast('MCP unavailable: '+info.error,true);return;}
  modal('Connect your agent',`<p>Agents keep their own canvas target while you switch tabs. Every edit names its document ID.</p><label for="mcp-config">MCP configuration</label><textarea id="mcp-config" rows="8" readonly spellcheck="false">${esc(info.config)}</textarea><p class="hint">Keep the app running. Trust this profile’s TLS certificate and supply OMC_MCP_TOKEN privately. Never forward the MCP port.</p><div class="actions right"><button id="copy-mcp" class="primary">Copy configuration</button></div>`);
  $('#copy-mcp').onclick=run(async()=>{await api.invoke('mcp-info',{copy:true});toast('Configuration copied');});
}
function joinDialog(){modal('Join a canvas',`<form id="join-form"><label for="join-invite">Private invitation</label><textarea id="join-invite" rows="4" placeholder="omc://join/…" required></textarea><p class="hint">Only open invitations from people you trust. Collaborators can change the shared canvas.</p><div class="actions right"><button class="primary">Join canvas</button></div></form>`);$('#join-form').onsubmit=run(async event=>{event.preventDefault();await api.invoke('join',{invite:$('#join-invite').value.trim(),focus:true});$('#dialog').close();});}
api.on(message=>{
  if(message.type==='workspace')renderWorkspace(message.state??message);
  else if(message.type==='preferences'){prefs=message.preferences;renderView();renderLibrary();}
  else if(message.type==='library-changed'&&workspace.activeTabId==null)void run(refreshLibrary)();
  else if(message.type==='error')toast(message.message,true);
  else if(message.type==='command'){const actions={new:()=>newCanvas(),import:importFile,library:()=>api.invoke('show-library'),join:joinDialog};void run(actions[message.name]??(()=>{}))();}
});
$('#home').onclick=run(()=>api.invoke('show-library'));$('#new').onclick=run(()=>newCanvas());$('#new-tab').onclick=run(()=>newCanvas());$('#import').onclick=run(importFile);$('#mcp').onclick=run(mcpDialog);$('#collaborate').onclick=joinDialog;
for(const node of document.querySelectorAll('[data-icon]'))node.innerHTML=icon(node.dataset.icon);
$('#search').oninput=renderLibrary;$('#sort').onchange=renderLibrary;
for(const button of document.querySelectorAll('[data-section]'))button.onclick=()=>{section=button.dataset.section;for(const node of document.querySelectorAll('[data-section]')){if(node===button)node.setAttribute('aria-current','page');else node.removeAttribute('aria-current');}renderLibrary();};
function renderView(){for(const value of ['grid','list'])$('#view-'+value).setAttribute('aria-pressed',String((prefs.view??'grid')===value));}
for(const value of ['grid','list'])$('#view-'+value).onclick=run(async()=>{prefs=await api.invoke('preferences',{view:value});renderView();renderLibrary();});
prefs=await api.invoke('preferences');renderView();renderWorkspace(await api.invoke('workspace'));await refreshLibrary();
