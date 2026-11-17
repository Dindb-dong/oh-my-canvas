import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';

import {capture, plan, withPaper} from './ld03.mjs';

const canvasName = 'OMC Benchmark • Synthetic CAP Probe • 2026-11-17';
const controlBoard = 'CAP Editable Scene';
const markupEscape = text => text.replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[character]);

function validate(fixture, file, runId) {
  assert.equal(fixture.workload, 'LD03');
  assert.equal(fixture.source_family_id, 'field-relay');
  assert.equal(file.name, canvasName);
  assert.ok(typeof file.fileId === 'string' && /^[-\w]+$/.test(file.fileId), 'The approved file needs a bare ID');
  assert.match(runId, /^[a-z0-9][a-z0-9-]{7,31}$/);
}

export function boardPlan(fixture, file, runId) {
  validate(fixture, file, runId);
  const boardName = fixture.start.nodes.find(node => node.key === 'board/title').text;
  const children = new Map();
  for (const row of fixture.start.nodes) {
    if (!children.has(row.parent)) children.set(row.parent, []);
    children.get(row.parent).push(row);
  }
  const text = (row, large = false) => {
    const typography = large ? 'font-size:24px;font-weight:700;line-height:32px' :
      'font-size:13px;font-weight:500;line-height:18px';
    return `<div style="font-family:Arial;${typography};color:#111827">${markupEscape(row.text)}</div>`;
  };

  function renderGroup(group, index) {
    const left = 28 + (index % 3) * 466;
    const top = 90 + Math.floor(index / 3) * 420;
    const label = text(children.get(group.key)[0], true);
    const cards = children.get(group.key).slice(1).map((card, position) => {
      const x = 12 + position % 3 * 140;
      const y = 48 + Math.floor(position / 3) * 106;
      const labelMarkup = children.get(card.key).map(row =>
        `<div style="font-family:Arial;font-size:13px;font-weight:700;line-height:18px;color:#ffffff">${markupEscape(row.text)}</div>`
      ).join('');
      const css = `position:absolute;top:${y}px;left:${x}px;width:130px;height:92px;box-sizing:border-box;display:flex;flex-direction:column;gap:${card.gap}px;padding:8px;background-color:${card.fill}`;
      return `<div style="${css}">${labelMarkup}</div>`;
    });
    const css = `position:absolute;top:${top}px;left:${left}px;width:424px;height:374px;box-sizing:border-box;display:flex;flex-direction:column;padding:12px;background-color:#edeff3`;
    return `<div style="${css}">${label}${cards.join('')}</div>`;
  }

  const boardChildren = children.get('board');
  return {
    pageName: `LD03 preflight / ${runId}`,
    boardName,
    prefix: `omc-ld03-${runId}`,
    artboardStyles: {width: '1440px', height: '960px', display: 'flex',
      flexDirection: 'column', backgroundColor: '#f8fafc', padding: '28px'},
    fragments: [text(boardChildren[0], true), ...boardChildren.slice(1).map(renderGroup)],
  };
}

function guardToolResponse(name, answer) {
  const entries = Array.isArray(answer) ? answer : [...(answer?.results ?? []), answer];
  assert.ok(entries.every(entry => !entry?.error && entry?.result !== 'error' &&
    (!entry?.ignoredStyles || Object.keys(entry.ignoredStyles).length === 0)),
  `Paper reported an in-band failure in ${name}`);
}

export async function seed(read, ts, fixture, file, runId) {
  const board = boardPlan(fixture, file, runId);
  const trace = [];
  const scope = {fileId: file.fileId, fileName: file.name, prefix: board.prefix, nodes: {}};
  const call = async (name, fields = {}) => {
    const args = {...fields, fileId: file.fileId};
    const result = await read({name, arguments: args});
    trace.push({name, arguments: args, result});
    guardToolResponse(name, result);
    return result;
  };

  const original = await call('get_basic_info');
  assert.equal(original.fileName, canvasName);
  let approved = original.artboards.some(item => item.name === controlBoard);
  for (const {id: pageId} of original.pages) {
    if (approved) break;
    approved = (await call('get_basic_info', {pageId})).artboards.some(item => item.name === controlBoard);
  }
  assert.ok(approved, 'Approved synthetic control board missing');
  assert.ok(!original.pages.some(page => page.name === board.pageName), 'Benchmark page already exists');
  for (const type of ['color', 'spacing']) {
    const tokens = await call('get_tokens', {types: [type], format: 'json',
      namePattern: `--${type}-${board.prefix}-*`});
    assert.deepEqual(tokens.tokens, [], 'Benchmark token namespace already exists');
  }

  try {
    await call('create_page', {name: board.pageName});
    const updated = await call('get_basic_info');
    assert.equal(updated.fileName, canvasName);
    const pages = updated.pages.filter(item => item.name === board.pageName);
    assert.equal(pages.length, 1, 'Paper did not create a unique benchmark page');
    scope.pageId = pages[0].id;
    assert.ok(!original.pages.some(item => item.id === scope.pageId), 'Paper returned a preexisting page');
    assert.deepEqual((await call('get_basic_info', {pageId: scope.pageId})).artboards, [],
      'Benchmark page was not empty');

    await call('create_artboard', {pageId: scope.pageId, name: board.boardName, styles: board.artboardStyles});
    const page = await call('get_basic_info', {pageId: scope.pageId});
    assert.equal(page.artboards.length, 1);
    assert.equal(page.artboards[0].name, board.boardName);
    scope.boardId = page.artboards[0].id;

    const boardChildren = fixture.start.nodes.filter(row => row.parent === 'board');
    const direct = [];
    for (const [index, html] of board.fragments.entries()) {
      await call('write_html', {mode: 'insert-children', targetNodeId: scope.boardId, html});
      const {children} = await call('get_children', {nodeId: scope.boardId});
      assert.equal(children.length, direct.length + 1, 'Paper added an unexpected number of top-level layers');
      const previouslySeen = new Set(direct.map(item => item.id));
      const inserted = children.filter(item => !previouslySeen.has(item.id));
      assert.equal(inserted.length, 1, 'Paper changed existing IDs while inserting a layer');
      direct.push({id: inserted[0].id, spec: boardChildren[index], parentId: scope.boardId});
    }
    scope.nodes.board = scope.boardId;
    const parent = await call('get_node_info', {nodeId: scope.boardId});
    assert.equal(parent.id, scope.boardId);
    assert.equal(parent.parentId, page.rootNodeId);
    assert.equal(parent.component, 'Frame');
    assert.equal(parent.isLocked, false);
    assert.equal(parent.isVisible, true);
    assert.deepEqual(new Set(parent.childIds), new Set(direct.map(item => item.id)));

    let pending = direct;
    while (pending.length) {
      const next = [];
      for (let offset = 0; offset < pending.length; offset += 8) {
        const children = await Promise.all(pending.slice(offset, offset + 8).map(async item => {
          const detail = await call('get_node_info', {nodeId: item.id});
          assert.equal(detail.id, item.id);
          assert.equal(detail.parentId, item.parentId);
          assert.equal(detail.component, item.spec.kind === 'text' ? 'Text' : 'Frame');
          assert.equal(detail.isLocked, false);
          assert.equal(detail.isVisible, true);
          if (item.spec.kind === 'text') assert.equal(detail.textContent, item.spec.text);
          scope.nodes[item.spec.key] = item.id;
          const expected = fixture.start.nodes.filter(row => row.parent === item.spec.key);
          assert.equal(detail.childIds.length, expected.length);
          return expected.map((spec, index) => ({spec, id: detail.childIds[index], parentId: item.id}));
        }));
        next.push(...children.flat());
      }
      pending = next;
    }
    assert.equal(Object.keys(scope.nodes).length, fixture.logical_objects);
    assert.equal(new Set(Object.values(scope.nodes)).size, fixture.logical_objects);

    const {setup} = plan(fixture, scope);
    for (const {name, arguments: args} of setup) await call(name, args);
    const before = await capture(read, ts, fixture, scope);
    return {scope, setupTrace: trace, before, blocker: before.blocker};
  } catch (error) {
    return {scope, setupTrace: trace, blocker: error.message};
  } finally {
    if (scope.boardId) {
      await call('finish_working_on_nodes', {nodeIds: [...new Set([scope.boardId, ...Object.values(scope.nodes)])]})
        .catch(error => trace.push({name: 'finish_working_on_nodes', error: error.message}));
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [mode, fixturePath, configPath, runId] = process.argv.slice(2);
  assert.ok(['plan', 'seed'].includes(mode) && fixturePath && configPath && runId,
    'Usage: ld03-seed.mjs plan|seed FIXTURE.json APPROVED_FILE.json RUN_ID');
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
  const file = JSON.parse(readFileSync(configPath, 'utf8'));
  const planned = boardPlan(fixture, file, runId);
  const output = mode === 'plan' ? planned :
    await withPaper(file, (read, ts) => seed(read, ts, fixture, file, runId));
  console.log(JSON.stringify(output));
  if (output.blocker) process.exitCode = 1;
}
