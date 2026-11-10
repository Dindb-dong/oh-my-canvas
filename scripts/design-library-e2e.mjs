import {_electron as electron} from 'playwright';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {documentPage} from './desktop-test-pages.mjs';
const source=process.argv[2];assert.ok(source&&path.isAbsolute(source),'Supply an absolute .fig path');
const primary=execFileSync('git',['worktree','list','--porcelain'],{encoding:'utf8'}).split('\n').find(l=>l.startsWith('worktree ')).slice(9);
const evidence=path.join(primary,'internal/docs/design-file-import');await fs.mkdir(evidence,{recursive:true});
const profile=await fs.mkdtemp(path.join(os.tmpdir(),'omc-large-design-'));
let app;const result={sourceBytes:(await fs.stat(source)).size,checks:[],pages:[],errors:[]};
async function launch(){app=await electron.launch({args:[process.cwd(),`--profile=${profile}`,'--mcp-port=0'],env:{...process.env,OMC_TEST_BACKGROUND:'1'},timeout:30000});const shell=await app.firstWindow();shell.setDefaultTimeout(120000);shell.on('pageerror',e=>result.errors.push(e.message));await shell.locator('#import').waitFor();return shell;}
async function tool(page,name,args){const t=performance.now();const r=await page.evaluate(async({name,args})=>window.lvMcp.handleToolCall('large-library-eval',name,args),{name,args});assert.ok(!r.isError,JSON.stringify(r));return {ms:performance.now()-t,data:r.structuredContent};}
try{
  let shell=await launch();await app.evaluate(({dialog},file)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]});},source);
  let t=performance.now();await shell.evaluate(()=>window.omc.invoke('import'));result.importMs=performance.now()-t;
  let page=await documentPage(app);page.setDefaultTimeout(120000);
  const meta=await page.evaluate(async()=>{const s=await window.omc.invoke('snapshot');return {id:s.id,pages:s.document.pages.map(id=>({id,name:s.document.pagesById[id].name,count:Object.keys(s.document.pagesById[id].objects).length})),assets:Object.keys(s.document.assets??{}).length};});
  assert.equal(meta.pages.length,46);result.assets=meta.assets;result.layerCount=meta.pages.reduce((n,p)=>n+p.count,0);result.checks.push('All 46 source pages persisted');
  const order=[...meta.pages.filter(p=>['Cover','Buttons','Examples','System','Keyboards','Product Bezels'].includes(p.name)),...meta.pages.filter(p=>!['Cover','Buttons','Examples','System','Keyboards','Product Bezels'].includes(p.name))];
  for(const p of order){const r=await tool(page,'select_page',{id:p.id});const images=await page.locator('#view image').evaluateAll(nodes=>nodes.map(n=>n.getAttribute('href')));result.pages.push({...p,ms:r.ms,imageNodes:images.length,uniqueImages:new Set(images).size});console.log('PASS page '+p.name+' '+Math.round(r.ms)+'ms');if(['Cover','Examples'].includes(p.name)){await page.keyboard.press('Shift+1');await page.screenshot({path:path.join(evidence,'large-'+p.name.toLowerCase()+'.png')});}}
  const cover=meta.pages.find(p=>p.name==='Cover');await tool(page,'select_page',{id:cover.id});
  const renamed=await tool(page,'page',{action:'rename',pageId:cover.id,name:'Cover — import verification'});result.editMs=renamed.ms;result.checks.push('Page rename accepted in the full imported library');
  t=performance.now();await page.evaluate(()=>window.omc.invoke('flush'));result.flushMs=performance.now()-t;
  await app.close();app=null;result.checks.push('All 46 pages selected and settled');
  shell=await launch();t=performance.now();await shell.evaluate(id=>window.omc.invoke('open',{id,focus:true}),meta.id);page=await documentPage(app);result.reopenMs=performance.now()-t;
  const reopened=await page.evaluate(async()=>{const s=await window.omc.invoke('snapshot');return {pages:s.document.pages.length,assets:Object.keys(s.document.assets??{}).length,cover:s.document.pagesById[s.document.pages[0]].name};});assert.deepEqual(reopened,{pages:46,assets:meta.assets,cover:'Cover — import verification'});result.checks.push('Fresh-process reopen retains every page and shared image');
  assert.deepEqual(result.errors,[]);result.passed=true;
} catch(error){result.passed=false;result.failure=error.stack;throw error;}
finally{await fs.writeFile(path.join(evidence,'large-runtime-result.json'),JSON.stringify(result,null,2));if(app)await app.close().catch(()=>{});await fs.rm(profile,{recursive:true,force:true});console.log(JSON.stringify({passed:result.passed,importMs:result.importMs,reopenMs:result.reopenMs,editMs:result.editMs,checks:result.checks}));}
