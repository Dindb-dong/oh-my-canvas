import assert from 'node:assert/strict';
import {createHash,randomBytes} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {connectEditor,createAccount,getMcpEndpoint,loopbackOrigin,newFile,waitForBackend} from '../penpot-ld02.mjs';
import {duplicateFromDashboard,reopenPage,watchSave} from './ld03.mjs';
import {decodeNativeResult,readAfterAttach} from './ld09.mjs';
import {hashNativeImages} from './ld06.mjs';

const marker = 'LD01 ';
const idPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

export async function verifyInputs(fixture,directory) {
  assert.equal(fixture.workload,'LD01');
  assert.ok(['harbor-ops','reading-room'].includes(fixture.source_family_id));
  assert.deepEqual(fixture.start,{nodes:[],styles:[]});
  assert.equal(fixture.expected.nodes.length,fixture.logical_objects);
  assert.deepEqual(fixture.assets.map(row=>row.name).sort(),['badge.png','detail-map.png']);
  const keys = new Set();
  for (const row of fixture.expected.nodes) {
    assert.ok(!keys.has(row.key),'Duplicate logical key');
    assert.ok(row.parent === null || keys.has(row.parent),'Expected parent-before-child order');
    assert.ok(['frame','image','text'].includes(row.kind));
    assert.ok(Array.isArray(row.bounds) && row.bounds.length === 4 && row.bounds.every(Number.isFinite));
    keys.add(row.key);
  }
  return Promise.all(fixture.assets.map(async meta=>{
    const bytes = await readFile(join(directory,meta.name));
    assert.equal(sha256(bytes),meta.sha256,`Fixture asset bytes changed for ${meta.name}`);
    return {meta,bytes};
  }));
}

function guard(id) {
  assert.match(id,idPattern);
  return `if (penpot.currentFile.id !== ${JSON.stringify(id)} || penpot.currentFile.pages.length !== 1)
    throw new Error("Wrong isolated LD01 file");
  const root = penpot.currentPage.root;
  const prefix = ${JSON.stringify(marker)};
  const keyOf = shape => {
    if (!shape.name.startsWith(prefix)) throw new Error("Unexpected shape outside LD01 scope");
    return shape.name.slice(prefix.length).replaceAll(" / ","/");
  };`;
}

export function createDashboard(fixture,assets,id) {
  return `${guard(id)}
  if (root.children.length) throw new Error("Expected an empty native document");
  const font = penpot.fonts.all.find(face => face.name === "Inter");
  if (!font) throw new Error("Fixture Inter face unavailable");
  const images = new Map();
  for (const asset of ${JSON.stringify(assets.map(({meta,bytes})=>({rgba:meta.rgba_sha256,name:meta.name,base64:bytes.toString('base64')})))}) {
    const media = await penpot.uploadMediaData(asset.name,
      Uint8Array.from(atob(asset.base64),char=>char.charCodeAt(0)),"image/png");
    images.set(asset.rgba,media);
  }
  const shapes = new Map();
  const specifications = ${JSON.stringify(fixture.expected.nodes)};
  for (const row of specifications) {
    const shape = row.kind === "text" ? penpot.createText(row.text) :
      row.kind === "image" ? penpot.createRectangle() : penpot.createBoard();
    shape.name = prefix + row.key;
    const parent = shapes.get(row.parent);
    if (parent) parent.appendChild(shape);
    shape.resize(row.bounds[2],row.bounds[3]);
    shape.x = row.bounds[0]; shape.y = row.bounds[1];
    if (row.kind === "text") {
      font.applyToText(shape); shape.fontSize = String(row.font_size);
      shape.lineHeight = "1"; shape.growType = "fixed"; shape.verticalAlign = "center";
    } else if (row.kind === "image") {
      const media = images.get(row.asset_rgba_sha256);
      if (!media) throw new Error("Missing registered source image");
      shape.fills = [{fillOpacity:1,fillImage:{id:media.id,width:media.width,height:media.height,
        mtype:media.mtype,name:media.name,keepAspectRatio:true}}];
    } else { shape.clipContent = false; shape.fills = [{fillColor:"#ffffff",fillOpacity:1}]; }
    shapes.set(row.key,shape);
  }
  for (const row of specifications.filter(row=>row.layout === "horizontal")) {
    const shape = shapes.get(row.key), layout = shape.addFlexLayout();
    layout.dir = "row"; layout.wrap = "nowrap"; layout.alignItems = "center";
    layout.justifyContent = "start"; layout.horizontalPadding = 0; layout.verticalPadding = 0;
    layout.rowGap = row.gap; layout.columnGap = row.gap;
    layout.horizontalSizing = "fix"; layout.verticalSizing = "fix";
    for (const child of specifications.filter(child=>child.parent === row.key)) {
      const item = shapes.get(child.key); layout.appendChild(item);
      item.layoutChild.horizontalSizing = "fix"; item.layoutChild.verticalSizing = "fix";
    }
  }
  return shapes.size;`;
}

export function readDashboard(id) {
  return `${guard(id)}
  const nodes = [], images = new Map();
  async function visit(shape,parent,editable) {
    const key = keyOf(shape);
    const row = {key,parent,native_id:shape.id,kind:shape.type === "board" ? "frame" : shape.type,
      bounds:[shape.x,shape.y,shape.width,shape.height],editable:editable && !shape.blocked && !shape.hidden};
    if (shape.type === "text") Object.assign(row,{text:shape.characters,font_family:shape.fontFamily,
      font_size:Number(shape.fontSize),native_font_id:shape.fontId});
    if (shape.flex) Object.assign(row,{layout:shape.flex.dir === "row" ? "horizontal" : shape.flex.dir,
      gap:shape.flex.columnGap});
    const image = shape.type === "rectangle" && shape.fills[0]?.fillImage;
    if (image) {
      if (!images.has(image.id)) {
        const bytes = await image.data();
        if (!bytes.length || bytes.length > 8*1024*1024) throw new Error("Invalid native image byte count");
        images.set(image.id,Array.from(bytes));
      }
      Object.assign(row,{kind:"image",native_image_id:image.id});
    }
    nodes.push(row);
    for (const child of shape.children ?? []) await visit(child,key,row.editable);
  }
  for (const shape of root.children) await visit(shape,null,true);
  return {document_id:penpot.currentFile.id,nodes,styles:[],image_bytes:Object.fromEntries(images)};`;
}

export function normalizeImages(observed,assets) {
  const hashed = hashNativeImages(observed);
  const known = new Map(assets.map(({meta})=>[meta.sha256,meta.rgba_sha256]));
  return {...hashed,nodes:hashed.nodes.map(row=>row.kind === 'image' && known.has(row.stored_png_sha256) ?
    {...row,asset_rgba_sha256:known.get(row.stored_png_sha256)} : row)};
}

export function applyProbe(id,actions) {
  assert.ok(Array.isArray(actions) && actions.length === 3);
  assert.deepEqual(actions.map(({op,key,property})=>({op,key,property})),[
    {op:'set_node',key:'header/title',property:'text'},
    {op:'set_node',key:'detail/title',property:'text'},
    {op:'set_node',key:'filters',property:'gap'},
  ]);
  return `${guard(id)}
  const index = new Map();
  const walk = shape => { index.set(keyOf(shape),shape); for (const child of shape.children ?? []) walk(child); };
  for (const shape of root.children) walk(shape);
  const actions = ${JSON.stringify(actions)};
  for (const action of actions) {
    const shape = index.get(action.key);
    if (!shape) throw new Error("Missing native verification target");
    if (action.property === "text") {
      if (shape.type !== "text") throw new Error("Expected native editable text");
      shape.characters = action.value;
    } else {
      if (!shape.flex || shape.flex.dir !== "row") throw new Error("Expected native horizontal layout");
      shape.flex.columnGap = action.value; shape.flex.rowGap = action.value;
    }
  }
  return actions;`;
}

async function replay(origin,fixture,assets,output,candidate) {
  const {benchRequire,Client,StreamableHTTPClientTransport} = await import('../replays/mcp.mjs');
  const {chromium} = benchRequire('playwright');
  const client = new Client({name:'omc-ld01-replay',version:'1'});
  const email = `omc-bench-${randomBytes(10).toString('hex')}@example.test`;
  const password = randomBytes(20).toString('hex')+'Aa1!';
  const evidence = {probe_actions:[],font_qualification:fixture.font};
  const fileName = `OMC Benchmark LD01 / ${fixture.source_family_id}`;
  let browser,endpoint,phase = 'disposable account setup';
  const safeError = error=>[email,password,endpoint?.searchParams.get('userToken')].filter(Boolean)
    .reduce((value,secret)=>value.replaceAll(secret,'[redacted]'),String(error));
  try {
    await waitForBackend(origin);
    browser = await chromium.launch({channel:'chrome',headless:true});
    const context = await browser.newContext({locale:'en-US',viewport:{width:fixture.viewport.width,height:fixture.viewport.height}});
    context.setDefaultTimeout(12000);
    const dashboard = await context.newPage();
    await createAccount(dashboard,origin,email,password);
    endpoint = await getMcpEndpoint(dashboard,origin);
    await client.connect(new StreamableHTTPClientTransport(endpoint));
    let editor = await newFile(dashboard,context,origin);
    await editor.getByRole('toolbar',{name:'Drawing tools'}).waitFor();
    const workspace = new URL(editor.url());
    assert.equal(workspace.origin,origin);
    const id = workspace.searchParams.get('file-id'); assert.match(id,idPattern);
    await editor.locator('header [class*="file-name-label"]').dblclick();
    const title = editor.locator('header input[class*="file-name-input"]');
    await title.fill(fileName); await title.press('Enter');
    if (editor !== dashboard) await dashboard.close();
    await connectEditor(editor);
    const execute = async code=>{
      const result = decodeNativeResult(await client.callTool({name:'execute_code',arguments:{
        code:`try { ${code} } catch (error) { return {ld01Error:String(error.message)}; }`,
      }},undefined,{timeout:20000}));
      if (result?.ld01Error) throw new Error(result.ld01Error);
      return result;
    };
    const capture = async file=>normalizeImages(await readAfterAttach(()=>execute(readDashboard(file))),assets);
    evidence.before = await capture(id);
    assert.equal(evidence.before.nodes.length,0);
    phase = 'create editable native dashboard and upload original image bytes';
    const saved = watchSave(editor,origin);
    assert.equal(await execute(createDashboard(fixture,assets,id)),fixture.logical_objects);
    const receipt = await saved; if (receipt instanceof Error) throw receipt;
    evidence.save_response_observed = receipt;
    evidence.candidate = await capture(id);
    phase = 'reopen original and read persistent native objects';
    editor = await reopenPage(editor,context,workspace);
    evidence.reopened = await capture(id);
    phase = 'duplicate original through native dashboard';
    const duplicate = await duplicateFromDashboard(editor,context,origin,fileName);
    assert.notEqual(duplicate.id,id);
    phase = 'edit duplicate native text and horizontal gap';
    evidence.probe_actions = await execute(applyProbe(duplicate.id,fixture.probe_actions));
    evidence.probe = await capture(duplicate.id);
    phase = 'reread protected original after duplicate edits';
    editor = await reopenPage(duplicate.opened,context,workspace);
    evidence.after_probe_original = await capture(id);
    await writeFile(candidate,JSON.stringify(evidence)+'\n',{flag:'wx',mode:0o600});
  } catch (error) {
    throw new Error(`Penpot LD01 ${phase}: ${safeError(error)}`);
  } finally {
    await Promise.allSettled([client.close(),browser?.close()]);
    await writeFile(join(output,'penpot-ld01-native-observations.json'),JSON.stringify({phase,...evidence})+'\n',
      {flag:'wx',mode:0o600});
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [origin,path,assets,...extra] = process.argv.slice(2);
  assert.ok(origin && path && assets && !extra.length,'Use ld01.mjs LOOPBACK_ORIGIN FIXTURE_JSON ASSET_DIR');
  const output = process.env.OMC_BENCH_OUTPUT_DIR, candidate = process.env.OMC_BENCH_CANDIDATE;
  assert.ok(output && candidate,'Run through the bounded benchmark attempt runner');
  const fixture = JSON.parse(await readFile(path,'utf8'));
  await replay(loopbackOrigin(origin),fixture,await verifyInputs(fixture,assets),output,candidate);
}
