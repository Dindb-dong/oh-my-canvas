import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {assetToolDocumentId, pngPixels} from './asset-pressure.mjs';
import {startService} from './profile-font.mjs';
import {publishCandidate} from '../publish-candidate.mjs';

const marker = 'LD01 ';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const id = n => 'node_' + n.toString(16).padStart(32, '0');

export function dashboardNodes(fixture, pageRoot, assets) {
  assert.equal(fixture.workload, 'LD01');
  assert.equal(fixture.expected.nodes.length, fixture.logical_objects);
  const parents = new Map();
  const groups = new Map();
  return fixture.expected.nodes.map((row, index) => {
    const parent = parents.get(row.parent);
    assert.ok(row.parent === null || parent, 'Expected parent before child');
    assert.ok(!parents.has(row.key));
    const [left, top, width, height] = row.bounds;
    const props = {name: marker + row.key, x: left - (parent?.bounds[0] ?? 0),
      y: top - (parent?.bounds[1] ?? 0), width, height};
    if (row.layout === 'horizontal') {
      props.layout = {type: 'flex', direction: 'row', alignItems: 'center', gap: row.gap};
    }
    if (row.kind === 'text') {
      Object.assign(props, {text: row.text, fontFamily: row.font_family, fontSize: row.font_size,
        fill: '#17243a', flexShrink: 0});
    } else if (row.kind === 'image') {
      props.assetHash = assets.get(row.asset_rgba_sha256);
      assert.match(props.assetHash ?? '', /^[a-f0-9]{64}$/);
    } else {
      assert.equal(row.kind, 'frame');
      props.fill = row.key === 'dashboard' ? '#f1f5fa' : '#ffffff';
    }
    const rank = (groups.get(row.parent) ?? 0) + 1;
    groups.set(row.parent, rank);
    const node = {id: id(index + 1), parentId: parent?.id ?? pageRoot.id, kind: row.kind,
      rank: rank.toString(16).padStart(8, '0') + '0'.repeat(24), homeShard: pageRoot.homeShard, properties: props};
    parents.set(row.key, {...row, id: node.id});
    return node;
  });
}

export function normalizeDashboard(raw, scene, rgba) {
  const [page] = raw.pages;
  assert.equal(raw.pages.length, 1);
  const layers = Object.values(raw.nodes).filter(node => node.id !== page.rootNodeId);
  if (!layers.length) return {document_id: raw.id, nodes: [], styles: []};
  assert.equal(scene.truncated, false);
  assert.equal(String(scene.revision), String(raw.sequence));
  const aliases = new Map(scene.nodes.map(row => [row.id, row.rawId]));
  const boxes = new Map(scene.diagnostics.map(row => [aliases.get(row.id), row.bounds]));
  const keys = new Map(layers.map(node => {
    assert.ok(node.properties.name.startsWith(marker));
    return [node.id, node.properties.name.slice(marker.length)];
  }));
  const nodes = layers.map(node => {
    const p = node.properties;
    const {x,y,width,height} = boxes.get(node.id);
    const row = {key: keys.get(node.id), native_id: node.id, kind: node.kind,
      parent: node.parentId === page.rootNodeId ? null : keys.get(node.parentId),
      bounds: [x,y,width,height], editable: p.locked !== true && p.visible !== false && p.hidden !== true};
    if (node.kind === 'text') {
      Object.assign(row, {text:p.text, font_family:p.fontFamily, font_size:p.fontSize});
    }
    if (node.kind === 'image') row.asset_rgba_sha256 = rgba.get(p.assetHash);
    if (p.layout?.type === 'flex' && p.layout.direction === 'row') {
      Object.assign(row, {layout:'horizontal', gap:p.layout.gap});
    }
    return row;
  });
  return {document_id: raw.id, nodes, styles: []};
}

async function execute(fixture, assetsDir, save, report, profile, signal) {
  const binary = join(process.env.OMC_BENCH_BIN_DIR ?? '/Applications/Oh My Canvas.app/Contents/MacOS', 'omc-service');
  report.binarySha256 = sha(await readFile(binary));
  const source = new Map();
  for (const asset of fixture.assets) {
    assert.match(asset.name, /^[a-z-]+\.png$/);
    const bytes = await readFile(join(assetsDir, asset.name));
    assert.equal(sha(bytes), asset.sha256);
    source.set(asset.sha256,{...asset,bytes});
  }
  const rgba = new Map();
  let service = await startService(binary, profile, signal);
  const rpc = (...args) => service.rpc(...args);
  const store = join(profile,'native-v1','assets','sha256');
  const snapshot = documentId => rpc('document.snapshot', {documentId});
  async function capture(label, documentId) {
    const raw = await snapshot(documentId);
    let scene;
    if (Object.keys(raw.nodes).length > 1) {
      await rpc('workspace.open', {documentId});
      scene = await rpc('tool.call',{name:'get_tree',arguments:{documentId:assetToolDocumentId(documentId),depth:5,detail:'detailed'}});
    }
    await save(label + '-native.json', {raw,scene});
    const scopedAssets = new Map();
    for (const node of Object.values(raw.nodes).filter(node => node.kind === 'image')) {
      const hash = node.properties.assetHash;
      const registered = source.get(hash);
      assert.ok(registered && rgba.has(hash),'No registered native image source for this node');
      const stored = await readFile(join(store,hash.slice(0,2),hash));
      assert.equal(sha(stored),registered.sha256);
      assert.deepEqual(stored,registered.bytes);
      scopedAssets.set(hash,registered.rgba_sha256);
      report.assetReadbacks.push({label,hash,nodeId:node.id,byteLength:stored.length});
    }
    return normalizeDashboard(raw, scene, scopedAssets);
  }
  async function command(raw, body) {
    const requestId = randomUUID();
    const receipt = await rpc('document.command',{envelope:{protocol:'omc.engine/1',
      requestId,idempotencyKey:requestId,documentId:raw.id,targetEpoch:raw.epoch,
      preconditions:{revision:{epoch:raw.epoch,sequence:raw.sequence}},command:body}});
    assert.equal(receipt.status,'durable');
    assert.equal(receipt.revision.epoch,raw.epoch);
    return receipt;
  }
  async function raster(documentId) {
    const raw = await snapshot(documentId);
    const {width,height} = fixture.viewport;
    const image = await rpc('document.export',{documentId,pageId:raw.pages[0].id,format:'png',
      bounds:{x:0,y:0,width,height}});
    assert.deepEqual(image.revision,{epoch:raw.epoch,sequence:raw.sequence});
    const png = Buffer.from(image.contentBase64,'base64');
    pngPixels(png,width,height);
    await save('candidate.png',png);
    report.raster = {sha256:sha(png),width,height,diagnostics:image.diagnostics};
  }
  try {
    const made = await rpc('workspace.create',{title:'Synthetic LD01 ' + fixture.source_family_id});
    const original = made.id;
    report.before = await capture('before',original);
    assert.deepEqual(report.before.nodes,[]);
    const start = performance.now();
    for (const [hash,asset] of source) {
      const added = await rpc('tool.call',{name:'document_assets',arguments:{action:'add',
        documentId:assetToolDocumentId(original),kind:'image',name:asset.name,
        dataUrl:'data:image/png;base64,' + asset.bytes.toString('base64')}});
      assert.equal(added.receipt.status,'durable');
      assert.equal(added.asset.hash,hash);
      rgba.set(hash,asset.rgba_sha256);
    }
    const ready = await snapshot(original);
    const root = ready.nodes[ready.pages[0].rootNodeId];
    const nodes = dashboardNodes(fixture,root,new Map([...rgba].map(([hash,value])=>[value,hash])));
    report.creationReceipt = await command(ready,{type:'node.createMany',nodes});
    await rpc('document.save',{documentId:original});
    report.createAndSaveMs = performance.now()-start;
    report.candidate = await capture('candidate',original);
    try {
      await raster(original);
    } catch (error) {
      report.raster = {error:error.message};
    }
    await service.stop();
    assert.equal(service.child.exitCode,0);
    service = await startService(binary,profile,signal);
    report.reopened = await capture('reopened',original);
    assert.deepEqual(report.reopened,report.candidate);
    const copy = await service.run('file.duplicate');
    const copyId = 'doc_' + copy.id.replaceAll('-','');
    assert.notEqual(copyId,original);
    const copyBefore = await snapshot(copyId);
    const index = new Map(Object.values(copyBefore.nodes).map(node=>[node.properties.name,node]));
    report.probe_actions = [];
    let changes = [];
    for (const action of fixture.probe_actions) {
      const node = index.get(marker+action.key);
      assert.ok(node);
      changes.push(action.property === 'text' ? {type:'text.replace',nodeId:node.id,text:action.value} :
        {type:'node.set',nodeId:node.id,properties:{layout:{...node.properties.layout,gap:action.value}}});
    }
    await command(copyBefore,{type:'batch',commands:changes});
    report.probe = await capture('probe',copyId);
    for (const action of fixture.probe_actions) {
      assert.equal(report.probe.nodes.find(node=>node.key===action.key)[action.property],action.value);
      report.probe_actions.push(action);
    }
    report.after_probe_original = await capture('protected',original);
    assert.deepEqual(report.after_probe_original,report.reopened);
    report.status = 'awaiting-canonical-grade';
    if (process.env.OMC_BENCH_CANDIDATE) await publishCandidate(process.env.OMC_BENCH_CANDIDATE,report);
  } finally {
    await service.stop();
  }
}

async function main() {
  const [fixturePath,assetsDir,output] = process.argv.slice(2);
  assert.ok(output,'Supply a canonical fixture, verified originals and new output directory');
  const fixture = JSON.parse(await readFile(fixturePath,'utf8'));
  await mkdir(output,{mode:0o700});
  const save = (name,data) => writeFile(join(output,name),Buffer.isBuffer(data) ? data : JSON.stringify(data,null,2)+'\n',
    {flag:'wx',mode:0o600});
  const profile = await mkdtemp(join(tmpdir(),'omc-ld01-'));
  const controller = new AbortController();
  for (const event of ['SIGINT','SIGTERM']) process.once(event,()=>controller.abort(new Error(event)));
  const report = {workload:'LD01',variant:fixture.source_family_id,fixtureSha256:fixture.fixture_sha256,
    measurementKind:'installed-native-deterministic-dashboard',fontBytesVerified:false,assetReadbacks:[]};
  try {
    await execute(fixture,assetsDir,save,report,profile,controller.signal);
  } catch (error) {
    Object.assign(report,{status:'failed',error:error.stack});
    process.exitCode=1;
  } finally {
    await rm(profile,{recursive:true,force:true,maxRetries:10});
    await save('observations.json',report);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
