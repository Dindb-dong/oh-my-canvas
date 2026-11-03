import {Client} from '@modelcontextprotocol/sdk/client/index.js';import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {promises as fs} from 'node:fs';import {createHash} from 'node:crypto';import assert from 'node:assert/strict';
const registration=JSON.parse(await fs.readFile('docs/qa/codex-mcp-registration.json','utf8'));const {command,args,env}=registration.transport;
const c=new Client({name:'Codex installed-app verification',version:'1'},{capabilities:{}});const text=r=>r.content.filter(i=>i.type==='text').map(i=>i.text).join('\n');
async function call(name,args={}){const r=await c.callTool({name,arguments:args});assert.ok(!r.isError,text(r));return r;}
try{
  await c.connect(new StdioClientTransport({command,args,env}));const list=await c.listTools();
  const tree=text(await call('get_tree',{depth:1}));const id=tree.match(/\b(a[0-9a-z]+) frame "01 \/ Studio UI system"/)?.[1];assert.ok(id,'Open the UI Kit in the installed app before running this check');
  await call('write_html',{target:id,position:'last',html:'<div style="position:absolute;left:64px;top:1010px;width:900px;height:24px;font-family:IBM Plex Sans;font-size:13px;color:#326950">Installed MCP edit verification</div>'});
  assert.match(text(await call('find',{text:'Installed MCP edit verification'})),/1 found/);
  await call('undo');assert.match(text(await call('find',{text:'Installed MCP edit verification'})),/0 found/);
  const shot=await call('screenshot',{id,mode:'overview'});for(const item of shot.content)if(item.type==='image')await fs.writeFile('docs/design/canvas-components.png',Buffer.from(item.data,'base64'));
  const hash=async p=>createHash('sha256').update(await fs.readFile(p)).digest('hex');const installedSha256=await hash('/Applications/Oh My Canvas.app/Contents/Resources/app.asar');assert.equal(installedSha256,await hash('release/mac-arm64/Oh My Canvas.app/Contents/Resources/app.asar'));
  await fs.writeFile('docs/qa/installed-result.json',JSON.stringify({passed:true,installed:'/Applications/Oh My Canvas.app',tools:list.tools.length,installedSha256,checks:['installed app archive equals verified package','Codex registered stdio command connects','existing UI Kit survives reinstall','MCP write/read/undo through installed app','actual component screenshot readback'],at:new Date().toISOString()},null,2));console.log('PASS installed app: registered MCP, actual edit/read/undo, retained UI Kit, packaged archive match');
}finally{await c.close();}
