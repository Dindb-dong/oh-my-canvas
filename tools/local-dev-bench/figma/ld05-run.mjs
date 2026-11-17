import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash, randomBytes} from 'node:crypto';
import {copyFile, mkdir, readFile, writeFile} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

import {mergeLD05NativeHandoff, planLD05NativeCycle, planLD05Refresh} from './ld05.mjs';
import {withFigmaMCP} from './ld03-model.mjs';
import {sourceProbe} from '../omc-native/ld05.mjs';
import {publishCandidate} from '../publish-candidate.mjs';

const bench = fileURLToPath(new URL('..',import.meta.url));
const sha = bytes=>createHash('sha256').update(bytes).digest('hex');
const color = rgb => {
  const match = rgb.match(/^rgb\((\d+), (\d+), (\d+)\)$/);
  assert.ok(match && match.slice(1).every(value=>Number(value)<=255));
  return '#'+Buffer.from(match.slice(1).map(Number)).toString('hex');
};
const px = value => {
  assert.match(value,/^\d+px$/);
  return Number(value.slice(0,-2));
};

export function projectSource(fixture,wanted,browser,assets) {
  assert.deepEqual(browser.states.map(row=>row.width),fixture.widths);
  const [{cards,afterPress,form,conditional,styles}] = browser.states;
  assert.deepEqual(cards.map(card=>card.label),wanted.cards);
  assert.equal(afterPress,wanted.keyboard_after);
  assert.ok(browser.evaluatedHtml.includes('<h1>'+fixture.title+'</h1>'));
  const labels = {title:fixture.title, check_control_name:wanted.check_control_name,
    keyboard_before:wanted.keyboard_before, keyboard_after:afterPress, component:wanted.component};
  if (form) {
    assert.equal(form.saved,wanted.valid_result+': '+form.retainedValue);
    Object.assign(labels,{field_name:wanted.field_name,invalid_result:form.invalid.message,
      submitted_value:form.retainedValue,valid_result:wanted.valid_result});
  }
  if (conditional) {
    assert.deepEqual(conditional,{keyboardShows:true,keyboardHides:true});
    labels.conditional='Show extra item';
  }
  return {labels,cards:cards.map(card=>{
    const image=card.src.match(/^\.\/assets\/([a-z-]+\.png)$/)?.[1];
    assert.ok(image && assets[image] && card.loaded);
    return {title:card.label,detail:card.detail,variant:card.variant,image};
  }),gap:px(styles.gap),radius:px(styles.radius),headingSize:px(styles.heading),
  wrap:styles.wrap==='wrap',accent:color(styles.accent),
  variantBorder:styles.variantBorder.startsWith('rgb(')?color(styles.variantBorder):'#718096',
  images:Object.fromEntries(Object.entries(assets).map(([key,bytes])=>[key,[...bytes]]))};
}

export function verifyProjection(scope,observed,source,assets) {
  assert.deepEqual([observed.document_id,observed.page_id,observed.root_id,observed.list_id],
    [scope.fileKey,scope.page,scope.root,scope.list]);
  assert.deepEqual(observed.labels,source.labels);
  assert.equal(observed.gap,source.gap);
  assert.equal(observed.direction,source.wrap?'HORIZONTAL':'VERTICAL');
  if (source.wrap) assert.equal(observed.wrap,'WRAP');
  assert.equal(observed.cards.length,source.cards.length);
  for (const [index,card] of source.cards.entries()) {
    const row=observed.cards[index], native=scope.cards[index];
    assert.deepEqual([row.frameId,row.headingId,row.detailId,row.assetId],
      [native.frame,native.heading,native.detail,native.asset]);
    assert.deepEqual([row.title,row.detail,row.variant,row.radius,row.headingSize,row.accent],
      [card.title,card.detail,card.variant,source.radius,source.headingSize,source.accent]);
    assert.equal(sha(Buffer.from(row.imageBytes)),sha(assets[card.image]),'Native source asset differs');
    if (source.wrap) assert.equal(row.flexBasis,224);
  }
}

const resultOf = response=>{
  assert.notEqual(response.isError,true,response.content?.[0]?.text ?? 'Figma call failed');
  return JSON.parse(response.content[0].text);
};
async function createSession(invoke,fileKey) {
  const response=await invoke({fileKey,description:'Registered synthetic LD05 source refresh and handoff'},'create_session');
  assert.notEqual(response.isError,true,'Figma rejected isolated LD05 session');
  const text=response.content?.map(item=>item.text??'').join('\n')??'';
  let parsed;
  try {parsed=JSON.parse(text);} catch {}
  const id=response.structuredContent?.sessionId??response.structuredContent?.session_id??parsed?.sessionId??parsed?.session_id??
    text.match(/session(?:[_ ]id)?[`"* ]*[:=][`"* ]*([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})/i)?.[1];
  assert.match(id??'',/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i);
  return id;
}

export async function runFigmaLD05(family,atlasScope,output,candidate) {
  assert.ok(['route-board','supply-ledger'].includes(family));
  const {fileKey,before}=JSON.parse(await readFile(atlasScope,'utf8'));
  assert.equal(before.document_id,fileKey);
  const anchors=before.pages.map(page=>({id:page.native_id,name:page.name}));
  assert.equal(anchors.length,10);
  const pageName='LD05 '+family+' '+randomBytes(6).toString('hex');
  const sourceDir=join(output,'source');
  const env={...process.env,PYTHONDONTWRITEBYTECODE:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1'};
  const readJSON=(script,...args)=>JSON.parse(execFileSync('python3',['-B',join(bench,script),...args],{env}));
  const sourceCommand=(name,...args)=>readJSON('ld05_source.py',name,family,sourceDir,...args);
  const fixture=readJSON('ld05_contract.py',family);
  const initial=sourceCommand('prepare');
  const git=(...args)=>execFileSync('git',['-C',sourceDir,'-c','user.name=LD05 Benchmark','-c','user.email=ld05@example.invalid',
    '-c','core.hooksPath=/dev/null','-c','commit.gpgsign=false',...args],{env,encoding:'utf8'}).trim();
  const commit=(message,files)=>{git('add','--',...files);git('commit','--quiet','-m',message);return git('rev-parse','HEAD');};
  git('init','--quiet','--template=');
  const save=(leaf,value)=>writeFile(join(output,leaf),JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});
  const evidence={fixture_sha256:fixture.fixture_sha256,starting_source_sha256:initial.source_sha256,
    initial_source_commit:commit('Prepare registered LD05 source',Object.keys(initial.files)),pageName,cycles:[]};
  const assets=Object.fromEntries(await Promise.all(Object.keys(initial.files).filter(key=>key.endsWith('.png')).map(async key=>{
    const bytes=await readFile(join(sourceDir,key));
    assert.equal(sha(bytes),initial.files[key]);
    return [key.split('/').at(-1),bytes];
  })));
  await save('registered-fixture.json',fixture);
  await withFigmaMCP(async write=>{
    const sessionId=await createSession(write,fileKey);
    await withFigmaMCP(async observe=>{
      let scope, previous=initial;
      for (const [index,rules] of fixture.cycles.entries()) {
        const cycle=index+1;
        const prefix='cycle-'+cycle+'-';
        const patched=sourceCommand('patch','--cycle',String(cycle));
        const changesBetween=(a,b)=>Object.keys(a.files).filter(path=>a.files[path]!==b.files[path]).sort();
        assert.deepEqual(changesBetween(previous,patched),['app.mjs','index.html']);
        const sourceCommit=commit('Apply registered source patch '+cycle,['app.mjs','index.html']);
        const observedSource=await sourceProbe(sourceDir,fixture,patched,cycle,rules.source_state);
        await save(prefix+'browser-source.json',observedSource.states);
        const source=projectSource(fixture,rules.source_state,observedSource,assets);
        const call=async (invoke,stage,request)=>{
          const response=await invoke(request);
          await save(prefix+stage+'.json',response);
          return resultOf(response);
        };
        scope=await call(write,'refresh',planLD05Refresh({fileKey,sessionId,pageName,scope,source,anchors}));
        const changes={...rules.result,imageHash:scope.imageHashes[rules.result.asset],
          ...(cycle===3?{imageBytes:[...assets[rules.result.asset]]}:{})};
        const plan=planLD05NativeCycle({fileKey,sessionId,scope,cycle,changes});
        const refreshed=await call(observe,'refresh-read',plan.read);
        verifyProjection(scope,refreshed,source,assets);
        await call(write,'edit',plan.edit);
        const reobserved=await call(observe,'persisted-read',plan.read);
        assert.deepEqual(reobserved.labels,source.labels);
        const [css,data]=await Promise.all(['theme.css','data.mjs'].map(name=>readFile(join(sourceDir,name),'utf8')));
        const merged=await mergeLD05NativeHandoff({fixture,scope,cycle,reobserved,css,data,
          assetSha256:sha(assets[rules.result.asset])});
        await writeFile(join(sourceDir,'theme.css'),merged.css);
        if (cycle===3) await writeFile(join(sourceDir,'data.mjs'),merged.data);
        const manifest=sourceCommand('manifest');
        const changed=changesBetween(patched,manifest);
        assert.deepEqual(changed,cycle===3?['data.mjs','theme.css']:['theme.css']);
        assert.equal(manifest.files['card.mjs'],initial.files['card.mjs']);
        const resultCommit=commit('Merge observed Figma design '+cycle,changed);
        const clean=join(output,'clean-'+cycle);
        for (const [name,expected] of Object.entries(manifest.files)) {
          const file=join(clean,name);
          await mkdir(dirname(file),{recursive:true,mode:0o700});
          await copyFile(join(sourceDir,name),file);
          assert.equal(sha(await readFile(file)),expected);
          if(name.endsWith('.mjs')) execFileSync(process.execPath,['--check',file]);
        }
        const reproduced=await sourceProbe(clean,fixture,manifest,cycle,rules.result);
        await save(prefix+'browser-clean.json',reproduced.states);
        const result={source_parent_sha256:previous.source_sha256,source_patch_sha256:patched.source_sha256,
          result_checkout_sha256:manifest.source_sha256,source_patch_commit:sourceCommit,result_commit:resultCommit,
          refreshed_canvas:rules.source_state,persisted_canvas:rules.result,source_result:rules.result,
          checked_widths:reproduced.states.map(row=>row.width),canvas_editable:true,clean_build:true,
          behavior_tests_passed:true,component_reused:true,no_missing_assets:true,normal_editor_reopen:'NOT_OBSERVED'};
        evidence.cycles.push(result);
        await save(prefix+'result.json',result);
        console.log(JSON.stringify({cycle,phase:'PERSISTED_READ_AND_CLEAN_SOURCE_VERIFIED',pageName}));
        previous=manifest;
      }
    });
  },{createSession:true});
  await publishCandidate(candidate,evidence);
}

if (process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  const [family,scope]=process.argv.slice(2);
  const {OMC_BENCH_OUTPUT_DIR:output,OMC_BENCH_CANDIDATE:candidate}=process.env;
  assert.ok(scope&&output&&candidate,'Use run_attempt.py with a registered atlas scope');
  await runFigmaLD05(family,scope,output,candidate);
}
