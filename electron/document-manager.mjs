import {randomUUID} from 'node:crypto';
import {Replica} from '../core/replica.mjs';
import {validId} from '../core/storage.mjs';
import {canvasTitle,createDocumentWriter} from './document-actions.mjs';

export const MAX_DOCUMENT_RUNTIMES=8;
const failure=(code,message)=>Object.assign(Error(message),{code});

export function createDocumentManager({store,createRuntime,disposeRuntime,flushRuntime,onChange=()=>{},onEvent=()=>{},canDispose=()=>true,maxResidents=MAX_DOCUMENT_RUNTIMES}) {
  const entries=new Map(),loading=new Map(),bindings=new Map(),generations=new Map();
  let activeTabId=null;
  const identity=entry=>({id:entry.record.id,title:entry.record.title,generation:entry.generation});
  const state=()=>({tabs:[...entries.values()].filter(entry=>entry.tabOpen).map(entry=>({...identity(entry),inUse:!!(entry.agents.size||entry.collab||!canDispose(entry)),saveError:entry.saveError??null})),activeTabId,libraryVisible:activeTabId===null});
  const changed=()=>onChange(state());
  const snapshot=entry=>({id:entry.record.id,documentId:entry.record.id,title:entry.record.title,document:entry.record.replica.document,ack:entry.seq,generation:entry.generation,recovered:!!entry.record.recovered,...entry.bootstrapNonce?{bootstrapNonce:entry.bootstrapNonce}:{}});
  async function save(entry){
    clearTimeout(entry.saveTimer);
    try{await entry.writer.save(entry.record);entry.saveError=null;onEvent(entry,{type:'saved',id:entry.record.id,at:Date.now()});}
    catch(error){entry.saveError=error.message;changed();throw error;}
  }
  function makeEntry(record){
    const entry={record,writer:createDocumentWriter(store),seq:0,generation:0,runtime:null,starting:null,tabOpen:false,agents:new Set(),collab:null,operations:Promise.resolve(),saveTimer:null};
    entry.unsubscribe=record.replica.onUpdate(()=>{
      clearTimeout(entry.saveTimer);entry.saveTimer=setTimeout(()=>{void save(entry).catch(error=>onEvent(entry,{type:'error',message:'Save failed: '+error.message}));},400);
      onEvent(entry,{type:'document',...snapshot(entry)});
    });
    return entry;
  }
  async function load(id,record){
    if(!validId(id))throw failure('bad_args','Invalid document ID');
    if(entries.has(id)){
      const entry=entries.get(id);
      if(entry.disposing){await entry.disposal;return load(id,record);}
      if(record&&record!==entry.record){try{entry.record.replica.receive(record.replica.state);}finally{record.replica.destroy();}}
      return entry;
    }
    if(loading.has(id)){const entry=await loading.get(id);if(record&&record!==entry.record){try{entry.record.replica.receive(record.replica.state);}finally{record.replica.destroy();}}return entry;}
    const task=Promise.resolve().then(async()=>{
      const loaded=record??await store.load(id),entry=makeEntry(loaded);entries.set(id,entry);return entry;
    });
    loading.set(id,task);
    try{return await task;}finally{loading.delete(id);}
  }
  function confirmGeneration(entry,generation){if(entry.generation!==generation)throw failure('runtime_restarted','Document renderer restarted; read fresh context before retrying');}
  function enqueue(entry,task){const generation=entry.generation,runtime=entry.runtime;const result=entry.operations.then(()=>{confirmGeneration(entry,generation);if(entry.runtime!==runtime)throw failure('runtime_restarted','Document renderer changed before this operation could run');return task();});entry.operations=result.catch(()=>{});return result;}
  function ready(entry,generation,error){
    if(entry.generation!==generation||!entry.starting)return;
    clearTimeout(entry.readyTimer);
    if(error)entry.rejectReady(failure('runtime_failed',error.message??String(error)));else entry.resolveReady(entry);
  }
  function reserve(entry){
    if(entry.reserved||entry.runtime||entry.starting)return;
    if([...entries.values()].filter(item=>item!==entry&&(item.runtime||item.starting||item.reserved)).length>=maxResidents)throw failure('resource_limit',`At most ${maxResidents} document runtimes can be resident. Close an unused tab or end its agent session first.`);
    entry.reserved=true;
  }
  async function ensureRuntime(entry){
    if(entry.disposing)throw failure('runtime_restarted','Document runtime is closing; reopen it before retrying');
    if(entry.starting)return entry.starting;
    if(entry.runtime)return entry;
    reserve(entry);
    entry.generation=(generations.get(entry.record.id)??0)+1;generations.set(entry.record.id,entry.generation);
    entry.seq=0;entry.bootstrapNonce=randomUUID();entry.bootstrapBase=entry.record.replica.document;
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
    return id;
  }
  function activate(id){
    const entry=entries.get(id);if(!entry?.runtime||!entry.tabOpen)throw failure('document_required','Open this document before activating its tab');
    activeTabId=id;changed();return state();
  }
  async function open(id,{focus=false,agent,signal}={}){
    signal?.throwIfAborted();const entry=await load(id);
    try{signal?.throwIfAborted();await ensureRuntime(entry);signal?.throwIfAborted();entry.tabOpen=true;bind(agent,entry);if(focus)activeTabId=id;changed();return entry;}
    catch(error){await release(entry);throw error;}
  }
  async function create(title,document,{focus=false,agent,signal}={}){
    signal?.throwIfAborted();
    const record={id:randomUUID(),title:canvasTitle(title??'Untitled canvas'),createdAt:new Date().toISOString(),replica:new Replica({document})};
    const entry=await load(record.id,record);
    try{signal?.throwIfAborted();reserve(entry);await save(entry);signal?.throwIfAborted();await ensureRuntime(entry);signal?.throwIfAborted();entry.tabOpen=true;bind(agent,entry);if(focus)activeTabId=record.id;changed();return entry;}
    catch(error){entry.reserved=false;if(!entry.runtime){entries.delete(record.id);entry.unsubscribe();record.replica.destroy();}else await release(entry);throw error;}
  }
  async function duplicate(id,title,options={}){
    const source=await load(id);source.holds=(source.holds??0)+1;let document,copyTitle;
    try{if(source.runtime)await flushRuntime(source);await save(source);options.signal?.throwIfAborted();document=source.record.replica.document;copyTitle=title??(source.record.title+' copy').slice(0,120);}
    finally{source.holds--;if(!source.runtime&&!source.starting)await release(source);}
    return create(copyTitle,document,options);
  }
  async function rename(id,title,{signal}={}){const entry=await load(id);entry.holds=(entry.holds??0)+1;try{signal?.throwIfAborted();const result=await entry.writer.rename(entry.record,id,title);onEvent(entry,{type:'metadata',document:{id,title:result.title}});changed();return result;}finally{entry.holds--;if(!entry.runtime&&!entry.starting)await release(entry);}}
  async function release(entry){
    if(entry.releasing)return entry.releasing;
    const work=(async()=>{
      if(entries.get(entry.record.id)!==entry||entry.starting||entry.reserved||entry.holds||entry.tabOpen||entry.agents.size||entry.collab||!canDispose(entry))return false;
      await entry.operations;await save(entry);
      if(entries.get(entry.record.id)!==entry||entry.starting||entry.reserved||entry.holds||entry.tabOpen||entry.agents.size||entry.collab||!canDispose(entry))return false;
      entry.disposing=true;entry.disposal=Promise.resolve().then(()=>disposeRuntime(entry));
      try{await entry.disposal;entry.runtime=null;clearTimeout(entry.saveTimer);entry.unsubscribe();entry.record.replica.destroy();entries.delete(entry.record.id);changed();return true;}
      finally{entry.disposing=false;entry.disposal=null;}
    })();
    entry.releasing=work;try{return await work;}finally{if(entry.releasing===work)entry.releasing=null;}
  }
  async function closeTab(id){
    const entry=entries.get(id);if(!entry)return state();
    if(entry.runtime)await flushRuntime(entry);await save(entry);
    entry.tabOpen=false;if(activeTabId===id)activeTabId=[...entries.values()].filter(item=>item.tabOpen).at(-1)?.record.id??null;
    await release(entry);changed();return state();
  }
  async function endAgent(agent){bindings.delete(agent);for(const entry of [...entries.values()]){entry.agents.delete(agent);await release(entry);}}
  async function flushAll(){for(const entry of entries.values()){if(entry.runtime)await flushRuntime(entry);await entry.operations;await save(entry);}}
  async function disposeAll(){for(const entry of entries.values()){clearTimeout(entry.saveTimer);clearTimeout(entry.readyTimer);await entry.collab?.close();await disposeRuntime(entry);entry.unsubscribe();entry.record.replica.destroy();}entries.clear();bindings.clear();activeTabId=null;}
  function runtimeGone(entry){ready(entry,entry.generation,Error('Document renderer stopped'));entry.runtime=null;entry.generation++;generations.set(entry.record.id,entry.generation);entry.seq=0;changed();}
  return {entries,bindings,state,identity,snapshot,load,enqueue,confirmGeneration,save,ensureRuntime,ready,bind,resolve,open,create,duplicate,rename,activate,release,showLibrary(){activeTabId=null;changed();return state();},closeTab,endAgent,flushAll,disposeAll,runtimeGone,changed};
}
