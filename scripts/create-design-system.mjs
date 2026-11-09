import {requireDocumentTarget} from './desktop-test-pages.mjs';
/** Dogfood the public MCP API: every sample becomes a real main, grouped into variant sets. */
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {promises as fs} from 'node:fs';import path from 'node:path';import os from 'node:os';import {decodeFile} from '../core/storage.mjs';import assert from 'node:assert/strict';
const out='docs/design/system';await fs.mkdir(out,{recursive:true});
const C={blue:'#2563eb',hover:'#1d4ed8',pressed:'#1e40af',sky:'#7dd3fc',lavender:'#c4b5fd',ink:'#202124',muted:'#64748b',line:'#e2e8f0',soft:'#eff6ff'};
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const box=(x,y,w,h,body='',style='',attrs='')=>`<div ${attrs} style="position:absolute;left:${x}px;top:${y}px;width:${w}px;height:${h}px;${style}">${body}</div>`;
const txt=(x,y,w,text,size=14,color=C.ink,attrs='')=>`<div ${attrs} style="position:absolute;left:${x}px;top:${y}px;width:${w}px;height:${Math.ceil(size*1.6)}px;font-family:IBM Plex Sans;font-size:${size}px;line-height:1.4;color:${color}">${esc(text)}</div>`;
const label=(ref,x,y,w,text,size=14,color=C.ink)=>txt(x,y,w,text,size,color,`data-ref="${ref}-label" data-name="Label"`);
const icon=(ref,x,y,symbol='＋',color=C.ink)=>txt(x,y,24,symbol,16,color,`data-ref="${ref}-icon" data-name="Icon"`);
const rect=(x,y,w,h,color,r=6,stroke='none')=>box(x,y,w,h,'',`background:${color};border:${stroke};border-radius:${r}px;`);
const combos=axes=>Object.entries(axes).reduce((rows,[key,values])=>rows.flatMap(r=>values.map(value=>({...r,[key]:value}))),[{}]);
const stateColor=s=>s==='Hover'?C.hover:s==='Pressed'?C.pressed:C.blue;
const families=[];
function family(name,axes,render,layout={}){families.push({name,axes,render,cols:layout.cols??4,cellW:layout.cellW??320,cellH:layout.cellH??120,property:layout.property??'Label'});}
family('Button',{Style:['Primary','Secondary','Ghost'],Size:['Small','Medium','Large'],State:['Default','Hover','Pressed','Disabled']},(p,r)=>{
 const h={Small:32,Medium:40,Large:48}[p.Size],w={Small:132,Medium:156,Large:180}[p.Size],disabled=p.State==='Disabled',primary=p.Style==='Primary';
 const bg=disabled?'#f1f5f9':primary?stateColor(p.State):p.State==='Default'?'#ffffff':C.soft,fg=disabled?'#94a3b8':primary?'#ffffff':C.blue;
 return {w,h,html:rect(0,0,w,h,bg,8,p.Style==='Secondary'?`1px solid ${C.line}`:'none')+icon(r,12,(h-24)/2,'＋',fg)+label(r,40,(h-22)/2,w-48,'New canvas',14,fg)};
},{cellW:280,cellH:110});
family('Icon button',{Style:['Filled','Outline'],Size:['Small','Medium','Large'],State:['Default','Hover','Pressed','Disabled']},(p,r)=>{
 const s={Small:32,Medium:40,Large:48}[p.Size],fg=p.State==='Disabled'?'#94a3b8':p.Style==='Filled'?'#ffffff':C.blue,bg=p.State==='Disabled'?'#f1f5f9':p.Style==='Filled'?stateColor(p.State):p.State==='Default'?'#ffffff':C.soft;
 return {w:s,h:s,html:rect(0,0,s,s,bg,8,p.Style==='Outline'?`1px solid ${C.line}`:'none')+label(r,(s-18)/2,(s-24)/2,24,'＋',18,fg)};
},{cellW:280,cellH:110});
family('Text field',{Size:['Medium','Large'],State:['Default','Hover','Focus','Filled','Error','Disabled']},(p,r)=>{
 const h=p.Size==='Large'?48:40,focus=p.State==='Focus',err=p.State==='Error',disabled=p.State==='Disabled';
 return {w:270,h:h+54,html:txt(0,0,250,'Canvas name',12)+rect(0,24,270,h,disabled?'#f8fafc':'#fff',8,`${focus?2:1}px solid ${err?'#dc2626':focus?C.blue:p.State==='Hover'?'#94a3b8':C.line}`)+label(r,12,24+(h-22)/2,242,['Filled','Focus'].includes(p.State)?'My next idea':'Enter a name',14,disabled?'#cbd5e1':p.State==='Filled'?C.ink:C.muted)+txt(0,h+30,265,err?'Please enter a valid name.':'Give your idea a name.',11,err?'#b91c1c':C.muted)};
},{cols:4,cellW:340,cellH:160,property:'Value'});
for(const kind of ['Checkbox','Radio','Switch'])family(kind,{State:['Default','Hover','Checked','Mixed','Disabled','Disabled checked']},(p,r)=>{
 const on=['Checked','Disabled checked','Mixed'].includes(p.State),disabled=p.State.startsWith('Disabled'),fg=disabled?'#94a3b8':C.ink,bg=disabled?'#e2e8f0':on?C.blue:'#fff';
 let control;
 if(kind==='Switch')control=rect(0,4,40,24,bg,12,on?'none':`1px solid ${C.line}`)+rect(on?20:4,8,16,16,on?'#fff':'#94a3b8',8);
 else control=rect(0,5,20,20,bg,kind==='Radio'?10:5,`1px solid ${on?bg:p.State==='Hover'?C.blue:C.line}`)+(on?(kind==='Radio'?rect(6,11,8,8,'#fff',4):icon(r,2,3,p.State==='Mixed'?'−':'✓','#fff')):'');
 return {w:220,h:36,html:control+label(r,kind==='Switch'?52:32,6,168,'Option label',14,fg)};
},{cols:3,cellW:380,cellH:120});
family('Navigation tab',{Destination:['Canvas','Components','MCP','Team','Settings'],State:['Default','Hover','Active','Disabled']},(p,r)=>{
 const names={Canvas:'캔버스',Components:'컴포넌트',MCP:'MCP 연결',Team:'팀 협업',Settings:'설정'},active=p.State==='Active';
 return {w:230,h:44,html:rect(0,0,230,44,active?C.soft:p.State==='Hover'?'#f8fafc':'#fff',8)+icon(r,14,10,'◇',active?C.blue:C.muted)+label(r,46,11,166,names[p.Destination],14,p.State==='Disabled'?'#cbd5e1':active?C.pressed:C.ink)};
},{cellW:320,cellH:110});
family('Badge',{Tone:['Neutral','Blue','Sky','Lavender','Warning','Danger'],Size:['Small','Medium']},(p,r)=>{
 const tones={Neutral:['#f1f5f9','#475569'],Blue:[C.soft,C.blue],Sky:['#e0f2fe','#075985'],Lavender:['#f3e8ff','#6b21a8'],Warning:['#fffbeb','#92400e'],Danger:['#fef2f2','#991b1b']},[bg,fg]=tones[p.Tone],h=p.Size==='Small'?24:30;
 return {w:112,h,html:rect(0,0,112,h,bg,14)+label(r,12,(h-19)/2,94,p.Tone==='Danger'?'Needs attention':p.Tone==='Warning'?'Pending':'Ready',12,fg)};
},{cellW:320,cellH:100});
family('Select field',{Size:['Compact','Regular'],State:['Default','Hover','Focus','Disabled']},(p,r)=>{
 const h=p.Size==='Compact'?34:40,disabled=p.State==='Disabled';
 return {w:180,h,html:rect(0,0,180,h,disabled?'#f8fafc':p.State==='Hover'?'#f8fafc':'#fff',8,`${p.State==='Focus'?2:1}px solid ${p.State==='Focus'?C.blue:p.State==='Hover'?'#cbd5e1':C.line}`)+label(r,12,(h-20)/2,136,'Last edited',12,disabled?'#cbd5e1':'#475569')+txt(151,(h-22)/2,20,'⌄',16,C.muted)};
},{cellW:320,cellH:110});
family('Select menu',{State:['Default','Hover','Selected','Disabled']},(p,r)=>({w:280,h:222,html:rect(0,0,280,222,'#fff',10,`1px solid ${C.line}`)+label(r,16,14,246,'Move to folder',12,C.muted)+['Personal','Team project','Design system','Archive'].map((v,i)=>rect(8,48+i*40,264,36,i===1&&p.State!=='Default'&&p.State!=='Disabled'?C.soft:'#fff',6)+txt(20,55+i*40,230,v,14,p.State==='Disabled'?'#cbd5e1':C.ink)).join('')}),{cellW:340,cellH:300});
family('List row',{Status:['Draft','Ready','Syncing','Error'],State:['Default','Hover','Selected','Disabled']},(p,r)=>({w:420,h:68,html:rect(0,0,420,68,p.State==='Selected'?C.soft:p.State==='Hover'?'#f8fafc':'#fff',8,`1px solid ${p.State==='Selected'?'#93c5fd':C.line}`)+rect(14,16,36,36,'#e0e7ff',8)+icon(r,20,21,'▧',C.blue)+label(r,64,12,250,'Design system library',14,p.State==='Disabled'?'#94a3b8':C.ink)+txt(64,36,250,'Edited just now · Local canvas',11,C.muted)+txt(332,24,80,p.Status,12,p.Status==='Error'?'#b91c1c':C.blue)}),{cols:3,cellW:480,cellH:125});
family('Canvas card',{Kind:['Document','Asset'],State:['Default','Hover','Selected','Loading','Error','Empty']},(p,r)=>{
 const bg=p.State==='Selected'?C.soft:'#f8fafc';let preview='';
 if(['Default','Hover','Selected'].includes(p.State))preview=rect(48,28,200,142,'#ffffff',6)+rect(68,50,110,12,C.blue,3)+rect(68,78,150,7,'#e2e8f0',3)+rect(68,98,70,48,C.sky,5)+rect(148,98,80,48,C.lavender,5);
 else preview=txt(36,83,250,p.State==='Loading'?'◌  Loading preview':p.State==='Error'?'Preview unavailable':'＋  Add content',14,C.muted);
 return {w:300,h:280,html:rect(0,0,300,280,'#fff',12,`1px solid ${p.State==='Selected'?C.blue:p.State==='Hover'?'#94a3b8':C.line}`)+rect(1,1,298,196,bg,10)+preview+label(r,18,218,262,p.Kind==='Document'?'Studio 01':'Image asset',14)+txt(18,247,260,'Edited just now',12,C.muted)};
},{cols:4,cellW:350,cellH:350});
family('Tooltip',{Placement:['Top','Bottom'],Tone:['Dark','Light']},(p,r)=>({w:230,h:42,html:rect(0,0,230,42,p.Tone==='Dark'?'#202124':'#fff',8,`1px solid ${C.line}`)+label(r,14,11,206,'Connect your local agent',13,p.Tone==='Dark'?'#fff':C.ink)}),{cellW:340,cellH:120});
family('Dialog',{State:['Default','Loading','Error','Success']},(p,r)=>({w:440,h:260,html:rect(0,0,440,260,'#fff',12,`1px solid ${C.line}`)+label(r,24,22,390,'Share this canvas',21)+txt(24,65,390,'Invite up to three teammates to your workspace.',13,C.muted)+rect(24,107,392,48,'#f8fafc',8,`1px solid ${p.State==='Error'?'#fca5a5':C.line}`)+txt(38,122,360,p.State==='Error'?'That invitation could not be opened.':p.State==='Success'?'Invitation copied.':'Local collaboration · End-to-end TLS',12,p.State==='Error'?'#b91c1c':C.muted)+rect(268,197,148,40,C.blue,8)+txt(286,207,125,p.State==='Loading'?'Connecting…':'Create invitation',13,'#fff')+rect(171,197,85,40,'#fff',8,`1px solid ${C.line}`)+txt(189,207,62,'Cancel',13)}),{cols:3,cellW:500,cellH:330});

const prepared=families.map((f,idx)=>{
 const variants=combos(f.axes),w=f.cols*f.cellW+128,h=Math.max(600,Math.ceil(variants.length/f.cols)*f.cellH+220);
 let body=txt(64,40,w-128,`${String(idx+1).padStart(2,'0')} / ${f.name}`,30)+txt(64,96,w-128,`${variants.length} variants · ${Object.keys(f.axes).join(' × ')} · Editable main components`,14,C.muted);
 const entries=variants.map((props,i)=>{
  const ref=`v${i}`,x=64+i%f.cols*f.cellW,y=198+Math.floor(i/f.cols)*f.cellH,shape=f.render(props,ref),name=Object.entries(props).map(([k,v])=>`${k}=${v}`).join(', ');
  body+=txt(x,y-25,f.cellW-20,Object.values(props).join(' / '),11,C.muted)+box(x,y,shape.w,shape.h,shape.html,'',`data-ref="${ref}" data-name="${esc(name)}"`);return {ref,props,name};
 });
 return {name:f.name,w,h,entries,property:f.property,html:box(0,0,w,h,body,'background:#ffffff;', 'data-ref="sheet"')};
});
const manifest={name:'Oh My Canvas / Component Library',palette:C,families:prepared.map(({html,...rest})=>rest),variants:prepared.reduce((n,f)=>n+f.entries.length,0)};
await fs.writeFile(path.join(out,'manifest.json'),JSON.stringify(manifest,null,2));for(const [i,f] of prepared.entries())await fs.writeFile(path.join(out,`${String(i+1).padStart(2,'0')}-${f.name.toLowerCase().replaceAll(' ','-')}.html`),f.html);
if(process.argv.includes('--prepare')){console.log('Prepared',manifest.variants,'real component variants in',prepared.length,'families');process.exit(0);}
const c=new Client({name:'Codex detailed design-system dogfooding',version:'1'},{capabilities:{}});
const command=process.env.OMC_MCP_COMMAND||process.execPath,args=process.env.OMC_MCP_COMMAND?['/Applications/Oh My Canvas.app/Contents/Resources/mcp-cli.cjs']:[path.resolve('dist/mcp-cli.cjs')];
const records=[];
let resumeDoc;
if(process.argv.includes('--resume')){
 const previous=JSON.parse(await fs.readFile(path.join(out,'mcp-result.json'),'utf8'));
 const dir=process.env.OMC_DATA_DIR||path.join(os.homedir(),'Library/Application Support/oh-my-canvas');
 for(const file of await fs.readdir(path.join(dir,'documents'))){if(!file.endsWith('.omc'))continue;const record=decodeFile(await fs.readFile(path.join(dir,'documents',file)));const doc=record.replica.document;record.replica.destroy();if(record.title==='Oh My Canvas Component Library'&&doc.components?.[previous.families[0].components[0].componentId])resumeDoc=doc;}
 assert.ok(resumeDoc,'Saved generated document could not be found');
 for(const record of previous.families){const page=Object.values(resumeDoc.pagesById).find(p=>p.objects[resumeDoc.components[record.components[0].componentId].mainId]);records.push({...record,board:Object.values(page.objects).find(s=>s.name?.endsWith('/ '+record.name)).id,set:resumeDoc.components[record.components[0].componentId].variantSetId,components:record.components.map(c=>({...c,id:resumeDoc.components[c.componentId].mainId}))});}
}

let documentId;
async function call(name,args={}){const r=await c.callTool({name,arguments:{...args,documentId}});if(r.isError)throw Error(name+': '+JSON.stringify(r));return r;}
try{
 await c.connect(new StdioClientTransport({command,args,env:{...process.env,...(process.env.OMC_MCP_COMMAND?{ELECTRON_RUN_AS_NODE:'1'}:{})}}));documentId=await requireDocumentTarget(c);
 const context=await call('get_context');assert.ok(context.structuredContent,'Open a document in the app first');
 if(resumeDoc){
  const live=(await call('components')).structuredContent;
  assert.deepEqual(live.components.map(c=>c.id).sort(),Object.keys(resumeDoc.components).sort(),'Open the saved generated document before resuming; no document edits were made');
  const compositionBoard=Object.values(resumeDoc.pagesById).flatMap(p=>Object.values(p.objects)).find(s=>s.name==='15 / Compositions');
  const compositions=Object.values(resumeDoc.components).filter(c=>['Composition / Workspace toolbar','Composition / Create canvas dialog'].includes(c.name));
  if(compositionBoard){
   assert.equal(compositions.length,2,'Composition authoring was interrupted; inspect the existing composition board before resuming. No document edits were made');
   assert.equal(live.total,manifest.variants+2,'Completed library count mismatch');
   console.log('PASS resume: completed library retained without edits:',live.total,'components');
   process.exitCode=0;
   await c.close();
   process.exit(0);
  }
 }
 for(const [i,f] of prepared.entries()){
  if(records.some(r=>r.name===f.name)){console.log('Resume: retained',f.name);continue;}
  const page=resumeDoc&&Object.values(resumeDoc.pagesById)[0],existing=page&&Object.values(page.objects).find(s=>s.name===`${String(i+1).padStart(2,'0')} / ${f.name}`);
  const board=existing?.id??(await call('create_board',{name:`${String(i+1).padStart(2,'0')} / ${f.name}`,width:f.w,height:f.h})).structuredContent.id;
  await call('update',{id:board,style:{position:'absolute',left:`${i%4*1700}px`,top:`${Math.floor(i/4)*1550}px`}});
  let refs={};
  if(existing){const sheet=page.objects[existing.childIds[0]];for(const v of f.entries){const root=Object.values(page.objects).find(s=>s.parentId===sheet.id&&s.name===v.name);assert.ok(root,'Missing partial variant '+v.name);refs[v.ref]=root.id;for(const kid of Object.values(page.objects).filter(s=>s.parentId===root.id)){if(kid.name==='Label')refs[v.ref+'-label']=kid.id;if(kid.name==='Icon')refs[v.ref+'-icon']=kid.id;}}}
  else refs=(await call('write_html',{target:board,position:'last',html:f.html})).structuredContent.refs;
  const ids=[],components=[];
  for(const v of f.entries){
   const id=refs[v.ref],old=existing&&resumeDoc.components?.[page.objects[id]?.componentId],made=old?{structuredContent:{componentId:old.id}}:await call('component',{action:'create',id});ids.push(id);
   const property=old?.properties?.find(p=>p.name===f.property),bound=property?{structuredContent:{property:property.id}}:await call('component',{action:'property',id,name:f.property,propertyType:'text',layer:refs[v.ref+'-label']});
   if(refs[v.ref+'-icon']&&!old?.properties?.some(p=>p.name==='Show icon'))await call('component',{action:'property',id,name:'Show icon',propertyType:'boolean',layer:refs[v.ref+'-icon']});
   components.push({id,componentId:made.structuredContent.componentId,property:bound.structuredContent.property,props:v.props});
  }
  const combined=await call('component',{action:'combine',ids,name:f.name});
  records.push({name:f.name,board,set:combined.structuredContent.selection[0],components});
  const shot=await call('screenshot',{id:board,mode:'overview'});for(const item of shot.content)if(item.type==='image')await fs.writeFile(path.join(out,`${String(i+1).padStart(2,'0')}-preview.png`),Buffer.from(item.data,'base64'));
  await fs.writeFile(path.join(out,'mcp-result.json'),JSON.stringify({families:records,variants:records.reduce((n,r)=>n+r.components.length,0)},null,2));
  console.log(`${i+1}/${prepared.length} ${f.name}: ${components.length} linked variants`);
 }
 // A composition made from real nested instances, so changing a source flows through it too.
 const board=(await call('create_board',{name:'15 / Compositions',width:1400,height:1000})).structuredContent.id;
 await call('update',{id:board,style:{position:'absolute',left:'3400px',top:'4650px'}});
 const html=box(0,0,1400,1000,txt(64,44,1250,'15 / Connected compositions',30)+txt(64,104,1250,'These frames contain real nested instances from the library.',14,C.muted)+box(64,180,900,100,rect(0,0,900,100,'#fff',10,`1px solid ${C.line}`),'','data-ref="toolbar" data-name="Workspace toolbar"')+box(64,350,500,340,rect(0,0,500,340,'#fff',12,`1px solid ${C.line}`)+txt(24,24,440,'Create a canvas',24),'','data-ref="dialog" data-name="Create canvas dialog"'),'background:#fff;');
 await fs.writeFile(path.join(out,'15-compositions.html'),html);
 const refs=(await call('write_html',{target:board,position:'last',html})).structuredContent.refs;
 const source=(family,match)=>records.find(r=>r.name===family).components.find(c=>Object.entries(match).every(([k,v])=>c.props[k]===v));
 const button=source('Button',{Style:'Primary',Size:'Medium',State:'Default'}),secondary=source('Button',{Style:'Secondary',Size:'Medium',State:'Default'}),field=source('Text field',{Size:'Medium',State:'Default'}),tab=source('Navigation tab',{Destination:'Canvas',State:'Active'});
 const positions=async id=>{const r=await call('get_styles',{ids:[id],keys:[]});const t=r.content.find(x=>x.type==='text').text;const m=t.match(/ x(-?\d+) y(-?\d+)/);return {x:Number(m[1]),y:Number(m[2])};};
 const toolbar=await positions(refs.toolbar),dialog=await positions(refs.dialog);
 for(const [target,src,x,y,value] of [[refs.toolbar,tab,toolbar.x+150,toolbar.y+50,'Recents'],[refs.toolbar,button,toolbar.x+770,toolbar.y+50,'New canvas'],[refs.dialog,field,dialog.x+170,dialog.y+140,'Untitled canvas'],[refs.dialog,secondary,dialog.x+210,dialog.y+270,'Cancel'],[refs.dialog,button,dialog.x+390,dialog.y+270,'Create canvas']]){
  const id=(await call('component',{action:'instance',source:src.componentId,parent:target,x,y})).structuredContent.selection[0];await call('component',{action:'set_property',id,property:src.property,value});
 }
 await call('component',{action:'create',id:refs.toolbar,name:'Composition / Workspace toolbar'});await call('component',{action:'create',id:refs.dialog,name:'Composition / Create canvas dialog'});
 const preview=await call('screenshot',{id:board,mode:'overview'});for(const item of preview.content)if(item.type==='image')await fs.writeFile(path.join(out,'15-preview.png'),Buffer.from(item.data,'base64'));
 const check=(await call('components')).structuredContent;assert.equal(check.total,manifest.variants+2);
 await fs.writeFile(path.join(out,'verification.json'),JSON.stringify({passed:true,variants:manifest.variants,families:records.length,compositions:2,components:check.total,nestedInstances:5,createdVia:'Actual Electron app public MCP, not a flattened import',at:new Date().toISOString()},null,2));
 console.log('PASS detailed reusable library:',check.total,'components and five nested instances');
}finally{await c.close();}
