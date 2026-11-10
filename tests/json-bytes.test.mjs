import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {jsonPrimitiveBytes,jsonStringBytes} from '../core/json-bytes.mjs';
import {assertDocument,MAX_DOCUMENT_BYTES} from '../core/document.mjs';
import {documentFixture} from './helpers.mjs';

const nativeBytes=value=>{const json=JSON.stringify(value);return json===undefined?undefined:new TextEncoder().encode(json).byteLength;};

test('primitive byte counts match native JSON across floating-point representations and omissions',()=>{
 const values=[null,true,false,undefined,Symbol('omitted'),()=>{},NaN,Infinity,-Infinity,-0,0,1,-1,1e-7,1e-6,1e20,1e21,Number.MIN_VALUE,Number.MAX_VALUE,Number.MAX_SAFE_INTEGER];
 const view=new DataView(new ArrayBuffer(8));let seed=0x12345678;
 const next=()=>seed=(Math.imul(seed,1664525)+1013904223)>>>0;
 for(let i=0;i<4096;i++){view.setUint32(0,next());view.setUint32(4,next());values.push(view.getFloat64(0));}
 for(const value of values)assert.equal(jsonPrimitiveBytes(value),nativeBytes(value));
 assert.throws(()=>jsonPrimitiveBytes(1n),TypeError);
});

test('quoted string bytes retain native Unicode escaping across cache churn and large uncached values',()=>{
 const values=['','"\\\b\f\n\r\t','한글 😀','\ud800','\udfff','\ud800\udfff','\u0000\u001f','\u2028\u2029','x'.repeat(128),'한'.repeat(129),'😀'.repeat(10000)];
 // Cover every UTF-16 code unit, including lone surrogates, and enough unique
 // immutable strings to churn the bounded cache more than once.
 for(let i=0;i<=0xffff;i++)values.push(String.fromCharCode(i));
 for(const value of values)assert.equal(jsonStringBytes(value),nativeBytes(value));
 for(const value of values.slice(0,11))assert.equal(jsonPrimitiveBytes(value),nativeBytes(value));
});

test('repeated short strings and numeric primitives do not allocate a UTF-8 buffer per field',t=>{
 const encode=TextEncoder.prototype.encode;let allocations=0;
 t.mock.method(TextEncoder.prototype,'encode',function(...args){allocations++;return encode.apply(this,args);});
 const key='json-byte-cache-regression-key';
 const expected=jsonStringBytes(key),afterFirst=allocations;
 for(let i=0;i<1000;i++){
  assert.equal(jsonStringBytes(key),expected);assert.equal(jsonPrimitiveBytes(key),expected);
  assert.equal(jsonPrimitiveBytes(i),String(i).length);jsonPrimitiveBytes(null);jsonPrimitiveBytes(true);jsonPrimitiveBytes(false);
 }
 assert.equal(allocations,afterFirst);
});

test('short cache keys detach large string parents without replacing UTF-16 surrogates',()=>{
 const moduleURL=new URL('../core/json-bytes.mjs',import.meta.url).href;
 const child=spawnSync(process.execPath,['--expose-gc','--input-type=module','-e',`
  import assert from 'node:assert/strict';
  import {jsonStringBytes} from ${JSON.stringify(moduleURL)};
  const native=value=>new TextEncoder().encode(JSON.stringify(value)).byteLength;
  const heap=()=>{global.gc();return process.memoryUsage().heapUsed;};
  const before=heap();
  const admit=index=>{
   const parent=('slice-'+index+'\\ud800\\udfff\\ud800\\udfff\\ud800').padEnd(64,'p')+'x'.repeat(2*1024*1024);
   const key=parent.slice(0,64);
   assert.equal(jsonStringBytes(key),native(key));
  };
  for(let index=0;index<8;index++)admit(index);
  const retainedBytes=heap()-before;
  const lone='cache-key-\\ud800',replacement='cache-key-\\ufffd';
  assert.equal(jsonStringBytes(lone),native(lone));
  assert.equal(jsonStringBytes(replacement),native(replacement));
  assert.equal(jsonStringBytes(lone),native(lone));
  console.log(JSON.stringify({retainedBytes}));
 `],{encoding:'utf8',timeout:15000});
 assert.equal(child.status,0,child.stderr||String(child.error??''));
 const {retainedBytes}=JSON.parse(child.stdout);
 // An isolated, explicit-GC child avoids shared test heap noise. Retaining all
 // eight two-byte parents costs about 32 MiB; allow 4 MiB of runtime variation.
 assert.ok(retainedBytes<4*1024*1024,`Short cache entries retained ${retainedBytes} bytes of parent strings`);
});

test('full document validation still enforces the exact byte boundary after mutable and custom-serializer edits',()=>{
 const doc=documentFixture();doc.notes='';
 let payload='한글 😀 \ud800 "\\\n';
 const custom={toJSON(key){return {key,payload};}};
 doc.extra={['escaped "\\\n']:custom,array:[undefined,NaN,Infinity,-0,null,true,false],omitted:undefined};
 doc.notes='x'.repeat(MAX_DOCUMENT_BYTES-nativeBytes(doc));
 assert.equal(nativeBytes(doc),MAX_DOCUMENT_BYTES);assert.doesNotThrow(()=>assertDocument(doc));
 payload+='x';assert.equal(nativeBytes(doc),MAX_DOCUMENT_BYTES+1);assert.throws(()=>assertDocument(doc),/16 MiB/);
 doc.notes='short';assert.doesNotThrow(()=>assertDocument(doc));
 doc.extra.loop=doc.extra;assert.throws(()=>assertDocument(doc),/Cyclic/);
});
