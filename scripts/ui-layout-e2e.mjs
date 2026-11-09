import {documentPage,libraryPage} from './desktop-test-pages.mjs';
// Real renderer geometry across the app shell, editor, menus and dialogs.
import {_electron} from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const exec=promisify(execFile);
const root=path.resolve(import.meta.dirname,'..'),out=path.join(root,'docs/qa/ui-layout');
await fs.mkdir(out,{recursive:true});
const profile=await fs.mkdtemp(path.join(os.tmpdir(),'omc-ui-layout-'));
const results=[],errors=[];let app,page;
async function measure(name){
 await page.evaluate(()=>document.fonts.ready);
 const nativeBounds=await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].getContentBounds());
 const data=await page.evaluate(()=>{
  const failures=[],controls=[];
  const rendered=e=>{const b=e.getBoundingClientRect(),s=getComputedStyle(e);return b.width&&b.height&&s.visibility!=='hidden'&&s.display!=='none'&&!e.closest('[hidden]');};
  const visible=e=>{const b=e.getBoundingClientRect();return rendered(e)&&b.right>0&&b.bottom>0&&b.left<innerWidth&&b.top<innerHeight;};
  for(const button of document.querySelectorAll('button')){
   if(!visible(button))continue;
   const icon=button.querySelector(':scope > svg.ui-icon,:scope > [data-icon] > svg.ui-icon');
   if(!icon)continue;
   const b=button.getBoundingClientRect(),i=icon.getBoundingClientRect(),label=button.getAttribute('aria-label')||button.title||button.textContent.trim(),issues=[];
   // Ignore offscreen content inside intentionally scrollable inspector/library panels.
   if(i.left<b.left-.5||i.right>b.right+.5||i.top<b.top-.5||i.bottom>b.bottom+.5)issues.push('icon outside button');
   if(Math.abs((i.top+i.bottom-b.top-b.bottom)/2)>1.5)issues.push('icon not vertically centered');
   const text=button.querySelector(':scope > .menu-label')||[...button.childNodes].find(n=>n.nodeType===Node.TEXT_NODE&&n.textContent.trim());
   if(text){const r=document.createRange();r.selectNodeContents(text);const t=r.getBoundingClientRect();if(t.width){const gap=t.left>=i.right-.5?t.left-i.right:i.left-t.right;if(gap<4||gap>14)issues.push('icon/label gap '+gap.toFixed(2));if(Math.abs((t.top+t.bottom-i.top-i.bottom)/2)>2)issues.push('icon/label baseline');}}
   const item={label,issues};controls.push(item);if(issues.length)failures.push(item);
  }
  for(const selector of ['#topbar','.workspace-header','#tools','.find-bar','.context-menu','dialog[open]']){
   for(const e of document.querySelectorAll(selector))if(visible(e)){
    const b=e.getBoundingClientRect();if(b.left<-.5||b.right>innerWidth+.5)failures.push({label:selector,issues:['surface outside viewport']});
    for(const button of e.querySelectorAll('button'))if(rendered(button)){
     const c=button.getBoundingClientRect();if(c.left<b.left-.5||c.right>b.right+.5)failures.push({label:button.getAttribute('aria-label')||button.textContent.trim(),issues:['control outside '+selector]});
    }
   }
  }
  for(const subtitle of document.querySelectorAll('.file-name small'))if(visible(subtitle)){const range=document.createRange();range.selectNodeContents(subtitle);if(range.getClientRects().length>1)failures.push({label:'Workspace subtitle',issues:['header label wraps']});}
  for(const check of document.querySelectorAll('.check'))if(visible(check)){
   const input=check.querySelector('input[type=checkbox]');if(!input)continue;
   const nodes=[...check.childNodes].filter(n=>n.nodeType===Node.TEXT_NODE&&n.textContent.trim());if(nodes.length){const r=document.createRange();r.selectNodeContents(nodes[0]);const t=r.getBoundingClientRect(),b=input.getBoundingClientRect();if(Math.abs((t.top+t.bottom-b.top-b.bottom)/2)>2)failures.push({label:check.textContent.trim(),issues:['checkbox/label alignment']});}
  }
  return {viewport:{width:innerWidth,height:innerHeight,dpr:devicePixelRatio},controls:controls.length,failures};
 });
 results.push({name,nativeBounds,...data});
 const originalConfig=await page.locator('#mcp-config').count()?await page.locator('#mcp-config').inputValue():null;
 if(originalConfig!==null)await page.evaluate(()=>{document.querySelector('#mcp-config').value='[Local MCP configuration redacted for screenshot privacy]';});
 await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
 try{
  if(process.platform==='darwin'){const id=await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].getMediaSourceId().split(':')[1]);await exec('screencapture',['-x','-o','-l',id,path.join(out,name+'.png')]);}
  else await page.screenshot({path:path.join(out,name+'.png')});
 }finally{if(originalConfig!==null)await page.evaluate(value=>document.querySelector('#mcp-config').value=value,originalConfig);}
 console.log(JSON.stringify({name,...data}));
}
async function close(){const dialogs=page.locator('dialog[open]');while(await dialogs.count()){await page.keyboard.press('Escape');await page.waitForTimeout(30);}}
async function ready(){await page.waitForFunction(()=>!!window.lvMcp&&!document.querySelector('#editor').inert);}
async function select(type){const s=await page.evaluate(()=>window.omc.invoke('snapshot'));const shape=Object.values(s.document.pagesById[s.document.pages[0]].objects).find(x=>x.type===type&&x.id!=='root');assert(shape,'Fixture shape '+type);await page.locator(`#editor .row[data-id="${shape.id}"] .name`).click();await page.locator('#right').evaluate(e=>e.scrollTop=0);}
try{
 app=await _electron.launch({env:{...process.env,OMC_TEST_BACKGROUND:'1'},args:[root,`--profile=${profile}`]});page=await app.firstWindow();page.setDefaultTimeout(10000);page.on('pageerror',e=>errors.push(e.message));await page.locator('#new').waitFor();await page.evaluate(()=>window.omc.invoke('preferences',{name:'Demo designer'}));
 for(const [name,width,height,zoom] of [['desktop',1500,980,1],['minimum',960,640,1],['scaled',1200,800,1.25]]){
  await app.evaluate(({BrowserWindow},{width,height,zoom})=>{const w=BrowserWindow.getAllWindows()[0];w.setSize(width,height,false);w.webContents.setZoomFactor(zoom);},{width,height,zoom});await page.waitForFunction(({width,height,zoom})=>Math.abs(innerWidth-width/zoom)<2&&Math.abs(innerHeight-height/zoom)<2,{width,height,zoom});
  await measure(name+'-library-empty');
  for(const [id,label] of [['mcp','mcp'],['collaborate','collaborate']]){await page.locator('#'+id).click();await page.locator('#dialog[open]').waitFor();await measure(name+'-'+label+'-dialog');if(id==='collaborate')await measure(name+'-join-dialog');await close();}
  await page.locator('#start-sample').click();page=await documentPage(app);await app.evaluate(({webContents},{url,zoom})=>webContents.getAllWebContents().find(c=>c.getURL()===url).setZoomFactor(zoom),{url:page.url(),zoom});await ready();
  await measure(name+'-editor');
  for(const type of ['rect','text','frame']){await select(type);await measure(name+'-inspector-'+type);for(const [part,fraction] of [['middle',.5],['bottom',1]]){await page.locator('#right').evaluate((e,f)=>e.scrollTop=(e.scrollHeight-e.clientHeight)*f,fraction);await measure(name+'-inspector-'+type+'-'+part);}if(type==='text'){await page.locator('#right').getByRole('button',{name:'Choose font family',exact:true}).click();await measure(name+'-font-dialog');await close();}}
  await page.locator('#document-title').click();await page.locator('#title-input').fill('A long canvas title for checking toolbar spacing with four participants — Design system components and variants');await page.locator('#title-input').press('Enter');
  await app.evaluate(({webContents},{url,message})=>webContents.getAllWebContents().find(c=>c.getURL()===url).send('omc:event',message),{url:page.url(),message:{type:'session',status:{mode:'host',peers:[{id:'a',name:'Alice',host:true},{id:'b',name:'Ben'},{id:'c',name:'Cora'},{id:'d',name:'Dee'}]}}});await page.locator('#peers .avatar').last().waitFor();await measure(name+'-long-title-four-peers');
  await app.evaluate(({webContents},{url,message})=>webContents.getAllWebContents().find(c=>c.getURL()===url).send('omc:event',message),{url:page.url(),message:{type:'session',status:{mode:'offline',peers:[]}}});
  await page.locator('#editor #stage').click({button:'right',position:{x:30,y:30}});await measure(name+'-context-menu');await page.keyboard.press('Escape');
  await page.locator('#editor .workspace-header').getByRole('button',{name:'Find layers',exact:true}).click();await measure(name+'-find');await page.locator('.find-bar').getByRole('button',{name:'Close find',exact:true}).click();
  for(const group of ['2','3']){await page.locator(`#editor [data-group="${group}"] button[aria-label="More drawing tools"]`).click();await measure(name+'-tools-'+group);await page.keyboard.press('Escape');}
  await page.keyboard.press('Meta+Alt+K');await page.locator('#editor .ltabs').getByRole('button',{name:'Assets',exact:true}).click();await measure(name+'-assets');
  await page.locator('#editor').getByRole('button',{name:'+ Style',exact:true}).click();await measure(name+'-style-dialog');await close();
  await page.locator('#editor .workspace-header').getByRole('button',{name:'Quick actions',exact:true}).click();await measure(name+'-commands-dialog');await close();
  await page.locator('#topbar #export').click();await measure(name+'-export-dialog');await close();
  await page.locator('#home').click();page=await libraryPage(app);await page.locator('[data-open]').first().waitFor();await measure(name+'-library-populated');await page.locator('#view-list').click();await measure(name+'-library-list');await page.locator('#view-grid').click();await page.locator('[data-more]').first().click();await measure(name+'-file-actions-dialog');await close();
  // Return to a fresh empty library for the next window size, using only this test's files.
  const docs=await page.evaluate(()=>window.omc.invoke('library'));for(const d of docs)await page.evaluate(id=>window.omc.invoke('delete',{id}),d.id);await page.reload();await page.locator('#start-sample').waitFor();
 }
 const failures=results.flatMap(r=>r.failures.map(f=>({scene:r.name,...f})));await fs.writeFile(path.join(out,'report.json'),JSON.stringify({passed:!failures.length&&!errors.length,scenes:results.length,controlMeasurements:results.reduce((n,r)=>n+r.controls,0),results,errors,scope:'macOS desktop 1500x980, minimum 960x640, 1200x800 at 125% application zoom; synthetic local profiles and four-peer display fixture (not a connection test); native macOS captures avoid zoomed renderer-screenshot cropping; MCP configuration redacted; geometry plus screenshots',failures},null,2)+'\n');assert.deepEqual(errors,[]);assert.equal(failures.length,0,JSON.stringify(failures));
}finally{await app?.close().catch(()=>{});await fs.rm(profile,{recursive:true,force:true});}
