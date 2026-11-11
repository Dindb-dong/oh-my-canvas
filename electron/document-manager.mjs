import {randomUUID} from 'node:crypto';
import {Replica} from '../core/replica.mjs';
import {changesBetween,projectChanges,assertDocument,same} from '../core/document.mjs';
import {pageProjection,assertLoadedPageChanges} from '../core/page-projection.mjs';
import {appendImportedPages} from './document-pages.mjs';
import {validId} from '../core/storage.mjs';
import {canvasTitle,createDocumentWriter} from './document-actions.mjs';

export const MAX_DOCUMENT_RUNTIMES=8;
const failure=(code,message)=>Object.assign(Error(message),{code});
const canonicalDeltaRequired=key=>{
  const p=JSON.parse(key);
  return p[0]==='page'&&['alive','order','id','objects'].includes(p[2])||
    p[0]==='shape'&&['alive','order','parentId','type','id','childIds','enclosingFrameId'].includes(p[3])||
    p[0]==='meta'&&['pages','pagesById','assets','components','styles','libraries'].includes(p[1]);
};

export function createDocumentManager({store,createRuntime,disposeRuntime,flushRuntime,waitForPages=async()=>{},onChange=()=>{},onEvent=()=>{},canDispose=()=>true,maxResidents=MAX_DOCUMENT_RUNTIMES}) {
  const entries=new Map(),loading=new Map(),bindings=new Map(),generations=new Map(),deleting=new Set(),creating=new Set();
  let activeTabId=null,stopping=false;
  const identity=entry=>({id:entry.record.id,title:entry.record.title,generation:entry.generation});
  const state=()=>({tabs:[...entries.values()].filter(entry=>entry.tabOpen).map(entry=>({...identity(entry),inUse:!!(entry.agents.size||entry.collab||!canDispose(entry)),saveError:entry.saveError??null,loading:entry.loadingState??null})),activeTabId,libraryVisible:activeTabId===null});
  const changed=()=>onChange(state());
  const visibleDocument=entry=>entry.record.replica?(entry.visiblePageIds?pageProjection(entry.record.replica.document,entry.visiblePageIds):entry.record.replica.document):entry.previewDocument;
  const snapshot=entry=>({id:entry.record.id,documentId:entry.record.id,title:entry.record.title,document:visibleDocument(entry),ack:entry.seq,acceptedSeq:entry.acceptedSeq,revision:entry.revision,generation:entry.generation,recovered:!!entry.record.recovered,loading:entry.loadingState??null,importStatus:entry.record.importStatus??null,...entry.bootstrapNonce?{bootstrapNonce:entry.bootstrapNonce}:{}});
  const acknowledgment=entry=>({type:'commit-ack',id:entry.record.id,documentId:entry.record.id,ack:entry.seq,acceptedSeq:entry.acceptedSeq,revision:entry.revision,generation:entry.generation});
  const pageList=document=>document.pages.map(id=>({id,name:document.pagesById[id].name??'Untitled page',objects:Object.keys(document.pagesById[id].objects).length}));
  function loadingChanged(entry){if(entry.stopping)return;onEvent(entry,{type:'document-loading',loading:entry.loadingState??null,importStatus:entry.record.importStatus??null,saveError:entry.saveError??null});changed();}
  async function awaitPages(entry,revision){
    const signal=entry.lifecycle.signal;signal.throwIfAborted();
    if(!entry.runtime)return;
    let abort;
    const cancelled=new Promise((resolve,reject)=>{abort=()=>reject(signal.reason);signal.addEventListener('abort',abort,{once:true});});
    try{return await Promise.race([waitForPages(entry,revision,signal),cancelled]);}
    finally{signal.removeEventListener('abort',abort);}
  }
  async function save(entry){
    if(!entry.record.replica)await authority(entry);
    clearTimeout(entry.saveTimer);
    try{await entry.writer.save(entry.record);entry.saveError=null;if(!entry.stopping)onEvent(entry,{type:'saved',id:entry.record.id,at:Date.now()});}
    catch(error){entry.saveError=error.message;changed();throw error;}
  }
  function subscribe(entry){
    const replica=entry.record.replica;
    entry.authoritativeDoc=replica.fields.size?replica.document:null;
    entry.unsubscribe=replica.onUpdate((update,origin,doc,transaction)=>{
      if(entry.suppressProjection||entry.stopping){entry.authoritativeDoc=replica.document;return;}
      clearTimeout(entry.saveTimer);entry.saveTimer=setTimeout(()=>{void save(entry).catch(error=>onEvent(entry,{type:'error',message:'Save failed: '+error.message}));},400);
      const fromRevision=entry.revision++;
      if(entry.committingSeq!==undefined)entry.acceptedSeq=Math.max(entry.acceptedSeq,entry.committingSeq);
      const keys=transaction?.changed?.get(replica.fields);
      const before=entry.authoritativeDoc;entry.authoritativeDoc=replica.document;
      if(keys&&before){
        // A renderer projection does not retain deleted Yjs fields. History can
        // resurrect a shape/page by toggling only `alive`, so topology must send
        // the visible declarations and repairs from the canonical projection.
        const changes=[...keys].some(canonicalDeltaRequired)?changesBetween(entry.visiblePageIds?pageProjection(before,entry.visiblePageIds):before,visibleDocument(entry)):[...keys].filter(key=>{const p=JSON.parse(key);return !entry.visiblePageIds||!['page','shape','geometry'].includes(p[0])||entry.visiblePageIds.has(p[1]);}).map(key=>[key,replica.fields.get(key)??null]);
        onEvent(entry,{...acknowledgment(entry),type:'document-delta',fromRevision,changes,...entry.committingSeq!==undefined?{originSequence:entry.committingSeq}:{}});
      }else onEvent(entry,{type:'document',...snapshot(entry)});
    });
  }
  function makeEntry(record,preview){
    const entry={record,writer:createDocumentWriter(store),seq:0,acceptedSeq:0,revision:0,generation:0,runtime:null,starting:null,tabOpen:false,agents:new Set(),collab:null,operations:Promise.resolve(),saveTimer:null,lifecycle:new AbortController(),unsubscribe:()=>{}};
    if(preview){
      entry.previewDocument=preview.document;entry.previewToken=preview.token;entry.bootstrapChanges=[];
      entry.visiblePageIds=new Set(preview.document.pages);
      entry.loadingState={kind:'reopen',state:'loading',phase:'opening',loadedPages:preview.document.pages.length,totalPages:preview.pages.length,pages:preview.pages};
    }else subscribe(entry);
    return entry;
  }
  async function authority(entry){
    if(entry.record.replica)return entry;
    if(entry.loadError)throw entry.loadError;
    if(entry.hydrating)return entry.hydrating;
    entry.hydrating=(async()=>{
      const loaded=await store.load(entry.record.id);
      try{
        if(!store.previewMatches?.(loaded,entry.previewToken))throw failure('preview_changed','The stored document changed while opening. New edits have not been saved; keep this tab open.');
        if(entry.bootstrapChanges?.length)loaded.replica.patch(entry.bootstrapChanges,'Initialize canvas',undefined,{recordHistory:false});
        const before=entry.previewDocument;
        entry.record=loaded;entry.bootstrapChanges=[];subscribe(entry);
        const after=visibleDocument(entry);
        if(!same(before,after)){entry.revision++;if(!entry.stopping)onEvent(entry,{type:'document',...snapshot(entry)});}
        entry.previewDocument=null;entry.loadingState={...entry.loadingState,phase:'pages'};loadingChanged(entry);
        return entry;
      }catch(error){if(entry.record!==loaded)loaded.replica.destroy();throw error;}
    })().catch(error=>{
      entry.loadError=error;entry.saveError=error.message;entry.loadingState={...entry.loadingState,state:'failed',error:error.message};loadingChanged(entry);
      if(!entry.stopping)onEvent(entry,{type:'error',message:'Could not finish opening. New changes have not been saved. '+error.message});throw error;
    });
    return entry.hydrating;
  }
  async function deliverRemainingPages(entry){
    await authority(entry);
    entry.lifecycle.signal.throwIfAborted();
    while(entry.visiblePageIds&&entry.visiblePageIds.size<entry.record.replica.document.pages.length){
      const revision=await enqueue(entry,async()=>{
        entry.lifecycle.signal.throwIfAborted();
        const document=entry.record.replica.document,ids=[];let count=0;
        for(const id of document.pages){
          if(entry.visiblePageIds.has(id))continue;
          const size=Object.keys(document.pagesById[id].objects).length;
          if(ids.length&&(ids.length>=4||count+size>4000))break;
          ids.push(id);count+=size;
        }
        if(!ids.length)return null;
        for(const id of ids)entry.visiblePageIds.add(id);
        const fromRevision=entry.revision++;
        onEvent(entry,{...acknowledgment(entry),type:'document-pages',fromRevision,pageDocument:pageProjection(document,ids),pageOrder:document.pages.filter(id=>entry.visiblePageIds.has(id))});
        entry.loadingState={...entry.loadingState,loadedPages:entry.visiblePageIds.size};loadingChanged(entry);
        return entry.revision;
      });
      // Publication is serialized; waiting for the renderer is not. A title or
      // text edit may need this same queue to end its active editing session.
      if(revision!==null)await awaitPages(entry,revision);
      await new Promise(resolve=>setTimeout(resolve,16));
    }
    entry.lifecycle.signal.throwIfAborted();
    entry.visiblePageIds=null;entry.loadingState={...entry.loadingState,state:'complete',phase:'complete'};loadingChanged(entry);
  }
  function beginLoading(entry){
    clearTimeout(entry.resumeTimer);
    if(entry.loadingState?.kind!=='reopen'||entry.loadingState.state!=='loading')return entry.deliveryTask??Promise.resolve();
    if(!entry.deliveryTask){entry.deliveryTask=deliverRemainingPages(entry).catch(error=>{entry.loadError??=error;entry.loadingState={...entry.loadingState,state:'failed',error:error.message};loadingChanged(entry);throw error;});void entry.deliveryTask.catch(()=>{});}
    return entry.deliveryTask;
  }
  async function complete(entry){
    await authority(entry);
    if(entry.loadingState?.kind==='reopen')await beginLoading(entry);
    if(entry.importTask)await entry.importTask;
    if(entry.loadError)throw entry.loadError;
    if(entry.record.importStatus&&entry.record.importStatus.state!=='complete')throw failure('import_incomplete','The source import is incomplete. Reimport the original file as a new canvas to load every page; the saved partial canvas is kept.');
    return entry;
  }
  async function load(id,record,{preview=false}={}){
    if(stopping)throw failure('runtime_restarted','Document manager is closing');
    if(deleting.has(id))throw failure('busy','Document is being deleted');
    if(!validId(id))throw failure('bad_args','Invalid document ID');
    if(record){if(store.prepareRecord)await store.prepareRecord(record);else await store.importAssets?.(record);}
    if(entries.has(id)){
      const entry=entries.get(id);
      if(entry.disposing){await entry.disposal;return load(id,record,{preview});}
      if(!preview||record)await authority(entry);
      if(record&&record!==entry.record){try{entry.record.replica.receive(record.replica.state);await store.prepareRecord?.(entry.record);}finally{record.replica.destroy();}}
      return entry;
    }
    if(loading.has(id)){const entry=await loading.get(id);if(!preview||record)await authority(entry);if(record&&record!==entry.record){try{entry.record.replica.receive(record.replica.state);await store.prepareRecord?.(entry.record);}finally{record.replica.destroy();}}return entry;}
    const task=Promise.resolve().then(async()=>{
      const cached=!record&&preview?await store.loadPreview?.(id):null;
      const loaded=record??(cached?{id:cached.id,title:cached.title,createdAt:cached.createdAt,updatedAt:cached.updatedAt,thumbnail:cached.thumbnail,recovered:cached.recovered,importStatus:cached.importStatus,replica:null}:await store.load(id));
      if(stopping){loaded.replica?.destroy();throw failure('runtime_restarted','Document manager is closing');}
      const entry=makeEntry(loaded,cached);entries.set(id,entry);return entry;
    });
    loading.set(id,task);
    try{return await task;}finally{loading.delete(id);}
  }
  function confirmGeneration(entry,generation){if(entry.generation!==generation)throw failure('runtime_restarted','Document renderer restarted; read fresh context before retrying');}
  function enqueue(entry,task,{allowStopping=false}={}){
    if(entry.stopping&&!allowStopping)return Promise.reject(failure('runtime_restarted','Document runtime is closing'));
    const generation=entry.generation,runtime=entry.runtime;
    const result=entry.operations.then(async()=>{confirmGeneration(entry,generation);if(entry.runtime!==runtime)throw failure('runtime_restarted','Document renderer changed before this operation could run');if(!entry.record.replica)await authority(entry);confirmGeneration(entry,generation);return task();});
    entry.operations=result.catch(()=>{});return result;
  }
  function ready(entry,generation,error){
    if(entry.generation!==generation||!entry.starting)return;
    clearTimeout(entry.readyTimer);
    if(error)entry.rejectReady(failure('runtime_failed',error.message??String(error)));else {entry.resolveReady(entry);if(entry.loadingState?.kind==='reopen')entry.resumeTimer=setTimeout(()=>{void beginLoading(entry).catch(()=>{});},1000);}
  }
  function reserve(entry){
    if(entry.reserved||entry.runtime||entry.starting)return;
    if([...entries.values()].filter(item=>item!==entry&&(item.runtime||item.starting||item.reserved)).length>=maxResidents)throw failure('resource_limit',`At most ${maxResidents} document runtimes can be resident. Close an unused tab or end its agent session first.`);
    entry.reserved=true;
  }
  async function ensureRuntime(entry){
    if(deleting.has(entry.record.id))throw failure('busy','Document is being deleted');
    if(entry.disposing||entry.stopping)throw failure('runtime_restarted','Document runtime is closing; reopen it before retrying');
    if(entry.starting)return entry.starting;
    if(entry.runtime)return entry;
    reserve(entry);
    entry.generation=(generations.get(entry.record.id)??0)+1;generations.set(entry.record.id,entry.generation);
    entry.seq=0;entry.acceptedSeq=0;entry.bootstrapNonce=randomUUID();entry.bootstrapBase=visibleDocument(entry);
    const waiting=new Promise((resolve,reject)=>{entry.resolveReady=resolve;entry.rejectReady=reject;});
    entry.starting=waiting;
    entry.readyTimer=setTimeout(()=>ready(entry,entry.generation,Error('Document renderer initialization timed out')),45000);
    try{entry.runtime=createRuntime(entry);await waiting;return entry;}
    catch(error){await disposeRuntime(entry);entry.runtime=null;throw error;}
    finally{clearTimeout(entry.readyTimer);entry.starting=null;entry.reserved=false;}
  }
  function bind(agent,entry){if(agent){bindings.set(agent,entry.record.id);entry.agents.add(agent);}return entry;}
  function resolve(agent,documentId,mutation=false){
    if(mutation&&!documentId)throw failure('document_required','Mutations require an explicit documentId. Use list_documents and open_document to choose it.');
    const id=documentId??bindings.get(agent);
    if(!id)throw failure('document_required','No document is bound to this MCP session. Use open_document or create_document first.');
    if(!validId(id))throw failure('bad_args','Invalid document ID');
    if(deleting.has(id))throw failure('busy','Document is being deleted');
    return id;
  }
  function activate(id){
    const entry=entries.get(id);if(!entry?.runtime||!entry.tabOpen)throw failure('document_required','Open this document before activating its tab');
    activeTabId=id;changed();return state();
  }
  async function open(id,{focus=false,agent,signal}={}){
    signal?.throwIfAborted();const entry=await load(id,undefined,{preview:!agent});
    try{signal?.throwIfAborted();await ensureRuntime(entry);signal?.throwIfAborted();entry.tabOpen=true;bind(agent,entry);if(focus)activeTabId=id;changed();return entry;}
    catch(error){await release(entry);throw error;}
  }
  function create(...args){
    if(stopping)return Promise.reject(failure('runtime_restarted','Document manager is closing'));
    const task=createEntry(...args);creating.add(task);
    void task.then(()=>creating.delete(task),()=>creating.delete(task));return task;
  }
  async function createEntry(title,document,{focus=false,agent,signal,importStatus}={}){
    signal?.throwIfAborted();
    if(store.prepareDocument)document=await store.prepareDocument(document);
    signal?.throwIfAborted();
    const record={id:randomUUID(),title:canvasTitle(title??'Untitled canvas'),createdAt:new Date().toISOString(),replica:new Replica({document}),...(importStatus?{importStatus}:{})};
    let entry;
    try{entry=await load(record.id,record);}catch(error){record.replica.destroy();throw error;}
    if(importStatus)entry.loadingState={...importStatus,kind:'import',format:importStatus.kind,phase:'pages'};
    let initiallySaved=false;
    try{signal?.throwIfAborted();if(stopping)throw failure('runtime_restarted','Document manager is closing');reserve(entry);await save(entry);initiallySaved=true;signal?.throwIfAborted();entry.lifecycle.signal.throwIfAborted();await ensureRuntime(entry);signal?.throwIfAborted();entry.tabOpen=true;bind(agent,entry);if(focus)activeTabId=record.id;changed();return entry;}
    catch(error){
      // The importer has not received this entry yet. If the first page was
      // already durable, retain an honest terminal status before releasing it.
      if(importStatus&&initiallySaved){
        record.importStatus={...importStatus,state:signal?.aborted||entry.stopping?'cancelled':'failed',loadedPages:record.replica.document.pages.length,error:String(error.message??error).slice(0,1024)};
        entry.loadingState={...record.importStatus,kind:'import',format:importStatus.kind,phase:'stopped'};
        try{await save(entry);}catch(saveError){error.saveError=saveError.message;}
      }
      entry.reserved=false;if(!entry.runtime){entries.delete(record.id);entry.unsubscribe();record.replica.destroy();}else await release(entry);throw error;
    }
  }
  async function bootstrap(entry,data){
    if(entry.seq!==0||typeof data?.nonce!=='string'||data.nonce!==entry.bootstrapNonce)throw Error('Invalid canvas initialization');
    if(!same(entry.bootstrapBase,visibleDocument(entry))){entry.bootstrapNonce=randomUUID();entry.bootstrapBase=visibleDocument(entry);return {...snapshot(entry),bootstrapRetry:true};}
    if(entry.loadingState?.state==='loading')assertLoadedPageChanges(visibleDocument(entry),data.changes);
    const generation=entry.generation,changes=await store.prepareChanges(data.changes);confirmGeneration(entry,generation);
    if(!same(entry.bootstrapBase,visibleDocument(entry))){entry.bootstrapNonce=randomUUID();entry.bootstrapBase=visibleDocument(entry);return {...snapshot(entry),bootstrapRetry:true};}
    if(entry.record.replica){
      entry.record.replica.patch(changes,'Initialize canvas',undefined,{recordHistory:false});await save(entry);confirmGeneration(entry,generation);
    }else{
      const next=assertDocument(projectChanges(entry.previewDocument,changes));
      if(!same(next.pages,entry.previewDocument.pages))throw Error('Initialization cannot change a partially loaded page list');
      entry.previewDocument=next;entry.bootstrapChanges.push(...changes);
    }
    entry.bootstrapNonce=null;entry.bootstrapBase=null;return snapshot(entry);
  }
  async function appendPages(entry,document,status){
    const revision=await enqueue(entry,async()=>{
      entry.lifecycle.signal.throwIfAborted();
      let added;
      entry.suppressProjection=true;
      try{added=appendImportedPages(entry.record.replica,document);}finally{entry.suppressProjection=false;}
      entry.record.importStatus=status;
      entry.loadingState={...status,kind:'import',format:status.kind,phase:'saving'};
      const fromRevision=entry.revision++;
      onEvent(entry,{...acknowledgment(entry),type:'document-pages',fromRevision,pageDocument:added,pageOrder:entry.record.replica.document.pages});loadingChanged(entry);
      await save(entry);
      entry.loadingState={...entry.loadingState,phase:status.state==='complete'?'complete':'pages'};loadingChanged(entry);
      return entry.revision;
    });
    await awaitPages(entry,revision);
    return entry;
  }
  async function finishImport(entry,status,warnings){
    return enqueue(entry,async()=>{
      if(warnings!==undefined){
        if(!Array.isArray(warnings)||warnings.length>40||warnings.some(value=>typeof value!=='string'||value.length>1024))throw Error('Invalid import diagnostics');
        const extra={...entry.record.replica.document.extra,importWarnings:[...new Set(warnings)]};
        if(!same(extra,entry.record.replica.document.extra))entry.record.replica.patch([[JSON.stringify(['meta','extra']),extra]],'Import diagnostics',undefined,{recordHistory:false});
      }
      entry.record.importStatus=status;
      const terminal={...status,kind:'import',format:status.kind,phase:status.state==='complete'?'complete':'stopped'};
      entry.loadingState={...terminal,...status.state==='complete'?{state:'loading'}:{},phase:'saving'};loadingChanged(entry);
      try{await save(entry);entry.loadingState=terminal;}
      catch(error){entry.loadingState={...terminal,state:'failed',phase:'stopped',error:error.message};throw error;}
      finally{loadingChanged(entry);}
    },{allowStopping:true});
  }
  function assertChanges(entry,changes){if(entry.loadingState?.state==='loading')assertLoadedPageChanges(visibleDocument(entry),changes);}
  async function duplicate(id,title,options={}){
    const source=await load(id);await complete(source);source.holds=(source.holds??0)+1;let document,copyTitle;
    try{if(source.runtime)await flushRuntime(source,{guardBusy:!!options.agent,signal:options.signal,agent:options.agent});await save(source);options.signal?.throwIfAborted();document=source.record.replica.document;copyTitle=title??(source.record.title+' copy').slice(0,120);}
    finally{source.holds--;if(!source.runtime&&!source.starting)await release(source);}
    return create(copyTitle,document,options);
  }
  async function rename(id,title,{signal}={}){const entry=await load(id);entry.holds=(entry.holds??0)+1;try{signal?.throwIfAborted();const result=await entry.writer.rename(entry.record,id,title);onEvent(entry,{type:'metadata',document:{id,title:result.title}});changed();return result;}finally{entry.holds--;if(!entry.runtime&&!entry.starting)await release(entry);}}
  async function release(entry){
    if(entry.releasing)return entry.releasing;
    const work=(async()=>{
      if(entries.get(entry.record.id)!==entry||entry.starting||entry.reserved||entry.holds||entry.tabOpen||entry.agents.size||entry.collab||!canDispose(entry))return false;
      await entry.operations;await save(entry);
      await store.flushPreviews?.(entry.record.id);
      if(entries.get(entry.record.id)!==entry||entry.starting||entry.reserved||entry.holds||entry.tabOpen||entry.agents.size||entry.collab||!canDispose(entry))return false;
      entry.disposing=true;entry.disposal=Promise.resolve().then(()=>disposeRuntime(entry));
      try{await entry.disposal;entry.runtime=null;clearTimeout(entry.saveTimer);clearTimeout(entry.resumeTimer);entry.unsubscribe();entry.record.replica?.destroy();entries.delete(entry.record.id);changed();return true;}
      finally{entry.disposing=false;entry.disposal=null;}
    })();
    entry.releasing=work;try{return await work;}finally{if(entry.releasing===work)entry.releasing=null;}
  }
  async function closeTab(id,options={}){
    const entry=entries.get(id);if(!entry)return state();
    if(entry.importTask)await entry.importTask.catch(()=>{});
    if(entry.loadingState?.kind==='reopen')await beginLoading(entry);
    if(entry.runtime)await flushRuntime(entry,options);await save(entry);
    await store.flushPreviews?.(id);
    entry.tabOpen=false;if(activeTabId===id)activeTabId=[...entries.values()].filter(item=>item.tabOpen).at(-1)?.record.id??null;
    await release(entry);changed();return state();
  }
  function discard(entry){if(entries.get(entry.record.id)!==entry||entry.runtime||entry.starting||entry.tabOpen||entry.agents.size||entry.collab||entry.holds)return false;clearTimeout(entry.saveTimer);clearTimeout(entry.resumeTimer);entry.unsubscribe();entry.record.replica?.destroy();entries.delete(entry.record.id);changed();return true;}
  async function releaseAgent(agent,id){
    const entry=entries.get(id);if(bindings.get(agent)===id)bindings.delete(agent);
    if(entry){entry.agents.delete(agent);await release(entry);}changed();return state();
  }
  async function remove(id,{expectedTitle,beforeRemove=async()=>{},cancelRemove=async()=>{}}={}){
    let entry;
    try{entry=await load(id);}catch(original){
      if(entries.has(id)||loading.has(id)||deleting.has(id))throw original;
      if(!validId(id))throw original;
      deleting.add(id);
      try{
        const metadata=(await store.list()).find(record=>record.id===id);
        if(!metadata?.damaged)throw original;
        if(metadata.title!==expectedTitle)throw failure('stale_title','Canvas title changed; inspect it before deleting');
        if(entries.has(id)||loading.has(id))throw failure('busy','Canvas became active before deletion');
        await store.remove(id);changed();return true;
      }finally{deleting.delete(id);}
    }
    if(entry.record.title!==expectedTitle){await release(entry);throw failure('stale_title','Canvas title changed; inspect it before deleting');}
    if(deleting.has(id)||entry.holds||entry.starting||entry.loadingState?.state==='loading'||entry.agents.size||entry.collab||!canDispose(entry))throw failure('busy','Canvas is in use. Finish loading and release agent bindings and collaboration before deleting');
    deleting.add(id);entry.holds=(entry.holds??0)+1;
    try{
      await beforeRemove(entry);await entry.operations;
      if(entry.agents.size||entry.collab||!canDispose(entry))throw failure('busy','Canvas became busy before deletion');
      await save(entry);await store.remove(id);
      await disposeRuntime(entry);entry.runtime=null;clearTimeout(entry.saveTimer);entry.unsubscribe();entry.record.replica.destroy();entries.delete(id);
      if(activeTabId===id)activeTabId=[...entries.values()].filter(item=>item.tabOpen).at(-1)?.record.id??null;
      changed();return true;
    }catch(error){await Promise.resolve().then(()=>cancelRemove(entry)).catch(()=>{});throw error;}
    finally{entry.holds--;deleting.delete(id);if(entries.get(id)===entry&&!entry.runtime)await release(entry);}
  }
  async function endAgent(agent){bindings.delete(agent);for(const entry of [...entries.values()]){entry.agents.delete(agent);await release(entry);}}
  async function flushAll(){for(const entry of entries.values()){if(entry.importTask)await entry.importTask.catch(()=>{});if(entry.loadingState?.kind==='reopen')await beginLoading(entry);if(entry.runtime)await flushRuntime(entry);await entry.operations;await save(entry);}await store.flushPreviews?.();}
  async function disposeAll(){
    stopping=true;
    for(const entry of entries.values()){entry.stopping=true;ready(entry,entry.generation,Error('Document runtime is closing'));clearTimeout(entry.saveTimer);clearTimeout(entry.readyTimer);clearTimeout(entry.resumeTimer);entry.cancelImport?.();entry.lifecycle.abort(failure('runtime_restarted','Document runtime is closing'));}
    // A first page can be saving before the importer receives its entry and
    // attaches importTask. Creation owns that earlier lifetime explicitly.
    await Promise.allSettled([...creating,...loading.values()]);
    for(const entry of [...entries.values()]){
      // A cancelled importer still owns its terminal metadata/save. Let it and
      // any already admitted edit finish before releasing the authority.
      await Promise.allSettled([entry.importTask,entry.deliveryTask,entry.hydrating,entry.operations]);
      await entry.operations;await store.flushPreviews?.(entry.record.id);
      await entry.collab?.close();await disposeRuntime(entry);entry.runtime=null;entry.generation++;
      generations.set(entry.record.id,entry.generation);entry.unsubscribe();entry.record.replica?.destroy();entries.delete(entry.record.id);
    }
    await store.flushPreviews?.();
    bindings.clear();activeTabId=null;
  }
  function runtimeGone(entry){ready(entry,entry.generation,Error('Document renderer stopped'));entry.runtime=null;entry.generation++;generations.set(entry.record.id,entry.generation);entry.seq=0;changed();}
  return {entries,bindings,deleting,state,identity,snapshot,acknowledgment,load,enqueue,confirmGeneration,save,ensureRuntime,ready,bind,resolve,open,create,duplicate,rename,activate,release,releaseAgent,remove,discard,authority,complete,beginLoading,bootstrap,appendPages,finishImport,assertChanges,showLibrary(){activeTabId=null;changed();return state();},closeTab,endAgent,flushAll,disposeAll,runtimeGone,changed};
}
