import assert from 'node:assert/strict';
import {execFileSync, spawn} from 'node:child_process';
import {createHash, randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {createReadStream} from 'node:fs';
import {cp, mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {extname, join, resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath, pathToFileURL} from 'node:url';

import {benchRequire, Client, StreamableHTTPClientTransport} from '../replays/mcp.mjs';
import {publishCandidate} from '../publish-candidate.mjs';

const scriptDirectory = fileURLToPath(new URL('..', import.meta.url));
const {chromium} = benchRequire('playwright');
const mime = {'.html': 'text/html', '.css': 'text/css', '.mjs': 'text/javascript', '.png': 'image/png'};
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

export async function sourceProbe(root, fixture, manifest, cycle, target, exportedHtml) {
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
    const initialCards = fixture.cycles[0].source_state.cards;
    for (const width of fixture.widths) {
      const page = await browser.newPage({viewport: {width, height: 850}});
      page.setDefaultTimeout(5000);
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.route('**/*', route => route.request().url().startsWith(base + '/')
        ? route.continue() : route.abort());
      await page.goto(base);
      const control = page.getByRole('button', {name: target.check_control_name});
      await control.waitFor();
      const status = page.locator('#state');
      assert.equal(await status.getAttribute('role'), 'status');
      const [controlName,beforePress,statusVisible] = await Promise.all([control.innerText(),status.innerText(),status.isVisible()]);
      assert.equal(controlName,target.check_control_name);
      assert.equal(beforePress, target.keyboard_before);
      assert.ok(statusVisible);
      await control.press('Space');
      const afterPress = await status.innerText();
      assert.equal(afterPress, target.keyboard_after);
      assert.equal(await control.getAttribute('aria-pressed'), 'true');
      await control.press('Space');
      assert.equal(await status.innerText(), target.keyboard_before);

      let form;
      if (cycle >= 2) {
        const field = page.getByLabel(target.field_name);
        const error = page.locator('#field-error');
        const submit = page.getByRole('button', {name: 'Save'});
        assert.equal(await field.getAttribute('aria-describedby'), null);
        assert.equal(await error.isVisible(), false);
        await submit.press('Enter');
        const invalid = {
          message: await error.innerText(), visible: await error.isVisible(),
          focused: await field.evaluate(input => document.activeElement === input),
          invalid: await field.getAttribute('aria-invalid'),
          describedBy: await field.getAttribute('aria-describedby'),
        };
        assert.deepEqual(invalid, {
          message: target.invalid_result, visible: true, focused: true, invalid: 'true', describedBy: 'field-error',
        });
        await field.fill(target.submitted_value);
        assert.equal(await field.getAttribute('aria-describedby'), null);
        assert.equal(await error.isVisible(), false);
        await field.press('Enter');
        const saved = await page.locator('#saved').innerText();
        assert.equal(saved, target.valid_result + ': ' + target.submitted_value);
        const retainedValue = await field.inputValue();
        assert.equal(retainedValue, target.submitted_value);
        // Capture the source-visible validation state for the editable refresh.
        await field.fill('');
        await submit.press('Enter');
        assert.equal(await error.innerText(), target.invalid_result);
        form = {invalid, saved, retainedValue,
          fieldName:await page.locator('label[for="fixture-value"]').innerText()};
      }
      let conditional;
      if (cycle === 3) {
        const extra = page.getByRole('checkbox', {name: 'Show extra item'});
        assert.deepEqual(await page.locator('.card h2').allTextContents(), initialCards);
        await extra.press('Space');
        assert.equal(await extra.isChecked(), true);
        assert.deepEqual(await page.locator('.card h2').allTextContents(), target.cards);
        await extra.press('Space');
        assert.equal(await extra.isChecked(), false);
        assert.deepEqual(await page.locator('.card h2').allTextContents(), initialCards);
        await extra.press('Space');
        conditional = {keyboardShows: true, keyboardHides: true};
      }
      await page.waitForFunction(() => [...document.querySelectorAll('.card img')]
        .every(image => image.complete && image.naturalWidth === 64 && image.naturalHeight === 36));
      const cards = await readBrowserCards(page);
      assert.deepEqual(cards.map(row => row.label), target.cards);
      for (const [index, card] of cards.entries()) {
        const variantCard = index === cards.length - 1 && target.variant;
        const filename = variantCard ? target.asset : fixture.cycles[0].source_state.asset;
        assert.equal(card.src, './assets/' + filename);
        assert.ok(card.loaded);
        assert.equal(card.variant, variantCard || 'standard');
        if (variantCard) assert.equal(card.detail, target.copy);
      }
      const styles = await readBrowserStyles(page);
      assert.ok(styles.fitsViewport);
      assertStyles(styles, target);
      if (target.wrap) {
        if (width === fixture.widths[0]) assert.ok(styles.rowCount > 1);
        if (width === fixture.widths.at(-1)) assert.equal(styles.rowCount, 1);
      }
      assert.deepEqual(errors, []);
      states.push({width, cards, controlName, beforePress, statusVisible, afterPress, form, conditional, styles});
      evaluatedHtml ??= await page.content();

      if (exportedHtml && staticBehavior === undefined) {
        await page.setContent(exportedHtml);
        const button = page.getByRole('button', {name: target.check_control_name});
        const status = page.locator('#state');
        const nativeButton = await button.count() === 1;
        staticBehavior = {
          styles: await readBrowserStyles(page),
          cards: await readBrowserCards(page),
          hasNativeButton: nativeButton,
          hasStatusRole: await status.count() === 1 && await status.getAttribute('role') === 'status',
          hasForm: await page.locator('#fixture-form').count() === 1,
          hasListControl: await page.locator('#show-extra').count() === 1,
          hasExecutableScript: await page.locator('script').count() > 0,
        };
        if (nativeButton && await status.count() === 1) {
          staticBehavior.before = await status.innerText();
          staticBehavior.ariaPressed = await button.getAttribute('aria-pressed');
          await button.press('Space');
          staticBehavior.after = await status.innerText();
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

async function readBrowserCards(page) {
  return page.locator('.card').evaluateAll(cards => cards.map(card => {
    const image = card.querySelector('img');
    return {label: card.querySelector('h2')?.textContent, detail: card.querySelector('p')?.textContent,
      variant: card.getAttribute('data-variant'), src: image?.getAttribute('src'),
      loaded: image?.complete && image.naturalWidth === 64 && image.naturalHeight === 36};
  }));
}

async function readBrowserStyles(page) {
  return page.locator('.cards').evaluate(list => {
    const styles = getComputedStyle(list);
    const cards = [...list.querySelectorAll('.card')];
    const heading = getComputedStyle(cards[0].querySelector('h2'));
    return {
      gap: styles.gap, wrap: styles.flexWrap, direction: styles.flexDirection,
      itemFlex: getComputedStyle(list.querySelector('li')).flex,
      radius: getComputedStyle(cards[0]).borderTopLeftRadius,
      heading: heading.fontSize, accent: heading.color,
      variantBorder: getComputedStyle(cards[cards.length - 1]).borderTopColor,
      rowCount: new Set(cards.map(card => Math.round(card.getBoundingClientRect().top))).size,
      fitsViewport: document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    };
  });
}

const rgb = hex => 'rgb(' + [...Buffer.from(hex.slice(1), 'hex')].join(', ') + ')';
function assertStyles(styles, target) {
  for (const [observed, expected] of [['gap', 'gap'], ['radius', 'radius'], ['heading', 'heading_size']]) {
    if (target[expected] !== undefined) assert.equal(styles[observed], target[expected] + 'px');
  }
  if (target.wrap) {
    assert.equal(styles.wrap, 'wrap');
    assert.equal(styles.direction, 'row');
    assert.equal(styles.itemFlex, '1 1 224px');
  }
  if (target.accent) assert.equal(styles.accent, rgb(target.accent));
  if (target.variant_border) assert.equal(styles.variantBorder, rgb(target.variant_border));
}

const textOf = snapshot => Object.values(snapshot.nodes).flatMap(row =>
  typeof row.properties.text === 'string' ? [row.properties.text] : []);
const hasClass = (node, name) => String(node.properties.class ?? '').split(/\s+/).includes(name);

function nativeCardLayout(snapshot, expected) {
  const nodes = Object.values(snapshot.nodes);
  const only = candidates => {
    assert.equal(candidates.length, 1);
    return candidates[0];
  };
  const children = parent => nodes.filter(node => node.parentId === parent.id);
  const list = only(nodes.filter(node => hasClass(node, 'cards')));
  const cards = expected.cards.map(label => {
    const heading = only(nodes.filter(node => node.properties.tag === 'h2' && node.properties.text === label));
    const card = snapshot.nodes[heading.parentId];
    assert.ok(hasClass(card, 'card'));
    const item = snapshot.nodes[card.parentId];
    assert.equal(item.parentId, list.id);
    assert.equal(item.properties.tag, 'li');
    const image = only(children(card).filter(node => node.kind === 'image'));
    const detail = only(children(card).filter(node => node.properties.tag === 'p'));
    return {item, card, heading, image, detail};
  });
  assert.deepEqual(children(list).sort((a,b) => a.rank.localeCompare(b.rank)).map(node => node.id),
    cards.map(row => row.item.id));
  assert.equal(cards.length, nodes.filter(node => hasClass(node, 'card')).length);
  return {list, cards, nodes};
}

function verifyEditableState(snapshot, expected, stylesheet, assetHashes, cycle) {
  const {cards, nodes} = nativeCardLayout(snapshot, expected);
  assert.equal(snapshot.metadata.css.trim(), stylesheet.trim());
  assert.ok(nodes.every(row => row.properties.locked !== true && row.properties.visible !== false));
  assert.deepEqual(cards.map(row => row.image.properties.assetHash), assetHashes);
  const byId = id => nodes.find(node => node.properties.htmlId === id);
  const status = byId('state');
  const toggle = byId('toggle');
  assert.equal(status?.properties.text, expected.keyboard_before);
  assert.equal(status.properties.attributes.role, 'status');
  assert.equal(toggle?.properties.tag, 'button');
  assert.ok([toggle.properties.text, ...nodes.filter(row => row.parentId === toggle.id)
    .map(row => row.properties.text)].includes(expected.check_control_name));
  if (expected.field_name) {
    const input = byId('fixture-value');
    assert.equal(input?.properties.tag, 'input');
    assert.equal(input.properties.attributes['aria-describedby'], 'field-error');
    assert.equal(byId('field-error')?.properties.text, expected.invalid_result);
    assert.equal(byId('saved')?.properties.text, `${expected.valid_result}: ${expected.submitted_value}`);
    assert.ok(nodes.some(node => node.properties.tag === 'label' && node.properties.text === expected.field_name));
  }
  if (cycle === 3) {
    assert.equal(byId('show-extra')?.properties.attributes.type, 'checkbox');
    assert.ok(nodes.some(node => node.properties.tag === 'label' && node.properties.text === 'Show extra item'));
  }
  return cards;
}

function replaceOne(text, find, replacement) {
  assert.equal(text.split(find).length, 2, 'Expected one source declaration to retain: ' + find);
  return text.replace(find, replacement);
}

export function mergeStyles(css, cycle, values) {
  switch (cycle) {
    case 1:
      return [
        ['card-gap','12px',values.gap],
        ['card-radius','6px',values.radius],
        ['card-heading-size','20px',values.heading_size],
      ].reduce((state, [name, original, value]) =>
        replaceOne(state, `--${name}: ${original};`, `--${name}: ${value};`), css);
    case 2: {
      assert.equal(values.wrap, 'wrap');
      assert.equal(values.direction, 'row');
      const wrapped = replaceOne(css, 'flex-direction: column;', 'flex-flow: row wrap;');
      const basis = replaceOne(wrapped, '.cards li { min-inline-size: 0;', `.cards li { flex: ${values.flex}; min-inline-size: 0;`);
      return replaceOne(basis, '--accent: #253357;', `--accent: ${values.accent};`);
    }
    case 3:
      return replaceOne(css, '--variant-border: #718096;', `--variant-border: ${values.variant_border};`);
    default:
      throw new Error('Unknown LD05 cycle ' + cycle);
  }
}

export function mergeExtraCard(data, variant, asset, detail) {
  const prefix = 'export const extraCard = ';
  const declarations = data.split('\n').filter(line => line.startsWith(prefix));
  assert.equal(declarations.length, 1);
  const [declaration] = declarations;
  assert.ok(declaration.endsWith(';'));
  const card = JSON.parse(declaration.slice(prefix.length, -1));
  assert.match(asset, /^[a-z-]+\.png$/);
  return replaceOne(data, declaration, prefix + JSON.stringify({...card, variant, image: asset, detail}) + ';');
}

async function diagnose(api, fixture, cycle, root, manifest, save, report, common) {
  const {source_state: expected, result: edits} = fixture.cycles[cycle - 1];
  const rawHtml = await readFile(join(root, 'index.html'), 'utf8');
  const css = await readFile(join(root, 'theme.css'), 'utf8');
  const source = await sourceProbe(root, fixture, manifest, cycle, expected);
  report.sourceBefore = source.states;
  await save('rendered-dom.html', source.evaluatedHtml);
  const image = await readFile(join(root, 'assets', expected.asset));
  report.sourceAssetSha256 = digest(image);
  const materialized = source.evaluatedHtml
    .replace('<link rel="stylesheet" href="./theme.css">', `<style>${css}</style>`)
    .replace('<script type="module" src="./app.mjs"></script>', '')
    .replaceAll(`src="./assets/${expected.asset}"`, `src="data:image/png;base64,${image.toString('base64')}"`);
  assert.ok(materialized.includes('<style>') && !materialized.includes('<script') &&
    !materialized.includes(`src="./assets/${expected.asset}"`));
  await save('native-import-rendered.html', materialized);

  let native;
  for (const [route, markup] of (cycle === 1 && !common ? [['raw',rawHtml], ['rendered',materialized]] : [['rendered',materialized]])) {
    const args = {format: 'html', contentBase64: Buffer.from(markup).toString('base64'), title: `LD05 cycle ${cycle} ${route}`};
    let snapshot;
    let strictRejection;
    try {
      snapshot = await api.rpc('document.import', {...args, strict: true});
    } catch (error) {
      if (!error.message.includes('unsupported source feature:')) throw error;
      strictRejection = error.message;
      snapshot = await api.rpc('document.import', {...args, strict: false});
    }
    await save(`${route}-native.json`, snapshot);
    report[route] = {documentId: snapshot.id, nodeCount: Object.keys(snapshot.nodes).length,
      strictRejection, text: textOf(snapshot), stylesRetained: Boolean(snapshot.metadata?.css)};
    if (route === 'rendered') native = snapshot;
  }
  assert.ok(expected.cards.every(label => report.rendered.text.includes(label)), 'Rendered state did not reach editable layers');
  if (report.raw) assert.ok(expected.cards.every(label => !report.raw.text.includes(label)), 'Raw input included dynamic cards');
  const layout = nativeCardLayout(native, expected);
  const {list,cards,nodes} = layout;
  assert.ok(nodes.every(row => row.properties.locked !== true));
  assert.ok(cards.every(row => row.image.properties.assetHash === report.sourceAssetSha256));
  if (cycle >= 2) {
    const fieldLabel = nodes.find(node => node.properties.tag === 'label' && node.properties.text === expected.field_name);
    assert.ok(fieldLabel);
    assert.ok(report.rendered.text.includes(expected.invalid_result), 'The visible validation error did not reach canvas');
    report.rendered.visibleValidation = expected.invalid_result;
    const field = nodes.find(node => node.properties.tag === 'input' && node.properties.htmlId === 'fixture-value');
    report.rendered.fieldMarkup = field ? field.properties.attributes : null;
  }
  if (cycle === 3) assert.ok(report.rendered.text.includes('Show extra item'), 'The conditional-list label did not reach canvas');
  if (common) verifyEditableState(native, expected, css, cards.map(() => report.sourceAssetSha256), cycle);
  const variant = cards.at(-1);
  const patches = [];
  const nodeSet = (node, properties) => patches.push({type:'node.set',nodeId:node.id,properties});
  const style = (node, next) => nodeSet(node,{style:{...node.properties.style,...next}});
  let stagedAsset;
  if (cycle === 1) {
    style(list,{gap:edits.gap+'px'});
    for (const row of cards) {
      style(row.card,{'border-radius':edits.radius+'px'});
      style(row.heading,{'font-size':edits.heading_size+'px'});
    }
  } else if (cycle === 2) {
    style(list,{'flex-direction':'row','flex-wrap':'wrap'});
    for (const row of cards) {
      style(row.item,{flex:'1 1 14rem'});
      style(row.heading,{color:edits.accent});
    }
  } else {
    const asset = await readFile(join(root, 'assets', edits.asset));
    const hash = digest(asset);
    const external = native.id.slice(4).replace(/^(........)(....)(....)(....)(............)$/,'$1-$2-$3-$4-$5');
    const added = await api.rpc('tool.call',{name:'document_assets',arguments:{
      documentId:external,action:'add',kind:'image',name:edits.asset,dataUrl:'data:image/png;base64,'+asset.toString('base64'),
    }});
    assert.equal(added.receipt.status,'durable');
    assert.equal(added.asset.hash,hash);
    assert.equal(added.asset.byteLength,asset.length);
    stagedAsset = {filename:edits.asset,sha256:hash,bytes:asset.length};
    nodeSet(variant.image,{assetHash:hash});
    nodeSet(variant.card,{style:{...variant.card.properties.style,'border-color':edits.variant_border},
      attributes:{...variant.card.properties.attributes,'data-variant':edits.variant}});
    patches.push({type:'text.replace',nodeId:variant.detail.id,text:edits.copy});
  }
  const before = stagedAsset ? await api.rpc('document.snapshot',{documentId:native.id}) : native;
  assert.deepEqual(before.nodes,native.nodes);
  const receiptKey = randomUUID();
  const receipt = await api.rpc('document.command', {envelope: {
    protocol:'omc.engine/1',documentId:native.id,requestId:receiptKey,idempotencyKey:receiptKey,
    targetEpoch:before.epoch,preconditions:{revision:{epoch:before.epoch,sequence:before.sequence}},
    command:{type:'batch',commands:patches},
  }});
  assert.equal(receipt.status,'durable');
  assert.equal(receipt.revision.epoch,before.epoch);
  assert.equal(BigInt(receipt.revision.sequence),BigInt(before.sequence)+1n);
  report.nativeEdit = {status:receipt.status,revision:receipt.revision,changedNodes:patches.length,stagedAsset};
  await api.rpc('document.save',{documentId:native.id});
  const after = await api.rpc('document.snapshot',{documentId:native.id});
  const projected = structuredClone(before);
  projected.sequence=receipt.revision.sequence;
  for (const op of patches) {
    const props=projected.nodes[op.nodeId].properties;
    if (op.type==='node.set') Object.assign(props,op.properties);
    else {
      assert.equal(props.textRuns.length,1);
      props.text=op.text;
      props.textRuns[0].text=op.text;
    }
  }
  assert.deepEqual(after,projected,'Native write changed more than the planned properties');
  await save('edited-native.json',after);
  const exports = {};
  let exportedHtml;
  for (const format of (common ? ['html'] : ['html','react','png'])) {
    let artifact;
    let strictRejection;
    try {
      artifact = await api.rpc('document.export',{documentId:native.id,format});
    } catch (error) {
      if (format!=='png' || !error.message.includes('unsupported scene feature:')) throw error;
      strictRejection=error.message;
      artifact=await api.rpc('document.export',{documentId:native.id,format,strict:false});
    }
    const bytes=Buffer.from(artifact.contentBase64,'base64');
    await save(`edited-native${strictRejection?'-permissive':''}.${artifact.extension}`,bytes);
    exports[format]={extension:artifact.extension,sha256:digest(bytes),diagnostics:artifact.diagnostics,strictRejection};
    if (format==='html') exportedHtml=bytes.toString('utf8');
  }
  report.exports=exports;
  const reopened=await api.reopen(native.id);
  assert.deepEqual(reopened,after,'Native reopen changed content');
  await save('reopened-native.json',reopened);
  report.nativeReopenVerified=true;

  const {staticBehavior}=await sourceProbe(root,fixture,manifest,cycle,expected,exportedHtml);
  const exportAssetHashes=staticBehavior.cards.map(({src})=>src?.startsWith('data:image/png;base64,')
    ? digest(Buffer.from(src.slice('data:image/png;base64,'.length),'base64')) : null);
  const expectedAssetHashes=cards.map((row,index)=>index===cards.length-1 && stagedAsset
    ? stagedAsset.sha256 : report.sourceAssetSha256);
  let emittedStylesMatch=true;
  try { assertStyles(staticBehavior.styles,edits); } catch (error) {
    if (error.code!=='ERR_ASSERTION') throw error;
    emittedStylesMatch=false;
  }
  report.staticExportBehavior={...staticBehavior,exportAssetHashes,emittedStylesMatch,
    exportedAssetsMatch:JSON.stringify(exportAssetHashes)===JSON.stringify(expectedAssetHashes),
    eventHandlerPreserved:typeof staticBehavior.before==='string' && staticBehavior.after===expected.keyboard_after};
  if (common) {
    const reopenedCards = verifyEditableState(reopened, edits, css, expectedAssetHashes, cycle);
    assert.ok(emittedStylesMatch && report.staticExportBehavior.exportedAssetsMatch);
    if (cycle === 3) {
      const extra = reopenedCards.at(-1);
      assert.equal(extra.detail.properties.text, edits.copy);
      assert.equal(extra.card.properties.attributes['data-variant'], edits.variant);
    }
  }

  // Merge only reopened native properties into the registered component source.
  const props = node => reopened.nodes[node.id].properties;
  let values;
  if (cycle===1) {
    values={gap:props(list).style.gap,radius:props(cards[0].card).style['border-radius'],
      heading_size:props(cards[0].heading).style['font-size']};
  } else if (cycle===2) {
    values={wrap:props(list).style['flex-wrap'],direction:props(list).style['flex-direction'],
      flex:props(cards[0].item).style.flex,accent:props(cards[0].heading).style.color};
  } else {
    assert.equal(props(variant.image).assetHash,stagedAsset.sha256);
    values={variant_border:props(variant.card).style['border-color']};
    const file=join(root,'data.mjs');
    const data=await readFile(file,'utf8');
    await writeFile(file,mergeExtraCard(data,props(variant.card).attributes['data-variant'],
      stagedAsset.filename,props(variant.detail).text));
  }
  await writeFile(join(root,'theme.css'),mergeStyles(css,cycle,values));
  const post=api.sourceCommand('manifest');
  const changedFiles=Object.keys(manifest.files).filter(file=>manifest.files[file]!==post.files[file]).sort();
  assert.deepEqual(changedFiles,cycle===3?['data.mjs','theme.css']:['theme.css']);
  assert.notEqual(post.source_sha256,manifest.source_sha256);
  const clean=await mkdtemp(join(tmpdir(),'ld05-clean-'));
  try {
    await cp(root,clean,{recursive:true});
    for (const file of Object.keys(post.files)) {
      assert.equal(digest(await readFile(join(clean,file))),post.files[file]);
      if (file.endsWith('.mjs')) execFileSync(process.execPath,['--check',join(clean,file)]);
    }
    const finalSource=await sourceProbe(clean,fixture,post,cycle,edits);
    report.mergedSource={changedFiles,manifest:post,observedWidths:finalSource.states,cleanStaticSourceVerified:true};
  } finally {await rm(clean,{recursive:true,force:true});}
}

async function main() {
  const [family, output, mode] = process.argv.slice(2);
  assert.ok(['route-board', 'supply-ledger'].includes(family) && output && (!mode || mode === '--common'),
    'Usage: ld05.mjs route-board|supply-ledger NEW_EVIDENCE_DIRECTORY [--common]');
  const common = mode === '--common';
  const candidate = process.env.OMC_BENCH_CANDIDATE;
  if (common) assert.ok(candidate, 'The common arm must publish to OMC_BENCH_CANDIDATE');
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
  function git(...args) {
    return execFileSync('git', ['-C', root, '-c', 'user.name=LD05 Benchmark', '-c', 'user.email=ld05@example.invalid',
      '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], {
      encoding: 'utf8', env: {...env, GIT_CONFIG_GLOBAL:'/dev/null', GIT_CONFIG_NOSYSTEM:'1'},
    });
  }
  function commit(message, files) {
    git('add', '--', ...files);
    git('commit', '--quiet', '-m', message);
    return git('rev-parse', 'HEAD').trim();
  }
  if (common) {
    git('init', '--quiet', '--template=');
    await save('initial-source-commit.txt', commit('Seed the registered source fixture', Object.keys(initial.files)) + '\n');
  }
  const report = {workload: 'LD05', sourceFamily: family, fixtureSha256: fixture.fixture_sha256,
    initialSource: initial, fullAcceptance: false, cycles: []};
  const neutral = {fixture_sha256:fixture.fixture_sha256, starting_source_sha256:initial.source_sha256, cycles:[]};
  await save('registered-fixture.json', fixture);
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
    let previous = initial;
    for (let cycle = 1; cycle <= fixture.cycles.length; cycle++) {
      const directory = 'cycle-' + cycle;
      await mkdir(join(evidence, directory), {mode:0o700});
      const saveCycle = (name, data) => save(join(directory, name), data);
      const sourceParent = sourceCommand('manifest');
      assert.deepEqual(sourceParent, previous);
      const manifest = sourceCommand('patch', '--cycle', String(cycle));
      const scheduledFiles = Object.keys(manifest.files).filter(file=>manifest.files[file]!==sourceParent.files[file]).sort();
      assert.deepEqual(scheduledFiles, ['app.mjs', 'index.html']);
      assert.notEqual(manifest.source_sha256, sourceParent.source_sha256);
      const began = performance.now();
      const result = {cycle, sourceParent, patchedSource:manifest, scheduledFiles, status:'started'};
      report.cycles.push(result);
      if (common) result.sourcePatchCommit = commit(`Apply source patch for cycle ${cycle}`, scheduledFiles);
      await saveCycle('theme-before.css', await readFile(join(root,'theme.css')));
      await diagnose({rpc, reopen, sourceCommand}, fixture, cycle, root, manifest, saveCycle, result, common);
      previous = result.mergedSource.manifest;
      assert.notEqual(previous.source_sha256, sourceParent.source_sha256);
      await saveCycle('theme-after.css', await readFile(join(root,'theme.css')));
      await saveCycle('data-after.mjs', await readFile(join(root,'data.mjs')));
      if (common) {
        const checked = fixture.cycles[cycle-1];
        const widths = result.mergedSource.observedWidths.map(state => state.width);
        assert.deepEqual(widths, fixture.widths);
        assert.equal(previous.files['card.mjs'], initial.files['card.mjs']);
        assert.ok(result.nativeReopenVerified && result.mergedSource.cleanStaticSourceVerified);
        await saveCycle('design-source.diff', git('diff', '--binary', '--', ...result.mergedSource.changedFiles));
        result.designCommit = commit(`Merge reopened canvas properties for cycle ${cycle}`, result.mergedSource.changedFiles);
        assert.equal(git('status', '--porcelain'), '');
        // The semantic assertions in diagnose check browser behavior and each required native field.
        neutral.cycles.push({source_parent_sha256:sourceParent.source_sha256, source_patch_sha256:manifest.source_sha256,
          result_checkout_sha256:previous.source_sha256, refreshed_canvas:checked.source_state,
          reopened_canvas:checked.result, source_result:checked.result, checked_widths:widths,
          canvas_editable:true, clean_build:true, behavior_tests_passed:true, component_reused:true, no_missing_assets:true});
      }
      result.elapsedMs = performance.now() - began;
      result.status = 'controlled-cycle-complete';
    }
    if (common) await publishCandidate(candidate, neutral);
    report.status = common ? 'awaiting-independent-common-grade' : 'controlled-three-cycle-diagnostic-complete';
  } catch (error) {
    report.error = error.stack;
    if (report.cycles.at(-1)?.status === 'started') report.cycles.at(-1).status = 'failed';
    report.status = 'controlled-three-cycle-diagnostic-incomplete';
    process.exitCode = 1;
  } finally {
    try {await stop();} finally {await rm(profile, {recursive: true, force: true, maxRetries: 10});}
    await save('diagnostic.json', report);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
