import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
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

async function createAccount(page, origin, email, password) {
  await page.goto(origin);
  assert.equal(new URL(page.url()).origin, origin);
  await page.getByText('Create an account', {exact:false}).click();
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
  if (await connect.isVisible()) {
    await connect.click();
    await editor.getByText(/Connected to MCP/i).first().waitFor({timeout:3000}).catch(() => {});
  } else {
    await editor.getByRole('menuitem', {name:/^Disconnect/}).waitFor();
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
  await penpot.openPage(page);
  const card = penpot.currentPage.root.children.find(c => c.name === ${JSON.stringify(cardName)});
  const label = card.children.find(n => n.name === "Caption");
  const reference = card.children.find(n => n.name === "Reference");
  const swatch = card.children.find(n => n.name === "Swatch");
`;
const readTargetCode = `
  return {id:card.id, labelId:label.id, referenceId:reference.id, swatchId:swatch.id,
    label:label.characters, gap:card.flex.rowGap, fill:swatch.fills[0].fillColor, reference:reference.characters};
`;

async function replay(origin) {
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
    const started = performance.now();
    const saved = editor.waitForResponse(response => response.url().includes('/update-file')
      && response.request().method() === 'POST' && response.ok(), {timeout:8000}).catch(() => null);
    const changed = await execute(guard + targetCode + `
      if (label.characters !== ${JSON.stringify(initial.text)} || card.flex.rowGap !== ${initial.gap} ||
          reference.characters !== ${JSON.stringify(initial.reference)} ||
          swatch.fills[0].fillColor !== ${JSON.stringify(initial.fill)}) {
        throw new Error("Unexpected starting state");
      }
      label.characters = ${JSON.stringify(edited.text)};
      card.flex.rowGap = ${edited.gap};
      swatch.fills = [{fillColor:${JSON.stringify(edited.fill)},fillOpacity:1}];
    ` + readTargetCode);
    const editMs = performance.now() - started;
    const {id, labelId, referenceId, swatchId, ...values} = changed;
    assert.deepEqual(values, expected);
    assert.equal(new Set([id, labelId, referenceId, swatchId]).size, 4);
    const saveObserved = Boolean(await saved);

    await context.close();
    context = await launch();
    const reopened = context.pages()[0];
    await reopened.goto(url.href);
    await connectEditor(reopened);
    assert.deepEqual(await execute(guard + targetCode + readTargetCode), changed);
    console.log(JSON.stringify({
      workload:'LD02', logical_objects:1000, pages:10, edit_ms:editMs,
      edit_to_verified_reopen_ms:performance.now() - started, save_response_observed:saveObserved,
      target_reopened:true, scope:'deterministic scoped edit and target readback',
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

if (process.argv.length !== 3) {
  console.error('Usage: node tools/local-dev-bench/penpot-ld02.mjs <loopback-origin|--self-test>');
  process.exitCode = 2;
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
} else {
  await replay(loopbackOrigin(process.argv[2]));
}
