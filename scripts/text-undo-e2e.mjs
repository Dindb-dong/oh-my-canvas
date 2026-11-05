import {_electron as electron} from 'playwright';
import {promises as fs} from 'node:fs';import path from 'node:path';import os from 'node:os';import assert from 'node:assert/strict';

const profile=await fs.mkdtemp(path.join(os.tmpdir(),'omc-text-undo-'));
const agent='text-undo-agent';let app,child;const errors=[];
try{
  app=await electron.launch({env:{...process.env,OMC_TEST_BACKGROUND:'1'},executablePath:process.argv.includes('--installed')?'/Applications/Oh My Canvas.app/Contents/MacOS/Oh My Canvas':undefined,args:[process.cwd(),`--profile=${profile}`]});child=app.process();
  const p=await app.firstWindow();p.setDefaultTimeout(15000);p.on('pageerror',e=>errors.push(e.message));
  await p.locator('#new').click();await p.waitForFunction(()=>!!window.lvMcp);
  const tool=async(name,args={})=>p.evaluate(({agent,name,args})=>window.lvMcp.handleToolCall(agent,name,args),{agent,name,args});
  const call=async(name,args={})=>{const r=await tool(name,args);assert.ok(!r.isError,JSON.stringify(r));return r.structuredContent;};
  const board=(await call('get_context')).boards[0];
  await call('write_html',{target:board,position:'last',html:'<div data-ref="undo-text" data-name="Undo text proof" style="position:absolute;left:80px;top:100px;width:400px;height:60px;font-family:IBM Plex Sans;font-size:28px;color:#202124">Hello</div>'});
  const snapshot=await p.evaluate(()=>window.omc.invoke('snapshot'));
  const shape=Object.values(snapshot.document.pagesById[snapshot.document.pages[0]].objects).find(s=>s.name==='Undo text proof');assert.ok(shape);
  const contentText=s=>{if(!s)return '';const walk=n=>typeof n.text==='string'?n.text:(n.children||[]).map(walk).join('');return s.content?walk(s.content):s.text||'';};
  const read=async()=>{const s=await p.evaluate(()=>window.omc.invoke('snapshot'));return contentText(s.document.pagesById[s.document.pages[0]].objects[shape.id]);};
  const waitText=async expected=>{for(let i=0;i<150;i++){if(await read()===expected)return;await p.waitForTimeout(25);}assert.equal(await read(),expected);};
  const menu=async label=>app.evaluate(({Menu},label)=>Menu.getApplicationMenu().items.find(i=>i.label==='Edit').submenu.items.find(i=>i.label===label).click(),label);
  const edit=async()=>{
    const rect=await p.locator(`[data-node-id="${shape.id}"]`).boundingBox();assert.ok(rect);
    await p.mouse.dblclick(rect.x+Math.min(20,rect.width/2),rect.y+Math.min(15,rect.height/2));
    await p.locator('textarea[aria-label="Text editor"]').waitFor({state:'attached'});
    assert.equal(await p.evaluate(()=>document.activeElement?.getAttribute('aria-label')),'Text editor');
    await p.keyboard.press('End');
  };
  await edit();let typed='Hello';for(const ch of ' abc'){await p.keyboard.type(ch);typed+=ch;await waitText(typed);assert.equal(await p.evaluate(()=>document.activeElement?.getAttribute('aria-label')),'Text editor','local acknowledgement must preserve the live text session');}
  // The native application-menu path must reach the live text session rather than global history.
  await menu('Undo');await waitText('Hello ');assert.equal(await p.locator('textarea[aria-label="Text editor"]').count(),1);
  await menu('Undo');await waitText('Hello');
  await menu('Redo');await waitText('Hello ');await menu('Redo');await waitText('Hello abc');
  await p.keyboard.press('Escape');await p.locator('textarea[aria-label="Text editor"]').waitFor({state:'detached'});
  // MCP must refuse to undo the later user's typing, even though this agent made the preceding edit.
  const refused=await tool('undo');assert.ok(refused.isError,JSON.stringify(refused));assert.match(JSON.stringify(refused),/nothing_to_undo/);await waitText('Hello abc');
  await menu('Undo');await waitText('Hello');
  await menu('Redo');await waitText('Hello abc');
  // A second typing session is a separate global operation, while its keystrokes remain one step.
  await edit();await p.keyboard.type(' HUMAN',{delay:20});await waitText('Hello abc HUMAN');await p.keyboard.press('Escape');
  await p.locator('textarea[aria-label="Text editor"]').waitFor({state:'detached'});await menu('Undo');await waitText('Hello abc');
  await menu('Redo');await waitText('Hello abc HUMAN');
  await p.evaluate(()=>window.omc.invoke('flush'));
  await fs.mkdir('docs/qa',{recursive:true});await p.screenshot({path:'docs/qa/text-undo-editor.png'});assert.deepEqual(errors,[]);
  const result={passed:true,checks:['real textarea typing after MCP edit','durable acknowledgements preserve the live text session and focus','native-menu Undo/Redo routes to active text session','one global Undo restores the whole ended typing session','native-menu Redo restores all keystrokes','agent Undo refuses later user input','separate text sessions remain separate undo steps'],rendererErrors:errors,at:new Date().toISOString()};
  await fs.writeFile('docs/qa/text-undo-result.json',JSON.stringify(result,null,2));console.log('PASS actual Electron text typing, native-menu Undo/Redo, session grouping and agent ownership');
}finally{
  if(app){await app.evaluate(({app})=>app.exit(0)).catch(()=>{});if(child.exitCode===null&&child.signalCode===null)await new Promise(resolve=>child.once('exit',resolve));}
  await fs.rm(profile,{recursive:true,force:true});
}
