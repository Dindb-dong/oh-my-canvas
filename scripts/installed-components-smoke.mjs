import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {promises as fs} from 'node:fs';import {createHash} from 'node:crypto';import assert from 'node:assert/strict';
const registration=JSON.parse(await fs.readFile('docs/qa/codex-mcp-registration.json','utf8'));
const c=new Client({name:'Codex installed components verification',version:'1'},{capabilities:{}});
async function call(name,args={}){const r=await c.callTool({name,arguments:args});assert.ok(!r.isError,JSON.stringify(r));return r;}
try{
 await c.connect(new StdioClientTransport(registration.transport));
 const tools=await c.listTools();assert.equal(tools.tools.length,19);
 const before=(await call('components')).structuredContent;assert.equal(before.total,172);
 const source=before.components.find(v=>v.name.includes('Style=Primary')&&v.name.includes('Size=Medium')&&v.name.includes('State=Default'));assert.ok(source);
 const made=(await call('component',{action:'instance',source:source.id,x:100,y:100})).structuredContent.selection[0];
 assert.match(JSON.stringify(await call('get_tree',{id:made,depth:1})),/instance/);
 await call('undo');
 const absent=await c.callTool({name:'get_tree',arguments:{id:made,depth:1}});assert.ok(absent.isError,'Undo must remove the inserted instance');
 assert.equal((await call('components')).structuredContent.total,172);
 const hash=async p=>createHash('sha256').update(await fs.readFile(p)).digest('hex');
 const installedSha256=await hash('/Applications/Oh My Canvas.app/Contents/Resources/app.asar');assert.equal(installedSha256,await hash('release/mac-arm64/Oh My Canvas.app/Contents/Resources/app.asar'));
 await fs.writeFile('docs/qa/installed-components-result.json',JSON.stringify({passed:true,tools:19,components:172,installedSha256,checks:['registered Codex stdio connects','installed package hash matches','existing detailed library opens','linked instance insert/read/undo','source component records retained'],at:new Date().toISOString()},null,2));
 console.log('PASS installed components: 19 MCP tools, 172 records, linked instance insert/read/undo and verified package hash');
}finally{await c.close();}
