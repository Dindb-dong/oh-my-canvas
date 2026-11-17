import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash, randomBytes} from 'node:crypto';
import {cp, mkdir, readFile, writeFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

import {mergeExtraCard, mergeStyles, sourceProbe} from '../omc-native/ld05.mjs';
import {connectEditor, createAccount, getMcpEndpoint, loopbackOrigin, newFile, waitForBackend} from '../penpot-ld02.mjs';
import {publishCandidate} from '../publish-candidate.mjs';
import {benchRequire, Client, StreamableHTTPClientTransport} from '../replays/mcp.mjs';
import {decodeNativeResult, readAfterAttach} from './ld09.mjs';

const bench = fileURLToPath(new URL('..', import.meta.url));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const assetPath = /^\.\/assets\/([a-z-]+\.png)$/;
const nativeId = /^[a-f0-9-]{36}$/i;
const json = value => JSON.stringify(value) + '\n';
const hexColor = rgb => {
  const channels = rgb.match(/^rgb\((\d+), (\d+), (\d+)\)$/)?.slice(1);
  assert.ok(channels?.length === 3 && channels.every(value => Number(value) <= 255));
  return '#' + Buffer.from(channels.map(Number)).toString('hex');
};
const px = number => {
  assert.match(number, /^\d+px$/);
  return Number(number.slice(0, -2));
};

function plugin(fileId, cycle, body) {
  assert.match(fileId, nativeId);
  assert.ok([1, 2, 3].includes(cycle));
  return `if (penpot.currentFile.id !== ${JSON.stringify(fileId)}) throw new Error("Wrong isolated LD05 file");
const root = penpot.currentPage.root, name = "LD05 cycle ${cycle}";
const lookup = (parent, key) => {
  const found = parent.children.filter(node => node.name === key);
  if (found.length !== 1) throw new Error("Expected one editable LD05 layer: " + key);
  return found[0];
};
const paint = color => ({fillColor:color,fillOpacity:1});
const attach = (parent, shape, key, width, height) => {
  shape.name = key;
  shape.resize(width,height);
  if (parent.flex) parent.flex.appendChild(shape);
  else parent.appendChild(shape);
  return shape;
};
const text = (parent, key, value, size, color) => {
  const shape = attach(parent,penpot.createText(value),key,Math.min(212,parent.width),32);
  shape.fontSize = String(size);
  shape.fills = [paint(color)];
  return shape;
};
const flex = (shape, dir, gap) => {
  const layout = shape.addFlexLayout();
  layout.dir = dir;
  layout.rowGap = layout.columnGap = gap;
  layout.alignItems = layout.alignContent = layout.justifyContent = "start";
  layout.horizontalSizing = "fix";
  layout.verticalSizing = "auto";
  return layout;
};
const upload = async asset => {
  const uploaded = await penpot.uploadMediaData(asset.name,Uint8Array.from(atob(asset.base64),c=>c.charCodeAt(0)),"image/png");
  if (uploaded.width !== 64 || uploaded.height !== 36) throw new Error("Unexpected LD05 source image dimensions");
  return [{fillOpacity:1,fillImage:{id:uploaded.id,width:uploaded.width,height:uploaded.height,mtype:uploaded.mtype,
    name:uploaded.name,keepAspectRatio:true}}];
};
const stroke = (shape, color) => {shape.strokes = [{strokeColor:color,strokeOpacity:1,strokeWidth:2,
  strokeStyle:"solid",strokeAlignment:"inner"}];};
${body}`;
}

export function sourceSpec(fixture, wanted, observations) {
  assert.deepEqual(observations.states.map(state => state.width), fixture.widths);
  const [{cards, afterPress, form, conditional, styles}] = observations.states;
  assert.deepEqual(cards.map(card => card.label), wanted.cards);
  assert.equal(afterPress, wanted.keyboard_after);
  const labels = {
    check_control_name:wanted.check_control_name, keyboard_before:wanted.keyboard_before, keyboard_after:afterPress,
    component:wanted.component, title:fixture.title,
  };
  if (form) {
    labels.field_name = wanted.field_name;
    labels.invalid_result = form.invalid.message;
    labels.submitted_value = form.retainedValue;
    assert.ok(form.saved.endsWith(': ' + form.retainedValue));
    labels.valid_result = form.saved.slice(0, -form.retainedValue.length - 2);
  }
  if (conditional) labels.conditional = 'Show extra item';
  assert.equal(Object.hasOwn(labels,'field_name'), Object.hasOwn(wanted,'field_name'));
  return {
    labels, cards:cards.map(card => {
      const image = card.src.match(assetPath)?.[1];
      assert.ok(card.loaded && image);
      return {...card, image};
    }),
    gap:px(styles.gap), radius:px(styles.radius), heading_size:px(styles.heading),
    wrap:styles.wrap === 'wrap', accent:hexColor(styles.accent),
  };
}

export function seedCycle(fileId, cycle, source, media) {
  return plugin(fileId,cycle,`if (root.children.some(shape => shape.name === name)) throw new Error("Cycle already exists");
const spec = ${JSON.stringify(source)};
const board = penpot.createBoard();
board.name = name;
board.resize(1088,500);
board.x = 0;
board.y = ${(cycle - 1) * 1080};
flex(board,"column",8);
for (const [key,value] of Object.entries(spec.labels)) text(board,key,value,20,"#182132");
const list = attach(board,penpot.createBoard(),"cards",1024,420);
const layout = flex(list,spec.wrap ? "row" : "column",spec.gap);
layout.wrap = spec.wrap ? "wrap" : "nowrap";
const images = new Map();
const media = ${JSON.stringify(media)};
for (const [index,row] of spec.cards.entries()) {
  if (!images.has(row.image)) images.set(row.image, await upload(media[row.image]));
  const card = attach(list,penpot.createBoard(),"card " + index,spec.wrap ? 224 : 480,120);
  if (spec.wrap) card.layoutChild.minWidth = 224;
  card.borderRadius = spec.radius;
  card.fills = [paint("#ffffff")];
  card.setPluginData("ld05-source-variant",row.variant);
  flex(card,"column",4);
  attach(card,penpot.createRectangle(),"image",64,36).fills = images.get(row.image);
  text(card,"heading",row.label,spec.heading_size,spec.accent);
  text(card,"detail",row.detail,16,"#182132");
}
return board.id;`);
}

export function editCycle(fileId, cycle, wanted, replacement) {
  return plugin(fileId,cycle,`const design = ${JSON.stringify(wanted)};
const list = lookup(lookup(root,name),"cards");
const cards = [...list.children].sort((left,right)=>Number(left.name.slice(5))-Number(right.name.slice(5)));
if (cards.length !== design.cards.length) throw new Error("Unexpected native card inventory");
${cycle === 1 ? `list.flex.rowGap = list.flex.columnGap = design.gap;
for (const card of cards) {
  card.borderRadius = design.radius;
  lookup(card,"heading").fontSize = String(design.heading_size);
}` : cycle === 2 ? `list.flex.dir = "row";
list.flex.wrap = "wrap";
for (const card of cards) {
  card.resize(224,card.height);
  card.layoutChild.minWidth = 224;
  lookup(card,"heading").fills = [paint(design.accent)];
}` : `const card = cards.at(-1);
stroke(card,design.variant_border);
card.setPluginData("ld05-source-variant", design.variant);
lookup(card,"image").fills = await upload(${JSON.stringify(replacement)});
lookup(card,"detail").characters = design.copy;`}
return list.id;`);
}

export function readCycle(fileId, cycle) {
  return plugin(fileId,cycle,`const board = lookup(root,name), list = lookup(board,"cards");
const usable = shape => !shape.blocked && !shape.hidden;
if (board.type !== "board" || list.type !== "board" || !usable(board) || !usable(list) || !list.flex) {
  throw new Error("Expected visible editable native LD05 boards");
}
const labels = {};
for (const shape of board.children.filter(layer => layer.id !== list.id)) {
  if (shape.type !== "text" || !usable(shape)) throw new Error("Non-editable source capture");
  labels[shape.name] = {id:shape.id, text:shape.characters};
}
const images = new Map(), cards = [];
for (const [index,card] of [...list.children].sort((left,right)=>Number(left.name.slice(5))-Number(right.name.slice(5))).entries()) {
  if (card.name !== "card " + index || card.type !== "board" || !usable(card) || card.children.length !== 3) {
    throw new Error("Unexpected native card structure");
  }
  const heading=lookup(card,"heading"), detail=lookup(card,"detail"), picture=lookup(card,"image");
  if ([heading,detail].some(shape=>shape.type!=="text"||!usable(shape)) ||
      picture.type!=="rectangle" || !usable(picture)) throw new Error("Non-editable native card children");
  const image=picture.fills[0]?.fillImage;
  if (!image || image.width !== 64 || image.height !== 36) throw new Error("Native image missing");
  if (!images.has(image.id)) {
    const bytes = await image.data();
    if (!bytes.length || bytes.length > 65536) throw new Error("Unexpected LD05 stored media size");
    images.set(image.id,Array.from(bytes));
  }
  cards.push({id:card.id,headingId:heading.id,detailId:detail.id,imageId:picture.id,mediaId:image.id,
    imageBytes:images.get(image.id),heading:heading.characters,detail:detail.characters,
    headingSize:Number(heading.fontSize),accent:heading.fills[0]?.fillColor?.toLowerCase(),radius:card.borderRadius,
    minWidth:card.layoutChild.minWidth,variant:card.getPluginData("ld05-source-variant"),
    variantBorder:card.strokes[0]?.strokeColor});
}

return {documentId:penpot.currentFile.id,boardId:board.id,listId:list.id,labels,cards,
  direction:list.flex.dir,wrap:list.flex.wrap,gap:list.flex.rowGap,columnGap:list.flex.columnGap};`);
}

export function hashStoredMedia(snapshot) {
  return {...snapshot,cards:snapshot.cards.map(({imageBytes,...card})=>{
    assert.ok(Array.isArray(imageBytes) && imageBytes.length > 0 && imageBytes.length <= 65536 &&
      imageBytes.every(byte=>Number.isInteger(byte) && byte >= 0 && byte <= 255),'Invalid stored image bytes');
    return {...card,imageSha256:sha(Buffer.from(imageBytes))};
  })};
}

export function normalizeView(snapshot, source, wanted, assets) {
  assert.deepEqual(Object.fromEntries(Object.entries(snapshot.labels).map(([key,row]) => [key,row.text])), source.labels);
  assert.deepEqual(snapshot.cards.map(card => card.heading), wanted.cards);
  const identities = [snapshot.boardId,snapshot.listId,...Object.values(snapshot.labels).map(label=>label.id),
    ...snapshot.cards.flatMap(card=>[card.id,card.headingId,card.detailId,card.imageId])];
  assert.ok(identities.every(id => typeof id === 'string'));
  assert.equal(new Set(identities).size,identities.length);
  assert.equal(snapshot.gap,snapshot.columnGap);
  const {title, conditional, ...labels} = source.labels;
  const values = {...labels,status_visible:true,cards:snapshot.cards.map(card => card.heading)};
  for (const [index,card] of snapshot.cards.entries()) {
    const variant = index === snapshot.cards.length-1 && wanted.variant;
    const expected = source.cards[index];
    assert.equal(card.imageSha256,assets[variant ? wanted.asset : expected.image].sha256);
    assert.equal(card.detail,variant ? wanted.copy : expected.detail);
    assert.equal(card.variant,variant || expected.variant);
    assert.equal(card.radius,wanted.radius ?? source.radius);
    assert.equal(card.headingSize,wanted.heading_size ?? source.heading_size);
    assert.equal(card.accent,(wanted.accent ?? source.accent).toLowerCase());
  }
  values.asset = snapshot.cards.at(-1).imageSha256 === assets[wanted.asset].sha256 ? wanted.asset : null;
  if (wanted.gap !== undefined) {
    assert.equal(snapshot.gap,wanted.gap);
    Object.assign(values,{gap:snapshot.gap,radius:snapshot.cards[0].radius,heading_size:snapshot.cards[0].headingSize});
  }
  if (wanted.wrap) {
    assert.equal(snapshot.direction,'row');
    assert.equal(snapshot.wrap,'wrap');
    assert.ok(snapshot.cards.every(card => card.minWidth === 224));
    Object.assign(values,{wrap:true,accent:snapshot.cards[0].accent.toUpperCase()});
  } else {
    assert.equal(snapshot.direction,'column');
    assert.equal(snapshot.gap,wanted.gap ?? source.gap);
  }
  if (wanted.variant) {
    const card = snapshot.cards.at(-1);
    assert.equal(card.variantBorder?.toUpperCase(),wanted.variant_border.toUpperCase());
    Object.assign(values,{variant:card.variant,copy:card.detail,variant_border:card.variantBorder.toUpperCase()});
  }
  assert.deepEqual(values,wanted);
  return values;
}

export function normalizeSource(fixture,wanted,observations) {
  const source = sourceSpec(fixture,wanted,observations);
  const {title,conditional,...labels} = source.labels;
  const last = source.cards.at(-1);
  const value = {...labels,status_visible:true,cards:source.cards.map(card=>card.label),asset:last.image};
  if (wanted.gap !== undefined) Object.assign(value,{gap:source.gap,radius:source.radius,heading_size:source.heading_size});
  if (wanted.wrap) Object.assign(value,{wrap:source.wrap,accent:source.accent.toUpperCase()});
  if (wanted.variant) Object.assign(value,{variant:last.variant,copy:last.detail,
    variant_border:hexColor(observations.states[0].styles.variantBorder).toUpperCase()});
  assert.deepEqual(value,wanted);
  return value;
}

export function decodeLD05(response, operation, token) {
  try {
    return decodeNativeResult(response);
  } catch (error) {
    let detail = response.content?.[0]?.text;
    if (typeof detail === 'string') {
      try {
        const payload = JSON.parse(detail);
        detail = typeof payload?.error === 'string' ? payload.error : payload?.error?.message;
      } catch {
        // The server sends a plain-text tool failure if plugin execution throws.
      }
    }
    if (typeof detail === 'string') {
      if (token) detail = detail.replaceAll(token,'[redacted]');
      detail = detail.replace(/\b(?:https?|wss?):\/\/[^\s"'<>]+/gi,'[url]')
        .replace(/\buserToken=[^\s&"'<>]+/gi,'userToken=[redacted]')
        .split(/\r?\n/,1)[0].replace(/[^\p{L}\p{N}\p{P}\p{S} ]/gu,' ').slice(0,280);
    }
    throw new Error(`${operation}: ${error.message}${detail ? ` (${detail})` : ''}`);
  }
}

export async function runLD05(origin,family,output,candidate) {
  await waitForBackend(origin);
  const readJSON = (script,...args) => JSON.parse(execFileSync('python3',[join(bench,script),...args],
    {env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}}));
  const fixture = readJSON('ld05_contract.py',family);
  const root = join(output,'source');
  const command = (action,...args)=>readJSON('ld05_source.py',action,family,root,...args);
  const initial = command('prepare');
  const assets = Object.fromEntries(await Promise.all(Object.entries(initial.files)
    .filter(([path])=>path.startsWith('assets/')).map(async ([path,sha256])=>{
      const bytes = await readFile(join(root,path));
      assert.equal(sha(bytes),sha256);
      const name = path.split('/')[1];
      return [name,{name,sha256,base64:bytes.toString('base64')}];
    })));
  const {chromium} = benchRequire('playwright');
  const browser = await chromium.launch({channel:'chrome',headless:true});
  const client = new Client({name:'omc-ld05-penpot',version:'1'});
  let token, phase;
  try {
    const context = await browser.newContext({locale:'en-US'});
    context.setDefaultTimeout(9000);
    const dashboard = await context.newPage();
    await createAccount(dashboard,origin,`omc-bench-${randomBytes(10).toString('hex')}@example.test`,
      randomBytes(20).toString('hex')+'Aa1!');
    const endpoint = await getMcpEndpoint(dashboard,origin);
    token = endpoint.searchParams.get('userToken');
    await client.connect(new StreamableHTTPClientTransport(endpoint));
    let editor = await newFile(dashboard,context,origin);
    const workspace = new URL(editor.url());
    assert.equal(workspace.origin,origin);
    if (editor !== dashboard) await dashboard.close();
    const fileId = workspace.searchParams.get('file-id');
    assert.match(fileId,nativeId);
    const call = code => client.callTool({name:'execute_code',arguments:{code}},undefined,{timeout:12000});
    const execute = async (operation,code) => decodeLD05(await call(code),operation,token);
    const attach = async () => {
      await editor.getByRole('toolbar',{name:'Drawing tools'}).waitFor();
      await connectEditor(editor);
      assert.equal(await readAfterAttach(async()=>decodeNativeResult(await call('return penpot.currentFile.id;'))),fileId);
    };
    await attach();
    const evidence = {fixture_sha256:fixture.fixture_sha256,starting_source_sha256:initial.source_sha256,
      cycles:[],scope:'deterministic Penpot plugin and retained source; no model'};
    let previous = initial;
    for (const [index,step] of fixture.cycles.entries()) {
      const cycle = index+1, started = performance.now();
      phase = 'cycle '+cycle+' source refresh';
      assert.deepEqual(command('manifest'),previous);
      const manifest = command('patch','--cycle',String(cycle));
      const before = await sourceProbe(root,fixture,manifest,cycle,step.source_state);
      const projection = sourceSpec(fixture,step.source_state,before);
      const boardId = await execute('native refresh write',seedCycle(fileId,cycle,projection,assets));
      const native = hashStoredMedia(await execute('refreshed native readback',readCycle(fileId,cycle)));
      assert.equal(native.boardId,boardId);
      const refreshed = normalizeView(native,projection,step.source_state,assets);

      phase = 'cycle '+cycle+' native edit and reopen';
      const saved = editor.waitForResponse(response => response.ok() &&
        new URL(response.url()).origin === origin && response.url().includes('/update-file') &&
        response.request().method()==='POST',{timeout:5500}).then(()=>true,()=>false);
      assert.equal(await execute('native design edit',editCycle(fileId,cycle,step.result,assets[step.result.asset])),native.listId);
      const edited = hashStoredMedia(await execute('edited native readback',readCycle(fileId,cycle)));
      const saveResponse = await saved;
      await editor.close();
      editor = await context.newPage();
      await editor.goto(workspace.href,{waitUntil:'domcontentloaded'});
      await attach();
      const reopened = hashStoredMedia(await execute('reopened native readback',readCycle(fileId,cycle)));
      assert.equal(reopened.documentId,fileId);
      assert.deepEqual(reopened,edited);
      assert.deepEqual(reopened.cards.map(card=>[card.id,card.headingId,card.detailId,card.imageId]),
        native.cards.map(card=>[card.id,card.headingId,card.detailId,card.imageId]));
      const projectionAfter = normalizeView(reopened,projection,step.result,assets);

      phase = 'cycle '+cycle+' retained source merge and independent replay';
      const cssPath = join(root,'theme.css');
      const {cards} = reopened;
      const values = cycle===1 ? {gap:reopened.gap+'px',radius:cards[0].radius+'px',heading_size:cards[0].headingSize+'px'} :
        cycle===2 ? {wrap:reopened.wrap,direction:reopened.direction,flex:'1 1 '+cards[0].minWidth+'px',accent:cards[0].accent} :
        {variant_border:cards.at(-1).variantBorder};
      if (cycle===3) {
        const dataPath = join(root,'data.mjs');
        const last = cards.at(-1);
        const media = Object.values(assets).find(asset=>asset.sha256 === last.imageSha256);
        assert.ok(media);
        await writeFile(dataPath,mergeExtraCard(await readFile(dataPath,'utf8'),last.variant,media.name,last.detail));
      }
      await writeFile(cssPath,mergeStyles(await readFile(cssPath,'utf8'),cycle,values));
      const post = command('manifest');
      const changed = Object.keys(post.files).filter(path=>post.files[path]!==manifest.files[path]).sort();
      assert.deepEqual(changed,cycle===3?['data.mjs','theme.css']:['theme.css']);
      const clean = join(output,'clean-'+cycle);
      await cp(root,clean,{recursive:true,errorOnExist:true,force:false});
      for (const [path,sha256] of Object.entries(post.files)) {
        assert.equal(sha(await readFile(join(clean,path))),sha256);
        if (path.endsWith('.mjs')) execFileSync(process.execPath,['--check',join(clean,path)]);
      }
      const final = await sourceProbe(clean,fixture,post,cycle,step.result);
      evidence.cycles.push({cycle,source_parent_sha256:previous.source_sha256,source_patch_sha256:manifest.source_sha256,
        result_checkout_sha256:post.source_sha256,refreshed_canvas:refreshed,reopened_canvas:projectionAfter,
        source_result:normalizeSource(fixture,step.result,final),checked_widths:final.states.map(state=>state.width),canvas_editable:true,
        clean_build:true,behavior_tests_passed:true,component_reused:post.files['card.mjs']===initial.files['card.mjs'],
        no_missing_assets:true,saveResponse,elapsedMs:performance.now()-started});
      await writeFile(join(output,'cycle-'+cycle+'.json'),json({before,native,edited,reopened,final,manifest,post}),
        {flag:'wx',mode:0o600});
      previous = post;
    }
    await publishCandidate(candidate,evidence);
  } catch (error) {
    const message = token ? String(error).replaceAll(token,'[redacted]') : String(error);
    throw new Error('Penpot LD05 '+(phase ?? 'setup')+': '+message);
  } finally {
    await Promise.allSettled([client.close(),browser.close()]);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [origin,family] = process.argv.slice(2);
  assert.ok(['route-board','supply-ledger'].includes(family),'Supply the registered LD05 source family');
  const {OMC_BENCH_OUTPUT_DIR:output,OMC_BENCH_CANDIDATE:candidate} = process.env;
  assert.ok(output && candidate,'Launch through run_attempt.py');
  const evidence = join(output,'penpot-ld05');
  await mkdir(evidence,{mode:0o700});
  await runLD05(loopbackOrigin(origin),family,evidence,candidate);
}
