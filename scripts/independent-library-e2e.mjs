import {documentPage,libraryPage} from './desktop-test-pages.mjs';
/** Fresh full-library desktop regression. No inherited test source used. */
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';
import electronExecutable from 'electron';
import { decodeFile } from '../core/storage.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = path.join(root, 'docs/design/system/component-library.omc');
const output = path.join(root, 'docs/qa/independent-library-e2e');
const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'omc-independent-library-'));
await fs.mkdir(output, { recursive: true });
const report = { startedAt: new Date().toISOString(), fixture: 'docs/design/system/component-library.omc', profileOwnership: 'fresh task-owned temporary profile; removed after processes exit', actualMainImport: true, build: 'existing shared dist; this script never builds', stages: [], pageErrors: [], consoleErrors: [], screenshots: [], status: 'running' };
let app, page;
const watchdog = setTimeout(() => {
    report.status = 'failed';
    report.watchdog = 'Five-minute whole-run deadline exceeded; only this script-owned temporary Electron process is terminated.';
    process.exitCode = 1;
    app?.process().kill('SIGTERM');
}, 300000);
process.on('unhandledRejection', reason => {
    (report.unhandledRejections ||= []).push(String(reason));
    process.exitCode = 1;
});
function stage(name, data = {}) {
    report.stages.push({ name, at: new Date().toISOString(), ...data });
    console.log(JSON.stringify({ stage: name, ...data }));
}
function rows(doc) {
    return doc.pages.flatMap(id => Object.values(doc.pagesById[id].objects));
}
function counts(doc) {
    const components = Object.values(doc.components || {}).filter(c => !c.deleted);
    const shapes = rows(doc);
    return { objects: shapes.length, mains: shapes.filter(s => s.isMain).length, components: components.length, variants: components.filter(c => c.variantSetId).length, variantSets: new Set(components.map(c => c.variantSetId).filter(Boolean)).size, nestedInstances: shapes.filter(s => s.isInstanceRoot && !s.isMain).length };
}
function descendants(doc, pageId, id) {
    const p = doc.pagesById[pageId], result = [], stack = [id], seen = new Set();
    while (stack.length) {
        const key = stack.pop();
        assert(!seen.has(key), 'cycle in persisted instance');
        seen.add(key);
        const s = p.objects[key];
        assert(s, `missing shape ${key}`);
        result.push(s);
        stack.push(...(s.childIds || []));
    }
    return result;
}
function bindingAudit(doc) {
    const ids = new Set(Object.values(doc.components || {}).flatMap(c => (c.properties || []).map(p => p.id)));
    const missing = [];
    let refs = 0;
    for (const s of rows(doc))
        for (const [field, id] of Object.entries(s.componentPropertyRefs || {})) {
            refs++;
            if (!ids.has(id))
                missing.push({ shape: s.id, field, id });
        }
    return { refs, missing };
}
async function snapshot() {
    return (await page.evaluate(() => window.omc.invoke('snapshot'))).document;
}
async function waitSnapshot(predicate, label, timeout = 45000) {
    const started = Date.now();
    let latest;
    while (Date.now() - started < timeout) {
        latest = await snapshot();
        if (predicate(latest))
            return latest;
        await new Promise(resolve => setTimeout(resolve, 120));
    }
    throw Error(`Timed out waiting for ${label}`);
}
async function ready() {
    stage('waiting-editor-ready');
    page=await documentPage(app);
    await page.waitForFunction(() => window.lvMcp && document.querySelector('#editor')?.inert === false, null, { timeout: 120000 });
    await page.locator('#editor #stage').waitFor({ state: 'visible', timeout: 120000 });
}
async function launch() {
    stage('launch-start');
    const env = { ...process.env, OMC_TEST_BACKGROUND: '1' };
    delete env.ELECTRON_RUN_AS_NODE;
    app = await electron.launch({ executablePath: electronExecutable, args: [root, `--profile=${profile}`], cwd: root, env, timeout: 60000 });
    page = await app.firstWindow();
    page.setDefaultTimeout(45000);
    page.on('pageerror', error => report.pageErrors.push(String(error)));
    page.on('console', message => {
        if (message.type() === 'error')
            report.consoleErrors.push(message.text());
    });
    await page.waitForURL('omc://canvas/index.html');
    await page.locator('#import').waitFor();
    stage('desktop-library-ready');
}
async function close() {
    if (!app)
        return;
    await app.close();
    app=null;
}
async function assets() {
    await page.locator('#editor .ltabs').getByRole('button', { name: 'Assets', exact: true }).click();
}
async function auditTiles() {
    await page.waitForFunction(() => {
        const tiles = Array.from(document.querySelectorAll('#editor .atile'));
        return tiles.length === 16 && tiles.every(tile => {
            const preview = tile.querySelector('.atile-preview');
            if (!preview) return false;
            const image = preview.tagName.toUpperCase() === 'IMG' ? preview : preview.querySelector('img');
            if (image) return image.complete && image.naturalWidth > 0;
            const svg = preview.tagName.toUpperCase() === 'SVG' ? preview : preview.querySelector('svg');
            return !!svg?.querySelector('rect,path,circle,ellipse,text,use,image');
        });
    }, null, {timeout:30000});
    const audit = await page.locator('#editor .atile').evaluateAll(tiles => tiles.map(tile => {
        const label = tile.querySelector('.atile-label');const style=label?getComputedStyle(label):null;
        const box=label?.getBoundingClientRect(),tileBox=tile.getBoundingClientRect();const range=document.createRange();if(label)range.selectNodeContents(label);
        return {id:tile.dataset.id,label:label?.textContent?.trim(),tileWidth:tile.clientWidth,scrollWidth:tile.scrollWidth,labelWidth:label?.clientWidth,labelScrollWidth:label?.scrollWidth,
            labelBox:box?{x:box.x,y:box.y,width:box.width,height:box.height}:null,tileBox:{x:tileBox.x,y:tileBox.y,width:tileBox.width,height:tileBox.height},
            textRects:Array.from(range.getClientRects()).map(r=>({x:r.x,y:r.y,width:r.width,height:r.height})),
            style:style?{display:style.display,overflowX:style.overflowX,overflowY:style.overflowY,whiteSpace:style.whiteSpace,overflowWrap:style.overflowWrap,webkitLineClamp:style.webkitLineClamp}:null,
            realPreview:!!tile.querySelector('.atile-preview svg,.atile-preview img,img.atile-preview,svg.atile-preview')};
    }));
    stage('assets-visual-audit',{tiles:audit});
    assert.equal(audit.length,16);
    const overflowing=audit.find(tile=>tile.scrollWidth>tile.tileWidth+1||tile.labelScrollWidth>tile.labelWidth+1);if(overflowing)await page.locator(`#editor .atile[data-id="${overflowing.id}"]`).scrollIntoViewIfNeeded();
    for(const tile of audit){assert(tile.label,'named family tile');assert(tile.realPreview,'source thumbnail rendered');assert(tile.scrollWidth<=tile.tileWidth+1,`tile label overflows: ${tile.label}`);assert(tile.labelScrollWidth<=tile.labelWidth+1,`family name overflows: ${tile.label}`);}
    return audit;
}
async function layers() {
    await page.locator('#editor .ltabs').getByRole('button', { name: 'Layers', exact: true }).click();
}
async function image(name) {
    const destination = path.join(output, name);
    await page.screenshot({ path: destination, timeout: 10000 });
    report.screenshots.push(path.relative(root, destination));
}
try {
    stage('fixture-decode-start');
    const portable = decodeFile(await fs.readFile(fixture, 'utf8'));
    const source = portable.replica.document;
    const expected = counts(source);
    const documentId = portable.id;
    portable.replica.destroy();
    assert.deepEqual(expected, { objects: 1065, mains: 172, components: 172, variants: 170, variantSets: 14, nestedInstances: 5 });
    assert.deepEqual(bindingAudit(source).missing, []);
    const components = Object.values(source.components);
    const first = components.find(c => c.variantSetId && (c.properties || []).some(p => p.type === 'text'));
    assert(first, 'eligible family with text property');
    const alternative = components.find(c => c.variantSetId === first.variantSetId && c.id !== first.id && (c.properties || []).some(p => p.name === 'Label'));
    assert(alternative, 'alternative with Label property');
    const composition = components.find(c => !c.variantSetId && descendants(source, c.mainPageId, c.mainId).some(s => s.isInstanceRoot && !s.isMain));
    assert(composition, 'composed main with nested instances');
    stage('fixture-decoded', { counts: expected });
    await launch();
    stage('request-main-import');
    await app.evaluate(({ dialog }, filename) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filename] });
    }, fixture);
    await page.locator('#import').click();
    stage('main-import-clicked');
    await ready();
    let doc = await snapshot();
    assert.deepEqual(counts(doc), expected);
    assert.deepEqual(bindingAudit(doc).missing, []);
    stage('actual-main-import-baseline', { counts: counts(doc), bindings: bindingAudit(doc).refs, documentId });
    await assets();
    await page.locator('#editor .atile').first().waitFor();
    assert.equal(await page.locator('#editor .atile').count(), 16, '14 family tiles plus 2 composed mains');
    await auditTiles();
    await image('01-assets-library.png');
    const baselineIds = new Set(rows(doc).map(s => s.id));
    await page.locator(`#editor .atile[data-id="${composition.id}"]`).click();
    doc = await waitSnapshot(value => rows(value).some(s => !baselineIds.has(s.id) && s.componentId === composition.id && s.isInstanceRoot), 'composed Assets insertion');
    const insertedComposition = rows(doc).find(s => !baselineIds.has(s.id) && s.componentId === composition.id && s.isInstanceRoot);
    assert(insertedComposition);
    const composedRows = descendants(doc, composition.mainPageId, insertedComposition.id);
    const sourceNested = descendants(source, composition.mainPageId, composition.mainId).filter(s => s.isInstanceRoot && !s.isMain).length;
    assert.equal(composedRows.filter(s => s.id !== insertedComposition.id && s.isInstanceRoot && !s.isMain).length, sourceNested);
    assert.deepEqual(bindingAudit(doc).missing, []);
    stage('assets-composed-instance', { id: insertedComposition.id, nested: sourceNested, editableObjects: composedRows.length });
    const beforeInsert = new Set(rows(doc).map(s => s.id));
    await page.locator(`#editor .atile[data-id="${first.id}"]`).click();
    doc = await waitSnapshot(value => rows(value).some(s => !beforeInsert.has(s.id) && s.componentId === first.id && s.isInstanceRoot), 'variant Assets insertion');
    const inserted = rows(doc).find(s => !beforeInsert.has(s.id) && s.componentId === first.id && s.isInstanceRoot);
    assert(inserted);
    const insertedId = inserted.id, pageId = first.mainPageId;
    const property = first.properties.find(p => p.name === 'Label');
    assert(property);
    const changedLabel = 'QA canvas';
    const labelInput = page.locator('#right').getByLabel('Label', { exact: true });
    await labelInput.fill(changedLabel);
    await labelInput.press('Tab');
    doc = await waitSnapshot(value => value.pagesById[pageId].objects[insertedId]?.componentProperties?.[property.id] === changedLabel, 'UI text property');
    assert(descendants(doc, pageId, insertedId).some(s => s.type === 'text' && s.content.children.some(p => p.children.some(r => r.text === changedLabel))));
    await page.locator('#right').getByLabel('Variant', { exact: true }).selectOption(alternative.id);
    doc = await waitSnapshot(value => value.pagesById[pageId].objects[insertedId]?.componentId === alternative.id, 'UI variant switch');
    const mappedProperty = alternative.properties.find(p => p.name === 'Label');
    assert.equal(doc.pagesById[pageId].objects[insertedId].componentProperties[mappedProperty.id], changedLabel);
    assert.deepEqual(bindingAudit(doc).missing, []);
    stage('ui-property-and-variant', { instanceId: insertedId, componentId: alternative.id, label: changedLabel });
    await image('02-instance-property-variant.png');
    await layers();
    await page.locator(`#editor .layers .row[data-id="${alternative.mainId}"] .name`).click();
    await page.locator('#right').getByRole('button', { name: 'Add variant', exact: true }).waitFor();
    const mainWidth = doc.pagesById[pageId].objects[alternative.mainId].width + 17;
    const width = page.locator('#right').getByLabel('W', { exact: true });
    await width.fill(String(mainWidth));
    await width.press('Tab');
    doc = await waitSnapshot(value => value.pagesById[pageId].objects[alternative.mainId].width === mainWidth && value.pagesById[pageId].objects[insertedId].width === mainWidth, 'UI main edit propagation');
    assert.equal(doc.pagesById[pageId].objects[insertedId].componentProperties[mappedProperty.id], changedLabel);
    await page.keyboard.press('Shift+2');
    stage('ui-main-edit-propagation', { mainId: alternative.mainId, width: mainWidth, instanceId: insertedId, overrideRetained: true });
    await image('03-main-edit-propagation.png');
    // Navigation finishes queued editor/host commits; portable decode independently verifies the disk result.
    await page.locator('#home').click();
    page=await libraryPage(app);
    await page.locator(`[data-open="${documentId}"]`).waitFor();
    const persisted = decodeFile(await fs.readFile(path.join(profile, 'documents', `${documentId}.omc`), 'utf8'));
    assert.equal(persisted.replica.document.pagesById[pageId].objects[insertedId].width, mainWidth);
    assert.equal(persisted.replica.document.pagesById[pageId].objects[insertedId].componentProperties[mappedProperty.id], changedLabel);
    persisted.replica.destroy();
    await close();
    stage('disk-save-and-process-close');
    await launch();
    await page.locator(`[data-open="${documentId}"]`).click();
    await ready();
    doc = await snapshot();
    assert.equal(doc.pagesById[pageId].objects[insertedId].width, mainWidth);
    assert.equal(doc.pagesById[pageId].objects[insertedId].componentId, alternative.id);
    assert.equal(doc.pagesById[pageId].objects[insertedId].componentProperties[mappedProperty.id], changedLabel);
    assert.equal(counts(doc).mains, 172);
    assert.equal(counts(doc).variants, 170);
    assert.equal(counts(doc).variantSets, 14);
    assert.deepEqual(bindingAudit(doc).missing, []);
    stage('fresh-process-reopen', { counts: counts(doc), bindings: bindingAudit(doc).refs, instanceId: insertedId });
    await assets();
    assert.equal(await page.locator('#editor .atile').count(), 16);
    await auditTiles();
    await image('04-reopened-library.png');
    assert.deepEqual(report.pageErrors, [], 'uncaught renderer errors');
    assert.deepEqual(report.unhandledRejections ||= [], [], 'unhandled Playwright launch/runtime errors');
    report.status = 'passed';
}
catch (error) {
    report.status = 'failed';
    report.error = { message: String(error), stack: error?.stack };
    if (page && !page.isClosed())
        await image('failure.png').catch(() => {
        });
    process.exitCode = 1;
}
finally {
    clearTimeout(watchdog);
    try {
        await close();
    }
    catch (error) {
        report.cleanupError = String(error);
        process.exitCode = 1;
        if (app) {
            await app.close().catch(() => {
            });
            if (app.process().exitCode !== null)
                app = null;
        }
    }
    if (!app)
        await fs.rm(profile, { recursive: true, force: true });
    else
        report.preservedProfile = profile;
    report.finishedAt = new Date().toISOString();
    await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ status: report.status, report: path.relative(root, path.join(output, 'report.json')), error: report.error?.message }));
}
