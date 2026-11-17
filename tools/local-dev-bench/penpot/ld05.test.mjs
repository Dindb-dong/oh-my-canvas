import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

import {decodeLD05,editCycle,hashStoredMedia,normalizeSource,normalizeView,readCycle,seedCycle,sourceSpec} from './ld05.mjs';

const AsyncFunction = Object.getPrototypeOf(async function() {}).constructor;
const file = '11f45678-0001-4001-9001-000000000001';
const generator = fileURLToPath(new URL('../ld05_contract.py',import.meta.url));

function fakePlugin() {
  let counter = 0;
  function shape(type, characters) {
    const data = new Map();
    return {id:String(++counter),type,characters,children:[],layoutChild:{},fills:[],strokes:[],
      resize(width,height) {this.width=width;this.height=height;},
      appendChild(child) {
        const index=root.children.indexOf(child);
        if (index!==-1) root.children.splice(index,1);
        this.children.push(child);
      },
      addFlexLayout() {return this.flex={appendChild:child=>this.appendChild(child)};},
      setPluginData(key,value) {data.set(key,value);},
      getPluginData(key) {return data.get(key);},
    };
  }
  const root = {children:[],appendChild() {throw new Error('Page root may not be reparented');}};
  const images = new Map();
  const penpot = {
    currentPage:{root},currentFile:{id:file},
    createBoard() {
      const board=shape('board');
      root.children.push(board);
      return board;
    },
    createRectangle:()=>shape('rectangle'),createText:value=>shape('text',value),
    uploadMediaData(name,bytes) {
      const id='media-'+ ++counter;
      images.set(id,bytes);
      return {id,width:64,height:36,mtype:'image/png',name};
    },
  };
  return {root,penpot,execute:code=>new AsyncFunction('penpot','storedMedia',
    code.replace('await image.data()','storedMedia.get(image.id)'))(penpot,images)};
}

function observe(fixture,wanted) {
  const baseAsset=fixture.cycles[0].source_state.asset;
  const rgb=hex=>'rgb('+[...Buffer.from(hex.slice(1),'hex')].join(', ')+')';
  return {states:fixture.widths.map(width=>({
    width,afterPress:wanted.keyboard_after,
    cards:wanted.cards.map((label,index)=>{
      const variant = index === wanted.cards.length-1 && wanted.variant;
      return {label,detail:variant?wanted.copy:'Original card detail',variant:variant||'standard',
        src:'./assets/'+(variant?wanted.asset:baseAsset),loaded:true};
    }),
    ...(wanted.field_name?{form:{invalid:{message:wanted.invalid_result},retainedValue:wanted.submitted_value,
      saved:wanted.valid_result+': '+wanted.submitted_value}}:{}),
    ...(wanted.cards.length===fixture.cycles[2].result.cards.length?{conditional:{keyboardShows:true,keyboardHides:true}}:{}),
    styles:{gap:(wanted.gap??12)+'px',radius:(wanted.radius??6)+'px',heading:(wanted.heading_size??20)+'px',
      wrap:wanted.wrap?'wrap':'nowrap',accent:rgb(wanted.accent??'#253357'),
      variantBorder:rgb(wanted.variant_border??'#718096')},
  }))};
}

for (const family of ['route-board','supply-ledger']) {
  test(family+' derives and validates three editable native cycles',async()=>{
    const fixture = JSON.parse(execFileSync('python3',['-B',generator,family],{encoding:'utf-8'}));
    const assets = Object.fromEntries([fixture.cycles[0].source_state.asset,fixture.cycles[2].result.asset].map(name=>{
      const bytes=Buffer.from(name);
      return [name,{name,base64:bytes.toString('base64'),sha256:createHash('sha256').update(bytes).digest('hex')}];
    }));
    const {root,penpot,execute}=fakePlugin();
    for (const [index,step] of fixture.cycles.entries()) {
      const cycle=index+1;
      const projected=sourceSpec(fixture,step.source_state,observe(fixture,step.source_state));
      assert.equal(await execute(seedCycle(file,cycle,projected,assets)),root.children.at(-1).id);
      const before=hashStoredMedia(await execute(readCycle(file,cycle)));
      assert.deepEqual(normalizeView(before,projected,step.source_state,assets),step.source_state);
      assert.equal(await execute(editCycle(file,cycle,step.result,assets[step.result.asset])),before.listId);
      const after=hashStoredMedia(await execute(readCycle(file,cycle)));
      assert.deepEqual(normalizeView(after,projected,step.result,assets),step.result);
      assert.deepEqual(normalizeSource(fixture,step.result,observe(fixture,step.result)),step.result);
      assert.deepEqual(after.cards.map(card=>card.id),before.cards.map(card=>card.id));
      const changed=structuredClone(after);
      changed.cards.at(-1).imageSha256='0'.repeat(64);
      assert.throws(()=>normalizeView(changed,projected,step.result,assets));
    }
    penpot.currentFile.id='outside-target';
    await assert.rejects(execute(readCycle(file,3)),/Wrong isolated/);
  });
}

test('records the failing native operation without leaking endpoint tokens or multiline output',()=>{
  const response={content:[{text:'Tool execution failed: TypeError: root is read-only at https://localhost/mcp?userToken=abc-secret\nstack details'}]};
  assert.throws(()=>decodeLD05(response,'native refresh write','abc-secret'),error=>{
    assert.match(error.message,/native refresh write.*root is read-only at \[url\]/);
    assert.doesNotMatch(error.message,/abc-secret|stack details|https:\/\//);
    return true;
  });
  assert.throws(()=>decodeLD05({content:[{text:`{"error":{"message":"${'a'.repeat(300)}"}}`}]},'readback'),
    error=>error.message.length < 360);
});

test('hashes exact plugin bytes on the host and rejects malformed payloads',()=>{
  const bytes=[0,255,128,1,2];
  const snapshot={cards:[{id:'native',imageBytes:bytes}]};
  assert.deepEqual(hashStoredMedia(snapshot),{cards:[{id:'native',imageSha256:
    createHash('sha256').update(Buffer.from(bytes)).digest('hex')}]});
  for (const invalid of [[],[-1],[256],[0.5],['1'],null]) {
    assert.throws(()=>hashStoredMedia({cards:[{imageBytes:invalid}]}));
  }
  assert.doesNotMatch(readCycle(file,1),/crypto|subtle/);
});
