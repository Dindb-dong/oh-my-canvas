// Fresh exporter gates and fresh-history data oracles; no source snapshot is created.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {relativeName,allowed,inspectText,checkLinks,reseedOMC,parseArgs} from '../scripts/prepare-publication.mjs';
import {Replica} from '../core/replica.mjs';
import {changesBetween} from '../core/document.mjs';
import {encodeFile,decodeFile} from '../core/storage.mjs';
const root=fileURLToPath(new URL('..',import.meta.url));
const digest=value=>createHash('sha256').update(value).digest('hex');
const record=(name,text)=>({path:name,bytes:Buffer.from(text)});
const synthetic=()=>({pages:['p'],pagesById:{p:{id:'p',name:'Synthetic',objects:{root:{id:'root',type:'frame',parentId:'root',enclosingFrameId:'root',x:0,y:0,width:100,height:100,childIds:['box']},box:{id:'box',type:'rect',parentId:'root',enclosingFrameId:'root',x:10,y:20,width:30,height:40,name:'Visible'}}}}});
test('allowlist excludes history, worktrees, dependencies, private artifacts and unapproved QA',()=>{
 const evidence=new Set(['docs/qa/reviewed.png']);
 for(const name of ['.git/config','core/.git/secrets','node_modules/pkg/a.js','vendor/editor/a.ts','apps/editor-lab/a.ts','work/tmp.txt','release/app.zip','docs/independent/source-comparison.json','docs/licensing/source-provenance.json','docs/independent/PLAN.md','docs/independent/implementation-state.json','docs/qa/old.png','public/canvaskit.wasm','public/fonts/generated.woff2','src/.env.production','fixtures/key.pem'])assert.equal(allowed(name,evidence),false,name);
 for(const name of ['editor/document/index.ts','core/document.mjs','public/fonts/IBM-Plex-Sans-LICENSE.txt','public/fonts/Noto-Sans-KR-LICENSE.txt','LICENSE','package-lock.json','licenses/native/texts/skia--LICENSE','fixtures/fonts/fonts/a.woff2','docs/qa/reviewed.png','docs/independent/publication-policy.md'])assert.equal(allowed(name,evidence),true,name);
});
test('portable paths and CLI options reject traversal and malformed requests',()=>{
 for(const name of ['../escape','/absolute','a/../b','a\\b','a//b'])assert.throws(()=>relativeName(name));
 assert.equal(relativeName('docs/public.md'),'docs/public.md');assert.throws(()=>parseArgs(['--unknown']),/Unknown option/);assert.throws(()=>parseArgs(['--out']),/needs/);assert.throws(()=>parseArgs(['--check','--init-git']),/cannot initialize/);assert.equal(parseArgs(['--check']).check,true);
});
test('privacy errors identify categories without echoing matched secrets',()=>{
 const fake='AKIA'+'A'.repeat(16);assert.throws(()=>inspectText('README.md',fake),error=>error.message.includes('AWS access-key')&&!error.message.includes(fake));
 assert.throws(()=>inspectText('docs/guide.md',['','Users','private-user','private-file'].join('/')),/absolute home path/);
 assert.doesNotThrow(()=>inspectText('README.md','Use ~/Documents; configure your own credentials.'));
});
test('project links require included targets and valid anchors',()=>{
 const good=[record('README.md','[Guide](docs/guide.md#details)\n![Icon](assets/icon.svg)'),record('docs/guide.md','# Guide\n## Details\n'),record('assets/icon.svg','<svg/>')];assert.doesNotThrow(()=>checkLinks(good));
 assert.throws(()=>checkLinks([record('README.md','[Missing](docs/excluded.md)')]),/excluded or missing/);assert.throws(()=>checkLinks([record('README.md','[Missing](#absent)')]),/missing anchor/);assert.throws(()=>checkLinks([record('README.md','[Escape](../private.md)')]),/escapes snapshot/);
});
test('upstream notice link exemption requires exact manifest bytes and canonical origin',()=>{
 const notice=record('licenses/native/texts/example--README.md','[Upstream sibling](not-in-this-snapshot.md)\n');const entry={file:'texts/example--README.md',bytes:notice.bytes.length,sha256:digest(notice.bytes),sourceUrl:'https://example.org/pinned/README.md',upstreamPath:'README.md'};
 const manifest=()=>record('licenses/native/manifest.json',JSON.stringify({files:[entry]}));assert.doesNotThrow(()=>checkLinks([notice,manifest()]));
 assert.throws(()=>checkLinks([notice]),/no checksum manifest/);assert.throws(()=>checkLinks([{...notice,bytes:Buffer.from('modified')},manifest()]),/checksum mismatch/);
 delete entry.sourceUrl;assert.throws(()=>checkLinks([notice,manifest()]),/canonical upstream route/);
 assert.throws(()=>checkLinks([record('licenses/native/README.md','[Project authored](missing.md)'),manifest()]),/excluded or missing/);
});
test('actual preserved upstream Markdown hashes match the pinned manifest before exemption',async()=>{
 const manifest=record('licenses/native/manifest.json',await fs.readFile(path.join(root,'licenses/native/manifest.json'),'utf8'));
 const names=['libjpeg-turbo--LICENSE.md','wuffs--README.md'];const notices=await Promise.all(names.map(async name=>({path:'licenses/native/texts/'+name,bytes:await fs.readFile(path.join(root,'licenses/native/texts',name))})));
 assert.doesNotThrow(()=>checkLinks([manifest,...notices]));
});
test('fresh OMC bytes are deterministic, preserve visible data/id/title and discard deleted history',()=>{
 const replica=new Replica({document:synthetic()});let decoded;
 try{
  let before=replica.document,after=structuredClone(before);after.pagesById.p.objects.box.name='DELETED-HISTORY-'+ 'q'.repeat(20000);replica.patch(changesBetween(before,after),'Hidden prior value');
  before=replica.document;after=structuredClone(before);after.pagesById.p.objects.box.name='Visible final';replica.patch(changesBetween(before,after),'Current value');
  assert.equal(Buffer.from(replica.state).includes(Buffer.from('DELETED-HISTORY-')),true);
  const input=Buffer.from(encodeFile({id:'11111111-1111-4111-8111-111111111111',title:'Synthetic publication fixture',createdAt:'2026-01-01T00:00:00.000Z',replica,thumbnail:'data:image/png;base64,AAAA'}));const original=Buffer.from(input);
  const first=reseedOMC('docs/design/system/component-library.omc',input),second=reseedOMC('docs/design/system/component-library.omc',input);
  assert.deepEqual(first.bytes,second.bytes);assert.deepEqual(input,original);decoded=decodeFile(first.bytes.toString());assert.equal(decoded.id,'11111111-1111-4111-8111-111111111111');assert.equal(decoded.title,'Synthetic publication fixture');assert.deepEqual(decoded.replica.document,replica.document);assert.equal(decoded.thumbnail,undefined);assert.equal(decoded.replica.undo.undoStack.length,0);assert.ok(first.transform.newStateBytes<first.transform.previousStateBytes);assert.equal(Buffer.from(decoded.state,'base64').includes(Buffer.from('DELETED-HISTORY-')),false);
 }finally{decoded?.replica.destroy();replica.destroy();}
});
test('CLI refuses an existing output directory without writing snapshot files',async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'omc-publication-gate-'));try{await fs.writeFile(path.join(directory,'keep.txt'),'owned sentinel');assert.throws(()=>execFileSync(process.execPath,['scripts/prepare-publication.mjs','--out',directory],{cwd:root,stdio:'pipe'}),error=>error.stderr.toString().includes('already exists'));assert.deepEqual(await fs.readdir(directory),['keep.txt']);assert.equal(await fs.readFile(path.join(directory,'keep.txt'),'utf8'),'owned sentinel');}finally{await fs.rm(directory,{recursive:true,force:true});}
});
