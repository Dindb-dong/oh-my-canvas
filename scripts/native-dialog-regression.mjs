import {documentPage,libraryPage} from './desktop-test-pages.mjs';
// Real macOS dialogs and native window capture: Playwright page screenshots omit native sheet dimming.
import {_electron} from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const exec=promisify(execFile),root=path.resolve(import.meta.dirname,'..');
if(process.platform!=='darwin')throw Error('This regression requires macOS native dialogs');
const out=path.join(root,'docs/qa/native-dialogs');await fs.mkdir(out,{recursive:true});
const profile=await fs.mkdtemp(path.join(os.tmpdir(),'omc-native-regression-'));
let app;const rows=[];
const wait=async fn=>{for(let i=0;i<200;i++){if(await fn())return;await new Promise(r=>setTimeout(r,75));}throw Error('Native dialog wait timed out');};
try{
 app=await _electron.launch({env:{...process.env,OMC_TEST_BACKGROUND:'1'},args:[root,`--profile=${profile}`]});
 await app.evaluate(({app})=>app.setAccessibilitySupportEnabled(true));
 let page=await app.firstWindow();await page.locator('#start-sample').click();page=await documentPage(app);await page.waitForFunction(()=>!!window.lvMcp&&!document.querySelector('#editor').inert);
 const info=await app.evaluate(({BrowserWindow})=>({pid:process.pid,id:BrowserWindow.getAllWindows()[0].getMediaSourceId().split(':')[1]}));
 await app.evaluate(({dialog})=>{globalThis.nativeCalls=[];globalThis.nativePending=0;for(const key of ['showOpenDialog','showSaveDialog']){const original=dialog[key].bind(dialog);dialog[key]=async(...args)=>{globalThis.nativeCalls.push({key,parentAttached:args.length!==1});globalThis.nativePending++;try{return await original(...args);}finally{globalThis.nativePending--;}}}});
 async function snapshot(label){
   const native=await app.evaluate(({BrowserWindow})=>({enabled:BrowserWindow.getAllWindows()[0].isEnabled(),opacity:BrowserWindow.getAllWindows()[0].getOpacity(),calls:globalThis.nativeCalls}));
   const file=path.join(out,label+'.png');await exec('screencapture',['-x','-o','-l',info.id,file]);
   const pixels=await page.evaluate(async b64=>{const im=await createImageBitmap(new Blob([Uint8Array.from(atob(b64),c=>c.charCodeAt(0))],{type:'image/png'}));const c=new OffscreenCanvas(im.width,im.height),ctx=c.getContext('2d');ctx.drawImage(im,0,0);return [...ctx.getImageData(im.width-20,Math.floor(im.height/2),1,1).data];},(await fs.readFile(file)).toString('base64'));
   rows.push({label,...native,pixels});assert.equal(native.enabled,true,label+' disabled canvas');assert.deepEqual(pixels,[255,255,255,255],label+' gray native veil');assert.ok(native.calls.every(c=>!c.parentAttached),'A parent-attached native sheet returned');
 }
 async function cancel(){
  await exec('osascript',['-e',`on run argv\ntell application "System Events"\nset proc to first application process whose unix id is (item 1 of argv as integer)\ntell proc\nset frontmost to true\ndelay 0.3\nrepeat with w in windows\nset flat to entire contents of w\nrepeat with i from (count of flat) to 1 by -1\nset e to item i of flat\ntry\nif (name of e is "Cancel") or (name of e is "취소") then\nperform action "AXPress" of e\nreturn "Canceled native panel"\nend if\nend try\nend repeat\nend repeat\nerror "Native Cancel button not found"\nend tell\nend tell\nend run`,String(info.pid)],{timeout:20000});
  await wait(()=>app.evaluate(()=>globalThis.nativePending===0));
 }
 await snapshot('before');
 // A renderer-owned input produced enabled=false / RGB204 even after reload before the fix.
 await page.locator('#stage').click({position:{x:30,y:30}});await page.keyboard.press('Meta+Shift+K');
 await wait(()=>app.evaluate(()=>globalThis.nativePending===1));await snapshot('asset-picker-open');
 await page.reload();page=await documentPage(app);await snapshot('asset-picker-after-reload');await cancel();await snapshot('after-cancel');
 // Repeated app import cancel must also leave the renderer usable and white.
 page=await libraryPage(app);for(let i=0;i<2;i++){await page.locator('#import').click();await wait(()=>app.evaluate(()=>globalThis.nativePending===1));await snapshot('import-open-'+i);await cancel();await page.locator('#import').waitFor();await snapshot('import-cancel-'+i);}
 await page.locator('#new').click();page=await documentPage(app);await page.waitForFunction(()=>!!window.lvMcp&&!document.querySelector('#editor').inert);await snapshot('usable-canvas');
 await fs.writeFile(path.join(out,'report.json'),JSON.stringify({pass:true,platform:process.platform,rows},null,2)+'\n');console.log('PASS real native asset picker, renderer reload, repeated import cancellation and canvas usability; no gray veil');
}finally{await app?.close().catch(()=>{});await fs.rm(profile,{recursive:true,force:true});}
