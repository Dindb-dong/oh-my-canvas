import assert from 'node:assert/strict';
import {execFileSync, spawn} from 'node:child_process';
import {createHash, randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {createReadStream} from 'node:fs';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {extname, join, resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';

import {benchRequire, Client, StreamableHTTPClientTransport} from '../replays/mcp.mjs';

const scriptDirectory = fileURLToPath(new URL('..', import.meta.url));
const {chromium} = benchRequire('playwright');
const mime = {'.html': 'text/html', '.css': 'text/css', '.mjs': 'text/javascript', '.png': 'image/png'};
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

async function sourceProbe(root, fixture, manifest, exportedHtml) {
  const server = createServer((request, response) => {
    const file = request.url === '/' ? 'index.html' : request.url.slice(1);
    if (!Object.hasOwn(manifest.files, file)) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, {'Content-Type': mime[extname(file)], 'Cache-Control': 'no-store'});
    createReadStream(join(root, file)).pipe(response);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  let browser;
  try {
    browser = await chromium.launch({channel: 'chrome', headless: true});
    const base = 'http://127.0.0.1:' + server.address().port;
    const states = [];
    let evaluatedHtml;
    let staticBehavior;
    const target = fixture.cycles[0].source_state;
    for (const width of fixture.widths) {
      const page = await browser.newPage({viewport: {width, height: 850}});
      await page.route('**/*', route => route.request().url().startsWith(base + '/')
        ? route.continue() : route.abort());
      await page.goto(base);
      const control = page.getByRole('button', {name: target.check_control_name});
      await control.waitFor();
      const labels = await page.locator('.card h2').allTextContents();
      assert.deepEqual(labels, target.cards);
      const liveRegion = page.getByRole('status');
      assert.equal(await liveRegion.innerText(), target.keyboard_before);
      const validImages = await page.locator('.card img').evaluateAll(images =>
        images.every(image => image.complete && image.naturalWidth === 64 && image.naturalHeight === 36));
      assert.ok(validImages);
      await control.press('Space');
      const afterPress = await liveRegion.innerText();
      assert.equal(afterPress, target.keyboard_after);
      await control.press('Space');
      assert.equal(await liveRegion.innerText(), target.keyboard_before);
      const styles = await page.locator('.cards').evaluate(list => ({
        gap: getComputedStyle(list).gap,
        radius: getComputedStyle(list.querySelector('.card')).borderTopLeftRadius,
        heading: getComputedStyle(list.querySelector('h2')).fontSize,
        fitsViewport: document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      }));
      assert.ok(styles.fitsViewport);
      states.push({width, labels, validImages, afterPress, styles});
      evaluatedHtml ??= await page.content();
      if (exportedHtml && staticBehavior === undefined) {
        await page.setContent(exportedHtml);
        const button = page.getByRole('button', {name: target.check_control_name});
        const status = page.getByRole('status');
        if (await button.count() === 1 && await status.count() === 1) {
          const before = await status.innerText();
          await button.press('Space');
          staticBehavior = {before, after: await status.innerText(), controlAndStatusPresent: true};
        } else {
          staticBehavior = {controlAndStatusPresent: false};
        }
      }
      await page.close();
    }
    return {states, evaluatedHtml, staticBehavior};
  } finally {
    await browser?.close();
    await new Promise((done, fail) => server.close(error => error ? fail(error) : done()));
  }
}

const textOf = snapshot => Object.values(snapshot.nodes).flatMap(row =>
  typeof row.properties.text === 'string' ? [row.properties.text] : []);
const hasClass = (node, name) => String(node.properties.class ?? '').split(/\s+/).includes(name);

async function diagnose(api, fixture, root, manifest, save, report) {
  const rawHtml = await readFile(join(root, 'index.html'), 'utf8');
  const css = await readFile(join(root, 'theme.css'), 'utf8');
  const source = await sourceProbe(root, fixture, manifest);
  report.sourceBefore = source.states;
  await save('rendered-dom.html', source.evaluatedHtml);
  const assetPath = fixture.cycles[0].source_state.asset;
  const image = await readFile(join(root, 'assets', assetPath));
  report.sourceAssetSha256 = digest(image);
  const materialized = source.evaluatedHtml
    .replace('<link rel="stylesheet" href="./theme.css">', `<style>${css}</style>`)
    .replace('<script type="module" src="./app.mjs"></script>', '')
    .replaceAll(`src="./assets/${assetPath}"`, `src="data:image/png;base64,${image.toString('base64')}"`);
  assert.ok(materialized.includes('<style>') && !materialized.includes('<script') &&
    !materialized.includes(`src="./assets/${assetPath}"`));
  await save('native-import-rendered.html', materialized);

  const imported = {};
  for (const [route, markup] of [['raw', rawHtml], ['rendered', materialized]]) {
    const args = {format: 'html', contentBase64: Buffer.from(markup).toString('base64'), title: `LD05 ${route}`};
    let snapshot;
    let strictRejection;
    try {
      snapshot = await api.rpc('document.import', {...args, strict: true});
    } catch (error) {
      if (!error.message.includes('unsupported source feature:')) throw error;
      strictRejection = error.message;
      report[route] = {strictRejection};
      snapshot = await api.rpc('document.import', {...args, strict: false});
    }
    imported[route] = snapshot;
    await save(`${route}-native.json`, snapshot);
    const exported = await api.rpc('document.export', {documentId: snapshot.id, format: 'html'});
    await save(`${route}-native.html`, Buffer.from(exported.contentBase64,'base64'));
    report[route] = {documentId: snapshot.id, nodeCount: Object.keys(snapshot.nodes).length,
      strictRejection, text: textOf(snapshot), stylesRetained: Boolean(snapshot.metadata?.css),
      diagnostics: exported.diagnostics};
  }
  const expected = fixture.cycles[0].source_state;
  assert.ok(expected.cards.every(label => report.rendered.text.includes(label)), 'Rendered state did not reach editable layers');
  assert.ok(expected.cards.every(label => !report.raw.text.includes(label)), 'Raw input unexpectedly included dynamic cards');

  const native = imported.rendered;
  const nodes = Object.values(native.nodes);
  const list = nodes.filter(node => hasClass(node, 'cards'));
  const cards = nodes.filter(node => hasClass(node, 'card'));
  const headings = nodes.filter(node => node.properties.tag === 'h2');
  assert.equal(list.length, 1);
  assert.equal(cards.length, expected.cards.length);
  assert.equal(headings.length, expected.cards.length);
  const edits = fixture.cycles[0].result;
  const modifications = [
    ...list.map(node => [node, 'gap', edits.gap]),
    ...cards.map(node => [node, 'border-radius', edits.radius]),
    ...headings.map(node => [node, 'font-size', edits.heading_size]),
  ];
  const receiptKey = randomUUID();
  const receipt = await api.rpc('document.command', {documentId: native.id, envelope: {
    protocol: 'omc.engine/1', documentId: native.id, requestId: receiptKey, idempotencyKey: receiptKey,
    targetEpoch: native.epoch, preconditions: {revision: {epoch: native.epoch, sequence: native.sequence}},
    command: {type: 'batch', commands: modifications.map(([node, field, value]) =>
      ({type: 'node.set', nodeId: node.id, properties: {style: {...node.properties.style, [field]: `${value}px`}}}))},
  }});
  report.nativeEdit = {status: receipt.status, revision: receipt.revision, changedNodes: modifications.length};
  assert.equal(receipt.status, 'durable');
  await api.rpc('document.save', {documentId: native.id});
  const after = await api.rpc('document.snapshot', {documentId: native.id});
  for (const [node, field, value] of modifications) {
    assert.equal(after.nodes[node.id].properties.style[field], `${value}px`);
  }
  await save('edited-native.json', after);

  const exports = {};
  for (const format of ['html', 'react', 'png']) {
    const artifact = await api.rpc('document.export', {documentId: native.id, format});
    const bytes = Buffer.from(artifact.contentBase64, 'base64');
    await save(`edited-native.${artifact.extension}`, bytes);
    exports[format] = {extension: artifact.extension, sha256: digest(bytes), diagnostics: artifact.diagnostics};
    if (format === 'html') exports.html.code = bytes.toString('utf8');
  }
  const exportedHtml = exports.html.code;
  delete exports.html.code;
  report.exports = exports;
  const reopened = await api.reopen(native.id);
  assert.deepEqual(reopened.nodes, after.nodes, 'Native reopen changed content');
  assert.deepEqual(reopened.metadata, after.metadata);
  await save('reopened-native.json', reopened);
  report.nativeReopenVerified = true;
  const observed = await sourceProbe(root, fixture, manifest, exportedHtml);
  report.staticExportBehavior = observed.staticBehavior;
  assert.ok(!observed.staticBehavior.controlAndStatusPresent ||
    observed.staticBehavior.before === observed.staticBehavior.after,
  'Static export unexpectedly implemented fixture behavior');

  // Merge only values observed in the reopened native design into the original stylesheet.
  const authored = Object.fromEntries(modifications.map(([node, field]) => [field, reopened.nodes[node.id].properties.style[field]]));
  let merged = css;
  for (const [name, old, value] of [
    ['card-gap', '12px', authored.gap],
    ['card-radius', '6px', authored['border-radius']],
    ['card-heading-size', '20px', authored['font-size']],
  ]) {
    const declaration = `--${name}: ${old};`;
    assert.equal(merged.split(declaration).length, 2);
    merged = merged.replace(declaration, `--${name}: ${value};`);
  }
  await writeFile(join(root, 'theme.css'), merged);
  const post = api.sourceCommand('manifest');
  assert.ok(Object.entries(post.files).every(([file, hash]) => (hash !== manifest.files[file]) === (file === 'theme.css')));
  const finalSource = await sourceProbe(root, fixture, post);
  for (const state of finalSource.states) {
    assert.equal(state.styles.gap, authored.gap);
    assert.equal(state.styles.radius, authored['border-radius']);
    assert.equal(state.styles.heading, authored['font-size']);
  }
  report.mergedSource = {changedFiles: ['theme.css'], manifest: post, observedWidths: finalSource.states};
}

async function main() {
  const [family, output] = process.argv.slice(2);
  assert.ok(['route-board', 'supply-ledger'].includes(family) && output,
    'Usage: ld05.mjs route-board|supply-ledger NEW_EVIDENCE_DIRECTORY');
  const evidence = resolve(output);
  await mkdir(evidence, {mode: 0o700});
  const root = join(evidence, 'source');
  const save = (name, data) => writeFile(join(evidence, name),
    typeof data === 'string' || Buffer.isBuffer(data) ? data : JSON.stringify(data, null, 2) + '\n',
    {flag:'wx', mode:0o600});
  const env = {...process.env, PYTHONDONTWRITEBYTECODE: '1'};
  const readJSON = (script, ...args) =>
    JSON.parse(execFileSync('python3', [join(scriptDirectory, script), ...args], {env}));
  const sourceCommand = (action, ...args) => readJSON('ld05_source.py', action, family, root, ...args);
  const fixture = readJSON('ld05_contract.py', family);
  const initial = sourceCommand('prepare');
  const manifest = sourceCommand('patch', '--cycle', '1');
  const report = {workload: 'LD05', sourceFamily: family, cycle: 1, fixtureSha256: fixture.fixture_sha256,
    initialSource: initial, patchedSource: manifest, fullAcceptance: false, otherCyclesRun: false};
  await save('registered-fixture.json', fixture);
  await save('theme-before.css', await readFile(join(root, 'theme.css')));
  const profile = await mkdtemp(join(tmpdir(), 'omc-ld05-'));
  const binary = join(process.env.OMC_BENCH_BIN_DIR ?? '/Applications/Oh My Canvas.app/Contents/MacOS', 'omc-service');
  let processHandle, client, session, endpoint, auth;
  async function start() {
    processHandle = spawn(binary, ['--profile', profile, '--port', '0'], {stdio: ['ignore', 2, 2]});
    await once(processHandle, 'spawn');
    const started = performance.now();
    let descriptor;
    while (!descriptor && performance.now() < started + 10000) {
      assert.equal(processHandle.exitCode, null);
      try {
        const candidate = JSON.parse(await readFile(join(profile, 'native-v1/service.json'), 'utf8'));
        if (candidate.pid === processHandle.pid) descriptor = candidate;
      } catch (error) {
        if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
      }
      if (!descriptor) await delay(25);
    }
    assert.ok(descriptor);
    endpoint = new URL(descriptor.endpoint);
    assert.equal(endpoint.hostname, '127.0.0.1');
    auth = {Authorization: `Bearer ${descriptor.token}`};
    client = new Client({name: 'omc-ld05-diagnostic', version: '1'});
    const transport = new StreamableHTTPClientTransport(new URL('/mcp', endpoint), {requestInit: {headers: auth}});
    await client.connect(transport, {timeout: 10000});
    session = transport.sessionId;
    assert.ok(session);
  }
  async function stop() {
    try {await client?.close();} finally {
      client = undefined;
      if (processHandle && processHandle.exitCode === null && processHandle.signalCode === null) {
        const exited = once(processHandle, 'exit');
        processHandle.kill('SIGINT');
        const watchdog = setTimeout(() => processHandle.kill('SIGKILL'), 5000);
        try {await exited;} finally {clearTimeout(watchdog);}
      }
    }
  }
  async function rpc(method, params) {
    const response = await fetch(new URL('/rpc', endpoint), {
      method: 'POST', headers: {...auth, 'Content-Type': 'application/json', 'X-OMC-Session': session},
      body: JSON.stringify({id: randomUUID(), method, params}), signal: AbortSignal.timeout(20000),
    });
    const payload = await response.json();
    assert.ok(response.ok && !payload.error, `${method}: ${payload.error?.message ?? response.status}`);
    return payload.result;
  }
  async function reopen(documentId) {
    await stop();
    assert.equal(processHandle.exitCode, 0);
    await start();
    await rpc('workspace.open', {documentId});
    return await rpc('document.snapshot', {documentId});
  }

  try {
    report.binarySha256 = digest(await readFile(binary));
    await start();
    await diagnose({rpc, reopen, sourceCommand}, fixture, root, manifest, save, report);
    report.status = 'controlled-cycle-complete';
  } catch (error) {
    report.error = error.stack;
    report.status = 'controlled-cycle-incomplete';
    process.exitCode = 1;
  } finally {
    try {await stop();} finally {await rm(profile, {recursive: true, force: true, maxRetries: 10});}
    await save('diagnostic.json', report);
  }
}

await main();
