import * as Y from 'yjs';
import { flatten, materialize, assertDocument,MAX_STATE_BYTES } from './document.mjs';
export class Replica {
  constructor({ state, document } = {}) {
    this.ydoc = new Y.Doc();
    this.fields = this.ydoc.getMap('fields');
    this.local = Symbol('local');
    this.validationDoc=null;this.cachedDocument=undefined;this.cachedState=undefined;
    this.ydoc.on('update',update=>{
      this.cachedDocument=this.publishingDocument;this.cachedState=undefined;
      if(this.validationDoc)Y.applyUpdate(this.validationDoc,update,'mirror');
    });
    if (state) {if(state.byteLength>MAX_STATE_BYTES)throw Error('CRDT history exceeds 16 MiB');Y.applyUpdate(this.ydoc, state, 'load');}
    else if (document) this.ydoc.transact(() => { for (const [k,v] of flatten(assertDocument(document))) this.fields.set(k,v); }, 'seed');
    this.undo = new Y.UndoManager(this.fields, { trackedOrigins: new Set([this.local]), captureTimeout: Infinity });
    if(state||document)this.validateState(this.ydoc);
  }
  get document() { return this.cachedDocument??=assertDocument(materialize(this.fields)); }
  get state() { return this.cachedState??=Y.encodeStateAsUpdate(this.ydoc); }
  validateState(doc){
    const document=assertDocument(materialize(doc.getMap('fields')));
    if(Y.encodeStateAsUpdate(doc).byteLength>MAX_STATE_BYTES)throw Error('Document and history exceed 16 MiB. Duplicate the canvas to start a fresh history, or use smaller images.');
    return document;
  }
  trial(){const trial=new Y.Doc({gc:false});Y.applyUpdate(trial,this.state);return trial;}
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
  patch(changes, label, group, {recordHistory=true} = {}) {
    if (!Array.isArray(changes) || changes.length > 300000) throw Error('Invalid patch');
    // Reuse a synchronized speculative document. Rejected candidates are discarded,
    // and only a validated incremental update is published to the live replica.
    const writes=[...this.recoveryFields(),...changes],trial=this.validator();
    const vector=Y.encodeStateVector(this.ydoc);
    let document,update;
    try{
      this.speculatingLocal=recordHistory;
      try{trial.transact(()=>{for(const [k,v] of writes){JSON.parse(k);trial.getMap('fields').set(k,v);}});}finally{this.speculatingLocal=false;}
      document=this.validateState(trial);update=Y.encodeStateAsUpdate(trial,vector);
    }catch(e){this.rejectValidation();throw e;}
    const top=this.undo.undoStack.at(-1);
    if(recordHistory&&(!group||top?.meta.get('group')!==group||top?.meta.get('label')!==label))this.undo.stopCapturing();
    this.publishingDocument=document;
    try{Y.applyUpdate(this.ydoc,update,recordHistory?this.local:'bootstrap');}finally{this.publishingDocument=undefined;}
    this.cachedDocument=document;
    const entry=this.undo.undoStack.at(-1);
    if(recordHistory&&entry){entry.meta.set('label',label);entry.meta.set('group',group);}
  }
  receive(update) {
    if (!(update instanceof Uint8Array) || update.byteLength > MAX_STATE_BYTES) throw Error('Update exceeds 16 MiB');
    const trial=this.validator();let document;
    try{Y.applyUpdate(trial,update);document=this.validateState(trial);}
    catch(e){this.rejectValidation();throw e;}
    this.publishingDocument=document;
    try{Y.applyUpdate(this.ydoc,update,'remote');}finally{this.publishingDocument=undefined;}
    this.cachedDocument=document;
  }
  history(direction){
    if(!['undo','redo'].includes(direction))throw Error('Invalid history action');
    const trial=this.trial(),undo=new Y.UndoManager(trial.getMap('fields'),{captureTimeout:0});
    try{
      // Stack items contain stable Yjs IDs/DeleteSets, not live document references.
      undo.undoStack=structuredClone(this.undo.undoStack);undo.redoStack=structuredClone(this.undo.redoStack);
      undo[direction]();this.validateState(trial);
    }finally{undo.destroy();trial.destroy();}
    this.undo.stopCapturing();this.undo[direction]();this.undo.stopCapturing();
  }
  onUpdate(fn) { this.ydoc.on('update', fn); return () => this.ydoc.off('update', fn); }
  destroy() { this.rejectValidation();this.undo.destroy(); this.ydoc.destroy(); }
}
