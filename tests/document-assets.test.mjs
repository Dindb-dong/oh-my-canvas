import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {build} from 'esbuild';
import {Store,decodeFile} from '../core/storage.mjs';
import {assetRef,hashAsset} from '../core/assets.mjs';
import {persistDesignImport,portableAssetDocument,assetResponse} from '../electron/document-assets.mjs';
import {createDocumentManager} from '../electron/document-manager.mjs';
import {createWorkspaceTools} from '../electron/workspace-tools.mjs';
import {documentFixture} from './helpers.mjs';

let formats;
test.before(async()=>{
  const result=await build({entryPoints:['src/document-factories.ts'],bundle:true,platform:'node',format:'esm',write:false,logLevel:'silent'});
  formats=await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].contents).toString('base64')}`);
});
async function fixture(t){
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'omc-asset-boundary-')),store=new Store(path.join(directory,'profile'));
  const cleanup=[];
  t.after(async()=>{for(const dispose of cleanup)await dispose();await store.flushPreviews();await fs.rm(directory,{recursive:true,force:true});});
  const bytes=Buffer.from('verified synthetic bitmap bytes'),hash=hashAsset(bytes),document=documentFixture();
  document.assets={bitmap:{id:'bitmap',kind:'image',src:assetRef(hash)}};
  return {directory,store,cleanup,bytes,hash,document,result:{document,warnings:[],blobs:[{hash,mimeType:'image/png',bytes}]}};
}
test('worker bytes are verified and durable before their referenced document is returned',async t=>{
  const f=await fixture(t);let release;
  const put=f.store.assets.put.bind(f.store.assets);
  f.store.assets.put=async(...args)=>{await new Promise(resolve=>{release=resolve;});return put(...args);};
  let published=false;const pending=persistDesignImport(f.result,f.store).then(result=>{published=true;return result;});
  await new Promise(resolve=>setImmediate(resolve));assert.equal(published,false);release();
  const ready=await pending;assert.equal(ready.blobs,undefined);assert.equal(ready.document.assets.bitmap.src,assetRef(f.hash));
  f.store.assets.put=put;
  assert.deepEqual((await f.store.assets.get(f.hash)).bytes,f.bytes);
  await assert.rejects(persistDesignImport({...f.result,blobs:[{...f.result.blobs[0],bytes:Buffer.from('corrupt')}]},f.store),/SHA-256/);
  const missing=structuredClone(f.document);missing.assets.bitmap.src=assetRef('f'.repeat(64));
  await assert.rejects(persistDesignImport({document:missing,warnings:[],blobs:[]},f.store),/ENOENT/);
});
test('immutable image route preserves MIME and refuses missing, malformed, or corrupt content',async t=>{
  const f=await fixture(t);await persistDesignImport(f.result,f.store);
  const response=await assetResponse(f.store.assets,f.hash);
  assert.equal(response.status,200);assert.equal(response.headers.get('content-type'),'image/png');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()),f.bytes);
  assert.equal((await assetResponse(f.store.assets,'../private')).status,404);
  assert.equal((await assetResponse(f.store.assets,'a'.repeat(64))).status,404);
  await fs.writeFile(f.store.assets.file(f.hash),'corrupt');
  assert.equal((await assetResponse(f.store.assets,f.hash)).status,422);
});
test('native portable JSON uses original bytes once without mutating the working document',async t=>{
  const f=await fixture(t);await persistDesignImport(f.result,f.store);
  let reads=0;const get=f.store.assets.get.bind(f.store.assets);f.store.assets.get=async hash=>{reads++;return get(hash);};
  const portable=await portableAssetDocument(f.document,f.store.assets,formats.portableDocument);
  const json=formats.exportCanvasJson(portable),reopened=formats.importCanvasJson(json);
  assert.equal(reads,1);assert.equal(reopened.assets.bitmap.src,`data:image/png;base64,${f.bytes.toString('base64')}`);
  assert.equal(f.document.assets.bitmap.src,assetRef(f.hash));assert.ok(!JSON.stringify(json).includes('omc-asset:'));
  await assert.rejects(portableAssetDocument(f.document,f.store.assets,formats.portableDocument,{maxBytes:1}),/byte limit/);
  await assert.rejects(portableAssetDocument(f.document,f.store.assets,formats.portableDocument,{signal:AbortSignal.abort(Error('cancelled'))}),/cancelled/);
});
test('workspace portable export and copy import preserve image dependencies across profiles',async t=>{
  const f=await fixture(t);await persistDesignImport(f.result,f.store);
  let manager;manager=createDocumentManager({store:f.store,createRuntime(entry){queueMicrotask(()=>manager.ready(entry,entry.generation));return {};},async disposeRuntime(){},async flushRuntime(){}});
  f.cleanup.push(()=>manager.disposeAll());
  const invoke=createWorkspaceTools({manager,store:f.store,profile:f.store.dir,...formats,runtimeRequest:async()=>({}),checkBusy:async()=>{},context:async()=>({})});
  const entry=await manager.create('Image document',f.document);
  const exported=await invoke({name:'export_document',agent:'test',args:{id:entry.record.id,format:'omc'}});
  const record=decodeFile(Buffer.from(exported.data,'base64').toString());t.after(()=>record.replica.destroy());
  assert.deepEqual(record.assets.get(f.hash).bytes,f.bytes);
  const targetStore=new Store(path.join(f.directory,'other-profile'));await targetStore.importAssets(record);
  assert.deepEqual((await targetStore.assets.get(f.hash)).bytes,f.bytes);
  const copied=await invoke({name:'import_document',agent:'test',args:{format:'omc',mode:'copy',payload:Buffer.from(exported.data,'base64').toString()}});
  assert.notEqual(copied.documentId,entry.record.id);
  assert.equal(manager.entries.get(copied.documentId).record.replica.document.assets.bitmap.src,assetRef(f.hash));
});
