import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {JSDOM} from 'jsdom';

test('background workspace updates refresh stale library metadata and preserve keyboard focus',async()=>{
  const dom=new JSDOM(await readFile(new URL('../index.html',import.meta.url),'utf8'),{url:'omc://canvas/index.html',runScripts:'outside-only'}),window=dom.window;
  const source=(await readFile(new URL('../src/main.js',import.meta.url),'utf8')).replace(/^import .*;\n/gm,'');
  const item=title=>({id:'doc-a',title,updatedAt:'2026-11-09T00:00:00Z'}),tick=()=>new Promise(resolve=>setTimeout(resolve,0));
  let listener,release,delayed=false,title='Old title',calls=0;
  window.icon=()=>'';window.omc={on:fn=>listener=fn,invoke:async action=>{
    if(action==='preferences')return {};
    if(action==='workspace')return {tabs:[],activeTabId:null};
    if(action==='library'){calls++;if(delayed){delayed=false;return new Promise(resolve=>release=resolve);}return [item(title)];}
  }};
  try{
    await window.eval('(async()=>{'+source+'})()');
    delayed=true;listener({type:'library-changed'});await tick();const before=calls;
    title='Saved new title';listener({type:'library-changed'});release([item('Old title')]);await tick();
    assert.equal(calls,before+1);assert.equal(window.document.querySelector('h3').textContent,title);
    const state={type:'workspace',tabs:[{id:'doc-a',title,inUse:true}],activeTabId:null};
    window.document.querySelector('#tab-library').focus();listener(state);
    assert.equal(window.document.activeElement.id,'tab-library');
    window.document.querySelector('[data-close-tab="doc-a"]').focus();listener({...state,tabs:[]});
    assert.equal(window.document.activeElement.id,'tab-library');
    window.document.querySelector('#search').focus();listener(state);
    assert.equal(window.document.activeElement.id,'search');await tick();
  }finally{window.close();}
});
