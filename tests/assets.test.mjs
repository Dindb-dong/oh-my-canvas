import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { AssetStore, assetRef, parseAssetRef, extractInlineAssets, hashAsset } from '../core/assets.mjs';
import { Store, encodeFile, decodeFile } from '../core/storage.mjs';
import { Replica } from '../core/replica.mjs';
import { changesBetween } from '../core/document.mjs';
import { documentFixture } from './helpers.mjs';

const pixel = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
const pixelBytes = Buffer.from(pixel.split(',')[1], 'base64');
async function directory(t) { const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'omc-assets-')); t.after(() => fs.rm(dir, { recursive: true, force: true })); return dir; }
async function documentStore(t, options) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'omc-assets-')), store = new Store(dir, options);
  t.after(async () => { await store.flushPreviews(); await fs.rm(dir, { recursive: true, force: true }); });
  return store;
}
function imageDoc(src = pixel) {
  const doc = documentFixture(); doc.assets = { icon: { id: 'icon', name: 'Icon', kind: 'image', src, mimeType: 'image/png' } };
  doc.pagesById.page.objects.label = { ...doc.pagesById.page.objects.label, type: 'image', image: { src }, assetId: 'icon' };
  return doc;
}

test('inline raster extraction deduplicates bytes, preserves unchanged branches and never rewrites ordinary text or SVG/fonts', () => {
  const doc = imageDoc(); doc.pagesById.page.objects.label.text = pixel;
  doc.assets.font = { kind: 'font', src: 'data:font/woff2;base64,AAAA' };
  doc.assets.svg = { kind: 'svg', src: 'data:image/svg+xml;base64,PHN2Zy8+' };
  doc.libraries = { nested: { components: { embedded: { image: { src: pixel } } } } };
  const result = extractInlineAssets(doc), hash = hashAsset(pixelBytes);
  assert.equal(result.assets.size, 1); assert.equal(result.document.assets.icon.src, assetRef(hash));
  assert.equal(result.document.pagesById.page.objects.label.image.src, assetRef(hash));
  assert.equal(result.document.libraries.nested.components.embedded.image.src, assetRef(hash));
  assert.equal(result.document.pagesById.page.objects.root, doc.pagesById.page.objects.root);
  assert.equal(result.document.pagesById.page.objects.label.text, pixel);
  assert.equal(result.document.assets.font, doc.assets.font); assert.equal(result.document.assets.svg, doc.assets.svg);
  assert.equal(doc.assets.icon.src, pixel);
  assert.equal(extractInlineAssets(result.document).document, result.document);
  assert.throws(() => extractInlineAssets({ src: 'data:image/png;base64,@@@=' }), /base64/);
  assert.throws(() => parseAssetRef('omc-asset:sha256:../outside'), /Invalid asset/);
});

test('immutable blob writes deduplicate concurrent imports and detect tampered bytes and metadata', async t => {
  const dir = await directory(t), events = [], store = new AssetStore(dir, { onMetric: event => events.push(event) });
  const descriptors = await Promise.all(Array.from({ length: 8 }, () => store.put(pixelBytes, 'image/png')));
  const hash = descriptors[0].hash;
  assert.equal(events.length, 1); assert.ok(descriptors.every(item => item.hash === hash));
  assert.deepEqual((await new AssetStore(dir).get(hash)).bytes, pixelBytes);
  await assert.rejects(store.put(pixelBytes, 'image/png', { hash: '0'.repeat(64) }), /SHA-256/);
  assert.throws(() => store.file('../outside'), /Invalid asset/);
  const corrupted = Buffer.from(pixelBytes); corrupted[20] ^= 1; await fs.writeFile(store.file(hash), corrupted);
  await assert.rejects(store.get(hash), /SHA-256/);
  await assert.rejects(store.put(pixelBytes, 'image/png'), /SHA-256/);
});

test('asset preparation persists bytes before patching and keeps source image bytes out of document and CRDT', async t => {
  const store = await documentStore(t);
  const document = await store.prepareDocument(imageDoc());
  const replica = new Replica({ document }); t.after(() => replica.destroy());
  const record = { id: randomUUID(), title: 'Images', replica };
  await store.save(record);
  const hash = parseAssetRef(document.assets.icon.src);
  assert.deepEqual((await store.assets.get(hash)).bytes, pixelBytes);
  assert.equal(JSON.stringify(replica.document).includes(pixel), false);
  assert.equal(Buffer.from(replica.state).includes(Buffer.from(pixel)), false);
  const update = await store.prepareChanges([[JSON.stringify(['shape', 'page', 'label', 'image']), { src: pixel }]]);
  assert.equal(update[0][1].src, assetRef(hash));
  const direct = await store.prepareChanges([[JSON.stringify(['shape', 'page', 'label', 'dataUrl']), pixel]]);
  assert.equal(direct[0][1], assetRef(hash));
  await assert.rejects(store.prepareChanges([[JSON.stringify(['meta', 'assets', 'extra']), { src: pixel }]]), /field key/);
  const read = await new Store(store.dir).load(record.id); t.after(() => read.replica.destroy());
  assert.deepEqual(read.replica.document, replica.document);
  assert.throws(() => encodeFile(record), /asset bytes/);
});

test('large v4 portable packages compress CRDT state while retaining verified image dependencies',async t=>{
  const store=await documentStore(t),document=imageDoc();document.capacity='large';document.notes='x'.repeat(17*1024*1024);
  const replica=new Replica({document:await store.prepareDocument(document)});t.after(()=>replica.destroy());
  const encoded=await store.export({id:randomUUID(),title:'Large portable image document',replica}),file=JSON.parse(encoded);
  assert.equal(file.version,4);assert.equal(file.stateEncoding,'gzip');assert.ok(Buffer.byteLength(encoded)<128*1024);
  const decoded=decodeFile(encoded);t.after(()=>decoded.replica.destroy());assert.deepEqual(decoded.replica.document,replica.document);assert.equal(decoded.assets.size,1);
  assert.throws(()=>decodeFile(JSON.stringify({...file,stateEncoding:'unknown'})),/state encoding/);
});

test('portable export rejects cumulative retained image bytes before reading any blob payload',async t=>{
  const store=await documentStore(t),replica=new Replica({document:documentFixture()});t.after(()=>replica.destroy());
  const hashes=Array.from({length:5},(_,i)=>i.toString(16).padStart(64,'0'));
  for(const hash of hashes)replica.retainedAssetRefs.add(hash);
  let reads=0;
  t.mock.method(store.assets,'describe',async hash=>({hash,mimeType:'image/png',byteLength:64*1024*1024}));
  t.mock.method(store.assets,'get',async()=>{reads++;throw Error('Unexpected bitmap allocation');});
  await assert.rejects(store.export({id:randomUUID(),title:'Too many retained images',replica}),/image assets exceed/);assert.equal(reads,0);
});

test('portable exports include verified blobs and history dependencies after delete, Undo, reopen and duplicate', async t => {
  const store = await documentStore(t);
  const replica = new Replica({ document: await store.prepareDocument(imageDoc()) }); t.after(() => replica.destroy());
  const record = { id: randomUUID(), title: 'Portable', replica }; await store.save(record);
  const before = replica.document, after = structuredClone(before), hash = parseAssetRef(before.assets.icon.src);
  delete after.assets.icon; delete after.pagesById.page.objects.label; after.pagesById.page.objects.board.childIds = [];
  replica.patch(changesBetween(before, after), 'Delete image'); await store.save(record);
  let exported = decodeFile(await store.export(record));
  assert.equal(exported.version, 4); assert.equal(exported.assets.has(hash), true); exported.replica.destroy();
  replica.history('undo'); assert.equal(replica.document.assets.icon.src, assetRef(hash));
  replica.history('redo'); await store.save(record);
  const restarted = new Store(store.dir), reopened = await restarted.load(record.id); t.after(() => reopened.replica.destroy());
  exported = decodeFile(await restarted.export(reopened)); t.after(() => exported.replica.destroy());
  assert.equal(exported.assets.has(hash), true);
  const destination = await documentStore(t); await destination.save(exported);
  assert.equal(exported.assets, undefined); assert.deepEqual((await destination.assets.get(hash)).bytes, pixelBytes);
  const duplicate = { id: randomUUID(), title: 'Copy', replica: new Replica({ document: before }) }; t.after(() => duplicate.replica.destroy());
  await store.save(duplicate); await store.remove(record.id);
  const copy = await store.load(duplicate.id); t.after(() => copy.replica.destroy());
  assert.equal(copy.replica.document.assets.icon.src, assetRef(hash));
  assert.deepEqual((await store.assets.get(hash)).bytes, pixelBytes);
});

test('missing, incorrect and truncated portable blobs fail before any destination document is published', async t => {
  const store = await documentStore(t);
  const record = { id: randomUUID(), title: 'Verify', replica: new Replica({ document: await store.prepareDocument(imageDoc()) }) }; t.after(() => record.replica.destroy());
  await store.save(record); const file = JSON.parse(await store.export(record)), hash = Object.keys(file.assets)[0];
  const missing = structuredClone(file); delete missing.assets[hash]; assert.throws(() => decodeFile(JSON.stringify(missing)), /missing a referenced asset/);
  const altered = structuredClone(file); altered.assets[hash].data = Buffer.from('different').toString('base64'); assert.throws(() => decodeFile(JSON.stringify(altered)), /SHA-256/);
  const truncated = structuredClone(file); truncated.assets[hash].data = truncated.assets[hash].data.slice(0, -1); assert.throws(() => decodeFile(JSON.stringify(truncated)), /base64/);
  const destination = await documentStore(t);
  const dangling = { id: randomUUID(), title: 'Missing', replica: new Replica({ document: record.replica.document }) }; t.after(() => dangling.replica.destroy());
  await assert.rejects(destination.save(dangling), /ENOENT/); assert.deepEqual(await destination.list(), []);
  await assert.rejects(destination.prepareDocument(dangling.replica.document), /ENOENT/);
  await assert.rejects(destination.prepareChanges([[JSON.stringify(['assets', 'missing']), { src: assetRef(hash) }]]), /ENOENT/);
});

test('large image extraction has bounded regexp work and does not put image bytes in a rename journal', async t => {
  const bytes = Buffer.alloc(4 * 1024 * 1024, 42), source = `data:image/png;base64,${bytes.toString('base64')}`;
  const events = [], store = await documentStore(t, { onMetric: event => events.push(event) });
  const replica = new Replica({ document: await store.prepareDocument(imageDoc(source)) }); t.after(() => replica.destroy());
  const record = { id: randomUUID(), title: 'Large image', replica }; await store.save(record);
  replica.patch([[JSON.stringify(['page', 'page', 'name']), 'A tiny rename']], 'Rename'); await store.save(record);
  const journal = events.find(event => event.stage === 'store-journal');
  assert.ok(journal.updateBytes < 1024); assert.ok(journal.bytes < 4096); assert.ok(replica.state.length < 8192);
});
