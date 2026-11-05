import {_electron} from 'playwright';
import {promises as fs} from 'node:fs';
import os from 'node:os';import path from 'node:path';import assert from 'node:assert/strict';
import {documentFixture,waitFor} from '../tests/helpers.mjs';
import {changesBetween} from '../core/document.mjs';import {Replica} from '../core/replica.mjs';import {Collaboration} from '../core/collaboration.mjs';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
const dir=await fs.mkdtemp(path.join(os.tmpdir(),'omc-independent-host-'));let app,guest,replica;const clients=[],checks=[];
const record=name=>{checks.push(name);console.log('PASS '+name);};
try{
 app=await _electron.launch({executablePath:process.env.OMC_TEST_EXECUTABLE,args:[...process.env.OMC_TEST_EXECUTABLE?[]:[process.cwd()],`--profile=${dir}`],timeout:30000});const p=await app.firstWindow();await p.locator('#new').waitFor();
 const invoke=(action,data)=>p.evaluate(({action,data})=>window.omc.invoke(action,data),{action,data});
 const initial=await invoke('create',{title:'Initialization proof',document:documentFixture()});
 await assert.rejects(invoke('bootstrap',{id:'wrong',nonce:initial.bootstrapNonce,changes:[]}));
 await assert.rejects(invoke('bootstrap',{id:initial.id,nonce:'wrong',changes:[]}));
 const hosted=await invoke('host',{port:0}),invite=await invoke('invite',{address:`127.0.0.1:${hosted.port}`});
 replica=new Replica();guest=new Collaboration({replica,id:initial.id,title:initial.title,name:'Race oracle'});await guest.join(invite);
 const before=replica.document,after=structuredClone(before);after.pagesById.page.objects.label.y=222;replica.patch(changesBetween(before,after));
 await waitFor(async()=>(await invoke('snapshot')).document.pagesById.page.objects.label.y===222);
 const stale=structuredClone(initial.document);stale.pagesById.page.objects.label.name='Initial normalization';
 const retry=await invoke('bootstrap',{id:initial.id,nonce:initial.bootstrapNonce,changes:changesBetween(initial.document,stale)});
 assert.equal(retry.bootstrapRetry,true);assert.equal(retry.document.pagesById.page.objects.label.y,222);assert.notEqual(retry.bootstrapNonce,initial.bootstrapNonce);
 await assert.rejects(invoke('bootstrap',{id:initial.id,nonce:initial.bootstrapNonce,changes:[]}));
 const normalized=structuredClone(retry.document);normalized.pagesById.page.objects.label.name='Initialized after race';
 const done=await invoke('bootstrap',{id:initial.id,nonce:retry.bootstrapNonce,changes:changesBetween(retry.document,normalized)});
 assert.equal(done.document.pagesById.page.objects.label.y,222);assert.equal(done.document.pagesById.page.objects.label.name,'Initialized after race');
 await assert.rejects(invoke('bootstrap',{id:initial.id,nonce:retry.bootstrapNonce,changes:[]}));
 assert.deepEqual((await invoke('undo')).document,done.document);
 record('nonce/id/replay validation, remote-base retry, durable normalization and no phantom Undo');
 await guest.close();guest=null;replica.destroy();replica=null;
 await p.locator('#home').click();await p.locator(`[data-open="${initial.id}"]`).click();await p.waitForFunction(()=>!!window.lvMcp,null,{timeout:30000});
 const snap=await invoke('snapshot');assert.equal(snap.document.pagesById.page.objects.label.y,222);
 record('initialized document survives real editor mount and reopen');
 const config=JSON.parse((await invoke('mcp-info',{transport:'stdio'})).config).mcpServers['oh-my-canvas'];
 for(let i=0;i<2;i++){const c=new Client({name:'independent-host-'+i,version:'1'},{capabilities:{}});clients.push(c);await c.connect(new StdioClientTransport(config));}
 const call={name:'create_board',arguments:{name:'Idempotent board',width:120,height:90},_meta:{'oh-my-canvas/idempotency-key':'retry-once'}};
 const first=await clients[0].callTool(call),second=await clients[0].callTool(call);assert.ok(!first.isError,JSON.stringify(first));assert.deepEqual(second,first);
 assert.equal(Object.values((await invoke('snapshot')).document.pagesById.page.objects).filter(s=>s.name==='Idempotent board').length,1);
 const collision=await clients[0].callTool({...call,arguments:{...call.arguments,name:'Different payload'}});assert.equal(collision.isError,true);
 const other=await clients[1].callTool({name:'create_board',arguments:{name:'Second author',width:100,height:100}});assert.ok(!other.isError,JSON.stringify(other));
 assert.equal((await clients[0].callTool({name:'undo',arguments:{}})).isError,true);
 assert.ok(!(await clients[1].callTool({name:'undo',arguments:{}})).isError);
 record('real stdio metadata retry deduplication/collision rejection and two-author Undo isolation');
 const inserted=await p.evaluate(()=>window.lvMcp.handleToolCall('preview-fixture','write_html',{target:'board',position:'last',html:'<div data-name="Preview drag proof" style="position:absolute;left:300px;top:300px;width:100px;height:80px;background:#2563eb"></div>'}));assert.ok(!inserted.isError,JSON.stringify(inserted));
 const initialDrag=await invoke('snapshot');let dragShape=Object.values(initialDrag.document.pagesById.page.objects).find(s=>s.name==='Preview drag proof');assert.ok(dragShape);
 const unclamped=await p.evaluate(id=>window.lvMcp.handleToolCall('preview-fixture','update',{id,style:{left:'',top:''}}),dragShape.id);assert.ok(!unclamped.isError,JSON.stringify(unclamped));dragShape=(await invoke('snapshot')).document.pagesById.page.objects[dragShape.id];
 const info=await invoke('host',{port:0}),remoteInvite=await invoke('invite',{address:`127.0.0.1:${info.port}`});replica=new Replica();guest=new Collaboration({replica,id:initial.id,title:initial.title,name:'Preview remote'});await guest.join(remoteInvite);
 await p.locator('#editor [data-tool="move"]').click();const box=await p.locator(`[data-shape-id="${dragShape.id}"]`).first().boundingBox();assert.ok(box);
 // Frames must be selected before the move tool starts a drag.
 await p.mouse.click(box.x+box.width/2,box.y+box.height/2);
 await p.mouse.move(box.x+box.width/2,box.y+box.height/2);await p.mouse.down();await p.mouse.move(box.x+box.width/2+40,box.y+box.height/2+20,{steps:6});
 assert.equal((await invoke('snapshot')).document.pagesById.page.objects[dragShape.id].x,dragShape.x,'Live gesture must remain nondurable');
 const live=await p.evaluate(id=>window.lvMcp.handleToolCall('preview-reader','get_tree',{id,depth:1,detail:'detailed'}),dragShape.id);assert.equal(live.structuredContent.tree.x,dragShape.x+40,'Live preview should follow the pointer before remote projection');
 const remoteBefore=replica.document,remoteAfter=structuredClone(remoteBefore);remoteAfter.pagesById.page.objects.label.name='Remote during preview';replica.patch(changesBetween(remoteBefore,remoteAfter));
 await waitFor(async()=>JSON.stringify(await p.evaluate(()=>window.lvMcp.handleToolCall('preview-reader','find',{name:'Remote during preview'}))).includes('Remote during preview'));
 await p.mouse.up();await waitFor(async()=>Math.abs((await invoke('snapshot')).document.pagesById.page.objects[dragShape.id].x-(dragShape.x+40))<.1);
 assert.equal((await invoke('snapshot')).document.pagesById.page.objects[dragShape.id].y,dragShape.y+20);
 await waitFor(()=>Math.abs(replica.document.pagesById.page.objects[dragShape.id].x-(dragShape.x+40))<.1);
 await p.keyboard.press(process.platform==='darwin'?'Meta+z':'Control+z');await waitFor(async()=>Math.abs((await invoke('snapshot')).document.pagesById.page.objects[dragShape.id].x-dragShape.x)<.1);
 assert.equal((await invoke('snapshot')).document.pagesById.page.objects.label.name,'Remote during preview');
 record('active native gesture survives incoming TLS projection, commits durably and author Undo preserves remote edit');
 await guest.close();guest=null;replica.destroy();replica=null;

 const persisted=await invoke('snapshot');await invoke('flush');assert.equal(persisted.id,initial.id);
 await fs.mkdir('docs/qa',{recursive:true});await fs.writeFile('docs/qa/independent-host-result.json',JSON.stringify({passed:true,checks,at:new Date().toISOString()},null,2));
}finally{
 for(const c of clients)await c.close().catch(()=>{});await guest?.close();replica?.destroy();
 if(app){await app.evaluate(({app})=>app.exit(0)).catch(()=>{});const child=app.process();if(child.exitCode===null&&child.signalCode===null)await new Promise(r=>child.once('exit',r));}
 await fs.rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100});
}
