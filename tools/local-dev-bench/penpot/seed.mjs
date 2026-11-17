import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdir, writeFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {makeCase, parsePlan} from './ld09.mjs';
import {
  connectEditor, createAccount, getMcpEndpoint, loopbackOrigin, newFile, waitForBackend,
} from '../penpot-ld02.mjs';

const solidCards = (makeCase('large', 0).logicalObjects - makeCase('small', 0).logicalObjects) / 4;
const batchSize = 25;

export function scaleBatches(fixture) {
  const count = fixture.size === 'large' ? solidCards : 0;
  return Array.from({length:Math.ceil(count / batchSize)}, (_, index) => {
    const start = index * batchSize;
    return {start, end:Math.min(start + batchSize, count)};
  });
}

export function scaleCode(fixture, fileId, {start, end}) {
  const identity = JSON.stringify({fileId, targetName:fixture.targetName});
  return `
    const spec = ${identity};
    const file = penpot.currentFile, page = penpot.currentPage;
    if (file.id !== spec.fileId || file.name !== spec.targetName || file.pages.length !== 1 ||
        page.root.children.length !== ${start}) throw new Error("Wrong synthetic scale seed state");
    for (let i = ${start}; i < ${end}; i++) {
      const board = penpot.createBoard();
      board.name = "LD09 scale card " + String(i + 1).padStart(3, "0");
      board.x = 480 + (i % 12) * 208;
      board.y = Math.floor(i / 12) * 144;
      board.resize(192,128);
      board.fills = [{fillColor:"#f4f7fb",fillOpacity:1}];
      const flex = board.addFlexLayout();
      flex.dir = "column";
      flex.rowGap = 8;
      flex.horizontalPadding = 12;
      flex.verticalPadding = 12;
      const label = penpot.createText("Inventory card " + String(i + 1).padStart(3, "0"));
      label.name = "Inventory caption";
      label.fontSize = "14";
      flex.appendChild(label);
      const swatch = penpot.createRectangle();
      swatch.name = "Inventory swatch";
      swatch.resize(64,24);
      swatch.fills = [{fillColor:"#2952a3",fillOpacity:1}];
      flex.appendChild(swatch);
      const dot = penpot.createEllipse();
      dot.name = "Inventory indicator";
      dot.resize(12,12);
      dot.fills = [{fillColor:"#065f46",fillOpacity:1}];
      flex.appendChild(dot);
    }
    return page.root.children.length;
  `;
}

export function seedCode(fileId, fixture = makeCase('small', 0)) {
  const spec = JSON.stringify({...fixture, fileId, priorCards:fixture.size === 'large' ? solidCards : 0});
  return `
    const spec = ${spec};
    const file = penpot.currentFile;
    const page = penpot.currentPage;
    if (file.id !== spec.fileId || file.name !== spec.targetName || file.pages.length !== 1 ||
        page.root.children.length !== spec.priorCards) throw new Error("Wrong synthetic fixture start state");
    page.name = spec.openedPage;
    const board = penpot.createBoard();
    board.name = spec.marker;
    board.resize(400,240);
    board.fills = [{fillColor:"#fffefa",fillOpacity:1}];
    const flex = board.addFlexLayout();
    flex.dir = "column";
    flex.rowGap = 12;
    flex.verticalPadding = 16;
    flex.horizontalPadding = 16;
    const caption = penpot.createText(spec.beforeText);
    caption.name = spec.layer;
    caption.fontSize = "19";
    flex.appendChild(caption);
    const swatch = penpot.createRectangle();
    swatch.name = "Qualification swatch";
    swatch.resize(64,32);
    swatch.fills = [{fillColor:"#2952a3",fillOpacity:1}];
    flex.appendChild(swatch);
    const dot = penpot.createEllipse();
    dot.name = "Qualification indicator";
    dot.resize(16,16);
    dot.fills = [{fillColor:"#065f46",fillOpacity:1}];
    flex.appendChild(dot);
    if (spec.priorCards > 0) board.bringToFront();
    return {pageId:page.id, textId:caption.id};
  `;
}

export function seedReadbackCode(plan) {
  return `
    const spec = ${JSON.stringify(plan)};
    const file = penpot.currentFile;
    const page = penpot.currentPage;
    if (file.id !== spec.fileId || file.name !== spec.targetName ||
        page.id !== spec.pageId || page.name !== spec.openedPage) throw new Error("Wrong reopened synthetic fixture");
    const board = page.root.children.find(node => node.type === "board" && node.name === spec.marker);
    const title = board?.children.find(node => node.type === "text" && node.id === spec.textId && node.name === spec.layer);
    const count = nodes => nodes.reduce((n, shape) => n + 1 + count(shape.children ?? []), 0);
    if (count(page.root.children) !== spec.logicalObjects || board?.children.length !== 3 ||
        title?.characters !== spec.beforeText) {
      throw new Error("Prepared synthetic fixture did not survive reopen");
    }
    return true;
  `;
}

function distractorCode(fileId, name) {
  return `
    const file = penpot.currentFile, page = penpot.currentPage;
    if (file.id !== ${JSON.stringify(fileId)} || file.name !== ${JSON.stringify(name)} ||
        file.pages.length !== 1 || page.root.children.length !== 0) throw new Error("Wrong synthetic catalog file");
    const tile = penpot.createRectangle();
    tile.name = "LD09 saved catalog tile";
    tile.resize(64,64);
    tile.fills = [{fillColor:"#2952a3",fillOpacity:1}];
    return page.root.children.length;
  `;
}

async function renamedFile(dashboard, context, origin, name) {
  const editor = await newFile(dashboard, context, origin);
  await editor.getByRole('toolbar', {name:'Drawing tools'}).waitFor();
  const workspace = new URL(editor.url());
  assert.equal(workspace.origin, origin);
  const fileId = workspace.searchParams.get('file-id');
  assert.match(fileId, /^[a-f0-9-]{36}$/i);
  const title = editor.locator('header [class*="file-name-label"]');
  await title.dblclick();
  const field = editor.locator('header input[class*="file-name-input"]');
  await field.fill(name);
  await field.press('Enter');
  await editor.getByText(name, {exact:true}).waitFor();
  return {editor, workspace, fileId};
}

function updateResponse(editor, origin) {
  return editor.waitForResponse(response => response.ok() && new URL(response.url()).origin === origin &&
    response.url().includes('/update-file') && response.request().method() === 'POST',
  {timeout:9000}).then(() => true, error => error.name === 'TimeoutError' ? false : error);
}

async function readProjectCatalog(context, workspace, origin, fixture) {
  // Penpot's Project Files screen lists the full catalog in modified-time order.
  const catalog = Promise.any([
    context.waitForEvent('page', {timeout:10000}),
    workspace.waitForURL(/screen=dashboard-files/, {timeout:10000}).then(() => workspace),
  ]);
  const [page] = await Promise.all([catalog, workspace.locator('header [class*="project-name"]').click()]);
  await page.waitForURL(/screen=dashboard-files/, {timeout:10000});
  assert.equal(new URL(page.url()).origin, origin);
  await page.getByRole('button', {name:fixture.targetName, exact:true}).waitFor();
  const savedCatalog = await page.locator('[class*="grid-item-button"][title], [class*="list-item-row"][title]')
    .evaluateAll(items => items.map(item => item.getAttribute('title')));
  return {savedCatalog, catalogOrder:'modified-desc', catalogUrl:page.url()};
}

export async function prepareFixture(originInput, directoryInput, fixture) {
  const origin = loopbackOrigin(originInput);
  const directory = resolve(directoryInput);
  await mkdir(directory, {mode:0o700});
  await waitForBackend(origin);
  const {benchRequire, Client, StreamableHTTPClientTransport} = await import('../replays/mcp.mjs');
  const {chromium} = benchRequire('playwright');
  const email = `omc-bench-${randomBytes(10).toString('hex')}@example.test`;
  const password = randomBytes(20).toString('hex') + 'Aa1!';
  const client = new Client({name:'omc-ld09-seed', version:'1'});
  let browser, endpoint;
  try {
    browser = await chromium.launch({channel:'chrome', headless:true});
    const context = await browser.newContext({locale:'en-US', viewport:{width:1280,height:900}});
    let dashboard = await context.newPage();
    await createAccount(dashboard, origin, email, password);
    console.log('Created isolated Penpot account');
    endpoint = await getMcpEndpoint(dashboard, origin);
    await client.connect(new StreamableHTTPClientTransport(endpoint));
    const execute = async code => {
      const response = await client.callTool({name:'execute_code', arguments:{code}}, undefined, {timeout:15000});
      assert.ok(!response.isError, 'Penpot MCP fixture request did not execute');
      const payload = JSON.parse(response.content[0].text);
      assert.ok(!payload.error && payload.result !== undefined, 'Penpot native seed or readback did not complete');
      return payload.result;
    };
    const fixtureIds = new Set();
    for (const name of fixture.distractorNames) {
      const {editor, fileId} = await renamedFile(dashboard, context, origin, name);
      assert.ok(!fixtureIds.has(fileId), 'Duplicate native catalog file identity');
      fixtureIds.add(fileId);
      await connectEditor(editor);
      const saved = updateResponse(editor, origin);
      assert.equal(await execute(distractorCode(fileId, name)), 1);
      const saveSignal = await saved;
      if (saveSignal instanceof Error) throw saveSignal;
      assert.equal(saveSignal, true, 'Catalog tile save was not observed');
      if (editor === dashboard) dashboard = await context.newPage();
      await editor.close();
      if (fixtureIds.size % 15 === 0) console.log(`Saved ${fixtureIds.size} catalog files`);
    }

    const {editor, workspace, fileId} = await renamedFile(dashboard, context, origin, fixture.targetName);
    assert.ok(!fixtureIds.has(fileId), 'Target reuses a distractor file identity');
    await connectEditor(editor);
    for (const batch of scaleBatches(fixture)) {
      assert.equal(await execute(scaleCode(fixture, fileId, batch)), batch.end);
    }
    const saved = updateResponse(editor, origin);
    const {pageId, textId} = await execute(seedCode(fileId, fixture));
    workspace.searchParams.set('page-id', pageId);
    const saveSignal = await saved;
    if (saveSignal instanceof Error) throw saveSignal;
    const reopened = editor === dashboard ? await context.newPage() : dashboard;
    await editor.close();
    await reopened.goto(workspace.href);
    await connectEditor(reopened);
    const plan = {
      size:fixture.size, savedLibraryEntries:fixture.savedLibraryEntries,
      origin, workspaceUrl:workspace.href, fileId, pageId, textId,
    };
    assert.equal(await execute(seedReadbackCode({...fixture, ...plan})), true);
    console.log('Prepared native fixture survived reopening');

    const catalog = await readProjectCatalog(context, reopened, origin, fixture);
    parsePlan({...plan, ...catalog});
    const options = {flag:'wx', mode:0o600};
    await writeFile(join(directory,'storage-state.json'),
      JSON.stringify(await context.storageState({indexedDB:true})) + '\n', options);
    await writeFile(join(directory,'mcp-endpoint.txt'), endpoint.href + '\n', options);
    await writeFile(join(directory,'prepared.json'), JSON.stringify({...plan, ...catalog}, null, 2) + '\n', options);
    console.log(JSON.stringify({workload:'LD09', prepared:true, size:fixture.size,
      savedLibraryEntries:fixture.savedLibraryEntries, logicalObjects:fixture.logicalObjects,
      catalogOrder:catalog.catalogOrder, scope:'prepared native solid-shape fixture', saveResponseObserved:saveSignal}));
  } catch (error) {
    const secrets = [email,password,endpoint?.searchParams.get('userToken')].filter(Boolean);
    throw new Error(secrets.reduce((value, secret) => value.replaceAll(secret, '[redacted]'), String(error)));
  } finally {
    await Promise.allSettled([client.close(), browser?.close()]);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [origin, directory, size, count] = process.argv.slice(2);
  assert.equal(process.argv.length, 6, 'Use seed.mjs LOOPBACK_ORIGIN NEW_PRIVATE_DIRECTORY SIZE COUNT');
  assert.match(count, /^(0|15|100)$/);
  await prepareFixture(origin, directory, makeCase(size, Number(count)));
}
