/** Native large-document measurements. Run the same script against both revisions:
 * cd <app checkout>; node <candidate>/scripts/large-document-e2e.mjs \
 *   --source /absolute/library.fig --output /absolute/evidence/baseline --label baseline
 * Requires a built app and a native display (xvfb-run is suitable on Linux CI).
 * All profiles are temporary. Results distinguish UI paint, durability and complete
 * MCP operations; frame intervals include native input automation, not GPU-only time.
 * --journey-timeout sets the global deadline in milliseconds (default 600000).
 * --legacy-loading keeps the full-document readiness contract for PR12 references.
 */
import {_electron as electron} from 'playwright';
import {promises as fs, createReadStream} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';

const args=Object.fromEntries(process.argv.slice(2).reduce((out,value,index,all)=>value.startsWith('--')?[...out,[value.slice(2),all[index+1]?.startsWith('--')?true:all[index+1]??true]]:out,[]));
const root=path.resolve(args['app-root']??process.cwd()),source=args.source,output=args.output,label=String(args.label??'current'),timeout=Number(args.timeout??300000),samples=Number(args.samples??90),journeyTimeout=Number(args['journey-timeout']??600000),legacyLoading=!!args['legacy-loading'];
assert.ok(typeof source==='string'&&path.isAbsolute(source),'--source requires an absolute .fig/.sketch/.json/.omc path');
assert.ok(typeof output==='string'&&path.isAbsolute(output),'--output requires an absolute evidence directory');
assert.ok(Number.isFinite(timeout)&&timeout>=1000&&Number.isSafeInteger(samples)&&samples>=5&&samples<=600,'Invalid timeout/samples');
assert.ok(Number.isSafeInteger(journeyTimeout)&&journeyTimeout>=1000&&journeyTimeout<=3600000,'--journey-timeout must be 1000–3600000 milliseconds');
await fs.mkdir(output,{recursive:true});
const temporary=await fs.mkdtemp(path.join(os.tmpdir(),'omc-large-qa-')),profile=path.join(temporary,'original');
const requireFromApp=createRequire(path.join(root,'package.json'));
const result={schemaVersion:2,label,legacyLoading,at:new Date().toISOString(),source:{path:source,bytes:(await fs.stat(source)).size},environment:{platform:process.platform,arch:process.arch,node:process.version,cpu:os.cpus()[0]?.model,logicalCPUs:os.cpus().length,totalMemory:os.totalmem()},checks:[],phases:{},rendererErrors:[],consoleErrors:[],startupDiagnostics:[],failedResponses:[],failedRequests:[],limitations:['Single native process run per revision; automated input frame intervals include driver scheduling.','A screenshot is evidence of the rendered result, not a comparison against the Figma original.','Harness waits do not change the app worker/runtime deadlines.','Gesture samples are warmed by a completed native save/settle before sampling; page-entry timing is recorded separately.','Reopen measures document open in a fresh process after app launch, not cold-disk or app-start latency; startup library listing may already have read/warmed storage or overlap the open.','Progressive import/reopen completion includes one early page-name edit and the app cooperative pauses for that interaction. First-editable and first-paint marks precede that edit.']};
try{result.revision=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();}catch{}
for(const name of ['electron','playwright','fflate','openfig-core'])try{result.environment[name]=requireFromApp(name+'/package.json').version;}catch{}
let app,shell,page,ownedChild,expired=false,watchdog,watchdogTask,expireJourney;
const journeyError=Error('Global native journey exceeded '+journeyTimeout+' milliseconds');
const journeyExpired=new Promise(resolve=>{expireJourney=resolve;});
function assertJourney(){if(expired)throw journeyError;}
function terminateOwned(){
  if(!ownedChild||ownedChild.exitCode!==null||ownedChild.signalCode!==null)return {pid:ownedChild?.pid,running:false};
  return {pid:ownedChild.pid,signal:'SIGKILL',sent:ownedChild.kill('SIGKILL')};
}
const observed=new WeakSet();
const hashFile=async file=>{const hash=createHash('sha256');for await(const bytes of createReadStream(file))hash.update(bytes);return hash.digest('hex');};
result.source.sha256=await hashFile(source);
let writing=Promise.resolve();
function checkpoint(){const text=JSON.stringify(result,null,2)+'\n';writing=writing.catch(()=>{}).then(async()=>{const temporary=path.join(output,'result.json.tmp');await fs.writeFile(temporary,text);await fs.rename(temporary,path.join(output,'result.json'));});return writing;}
async function check(name,fn,{fatal=false}={}){
  assertJourney();const started=performance.now();
  result.pendingCheck={name,startedAt:new Date().toISOString()};
  console.log('START',label,name);await checkpoint();assertJourney();
  try{
    const value=await Promise.race([Promise.resolve().then(fn),journeyExpired.then(()=>{throw journeyError;})]);
    assertJourney();result.checks.push({name,passed:true,ms:performance.now()-started});delete result.pendingCheck;
    console.log('PASS',label,name);await checkpoint();return value;
  }catch(error){
    if(!expired){result.checks.push({name,passed:false,ms:performance.now()-started,error:error.stack??String(error)});delete result.pendingCheck;}
    console.error('FAIL',label,name,error.message);
    if(!expired)await page?.screenshot({path:path.join(output,'failure-'+result.checks.length+'.png'),timeout:15000}).catch(()=>{});
    await checkpoint();if(fatal||expired)throw error;
  }
}
function observe(target){
  if(observed.has(target))return;observed.add(target);target.setDefaultTimeout(30000);
  target.on('pageerror',error=>result.rendererErrors.push({url:target.url(),message:error.message}));
  target.on('console',message=>{
    if(message.type()==='error')result.consoleErrors.push({url:target.url(),message:message.text().slice(0,1000),location:message.location()});
    if(message.type()==='info'&&message.text().startsWith('[omc-startup]')){
      result.startupDiagnostics.push({at:new Date().toISOString(),url:target.url(),message:message.text().slice(0,4000),location:message.location()});
      console.log(message.text());void checkpoint().catch(error=>console.error('Could not checkpoint startup diagnostic:',error.message));
    }
  });
  // Network failures are diagnostic, including the deliberately requested missing bitmap.
  target.on('response',response=>{if(response.status()>=400)result.failedResponses.push({pageUrl:target.url(),url:response.url(),status:response.status(),statusText:response.statusText(),resourceType:response.request().resourceType()});});
  target.on('requestfailed',request=>result.failedRequests.push({pageUrl:target.url(),url:request.url(),resourceType:request.resourceType(),error:request.failure()?.errorText}));
}
async function launch(directory){
  assertJourney();await fs.mkdir(directory,{recursive:true});assertJourney();
  app=await electron.launch({executablePath:requireFromApp('electron'),args:[root,`--profile=${directory}`,'--mcp-port=0'],env:{...process.env,OMC_TEST_BACKGROUND:'1'},timeout:60000});ownedChild=app.process();
  if(expired){result.journeyTimeout.lateTermination=terminateOwned();await checkpoint();throw journeyError;}
  // Observe the existing public startup marks before a document runtime exists.
  // This does not hold or replace any application method or hydration promise.
  await app.context().addInitScript(()=>{
    if(location.pathname!=='/document.html')return;
    const state={timeOrigin:performance.timeOrigin,marks:{},states:[],earlyEdit:null},keyOf=value=>JSON.stringify([value.pageCount,value.selectedPageId,value.selectedPageName,value.loadingState,value.saveState,value.ready,value.inert]);
    let previous,observer;
    const sample=reason=>{
      const select=document.querySelector('select[aria-label="Current page"]'),rows=select?[]:[...document.querySelectorAll('#editor .pages .page-row[data-id]')],active=rows.find(row=>row.classList.contains('active'));
      // One/two-page documents use compact rows; the picker appears at page three.
      const value={at:performance.now(),reason,pageCount:select?.options.length??rows.length,selectedPageId:select?.value??active?.dataset.id??null,selectedPageName:select?.selectedOptions[0]?.textContent??active?.querySelector('.name')?.textContent??null,pageNavigation:select?'select':rows.length?'rows':'unmounted',loadingState:document.body?.dataset.loadingState??null,saveState:document.querySelector('#save-state')?.textContent??null,ready:document.body?.dataset.documentReady==='true',inert:!!document.querySelector('#editor')?.inert,hidden:document.hidden};
      const key=keyOf(value);if(key!==previous){previous=key;if(state.states.length<100)state.states.push(value);}
      if(value.ready&&value.loadingState==='complete'&&!state.complete)state.complete={...value,absoluteMs:performance.timeOrigin+value.at};
      const edit=state.earlyEdit;
      if(edit?.change&&value.saveState==='Stored on this computer'&&!edit.storeCheckStarted){
        edit.storeCheckStarted=true;edit.storedObservedAt=value.at;
        void window.omc.invoke('snapshot').then(snap=>{edit.stored={observedAt:value.at,ack:snap.ack,acceptedSeq:snap.acceptedSeq,loading:snap.loading,pages:snap.document.pages.length,pageName:snap.document.pagesById[edit.pageId]?.name};},error=>{edit.error=String(error);});
      }
      return value;
    };
    const marks=new PerformanceObserver(list=>{for(const entry of list.getEntries())if(['omc-first-editable','omc-first-paint'].includes(entry.name)&&!state.marks[entry.name])state.marks[entry.name]={...sample(entry.name),at:entry.startTime,absoluteMs:performance.timeOrigin+entry.startTime,observedAt:performance.now(),detail:entry.detail};});
    marks.observe({type:'mark',buffered:true});
    observer=new MutationObserver(()=>sample('dom'));observer.observe(document,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['data-loading-state','data-document-ready','inert','value']});
    document.addEventListener('change',event=>{
      const edit=state.earlyEdit;
      if(edit&&!edit.change&&event.target instanceof HTMLInputElement&&event.target.matches('input[aria-label="Name"]')&&event.composedPath().some(node=>node instanceof Element&&node.id==='right')&&event.target.value===edit.name)edit.change=sample('early-change');
    });
    window.__largeDocumentStartup={state,sample,stop(){observer.disconnect();marks.disconnect();}};
  });
  app.context().on('page',observe);shell=await app.firstWindow();observe(shell);
  await shell.waitForFunction(()=>typeof document.querySelector('#import')?.onclick==='function',null,{timeout:30000,polling:100}).catch(error=>{throw Error('Shell JavaScript did not bind Import within 30 seconds; inspect consoleErrors and failedResponses',{cause:error});});
  await app.evaluate(({BrowserWindow})=>{const window=BrowserWindow.getAllWindows()[0];window.setSize(1500,980);window.showInactive();});result.environment.visibleWindow=true;result.environment.electronRuntime=await app.evaluate(()=>process.versions);result.environment.gpu=await app.evaluate(({app})=>app.getGPUFeatureStatus());result.environment.gpuInfo=await app.evaluate(async({app})=>{try{return await app.getGPUInfo('basic');}catch(error){return{error:error.message};}});
}
function runtimeId(candidate){try{const url=new URL(candidate.url());return url.pathname==='/document.html'?url.searchParams.get('documentId'):null;}catch{return null;}}
async function documentPage(id){
  const until=Date.now()+timeout;
  while(Date.now()<until){
    assertJourney();
    // Known IDs avoid a main-process workspace request while authority hydrates.
    const wanted=id??(await shell.evaluate(()=>window.omc.invoke('workspace'))).activeTabId;
    const found=app.context().pages().filter(item=>runtimeId(item)===wanted).sort((a,b)=>Number(new URL(b.url()).searchParams.get('generation'))-Number(new URL(a.url()).searchParams.get('generation')))[0];
    if(found){observe(found);await found.waitForFunction(legacy=>!!window.lvMcp&&!document.querySelector('#editor')?.inert&&(legacy||document.body.dataset.documentReady==='true'),legacyLoading,{timeout});return found;}
    await new Promise(resolve=>setTimeout(resolve,20));
  }
  throw Error('Document did not become ready within harness deadline');
}
async function close(){
  if(!app)return;
  const current=app,child=current.process(),started=performance.now();
  app=null;page=null;shell=null;
  let deadline;
  try{
    await Promise.race([current.close(),new Promise((_,reject)=>{deadline=setTimeout(()=>reject(Error('Native close exceeded 30 seconds')),30000);})]);
  }catch(error){
    const forced={pid:child.pid,reason:error.message,ms:performance.now()-started};
    if(child.exitCode===null&&child.signalCode===null){
      forced.signal='SIGKILL';
      forced.sent=child.kill('SIGKILL');
      let exitDeadline;
      await Promise.race([new Promise(resolve=>child.once('exit',resolve)),new Promise(resolve=>{exitDeadline=setTimeout(resolve,5000);})]);
      clearTimeout(exitDeadline);
    }
    (result.forcedCloses??=[]).push(forced);
    await checkpoint();
    throw Error('Native app required forced cleanup: '+error.message,{cause:error});
  }finally{clearTimeout(deadline);}
}
async function tool(name,data={}){const value=await page.evaluate(async({name,data})=>window.lvMcp.handleToolCall('large-document-qa',name,data),{name,data});assert.ok(!value.isError,JSON.stringify(value).slice(0,2000));return value.structuredContent??JSON.parse(value.content[0].text);}
async function flush(){await shell.evaluate(id=>window.omc.invoke('runtime-command',{id,name:'save'}),result.document?.id);await page.evaluate(()=>window.omc.invoke('flush'));}
async function watchErrors(target){await target.evaluate(()=>{window.__largeDocumentError?.observer.disconnect();const toast=document.querySelector('#toast'),state={message:null};if(!toast)return;state.observer=new MutationObserver(()=>{if(!toast.hidden&&toast.classList.contains('error-toast'))state.message=toast.textContent;});state.observer.observe(toast,{attributes:true,childList:true,characterData:true,subtree:true});window.__largeDocumentError=state;});}
async function importFile(file){
  await app.evaluate(({dialog},file)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]});},file);
  const previous=await shell.evaluate(()=>window.omc.invoke('workspace'));await watchErrors(shell);
  const timing={started:performance.now(),requestedAt:Date.now()};await shell.locator('#import').click();const until=Date.now()+timeout;
  while(Date.now()<until){
    assertJourney();
    const candidate=app.context().pages().find(candidate=>runtimeId(candidate)&&!previous.tabs.some(tab=>tab.id===runtimeId(candidate)));
    if(candidate){timing.documentId=runtimeId(candidate);page=await documentPage(timing.documentId);return {...timing,firstReadyObservedMs:performance.now()-timing.started};}
    const error=await shell.evaluate(()=>window.__largeDocumentError?.message);if(error)throw Error('Native import: '+error);
    await new Promise(resolve=>setTimeout(resolve,20));
  }
  throw Error('Native import exceeded harness deadline');
}
async function loadingJourney(timing,{progressive=false,earlyName,phase}={}){
  if(legacyLoading){
    await page.evaluate(()=>window.__largeDocumentStartup?.stop());
    return {legacy:true,firstReadyObservedMs:timing.firstReadyObservedMs,allPagesMs:timing.firstReadyObservedMs,allPagesObservedMs:timing.firstReadyObservedMs};
  }
  await page.waitForFunction(()=>!!window.__largeDocumentStartup?.state.marks['omc-first-paint'],null,{timeout:30000});
  const initial=await page.evaluate(()=>({marks:window.__largeDocumentStartup.state.marks,current:window.__largeDocumentStartup.sample('first-ready-observation')}));
  const first=initial.marks['omc-first-editable'],paint=initial.marks['omc-first-paint'];
  const report={firstReadyObservedMs:timing.firstReadyObservedMs,firstEditableMs:first?first.absoluteMs-timing.requestedAt:null,firstPaintMs:paint?paint.absoluteMs-timing.requestedAt:null,firstEditable:first??null,firstPaint:paint??null,initialObservation:initial.current};
  if(phase){result.phases[phase]=report;await checkpoint();}
  assert.ok(first&&paint,'Runtime did not emit both startup marks');assert.ok(paint.at>=first.at,'First paint preceded editability');
  let early;
  if(progressive){
    assert.equal(first.detail?.loadedPages,1,'First editable mark did not contain exactly one loaded page');
    assert.equal(paint.detail?.loadedPages,1,'First paint did not precede delivery of the remaining pages');
    assert.ok(first.detail.totalPages>1,'Progressive fixture has no remaining pages');
    assert.equal(initial.current.loadingState,'loading','Remaining pages completed before the early-edit check');
    assert.ok(initial.current.pageCount>=1&&initial.current.pageCount<first.detail.totalPages,'No partial editing window was observed');
    early=await page.evaluate(name=>{
      const qa=window.__largeDocumentStartup,before=qa.sample('before-early-edit');
      qa.state.earlyEdit={pageId:before.selectedPageId,previousName:before.selectedPageName,name,before};return qa.state.earlyEdit;
    },earlyName);
    assert.ok(early.pageId,'The initial page is not selected');
    const input=page.locator('#right input[aria-label="Name"]');await input.fill(earlyName);await input.press('Tab');
    const change=await page.evaluate(()=>window.__largeDocumentStartup.state.earlyEdit.change);
    report.earlyEdit={...early,change};if(phase)await checkpoint();
    assert.ok(change,'The page inspector did not commit the early edit');
    assert.equal(change.loadingState,'loading','The rename was not committed during loading');
    assert.ok(change.pageCount<first.detail.totalPages,'All pages were present before the early rename');
    assert.notEqual(change.saveState,'Stored on this computer','An edit was reported Stored synchronously, before any durable acknowledgment');
  }
  await page.waitForFunction(()=>['complete','incomplete'].includes(document.body.dataset.loadingState),null,{timeout});
  const terminal=await page.evaluate(()=>({state:document.body.dataset.loadingState,message:document.querySelector('#loading-description')?.textContent}));
  assert.equal(terminal.state,'complete','Background loading failed: '+terminal.message);
  if(early){
    await page.waitForFunction(()=>{const e=window.__largeDocumentStartup.state.earlyEdit;return e.stored||e.error;},null,{timeout});
    early=await page.evaluate(()=>window.__largeDocumentStartup.state.earlyEdit);
    assert.ok(!early.error,early.error);assert.ok(early.stored.ack>=1,'Stored status had no durable user-edit acknowledgment');
    assert.equal(early.stored.pageName,earlyName,'The early edit was overwritten before durability');
    assert.equal(await page.locator('#right input[aria-label="Name"]').inputValue(),earlyName,'The early name disappeared as pages arrived');
  }
  await frames();
  const state=await page.evaluate(()=>{const qa=window.__largeDocumentStartup;qa.sample('all-pages-observation');qa.stop();return qa.state;});
  assert.ok(state.complete,'No complete loading state was observed');
  return {...report,allPagesMs:state.complete.absoluteMs-timing.requestedAt,allPagesObservedMs:performance.now()-timing.started,complete:state.complete,earlyEdit:early,loadingStates:state.states};
}
async function metadata(){return page.evaluate(async({trackedShape})=>{const state=await window.omc.invoke('snapshot'),doc=state.document,refs=new Set(),missing=new Set();let inlineSources=0,inlineChars=0;const stack=[doc];while(stack.length){const record=stack.pop();if(!record||typeof record!=='object')continue;if(record.assetId&&!record.src&&!record.url&&!record.id&&!doc.assets?.[record.assetId])missing.add(record.assetId);for(const [key,value] of Object.entries(record)){if(typeof value==='string'&&/^omc-asset:sha256:[a-f0-9]{64}$/.test(value))refs.add(value.slice(-64));else if(key==='src'&&typeof value==='string'&&value.startsWith('data:image/')){inlineSources++;inlineChars+=value.length;}else if(value&&typeof value==='object')stack.push(value);}}return{id:state.id,title:state.title,pages:doc.pages.map(id=>({id,name:doc.pagesById[id].name,objects:Object.keys(doc.pagesById[id].objects).length,firstRoot:doc.pagesById[id].objects.root.childIds?.[0],focusRoot:(()=>{const objects=doc.pagesById[id].objects;const shape=(objects.root.childIds??[]).map(key=>objects[key]).find(shape=>shape&&!shape.hidden&&shape.width>100&&shape.height>100);return shape?{id:shape.id,x:shape.x,y:shape.y,width:shape.width,height:shape.height}:null;})()})),assets:Object.keys(doc.assets??{}).length,externalHashes:[...refs],missingAssets:[...missing],inlineSources,inlineChars,trackedShape:trackedShape?doc.pages.map(id=>doc.pagesById[id].objects[trackedShape]).filter(Boolean).map(shape=>({id:shape.id,x:shape.x,y:shape.y})):[]};},{trackedShape:result.phases.drag?.target?.id});}
function assertRetainedDocument(meta,cover,names={}){
  assert.deepEqual(meta.pages.map(item=>({id:item.id,objects:item.objects})),result.document.pages.map(item=>({id:item.id,objects:item.objects})),'Page order, IDs or per-page object counts changed');
  assert.deepEqual(meta.pages.map(item=>item.name),result.document.pages.map(item=>names[item.id]??(item.id===cover.id?'Cover — verified '+label:item.name)),'Page names were not retained');
  assert.equal(meta.assets,result.document.assets);assert.equal(meta.missingAssets.length,0);
  if(result.document.externalHashes.length)assert.deepEqual([...meta.externalHashes].sort(),[...result.document.externalHashes].sort(),'Original bitmap hash set changed');
  const drag=result.phases.drag?.target;
  if(drag){assert.equal(meta.trackedShape.length,1,'Dragged shape was lost or duplicated');for(const axis of ['x','y'])assert.ok(Math.abs(meta.trackedShape[0][axis]-drag.after[axis])<=1e-6,'Dragged shape position was not retained: '+axis);}
}
async function memory(){return app.evaluate(({app})=>app.getAppMetrics().map(item=>({type:item.type,cpu:item.cpu,memory:item.memory})));}
async function installProbe(){await page.evaluate(()=>{
  let current,raf;const messages=[],inputStart=new WeakMap();
  window.omc.on(message=>{if(current&&['saved','document','document-delta','error'].includes(message.type))messages.push({type:message.type,at:performance.now(),changeCount:message.changes?.length,revision:message.revision,message:message.type==='error'?message.message:undefined});});
  for(const type of ['wheel','pointermove','pointerdown','pointerup']){document.addEventListener(type,event=>{if(current)inputStart.set(event,performance.now());},true);document.addEventListener(type,event=>{if(current&&inputStart.has(event))current.handlers.push({type,at:inputStart.get(event),ms:performance.now()-inputStart.get(event)});});}
  const mutations=new MutationObserver(records=>{if(current)for(const record of records){current.mutations++;if(record.type==='childList'){current.added+=record.addedNodes.length;current.removed+=record.removedNodes.length;}}});mutations.observe(document.querySelector('#editor'),{subtree:true,childList:true,attributes:true});
  let longTasks;try{longTasks=new PerformanceObserver(list=>{if(current)for(const entry of list.getEntries())if(entry.startTime>=current.started)current.longTasks.push({at:entry.startTime,ms:entry.duration});});longTasks.observe({type:'longtask',buffered:false});}catch{}
  const stats=values=>{const sorted=[...values].sort((a,b)=>a-b);return{n:sorted.length,median:sorted[Math.floor(sorted.length/2)]??null,p95:sorted[Math.min(sorted.length-1,Math.ceil(sorted.length*.95)-1)]??null,max:sorted.at(-1)??null,total:sorted.reduce((a,b)=>a+b,0)};};
  window.__largeDocumentQA={start(name){cancelAnimationFrame(raf);messages.length=0;current={name,started:performance.now(),frames:[],handlers:[],longTasks:[],mutations:0,added:0,removed:0};let previous;const frame=now=>{if(!current)return;if(previous!==undefined)current.frames.push(now-previous);previous=now;raf=requestAnimationFrame(frame);};raf=requestAnimationFrame(frame);},mark(name){if(current)current[name]=performance.now()-current.started;},messages:()=>messages,finish(){cancelAnimationFrame(raf);const data=current;current=null;const ack=messages.find(entry=>entry.type==='document'||entry.type==='document-delta'),saved=ack&&messages.find(entry=>entry.type==='saved'&&entry.at>=ack.at);return{...data,elapsedMs:performance.now()-data.started,frameIntervalsMs:stats(data.frames),inputHandlersMs:stats(data.handlers.map(entry=>entry.ms)),longTasksMs:stats(data.longTasks.map(entry=>entry.ms)),notifications:messages.map(entry=>({...entry,ms:entry.at-data.started})),ackMs:ack?ack.at-data.started:null,durableMs:saved?saved.at-data.started:null,dom:{sceneNodes:document.querySelectorAll('#view *').length,shapeNodes:document.querySelectorAll('#view [data-shape-id]').length,layerRows:document.querySelectorAll('.layers .row[data-id]').length},svgSurfaceViewBox:document.querySelector('#view svg')?.getAttribute('viewBox')};}};
});}
const tick=()=>page.evaluate(()=>new Promise(requestAnimationFrame));
const frames=()=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
const start=name=>page.evaluate(name=>window.__largeDocumentQA.start(name),name);
async function finish({save=false}={}){await frames();await page.evaluate(()=>window.__largeDocumentQA.mark('paintMs'));if(save)await page.waitForFunction(()=>{const events=window.__largeDocumentQA.messages(),ack=events.find(event=>event.type==='document'||event.type==='document-delta');return ack&&events.some(event=>event.type==='saved'&&event.at>=ack.at);},null,{timeout});const data=await page.evaluate(()=>window.__largeDocumentQA.finish());delete data.frames;delete data.handlers;delete data.longTasks;data.viewport=(await tool('view',{action:'get'})).viewport;return data;}
async function selectPage(id){await start('page-entry');await page.locator('select[aria-label="Current page"]').selectOption(id);const entry=await finish();const began=performance.now();await tool('select_page',{id});entry.additionalSettleMs=performance.now()-began;const currentName=await page.locator('select[aria-label="Current page"]').evaluate(select=>select.selectedOptions[0].textContent);assert.equal(await page.locator('#right input[aria-label="Name"]').inputValue(),currentName,'Page inspector shows a stale page name');return entry;}
async function selectLeaf(){const candidate=await page.evaluate(async()=>{const state=await window.omc.invoke('snapshot'),select=document.querySelector('select[aria-label="Current page"]'),objects=state.document.pagesById[select.value].objects;for(const shape of Object.values(objects).reverse()){if(!['rect','image','ellipse'].includes(shape.type)||shape.childIds?.length||shape.width<12||shape.height<12||shape.width>1000||shape.height>1000||shape.locked||shape.hidden)continue;let parent=objects[shape.parentId],ok=true,visited=new Set();while(parent&&parent.id!=='root'&&!visited.has(parent.id)){visited.add(parent.id);if(parent.locked||parent.hidden||parent.layout||parent.isMaskGroup||parent.clipContent&&(shape.x+shape.width/2<parent.x||shape.x+shape.width/2>parent.x+parent.width||shape.y+shape.height/2<parent.y||shape.y+shape.height/2>parent.y+parent.height)){ok=false;break;}parent=objects[parent.parentId];}if(ok)return{id:shape.id,x:shape.x,y:shape.y,width:shape.width,height:shape.height};}return null;});assert.ok(candidate,'No unlocked free-positioned leaf is available for a drag');await tool('view',{action:'select',ids:[candidate.id]});await tool('view',{action:'fit',ids:[candidate.id]});const box=await page.locator('#editor #stage').boundingBox();await tool('view',{action:'set',viewport:{vport:{width:box.width,height:box.height},vbox:{x:candidate.x+candidate.width/2-box.width/2,y:candidate.y+candidate.height/2-box.height/2,width:box.width,height:box.height},zoom:1}});await frames();return candidate;}
async function exportFile(format){if(await page.locator('#dialog').evaluate(dialog=>dialog.open))await page.locator('#dialog button[aria-label="Close dialog"]').click();const file=path.join(output,'export.'+format);await app.evaluate(({dialog},file)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath:file});},file);await page.locator('#export').click();await watchErrors(page);const began=performance.now();await page.locator(`[data-format="${format}"]`).click();await page.waitForFunction(()=>window.__largeDocumentError?.message||!document.querySelector('#dialog')?.open,null,{timeout});const error=await page.evaluate(()=>window.__largeDocumentError?.message);if(error)throw Error('Native export: '+error);const stat=await fs.stat(file);assert.ok(stat.size>20);result.phases['export-'+format]={ms:performance.now()-began,bytes:stat.size};return file;}
async function inspectPortableText(file,kind){const input=createReadStream(file,{encoding:'utf8'});let tail='',localReference=false,hasData=false,remoteImage=false;for await(const text of input){const part=tail+text;localReference ||= /omc-asset:sha256:|omc:\/\/canvas\/assets\//.test(part);hasData ||= /data:image\//.test(part);remoteImage ||= kind==='SVG'&&/<image\b[^>]*(?:href|xlink:href)=["'](?!data:)[^"']+["']/i.test(part);tail=part.slice(-1000);}assert.equal(localReference,false,kind+' contains workspace-only URLs');assert.equal(remoteImage,false,'SVG contains an unresolved image URL');if(kind==='JSON'&&result.document.assets)assert.ok(hasData,kind+' has no embedded image sources');return{localReference,hasData,remoteImage};}

function traceUnionMs(intervals){
  let total=0,end=-Infinity;
  for(const [start,stop] of intervals.sort((a,b)=>a[0]-b[0]||a[1]-b[1])){total+=Math.max(0,stop-Math.max(start,end));end=Math.max(end,stop);}
  return total/1000;
}
function tracePhase(name){
  if(/^(?:V8\.GC|BlinkGC|MinorGC|MajorGC|GC\b)/.test(name))return 'garbageCollection';
  if(/^(?:Layout|UpdateLayoutTree|RecalculateStyles|RecalculateStyle|UpdateStyle|HitTest)$/.test(name))return 'styleAndLayout';
  if(/^(?:Decode Image|DecodeImage|ImageDecodeTask)$/.test(name))return 'imageDecode';
  if(/^(?:Paint|PaintImage|PrePaint|UpdateLayerTree|Layerize|CompositeLayers|Commit|RasterTask|Rasterize)$/.test(name))return 'paintAndComposite';
  if(/^(?:FunctionCall|EvaluateScript|RunMicrotasks|EventDispatch|FireAnimationFrame|TimerFire|CompileScript|CompileCode|V8\.Execute|v8\.run|v8\.run_microtasks)$/.test(name))return 'scriptAndCallbacks';
  return null;
}
function summarizePanTrace(events,startName,endName,deadline){
  if(!Array.isArray(events)||events.length>250000)throw Error('Pan trace has no event array or exceeds the 250,000-event summary limit');
  const start=events.find(event=>event.name===startName&&Number.isFinite(event.ts)),end=events.find(event=>event.name===endName&&Number.isFinite(event.ts));
  if(!start||!end||start.pid!==end.pid||start.tid!==end.tid||end.ts<=start.ts)throw Error('Pan trace has no matching renderer time markers');
  const threads=new Map();
  for(const event of events)if(event.ph==='M'&&event.name==='thread_name')threads.set(`${event.pid}:${event.tid}`,String(event.args?.name??''));
  const pending=new Map(),complete=[];let unmatchedEnds=0;
  const add=(event,stop)=>{if(Number.isFinite(event.ts)&&Number.isFinite(stop)&&stop>event.ts)complete.push({name:String(event.name??''),pid:event.pid,tid:event.tid,start:event.ts,end:stop,dispatchType:event.args?.data?.type,callback:event.name==='FunctionCall'?{name:event.args?.data?.functionName??'',url:event.args?.data?.url??event.args?.data?.scriptName??'',line:event.args?.data?.lineNumber}:undefined});};
  for(const event of events.filter(event=>['X','B','E'].includes(event.ph)).sort((a,b)=>a.ts-b.ts)){
    if(performance.now()>deadline)throw Error('Pan trace summary exceeded the diagnostic deadline');
    if(event.ph==='X'){add(event,event.ts+event.dur);continue;}
    const key=`${event.pid}:${event.tid}`,stack=pending.get(key)??[];pending.set(key,stack);
    if(event.ph==='B')stack.push(event);else{const begin=stack.pop();if(begin)add(begin,event.ts);else unmatchedEnds++;}
  }
  const clipped=complete.filter(event=>event.end>start.ts&&event.start<end.ts).map(event=>({...event,from:Math.max(start.ts,event.start),to:Math.min(end.ts,event.end)}));
  const main=clipped.filter(event=>event.pid===start.pid&&event.tid===start.tid);
  // Pick the innermost classified synchronous event for each interval. An inner
  // Layout/GC/Paint event is excluded from its enclosing JS callback, so these
  // buckets partition the window instead of summing nested inclusive timings.
  const phases=['garbageCollection','styleAndLayout','imageDecode','paintAndComposite','scriptAndCallbacks','otherObserved','idleOrUnobserved'];
  const totals=Object.fromEntries(phases.map(name=>[name,0])),edges=[{at:start.ts},{at:end.ts}],active=new Set(),heap=[];
  const preferred=(a,b)=>a.start>b.start||a.start===b.start&&(a.end<b.end||a.end===b.end&&phases.indexOf(a.phase)<phases.indexOf(b.phase));
  const push=entry=>{let index=heap.push(entry)-1;while(index){const parent=(index-1)>>1;if(!preferred(heap[index],heap[parent]))break;[heap[index],heap[parent]]=[heap[parent],heap[index]];index=parent;}};
  const pop=()=>{const last=heap.pop();if(!heap.length)return;heap[0]=last;let index=0;while(index*2+1<heap.length){let child=index*2+1;if(child+1<heap.length&&preferred(heap[child+1],heap[child]))child++;if(!preferred(heap[child],heap[index]))break;[heap[index],heap[child]]=[heap[child],heap[index]];index=child;}};
  main.forEach((event,id)=>{const entry={...event,id,phase:tracePhase(event.name)};edges.push({at:event.from,enter:true,entry},{at:event.to,enter:false,entry});});
  edges.sort((a,b)=>a.at-b.at);let previous=start.ts,observed=0;
  for(let index=0;index<edges.length;){
    if(performance.now()>deadline)throw Error('Pan trace attribution exceeded the diagnostic deadline');
    const at=edges[index].at;while(heap.length&&!active.has(heap[0].id))pop();
    totals[heap[0]?.phase??(observed?'otherObserved':'idleOrUnobserved')]+=at-previous;
    while(index<edges.length&&edges[index].at===at){const {entry,enter}=edges[index++];if(!entry)continue;observed+=enter?1:-1;if(entry.phase){if(enter){active.add(entry.id);push(entry);}else active.delete(entry.id);}}
    previous=at;
  }
  const rounded=value=>Math.round(value*1000)/1000;
  const eventSummary=items=>{
    const groups=new Map();for(const event of items){const group=groups.get(event.name)??[];group.push(event);groups.set(event.name,group);}
    return [...groups].map(([name,group])=>({name,events:group.length,inclusiveUnionMsNotAdditive:rounded(traceUnionMs(group.map(event=>[event.from,event.to]))),maxEventMs:rounded(group.reduce((maximum,event)=>Math.max(maximum,(event.to-event.from)/1000),0))})).sort((a,b)=>b.inclusiveUnionMsNotAdditive-a.inclusiveUnionMsNotAdditive).slice(0,20);
  };
  const otherThreads=new Map();for(const event of clipped)if(event.pid===start.pid&&event.tid!==start.tid){const group=otherThreads.get(event.tid)??[];group.push(event);otherThreads.set(event.tid,group);}
  const callbacks=new Map();for(const event of main)if(event.callback){const key=JSON.stringify(event.callback),group=callbacks.get(key)??[];group.push(event);callbacks.set(key,group);}
  const taskName=['RunTask','ThreadControllerImpl::RunTask','TaskQueueManager::ProcessTaskFromWorkQueue'].find(name=>main.some(event=>event.name===name)),tasks=main.filter(event=>event.name===taskName).map(event=>(event.to-event.from)/1000).sort((a,b)=>a-b);
  return {windowMs:rounded((end.ts-start.ts)/1000),renderer:{pid:start.pid,tid:start.tid,threadName:threads.get(`${start.pid}:${start.tid}`)??null,identifiedBy:'paired public Performance API markers'},eventCount:events.length,rendererMainEventCount:main.length,wheelDispatchEvents:main.filter(event=>event.name==='EventDispatch'&&event.dispatchType==='wheel').length,exclusiveMainThreadMs:Object.fromEntries(Object.entries(totals).map(([name,us])=>[name,rounded(us/1000)])),mainThreadTasks:taskName?{eventName:taskName,count:tasks.length,over50ms:tasks.filter(ms=>ms>=50).length,maxMs:rounded(tasks.at(-1)??0),p95Ms:rounded(tasks[Math.ceil(tasks.length*.95)-1]??0)}:null,eventsInclusiveNotAdditive:eventSummary(main),callbacksInclusiveNotAdditive:[...callbacks].map(([key,group])=>({...JSON.parse(key),events:group.length,inclusiveUnionMsNotAdditive:rounded(traceUnionMs(group.map(event=>[event.from,event.to])))})).sort((a,b)=>b.inclusiveUnionMsNotAdditive-a.inclusiveUnionMsNotAdditive).slice(0,10),otherRendererThreadsNotAdditive:[...otherThreads].map(([tid,group])=>({tid,name:threads.get(`${start.pid}:${tid}`)??null,observedUnionMs:rounded(traceUnionMs(group.map(event=>[event.from,event.to]))),eventsInclusiveNotAdditive:eventSummary(group).slice(0,5)})).sort((a,b)=>b.observedUnionMs-a.observedUnionMs).slice(0,8),unpairedSynchronousEvents:{begins:[...pending.values()].reduce((count,stack)=>count+stack.length,0),ends:unmatchedEnds},method:'Main-thread interval attribution, not CPU utilization. Exclusive buckets partition the marked window; per-name/callback rows overlap and must not be added. Other threads run concurrently. Async events and other processes, including GPU work, are outside this attribution.'};
}
async function diagnoseInputTrace(kind='pan'){
  const started=performance.now(),deadline=started+30000,workDeadline=deadline-2000,maxBytes=32*1024*1024;
  const report={available:false,...kind==='pan'?{wheelEventsRequested:6,wheelEventsSent:0}:{pointerDownEventsRequested:1,pointerDownEventsSent:0},timeoutMs:30000,maxBytes,description:kind==='pan'?'Separate diagnostic after the measured pan; tracing overhead is excluded from phases.pan.':'Separate pointerdown/up diagnostic immediately after the measured drag, without movement. Caches may be warm. Tracing overhead is excluded from phases.drag.'};
  let client,stream,tracing=false,closing=false,completeListener,pointerDown=false,modifierDown=false;
  const modifier=process.platform==='darwin'?'Meta':'Control';
  const bounded=async(run,until=workDeadline)=>{const left=until-performance.now();if(left<=0)throw Error('Pan trace diagnostic exceeded 30 seconds');let timer;try{return await Promise.race([Promise.resolve().then(run),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Pan trace diagnostic exceeded 30 seconds')),left);})]);}finally{clearTimeout(timer);}};
  try{
    report.rendererOSProcessId=await bounded(()=>app.evaluate(({webContents},url)=>webContents.getAllWebContents().find(contents=>contents.getURL()===url)?.getOSProcessId()??null,page.url()));
    client=await bounded(()=>page.context().newCDPSession(page).then(session=>{client=session;if(closing)void session.detach().catch(()=>{});return session;}));
    const completion=new Promise(resolve=>{completeListener=value=>{stream=value.stream;resolve(value);};client.on('Tracing.tracingComplete',completeListener);});
    tracing=true;
    await bounded(()=>client.send('Tracing.start',{transferMode:'ReturnAsStream',streamFormat:'json',streamCompression:'none',traceConfig:{recordMode:'recordUntilFull',traceBufferSizeInKb:8192,enableSampling:false,includedCategories:['devtools.timeline','disabled-by-default-devtools.timeline','blink.user_timing','v8']}}));
    await bounded(frames);
    const marker='omc-'+kind+'-diagnostic-'+Date.now(),startName=marker+'-start',endName=marker+'-end';
    await bounded(()=>page.evaluate(name=>performance.mark(name),startName));
    if(kind==='pan')for(let index=0;index<6;index++){assertJourney();await bounded(()=>page.mouse.wheel(index%2?14:-14,0));report.wheelEventsSent++;await bounded(tick);}
    else{
      modifierDown=true;await bounded(()=>page.keyboard.down(modifier));pointerDown=true;await bounded(()=>page.mouse.down());report.pointerDownEventsSent++;
      await bounded(()=>page.keyboard.up(modifier));modifierDown=false;await bounded(frames);
      await bounded(()=>page.mouse.up());pointerDown=false;
    }
    await bounded(frames);await bounded(()=>page.evaluate(name=>performance.mark(name),endName));
    await bounded(()=>client.send('Tracing.end'));tracing=false;
    const finished=await bounded(()=>completion);report.dataLossOccurred=!!finished.dataLossOccurred;
    if(!stream)throw Error('CDP returned no trace stream');
    const chunks=[];let bytes=0;
    while(true){
      const part=await bounded(()=>client.send('IO.read',{handle:stream,size:256*1024}));
      if(typeof part.data!=='string'||part.data.length>maxBytes*4/3+8)throw Error('Pan trace chunk exceeds the 32-MiB diagnostic limit');
      const chunk=Buffer.from(part.data,part.base64Encoded?'base64':'utf8');bytes+=chunk.length;
      if(bytes>maxBytes)throw Error('Pan trace exceeds the 32-MiB diagnostic limit');chunks.push(chunk);
      if(part.eof)break;if(!chunk.length)throw Error('CDP trace stream made no progress');
    }
    const trace=Buffer.concat(chunks,bytes);report.traceBytes=bytes;
    report.summary=summarizePanTrace(JSON.parse(trace.toString('utf8')).traceEvents,startName,endName,workDeadline);
    await bounded(()=>fs.writeFile(path.join(output,kind+'-trace.json'),trace));
    report.rawTraceFile=kind+'-trace.json';report.available=true;report.complete=!report.dataLossOccurred;
  }catch(error){report.error=String(error.message??error).slice(0,1000);}
  finally{
    closing=true;
    const cleanup=async run=>{const pending=Promise.resolve().then(run);try{await bounded(()=>pending,deadline);}catch(error){pending.catch(()=>{});(report.cleanupErrors??=[]).push(String(error.message??error).slice(0,300));}};
    if(modifierDown)await cleanup(()=>page.keyboard.up(modifier));if(pointerDown)await cleanup(()=>page.mouse.up());
    if(client){if(tracing)await cleanup(()=>client.send('Tracing.end'));if(stream)await cleanup(()=>client.send('IO.close',{handle:stream}));if(completeListener)client.off('Tracing.tracingComplete',completeListener);await cleanup(()=>client.detach());}
    report.durationMs=performance.now()-started;
  }
  return report;
}

result.journey={startedAt:new Date().toISOString(),timeoutMs:journeyTimeout};
watchdog=setTimeout(()=>{
  expired=true;result.passed=false;
  result.journeyTimeout={at:new Date().toISOString(),timeoutMs:journeyTimeout,pendingCheck:result.pendingCheck};
  result.checks.push({name:result.pendingCheck?.name??'journey cleanup',passed:false,timeout:true,error:journeyError.message});
  console.error('TIMEOUT',label,result.pendingCheck?.name??'journey cleanup');
  watchdogTask=(async()=>{
    try{await checkpoint();}catch(error){console.error('Could not checkpoint timeout:',error.message);}
    try{result.journeyTimeout.termination=terminateOwned();}catch(error){result.journeyTimeout.terminationError=error.message;}
    finally{expireJourney();}
    await checkpoint().catch(error=>console.error('Could not checkpoint termination:',error.message));
  })();
},journeyTimeout);
try{
  await check('native launch',()=>launch(profile),{fatal:true});
  await check('source import first paint, early edit, and all pages',async()=>{
    const timing=await importFile(source);
    result.phases.import=await loadingJourney(timing,{phase:'import',progressive:!legacyLoading&&['.fig','.sketch'].includes(path.extname(source).toLowerCase()),earlyName:'Cover — during import '+label});
    result.phases.importMs=result.phases.import.allPagesMs;result.document=await metadata();assert.equal(result.document.missingAssets.length,0);
    if(args['expect-pages'])assert.equal(result.document.pages.length,Number(args['expect-pages']));
    if(path.basename(source)==='iOS-and-iPadOS-27.fig'){assert.equal(result.document.pages.length,46);assert.equal(result.document.assets,160);}
    const early=result.phases.import.earlyEdit;
    if(early)assert.equal(result.document.pages.find(item=>item.id===early.pageId)?.name,early.name,'The completed import lost the early page name');
    result.document.objects=result.document.pages.reduce((sum,item)=>sum+item.objects,0);result.phases.afterImportMemory=await memory();
  },{fatal:true});
  await check('install measurement probes',installProbe,{fatal:true});
  const cover=result.document.pages.find(item=>item.name==='Cover')??result.document.pages[0],examples=result.document.pages.find(item=>item.name==='Examples')??[...result.document.pages].sort((a,b)=>b.objects-a.objects)[0];
  await check('Cover page entry',async()=>{result.phases.coverEntry=await selectPage(cover.id);});
  await check('page rename UI paint and durable save',async()=>{await flush();await page.locator('button[aria-label="Page actions"]').click();await page.locator('.omc-dialog').getByRole('button',{name:'Rename',exact:true}).click();await page.locator('.omc-dialog input').fill('Cover — native performance '+label);await start('rename-ui');await page.locator('.omc-dialog').getByRole('button',{name:'Save',exact:true}).evaluate(button=>button.click());result.phases.renameUI=await finish({save:true});assert.ok(result.phases.renameUI.ackMs!==null&&result.phases.renameUI.durableMs!==null);});
  await check('page rename complete MCP operation',async()=>{const began=performance.now();await tool('page',{action:'rename',pageId:cover.id,name:'Cover — verified '+label});result.phases.renameMcpEndToEndMs=performance.now()-began;await flush();});
  await check('Examples page entry and layer window',async()=>{result.phases.examplesEntry=await selectPage(examples.id);const size=await page.locator('#editor #stage').boundingBox();await tool('view',{action:'set',viewport:{vport:{width:size.width,height:size.height},vbox:{x:examples.focusRoot?.x??0,y:examples.focusRoot?.y??0,width:size.width,height:size.height},zoom:1}});await frames();result.phases.examplesFocus=examples.focusRoot;result.phases.examplesViewport=(await tool('view',{action:'get'})).viewport;result.phases.examplesInitialDom=await page.evaluate(()=>({sceneNodes:document.querySelectorAll('#view *').length,shapeNodes:document.querySelectorAll('#view [data-shape-id]').length,layerRows:document.querySelectorAll('.layers .row[data-id]').length}));await page.screenshot({path:path.join(output,'examples.png')});});
  await check('pure pan has no document writes',async()=>{const box=await page.locator('#editor #stage').boundingBox();await page.mouse.move(box.x+box.width*.6,box.y+box.height*.5);await flush();await start('pure-pan');for(let i=0;i<samples;i++){await page.mouse.wheel(i%2?14:-14,0);await tick();}result.phases.pan=await finish();assert.equal(result.phases.pan.notifications.filter(event=>['document','document-delta'].includes(event.type)).length,0);});
  result.phases.panTrace=result.phases.pan?await diagnoseInputTrace('pan'):{available:false,error:'The measured pan did not complete'};
  console.log('PAN TRACE',label,JSON.stringify(result.phases.panTrace));await checkpoint();
  await check('hover has no document writes',async()=>{const box=await page.locator('#editor #stage').boundingBox();await start('hover');for(let i=0;i<samples;i++){await page.mouse.move(box.x+40+(i*47)%Math.max(1,box.width-80),box.y+40+(i*31)%Math.max(1,box.height-80));await tick();}result.phases.hover=await finish();assert.equal(result.phases.hover.notifications.filter(event=>['document','document-delta'].includes(event.type)).length,0);});
  await check('single leaf drag preview and commit',async()=>{const leaf=await selectLeaf(),view=await tool('view',{action:'get'}),box=await page.locator('#editor #stage').boundingBox(),viewport=view.viewport;const x=box.x+(leaf.x+leaf.width/2-viewport.vbox.x)*viewport.zoom,y=box.y+(leaf.y+leaf.height/2-viewport.vbox.y)*viewport.zoom;await page.mouse.move(x,y);await flush();await start('leaf-drag');const modifier=process.platform==='darwin'?'Meta':'Control';await page.keyboard.down(modifier);await page.mouse.down();await page.keyboard.up(modifier);try{const selection=await page.locator('.layers .row[aria-selected="true"][data-id]').evaluateAll(rows=>rows.map(row=>row.dataset.id));assert.deepEqual(selection,[leaf.id],'Hit test selected a different layer; this would not measure a single-leaf drag');for(let i=1;i<=24;i++){await page.mouse.move(x+i*2,y+i);await tick();}await page.evaluate(()=>window.__largeDocumentQA.mark('releaseMs'));}finally{await page.mouse.up();}result.phases.drag=await finish({save:true});const moved=await page.evaluate(async id=>{const state=await window.omc.invoke('snapshot'),pageId=document.querySelector('select[aria-label="Current page"]').value,s=state.document.pagesById[pageId].objects[id];return{x:s.x,y:s.y};},leaf.id);assert.ok(moved.x!==leaf.x||moved.y!==leaf.y,'The selected leaf did not move');result.phases.drag.target={id:leaf.id,before:{x:leaf.x,y:leaf.y},after:moved};result.phases.drag.releaseToDurableMs=result.phases.drag.durableMs-result.phases.drag.releaseMs;result.phases.afterGestureMemory=await memory();});
  result.phases.dragStartTrace=result.phases.drag?.target?await diagnoseInputTrace('drag-start'):{available:false,error:'The measured drag did not complete'};
  console.log('DRAG START TRACE',label,JSON.stringify(result.phases.dragStartTrace));await checkpoint();
  await check('asset closure and native missing-asset response',async()=>{const meta=await metadata();assert.equal(meta.missingAssets.length,0);result.assetClosure={assetDefinitions:meta.assets,externalHashes:meta.externalHashes.length,inlineSources:meta.inlineSources};if(!meta.externalHashes.length){result.assetClosure.route='not applicable: baseline retains inline originals';return;}for(const hash of meta.externalHashes){const file=path.join(profile,'documents','assets',hash.slice(0,2),hash);assert.equal(await hashFile(file),hash,'Persisted bitmap hash mismatch');}const fetches=await page.evaluate(async({hash,missing})=>{const present=await fetch('omc://canvas/assets/'+hash),bytes=await present.arrayBuffer(),sum=await crypto.subtle.digest('SHA-256',bytes);const absent=await fetch('omc://canvas/assets/'+missing);return{presentStatus:present.status,presentHash:[...new Uint8Array(sum)].map(byte=>byte.toString(16).padStart(2,'0')).join(''),mime:present.headers.get('content-type'),missingStatus:absent.status,missingBytes:(await absent.arrayBuffer()).byteLength};},{hash:meta.externalHashes[0],missing:'0'.repeat(64)});assert.equal(fetches.presentStatus,200);assert.equal(fetches.presentHash,meta.externalHashes[0]);assert.equal(fetches.missingStatus,404);result.assetClosure.route=fetches;});
  await check('portable JSON export',async()=>{const file=await exportFile('json');result.jsonPortable=await inspectPortableText(file,'JSON');});
  await check('portable SVG export',async()=>{await tool('select_page',{id:cover.id});await tool('view',{action:'select',ids:[cover.firstRoot]});const file=await exportFile('svg');result.svgPortable=await inspectPortableText(file,'SVG');});
  await check('portable OMC export',async()=>{await exportFile('omc');});
  await check('fresh process first paint, early edit, and complete reopen',async()=>{
    await flush();await close();await launch(profile);
    const timing={started:performance.now(),requestedAt:Date.now()};
    // Issue Open without waiting on a later main-process authority load before
    // observing the independent document renderer's early editable window.
    const opening=shell.evaluate(id=>window.omc.invoke('open',{id,focus:true}),result.document.id);void opening.catch(()=>{});
    page=await documentPage(result.document.id);timing.firstReadyObservedMs=performance.now()-timing.started;
    result.phases.reopen=await loadingJourney(timing,{phase:'reopen',progressive:!legacyLoading&&result.document.pages.length>1,earlyName:'Cover — during reopen '+label});
    await opening;result.phases.reopenMs=result.phases.reopen.allPagesMs;
    const early=result.phases.reopen.earlyEdit,meta=await metadata();assertRetainedDocument(meta,cover,early?{[early.pageId]:early.name}:{});
    await flush();
    if(early){
      // The pre-reopen exports retain the verified name. Restore it after the
      // early edit's durable ACK and complete-inventory assertion, for comparison.
      const input=page.locator('#right input[aria-label="Name"]');await input.fill(early.previousName);await input.press('Tab');await flush();
    }
    await close();
  });
  for(const format of ['omc','json'])await check('fresh-profile '+format+' round trip',async()=>{const file=path.join(output,'export.'+format);await fs.stat(file);await close();await launch(path.join(temporary,'roundtrip-'+format));const timing=await importFile(file),loading=await loadingJourney(timing);result.phases[format+'RoundTripMs']=loading.allPagesMs;const meta=await metadata();assertRetainedDocument(meta,cover);result[format+'RoundTrip']={pages:meta.pages.length,objects:meta.pages.reduce((sum,item)=>sum+item.objects,0),assets:meta.assets,externalHashes:meta.externalHashes.length};await close();});
  result.passed=!expired&&result.checks.every(item=>item.passed)&&result.rendererErrors.length===0&&!result.forcedCloses?.length;
}catch(error){result.passed=false;result.failure=error.stack??String(error);}finally{await close().catch(error=>{result.closeError=error.message;result.passed=false;});clearTimeout(watchdog);await watchdogTask;await fs.rm(temporary,{recursive:true,force:true,maxRetries:5,retryDelay:100});result.finishedAt=new Date().toISOString();await checkpoint();console.log(JSON.stringify({label,passed:result.passed,checks:result.checks.map(({name,passed})=>({name,passed})),output}));if(!result.passed)process.exitCode=1;}
