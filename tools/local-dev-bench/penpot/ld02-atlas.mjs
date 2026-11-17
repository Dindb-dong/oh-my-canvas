import assert from 'node:assert/strict';
import {createHash, randomBytes} from 'node:crypto';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';
import {withLD02Broker} from '../ld02-model.mjs';
import {runLD03Agent} from '../ld03-model.mjs';
import {publishCandidate} from '../publish-candidate.mjs';
import {
  connectEditor, createAccount, getMcpEndpoint, loopbackOrigin, newFile, waitForBackend,
} from '../penpot-ld02.mjs';
import {duplicateFromDashboard} from './ld03.mjs';
import {decodeNativeResult, readAfterAttach} from './ld09.mjs';

const scope = 'OMC Benchmark LD02 / conservation-atlas';
const nativeKey = 'atlas-logical-key';
const nativeId = /^[a-f0-9-]{36}$/i;
const target = {name:'Ceramics review',receipt:'AC-270'};

export function validateFixture(fixture) {
  assert.equal(fixture.workload,'LD02');
  assert.equal(fixture.source_family_id,'conservation-atlas');
  assert.equal(fixture.logical_objects,1000);
  assert.equal(fixture.start.pages.length,10);
  assert.equal(fixture.start.nodes.length,1000);
  assert.deepEqual(fixture.edit.map(row => row.field),['text','gap','radius']);
  return fixture;
}

function guard(fileId) {
  assert.match(fileId,nativeId);
  return `if (penpot.currentFile.id !== ${JSON.stringify(fileId)}) throw new Error("Wrong isolated Atlas document");`;
}

export function seedAtlasPage(fixture, page, index, fileId) {
  const rows = fixture.start.nodes.filter(node => node.page === page.key);
  assert.equal(rows.length,100);
  return `${guard(fileId)}
    const page = ${index === 0 ? 'penpot.currentPage' : 'penpot.createPage()'};
    page.name = ${JSON.stringify(page.name)};
    if (penpot.currentPage.id !== page.id) await penpot.openPage(page);
    if (page.root.children.length !== 0) throw new Error("Atlas setup requires an empty page");
    const shapes = new Map();
    for (const spec of ${JSON.stringify(rows)}) {
      let shape;
      if (spec.kind === "text") {
        shape = penpot.createText(spec.text);
        shape.growType = "fixed";
        shape.fontSize = "12";
      } else if (spec.kind === "rectangle") {
        shape = penpot.createRectangle();
        shape.borderRadius = spec.radius;
      } else {
        shape = penpot.createBoard();
      }
      shape.name = spec.name;
      shape.setPluginData(${JSON.stringify(nativeKey)},spec.key);
      if (spec.fill) shape.fills = [{fillColor:spec.fill,fillOpacity:1}];
      const [x,y,w,h] = spec.bounds;
      shape.resize(w,h);
      const parent = shapes.get(spec.parent);
      if (parent?.flex) {
        parent.flex.appendChild(shape);
      } else if (parent) {
        parent.appendChild(shape);
        shape.parentX = x - parent.x;
        shape.parentY = y - parent.y;
      } else {
        shape.x = x;
        shape.y = y;
      }
      if (spec.layout === "vertical") {
        const flex = shape.addFlexLayout();
        flex.dir = "column";
        flex.rowGap = spec.gap;
        flex.horizontalPadding = spec.padding;
        flex.verticalPadding = spec.padding;
        flex.alignItems = "start";
        flex.justifyContent = "start";
        flex.horizontalSizing = "fix";
        flex.verticalSizing = "fix";
      }
      shapes.set(spec.key,shape);
    }
    return {nativeId:page.id,logicalObjects:shapes.size};
  `;
}

export function atlasInventory(fixture, fileId) {
  return `${guard(fileId)}
    const keys = new Map(${JSON.stringify(fixture.start.pages.map(page => [page.name,page.key]))});
    return {
      document_id:penpot.currentFile.id,
      pages:penpot.currentFile.pages.map(page => ({key:keys.get(page.name) ?? "unknown:" + page.name,
        native_id:page.id, name:page.name})),
      selected_native_ids:penpot.selection.map(shape => shape.id)
    };
  `;
}

export function readAtlasPage(page, fileId) {
  return readAtlasPages([page],fileId);
}

export function readAtlasPages(pages, fileId) {
  return `${guard(fileId)}
    const keyLiteral = ${JSON.stringify(nativeKey)};
    const walk = (shape, pageKey, parent, order) => {
      const key = shape.getPluginData(keyLiteral);
      const row = {native_id:shape.id,key,page:pageKey,parent,name:shape.name,
        kind:shape.type === "board" ? "frame" : shape.type, editable:!shape.blocked && !shape.hidden,
        bounds:[shape.x,shape.y,shape.width,shape.height]};
      if (order !== undefined) row.order = order;
      if (shape.type === "text") row.text = shape.characters;
      else row.fill = shape.fills[0]?.fillColor?.toLowerCase();
      if (shape.type === "rectangle") row.radius = shape.borderRadius;
      let children = shape.children ?? [];
      if (shape.flex) {
        row.layout = shape.flex.dir === "column" ? "vertical" : shape.flex.dir;
        row.gap = shape.flex.rowGap;
        const padding = [shape.flex.topPadding,shape.flex.rightPadding,shape.flex.bottomPadding,shape.flex.leftPadding];
        row.padding = padding.every(value => value === padding[0]) ? padding[0] : padding;
        children = [...children].sort((a,b) => a.y - b.y);
      }
      return [row,...children.flatMap((child,index) => walk(child,pageKey,key,shape.flex ? index : undefined))];
    };
    return ${JSON.stringify(pages)}.flatMap(spec => {
      const page = penpot.currentFile.pages.find(candidate => candidate.id === spec.native_id);
      if (!page || page.name !== spec.name) throw new Error("Missing native Atlas page");
      return page.root.children.flatMap(shape => walk(shape,spec.key,null));
    });
  `;
}

export function atlasTarget(fileId, edit = false, fixture, {selector, requested, nativeScope} = {}) {
  const {name,receipt} = selector ?? target;
  const changes = Object.fromEntries(fixture.edit.map(({field,from,to}) =>
    [field,{from,to:requested ? requested[field] : to}]));
  return `${guard(fileId)}
    const matches = [];
    for (const page of penpot.currentFile.pages) {
      for (const zone of page.root.children) {
        for (const station of zone.children ?? []) {
          if (station.name === ${JSON.stringify(name)} && station.children?.some(child =>
            child.name === "receipt" && child.type === "text" && child.characters === ${JSON.stringify(receipt)})) {
            matches.push({page,station});
          }
        }
      }
    }
    ${selector && !edit ? 'if (!matches.length) return null;' : ''}
    if (matches.length !== 1) throw new Error("Semantic Atlas target is absent or ambiguous");
    const {page,station:discovered} = matches[0];
    ${nativeScope ? `
      const permitted = ${JSON.stringify(nativeScope)};
      if (page.id !== permitted.page || penpot.currentPage.id !== permitted.page) {
        throw new Error("Atlas edit is outside the permitted working page");
      }
      if (penpot.selection.length !== 0) throw new Error("Atlas edit requires cleared selection");
    ` : selector ? '' : 'if (penpot.currentPage.id !== page.id) await penpot.openPage(page);'}
    const station = ${selector && !edit ? 'discovered' : 'penpot.currentPage.getShapeById(discovered.id)'};
    const caption = station.children.find(shape => shape.name === "status" && shape.type === "text");
    const marker = station.children.find(shape => shape.name === "marker" && shape.type === "rectangle");
    ${nativeScope ? `
      if (station.id !== permitted.gap || caption?.id !== permitted.text || marker?.id !== permitted.radius) {
        throw new Error("Atlas edit would replace or change an unregistered native shape");
      }
    ` : ''}
    const key = ${JSON.stringify(nativeKey)};
    const before = {text:caption.characters,gap:station.flex.rowGap,radius:marker.borderRadius};
    ${edit ? `
      const updates = ${JSON.stringify(changes)};
      if (Object.keys(before).some(field => before[field] !== updates[field].from)) throw new Error("Wrong native Atlas starting values");
      const block = penpot.history.undoBlockBegin();
      try {
        caption.characters = updates.text.to;
        station.flex.rowGap = updates.gap.to;
        marker.borderRadius = updates.radius.to;
      } finally {
        penpot.history.undoBlockFinish(block);
      }
      return [
        {key:caption.getPluginData(key),field:"text",from:before.text,to:caption.characters},
        {key:station.getPluginData(key),field:"gap",from:before.gap,to:station.flex.rowGap},
        {key:marker.getPluginData(key),field:"radius",from:before.radius,to:marker.borderRadius},
      ];
    ` : 'return before;'}
  `;
}

export async function runAtlasModel({execute,fixture,fileId,before,modelCommand,modelTools,beforeWrite}) {
  assert.equal(before.document_id,fileId);
  assert.deepEqual(before.selected_native_ids,[]);
  const nativeScope = Object.fromEntries(fixture.edit.map(({key,field}) =>
    [field,before.nodes.find(node => node.key === key)?.native_id]));
  nativeScope.page = before.pages.find(page => page.key === fixture.working_page)?.native_id;
  assert.ok(Object.values(nativeScope).every(value => typeof value === 'string' && value));
  assert.equal(new Set(Object.values(nativeScope)).size,4);
  const find = async selector => {
    const state = await readAfterAttach(() => execute(atlasTarget(fileId,false,fixture,{selector})));
    return state && {...selector,text:state.text,gap_px:state.gap,radius_px:state.radius};
  };

  const dir = await mkdtemp(join(tmpdir(),'omc-penpot-atlas-'));
  const socket = join(dir,'agent.sock');
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  const signals = ['SIGINT','SIGTERM'];
  for (const signal of signals) process.once(signal,interrupt);
  let actions = [];
  try {
    await withLD02Broker(socket,{
      query:target,
      find,
      edit:async (selector,requested) => {
        beforeWrite();
        const observed = await execute(atlasTarget(fileId,true,fixture,{selector,requested,nativeScope}));
        assert.deepEqual(observed,fixture.edit.map(({key,field,from}) => ({key,field,from,to:requested[field]})),
          'Penpot did not commit the requested values to the permitted native shapes');
        actions = observed;
        return find(selector);
      },
    },modelTools,() => runLD03Agent(modelCommand,socket,controller.signal));
    return actions;
  } finally {
    for (const signal of signals) process.off(signal,interrupt);
    await rm(dir,{recursive:true,force:true});
  }
}

export function atlasDifferences(spec, state, tolerance) {
  const differences = [];
  for (const field of ['pages','nodes']) {
    const rows = new Map(state[field].map(row => [row.key,row]));
    if (rows.size !== state[field].length || rows.size !== spec[field].length) differences.push(field + '.inventory');
    for (const expected of spec[field]) {
      const actual = rows.get(expected.key);
      if (!actual) {
        differences.push(expected.key + '.missing');
        continue;
      }
      if (field === 'nodes' && actual.editable !== true) differences.push(expected.key + '.editable');
      for (const [key,value] of Object.entries(expected)) {
        const valid = key === 'bounds' ? Array.isArray(actual.bounds) && actual.bounds.length === 4 &&
          value.every((v,i) => Number.isFinite(actual.bounds[i]) && Math.abs(actual.bounds[i]-v) <= tolerance)
          : actual[key] === value;
        if (!valid) differences.push(expected.key + '.' + key);
      }
    }
  }
  return differences;
}

async function capture(execute, fixture, fileId) {
  const state = await readAfterAttach(() => execute(atlasInventory(fixture,fileId)));
  const nodes = [];
  for (let i = 0; i < state.pages.length; i += 2) {
    // Keep a bounded tool reply while eliminating half the round trips.
    nodes.push(...await execute(readAtlasPages(state.pages.slice(i,i+2),fileId)));
  }
  return {...state,nodes,styles:[]};
}

async function persistDiagnostic(label, state, differences) {
  const output = process.env.OMC_BENCH_OUTPUT_DIR;
  if (output) await writeFile(join(output,`atlas-${label}-failure.json`),
    JSON.stringify({label,differences,state}) + '\n',{flag:'wx',mode:0o600});
}

async function verifyStart(execute, fixture, id, label) {
  const state = await capture(execute,fixture,id);
  const differences = atlasDifferences(fixture.start,state,fixture.geometry_tolerance_px);
  if (state.selected_native_ids.length !== 0) differences.push('selection');
  if (differences.length) {
    await persistDiagnostic(label,state,differences);
    throw new Error(`${label}: ${differences.length} differences (${differences.slice(0,8).join(', ')})`);
  }
  return state;
}

async function waitValues(execute, fixture, id, expectedSide) {
  const deadline = performance.now()+5000;
  const wants = Object.fromEntries(fixture.edit.map(row => [row.field,row[expectedSide]]));
  for (;;) {
    const values = await readAfterAttach(() => execute(atlasTarget(id,false,fixture)));
    if (Object.entries(wants).every(([field,value]) => values[field] === value)) return;
    if (performance.now() >= deadline) throw new Error(`Native Atlas history did not reach ${expectedSide}`);
    await delay(120);
  }
}

async function reopen(page, context, url) {
  const next = await context.newPage();
  await page.close();
  await next.goto(url.href);
  await connectEditor(next);
  return next;
}

function waitSave(page, origin) {
  return page.waitForResponse(response => response.ok() && new URL(response.url()).origin === origin &&
    response.url().includes('/update-file') && response.request().method() === 'POST',{timeout:8000})
    .then(() => true,error => error.name === 'TimeoutError' ? false : error);
}

function identityHash(state) {
  const pairs = rows => rows.map(({key,native_id}) => [key,native_id]).sort(([a],[b]) => a.localeCompare(b));
  return createHash('sha256').update(JSON.stringify([state.document_id,pairs(state.pages),pairs(state.nodes)])).digest('hex');
}

function preparedWorkspace(raw, origin) {
  const url = new URL(raw);
  assert.equal(url.origin,origin);
  assert.ok(!url.username && !url.password);
  assert.equal(url.searchParams.get('screen'),'workspace');
  for (const key of ['file-id','page-id']) assert.match(url.searchParams.get(key),nativeId);
  return url;
}

async function replay(origin, fixture, modelCommand, prepare, prepared) {
  await waitForBackend(origin);
  const {benchRequire, Client, StreamableHTTPClientTransport} = await import('../replays/mcp.mjs');
  const {chromium} = benchRequire('playwright');
  const email = `omc-bench-${randomBytes(10).toString('hex')}@example.test`;
  const password = randomBytes(20).toString('hex')+'Aa1!';
  const client = new Client({name:'omc-ld02-atlas',version:'1'});
  let browser, endpoint;
  let phase = 'synthetic account setup';
  const modelTools = [];
  let edit = [];
  try {
    browser = await chromium.launch({channel:'chrome',headless:true});
    const enrolled = prepared && JSON.parse(await readFile(prepared,'utf8'));
    if (enrolled) assert.equal(enrolled.fixtureSha256,fixture.fixture_sha256);
    const context = await browser.newContext({locale:'en-US',viewport:{
      width:fixture.viewport.width,height:fixture.viewport.height,
    },...(enrolled ? {storageState:enrolled.storageState} : {})});
    context.setDefaultTimeout(15000);
    const dashboard = await context.newPage();
    if (enrolled) await dashboard.goto(origin);
    else await createAccount(dashboard,origin,email,password);
    endpoint = await getMcpEndpoint(dashboard,origin);
    await client.connect(new StreamableHTTPClientTransport(endpoint));
    let editor = enrolled ? await context.newPage() : await newFile(dashboard,context,origin);
    const workspace = enrolled ? preparedWorkspace(enrolled.workspace,origin) : new URL(editor.url());
    if (enrolled) await editor.goto(workspace.href);
    await editor.getByRole('toolbar',{name:'Drawing tools'}).waitFor();
    assert.equal(workspace.origin,origin);
    const id = workspace.searchParams.get('file-id');
    assert.match(id,nativeId);
    if (!enrolled) {
      await editor.locator('header [class*="file-name-label"]').dblclick();
      const title = editor.locator('header input[class*="file-name-input"]');
      await title.fill(scope);
      await title.press('Enter');
    }
    await editor.getByText(scope,{exact:true}).waitFor();
    if (editor !== dashboard) await dashboard.close();
    await connectEditor(editor);
    const execute = async code => decodeNativeResult(await client.callTool({
      name:'execute_code',arguments:{code},
    },undefined,{timeout:25000}));
    await readAfterAttach(() => execute(`${guard(id)} return penpot.currentFile.id;`));

    phase = 'seed ten native Atlas pages';
    const setupStarted = performance.now();
    let initialSaveObserved, before, copy;
    if (enrolled) {
      const url = preparedWorkspace(enrolled.copy,origin);
      copy = {id:url.searchParams.get('file-id'),url};
      before = await verifyStart(execute,fixture,id,'before');
      assert.equal(identityHash(before),enrolled.originalIdentitySha256);
    } else {
      const nativePages = new Map();
      let setupSave;
      for (const [index,page] of fixture.start.pages.entries()) {
        if (index === fixture.start.pages.length - 1) setupSave = waitSave(editor,origin);
        const result = await execute(seedAtlasPage(fixture,page,index,id));
        assert.equal(result.logicalObjects,100);
        nativePages.set(page.key,result.nativeId);
      }
      workspace.searchParams.set('page-id',nativePages.get(fixture.working_page));
      initialSaveObserved = await setupSave;
      if (initialSaveObserved instanceof Error) throw initialSaveObserved;
      editor = await reopen(editor,context,workspace);
      before = await verifyStart(execute,fixture,id,'before');
      phase = 'duplicate the prepared original';
      copy = await duplicateFromDashboard(editor,context,origin,scope);
      const copyInventory = await readAfterAttach(() => execute(atlasInventory(fixture,copy.id)));
      const copyPage = copyInventory.pages.find(page => page.key === fixture.working_page);
      assert.ok(copyPage);
      copy.url.searchParams.set('page-id',copyPage.native_id);
      editor = await reopen(copy.opened,context,prepare ? copy.url : workspace);
      if (prepare) {
        const copyBefore = await verifyStart(execute,fixture,copy.id,'prepared-copy');
        await writeFile(prepare, JSON.stringify({fixtureSha256:fixture.fixture_sha256,workspace:workspace.href,
          copy:copy.url.href, originalIdentitySha256:identityHash(before), copyIdentitySha256:identityHash(copyBefore),
          storageState:await context.storageState()})+'\n',{flag:'wx',mode:0o600});
        return;
      }
    }
    assert.notEqual(copy.id,id,'Expected distinct native verification copy');
    const setupMs = performance.now()-setupStarted;

    phase = 'three semantic edits on original';
    const started = performance.now();
    let saved;
    if (modelCommand) {
      edit = await runAtlasModel({
        execute,fixture,fileId:id,before,modelCommand,modelTools,
        beforeWrite:() => { saved = waitSave(editor,origin); },
      });
    } else {
      await waitValues(execute,fixture,id,'from');
      saved = waitSave(editor,origin);
      edit = await execute(atlasTarget(id,true,fixture));
      await waitValues(execute,fixture,id,'to');
    }
    const editMs = performance.now()-started;
    const candidate = await capture(execute,fixture,id);
    const saveObserved = await saved;
    if (saveObserved instanceof Error) throw saveObserved;
    phase = 'normal original reopen';
    editor = await reopen(editor,context,workspace);
    const reopened = await capture(execute,fixture,id);
    const reopenMs = performance.now()-started;
    phase = 'independently verify Undo and Redo on native copy';
    editor = await reopen(editor,context,copy.url);
    const copyBefore = await verifyStart(execute,fixture,copy.id,'copy-before');
    if (enrolled) assert.equal(identityHash(copyBefore),enrolled.copyIdentitySha256);
    await editor.keyboard.press('Escape');
    await execute(atlasTarget(copy.id,true,fixture));
    await waitValues(execute,fixture,copy.id,'to');
    const copyEdited = await capture(execute,fixture,copy.id);
    const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
    await editor.keyboard.press(`${modifier}+z`);
    await waitValues(execute,fixture,copy.id,'from');
    const copyUndo = await capture(execute,fixture,copy.id);
    await editor.keyboard.press(`${modifier}+Shift+z`);
    await waitValues(execute,fixture,copy.id,'to');
    const copyRedo = await capture(execute,fixture,copy.id);
    phase = 'read the protected original';
    editor = await reopen(editor,context,workspace);
    const afterProbeOriginal = await capture(execute,fixture,id);
    const evidence = {
      before,candidate,reopened,edit,copy_before:copyBefore,copy_edited:copyEdited,copy_undo:copyUndo,copy_redo:copyRedo,
      copy_history:{undo_count:1,redo_count:1},after_probe_original:afterProbeOriginal,
      ...(modelCommand ? {modelTools} : {}),
    };
    await publishCandidate(process.env.OMC_BENCH_CANDIDATE,evidence);
    console.log(JSON.stringify({workload:'LD02',sourceFamily:fixture.source_family_id,setupMs,editMs,reopenMs,
      initialSaveObserved,saveObserved,
      scope:modelCommand ? 'model-assisted canonical native Atlas edit' : 'native product-only canonical Atlas gate'}));
  } catch (error) {
    const secrets = [email,password,endpoint?.searchParams.get('userToken')].filter(Boolean);
    const message = secrets.reduce((value,secret) => value.replaceAll(secret,'[redacted]'),String(error));
    throw new Error(`Penpot LD02 ${phase}: ${message}`);
  } finally {
    await Promise.allSettled([client.close(),browser?.close()]);
    const output = process.env.OMC_BENCH_OUTPUT_DIR;
    if (modelCommand && output) await writeFile(join(output,'ld02-model-actions.json'),
      JSON.stringify({edit,modelTools}) + '\n',{flag:'wx',mode:0o600});
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const {positionals,values} = parseArgs({allowPositionals:true,options:{
    'model-command':{type:'string'},prepare:{type:'string'},prepared:{type:'string'},
  }});
  assert.equal(positionals.length,2,
    'Use ld02-atlas.mjs LOOPBACK_ORIGIN CANONICAL_ATLAS.json [--prepare OUT | --prepared INPUT] [--model-command EXECUTABLE]');
  assert.ok(!values.prepare || (!values.prepared && !values['model-command']));
  assert.ok(values.prepare || process.env.OMC_BENCH_CANDIDATE,'Set OMC_BENCH_CANDIDATE for the independent neutral grader');
  const fixture = validateFixture(JSON.parse(await readFile(positionals[1],'utf8')));
  await replay(loopbackOrigin(positionals[0]),fixture,values['model-command'],values.prepare,values.prepared);
}
