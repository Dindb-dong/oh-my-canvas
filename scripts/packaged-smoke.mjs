import {_electron as electron} from 'playwright';
import {promises as fs} from 'node:fs';
import os from 'node:os';import path from 'node:path';import assert from 'node:assert/strict';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {createMcpFetch} from '../core/mcp-fetch.mjs';
import {extractFile} from '@electron/asar';import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {TOOLS} from '../dist/tool-defs.mjs';
const dir=await fs.mkdtemp(path.join(os.tmpdir(),'omc-packaged-'));
const primary=execFileSync('git',['worktree','list','--porcelain'],{encoding:'utf8'}).split('\n')[0].slice(9);
const output=path.join(primary,'internal/docs/vector-authoring/delivery');await fs.mkdir(output,{recursive:true});
const executablePath=path.resolve('release/mac-arm64/Oh My Canvas.app/Contents/MacOS/Oh My Canvas');
let app,client,child;
async function assertPortableLinks(directory){
  for(const entry of await fs.readdir(directory,{withFileTypes:true})){
    const file=path.join(directory,entry.name);
    if(entry.isSymbolicLink()){
      const target=await fs.readlink(file),resolved=path.resolve(path.dirname(file),target);
      assert.ok(!path.isAbsolute(target)&&resolved.startsWith(path.resolve('release/mac-arm64/Oh My Canvas.app')+path.sep),`Bundle link escapes the app: ${file} -> ${target}`);
    }else if(entry.isDirectory())await assertPortableLinks(file);
  }
}
try{
  await assertPortableLinks(path.resolve('release/mac-arm64/Oh My Canvas.app'));
  app=await electron.launch({env:{...process.env,OMC_TEST_BACKGROUND:'1'},executablePath,args:[`--profile=${dir}`],timeout:30000});child=app.process();const page=await app.firstWindow();assert.equal(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].isVisible()),false,'Packaged synthetic test window must start hidden');await page.locator('#start-sample').click();await page.waitForFunction(()=>!!window.lvMcp);
  const runtime=await app.evaluate(()=>process.versions.electron),expected=JSON.parse(await fs.readFile('node_modules/electron/package.json','utf8')).version;assert.equal(runtime,expected);
  const archive=path.resolve('release/mac-arm64/Oh My Canvas.app/Contents/Resources/app.asar'),hash=createHash('sha256');
  for(const directory of ['core','electron','dist/assets'])for(const name of (await fs.readdir(directory)).sort()){
    const file=path.join(directory,name);if(!/\.(mjs|cjs|js|css)$/.test(name))continue;
    const current=await fs.readFile(file);assert.deepEqual(extractFile(archive,file),current,`Packaged source differs: ${file}`);hash.update(file);hash.update(current);
  }
  const sourceSha256=hash.digest('hex');
  const config=JSON.parse((await page.evaluate(()=>window.omc.invoke('mcp-info',{transport:'stdio'}))).config).mcpServers['oh-my-canvas'];
  assert.equal(config.command,executablePath);assert.ok(!config.args[0].includes('app.asar/'));
  client=new Client({name:'packaged-smoke',version:'1'},{capabilities:{}});await client.connect(new StdioClientTransport(config));
  assert.deepEqual((await client.listTools()).tools.map(tool=>tool.name).sort(),TOOLS.map(tool=>tool.name).sort());
  const result=await client.callTool({name:'create_board',arguments:{name:'Packaged MCP',width:320,height:200}});assert.ok(!result.isError,JSON.stringify(result));
  await client.close();client=null;
  const descriptor=JSON.parse(await fs.readFile(path.join(dir,'mcp-runtime.json'),'utf8'));
  assert.equal(descriptor.version,2);assert.equal('token' in descriptor,false);
  const token=await fs.readFile(path.join(dir,'mcp-token-v2'),'utf8');
  client=new Client({name:'packaged-http-smoke',version:'1'},{capabilities:{}});
  const transport=new StreamableHTTPClientTransport(new URL(`https://127.0.0.1:${descriptor.port}/mcp`),{fetch:createMcpFetch(await fs.readFile(descriptor.certFile,'utf8')),requestInit:{headers:{Authorization:`Bearer ${token}`}}});
  await client.connect(transport);assert.deepEqual((await client.listTools()).tools.map(tool=>tool.name).sort(),TOOLS.map(tool=>tool.name).sort());
  assert.ok(!(await client.callTool({name:'get_context',arguments:{}})).isError);
  await transport.terminateSession();await client.close();client=null;
  const tree=await page.evaluate(()=>window.lvMcp.handleToolCall('smoke','get_tree',{depth:1}));assert.match(JSON.stringify(tree),/Packaged MCP/);
  await page.screenshot({path:path.join(output,'packaged-app.png')});
  await page.evaluate(()=>window.omc.invoke('flush'));
  await fs.writeFile(path.join(output,'packaged-result.json'),JSON.stringify({passed:true,electron:runtime,sourceSha256,checks:['portable bundle framework/dependency links','packaged app launches','packaged source matches current core/main/renderer bytes','packaged runtime fonts/WASM','bundled MCP CLI through Electron Node mode','durable MCP edit','packaged SDK Streamable HTTP initialize/list/call'],at:new Date().toISOString()},null,2));
  console.log('PASS packaged macOS app + standalone bundled MCP CLI + persistent edit');
}catch(error){console.error('PACKAGED CHECK FAILED:',error);throw error;}finally{
  await client?.close().catch(()=>{});
  if(app){await app.evaluate(({app})=>app.exit(0)).catch(()=>{});if(child)await new Promise(r=>{if(child.exitCode!==null||child.signalCode!==null)r();else child.once('exit',r);});}
  await fs.rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:150});
}
