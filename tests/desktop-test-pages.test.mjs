import test from 'node:test';
import assert from 'node:assert/strict';
import {documentPage,libraryPage} from '../scripts/desktop-test-pages.mjs';

test('desktop test adapter chooses exact document and current generation, independent of page order',async()=>{
  const makePage=(id,generation)=>({url:()=>`omc://canvas/document.html?documentId=${id}&generation=${generation}`,on(){},waitForFunction:async()=>{}});
  const old=makePage('a',1),other=makePage('b',2),current=makePage('a',3);
  const shell={evaluate:async()=>({tabs:[{id:'a',generation:3},{id:'b',generation:2}],activeTabId:'b'}),emit(){}};
  const app={firstWindow:async()=>shell,context:()=>({pages:()=>[old,other,current]})};
  assert.equal(await documentPage(app,'a'),current);
  assert.equal(await documentPage(app),other);
});

test('desktop test adapter closes only the fixture tabs before returning the shell',async()=>{
  const calls=[],shell={evaluate:async(fn,id)=>{if(id){calls.push(id);return;}if(String(fn).includes("'workspace'"))return {tabs:[{id:'a'},{id:'b'}]};calls.push('library');},locator:()=>({waitFor:async()=>{}})};
  assert.equal(await libraryPage({firstWindow:async()=>shell},{closeTabs:true}),shell);
  assert.deepEqual(calls,['a','b','library']);
});
