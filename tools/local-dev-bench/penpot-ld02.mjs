import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {isDeepStrictEqual} from 'node:util';
import {fixture, target} from './replays/ld02-fixture.mjs';

const name = 'OMC Benchmark';
const prefix = 'LD02 Pilot / ';
const {page:batch, card:cardName, before:initial, after:edited} = target;
const expected = {label:edited.text, gap:edited.gap, fill:edited.fill, reference:initial.reference};

function loopbackOrigin(input) {
  const url = new URL(input);
  assert.ok(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    && url.port && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash,
  'Pass the explicit HTTP loopback origin of a disposable Penpot stack, including its port');
  return url.origin;
}

async function waitForBackend(origin, fetchProfile = fetch) {
  const deadline = performance.now() + 45000;
  let lastStatus = 'unreachable';
  while (performance.now() < deadline) {
    const response = await fetchProfile(new URL('/api/main/methods/get-profile', origin), {
      redirect:'error', signal:AbortSignal.timeout(2500),
    }).catch(() => null);
    if (response) {
      const ready = response.ok && response.headers.get('content-type')?.includes('application/transit+json');
      lastStatus = `HTTP ${response.status}`;
      await response.body?.cancel();
      if (ready) return;
    }
    await delay(500);
  }
  throw new Error(`Penpot profile API was not ready after 45 seconds (${lastStatus})`);
}

async function createAccount(page, origin, email, password) {
  const response = await page.goto(origin);
  assert.equal(new URL(page.url()).origin, origin);
  const signup = page.getByText('Create an account', {exact:false});
  try {
    await signup.click();
  } catch (error) {
    const loginVisible = await page.getByRole('heading', {name:'Log into my account'}).isVisible();
    throw new Error(`Penpot signup unavailable (page HTTP ${response?.status()}, login heading visible: ${loginVisible}, signup matches: ${await signup.count()}): ${error.message}`);
  }
  await page.getByRole('textbox', {name:'Full Name'}).fill(name);
  await page.getByRole('textbox', {name:'Work email'}).fill(email);
  await page.getByRole('textbox', {name:'Password'}).fill(password);
  await page.getByRole('button', {name:'Create an account'}).click();
  await page.getByRole('textbox', {name:'Full Name'}).waitFor({state:'hidden'});
  if (await page.getByRole('heading', {name:'Log into my account'}).isVisible()) {
    await page.getByRole('textbox', {name:'Work email'}).fill(email);
    await page.getByRole('textbox', {name:'Password'}).fill(password);
    await page.getByRole('button', {name:'Continue'}).click();
  }
  await page.getByRole('button', {name:'+ New File', exact:true}).waitFor();
  const personal = page.getByRole('heading', {name:'Help us get to know you'});
  if (await personal.isVisible()) {
    await page.getByText('Personal', {exact:true}).click();
    await page.getByRole('combobox').first().click();
    await page.getByRole('option', {name:'Development'}).click();
    await page.getByRole('button', {name:'Next', exact:true}).first().click();
    await page.getByText('Figma', {exact:true}).first().click();
    await page.getByRole('button', {name:'Next', exact:true}).first().click();
    await page.getByText('Generating real code from designs', {exact:true}).click();
    await page.getByRole('button', {name:'Start', exact:true}).click();
    await page.getByText('Continue without team', {exact:true}).click();
  }
}

async function getMcpEndpoint(page, origin) {
  await page.getByRole('button', {name:`${name} ${name}`}).click();
  await page.getByRole('menuitem', {name:'Your account'}).click();
  await page.getByText('Integrations', {exact:true}).click();
  const settings = page.getByRole('region', {name:'Integrations'});
  await settings.getByRole('heading', {name:'MCP Server'}).waitFor();
  if (await settings.getByRole('switch', {name:'Disabled'}).isVisible()) {
    await settings.locator('[class*=mcp-server-switch-cover]').click();
    await page.getByRole('button', {name:'Generate MCP key', exact:true}).click();
    await page.getByRole('heading', {name:'MCP key generated'}).waitFor();
  }
  const url = new URL(await settings.getByRole('textbox').inputValue());
  assert.ok(url.origin === origin && url.pathname === '/mcp/stream' && url.searchParams.has('userToken'),
    'Penpot returned an MCP URL outside the selected local instance');
  return url;
}

async function newFile(page, context, origin) {
  await page.goto(origin);
  const workspace = Promise.any([
    context.waitForEvent('page', {timeout:10000}),
    page.waitForURL(/screen=workspace/, {timeout:10000}).then(() => page),
  ]);
  const [editor] = await Promise.all([workspace, page.getByRole('button', {name:'+ New File', exact:true}).click()]);
  await editor.waitForURL(/screen=workspace/, {timeout:10000});
  return editor;
}

async function connectEditor(editor) {
  await editor.getByRole('toolbar', {name:'Drawing tools'}).waitFor();
  await editor.getByRole('button', {name:'MCP', exact:true}).click();
  const connect = editor.getByRole('menuitem', {name:/^Connect( here)?$/});
  const connected = editor.getByText('MCP connected', {exact:true});
  await connect.or(connected).first().waitFor();
  if (await connect.isVisible()) {
    try {
      await connect.click({timeout:1500});
    } catch (error) {
      // Reconnect can replace the action while Playwright is waiting to click it.
      if (error.name !== 'TimeoutError' || !(await connected.isVisible())) throw error;
      return;
    }
    await editor.getByText(/Connected to MCP/i).first().waitFor({timeout:3000}).catch(() => {});
  }
}

function seedCode(guard, page) {
  const cards = page.children.map(c => [
    c.name, c.x, c.y, c.width, c.height, c.padding, c.gap, c.children[0].text, c.children[1].text,
  ]);
  return `${guard}
    const page = penpot.createPage();
    page.name = ${JSON.stringify(prefix + page.name)};
    await penpot.openPage(page);
    for (const [name,x,y,w,h,pad,gap,caption,reference] of ${JSON.stringify(cards)}) {
      const board = penpot.createBoard();
      board.name = name;
      board.x = x;
      board.y = y;
      board.resize(w,h);
      board.fills = [{fillColor:"#ffffff",fillOpacity:1}];
      const flex = board.addFlexLayout();
      flex.dir = "column";
      flex.rowGap = gap;
      flex.verticalPadding = pad;
      flex.horizontalPadding = pad;
      flex.alignItems = "start";
      for (const [str,role] of [[caption,"Caption"],[reference,"Reference"]]) {
        const text = penpot.createText(str);
        text.name = role;
        text.fontSize = "16";
        flex.appendChild(text);
      }
      const rect = penpot.createRectangle();
      rect.name = "Swatch";
      rect.resize(64,32);
      rect.fills = [{fillColor:${JSON.stringify(initial.fill)},fillOpacity:1}];
      flex.appendChild(rect);
    }
    const live = penpot.currentPage.root.children;
    return {cards:live.length, objects:live.reduce((n,c) => n + 1 + c.children.length, 0)};
  `;
}

const targetCode = `
  const page = penpot.currentFile.pages.find(p => p.name === ${JSON.stringify(prefix + batch)});
  if (penpot.currentPage.id !== page.id) await penpot.openPage(page);
  const card = penpot.currentPage.root.children.find(c => c.name === ${JSON.stringify(cardName)});
  const label = card.children.find(n => n.name === "Caption");
  const reference = card.children.find(n => n.name === "Reference");
  const swatch = card.children.find(n => n.name === "Swatch");
`;
const readTargetCode = `
  return {id:card.id, labelId:label.id, referenceId:reference.id, swatchId:swatch.id,
    label:label.characters, gap:card.flex.rowGap, fill:swatch.fills[0].fillColor, reference:reference.characters};
`;

// Read the file through the Plugin API without navigating away from the Undo/Redo page.
const pageInventoryCode = `
  return penpot.currentFile.pages.map(page => ({id:page.id, name:page.name}));
`;
function pageSnapshotCode(pageId) {
  return `
    const page = penpot.currentFile.pages.find(page => page.id === ${JSON.stringify(pageId)});
    const fills = shape => shape.fills.map(fill => [fill.fillColor, fill.fillOpacity]);
    return page.root.children.map(board => ({
      id:board.id, type:board.type, name:board.name, x:board.x, y:board.y,
      width:board.width, height:board.height, fills:fills(board),
      direction:board.flex.dir, gap:board.flex.rowGap, align:board.flex.alignItems,
      padding:[board.flex.topPadding, board.flex.rightPadding, board.flex.bottomPadding, board.flex.leftPadding],
      children:board.children.map(node => {
        const identity = {id:node.id, type:node.type, name:node.name};
        if (node.type === "text") {
          return {...identity, text:node.characters, fontSize:node.fontSize};
        }
        return {...identity, width:node.width, height:node.height, fills:fills(node)};
      }),
    }));
  `;
}

async function snapshotFile(execute, guard) {
  const pages = await execute(guard + pageInventoryCode);
  assert.equal(pages.length, fixture.pages.length + 1, 'Unexpected disposable file page count');
  for (const page of pages) {
    page.cards = await execute(guard + pageSnapshotCode(page.id));
  }
  return pages;
}

function validateBaseline(pages) {
  assert.equal(pages.length, fixture.pages.length + 1, 'Expected one empty page plus the fixture');
  const identities = new Set();
  const identity = id => {
    assert.ok(typeof id === 'string' && id.length > 0 && !identities.has(id), 'Invalid or duplicate native identity');
    identities.add(id);
  };
  for (const page of pages) identity(page.id);
  const pageNames = new Set(fixture.pages.map(page => prefix + page.name));
  const sparePages = pages.filter(page => !pageNames.has(page.name));
  assert.equal(sparePages.length, 1, 'Unexpected native file page inventory');
  assert.deepEqual(sparePages[0].cards, [], 'Expected an empty native default page');
  let logicalObjects = 0;
  for (const spec of fixture.pages) {
    const page = pages.find(page => page.name === prefix + spec.name);
    assert.equal(page?.cards.length, spec.children.length, `Fixture card count on ${spec.name}`);
    for (const card of spec.children) {
      const native = page.cards.find(native => native.name === card.name);
      assert.ok(native, `Missing ${spec.name} / ${card.name}`);
      const {id, name, children, x, y, width, height, ...properties} = native;
      identity(id);
      // A native resize can introduce floating-point residue in otherwise identical fixture dimensions.
      for (const [dimension, actual, expected] of [['width', width, card.width], ['height', height, card.height]]) {
        assert.ok(Number.isFinite(actual) && Math.abs(actual - expected) <= 1e-9,
          `Native board ${dimension} for ${spec.name} / ${name}: expected ${expected}, got ${actual}`);
      }
      assert.deepEqual(properties, {
        type:'board', fills:[['#ffffff', 1]],
        direction:'column', gap:card.gap, align:'start', padding:Array(4).fill(card.padding),
      }, `Native board properties for ${spec.name} / ${name}`);
      assert.deepEqual({x, y}, {x:card.x, y:card.y}, `Native board position for ${spec.name} / ${name}`);
      const expectedChildren = [
        {type:'text', name:'Caption', text:card.children[0].text, fontSize:'16'},
        {type:'text', name:'Reference', text:card.children[1].text, fontSize:'16'},
        {type:'rectangle', name:'Swatch', width:card.children[2].width, height:card.children[2].height,
          fills:[[card.children[2].fill, 1]]},
      ];
      assert.equal(children.length, expectedChildren.length);
      for (const expectedChild of expectedChildren) {
        const child = children.find(candidate => candidate.name === expectedChild.name);
        assert.ok(child, `Missing ${spec.name} / ${name} / ${expectedChild.name}`);
        const {id, ...properties} = child;
        identity(id);
        assert.deepEqual(properties, expectedChild);
      }
      logicalObjects += 1 + children.length;
    }
  }
  assert.equal(logicalObjects, fixture.logicalObjects);
}

function validateEvidence(evidence) {
  const {schema, workload, before, changed, undone, redone, reopened} = evidence;
  assert.equal(schema, 'penpot-ld02-v1');
  assert.equal(workload, fixture.workload);
  validateBaseline(before);
  const expectedAfter = structuredClone(before);
  const card = expectedAfter.find(page => page.name === prefix + batch).cards.find(card => card.name === cardName);
  card.children.find(node => node.name === 'Caption').text = edited.text;
  card.children.find(node => node.name === 'Swatch').fills[0][0] = edited.fill;
  card.gap = edited.gap;
  for (const [phase, actual, expected] of [
    ['Initial edit', changed, expectedAfter], ['Undo', undone, before],
    ['Redo', redone, expectedAfter], ['Normal reopen', reopened, expectedAfter],
  ]) {
    assert.ok(isDeepStrictEqual(actual, expected), `${phase} differs from the required full-file semantics or identities`);
  }
}

const editTargetCode = targetCode + `
  const block = penpot.history.undoBlockBegin();
  try {
    label.characters = ${JSON.stringify(edited.text)};
    card.flex.rowGap = ${edited.gap};
    swatch.fills = [{fillColor:${JSON.stringify(edited.fill)},fillOpacity:1}];
  } finally {
    penpot.history.undoBlockFinish(block);
  }
  return true;
`;

async function waitForTarget(execute, code, expected, phase) {
  const deadline = performance.now() + 5000;
  do {
    const actual = await execute(code);
    if (isDeepStrictEqual(actual, expected)) return;
    await delay(100);
  } while (performance.now() < deadline);
  throw new Error(`${phase} did not produce the expected native target state`);
}

async function replay(origin) {
  await waitForBackend(origin);
  const {benchRequire, Client, StreamableHTTPClientTransport} = await import('./replays/mcp.mjs');
  const {chromium} = benchRequire('playwright');
  const profile = await mkdtemp(join(tmpdir(), 'omc-penpot-ld02-'));
  const email = `omc-bench-${randomBytes(10).toString('hex')}@example.test`;
  const password = randomBytes(20).toString('hex') + 'Aa1!';
  const launch = () => chromium.launchPersistentContext(profile, {
    channel:'chrome', headless:true, locale:'en-US', viewport:{width:1280,height:900},
  });
  let context, client, endpoint;
  let cleanupPromise;
  const cleanup = () => cleanupPromise ??= (async () => {
    await Promise.allSettled([client?.close(), context?.close()]);
    await rm(profile, {recursive:true, force:true});
  })();
  const stop = signal => {
    void cleanup().finally(() => process.exit(signal === 'SIGINT' ? 130 : 143));
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    context = await launch();
    const page = context.pages()[0];
    await createAccount(page, origin, email, password);
    endpoint = await getMcpEndpoint(page, origin);
    client = new Client({name:'omc-ld02-replay', version:'1'});
    await client.connect(new StreamableHTTPClientTransport(endpoint));
    const execute = async code => {
      const response = await client.callTool({name:'execute_code', arguments:{code}}, undefined, {timeout:60000});
      assert.ok(!response.isError, JSON.stringify(response.content));
      const payload = JSON.parse(response.content[0].text);
      assert.ok(!payload.error && payload.result !== undefined, JSON.stringify(payload));
      return payload.result;
    };
    const editor = await newFile(page, context, origin);
    const url = new URL(editor.url());
    assert.equal(url.origin, origin);
    const fileId = url.searchParams.get('file-id');
    assert.match(fileId, /^[a-f0-9-]{36}$/);
    await connectEditor(editor);
    const before = await execute('return {fileId:penpot.currentFile.id, children:penpot.currentPage.root.children.length};');
    assert.deepEqual(before, {fileId, children:0});
    const guard = `if (penpot.currentFile.id !== ${JSON.stringify(fileId)}) throw new Error("Wrong synthetic file");`;
    for (const fixturePage of fixture.pages) {
      assert.deepEqual(await execute(seedCode(guard, fixturePage)), {cards:25, objects:100});
    }
    const evidence = {schema:'penpot-ld02-v1', workload:fixture.workload};
    evidence.before = await snapshotFile(execute, guard);
    const readTarget = guard + targetCode + readTargetCode;
    const card = evidence.before.find(page => page.name === prefix + batch).cards.find(card => card.name === cardName);
    const targetBefore = {
      id:card.id, labelId:card.children.find(node => node.name === 'Caption').id,
      referenceId:card.children.find(node => node.name === 'Reference').id,
      swatchId:card.children.find(node => node.name === 'Swatch').id,
      label:initial.text, gap:initial.gap, fill:initial.fill, reference:initial.reference,
    };
    const targetAfter = {...targetBefore, ...expected};
    await editor.keyboard.press('Escape');
    const started = performance.now();
    await execute(guard + editTargetCode);
    await waitForTarget(execute, readTarget, targetAfter, 'Edit');
    const editMs = performance.now() - started;
    evidence.changed = await snapshotFile(execute, guard);

    const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
    await editor.keyboard.press(`${modifier}+z`);
    await waitForTarget(execute, readTarget, targetBefore, 'Undo');
    evidence.undone = await snapshotFile(execute, guard);

    const saved = editor.waitForResponse(response => response.url().includes('/update-file')
      && response.request().method() === 'POST' && response.ok(), {timeout:8000}).catch(() => null);
    await editor.keyboard.press(`${modifier}+Shift+z`);
    await waitForTarget(execute, readTarget, targetAfter, 'Redo');
    evidence.redone = await snapshotFile(execute, guard);
    const saveObserved = Boolean(await saved);

    await context.close();
    context = await launch();
    const reopened = context.pages()[0];
    await reopened.goto(url.href);
    await connectEditor(reopened);
    evidence.reopened = await snapshotFile(execute, guard);
    const elapsed = performance.now() - started;
    const candidate = process.env.OMC_BENCH_CANDIDATE;
    if (candidate) {
      await writeFile(candidate, JSON.stringify(evidence) + '\n', {flag:'wx', mode:0o600});
    } else {
      validateEvidence(evidence);
    }
    console.log(JSON.stringify({
      workload:'LD02', logical_objects:fixture.logicalObjects, pages:fixture.pages.length, edit_ms:editMs,
      edit_undo_redo_reopen_ms:elapsed, save_response_observed:saveObserved,
      scope:'isolated deterministic edit with full-file semantic and identity snapshots',
    }));
  } catch (error) {
    const secrets = [email, password, endpoint?.searchParams.get('userToken')].filter(Boolean);
    const sanitized = secrets.reduce((value, secret) => value.replaceAll(secret, '[redacted]'), String(error));
    throw new Error(sanitized);
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    await cleanup();
  }
}

async function selfTestEvidence() {
  let sequence = 0;
  let undoBlock;
  const makePage = () => ({id:`page-${sequence++}`, name:'Page 1', root:{children:[]}});
  const makeShape = (type, properties = {}) => ({
    id:`shape-${sequence++}`, type, ...properties,
    resize(width, height) { Object.assign(this, {width, height}); },
  });
  const firstPage = makePage();
  const penpot = {
    currentPage:firstPage, currentFile:{id:'test-file', pages:[firstPage]},
    createPage() {
      const page = makePage();
      this.currentFile.pages.push(page);
      return page;
    },
    async openPage(page) { this.currentPage = page; },
    createBoard() {
      const board = makeShape('board', {
        children:[],
        addFlexLayout() {
          this.flex = {
            set verticalPadding(pad) { this.topPadding = this.bottomPadding = pad; },
            set horizontalPadding(pad) { this.leftPadding = this.rightPadding = pad; },
            appendChild: child => this.children.push(child),
          };
          return this.flex;
        },
      });
      this.currentPage.root.children.push(board);
      return board;
    },
    createText(text) { return makeShape('text', {characters:text}); },
    createRectangle() { return makeShape('rectangle'); },
    history:{
      undoBlockBegin() { return undoBlock = Symbol('edit'); },
      undoBlockFinish(block) { assert.equal(block, undoBlock); undoBlock = undefined; },
    },
  };
  const AsyncFunction = (async () => {}).constructor;
  const execute = async code => JSON.parse(JSON.stringify(await new AsyncFunction('penpot', code)(penpot)));
  const guard = 'if (penpot.currentFile.id !== "test-file") throw new Error("Wrong synthetic file");';
  for (const page of fixture.pages) {
    assert.deepEqual(await execute(seedCode(guard, page)), {cards:25, objects:100});
  }
  const firstBoard = penpot.currentFile.pages[1].root.children[0];
  firstBoard.width = 224.00000000000003;
  const before = await snapshotFile(execute, guard);
  await execute(guard + editTargetCode);
  assert.equal(undoBlock, undefined);
  const changed = await snapshotFile(execute, guard);
  const evidence = {schema:'penpot-ld02-v1', workload:fixture.workload,
    before, changed, undone:before, redone:changed, reopened:changed};
  validateEvidence(evidence);
  const invalidBefore = structuredClone(before);
  invalidBefore[1].cards[0].width = 225;
  assert.throws(() => validateEvidence({...evidence, before:invalidBefore}), /Native board width/);
  const invalidRedo = structuredClone(changed);
  invalidRedo[1].cards[0].width = 224;
  assert.throws(() => validateEvidence({...evidence, redone:invalidRedo}), /Redo differs/);
  assert.throws(() => validateEvidence({...evidence, undone:changed}), /Undo differs/);
  assert.throws(() => validateEvidence({...evidence, redone:before}), /Redo differs/);
  const reopened = structuredClone(changed);
  reopened[1].cards[0].children[0].id = 'replacement';
  assert.throws(() => validateEvidence({...evidence, reopened}), /Normal reopen differs/);
  reopened[1].cards[0].children[0].id = changed[1].cards[0].children[0].id;
  reopened[1].cards[0].children[1].text = 'unrelated edit';
  assert.throws(() => validateEvidence({...evidence, reopened}), /Normal reopen differs/);
}

if (process.argv.length !== 3) {
  console.error('Usage: node tools/local-dev-bench/penpot-ld02.mjs <loopback-origin|--accept|--self-test>');
  process.exitCode = 2;
} else if (process.argv[2] === '--accept') {
  const candidate = process.env.OMC_BENCH_CANDIDATE;
  assert.ok(candidate, 'Set OMC_BENCH_CANDIDATE to the producer snapshot');
  try {
    validateEvidence(JSON.parse(await readFile(candidate, 'utf8')));
    console.log(JSON.stringify({
      workload:'LD02', accepted:true, checks:['fixture', 'edit', 'undo', 'redo', 'normal_reopen', 'native_identities', 'protected_scope'],
    }));
  } catch (error) {
    console.log(JSON.stringify({workload:'LD02', accepted:false, reason:error.message}));
    process.exitCode = 1;
  }
} else if (process.argv[2] === '--self-test') {
  assert.equal(loopbackOrigin('http://localhost:19001'), 'http://localhost:19001');
  for (const bad of ['https://localhost:19001', 'http://example.test:19001', 'http://user@localhost:19001',
    'http://localhost:19001/mcp', 'http://localhost:19001/?secret=1', 'http://localhost']) {
    assert.throws(() => loopbackOrigin(bad));
  }
  assert.equal(fixture.pages.length, 10);
  const page = fixture.pages.find(candidate => candidate.name === batch);
  assert.equal(page.children.length, 25);
  assert.ok(seedCode('if (false) throw new Error();', page).includes(cardName));
  let requests = 0;
  await waitForBackend('http://localhost:19001', async url => {
    assert.equal(url.href, 'http://localhost:19001/api/main/methods/get-profile');
    if (++requests === 1) return new Response('bad gateway', {status:502});
    return new Response('{}', {headers:{'content-type':'application/transit+json'}});
  });
  assert.equal(requests, 2);
  await selfTestEvidence();
} else {
  await replay(loopbackOrigin(process.argv[2]));
}
