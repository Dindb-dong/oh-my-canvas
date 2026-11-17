import assert from 'node:assert/strict';
import {createHash,randomBytes} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  connectEditor,createAccount,getMcpEndpoint,loopbackOrigin,newFile,waitForBackend,
} from '../penpot-ld02.mjs';
import {reopenPage,watchSave} from './ld03.mjs';
import {decodeNativeResult,readAfterAttach} from './ld09.mjs';

const prefix = 'LD06 ';
const fileIdPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

export async function verifyInputs(fixture, assetDir) {
  assert.equal(fixture.workload,'LD06');
  assert.equal(fixture.source_family_id,'metro-stories');
  assert.equal(fixture.font_registered,true);
  assert.equal(fixture.font.family,'Noto Sans KR');
  assert.equal(fixture.font.license,'OFL-1.1');
  assert.equal(fixture.start.nodes.length,8);
  assert.equal(fixture.logical_objects,26);
  const expected = ['content.json','fixture-font.ttf',...Array.from({length:6},(_,i) => `initial-image-${i+1}.png`),
    'replacement-image-3.png','replacement-image-6.png'];
  assert.deepEqual(fixture.assets.map(asset => asset.name).sort(),expected.sort());
  const pairs = await Promise.all(fixture.assets.map(async meta => {
    const path = join(assetDir,meta.name);
    const bytes = await readFile(path);
    assert.equal(sha256(bytes),meta.sha256,`Fixture asset bytes changed for ${meta.name}`);
    return [meta.name,{meta,bytes,path}];
  }));
  const assets = new Map(pairs);
  const content = JSON.parse(assets.get('content.json').bytes);
  assert.deepEqual(content.initial.map(node => node.slot),[0,1,2,3,4,5]);
  assert.deepEqual(content.updates.map(node => node.slot),[2,5]);
  return {assets,content};
}

function guard(id) {
  assert.match(id,fileIdPattern);
  return `if (penpot.currentFile.id !== ${JSON.stringify(id)} || penpot.currentFile.pages.length !== 1) {
    throw new Error("Wrong isolated LD06 file");
  }
  const root = penpot.currentPage.root;
  const prefix = ${JSON.stringify(prefix)};
  const keyOf = shape => {
    if (!shape.name.startsWith(prefix)) throw new Error("Unexpected object outside the scoped LD06 fixture");
    return shape.name.slice(prefix.length).replaceAll(" / ","/");
  };
  const exact = (parent,key) => {
    const matches = parent.children.filter(shape => keyOf(shape) === key);
    if (matches.length !== 1) throw new Error("Expected one native shape for " + key);
    return matches[0];
  };`;
}

const position = `const position = (shape,box,parent) => {
  if (parent) parent.appendChild(shape);
  shape.resize(box[2],box[3]);
  shape.x = box[0];
  shape.y = box[1];
};`;

const setText = `const setText = (shape,face,size) => {
  face.applyToText(shape);
  shape.fontSize = String(size);
  shape.growType = "fixed";
  shape.lineHeight = "1";
  shape.verticalAlign = "center";
};`;

export function seedNative(fixture, id) {
  return `${guard(id)} ${position} ${setText}
  if (root.children.length !== 0) throw new Error("Expected a new empty benchmark file");
  const face = penpot.fonts.all.find(entry => entry.name === "Noto Sans KR" && entry.fontId.startsWith("custom-"));
  if (!face) throw new Error("Uploaded team-local Noto Sans KR face is unavailable");
  const shapes = new Map();
  for (const node of ${JSON.stringify(fixture.start.nodes)}) {
    const shape = node.kind === "text" ? penpot.createText(node.text) : penpot.createBoard();
    shape.name = prefix + node.key;
    if (node.kind === "text") setText(shape,face,26);
    else shape.fills = [{fillColor:node.parent ? "#f2f4f8" : "#ffffff",fillOpacity:1}];
    position(shape,node.bounds,shapes.get(node.parent));
    shapes.set(node.key,shape);
  }
  return {count:shapes.size,fontId:face.fontId};`;
}

export function placeSlot(id, rows, content, asset, fontId, edit) {
  const base = `card/${content.slot}`;
  assert.equal(rows.length,3);
  assert.equal(rows.find(row => row.key === `${base}/name`).text,content.name);
  assert.equal(rows.find(row => row.key === `${base}/caption`).text,content.caption);
  assert.equal(rows.find(row => row.kind === 'image').asset_rgba_sha256,asset.meta.rgba_sha256);
  return `${guard(id)} ${position} ${setText}
  const card = exact(exact(root,"canvas"),${JSON.stringify(base)});
  const edit = ${JSON.stringify(edit)};
  if (card.children.length !== (edit ? 3 : 0)) throw new Error("Unexpected LD06 card contents");
  const face = penpot.fonts.findById(${JSON.stringify(fontId)});
  if (face?.fontId !== ${JSON.stringify(fontId)}) throw new Error("Pinned custom font identity changed");
  const rows = ${JSON.stringify(rows.map(row => ({key:row.key,kind:row.kind,text:row.text,bounds:row.bounds})))};
  const native = await penpot.uploadMediaData(${JSON.stringify(asset.meta.name)},
    Uint8Array.from(atob(${JSON.stringify(asset.bytes.toString('base64'))}), char => char.charCodeAt(0)),"image/png");
  for (const row of rows) {
    const picture = row.kind === "image";
    const shape = edit ? exact(card,row.key) : picture ? penpot.createRectangle() : penpot.createText(row.text);
    if (picture) shape.fills = [{fillOpacity:1,fillImage:{id:native.id,width:native.width,height:native.height,
      mtype:native.mtype,name:native.name,keepAspectRatio:true}}];
    else if (edit) shape.characters = row.text;
    else setText(shape,face,16);
    if (!edit) {
      shape.name = prefix + row.key;
      position(shape,row.bounds,card);
    }
  }
  return native.id;`;
}

export function readNative(id) {
  return `${guard(id)}
  const canvas = exact(root,"canvas");
  if (root.children.length !== 1) throw new Error("Unexpected extra boards");
  const nodes = [], images = new Map();
  const box = shape => [shape.x,shape.y,shape.width,shape.height];
  const hex = async bytes => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",bytes)),
    byte => byte.toString(16).padStart(2,"0")).join("");
  const contains = (outer,inner) => outer[0]-2 <= inner[0] && outer[1]-2 <= inner[1] &&
    inner[0]+inner[2] <= outer[0]+outer[2]+2 && inner[1]+inner[3] <= outer[1]+outer[3]+2;
  async function visit(shape,parent,ancestors,editable) {
    const key = keyOf(shape);
    const row = {key,parent,native_id:shape.id,kind:shape.type === "board" ? "frame" : shape.type,bounds:box(shape),
      editable:editable && !shape.blocked && !shape.hidden};
    if (shape.type === "text") {
      const glyphs = shape.textBounds ? box(shape.textBounds) : null;
      Object.assign(row,{text:shape.characters,font_family:shape.fontFamily,font_id:shape.fontId,
        rendered_bounds:glyphs,native_face_variant:shape.fontVariantId,fully_visible:row.editable && !!glyphs &&
        glyphs[2] > 0 && glyphs[3] > 0 && [row.bounds,...ancestors].every(bounds => contains(bounds,glyphs))});
    }
    const fill = shape.type === "rectangle" && shape.fills[0]?.fillImage;
    if (fill) {
      if (!images.has(fill.id)) images.set(fill.id, hex(await fill.data()));
      Object.assign(row,{kind:"image",native_image_id:fill.id,stored_png_sha256:await images.get(fill.id),
        native_image_size:[fill.width,fill.height],native_center_cover:fill.keepAspectRatio === true});
    }
    nodes.push(row);
    for (const child of shape.children ?? []) await visit(child,key,[row.bounds,...ancestors],row.editable);
  }
  await visit(canvas,null,[],true);
  return {document_id:penpot.currentFile.id,nodes,styles:[]};`;
}

export function exportPng(id) {
  return `${guard(id)}
  const bytes = await exact(root,"canvas").export({type:"png",scale:1});
  if (!bytes?.length) throw new Error("Native board PNG export returned no bytes");
  let result = "";
  for (let i=0;i<bytes.length;i+=16000) result += String.fromCharCode(...bytes.slice(i,i+16000));
  return btoa(result);`;
}

async function uploadTeamFont(page,origin,{path,meta}) {
  const dashboard = page.url();
  await page.getByTestId('fonts').click();
  assert.equal(new URL(page.url()).origin,origin);
  await page.locator('#font-upload').setInputFiles(path);
  await page.getByRole('button',{name:'Upload',exact:true}).click({timeout:20000});
  await page.getByText(meta.family,{exact:true}).waitFor({timeout:45000});
  await page.goto(dashboard);
}

async function replay(origin,fixture,{assets,content},output) {
  await waitForBackend(origin);
  const {benchRequire,Client,StreamableHTTPClientTransport} = await import('../replays/mcp.mjs');
  const {chromium} = benchRequire('playwright');
  const client = new Client({name:'omc-ld06-assets',version:'1'});
  const email = `omc-bench-${randomBytes(10).toString('hex')}@example.test`;
  const password = randomBytes(20).toString('hex')+'Aa1!';
  let browser,endpoint,phase = 'disposable account setup';
  const evidence = {source_handoff:null,phases:{},font_requests:[],export_errors:{}};
  const safeError = error => [email,password,endpoint?.searchParams.get('userToken')].filter(Boolean)
    .reduce((value,secret) => value.replaceAll(secret,'[redacted]'),String(error));
  try {
    browser = await chromium.launch({channel:'chrome',headless:true});
    const context = await browser.newContext({locale:'en-US',viewport:{width:1440,height:960}});
    context.setDefaultTimeout(15000);
    const fontRequests = [];
    context.on('response',response => {
      const url = new URL(response.url());
      if (response.ok() && url.origin === origin && response.request().resourceType() === 'font') {
        fontRequests.push(response.body().then(bytes => ({path:url.pathname,sha256:sha256(bytes)}),() => null));
      }
    });
    const dashboard = await context.newPage();
    await createAccount(dashboard,origin,email,password);
    phase = 'upload exact TTF to the disposable Penpot team';
    await uploadTeamFont(dashboard,origin,assets.get(fixture.font.name));
    endpoint = await getMcpEndpoint(dashboard,origin);
    await client.connect(new StreamableHTTPClientTransport(endpoint));
    let editor = await newFile(dashboard,context,origin);
    await editor.getByRole('toolbar',{name:'Drawing tools'}).waitFor();
    const workspace = new URL(editor.url());
    assert.equal(workspace.origin,origin);
    const id = workspace.searchParams.get('file-id');
    assert.match(id,fileIdPattern);
    if (editor !== dashboard) await dashboard.close();
    await connectEditor(editor);
    const execute = async code => {
      const wrapped = `try { ${code} } catch (error) { return {ld06Error:String(error.message)}; }`;
      const result = decodeNativeResult(await client.callTool({name:'execute_code',arguments:{code:wrapped}},undefined,{timeout:30000}));
      if (result?.ld06Error) throw new Error(result.ld06Error);
      return result;
    };
    await readAfterAttach(() => execute(`${guard(id)} return penpot.currentFile.id;`));
    phase = 'prepare eight native baseline objects';
    const {count,fontId} = await execute(seedNative(fixture,id));
    assert.equal(count,fixture.start.nodes.length);
    evidence.native_team_font_id = fontId;
    evidence.phases.before = await execute(readNative(id));
    const record = async (name,page) => {
      await page.evaluate(async () => {
        await Promise.race([document.fonts.ready,new Promise(resolve => setTimeout(resolve,4000))]);
      });
      evidence.phases[name] = await readAfterAttach(() => execute(readNative(id)));
      try {
        const bytes = Buffer.from(await execute(exportPng(id)),'base64');
        await writeFile(join(output,`${name}.png`),bytes,{flag:'wx',mode:0o600});
      } catch (error) {
        evidence.export_errors[name] = safeError(error);
      }
    };
    for (const [name,entries,replace] of [['loaded',content.initial,false],['candidate',content.updates,true]]) {
      phase = `${name} exact asset and bilingual layer writes`;
      let saved;
      for (const [index,entry] of entries.entries()) {
        const scene = replace ? fixture.expected : fixture.loaded;
        const rows = scene.nodes.filter(node => node.parent === `card/${entry.slot}`);
        const asset = assets.get(`${replace ? 'replacement' : 'initial'}-image-${entry.slot+1}.png`);
        if (index === entries.length-1) saved = watchSave(editor,origin);
        assert.match(await execute(placeSlot(id,rows,entry,asset,fontId,replace)),fileIdPattern);
      }
      const savedResult = await saved;
      if (savedResult instanceof Error) throw savedResult;
      evidence[`${name}_save_observed`] = savedResult;
      await record(name,editor);
    }
    phase = 'normal original reopen and independent native byte readback';
    editor = await reopenPage(editor,context,workspace);
    await record('reopened',editor);
    evidence.font_requests = (await Promise.all(fontRequests)).filter(Boolean);
  } catch (error) {
    throw new Error(`Penpot LD06 ${phase}: ${safeError(error)}`);
  } finally {
    await Promise.allSettled([client.close(),browser?.close()]);
    await writeFile(join(output,'penpot-native-observations.json'),JSON.stringify({phase,...evidence})+'\n',{flag:'wx',mode:0o600});
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [origin,path,assetDir,output,...extra] = process.argv.slice(2);
  assert.ok(path && assetDir && output && !extra.length,'Use ld06.mjs LOOPBACK_ORIGIN FIXTURE_JSON ASSET_DIR EXISTING_OUTPUT_DIR');
  const fixture = JSON.parse(await readFile(path,'utf8'));
  await replay(loopbackOrigin(origin),fixture,await verifyInputs(fixture,assetDir),output);
}
