import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdir, writeFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {makeCase, parsePlan} from './ld09.mjs';
import {
  connectEditor, createAccount, getMcpEndpoint, loopbackOrigin, newFile, waitForBackend,
} from '../penpot-ld02.mjs';

const fixture = makeCase('small', 0);

export function seedCode(fileId) {
  const spec = JSON.stringify({...fixture, fileId});
  return `
    const spec = ${spec};
    const file = penpot.currentFile;
    const page = penpot.currentPage;
    if (file.id !== spec.fileId || file.name !== spec.targetName || file.pages.length !== 1 ||
        page.root.children.length !== 0) throw new Error("Wrong blank benchmark file");
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
    if (page.root.children.length !== 1 || board?.children.length !== 3 || title?.characters !== spec.beforeText) {
      throw new Error("Prepared synthetic fixture did not survive reopen");
    }
    return true;
  `;
}

async function main(args) {
  assert.equal(args.length, 2, 'Use seed-small.mjs LOOPBACK_ORIGIN NEW_PRIVATE_DIRECTORY');
  const origin = loopbackOrigin(args[0]);
  const directory = resolve(args[1]);
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
    const dashboard = await context.newPage();
    await createAccount(dashboard, origin, email, password);
    console.log('Created isolated Penpot account');
    endpoint = await getMcpEndpoint(dashboard, origin);
    await client.connect(new StreamableHTTPClientTransport(endpoint));
    const editor = await newFile(dashboard, context, origin);
    await editor.getByRole('toolbar', {name:'Drawing tools'}).waitFor();
    const workspace = new URL(editor.url());
    const fileId = workspace.searchParams.get('file-id');
    assert.equal(workspace.origin, origin);
    assert.match(fileId, /^[a-f0-9-]{36}$/i);
    const title = editor.locator('header [class*="file-name-label"]');
    await title.dblclick();
    const field = editor.locator('header input[class*="file-name-input"]');
    await field.fill(fixture.targetName);
    await field.press('Enter');
    await editor.getByText(fixture.targetName, {exact:true}).waitFor();

    await connectEditor(editor);
    const execute = async code => {
      const response = await client.callTool({name:'execute_code', arguments:{code}}, undefined, {timeout:15000});
      assert.ok(!response.isError, 'Penpot MCP fixture request did not execute');
      const payload = JSON.parse(response.content[0].text);
      assert.ok(!payload.error && payload.result !== undefined, 'Penpot native seed or readback did not complete');
      return payload.result;
    };
    const saved = editor.waitForResponse(response => response.ok() && new URL(response.url()).origin === origin &&
      response.url().includes('/update-file') && response.request().method() === 'POST',
    {timeout:9000}).then(() => true, error => error.name === 'TimeoutError' ? false : error);
    const {pageId, textId} = await execute(seedCode(fileId));
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

    await reopened.goto(origin);
    await reopened.getByRole('button', {name:fixture.targetName, exact:true}).waitFor();
    const savedCatalog = await reopened.locator('[class*="grid-item-button"][title], [class*="list-item-row"][title]')
      .evaluateAll(items => items.map(item => item.getAttribute('title')));
    parsePlan({...plan, savedCatalog});
    const options = {flag:'wx', mode:0o600};
    await writeFile(join(directory,'storage-state.json'),
      JSON.stringify(await context.storageState({indexedDB:true})) + '\n', options);
    await writeFile(join(directory,'mcp-endpoint.txt'), endpoint.href + '\n', options);
    await writeFile(join(directory,'prepared.json'), JSON.stringify({...plan, savedCatalog}, null, 2) + '\n', options);
    console.log(JSON.stringify({workload:'LD09', prepared:true, savedLibraryEntries:0, logicalObjects:4,
      scope:'small prepared native solid-shape qualification', saveResponseObserved:saveSignal}));
  } catch (error) {
    const secrets = [email,password,endpoint?.searchParams.get('userToken')].filter(Boolean);
    throw new Error(secrets.reduce((value, secret) => value.replaceAll(secret, '[redacted]'), String(error)));
  } finally {
    await Promise.allSettled([client.close(), browser?.close()]);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main(process.argv.slice(2));
}
