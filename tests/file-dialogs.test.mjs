import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createFileDialogs} from '../electron/file-dialogs.mjs';

test('file dialogs are application-modal, single-flight and release cancellation/error ownership',async()=>{
  let finish, args;
  const dialogs=createFileDialogs({showOpenDialog:(...a)=>{args=a;return new Promise(resolve=>finish=resolve);},showSaveDialog:async()=>{throw Error('Native error');}});
  const first=dialogs.open({title:'Open'});
  assert.deepEqual(args,[{title:'Open'}]); // Passing a parent reintroduces the native gray sheet.
  await assert.rejects(dialogs.save({}),/Finish or cancel/);
  finish({canceled:true,filePaths:[]});await first;
  await assert.rejects(dialogs.save({}),/Native error/);
  const next=dialogs.pick({kind:'image'});finish({canceled:true});assert.deepEqual(await next,[]);
});

test('desktop picker exposes only user-selected, bounded supported files without native paths',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'omc-picker-test-'));
  try{
    const file=path.join(dir,'image.png');await writeFile(file,Buffer.from([1,2,3]));
    let selection=[file];
    const dialogs=createFileDialogs({showOpenDialog:async()=>({canceled:false,filePaths:selection})});
    assert.deepEqual(await dialogs.pick({kind:'image'}),[{name:'image.png',bytes:Buffer.from([1,2,3])}]);
    await assert.rejects(dialogs.pick({kind:'any'}),/Unsupported/);
    await assert.rejects(dialogs.pick({kind:'image',multiple:'true'}),/Unsupported/);
    selection=[file,file];await assert.rejects(dialogs.pick({kind:'image'}),/at most/);
    selection=[path.join(dir,'private.txt')];await assert.rejects(dialogs.pick({kind:'image'}),/Unsupported/);
    selection=Array(51).fill(file);await assert.rejects(dialogs.pick({kind:'assets',multiple:true}),/at most/);
    selection=[file];await writeFile(file,Buffer.alloc(32*1024*1024+1));await assert.rejects(dialogs.pick({kind:'image'}),/size limit/);
  }finally{await rm(dir,{recursive:true,force:true});}
});


test('design asset picker accepts Figma and Sketch files using binary bytes',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'omc-design-picker-'));
  try{
    const selected=[path.join(dir,'Design.FIG'),path.join(dir,'Design.sketch')];
    for(const file of selected)await writeFile(file,Buffer.from([80,75,3,4]));
    let options;
    const dialogs=createFileDialogs({showOpenDialog:async value=>{options=value;return {canceled:false,filePaths:selected};}});
    const files=await dialogs.pick({kind:'assets',multiple:true});
    assert.equal(files.length,2);assert.ok(options.filters[0].extensions.includes('fig'));assert.ok(options.filters[0].extensions.includes('sketch'));
    assert.deepEqual(files[0].bytes,Buffer.from([80,75,3,4]));
  }finally{await rm(dir,{recursive:true,force:true});}
});
