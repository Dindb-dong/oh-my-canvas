import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile, writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';

const prefix = 'OMC Benchmark LD09 / ';
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const sha256 = /^[a-f0-9]{64}$/;
const poolSizes = [0, 15, 100];
const route = 'prepared-native-file-open';
const marker = 'LD09 lifecycle board';
const layer = 'LD09 editable caption';
const beforeText = 'Library status: awaiting review';
const afterText = 'Library status: ready for review';
const schema = 'penpot-ld09-v1';
const assetSchema = 'asset-response-sha256-and-browser-font';
const notObserved = reason => ({status:'unobservable', reason});

export function makeCase(size, savedLibraryEntries) {
  assert.ok(['small', 'large'].includes(size), 'Choose small or large');
  assert.ok(poolSizes.includes(savedLibraryEntries), 'Choose 0, 15, or 100 distractor files');
  return {
    workload:'LD09', product:'penpot-local', route,
    size, savedLibraryEntries,
    tier:size === 'small' && savedLibraryEntries === 0 ? 'qualification' : 'prepared-scale',
    targetName:`${prefix}${size} / ${savedLibraryEntries}`,
    openedPage:'LD09 lifecycle',
    marker, layer, beforeText, afterText,
    logicalObjects:size === 'small' ? 4 : 1000,
    distractorNames:Array.from({length:savedLibraryEntries}, (_, index) =>
      `${prefix}catalog ${String(index + 1).padStart(3, '0')}`),
  };
}

export function parsePlan(plan) {
  const testCase = makeCase(plan.size, plan.savedLibraryEntries);
  const url = new URL(plan.origin);
  assert.ok(url.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(url.hostname)
    && url.port && url.href === `${url.origin}/`, 'Use a disposable HTTP loopback Penpot origin');
  for (const key of ['fileId', 'pageId', 'textId']) assert.match(plan[key], uuid, `Invalid ${key}`);
  assert.equal(new Set([plan.fileId, plan.pageId, plan.textId]).size, 3);
  const workspace = new URL(plan.workspaceUrl);
  assert.ok(workspace.origin === url.origin && !workspace.username && !workspace.password &&
    workspace.searchParams.get('screen') === 'workspace' && workspace.searchParams.get('file-id') === plan.fileId &&
    workspace.searchParams.get('page-id') === plan.pageId, 'Provide the exact prepared native workspace URL');
  assert.ok(Array.isArray(plan.savedCatalog), 'Provide the observed isolated project catalog');
  assert.deepEqual([...plan.savedCatalog].sort(), [testCase.targetName, ...testCase.distractorNames].sort());
  if (plan.assetFont) {
    const {assetPaths, fontFamily, fontId} = plan.assetFont;
    assert.ok(assetPaths && Object.keys(assetPaths).length > 0, 'Provide registered workspace image response paths');
    for (const [pathname, hash] of Object.entries(assetPaths)) {
      const image = new URL(pathname, url);
      assert.ok(image.origin === url.origin && image.pathname === pathname && pathname.startsWith('/assets/'));
      assert.match(hash, sha256);
    }
    assert.ok(typeof fontFamily === 'string' && fontFamily.trim(), 'Provide the exact browser font family');
    assert.ok(typeof fontId === 'string' && fontId.trim(), 'Provide the native font ID');
  }
  return {...plan, ...testCase, origin:url.origin};
}

function checkState(plan, actual, text) {
  assert.deepEqual({
    fileId:actual.fileId, fileName:actual.fileName, pageId:actual.pageId, pageName:actual.pageName,
    textId:actual.textId, logicalObjects:actual.logicalObjects, text:actual.text,
  }, {
    fileId:plan.fileId, fileName:plan.targetName, pageId:plan.pageId, pageName:plan.openedPage,
    textId:plan.textId, logicalObjects:plan.logicalObjects, text,
  }, 'Native document fixture, identity, count, or text differs');
  if (plan.assetFont) assert.equal(actual.fontId, plan.assetFont.fontId);
}

export function validateEvidence(plan, evidence) {
  assert.equal(evidence.schema, schema);
  assert.deepEqual(evidence.testCase, makeCase(plan.size, plan.savedLibraryEntries));
  checkState(plan, evidence.before, beforeText);
  checkState(plan, evidence.edited, afterText);
  checkState(plan, evidence.reopened, afterText);
  assert.deepEqual(evidence.events.map(event => event.name), [
    'headless_launch_requested', 'headless_browser_ready', 'first_window', 'first_native_content',
    'asset_font_ready', 'first_accepted_edit', 'warm_reopen_requested', 'warm_reopen_content',
    'warm_reopen_verified',
  ]);
  assert.equal(evidence.events.find(event => event.name === 'first_window').status, 'unobservable');
  assert.equal(typeof evidence.saveResponseObserved, 'boolean');
  let previous = 0;
  for (const event of evidence.events) {
    if (event.status === 'observed') {
      assert.ok(Number.isFinite(event.elapsedMs) && event.elapsedMs >= previous, 'Lifecycle clocks are not monotonic');
      previous = event.elapsedMs;
    } else {
      assert.ok(['first_window','asset_font_ready'].includes(event.name));
      assert.equal(event.status, 'unobservable');
      assert.equal(typeof event.reason, 'string');
      assert.equal(event.elapsedMs, undefined);
    }
  }
  const asset = evidence.events.find(event => event.name === 'asset_font_ready');
  if (asset.status === 'observed') {
    assert.ok(plan.assetFont, 'Asset/font readiness requires registered evidence');
    assert.equal(asset.method, assetSchema);
    assert.deepEqual(asset.assetPaths, plan.assetFont.assetPaths);
    assert.equal(asset.fontFamily, plan.assetFont.fontFamily);
  }
}

export async function collectLifecycle(plan, driver, now = performance.now.bind(performance)) {
  const origin = now();
  const events = [];
  const mark = (name, fields = {}) => events.push({name, status:'observed', elapsedMs:now() - origin, ...fields});
  mark('headless_launch_requested');
  await driver.launch();
  mark('headless_browser_ready');
  events.push({name:'first_window', ...notObserved('Headless Chrome has no visible OS window')});
  await driver.open();
  mark('first_native_content', {surface:'Penpot Layers panel fixture marker'});
  const before = await driver.readNative();
  checkState(plan, before, beforeText);
  const readiness = await driver.assetFontReady();
  if (readiness.status === 'observed') mark('asset_font_ready', readiness);
  else events.push({name:'asset_font_ready', ...readiness});
  await driver.edit();
  const edited = await driver.readNative();
  checkState(plan, edited, afterText);
  mark('first_accepted_edit', {surface:'Plugin API independent readback'});
  const saveResponseObserved = await driver.waitForSave();
  mark('warm_reopen_requested');
  await driver.reopen();
  mark('warm_reopen_content', {surface:'Penpot Layers panel fixture marker'});
  const reopened = await driver.readNative();
  checkState(plan, reopened, afterText);
  mark('warm_reopen_verified', {surface:'Plugin API independent readback'});
  return {
    schema, testCase:makeCase(plan.size, plan.savedLibraryEntries), events, before, edited, reopened,
    browserCache:'fresh-browser-process; warm reopen in the same browser context', hostCache:'uncontrolled',
    catalogEvidence:'operator-prepared saved-project inventory', saveResponseObserved,
  };
}

function nativeCode(plan, edit = false) {
  const facts = JSON.stringify({
    fileId:plan.fileId, fileName:plan.targetName, pageId:plan.pageId, pageName:plan.openedPage,
    marker, textId:plan.textId, layer, beforeText, afterText, logicalObjects:plan.logicalObjects,
  });
  return `
    const spec = ${facts};
    const file = penpot.currentFile, page = penpot.currentPage;
    if (file.id !== spec.fileId || file.name !== spec.fileName ||
        page.id !== spec.pageId || page.name !== spec.pageName) throw new Error("Wrong prepared synthetic file");
    const board = page.root.children.find(shape => shape.type === "board" && shape.name === spec.marker);
    const text = board?.children.find(shape => shape.id === spec.textId && shape.name === spec.layer && shape.type === "text");
    if (!text) throw new Error("Missing synthetic caption");
    const count = nodes => nodes.reduce((n, shape) => n + 1 + count(shape.children ?? []), 0);
    const logicalObjects = count(page.root.children);
    if (logicalObjects !== spec.logicalObjects) throw new Error("Wrong prepared document size");
    ${edit ? `if (text.characters !== spec.beforeText) throw new Error("Wrong initial caption"); text.characters = spec.afterText;` : ''}
    return {fileId:file.id, fileName:file.name, pageId:page.id, pageName:page.name,
      textId:text.id, logicalObjects, text:text.characters, fontId:text.fontId};
  `;
}

async function createDriver(plan, storageState, endpoint) {
  const {benchRequire, Client, StreamableHTTPClientTransport} = await import('../replays/mcp.mjs');
  const {chromium} = benchRequire('playwright');
  let browser, context, page, saved;
  let clientConnected = false;
  let editorConnected = false;
  const assetHashes = {};
  const client = new Client({name:'omc-ld09-qualification', version:'1'});
  const open = async () => {
    editorConnected = false;
    page = await context.newPage();
    page.setDefaultTimeout(10000);
    if (plan.assetFont) {
      page.on('response', response => {
        const url = new URL(response.url());
        if (url.origin !== plan.origin || !response.ok() || !Object.hasOwn(plan.assetFont.assetPaths, url.pathname)) return;
        void response.body().then(bytes => {
          assetHashes[url.pathname] = createHash('sha256').update(bytes).digest('hex');
        }).catch(() => {});
      });
    }
    await page.goto(plan.workspaceUrl, {waitUntil:'commit'});
    assert.equal(new URL(page.url()).origin, plan.origin);
    await page.getByText(marker, {exact:true}).waitFor({state:'visible'});
  };
  const connectEditor = async () => {
    await page.getByRole('button', {name:'MCP', exact:true}).click();
    const button = page.getByRole('menuitem', {name:/^Connect( here)?$/});
    const status = page.getByText('MCP connected', {exact:true});
    await button.or(status).first().waitFor();
    if (await button.isVisible()) {
      try {
        await button.click({timeout:1500});
      } catch (error) {
        if (error.name !== 'TimeoutError' || !(await status.isVisible())) throw error;
      }
    }
  };
  const execute = async code => {
    const response = await client.callTool({name:'execute_code', arguments:{code}}, undefined, {timeout:20000});
    assert.ok(!response.isError, 'Penpot MCP did not execute the requested read or edit');
    const payload = JSON.parse(response.content[0].text);
    assert.ok(!payload.error && payload.result !== undefined, 'Penpot native fixture operation failed');
    return payload.result;
  };
  return {
    async launch() {
      browser = await chromium.launch({channel:'chrome', headless:true});
      context = await browser.newContext({storageState, locale:'en-US', viewport:{width:1280,height:900}});
    },
    open,
    async readNative() {
      if (!clientConnected) {
        await client.connect(new StreamableHTTPClientTransport(endpoint));
        clientConnected = true;
      }
      if (!editorConnected) {
        await connectEditor();
        editorConnected = true;
      }
      return execute(nativeCode(plan));
    },
    async assetFontReady() {
      if (!plan.assetFont) return notObserved('No registered image responses or browser-visible font were provided');
      const {assetPaths, fontFamily} = plan.assetFont;
      const paths = Object.keys(assetPaths);
      const captured = () => paths.every(path => Object.hasOwn(assetHashes, path));
      const waitForAssets = async () => {
        const deadline = performance.now() + 5000;
        while (!captured() && performance.now() < deadline) await delay(50);
      };
      const [font] = await Promise.all([
        page.waitForFunction(family => Array.from(document.fonts).some(face =>
          face.family.replace(/^["']|["']$/g, '') === family && face.status === 'loaded'), fontFamily,
        {timeout:5000}).catch(error => {
          if (error.name !== 'TimeoutError') throw error;
          return null;
        }),
        waitForAssets(),
      ]);
      await font?.dispose();
      for (const [pathname, hash] of Object.entries(assetPaths)) {
        if (assetHashes[pathname] !== undefined) assert.equal(assetHashes[pathname], hash, 'Workspace image bytes differ');
      }
      if (!font || !captured()) {
        return notObserved('The workspace did not expose every registered image response and loaded CSS font');
      }
      return {status:'observed', method:assetSchema, fontFamily, assetPaths};
    },
    async edit() {
      saved = page.waitForResponse(response => response.ok() && new URL(response.url()).origin === plan.origin
        && response.url().includes('/update-file') && response.request().method() === 'POST',
      {timeout:10000}).then(() => true, error => error.name === 'TimeoutError' ? false : error);
      await execute(nativeCode(plan, true));
    },
    async waitForSave() {
      const result = await saved;
      if (result instanceof Error) throw result;
      return result;
    },
    async reopen() {
      await page.close();
      await open();
    },
    async close() { await Promise.allSettled([client.close(), browser?.close()]); },
  };
}

async function main(args) {
  const [action, input, count] = args;
  if (action === 'plan' && input && count !== undefined && args.length === 3) {
    assert.match(count, /^(0|15|100)$/);
    console.log(JSON.stringify(makeCase(input, Number(count)), null, 2));
    return;
  }
  assert.ok(['run', 'accept'].includes(action) && args.length === 2, 'Use plan SIZE COUNT, run PREPARED.json, or accept PREPARED.json');
  const plan = parsePlan(JSON.parse(await readFile(input, 'utf8')));
  const candidate = process.env.OMC_BENCH_CANDIDATE;
  assert.ok(candidate, 'Set OMC_BENCH_CANDIDATE to the attempt evidence file');
  if (action === 'accept') {
    const evidence = JSON.parse(await readFile(candidate, 'utf8'));
    validateEvidence(plan, evidence);
    console.log(JSON.stringify({
      workload:'LD09', accepted:true, scope:'prepared native lifecycle',
      assetFontReady:evidence.events.find(event => event.name === 'asset_font_ready').status,
      presentation:'unobservable',
    }));
    return;
  }
  const storageState = process.env.PENPOT_BENCH_STORAGE_STATE;
  const endpoint = URL.parse(process.env.PENPOT_BENCH_MCP_URL ?? '');
  assert.ok(storageState && endpoint?.origin === plan.origin && endpoint.pathname === '/mcp/stream' &&
    !endpoint.username && !endpoint.password && !endpoint.hash && endpoint.searchParams.get('userToken'),
  'Use prepared synthetic test account state and its exact local MCP endpoint');
  const driver = await createDriver(plan, storageState, endpoint);
  try {
    const evidence = await collectLifecycle(plan, driver);
    await writeFile(candidate, JSON.stringify(evidence) + '\n', {flag:'wx', mode:0o600});
    console.log(JSON.stringify({workload:'LD09', route, size:plan.size, savedLibraryEntries:plan.savedLibraryEntries,
      events:evidence.events}));
  } catch (error) {
    throw new Error(String(error).replaceAll(endpoint.searchParams.get('userToken'), '[redacted]'));
  } finally {
    await driver.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main(process.argv.slice(2));
}
