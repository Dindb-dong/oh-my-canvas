import * as Y from 'yjs';
import { flatten, materialize, assertDocument,MAX_STATE_BYTES } from './document.mjs';
import * as documentModel from './document.mjs';
import { collectAssetRefs } from './asset-refs.mjs';
import {localMapStateBound,scratchMapStateBound,independentMapStateBound,supportsLocalMapBound} from './state-budget.mjs';
import {mergePageDocuments,pageProjection} from './page-projection.mjs';
const catalogs=new Set(['assets','components','styles','libraries']);
const owns=(value,key)=>Object.prototype.hasOwnProperty.call(value??{},key);
const sameDefinition=(before,after)=>{
  const semantic=value=>value&&typeof value==='object'&&!Array.isArray(value)?Object.fromEntries(Object.entries(value).filter(([key])=>key!=='name')):value;
  return documentModel.same(semantic(before),semantic(after));
};
// Reusing a pre-encoding projection requires values which Yjs's Any codec
// preserves exactly. Unusual structured-clone values still import through the
// ordinary decoded-state validation path. Inspect descriptors, never getters.
function stableAtomicValue(value,seen){
  if(value===null||['undefined','boolean','number'].includes(typeof value))return true;
  if(typeof value==='string')return value.isWellFormed();
  if(typeof value!=='object')return false;
  if(seen.has(value))return true;seen.add(value);
  const array=Array.isArray(value),proto=Object.getPrototypeOf(value);
  if(proto!==(array?Array.prototype:Object.prototype))return false;
  const keys=Reflect.ownKeys(value);
  if(array&&keys.length!==value.length+1)return false;
  for(const key of keys){
    if(array&&key==='length')continue;
    if(typeof key!=='string'||!key.isWellFormed()||key==='__proto__')return false;
    if(array&&(!/^(0|[1-9]\d*)$/.test(key)||Number(key)>=value.length))return false;
    const descriptor=Object.getOwnPropertyDescriptor(value,key);
    if(!descriptor?.enumerable||!owns(descriptor,'value')||!stableAtomicValue(descriptor.value,seen))return false;
  }
  return true;
}
const canonicalChanges=changes=>changes?.some(([key])=>{
  const p=JSON.parse(key);
  return p[0]==='page'&&['alive','order','id','objects'].includes(p[2])||
    p[0]==='shape'&&['alive','order','parentId','type','id','childIds','enclosingFrameId'].includes(p[3])||
    p[0]==='meta'&&['pages','pagesById','assets','components','styles','libraries'].includes(p[1]);
});
export class Replica {
  constructor({ state, updates = [], document, onMetric } = {}) {
    this.ydoc = new Y.Doc();
    this.fields = this.ydoc.getMap('fields');
    this.local = Symbol('local');
    this.validationDoc=null;this.cachedDocument=undefined;this.cachedState=undefined;this.encodedStateCeiling=undefined;
    this.revision=0;this.updateLog=[];this.updateLogBytes=0;this.retainedAssetRefs=new Set();this.onMetric=onMetric;
    const observe=()=>{
      this.fields.observe(event=>{for(const field of event.keysChanged)collectAssetRefs(this.fields.get(field),this.retainedAssetRefs);});
      this.ydoc.on('update',update=>{
      this.cachedDocument=this.publishingDocument;this.cachedState=undefined;this.encodedStateCeiling=this.publishingCeiling;
      this.revision++;
      // Persistence readers that fall behind this bounded log receive a fresh
      // checkpoint instead. Keep the latest detached copy weakly, so immediate
      // saves can capture a large page delta without retaining it in this log.
      // Subscriber-owned event bytes cannot mutate the persistence snapshot.
      const copy=update.slice();
      this.latestUpdate={revision:this.revision,update:new WeakRef(copy)};
      if(update.byteLength>4*1024*1024){this.updateLog=[];this.updateLogBytes=0;}
      else{
        this.updateLog.push({revision:this.revision,update:copy});this.updateLogBytes+=copy.byteLength;
        while(this.updateLog.length>512||this.updateLogBytes>4*1024*1024){this.updateLogBytes-=this.updateLog.shift().update.byteLength;}
      }
      if(this.validationDoc)Y.applyUpdate(this.validationDoc,update,'mirror');
      });
    };
    try{
      if(!Array.isArray(updates)||updates.length&&!state)throw Error('Journal updates require a checkpoint');
      if(state){
        const maximum=documentModel.MAX_LARGE_STATE_BYTES??MAX_STATE_BYTES;
        if(!(state instanceof Uint8Array)||state.byteLength>maximum)throw Error('CRDT history exceeds the storage limit');
        try{Y.applyUpdate(this.ydoc,state,'load');}catch(error){throw Object.assign(error,{hydrationPhase:'checkpoint'});}
        let journalBytes=0;
        for(const update of updates){
          if(!(update instanceof Uint8Array)||update.byteLength>maximum||(journalBytes+=update.byteLength)>(documentModel.MAX_PORTABLE_BYTES??384*1024*1024))throw Error('Save journal updates exceed the storage limit');
          Y.applyUpdate(this.ydoc,update,'load-journal');
        }
        // Hydrate directly into the final replica. There are no subscribers to
        // publish intermediate states or re-encode each load as an update event.
        this.revision=1;this.rememberStateAssets();observe();
      }else{
        if(document){
          this.ydoc.transact(()=>{for(const [key,value] of flatten(assertDocument(document)))this.fields.set(key,value);},'seed');
          this.revision=1;this.rememberStateAssets();
        }
        observe();
      }
      this.undo=new Y.UndoManager(this.fields,{trackedOrigins:new Set([this.local]),captureTimeout:Infinity});
      if(state||document)this.cachedDocument=this.validateState(this.ydoc);
    }catch(error){this.undo?.destroy();this.ydoc.destroy();throw error;}
  }
  get document() { return this.cachedDocument??=assertDocument(materialize(this.fields)); }
  get state() {
    if(!this.cachedState)this.cachedState=Y.encodeStateAsUpdate(this.ydoc);
    this.encodedStateCeiling=this.cachedState.byteLength;
    return this.cachedState;
  }
  rememberStateAssets(){
    // An imported checkpoint can contain an asset only in retained Undo content.
    // This scan happens on load/remote import, never for an ordinary local edit.
    for(const structs of this.ydoc.store.clients.values())for(const item of structs)for(const value of item.content?.getContent?.()??[])collectAssetRefs(value,this.retainedAssetRefs);
  }
  captureSince(token,{full=false}={}){
    const base={replica:this,revision:this.revision,assetHashes:[...this.retainedAssetRefs]};
    const owner=token?.replica instanceof WeakRef?token.replica.deref():token?.replica;
    if(!full&&owner===this&&token.revision===this.revision)return {...base,full:false,update:null};
    if(!full&&owner===this&&token.revision===this.revision-1&&this.latestUpdate?.revision===this.revision){
      const update=this.latestUpdate.update.deref();if(update)return {...base,full:false,update:update.slice()};
    }
    if(!full&&owner===this&&Number.isSafeInteger(token.revision)&&token.revision<=this.revision&&token.revision>=((this.updateLog[0]?.revision??this.revision+1)-1)){
      const updates=this.updateLog.filter(item=>item.revision>token.revision).map(item=>item.update);
      return {...base,full:false,update:updates.length===1?updates[0].slice():Y.mergeUpdates(updates)};
    }
    return {...base,full:true,update:this.state.slice()};
  }
  validateState(doc,{previous,changes,stateCeiling,budget,boundOnly=false}={}){
    const started=performance.now();
    const canonical=canonicalChanges(changes);
    // Topology can reveal retained fields absent from the visible projection.
    // Validate the actual trial state there; scalar edits keep structural sharing.
    const incremental=previous&&changes&&!canonical&&documentModel.projectChanges;
    const projected=incremental?documentModel.projectChanges(previous,changes):materialize(doc.getMap('fields'));
    const document=incremental&&documentModel.assertDocumentIncremental?documentModel.assertDocumentIncremental(projected,previous):assertDocument(projected);
    const validatedAt=performance.now(),profile=documentModel.documentLimits?.(document),limit=profile?.stateBytes??profile?.bytes??MAX_STATE_BYTES;
    const bounded=Number.isSafeInteger(stateCeiling)&&stateCeiling>=0&&stateCeiling<=limit;
    if(boundOnly&&!bounded)return null;
    const state=bounded?null:Y.encodeStateAsUpdate(doc),encodedAt=performance.now(),bytes=state?.byteLength??stateCeiling;
    if(bytes>limit)throw Error(`Document and history exceed ${limit/1024/1024} MiB. Duplicate the canvas to start a fresh history, or use smaller images.`);
    if(budget)budget.bytes=bytes;
    if(doc===this.ydoc){if(state)this.cachedState=state;this.encodedStateCeiling=bytes;}
    try{this.onMetric?.({stage:'replica-validation',durationMs:performance.now()-started,documentMs:validatedAt-started,encodeStateMs:bounded?0:encodedAt-validatedAt,...bounded?{stateBytesUpperBound:bytes}:{stateBytes:bytes},sizeValidation:bounded?'bounded':'exact',incremental:!!incremental});}catch{}
    return document;
  }
  trial(){
    const trial=new Y.Doc({gc:false});
    try{
      Y.applyUpdate(trial,this.state);trial.clientID=this.ydoc.clientID;
      // Updates contain document data, not Undo's redone chains. Without these
      // links a second Undo can validate B while the live history restores A.
      // Decoding may merge adjacent structs, so restore the original boundaries
      // before attaching the corresponding stable-ID links to the trial.
      trial.transact(transaction=>{
        for(const structs of this.ydoc.store.clients.values())for(const item of structs){
          if(!(item instanceof Y.Item)||item.redone===null)continue;
          const copy=Y.getItemCleanStart(transaction,item.id);
          Y.getItemCleanEnd(transaction,trial.store,{client:item.id.client,clock:item.id.clock+item.length-1});
          if(!(copy instanceof Y.Item)||copy.length!==item.length)throw Error('Cannot reconstruct history item boundaries');
          copy.redone={client:item.redone.client,clock:item.redone.clock};copy.keep=item.keep;
        }
      },'history-clone');
      return trial;
    }catch(error){trial.destroy();throw error;}
  }
  recoveryFields(){
    const doc=this.document,entries=[];
    for(const pid of doc.pages){
      for(const k of [JSON.stringify(['page',pid,'alive']),JSON.stringify(['shape',pid,'root','alive'])])if(this.fields.get(k)!==true)entries.push([k,true]);
    }
    return entries;
  }
  keptByLive(item){
    const structs=this.ydoc.store.clients.get(item.id.client);
    if(!structs?.length)return false;
    const last=structs.at(-1);if(item.id.clock>=last.id.clock+last.length)return false;
    let i=Y.findIndexSS(structs,item.id.clock);
    for(;i<structs.length&&structs[i].id.clock<item.id.clock+item.length;i++)if(structs[i] instanceof Y.Item&&structs[i].keep)return true;
    return false;
  }
  validator(){
    if(!this.validationDoc){
      // Match live GC for remote replacements, while retaining live Undo items.
      // A tentative local write also keeps its predecessor until live Undo owns it.
      this.validationDoc=new Y.Doc({gc:true,gcFilter:item=>!this.speculatingLocal&&!this.keptByLive(item)});
      Y.applyUpdate(this.validationDoc,this.state,'mirror-seed');
    }
    return this.validationDoc;
  }
  rejectValidation(){this.validationDoc?.destroy();this.validationDoc=null;}
  simpleCandidate(writes){
    if(!writes.length||canonicalChanges(writes)||!Number.isSafeInteger(this.encodedStateCeiling))return null;
    const keys=writes.map(([key])=>key);
    if(!supportsLocalMapBound(this.ydoc,keys))return null;
    for(const [key,value] of writes){
      const item=this.fields._map.get(key);
      if(!item||item.deleted||item.length!==1||!(item.content instanceof Y.ContentAny))return null;
      // A scratch write must not attach or mutate a caller-owned shared type.
      if(value!==null&&typeof value==='object'&&!Array.isArray(value)&&Object.getPrototypeOf(value)!==Object.prototype)return null;
    }
    const scratch=new Y.Doc({gc:false}),budget={};
    try{
      scratch.transact(()=>{for(const [key,value] of writes)scratch.getMap('fields').set(key,value);});
      if(!supportsLocalMapBound(scratch,keys))return null;
      const stateCeiling=scratchMapStateBound(this.encodedStateCeiling,Y.encodeStateAsUpdate(scratch).byteLength,writes.length);
      const document=this.validateState(scratch,{previous:this.document,changes:writes,stateCeiling,budget,boundOnly:true});
      return document?{document,budget}:null;
    }finally{scratch.destroy();}
  }
  publishLocal(document,ceiling,label,group,recordHistory,publish){
    const top=this.undo.undoStack.at(-1);
    if(recordHistory&&(!group||top?.meta.get('group')!==group||top?.meta.get('label')!==label))this.undo.stopCapturing();
    this.publishingDocument=document;this.publishingCeiling=ceiling;
    try{publish();}finally{this.publishingDocument=undefined;this.publishingCeiling=undefined;}
    this.cachedDocument=document;this.encodedStateCeiling=ceiling;
    const entry=this.undo.undoStack.at(-1);
    if(recordHistory&&entry){entry.meta.set('label',label);entry.meta.set('group',group);}
  }
  patch(changes, label, group, {recordHistory=true} = {}) {
    if (!Array.isArray(changes) || changes.length > 300000) throw Error('Invalid patch');
    for(const row of changes){
      if(!Array.isArray(row)||row.length!==2)throw Error('Invalid field change');
      documentModel.fieldParts(row[0]);collectAssetRefs(row[1]);
    }
    const writes=[...this.recoveryFields(),...changes];
    // An empty acknowledgement/bootstrap patch has no state to validate. Keep
    // recovery declarations above: an empty input can still repair a page whose
    // last live declaration was removed by concurrent edits.
    if(!writes.length)return;
    let simple;
    try{simple=this.simpleCandidate(writes);}catch(error){this.rejectValidation();throw error;}
    if(simple){
      this.publishLocal(simple.document,simple.budget.bytes,label,group,recordHistory,()=>this.ydoc.transact(()=>{for(const [key,value] of writes)this.fields.set(key,value);},recordHistory?this.local:'bootstrap'));
      return;
    }
    // Topology, new registers and near-limit candidates retain the synchronized
    // speculative document; rejected candidates never reach the live replica.
    const trial=this.validator();
    const keys=writes.map(([key])=>key),boundEligible=supportsLocalMapBound(trial,keys),updates=[],capture=update=>updates.push(update);
    const budget={};let document,update;
    try{
      this.speculatingLocal=recordHistory;
      trial.on('update',capture);
      try{trial.transact(()=>{for(const [k,v] of writes){trial.getMap('fields').set(k,v);}});}finally{trial.off('update',capture);this.speculatingLocal=false;}
      update=updates.length===1?updates[0]:updates.length?Y.mergeUpdates(updates):new Uint8Array([0,0]);
      const stateCeiling=boundEligible&&supportsLocalMapBound(trial,keys)?localMapStateBound(this.encodedStateCeiling,update.byteLength,writes.length):null;
      document=this.validateState(trial,{previous:this.document,changes:writes,stateCeiling,budget});
    }catch(e){this.rejectValidation();throw e;}
    this.publishLocal(document,budget.bytes,label,group,recordHistory,()=>Y.applyUpdate(this.ydoc,update,recordHistory?this.local:'bootstrap'));
  }
  /** Import only previously unused page namespaces. This method accepts a
   * document, never an externally asserted validation proof or opaque update.
   * It derives canonical fields itself and validates the complete new pages
   * plus the immutable combined document before a single live transaction.
   * As with ordinary model patches, supplied values are immutable after handoff.
   */
  appendNewPages(batch){
    const started=performance.now(),before=this.document;
    assertDocument(batch);
    const ids=new Set(batch.pages);
    if(ids.size!==batch.pages.length)throw Error('Invalid imported page order');
    for(const id of ids)if(owns(before.pagesById,id))throw Error('A loading batch cannot replace an existing page');
    // Include hard-deleted keys retained by Yjs, not just visible map entries.
    for(const key of this.fields._map.keys()){
      const p=documentModel.fieldParts(key);
      if(['page','shape','geometry'].includes(p[0])&&ids.has(p[1]))throw Error('An imported page ID is already used by document history');
    }
    const ranks=before.pages.map(id=>this.fields.get(JSON.stringify(['page',id,'order'])));
    const ordered=ranks.every(Number.isSafeInteger)&&before.pages.every(id=>this.fields.get(JSON.stringify(['page',id,'alive']))===true);
    const lastOrder=ordered?Math.max(-1,...ranks):before.pages.length-1;
    const safeOrder=ordered&&lastOrder<=Number.MAX_SAFE_INTEGER-batch.pages.length;
    const index=new Map(batch.pages.map((id,i)=>[id,i])),writes=new Map(),stableValues=new WeakSet();let stable=true;
    for(const [key,value] of flatten(batch)){
      const p=documentModel.fieldParts(key);
      if(p[0]==='meta')continue;
      if(catalogs.has(p[0])){
        if(owns(before[p[0]],p[1])){
          if(!sameDefinition(before[p[0]][p[1]],value))throw Error('An imported catalog ID conflicts with an existing definition');
          continue;
        }
        if(this.fields._map.has(key))throw Error('An imported catalog ID was previously deleted; its dependencies cannot be restored by a page batch');
      }
      collectAssetRefs(value);
      stable=stable&&stableAtomicValue(value,stableValues);
      writes.set(key,p[0]==='page'&&p[2]==='order'?(safeOrder?lastOrder+1:before.pages.length)+index.get(p[1]):value);
    }
    // A standalone fragment's last-page recovery must not conceal tombstoned
    // declarations: recovery would disappear when merged into a live document.
    for(const id of ids)if(writes.get(JSON.stringify(['page',id,'alive']))!==true||writes.get(JSON.stringify(['shape',id,'root','alive']))!==true)throw Error('Invalid imported page declarations');
    const canonical=materialize(writes);
    if(!documentModel.same(canonical.pages,batch.pages))throw Error('Invalid imported page declarations');
    for(const profile of ['capacity','capacityProfile'])if(owns(before,profile))canonical[profile]=before[profile];
    const document=mergePageDocuments(before,canonical),validatedAt=performance.now();
    const scratch=new Y.Doc(),fields=scratch.getMap('fields');
    try{
      while(scratch.clientID===this.ydoc.clientID||this.ydoc.store.clients.has(scratch.clientID))scratch.clientID=(scratch.clientID+1)>>>0;
      scratch.transact(()=>{for(const [key,value] of writes)fields.set(key,value);},'import-pages');
      const update=Y.encodeStateAsUpdate(scratch),preparedAt=performance.now();
      const ceiling=safeOrder&&stable?independentMapStateBound(this.ydoc,scratch,this.encodedStateCeiling,update.byteLength):null;
      const bounded=ceiling!==null&&ceiling<=documentModel.documentLimits(document).stateBytes;
      if(bounded)this.publishLocal(document,ceiling,undefined,undefined,false,()=>Y.applyUpdate(this.ydoc,update,'remote'));
      else this.receive(update);
      try{this.onMetric?.({stage:'replica-append-pages',durationMs:performance.now()-started,documentMs:validatedAt-started,prepareUpdateMs:preparedAt-validatedAt,applyMs:performance.now()-preparedAt,updateBytes:update.byteLength,pages:batch.pages.length,sizeValidation:bounded?'independent-bound':'exact',stateBytesUpperBound:this.encodedStateCeiling});}catch{}
      return pageProjection(this.document,batch.pages);
    }finally{scratch.destroy();}
  }
  receive(update) {
    if (!(update instanceof Uint8Array) || update.byteLength > (documentModel.MAX_LARGE_STATE_BYTES??MAX_STATE_BYTES)) throw Error('Update exceeds the storage limit');
    const retainedAssets=new Set();
    for(const item of Y.decodeUpdate(update).structs)for(const value of item.content?.getContent?.()??[])collectAssetRefs(value,retainedAssets);
    const trial=this.validator(),budget={};let document;
    try{Y.applyUpdate(trial,update);document=this.validateState(trial,{budget});}
    catch(e){this.rejectValidation();throw e;}
    this.publishingDocument=document;this.publishingCeiling=budget.bytes;
    try{Y.applyUpdate(this.ydoc,update,'remote');}finally{this.publishingDocument=undefined;this.publishingCeiling=undefined;}
    this.cachedDocument=document;this.encodedStateCeiling=budget.bytes;
    // Incoming complete states can introduce history-only dependencies. Keeping
    // this union ensures future Undo/portable export cannot lose their blobs.
    for(const hash of retainedAssets)this.retainedAssetRefs.add(hash);
  }
  history(direction){
    if(!['undo','redo'].includes(direction))throw Error('Invalid history action');
    const previousBytes=this.state.byteLength,trial=this.trial(),undo=new Y.UndoManager(trial.getMap('fields'),{captureTimeout:0}),budget={};
    try{
      // Stack items contain stable Yjs IDs/DeleteSets, not live document references.
      undo.undoStack=structuredClone(this.undo.undoStack);undo.redoStack=structuredClone(this.undo.redoStack);
      const stack=direction==='undo'?'undoStack':'redoStack',source=undo[stack].slice(),updates=[];
      const capture=update=>updates.push(update);trial.on('update',capture);
      try{undo[direction]();}finally{trial.off('update',capture);}
      const document=this.validateState(trial,{budget});
      if(updates.length){
        // Trial/live GC and struct merging can differ by a few header bytes.
        // Bound from the complete pre-state plus actual restored payloads and
        // every affected clock, rather than treating trial length as exact live
        // length. Conservative rejection near capacity happens before mutation.
        let affected=0;
        for(const item of source.slice(undo[stack].length))for(const set of [item.insertions,item.deletions])for(const ranges of set.clients.values())for(const range of ranges)affected+=range.len;
        const update=updates.length===1?updates[0]:Y.mergeUpdates(updates),ceiling=scratchMapStateBound(previousBytes,update.byteLength,affected);
        const limit=documentModel.documentLimits(document).stateBytes;
        if(ceiling===null||ceiling>limit)throw Error(`History operation may exceed ${limit/1024/1024} MiB; duplicate the canvas to start fresh history.`);
        budget.bytes=ceiling;
      }else budget.bytes=previousBytes;
    }finally{undo.destroy();trial.destroy();}
    this.undo.stopCapturing();this.publishingCeiling=budget.bytes;
    try{this.undo[direction]();}finally{this.publishingCeiling=undefined;this.undo.stopCapturing();}
    // Only the live encoding is exact: cloned histories may merge structs into
    // fewer headers even when their logical document and client IDs match.
    this.cachedState=Y.encodeStateAsUpdate(this.ydoc);this.encodedStateCeiling=this.cachedState.byteLength;
  }
  onUpdate(fn) { this.ydoc.on('update', fn); return () => this.ydoc.off('update', fn); }
  destroy() { this.rejectValidation();this.undo.destroy(); this.ydoc.destroy(); }
}
