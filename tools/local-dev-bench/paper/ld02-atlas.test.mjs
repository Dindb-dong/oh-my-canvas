import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import test from 'node:test';
import {atlasPlan, captureAtlas, checkProtectedAtlas, discoverAtlasEdit, paperAtlasModelHandlers, seedAtlasPage} from './ld02-atlas.mjs';

const fixture = JSON.parse(execFileSync('python3', [
  'tools/local-dev-bench/workloads/synthetic.py', 'fixture', 'LD02', '--variant', 'conservation-atlas',
], {env: {...process.env, PYTHONDONTWRITEBYTECODE: '1'}}));
const file = {fileId: 'synthetic-original', name: 'OMC Benchmark • Synthetic CAP Probe • 2026-11-17'};
const plan = atlasPlan(fixture, file, 'test-atlas-01');
const ids = key => 'native/' + key;
const paperKind = {frame: 'Frame', text: 'Text', rectangle: 'Frame'};

function mock(snapshot, {unknownBounds = false, observeRead = async () => {}} = {}) {
  const pages = plan.pages.map(row => ({name: row.name, id: ids(row.key)}));
  const node = new Map(snapshot.nodes.map(row => [ids(row.key),row]));
  const children = Map.groupBy(snapshot.nodes, row => ids(row.parent ?? row.page));
  const calls = [];
  function layer(row) {
    const [worldX,worldY,width,height] = row.bounds;
    const childIds = (children.get(ids(row.key)) ?? []).map(child => ids(child.key));
    return {
      id:ids(row.key), name:row.name, component:paperKind[row.kind], textContent:row.text,
      parentId:ids(row.parent ?? row.page), childIds, childCount:childIds.length,
      worldX, worldY:unknownBounds && row.kind==='text' ? null : worldY, width, height,
      isLocked:false,isVisible:true,
    };
  }
  return {
    calls,
    read: async ({name, arguments: args}) => {
      assert.equal(args.fileId,file.fileId);
      calls.push(name);
      await observeRead(name);
      if (name==='get_basic_info') return {fileName:file.name,pages,rootNodeId:args.pageId};
      if (name==='get_selection') return {selectedNodes:[],count:0};
      if (name==='get_node_info') return layer(node.get(args.nodeId));
      if (name==='get_children') return {children:(children.get(args.nodeId)??[]).map(layer)};
      if (name==='find_nodes') {
        const matches=snapshot.nodes.filter(row=>ids(row.page)===args.pageId&&row.text===args.textValue);
        return {nodes:matches.map(layer),count:matches.length};
      }
      if (name==='get_computed_styles') return {styles:Object.fromEntries(args.nodeIds.map(id=>{
        const props=node.get(id);
        return [id,{backgroundColor:props.fill,padding:`${props.padding}px`,gap:`${props.gap}px`,
          borderRadius:`${props.radius}px`,display:'flex',flexDirection:'column'}];
      }))};
      if(name==='set_text_content') {
        for (const {nodeId, html} of args.updates) node.get(nodeId).text = html;
        return {updates: []};
      }
      if(name==='update_styles') {
        for (const {nodeIds, styles} of args.updates) for (const id of nodeIds) {
          if (styles.gap) node.get(id).gap = Number.parseInt(styles.gap);
          if (styles.borderRadius) node.get(id).radius = Number.parseInt(styles.borderRadius);
        }
        return {updates: []};
      }
      if(name==='finish_working_on_nodes') return {};
      throw new Error(`Unexpected Paper tool ${name}`);
    },
  };
}

test('plans 10 isolated pages and 1,000 editable fixture elements', () => {
  assert.equal(plan.pages.length, 10);
  assert.equal(plan.logicalObjects, 1000);
  for (const page of plan.pages) {
    assert.equal(page.create.name, 'create_page');
    assert.equal(page.create.arguments.fileId, file.fileId);
    assert.equal(page.zoneFragments.length, 4);
    for (const fragment of page.zoneFragments) {
      assert.equal([...fragment.matchAll(/layer-name=/g)].length, 25);
      assert.equal([...fragment.matchAll(/gap:8px/g)].length, 4);
      assert.equal([...fragment.matchAll(/border-radius:4px/g)].length, 4);
    }
  }
  assert.throws(() => atlasPlan(fixture, {...file,name:'Unapproved'}, 'test-atlas-01'));
});

test('native artboard seeding preserves registered zone origins without an HTML root wrapper', async () => {
  for (const page of plan.pages) {
    const boards = [];
    const inserts = [];
    let released;
    await seedAtlasPage(async ({name, arguments: args}) => {
      assert.equal(args.fileId, file.fileId);
      if (name === 'get_basic_info') {
        assert.equal(args.pageId, ids(page.key));
        return {fileName: file.name, rootNodeId: ids(page.key), artboards: boards};
      }
      if (name === 'get_children') return {children: []};
      if (name === 'create_artboard') {
        const spec = fixture.start.nodes.find(row => row.page === page.key && row.name === args.name && row.parent === null);
        assert.ok(spec);
        const [left, top, width, height] = spec.bounds;
        assert.deepEqual(args.styles, {left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px`,
          display: 'flex', flexDirection: 'column', backgroundColor: spec.fill});
        boards.push({id: ids(spec.key), name: args.name, width, height});
        return {};
      }
      if (name === 'update_styles') {
        assert.equal(args.updates.length, 4);
        for (const update of args.updates) {
          const board = boards.find(row => update.nodeIds.includes(row.id));
          board.worldX = Number.parseFloat(update.styles.left);
          board.worldY = Number.parseFloat(update.styles.top);
        }
        return {updates: args.updates.map(() => ({ignoredStyles: {}}))};
      }
      if (name === 'write_html') {
        assert.ok(boards.some(board => board.id === args.targetNodeId));
        assert.equal(args.mode, 'insert-children');
        assert.equal([...args.html.matchAll(/layer-name=/g)].length, 24);
        assert.equal([...args.html.matchAll(/gap:8px/g)].length, 4);
        assert.equal([...args.html.matchAll(/border-radius:4px/g)].length, 4);
        inserts.push(args.targetNodeId);
        return {createdNodes: [{id: args.targetNodeId + '/child'}]};
      }
      if (name === 'finish_working_on_nodes') {
        released = args.nodeIds;
        return 'OK';
      }
      throw new Error(name);
    }, plan, page, ids(page.key));
    assert.equal(boards.length, 4);
    assert.deepEqual(inserts, boards.map(board => board.id));
    assert.deepEqual(released, inserts);
    assert.equal(boards.length + inserts.length * 24, 100);
  }
});

test('discovery joins exact title and receipt on a shared native parent', async () => {
  const source = mock(fixture.start);
  const result = await discoverAtlasEdit(source.read, plan, {
    title:'Ceramics review',receipt:'AC-270',status:'Ready for registrar review',gap:14,radius:10,
  });
  assert.equal(result.section.id, ids(fixture.edit.find(row=>row.field==='gap').key));
  assert.deepEqual(result.requests.map(row=>row.name),['set_text_content','update_styles']);
  assert.equal(result.requests[0].arguments.updates[0].html,'Ready for registrar review');
  assert.deepEqual(result.requests[1].arguments.updates.map(row=>row.styles),[{gap:'14px'},{borderRadius:'10px'}]);
  assert.equal(source.calls.filter(name=>name==='find_nodes').length,20);
});

test('model discovers through live state and changes only the pinned beginning station', async () => {
  const source = mock(structuredClone(fixture.start));
  const handlers = paperAtlasModelHandlers(source.read, plan, fixture);
  const values = {text: 'Ready for registrar review', gap: 14, radius: 10};
  await assert.rejects(handlers.edit(handlers.query, values), /No live Paper target/);
  assert.equal(await handlers.find({...handlers.query, receipt: 'ZZ-999'}), null);
  assert.deepEqual(await handlers.find(handlers.query), {...handlers.query,
    text: 'Condition check pending', gap_px: 8, radius_px: 4});
  assert.deepEqual(await handlers.edit(handlers.query, values), {...handlers.query,
    text: values.text, gap_px: values.gap, radius_px: values.radius});
  await assert.rejects(handlers.edit(handlers.query, values), /Paper target changed before write/);
  assert.equal(source.calls.filter(name => name === 'set_text_content').length, 1);
  assert.equal(source.calls.filter(name => name === 'update_styles').length, 1);
});

test('captures all 1,000 layers and detects identity and unrelated data drift', async () => {
  let inFlight = 0;
  let peak = 0;
  const original = mock(fixture.start, {observeRead: async () => {
    peak = Math.max(peak, ++inFlight);
    await Promise.resolve();
    inFlight--;
  }});
  const after = mock(fixture.expected);
  const before = await captureAtlas(original.read,fixture,plan);
  const candidate = await captureAtlas(after.read,fixture,plan);
  assert.equal(before.snapshot.nodes.length,1000);
  assert.equal(before.snapshot.nodes.filter(row=>row.kind==='rectangle'&&row.native_type==='Frame'&&row.radius===4).length,160);
  assert.equal(before.missingBounds.length,0);
  assert.equal(original.calls.filter(name=>name==='get_node_info').length,1000);
  assert.equal(original.calls.filter(name=>name==='get_children').length,10);
  assert.equal(original.calls.filter(name=>name==='get_computed_styles').length,40);
  assert.equal(peak,16);
  assert.deepEqual(before.snapshot.selected_native_ids,[]);
  assert.deepEqual(checkProtectedAtlas(fixture,before.snapshot,candidate.snapshot), fixture.edit);
  const validate = [
    'import json, sys, synthetic',
    'payload = json.load(sys.stdin)',
    'failures = []',
    'synthetic._phase("before", payload["fixture"]["start"], payload["before"], failures)',
    'synthetic._phase("candidate", payload["fixture"]["expected"], payload["candidate"], failures)',
    'assert not failures, failures',
  ].join('\n');
  execFileSync('python3', ['-c', validate], {
    input: JSON.stringify({fixture, before: before.snapshot, candidate: candidate.snapshot}),
    env: {...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONPATH: 'tools/local-dev-bench/workloads'},
  });
  const bystander = candidate.snapshot.nodes.find(row=>row.text==='Catalog shelf 1');
  bystander.text = 'Changed elsewhere';
  assert.throws(()=>checkProtectedAtlas(fixture,before.snapshot,candidate.snapshot),/Protected native content/);
  bystander.text = 'Catalog shelf 1';
  bystander.native_id = 'replacement';
  assert.throws(()=>checkProtectedAtlas(fixture,before.snapshot,candidate.snapshot),/Protected native content/);
});

test('records inactive-page geometry as missing rather than copying fixture bounds', async () => {
  const inactive = mock(fixture.start,{unknownBounds:true});
  const captured = await captureAtlas(inactive.read,fixture,plan);
  assert.equal(captured.missingBounds.length,640);
  for(const row of captured.snapshot.nodes.filter(row=>row.kind==='text')) assert.equal(row.bounds,null);
});
