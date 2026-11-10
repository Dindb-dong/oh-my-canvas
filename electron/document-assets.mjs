import {collectAssetRefs,parseAssetRef} from '../core/asset-refs.mjs';
import {MAX_ASSET_BYTES} from '../core/assets.mjs';
import {MAX_DESIGN_EXPANDED_BYTES,MAX_PORTABLE_BYTES} from '../core/capacity.mjs';

// Decode workers transfer raw bitmap buffers. Persist them before any document
// containing their references reaches an editor, a Replica, or a peer.
export async function persistDesignImport(result,store){
  if(!result?.document||!Array.isArray(result.warnings)||!Array.isArray(result.blobs??[]))throw Error('Invalid design import result');
  const blobs=result.blobs??[];
  if(blobs.length>4096)throw Error('Too many design image assets');
  let total=0;
  for(const blob of blobs){
    if(!(blob.bytes instanceof Uint8Array)||blob.bytes.byteLength>MAX_ASSET_BYTES)throw Error('Invalid design image asset');
    total+=blob.bytes.byteLength;
    if(total>MAX_DESIGN_EXPANDED_BYTES)throw Error('Design image assets exceed the decoded byte limit');
    await store.assets.put(blob.bytes,blob.mimeType,{hash:blob.hash});
  }
  const document=await store.prepareDocument(result.document);
  return {document,warnings:result.warnings,...result.timings?{timings:result.timings}:{}};
}

// The main process supplies data URLs to the same portable-document converter
// used by the editor. No FileReader or source bitmap IPC round trip is needed.
export async function portableAssetDocument(document,assets,makePortable,{signal,maxBytes=MAX_PORTABLE_BYTES}={}){
  signal?.throwIfAborted();
  const hashes=collectAssetRefs(document);
  if(!hashes.size)return document;
  if(typeof makePortable!=='function')throw Error('Portable image converter is unavailable');
  const sources=new Map();let remaining=maxBytes;
  for(const hash of hashes){
    signal?.throwIfAborted();
    const asset=await assets.get(hash);
    remaining-=asset.byteLength;
    if(remaining<0)throw Error('Image export exceeds the byte limit');
    sources.set(hash,`data:${asset.mimeType};base64,${Buffer.from(asset.bytes).toString('base64')}`);
  }
  return makePortable(document,source=>{const hash=parseAssetRef(source);return hash?sources.get(hash)??source:source;},{signal,maxBytes});
}

export async function assetResponse(assets,hash){
  if(!/^[a-f0-9]{64}$/.test(hash))return new Response('Not found',{status:404});
  try{
    const asset=await assets.get(hash);
    return new Response(asset.bytes,{headers:{'Content-Type':asset.mimeType,'Content-Length':String(asset.byteLength),'Cache-Control':'private, max-age=31536000, immutable','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'"}});
  }catch(error){return new Response(error.code==='ENOENT'?'Not found':'Image asset could not be verified',{status:error.code==='ENOENT'?404:422});}
}
