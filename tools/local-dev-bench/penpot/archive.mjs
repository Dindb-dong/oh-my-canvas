import assert from 'node:assert/strict';
import {createHash, randomBytes} from 'node:crypto';
import {readFile, writeFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  connectEditor, createAccount, getMcpEndpoint, loopbackOrigin, waitForBackend,
} from '../penpot-ld02.mjs';
import {decodeNativeResult, makeCase, parsePlan, readAfterAttach} from './ld09.mjs';

const work = makeCase('small', 0);
const route = 'native-penpot-archive-import';
const schema = 'penpot-ld09-archive/1';
const id = /^[a-f0-9-]{36}$/i;
const cards = '[class*="grid-item-button"][title], [class*="list-item-row"][title]';
const phases = [
  'headless_launch_requested', 'headless_browser_ready', 'first_window',
  'fresh_project_ready', 'import_upload_requested', 'import_review_ready',
  'import_confirmed', 'import_complete', 'first_native_content', 'asset_font_ready',
  'native_equivalence_verified', 'first_accepted_edit', 'warm_reopen_requested',
  'warm_reopen_content', 'warm_reopen_verified',
];

function workspaceURL(page, origin) {
  const url = new URL(page.url());
  assert.equal(url.origin, origin);
  assert.equal(url.searchParams.get('screen'), 'workspace');
  assert.match(url.searchParams.get('file-id'), id);
  return url;
}

function catalogURL(input, origin) {
  const url = new URL(input);
  assert.equal(url.origin, origin);
  assert.equal(url.searchParams.get('screen'), 'dashboard-files');
  assert.match(url.searchParams.get('project-id'), id);
  return url;
}

export function archiveHash(bytes) {
  assert.ok(bytes.length >= 22 && bytes.length <= 4 * 1024 * 1024 && bytes.readUInt32BE(0) === 0x504b0304,
    'Expected a bounded native .penpot ZIP archive');
  return createHash('sha256').update(bytes).digest('hex');
}

export function snapshotCode(fileId, edit = false) {
  assert.match(fileId, id);
  return `
    const file = penpot.currentFile, page = penpot.currentPage;
    const spec = ${JSON.stringify(work)};
    if (file.id !== ${JSON.stringify(fileId)} || file.name !== spec.targetName ||
        file.pages.length !== 1 || page.name !== spec.openedPage) throw new Error("Wrong native archive fixture");
    const board = page.root.children.find(shape => shape.type === "board" && shape.name === spec.marker);
    const text = board?.children.find(shape => shape.type === "text" && shape.name === spec.layer);
    if (!text) throw new Error("Missing editable archive caption");
    ${edit ? `if (text.characters !== spec.beforeText) throw new Error("Unexpected caption");
      text.characters = spec.afterText;` : ''}
    const number = value => Math.round(value * 1e6) / 1e6;
    const shapes = [];
    const walk = (shape, parent) => {
      const row = {id:shape.id, name:shape.name, parent, type:shape.type,
        bounds:[shape.x,shape.y,shape.width,shape.height].map(number),
        fills:shape.fills.map(fill => [fill.fillColor,fill.fillOpacity]),
        editable:!shape.blocked && !shape.hidden};
      if (shape.type === "text") Object.assign(row, {text:shape.characters, font:shape.fontId, size:shape.fontSize});
      if (shape.flex) Object.assign(row, {layout:shape.flex.dir, gap:shape.flex.rowGap,
        padding:[shape.flex.topPadding,shape.flex.rightPadding,shape.flex.bottomPadding,shape.flex.leftPadding]});
      shapes.push(row);
      for (const child of shape.children ?? []) walk(child, shape.name);
    };
    for (const shape of page.root.children) walk(shape, null);
    return {fileId:file.id,pageId:page.id,fileName:file.name,pageName:page.name,shapes};
  `;
}

function verifyBaseline(state) {
  assert.match(state.fileId,id);
  assert.match(state.pageId,id);
  assert.equal(state.fileName,work.targetName);
  assert.equal(state.pageName,work.openedPage);
  assert.equal(state.shapes.length,work.logicalObjects);
  const names = new Map(state.shapes.map(shape => [shape.name,shape]));
  const board = names.get(work.marker);
  const caption = names.get(work.layer);
  assert.deepEqual([board.type,board.parent,board.layout,board.gap,board.bounds.slice(2),board.padding,board.fills],
    ['board',null,'column',12,[400,240],[16,16,16,16],[['#fffefa',1]]]);
  assert.deepEqual([caption.type,caption.parent,caption.text,caption.size],['text',work.marker,work.beforeText,'19']);
  for (const [name,type,width,height,fill] of [
    ['Qualification swatch','rectangle',64,32,'#2952a3'],
    ['Qualification indicator','ellipse',16,16,'#065f46'],
  ]) {
    const shape = names.get(name);
    assert.deepEqual([shape.type,shape.parent,shape.bounds.slice(2),shape.fills],
      [type,work.marker,[width,height],[[fill,1]]]);
  }
  for (const shape of state.shapes) {
    assert.match(shape.id,id);
    assert.ok(shape.editable && shape.bounds.every(Number.isFinite));
  }
  assert.equal(new Set(state.shapes.map(shape => shape.id)).size, work.logicalObjects);
}

function structure(state) {
  return state.shapes.map(({id,...shape}) => shape);
}

export function validateArchiveEvidence(bundle, evidence, bytes) {
  assert.equal(evidence.schema,schema);
  assert.equal(evidence.route,route);
  assert.equal(evidence.archiveSha256,archiveHash(bytes));
  assert.equal(evidence.archiveSha256,bundle.archiveSha256);
  assert.equal(typeof evidence.saveResponseObserved,'boolean');
  verifyBaseline(bundle.source);
  verifyBaseline(evidence.imported);
  assert.notEqual(evidence.imported.fileId,bundle.source.fileId);
  assert.deepEqual(structure(evidence.imported),structure(bundle.source), 'Native archive semantics differ');
  const expected = structuredClone(evidence.imported);
  const caption = expected.shapes.find(shape => shape.name === work.layer);
  caption.text = work.afterText;
  // Text content can legitimately change the native text box extent.
  for (const phase of ['edited','reopened']) {
    const current = structuredClone(evidence[phase]);
    const actualCaption = current.shapes.find(shape => shape.name === work.layer);
    assert.ok(actualCaption.bounds.every(Number.isFinite));
    actualCaption.bounds = caption.bounds;
    assert.deepEqual(current,expected,`${phase} lost a native identity, required edit, or protected shape`);
  }
  assert.deepEqual(evidence.edited,evidence.reopened,'Native shape properties changed on reopen');
  assert.deepEqual(evidence.events.map(event => event.name),phases);
  let previous = 0;
  for (const event of evidence.events) {
    if (['first_window','asset_font_ready'].includes(event.name)) {
      assert.equal(event.status,'unobservable');
      assert.equal(event.elapsedMs,undefined);
    } else {
      assert.equal(event.status,'observed');
      assert.ok(Number.isFinite(event.elapsedMs) && event.elapsedMs >= previous);
      previous = event.elapsedMs;
    }
  }
}

function clientFor(Client, transport, endpoint) {
  const client = new Client({name:'omc-penpot-archive',version:'1'});
  return {
    connect:() => client.connect(new transport(endpoint)),
    close:() => client.close(),
    execute:async code => decodeNativeResult(await client.callTool({
      name:'execute_code',arguments:{code},
    },undefined,{timeout:15000})),
  };
}

function endpointFor(value, origin) {
  const endpoint = URL.parse(value ?? '');
  assert.ok(endpoint?.origin === origin && endpoint.pathname === '/mcp/stream' &&
    !endpoint.username && !endpoint.password && !endpoint.hash && endpoint.searchParams.has('userToken'),
  'Use an exact task-local MCP endpoint');
  return endpoint;
}

async function nativePage(context, url) {
  const page = await context.newPage();
  await page.goto(url.href,{waitUntil:'commit'});
  await page.getByTestId('layer-row').getByText(work.marker,{exact:true}).waitFor();
  return page;
}

async function readSnapshot(page, mcp, fileId) {
  await connectEditor(page);
  return readAfterAttach(() => mcp.execute(snapshotCode(fileId)));
}

async function prepare(runtime, sourceDir, bundleDir) {
  const sourcePlan = parsePlan(JSON.parse(await readFile(join(sourceDir,'prepared.json'),'utf8')));
  assert.equal(sourcePlan.size,'small');
  assert.equal(sourcePlan.savedLibraryEntries,0);
  const origin = loopbackOrigin(sourcePlan.origin);
  const sourceEndpoint = endpointFor((await readFile(join(sourceDir,'mcp-endpoint.txt'),'utf8')).trim(),origin);
  const browser = await runtime.chromium.launch({channel:'chrome',headless:true});
  const sourceMcp = clientFor(runtime.Client,runtime.StreamableHTTPClientTransport,sourceEndpoint);
  const email = `omc-bench-${randomBytes(10).toString('hex')}@example.test`;
  const password = randomBytes(20).toString('hex') + 'Aa1!';
  let destinationEndpoint;
  let phase = 'read prepared source';
  try {
    const sourceContext = await browser.newContext({storageState:join(sourceDir,'storage-state.json'),locale:'en-US'});
    sourceContext.setDefaultTimeout(12000);
    await sourceMcp.connect();
    const editor = await nativePage(sourceContext,new URL(sourcePlan.workspaceUrl));
    const source = await readSnapshot(editor,sourceMcp,sourcePlan.fileId);
    verifyBaseline(source);
    await editor.close();

    phase = 'download source archive through Penpot dashboard';
    const dashboard = await sourceContext.newPage();
    await dashboard.goto(catalogURL(sourcePlan.catalogUrl,origin).href);
    const sourceCard = dashboard.getByRole('button',{name:work.targetName,exact:true});
    await sourceCard.hover();
    await sourceCard.locator('[id$="-action-menu"]').click();
    const exporting = performance.now();
    const savedDownload = dashboard.waitForEvent('download',{timeout:25000});
    const [download] = await Promise.all([savedDownload, dashboard.getByText('Download Penpot file (.penpot)',{exact:true}).click()]);
    assert.match(download.suggestedFilename(),/\.penpot$/i);
    const bytes = await readFile(await download.path());
    const digest = archiveHash(bytes);
    const exportElapsedMs = performance.now() - exporting;
    await sourceContext.close();

    phase = 'prepare a separate empty Penpot project';
    const targetContext = await browser.newContext({locale:'en-US',viewport:{width:1280,height:900}});
    targetContext.setDefaultTimeout(12000);
    const target = await targetContext.newPage();
    await createAccount(target,origin,email,password);
    destinationEndpoint = await getMcpEndpoint(target,origin);
    await target.goto(origin);
    await target.getByTestId('dashboard-sidebar').getByText('Drafts',{exact:true}).click();
    await target.waitForURL(/screen=dashboard-files/);
    await target.getByRole('button',{name:'+ New File',exact:true}).waitFor();
    assert.equal(await target.locator(cards).count(),0,'Destination project is not empty');
    const catalog = catalogURL(target.url(),origin);
    assert.notEqual(catalog.href,sourcePlan.catalogUrl);
    const options = {flag:'wx',mode:0o600};
    await writeFile(join(bundleDir,'fixture.penpot'),bytes,options);
    await writeFile(join(bundleDir,'storage-state.json'),JSON.stringify(await targetContext.storageState({indexedDB:true})),options);
    await writeFile(join(bundleDir,'mcp-endpoint.txt'),destinationEndpoint.href + '\n',options);
    const manifest = {schema,route,origin,catalogUrl:catalog.href,source,archiveSha256:digest,archiveBytes:bytes.length,exportElapsedMs};
    await writeFile(join(bundleDir,'archive-manifest.json'),JSON.stringify(manifest) + '\n',options);
    console.log(JSON.stringify({route,archiveSha256:digest,archiveBytes:bytes.length,exportElapsedMs,sourceShapes:source.shapes.length}));
  } catch (error) {
    const secrets = [email,password,sourceEndpoint.searchParams.get('userToken'),destinationEndpoint?.searchParams.get('userToken')].filter(Boolean);
    throw new Error(`${phase}: ${secrets.reduce((message, secret) => message.replaceAll(secret,'[redacted]'),String(error))}`);
  } finally {
    await Promise.allSettled([sourceMcp.close(),browser.close()]);
  }
}

async function importFixture(runtime, bundleDir, bundle, bytes, candidate) {
  const origin = loopbackOrigin(bundle.origin);
  const endpoint = endpointFor((await readFile(join(bundleDir,'mcp-endpoint.txt'),'utf8')).trim(),origin);
  const mcp = clientFor(runtime.Client,runtime.StreamableHTTPClientTransport,endpoint);
  const start = performance.now();
  const events = [];
  const mark = name => events.push({name,status:'observed',elapsedMs:performance.now()-start});
  mark('headless_launch_requested');
  let browser;
  let phase = 'launch headless browser';
  try {
    browser = await runtime.chromium.launch({channel:'chrome',headless:true});
    const context = await browser.newContext({storageState:join(bundleDir,'storage-state.json'),
      viewport:{width:1280,height:900},locale:'en-US'});
    context.setDefaultTimeout(14000);
    mark('headless_browser_ready');
    events.push({name:'first_window',status:'unobservable'});
    const dashboard = await context.newPage();
    const catalog = catalogURL(bundle.catalogUrl,origin);
    await dashboard.goto(catalog.href);
    await dashboard.getByRole('button',{name:'+ New File',exact:true}).waitFor();
    assert.equal(await dashboard.locator(cards).count(),0,'Refusing to import outside a fresh project');
    mark('fresh_project_ready');
    phase = 'import one archive through the Project Files menu';
    await dashboard.getByRole('button',{name:'Options',exact:true}).click();
    const chooser = dashboard.waitForEvent('filechooser');
    const [file] = await Promise.all([chooser,dashboard.getByText('Import Penpot files',{exact:true}).click()]);
    mark('import_upload_requested');
    // Use the exact bytes whose digest was checked before launch.
    await file.setFiles({name:'fixture.penpot',mimeType:'application/penpot',buffer:bytes});
    const modal = dashboard.locator('[class*="dashboard_import__modal-container"]');
    const review = modal.getByRole('button',{name:'Continue',exact:true});
    await review.waitFor();
    mark('import_review_ready');
    await review.click();
    mark('import_confirmed');
    const accept = modal.getByRole('button',{name:'Accept',exact:true});
    await accept.click();
    const card = dashboard.getByRole('button',{name:work.targetName,exact:true});
    await card.waitFor();
    assert.equal(await dashboard.locator(cards).count(),1);
    mark('import_complete');
    phase = 'open imported native fixture';
    const workspace = Promise.any([
      context.waitForEvent('page',{timeout:10000}),
      dashboard.waitForURL(/screen=workspace/,{timeout:10000}).then(() => dashboard),
    ]);
    let [editor] = await Promise.all([workspace,card.dblclick()]);
    await editor.waitForURL(/screen=workspace/);
    const url = workspaceURL(editor,origin);
    const fileId = url.searchParams.get('file-id');
    assert.notEqual(fileId,bundle.source.fileId);
    await editor.getByTestId('layer-row').getByText(work.marker,{exact:true}).waitFor();
    mark('first_native_content');
    events.push({name:'asset_font_ready',status:'unobservable'});
    await mcp.connect();
    const imported = await readSnapshot(editor,mcp,fileId);
    verifyBaseline(imported);
    assert.deepEqual(structure(imported),structure(bundle.source),'Imported native shapes differ');
    mark('native_equivalence_verified');
    const saved = editor.waitForResponse(response => response.ok() && response.url().includes('/update-file') &&
      new URL(response.url()).origin === origin && response.request().method() === 'POST',
    {timeout:8000}).then(() => true, error => error.name === 'TimeoutError' ? false : error);
    phase = 'edit imported native caption';
    await mcp.execute(snapshotCode(fileId,true));
    const edited = await readAfterAttach(() => mcp.execute(snapshotCode(fileId)));
    assert.equal(edited.shapes.find(shape => shape.name === work.layer).text,work.afterText);
    mark('first_accepted_edit');
    const saveResponseObserved = await saved;
    if (saveResponseObserved instanceof Error) throw saveResponseObserved;
    mark('warm_reopen_requested');
    phase = 'warm reopen imported native file';
    await editor.close();
    editor = await nativePage(context,url);
    mark('warm_reopen_content');
    const reopened = await readSnapshot(editor,mcp,fileId);
    mark('warm_reopen_verified');
    const evidence = {schema,route,archiveSha256:archiveHash(bytes),events,imported,edited,reopened,saveResponseObserved};
    await writeFile(candidate,JSON.stringify(evidence) + '\n',{flag:'wx',mode:0o600});
    console.log(JSON.stringify({route,events,saveResponseObserved}));
  } catch (error) {
    throw new Error(`${phase}: ${String(error).replaceAll(endpoint.searchParams.get('userToken'),'[redacted]')}`);
  } finally {
    await Promise.allSettled([mcp.close(),browser?.close()]);
  }
}

async function main([action,bundleDir,sourceDir]) {
  assert.ok(['prepare','run','accept'].includes(action) && bundleDir &&
    Boolean(sourceDir) === (action === 'prepare'),'Use archive.mjs prepare BUNDLE_DIR SOURCE_SEED_DIR, or run/accept BUNDLE_DIR');
  if (action === 'prepare') {
    const mcp = await import('../replays/mcp.mjs');
    const {chromium} = mcp.benchRequire('playwright');
    await prepare({...mcp,chromium},sourceDir,bundleDir);
    return;
  }
  const bundle = JSON.parse(await readFile(join(bundleDir,'archive-manifest.json'),'utf8'));
  assert.equal(bundle.schema,schema);
  assert.equal(bundle.route,route);
  const bytes = await readFile(join(bundleDir,'fixture.penpot'));
  assert.equal(bundle.archiveSha256,archiveHash(bytes));
  assert.equal(bundle.archiveBytes,bytes.length);
  const candidate = process.env.OMC_BENCH_CANDIDATE;
  assert.ok(candidate,'Set OMC_BENCH_CANDIDATE to the attempt evidence path');
  if (action === 'accept') {
    const evidence = JSON.parse(await readFile(candidate,'utf8'));
    validateArchiveEvidence(bundle,evidence,bytes);
    console.log(JSON.stringify({route,accepted:true,assets:'unobservable',presentation:'unobservable'}));
    return;
  }
  await waitForBackend(loopbackOrigin(bundle.origin));
  const mcp = await import('../replays/mcp.mjs');
  const {chromium} = mcp.benchRequire('playwright');
  await importFixture({...mcp,chromium},bundleDir,bundle,bytes,candidate);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main(process.argv.slice(2));
}
