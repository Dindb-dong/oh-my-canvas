import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import test from 'node:test';
import {normalizeAssetSnapshot,uploadTargets} from './ld06-run.mjs';

test('official upload URL contract pins targets before any binary POST',()=>{
  const url='https://example.invalid/synthetic-test-only';
  // Exact key shape observed from the official tool; no private URL retained.
  assert.deepEqual(uploadTargets({uploads:[{submitUrl:url,targetNodeId:'1:2'}],instructions:'POST bytes'},['1:2']),[url]);
  assert.deepEqual(uploadTargets({uploads:[{uploadUrl:url,targetNodeId:'1:2'}]},['1:2']),[url]);
  assert.throws(()=>uploadTargets({uploads:[{uploadUrl:url,targetNodeId:'other'}]},['1:2']));
  assert.throws(()=>uploadTargets({uploads:[]},['1:2']),/manifest/);
  assert.throws(()=>uploadTargets({uploads:['http://example.invalid']},['1:2']),/Missing official/);
});

test('LD06 derives asset identity and text visibility from actual bytes and native geometry',()=>{
  const bytes=Buffer.from('actual test-only PNG bytes');
  const sha256=createHash('sha256').update(bytes).digest('hex');
  const fixture={assets:[{media_type:'image/png',sha256,rgba_sha256:'registered-decoded-pixels'}],
    font:{sha256:'expected-font-bytes-must-not-be-observed'}};
  const native={document_id:'synthetic-only',nodes:[
    {key:'canvas',parent:null,native_id:'1:2',kind:'frame',bounds:[0,0,500,500]},
    {key:'label',parent:'canvas',native_id:'1:3',kind:'text',bounds:[10,10,100,30],
      render_bounds:[11,12,70,22],text_truncation:'DISABLED',font_family:'Noto Sans KR'},
    {key:'image',parent:'canvas',native_id:'1:4',kind:'image',image_hash:'actual-image-hash'},
  ]};
  const normalized=normalizeAssetSnapshot(native,fixture,new Map([['actual-image-hash',bytes]]));
  assert.equal(normalized.nodes[1].fully_visible,true);
  assert.equal(normalized.nodes[1].font_sha256,undefined);
  assert.equal(normalized.nodes[2].asset_rgba_sha256,'registered-decoded-pixels');
  assert.equal(normalized.nodes[2].stored_sha256,sha256);
  assert.equal(native.nodes[2].asset_rgba_sha256,undefined,'Original readback must remain raw');
  assert.throws(()=>normalizeAssetSnapshot(native,fixture,new Map()),/Missing actual/);
  assert.throws(()=>normalizeAssetSnapshot(native,fixture,new Map([['actual-image-hash',Buffer.from('wrong')]])),/differs/);
  const missingFont=structuredClone(native);missingFont.nodes[1].font_sha256=fixture.font.sha256;
  assert.throws(()=>normalizeAssetSnapshot(missingFont,fixture,new Map()),/must not be inferred/);
  const clipped=structuredClone(native);clipped.nodes[1].render_bounds=[490,12,70,22];
  assert.equal(normalizeAssetSnapshot(clipped,fixture,new Map([['actual-image-hash',bytes]])).nodes[1].fully_visible,false);
});
