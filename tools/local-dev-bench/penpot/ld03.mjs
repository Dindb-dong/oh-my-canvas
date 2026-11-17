import assert from 'node:assert/strict';
import {createHash, randomBytes} from 'node:crypto';
import {lstat, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {isDeepStrictEqual, parseArgs} from 'node:util';
import {fileURLToPath} from 'node:url';
import {
  connectEditor, createAccount, getMcpEndpoint, loopbackOrigin, newFile, waitForBackend,
} from '../penpot-ld02.mjs';
import {decodeNativeResult, readAfterAttach} from './ld09.mjs';
import {runLD03Agent, withLD03Broker} from '../ld03-model.mjs';
import {publishCandidate} from '../publish-candidate.mjs';

const marker = 'LD03 ';
const tokenSet = 'LD03 shared values';
const idPattern = /^[a-f0-9-]{36}$/i;
const card = /^target\/(\d+)\/(\d+)$/;

export function planFieldRelay(fixture) {
  assert.equal(fixture.workload, 'LD03');
  const edition = fixture.source_family_id === 'edition-grid';
  assert.ok(edition || fixture.source_family_id === 'field-relay', 'Unknown LD03 fixture family');
  assert.equal(fixture.start.nodes.length, fixture.logical_objects);
  assert.equal(fixture.target_references, 40);
  assert.equal(fixture.local_overrides, 4);
  const keys = new Set();
  return fixture.start.nodes.map(node => {
    assert.ok(!keys.has(node.key));
    assert.ok(node.parent === null || keys.has(node.parent), 'Expected parent-before-child fixture order');
    keys.add(node.key);
    const match = card.exec(node.key);
    let box;
    if (node.key === 'board') box = [0, 0, 1440, 960];
    // Edition grid gives each department wrapper two separate ten-card columns.
    else if (node.key === 'board/editorial') box = [20, 76, 552, 844];
    else if (node.key === 'board/distribution') box = [596, 76, 552, 844];
    else if (match) {
      const row = Number(match[2]);
      box = edition ? [10, 44 + row * 78, 240, 74] : [10, 46 + row * 98, 204, 90];
    } else if (/^target\/\d+$/.test(node.key)) {
      const group = Number(node.key.at(-1));
      box = edition ? [8 + (group % 2) * 268, 8, 260, 828] : [20 + group * 232, 76, 224, 844];
    } else if (node.key === 'keep') box = [1180, 76, 240, 844];
    else if (/^keep\/\d+$/.test(node.key)) box = [10, 46 + Number(node.key.at(-1)) * 98, 216, 90];
    if (node.kind !== 'text') assert.ok(box, `No geometry for LD03 object ${node.key}`);
    return {...node, box};
  });
}

function guard(fileId) {
  assert.match(fileId, idPattern);
  return `if (penpot.currentFile.id !== ${JSON.stringify(fileId)}) throw new Error("Wrong isolated LD03 file");`;
}

export function seedFieldRelay(fixture, fileId) {
  const nodes = planFieldRelay(fixture);
  return `${guard(fileId)}
    const page = penpot.currentPage;
    if (page.root.children.length !== 0 || penpot.currentFile.pages.length !== 1) throw new Error("Expected a blank fixture");
    const catalog = penpot.library.local.tokens;
    if (!catalog || typeof catalog.addSet !== "function") throw new Error("Native design token catalog unavailable");
    const set = catalog.addSet({name:${JSON.stringify(tokenSet)}});
    if (!set.active) set.toggleActive();
    const tokens = new Map();
    for (const style of ${JSON.stringify(fixture.start.styles)}) {
      const token = set.addToken({name:style.key, type:style.kind === "length" ? "spacing" : style.kind,
        value:String(style.value)});
      if (!token || !token.id) throw new Error("Native token creation failed for " + style.key);
      tokens.set(style.key, token);
    }

    const index = new Map();
    const add = ${JSON.stringify(nodes)};
    for (const spec of add) {
      const shape = spec.kind === "text" ? penpot.createText(spec.text) : penpot.createBoard();
      shape.name = ${JSON.stringify(marker)} + spec.key;
      index.set(spec.key, shape);
      const parent = index.get(spec.parent);
      if (parent?.flex) parent.flex.appendChild(shape);
      else if (parent) parent.appendChild(shape);
      if (spec.kind === "text") {
        shape.fontSize = spec.key === "board/title" ? "30" : "14";
        if (!parent?.flex) {
          shape.parentX = 12;
          shape.parentY = 10;
        }
      } else {
        const [x,y,w,h] = spec.box;
        shape.resize(w,h);
        if (parent) {
          shape.parentX = x;
          shape.parentY = y;
        } else {
          shape.x = x;
          shape.y = y;
        }
        shape.fills = [{fillColor:spec.fill ?? "#f4f6fa",fillOpacity:1}];
        if (spec.layout === "vertical") {
          const flex = shape.addFlexLayout();
          flex.dir = "column";
          flex.rowGap = spec.gap;
          flex.horizontalPadding = 8;
          flex.verticalPadding = 6;
        }
      }
    }
    for (const spec of add) {
      for (const [property, key] of Object.entries(spec.bindings ?? {})) {
        index.get(spec.key).applyToken(tokens.get(key), [property === "gap" ? "rowGap" : property]);
      }
    }
    return {nodes:index.size, styles:tokens.size};
  `;
}

export function readFieldRelay(fileId) {
  return `${guard(fileId)}
    const catalog = penpot.library.local.tokens;
    const set = catalog.sets.find(candidate => candidate.name === ${JSON.stringify(tokenSet)});
    if (!set?.active) throw new Error("Prepared token set is missing or inactive");
    const styles = set.tokens.map(token => ({
      key:token.name, native_id:token.id,
      kind:token.type === "spacing" ? "length" : token.type,
      value:token.type === "spacing" ? Number(token.value) : token.value.toLowerCase(),
    }));
    const styleIds = new Map(styles.map(token => [token.key,token.native_id]));
    const prefix = ${JSON.stringify(marker)};
    const nodes = [];
    const walk = (shape, parent) => {
      if (!shape.name.startsWith(prefix)) throw new Error("Unexpected unmarked LD03 object");
      // Penpot stores slash-separated layer names with spaced path separators.
      const key = shape.name.slice(prefix.length).replaceAll(" / ", "/");
      const row = {key, native_id:shape.id, parent, editable: !shape.blocked && !shape.hidden,
        kind:shape.type === "board" ? "frame" : shape.type};
      if (shape.type === "text") row.text = shape.characters;
      if (shape.flex) {
        row.layout = shape.flex.dir === "column" ? "vertical" : shape.flex.dir;
        row.fill = shape.fills[0]?.fillColor?.toLowerCase();
        row.gap = shape.flex.rowGap;
      }
      row.bindings = Object.fromEntries(Object.entries(shape.tokens ?? {}).map(([prop, name]) =>
        [prop === "rowGap" ? "gap" : prop, styleIds.get(name) ?? "unknown token: " + name]));
      nodes.push(row);
      for (const child of shape.children ?? []) walk(child, key);
    };
    if (penpot.currentFile.pages.length !== 1) throw new Error("Unexpected LD03 file pages");
    for (const child of penpot.currentPage.root.children) walk(child, null);
    return {document_id:penpot.currentFile.id, nodes, styles};
  `;
}

export function changeFieldRelay(fileId, changes, nativeIds) {
  assert.equal(changes.length, 2);
  assert.deepEqual(changes.map(change => change.key).sort(), ['target.accent','target.spacing']);
  return `${guard(fileId)}
    const set = penpot.library.local.tokens.sets.find(candidate => candidate.name === ${JSON.stringify(tokenSet)});
    if (!set?.active) throw new Error("Missing active benchmark tokens");
    const ids = ${JSON.stringify(nativeIds ?? null)};
    const changes = ${JSON.stringify(changes)};
    const tokens = changes.map(change => {
      const token = set.tokens.find(candidate => candidate.name === change.key);
      if (!token || token.type !== (change.key.endsWith(".spacing") ? "spacing" : "color") ||
          (ids && token.id !== ids[change.key])) throw new Error("Wrong native token");
      return token;
    });
    return changes.map((change,index) => {
      const token = tokens[index];
      token.value = String(change.value);
      return {op:"set_style", key:token.name, value:change.value};
    });
  `;
}

export function refreshFieldRelay(fileId) {
  return `${guard(fileId)}
    const set = penpot.library.local.tokens.sets.find(candidate => candidate.name === ${JSON.stringify(tokenSet)});
    if (!set?.active) throw new Error("Missing active benchmark tokens");
    // The Penpot 2.19.2 plugin value setter commits the definition. The
    // idempotent public activation setter invokes native workspace propagation.
    set.active = true;
    return set.active;
  `;
}

function compactFieldRelay(fileId, nativeIds) {
  return `${guard(fileId)}
    const set = penpot.library.local.tokens.sets.find(candidate => candidate.name === ${JSON.stringify(tokenSet)});
    if (!set?.active) throw new Error("Missing active benchmark tokens");
    const tokens = new Map(set.tokens.map(token => [token.name,token]));
    const expected = ${JSON.stringify(nativeIds)};
    if (tokens.size !== Object.keys(expected).length) throw new Error("Unexpected native token set");
    for (const [key,id] of Object.entries(expected)) {
      const token = tokens.get(key);
      if (!token || token.id !== id || token.type !== (key.endsWith(".spacing") ? "spacing" : "color")) {
        throw new Error("Benchmark token identity changed");
      }
    }
    const values = family => ({accent:tokens.get(family + ".accent").value.toLowerCase(),
      spacing_px:Number(tokens.get(family + ".spacing").value)});
    return {target:values("target"),archive:values("keep")};
  `;
}

export async function runFieldRelayModel({execute,fileId,before,modelCommand,modelTools,candidateActions,beforeWrite}) {
  assert.equal(before.document_id, fileId);
  const ids = Object.fromEntries(before.styles.map(style => [style.key,style.native_id]));
  assert.deepEqual(Object.keys(ids).sort(), ['keep.accent','keep.spacing','target.accent','target.spacing']);
  assert.ok(Object.values(ids).every(value => typeof value === 'string' && value));
  assert.equal(new Set(Object.values(ids)).size,4);
  const inspect = () => readAfterAttach(() => execute(compactFieldRelay(fileId,ids)));
  const privateDir = await mkdtemp(join(tmpdir(),'omc-penpot-ld03-'));
  const socketPath = join(privateDir,'agent.sock');
  const cancel = new AbortController();
  const interrupt = () => cancel.abort();
  for (const signal of ['SIGINT','SIGTERM']) process.once(signal,interrupt);
  try {
    await withLD03Broker(socketPath, {
      inspect,
      apply:async ({accent,spacing_px}) => {
        const previous = await inspect();
        const changes = [{key:'target.accent',value:accent},{key:'target.spacing',value:spacing_px}];
        beforeWrite?.();
        await execute(changeFieldRelay(fileId, changes, ids));
        assert.equal(await execute(refreshFieldRelay(fileId)),true);
        const current = await inspect();
        assert.deepEqual(current.target,{accent,spacing_px},'The native token definitions did not persist the model request');
        assert.deepEqual(current.archive,previous.archive,'A protected native archive token changed');
        for (const change of changes) {
          candidateActions.push({op:'set_style',key:change.key,nativeId:ids[change.key],value:change.value});
        }
        return current;
      },
    },modelTools,() => runLD03Agent(modelCommand,socketPath,cancel.signal));
    assert.ok(candidateActions.length,'The model did not complete a native target token write');
  } finally {
    for (const signal of ['SIGINT','SIGTERM']) process.off(signal,interrupt);
    await rm(privateDir,{recursive:true,force:true});
  }
}

function identities(state) {
  return Object.fromEntries(['nodes','styles'].map(collection => [collection,
    Object.fromEntries(state[collection].map(row => [row.key,row.native_id])),
  ]));
}

async function storeObservation(name, evidence) {
  const output = process.env.OMC_BENCH_OUTPUT_DIR;
  if (output) await writeFile(join(output, name), JSON.stringify(evidence) + '\n', {flag:'wx', mode:0o600});
}

export function stateDifferences(spec, state) {
  const differences = [];
  const styles = new Map(state.styles.map(style => [style.key,style]));
  const shapes = new Map(state.nodes.map(node => [node.key,node]));
  if (state.nodes.length !== spec.nodes.length) differences.push('nodes.count');
  if (state.styles.length !== spec.styles.length) differences.push('styles.count');
  for (const style of spec.styles) {
    if (styles.get(style.key)?.value !== style.value) differences.push(style.key + '.value');
  }
  for (const node of spec.nodes) {
    const row = shapes.get(node.key);
    if (!row) {
      differences.push(node.key + '.missing');
      continue;
    }
    if (row.editable !== true) differences.push(node.key + '.editable');
    const {bindings, ...properties} = node;
    for (const [key, value] of Object.entries(properties)) {
      if (row[key] !== value) differences.push(node.key + '.' + key);
    }
    const expected = Object.fromEntries(Object.entries(bindings ?? {}).map(([prop, key]) =>
      [prop, styles.get(key)?.native_id]));
    if (!isDeepStrictEqual(row.bindings, expected)) differences.push(node.key + '.bindings');
  }
  return differences;
}

async function requireState(spec, state, phase) {
  const differences = stateDifferences(spec, state);
  if (!differences.length) return;
  await storeObservation(`ld03-${phase}-failure.json`, {phase, differences, state});
  throw new Error(`${phase}: ${differences.length} differences (${differences.slice(0,8).join(', ')})`);
}

async function takeState(execute, fileId, spec) {
  const deadline = performance.now() + 6500;
  let state;
  do {
    state = await readAfterAttach(() => execute(readFieldRelay(fileId)));
    if (!stateDifferences(spec, state).length) return state;
    await delay(150);
  } while (performance.now() < deadline);
  return state;
}

export function watchSave(page, origin) {
  return page.waitForResponse(response => response.ok() && new URL(response.url()).origin === origin &&
    response.url().includes('/update-file') && response.request().method() === 'POST',
  {timeout:8000}).then(() => true, error => error.name === 'TimeoutError' ? false : error);
}

export async function reopenPage(page, context, workspace) {
  const next = await context.newPage();
  await page.close();
  await next.goto(workspace.href);
  await connectEditor(next);
  return next;
}

export async function duplicateFromDashboard(page, context, origin, name) {
  const dashboard = await context.newPage();
  await page.close();
  await dashboard.goto(origin);
  const source = dashboard.getByRole('button', {name:name, exact:true});
  await source.hover();
  await source.locator('[id$="-action-menu"]').click();
  await dashboard.getByText('Duplicate', {exact:true}).click();

  const cards = dashboard.locator('[class*="grid-item-button"][title], [class*="list-item-row"][title]');
  await cards.nth(1).waitFor({state:'visible'});
  const titles = await cards.evaluateAll(items => items.map(item => item.getAttribute('title')));
  assert.equal(titles.length, 2, 'Expected one original and one native duplicate on the disposable account');
  assert.ok(titles.includes(name), 'Original benchmark card missing');
  const copy = titles.find(title => title !== name);
  assert.ok(copy.startsWith(name), 'Unexpected duplicate file');
  const duplicate = dashboard.getByRole('button', {name:copy, exact:true});
  const editor = Promise.any([
    context.waitForEvent('page', {timeout:10000}),
    dashboard.waitForURL(/screen=workspace/, {timeout:10000}).then(() => dashboard),
  ]);
  const [opened] = await Promise.all([editor, duplicate.dblclick()]);
  await opened.waitForURL(/screen=workspace/, {timeout:10000});
  if (opened !== dashboard) await dashboard.close();
  const url = new URL(opened.url());
  assert.equal(url.origin, origin);
  await connectEditor(opened);
  return {opened, url, id:url.searchParams.get('file-id')};
}

export function preparedIdentityHash(state) {
  const pairs = rows => rows.map(({key,native_id})=>[key,native_id]).sort(([a],[b])=>a.localeCompare(b));
  return createHash('sha256').update(JSON.stringify([state.document_id,pairs(state.nodes),pairs(state.styles)])).digest('hex');
}

export function validatePreparedDescriptor(fixture,origin,prepared) {
  assert.equal(prepared.schema,'omc-penpot-ld03-prepared/1');
  assert.equal(prepared.fixtureSha256,fixture.fixture_sha256,'Prepared fixture differs');
  assert.equal(prepared.fileName,`OMC Benchmark LD03 / ${fixture.source_family_id}`);
  const workspace = new URL(prepared.workspace);
  assert.equal(workspace.origin,origin);
  assert.ok(!workspace.username && !workspace.password);
  assert.equal(workspace.searchParams.get('screen'),'workspace');
  for (const key of ['file-id','page-id']) assert.match(workspace.searchParams.get(key),idPattern);
  assert.match(prepared.baselineIdentitySha256,/^[a-f0-9]{64}$/);
  assert.match(prepared.saveFence.pageId,idPattern);
  assert.equal(workspace.searchParams.get('page-id'),prepared.saveFence.pageId);
  assert.match(prepared.saveFence.marker,/^[a-f0-9]{32}$/);
  assert.ok(Array.isArray(prepared.storageState.cookies) && Array.isArray(prepared.storageState.origins));
  assert.ok(prepared.storageState.origins.every(row=>row.origin === origin),'Unexpected prepared storage origin');
  return workspace;
}

export function requirePreparedBaseline(fixture,prepared,state) {
  assert.equal(state.document_id,new URL(prepared.workspace).searchParams.get('file-id'));
  assert.deepEqual(stateDifferences(fixture.start,state),[],'Prepared native baseline differs');
  assert.equal(preparedIdentityHash(state),prepared.baselineIdentitySha256,'Prepared native identities changed');
}

export async function loadPreparedDescriptor(path,fixture,origin) {
  const info = await lstat(path);
  assert.ok(info.isFile() && (info.mode & 0o077) === 0,'Prepared credentials must be a private regular file');
  const enrolled = JSON.parse(await readFile(path,'utf8'));
  return {enrolled,workspace:validatePreparedDescriptor(fixture,origin,enrolled)};
}

export function preparationSaveFence(fileId,marker) {
  assert.match(marker,/^[a-f0-9]{32}$/);
  return `${guard(fileId)}
    const page = penpot.currentPage;
    const saved = new Promise((resolve,reject)=>{
      const listener = penpot.on("contentsave",()=>{clearTimeout(timer);penpot.off(listener);resolve(true);});
      const timer = setTimeout(()=>{penpot.off(listener);reject(new Error("LD03 preparation contentsave deadline"));},20000);
    });
    page.setPluginData("ld03-save-fence",${JSON.stringify(marker)});
    await saved;
    return {pageId:page.id,marker:page.getPluginData("ld03-save-fence"),contentsave:true};`;
}

export function readPreparationFence(fileId,pageId) {
  assert.match(pageId,idPattern);
  return `${guard(fileId)}
    const page = penpot.currentFile.pages.find(page=>page.id === ${JSON.stringify(pageId)});
    if (!page) throw new Error("Missing LD03 prepared page");
    return page.getPluginData("ld03-save-fence");`;
}

async function replay(origin, fixture, modelCommand, {prepare,prepared} = {}) {
  const fileName = `OMC Benchmark LD03 / ${fixture.source_family_id}`;
  const {benchRequire, Client, StreamableHTTPClientTransport} = await import('../replays/mcp.mjs');
  const {chromium} = benchRequire('playwright');
  const client = new Client({name:'omc-ld03-replay', version:'1'});
  const email = `omc-bench-${randomBytes(10).toString('hex')}@example.test`;
  const password = randomBytes(20).toString('hex') + 'Aa1!';
  let browser, endpoint;
  let phase = 'prepare disposable account';
  const modelTools = [];
  const candidateActions = [];
  try {
    await waitForBackend(origin);
    browser = await chromium.launch({channel:'chrome', headless:true});
    let enrolled, preparedWorkspace;
    if (prepared) {
      const loaded = await loadPreparedDescriptor(prepared,fixture,origin);
      enrolled = loaded.enrolled; preparedWorkspace = loaded.workspace;
    }
    const context = await browser.newContext({locale:'en-US', viewport:{width:1440,height:960},
      ...(enrolled ? {storageState:enrolled.storageState} : {})});
    context.setDefaultTimeout(15000);
    const dashboard = await context.newPage();
    if (enrolled) await dashboard.goto(origin);
    else await createAccount(dashboard, origin, email, password);
    endpoint = await getMcpEndpoint(dashboard, origin);
    await client.connect(new StreamableHTTPClientTransport(endpoint));
    let editor = enrolled ? await context.newPage() : await newFile(dashboard, context, origin);
    if (enrolled) await editor.goto(preparedWorkspace.href,{waitUntil:'domcontentloaded'});
    await editor.getByRole('toolbar', {name:'Drawing tools'}).waitFor();
    const workspace = preparedWorkspace ?? new URL(editor.url());
    assert.equal(workspace.origin, origin);
    const id = workspace.searchParams.get('file-id');
    assert.match(id, idPattern);
    if (!enrolled) {
      await editor.locator('header [class*="file-name-label"]').dblclick();
      const title = editor.locator('header input[class*="file-name-input"]');
      await title.fill(fileName);
      await title.press('Enter');
      await editor.getByText(fileName, {exact:true}).waitFor();
    }
    if (editor !== dashboard) await dashboard.close();

    await connectEditor(editor);
    const execute = async code => decodeNativeResult(await client.callTool({
      name:'execute_code', arguments:{code},
    }, undefined, {timeout:20000}));
    await readAfterAttach(() => execute(`${guard(id)} return penpot.currentFile.id;`));
    phase = enrolled ? 'verify frozen prepared native baseline' : `seed native ${fixture.source_family_id} tokens and shapes`;
    const setup = performance.now();
    if (!enrolled) assert.deepEqual(await execute(seedFieldRelay(fixture, id)), {nodes:fixture.logical_objects, styles:4});
    let before = await takeState(execute, id, fixture.start);
    await requireState(fixture.start, before, 'baseline');
    if (enrolled) {
      requirePreparedBaseline(fixture,enrolled,before);
      assert.equal(await readAfterAttach(()=>execute(readPreparationFence(id,enrolled.saveFence.pageId))),enrolled.saveFence.marker,
        'Prepared save fence differs');
    }
    if (prepare) {
      phase = 'persist prepared baseline with an actual content save fence';
      const marker = randomBytes(16).toString('hex');
      const response = editor.waitForResponse(reply=>reply.ok() && new URL(reply.url()).origin === origin &&
        reply.url().includes('/update-file') && reply.request().method() === 'POST' && reply.request().postData()?.includes(marker),
      {timeout:22000}).then(()=>true,error=>error);
      const fence = await execute(preparationSaveFence(id,marker));
      const receipt = await response; if (receipt instanceof Error) throw receipt;
      assert.equal(fence.contentsave,true); assert.equal(fence.marker,marker);
      phase = 'independent normal reopen of frozen prepared baseline';
      editor = await reopenPage(editor,context,workspace);
      assert.equal(await readAfterAttach(()=>execute(readPreparationFence(id,fence.pageId))),marker);
      const reopened = await takeState(execute,id,fixture.start);
      await requireState(fixture.start,reopened,'prepared-reopened-baseline');
      assert.equal(preparedIdentityHash(reopened),preparedIdentityHash(before),'Prepared baseline identities changed on reopen');
      before = reopened;
      const descriptor = {schema:'omc-penpot-ld03-prepared/1',fixtureSha256:fixture.fixture_sha256,
        workspace:workspace.href,fileName,baselineIdentitySha256:preparedIdentityHash(before),
        saveFence:{pageId:fence.pageId,marker},storageState:await context.storageState()};
      validatePreparedDescriptor(fixture,origin,descriptor);
      await writeFile(prepare,JSON.stringify(descriptor)+'\n',{flag:'wx',mode:0o600});
      return;
    }
    const setupMs = performance.now() - setup;
    phase = 'apply two original token updates';
    const started = performance.now();
    let saved;
    if (modelCommand) {
      await runFieldRelayModel({
        execute,fileId:id,before,modelCommand,modelTools,candidateActions,
        beforeWrite:() => { saved = watchSave(editor,origin); },
      });
    } else {
      const changes = fixture.expected.styles
        .filter(style => style.key.startsWith('target.'))
        .map(style => ({key:style.key,value:style.value}));
      saved = watchSave(editor, origin);
      await execute(changeFieldRelay(id, changes));
      assert.equal(await execute(refreshFieldRelay(id)), true);
    }
    const candidate = await takeState(execute, id, fixture.expected);
    await requireState(fixture.expected, candidate, 'edited-original');
    const editedMs = performance.now() - started;
    const saveResult = await saved;
    if (saveResult instanceof Error) throw saveResult;
    phase = 'normal original reopen';
    editor = await reopenPage(editor, context, workspace);
    const reopened = await takeState(execute, id, fixture.expected);
    const reopenedMs = performance.now() - started;
    await storeObservation('ld03-original-observations.json', {before,candidate,reopened});
    await requireState(fixture.expected, reopened, 'reopened-original');
    for (const state of [candidate,reopened]) {
      assert.equal(state.document_id, id);
      assert.deepEqual(identities(state), identities(before), 'Native references in the original were replaced');
    }

    phase = 'native verification duplicate';
    const {opened, id:copyId, url:copyUrl} = await duplicateFromDashboard(editor, context, origin, fileName);
    assert.notEqual(copyId, id, 'Propagation probe must edit a distinct native copy');
    let copy = opened;
    const copyImmediate = await readAfterAttach(() => execute(readFieldRelay(copyId)));
    let copyBefore = copyImmediate;
    if (stateDifferences(fixture.expected, copyImmediate).length) {
      const settled = await takeState(execute, copyId, fixture.expected);
      copyBefore = settled;
      let copyReopened = null;
      if (stateDifferences(fixture.expected, settled).length) {
        copy = await reopenPage(copy, context, copyUrl);
        copyReopened = await takeState(execute, copyId, fixture.expected);
        copyBefore = copyReopened;
      }
      await storeObservation('ld03-copy-settle.json', {immediate:copyImmediate, settled, reopened:copyReopened});
    }
    await requireState(fixture.expected, copyBefore, 'copy-baseline');
    phase = 'repeat shared token edits on the copy';
    const probeActions = await execute(changeFieldRelay(copyId, fixture.probe_actions));
    assert.equal(await execute(refreshFieldRelay(copyId)), true);
    const probe = await takeState(execute, copyId, fixture.probe);
    assert.deepEqual(identities(probe), identities(copyBefore), 'Native references in the verification copy were replaced');
    phase = 'reread the protected original';
    editor = await reopenPage(copy, context, workspace);
    const afterProbeOriginal = await takeState(execute, id, fixture.expected);
    const evidence = {before, candidate, reopened, probe, after_probe_original:afterProbeOriginal,
      probe_actions:probeActions, copy_before:copyBefore,
      ...(modelCommand ? {candidateActions,modelTools} : {})};
    await publishCandidate(process.env.OMC_BENCH_CANDIDATE, evidence);
    console.log(JSON.stringify({workload:'LD03', sourceFamily:fixture.source_family_id,
      setupMs, editedMs, reopenedMs, saveResponseObserved:saveResult, preparedStart:Boolean(enrolled),
      scope:modelCommand ? 'model-assisted native shared-value edit' : 'native deterministic shared-value edit'}));
  } catch (error) {
    const secrets = [email,password,endpoint?.searchParams.get('userToken')].filter(Boolean);
    const message = secrets.reduce((value, secret) => value.replaceAll(secret, '[redacted]'), String(error));
    throw new Error(`Penpot LD03 ${phase}: ${message}`);
  } finally {
    await Promise.allSettled([client.close(), browser?.close()]);
    if (modelCommand) await storeObservation('ld03-model-actions.json',{candidateActions,modelTools});
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const {positionals,values} = parseArgs({allowPositionals:true,options:{
    'model-command':{type:'string'},prepare:{type:'string'},prepared:{type:'string'},
  }});
  assert.equal(positionals.length,2,'Use ld03.mjs LOOPBACK_ORIGIN CANONICAL_LD03_JSON [--prepare OUT | --prepared INPUT] [--model-command EXECUTABLE]');
  assert.ok(!values.prepare || (!values.prepared && !values['model-command']),'Preparation cannot edit or use another prepared baseline');
  assert.ok(values.prepare || process.env.OMC_BENCH_CANDIDATE, 'Set OMC_BENCH_CANDIDATE for the neutral grader');
  const fixture = JSON.parse(await readFile(positionals[1], 'utf8'));
  planFieldRelay(fixture);
  await replay(loopbackOrigin(positionals[0]),fixture,values['model-command'],values);
}
