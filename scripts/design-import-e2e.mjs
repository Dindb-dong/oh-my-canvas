import {_electron as electron} from 'playwright';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {figFixture,sketchFixture} from '../editor/__tests__/fixtures/design-files.ts';
import {documentPage} from './desktop-test-pages.mjs';
import {readDesignFile} from '../electron/design-import.mjs';
const primary=execFileSync('git',['worktree','list','--porcelain'],{encoding:'utf8'}).split('\n').find(l=>l.startsWith('worktree ')).slice(9);
const evidence=path.join(primary,'internal/docs/design-file-import');
execFileSync('git',['check-ignore',evidence],{cwd:primary});await fs.mkdir(evidence,{recursive:true});
const profile=await fs.mkdtemp(path.join(os.tmpdir(),'omc-design-import-'));
let app;const errors=[];
try{
  const fig=path.join(profile,'fixture.fig'),sketch=path.join(profile,'fixture.sketch');
  await fs.writeFile(fig,figFixture(true).zip);await fs.writeFile(sketch,sketchFixture());
  await assert.rejects(readDesignFile(new Uint8Array([1]),'fig'),/Figma/);
  app=await electron.launch({args:[process.cwd(),`--profile=${profile}`,'--mcp-port=0'],env:{...process.env,OMC_TEST_BACKGROUND:'1'},timeout:30000});
  const shell=await app.firstWindow();shell.on('pageerror',e=>errors.push(e.message));await shell.locator('#import').waitFor();
  for(const file of [fig,sketch]){
    await app.evaluate(({dialog},file)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]});},file);
    const previous=(await shell.evaluate(()=>window.omc.invoke('workspace'))).activeTabId;
    await shell.evaluate(()=>window.omc.invoke('show-library'));await shell.locator('#import').click();
    let page;const deadline=Date.now()+30000;
    while(Date.now()<deadline){const state=await shell.evaluate(()=>window.omc.invoke('workspace'));if(state.activeTabId&&state.activeTabId!==previous){page=await documentPage(app,state.activeTabId);break;}await new Promise(r=>setTimeout(r,50));}
    assert.ok(page);await page.evaluate(()=>window.omc.invoke('flush'));
    const snapshot=await page.evaluate(()=>window.omc.invoke('snapshot'));
    assert.equal(snapshot.document.pages.length,file===fig?1:2);
    assert.ok(Object.values(snapshot.document.pagesById[snapshot.document.pages[0]].objects).some(s=>s.name==='Title'));
    await page.screenshot({path:path.join(evidence,file===fig?'fig-import.png':'sketch-import.png')});
    const before=Object.keys(snapshot.document.pagesById[snapshot.document.pages[0]].objects).length;
    const drop=await fs.readFile(fig);
    await page.locator('#editor main').evaluate((stage,data)=>{const dt=new DataTransfer();dt.items.add(new File([new Uint8Array(data)],'placed.fig'));const box=stage.getBoundingClientRect();stage.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:dt,clientX:box.x+100,clientY:box.y+100}));},Array.from(drop));
    const placedDeadline=Date.now()+15000;let placed;
    while(Date.now()<placedDeadline){await page.evaluate(()=>window.omc.invoke('flush'));placed=await page.evaluate(()=>window.omc.invoke('snapshot'));if(Object.keys(placed.document.pagesById[placed.document.pages[0]].objects).length>before)break;await new Promise(r=>setTimeout(r,50));}
    assert.ok(Object.keys(placed.document.pagesById[placed.document.pages[0]].objects).length>before,'Drop must insert editable layers');
    console.log('PASS native '+path.extname(file)+' import and Figma drop through worker/IPC under renderer CSP');
  }
  assert.deepEqual(errors,[]);await fs.writeFile(path.join(evidence,'runtime-result.json'),JSON.stringify({passed:true,errors},null,2));
}finally{if(app)await app.close();await fs.rm(profile,{recursive:true,force:true});}
