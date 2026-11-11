// Documentation-only checks: no app startup, network requests, or user-data writes.
import {readFile,stat,readdir} from 'node:fs/promises';import path from 'node:path';import assert from 'node:assert/strict';import yaml from 'js-yaml';import {JSDOM} from 'jsdom';
const readmes=['README.md','README-ko.md','README-ja.md','README-zh-CN.md'];
const nativeFiles=(await readdir('docs/native-engine')).filter(x=>x.endsWith('.md')).sort().map(x=>'docs/native-engine/'+x);
const nativeSpecs=new Set(['docs/NATIVE_ENGINE_PLAN.md',...nativeFiles]);
const files=[...readmes,'CONTRIBUTING.md','SECURITY.md',...['GETTING_STARTED','ARCHITECTURE','TESTING','TROUBLESHOOTING'].map(x=>`docs/${x}.md`),...['ko','ja','zh-CN'].map(x=>`docs/contributing/${x}.md`),'.github/PULL_REQUEST_TEMPLATE.md',...['MIT_READINESS','DEPENDENCIES','REPLACEMENT'].map(x=>`docs/licensing/${x}.md`),'docs/NATIVE_ENGINE_PLAN.md','docs/DESIGN_FILE_IMPORT.md','IMPLEMENTATION.md',...nativeFiles];
const contents=new Map(await Promise.all(files.map(async file=>[file,await readFile(file,'utf8')])));
const slug=s=>s.toLowerCase().replace(/<[^>]*>|[`*]/g,'').replace(/[^\p{L}\p{N}_ -]/gu,'').replace(/ /g,'-');
let checked=0,jsonExamples=0;
function withoutFences(raw,file){
 const prose=[];let fence=null;
 for(const [index,line] of raw.split('\n').entries()){
  const match=line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
  if(fence){
   if(match&&match[1][0]===fence.marker&&match[1].length>=fence.length&&!match[2].trim()){
    if(nativeSpecs.has(file)&&fence.info==='json'){
     assert.doesNotThrow(()=>JSON.parse(fence.body.join('\n')),file+': invalid JSON example at line '+fence.line);jsonExamples++;
    }
    fence=null;
   }else fence.body.push(line);
   prose.push('');continue;
  }
  if(match){fence={marker:match[1][0],length:match[1].length,info:match[2].trim(),line:index+1,body:[]};prose.push('');}
  else prose.push(line);
 }
 assert.ok(!fence,file+': unclosed code fence at line '+fence?.line);
 return prose.join('\n');
}
for(const [file,raw] of contents){
 const text=withoutFences(raw,file);
 const links=[...[...text.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)].map(m=>m[1]),...[...text.matchAll(/(?:href|src)="([^"]+)"/g)].map(m=>m[1])];
 for(const link of links){
  if(/^(?:https?:|mailto:)/.test(link))continue;
  assert.ok(!link.startsWith('/'),'Use portable repository links: '+file+' '+link);
  const [relative,hash]=link.split('#'),target=relative?path.resolve(path.dirname(file),decodeURIComponent(relative)):path.resolve(file);const info=await stat(target).catch(()=>null);assert.ok(info,`Broken link in ${file}: ${link}`);checked++;
  if(hash&&info.isFile()&&target.endsWith('.md')){const body=await readFile(target,'utf8'),ids=[...[...body.matchAll(/\bid="([^"]+)"/g)].map(m=>m[1]),...[...body.matchAll(/^#{1,6} (.+)$/gm)].map(m=>slug(m[1]))];assert.ok(ids.includes(decodeURIComponent(hash)),`Missing anchor in ${file}: ${link}`);}
 }
 for(const m of text.matchAll(/<img\b[^>]*>/g))assert.match(m[0],/\balt="[^"]+"/,`Missing image alt text in ${file}`);
}
const blocks=s=>[...s.matchAll(/```sh\n([\s\S]*?)```/g)].map(m=>m[1]);
for(const file of readmes){const s=contents.get(file);assert.deepEqual(blocks(s),blocks(contents.get('README.md')),`Command drift: ${file}`);for(const id of ['quick-start','screenshots','components','mcp','contributing'])assert.ok(s.includes(`id="${id}"`),`${file}: ${id}`);for(const n of ['170','31'])assert.ok(s.includes(n),`${file}: missing shared fact ${n}`);for(const other of readmes)if(other!==file)assert.ok(s.includes(other),`${file}: language switch to ${other}`);}
for(const file of ['bug_report.yml','feature_request.yml']){const form=yaml.load(await readFile('.github/ISSUE_TEMPLATE/'+file,'utf8'));assert.ok(form.name&&form.description&&Array.isArray(form.body));const ids=new Set();for(const field of form.body){assert.ok(['markdown','input','textarea','dropdown','checkboxes'].includes(field.type));if(field.type==='markdown')continue;assert.ok(field.id&&!ids.has(field.id));ids.add(field.id);assert.ok(field.attributes?.label);if(field.type==='dropdown'||field.type==='checkboxes')assert.ok(field.attributes.options.length);}assert.ok(!form.labels&&!form.assignees,'Do not assume remote labels or assignees');}
assert.equal(yaml.load(await readFile('.github/ISSUE_TEMPLATE/config.yml','utf8')).blank_issues_enabled,false);
for(const file of await readdir('assets/readme')){if(!file.endsWith('.svg'))continue;const dom=new JSDOM(await readFile('assets/readme/'+file,'utf8'),{contentType:'image/svg+xml'});assert.ok(dom.window.document.querySelector('title'));dom.window.close();}
console.log(`PASS ${files.length} documents, ${checked} local links/images, balanced code fences, ${jsonExamples} native JSON examples, four-language commands/anchors, three GitHub YAML files and SVG assets`);
