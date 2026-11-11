import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createCanvasProtocolHandler} from '../electron/canvas-protocol.mjs';

async function fixture(t){
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'omc-protocol-'));
  t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  await fs.mkdir(path.join(directory,'assets'));
  const reads=[],bytes=new Uint8Array([1,2,3]);
  const handle=createCanvasProtocolHandler({directory,assets:{async get(hash){reads.push(hash);return {bytes,mimeType:'image/png',byteLength:bytes.length};}}});
  return {directory,reads,bytes,handle};
}

test('Vite application assets reach static files instead of the image blob store',async t=>{
  const f=await fixture(t);
  const resources=[
    ['index-Df7qN4aR.js','window.shellLoaded = true;','application/javascript'],
    ['document-runtime-Cp8zB2mK.js','window.runtimeLoaded = true;','application/javascript'],
    ['index-Bk9sL3vX.css','body { color: black; }','text/css'],
    ['a'.repeat(64)+'.js','export const hashNamedBundle = true;','application/javascript'],
  ];
  for(const [name,content,type] of resources){
    await fs.writeFile(path.join(f.directory,'assets',name),content);
    const response=await f.handle({url:`omc://canvas/assets/${name}?v=1`});
    assert.equal(response.status,200,name);
    assert.equal(response.headers.get('content-type'),type);
    assert.equal(await response.text(),content);
    assert.match(response.headers.get('content-security-policy'),/script-src 'self'/);
  }
  assert.deepEqual(f.reads,[]);
});

test('only the exact immutable image path reads the blob store',async t=>{
  const f=await fixture(t),hash='a'.repeat(64);
  const response=await f.handle({url:`omc://canvas/assets/${hash}`});
  assert.equal(response.status,200);
  assert.equal(response.headers.get('content-type'),'image/png');
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()),f.bytes);
  assert.deepEqual(f.reads,[hash]);
  for(const suffix of ['missing.js','a'.repeat(63),hash+'/extra',hash+'.png']){
    assert.equal((await f.handle({url:`omc://canvas/assets/${suffix}`})).status,404);
  }
  assert.equal((await f.handle({url:`omc://other/assets/${hash}`})).status,404);
  assert.deepEqual(f.reads,[hash]);
});
