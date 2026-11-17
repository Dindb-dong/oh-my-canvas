import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';

const properties = {fill: 'backgroundColor', gap: 'gap'};
const tool = (name, fileId, fields) => ({name, arguments: {fileId, ...fields}});

function tokenName(prefix, row) {
  return `--${row.kind === 'color' ? 'color' : 'spacing'}-${prefix}-${row.key.replace('.', '-')}`;
}

function cssValue(kind, value) {
  return kind === 'color' ? value : `${value}px`;
}

function validate(fixture, scope) {
  assert.equal(fixture.workload, 'LD03');
  assert.match(scope.prefix, /^omc-ld03-[a-z0-9][a-z0-9-]{0,32}$/);
  for (const key of ['fileId', 'fileName', 'pageId', 'boardId']) {
    assert.ok(typeof scope[key] === 'string' && scope[key].trim(), `Missing scope.${key}`);
  }
}

export function plan(fixture, scope) {
  validate(fixture, scope);
  const tokenNames = new Map(fixture.start.styles.map(row => [row.key, tokenName(scope.prefix, row)]));
  const starting = fixture.start.styles.map(row => ({
    type: row.kind === 'color' ? 'color' : 'spacing',
    name: tokenNames.get(row.key), value: cssValue(row.kind, row.value),
  }));
  const edits = phase => fixture[phase].styles.map(row => ({
    name: tokenNames.get(row.key), value: cssValue(row.kind, row.value),
  })).filter(row => starting.find(start => start.name === row.name).value !== row.value);
  const bindings = [];
  for (const node of fixture.start.nodes.filter(row => Object.hasOwn(row, 'bindings'))) {
    const nodeId = scope.nodes?.[node.key];
    assert.ok(typeof nodeId === 'string' && nodeId, `Missing native ID for ${node.key}`);
    const styles = {};
    for (const [key, css] of Object.entries(properties)) {
      const reference = node.bindings[key];
      styles[css] = reference ? `var(${tokenNames.get(reference)})` :
        cssValue(key === 'fill' ? 'color' : 'length', node[key]);
    }
    bindings.push({nodeIds: [nodeId], styles});
  }
  assert.equal(new Set(bindings.map(row => row.nodeIds[0])).size, bindings.length, 'Repeated card IDs');
  return {
    setup: [
      tool('create_tokens', scope.fileId, {tokens: starting}),
      tool('update_styles', scope.fileId, {updates: bindings}),
    ],
    candidate: tool('set_tokens', scope.fileId, {tokens: edits('expected')}),
    probe: tool('set_tokens', scope.fileId, {tokens: edits('probe')}),
  };
}

function normalizeColor(value) {
  if (typeof value !== 'string') return undefined;
  if (/^#[0-9a-f]{6}$/i.test(value)) return value.toLowerCase();
  const rgb = value.match(/^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/);
  if (rgb && rgb.slice(1).every(channel => Number(channel) <= 255)) {
    return '#' + rgb.slice(1).map(channel => Number(channel).toString(16).padStart(2, '0')).join('');
  }
  return undefined;
}

function number(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return typeof value === 'string' && /^-?\d+(?:\.\d+)?px$/.test(value) ? Number(value.slice(0, -2)) : undefined;
}

export function normalize(fixture, scope, observation) {
  validate(fixture, scope);
  const {home, page, tokens, details, computed, sourceStyles} = observation;
  assert.equal(home.fileName, scope.fileName, 'Different Paper file');
  assert.ok(home.pages.some(row => row.id === scope.pageId), 'Page is outside approved file');
  assert.ok(page.artboards.some(row => row.id === scope.boardId), 'Board is outside approved page');

  const tokenByName = new Map();
  for (const row of tokens.tokens) {
    assert.ok(!tokenByName.has(row.name), 'Duplicate native token selector');
    tokenByName.set(row.name, row);
  }
  assert.equal(tokenByName.size, fixture.start.styles.length, 'Missing or extra run-scoped tokens');
  const styles = fixture.start.styles.map(row => {
    const name = tokenName(scope.prefix, row);
    const native = tokenByName.get(name);
    assert.ok(typeof native?.id === 'string' && native.id, `Missing stable native token ID for ${name}`);
    assert.equal(native.type, row.kind === 'color' ? 'color' : 'spacing', `Unexpected token type for ${name}`);
    return {
      key: row.key, native_id: native.id, kind: row.kind,
      value: row.kind === 'color' ? normalizeColor(native.value) : number(native.value),
    };
  });
  const idsByName = new Map(fixture.start.styles.map((row, index) => [tokenName(scope.prefix, row), styles[index].native_id]));
  const fixtureRows = new Map(fixture.start.nodes.map(row => [row.key, row]));
  const logicalByNative = new Map(Object.entries(scope.nodes ?? {}).map(([key, id]) => [id, key]));
  assert.equal(logicalByNative.get(scope.boardId), 'board');
  assert.equal(logicalByNative.size, fixtureRows.size, 'Incomplete or repeated setup IDs');

  const visited = new Set();
  const nodes = [];
  function walk(id, expectedParent) {
    const node = details[id];
    const key = logicalByNative.get(id);
    const spec = fixtureRows.get(key);
    assert.ok(spec && node?.id === id && !visited.has(id), 'Unexpected, missing or duplicate Paper layer');
    assert.equal(node.parentId, expectedParent, 'Paper layer parent mismatch');
    visited.add(id);
    const value = {
      key, native_id: id, parent: id === scope.boardId ? null : logicalByNative.get(node.parentId),
      kind: {Frame: 'frame', Text: 'text'}[node.component],
      editable: node.isLocked === false && node.isVisible === true,
    };
    if (node.component === 'Text') value.text = node.textContent;
    if (Object.hasOwn(spec, 'bindings')) {
      const rendered = computed.styles[id];
      const raw = sourceStyles[id];
      assert.ok(rendered && raw, `Missing CSS evidence for ${key}`);
      value.fill = normalizeColor(rendered.backgroundColor);
      value.gap = number(rendered.gap);
      value.layout = rendered.display === 'flex' && rendered.flexDirection === 'column' ? 'vertical' : undefined;
      value.bindings = {};
      for (const [property, css] of Object.entries(properties)) {
        const declared = raw[css];
        assert.ok(typeof declared === 'string' || typeof declared === 'number', `Missing raw ${css} for ${key}`);
        const reference = typeof declared === 'string' && declared.match(/^var\(\s*(--[\w-]+)\s*\)$/);
        if (reference) {
          assert.ok(idsByName.has(reference[1]), `Reference outside the scoped tokens on ${key}`);
          value.bindings[property] = idsByName.get(reference[1]);
        } else {
          assert.ok(property === 'fill' ? normalizeColor(declared) : number(declared) !== undefined,
            `Unverifiable literal override on ${key}.${property}`);
        }
      }
    }
    nodes.push(value);
    assert.ok(Array.isArray(node.childIds) && node.childIds.length === node.childCount);
    for (const child of node.childIds) walk(child, id);
  }
  walk(scope.boardId, page.rootNodeId);
  assert.equal(visited.size, fixtureRows.size, 'Incomplete Paper layer tree');
  return {document_id: scope.fileId, nodes, styles};
}

export function sourceStylesFromJsx(ts, code) {
  const syntax = ts.createSourceFile('paper-export.tsx', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  assert.equal(syntax.parseDiagnostics.length, 0, 'Paper JSX could not be parsed');
  const byId = Object.create(null);
  function visit(node) {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const list = node.attributes.properties.filter(ts.isJsxAttribute);
      const id = list.find(attr => attr.name.getText(syntax) === 'id')?.initializer;
      const style = list.find(attr => attr.name.getText(syntax) === 'style')?.initializer;
      if (id && ts.isStringLiteral(id) && style && ts.isJsxExpression(style)
          && style.expression && ts.isObjectLiteralExpression(style.expression)) {
        assert.ok(!Object.hasOwn(byId, id.text), 'Repeated node ID in Paper JSX');
        const fields = Object.create(null);
        for (const property of style.expression.properties) {
          if (!ts.isPropertyAssignment(property)) continue;
          const {name, initializer} = property;
          if (ts.isStringLiteral(initializer)) fields[name.text] = initializer.text;
          if (ts.isNumericLiteral(initializer)) fields[name.text] = Number(initializer.text);
        }
        byId[id.text] = fields;
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(syntax);
  return byId;
}

export async function capture(read, ts, fixture, scope) {
  validate(fixture, scope);
  const call = (name, args) => read(tool(name, scope.fileId, args));
  const home = await call('get_basic_info');
  assert.equal(home.fileName, scope.fileName, 'Different Paper file');
  assert.ok(home.pages.some(row => row.id === scope.pageId), 'Page is outside approved file');
  const page = await call('get_basic_info', {pageId: scope.pageId});
  assert.ok(page.artboards.some(row => row.id === scope.boardId), 'Board is outside approved page');
  const tokenRows = await Promise.all(['color', 'spacing'].map(type =>
    call('get_tokens', {types: [type], namePattern: `--${type}-${scope.prefix}-*`, format: 'json'})));
  const tokens = {tokens: tokenRows.flatMap(row => row.tokens)};
  const details = Object.create(null);
  let pending = [scope.boardId];
  while (pending.length) {
    const next = [];
    for (let offset = 0; offset < pending.length; offset += 8) {
      const group = await Promise.all(pending.slice(offset, offset + 8).map(nodeId =>
        call('get_node_info', {nodeId})));
      for (const row of group) {
        assert.ok(row.id && !Object.hasOwn(details, row.id), 'Duplicate or absent native node ID');
        details[row.id] = row;
        next.push(...row.childIds);
      }
    }
    pending = next;
    assert.ok(Object.keys(details).length + pending.length <= fixture.start.nodes.length, 'Paper board has extra layers');
  }
  const computed = await call('get_computed_styles', {nodeIds: Object.keys(details)});
  const jsx = await call('get_jsx', {
    nodeId: scope.boardId, includeNodeIds: true, includeRootPositioning: true, format: 'inline-styles',
  });
  assert.equal(typeof jsx, 'string');
  const raw = {home, page, tokens, details, computed, jsx};
  try {
    const snapshot = normalize(fixture, scope, {...raw, sourceStyles: sourceStylesFromJsx(ts, jsx)});
    return {raw, snapshot};
  } catch (error) {
    if (error.code !== 'ERR_ASSERTION') throw error;
    return {raw, snapshot: null, blocker: error.message};
  }
}

export async function withPaper(scope, action) {
  const endpoint = new URL(process.env.PAPER_BENCH_URL ?? 'http://127.0.0.1:29979/mcp');
  assert.ok(endpoint.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname));
  assert.ok(!endpoint.username && !endpoint.password && !endpoint.search && !endpoint.hash);
  const {Client, StreamableHTTPClientTransport, benchRequire} = await import('../replays/mcp.mjs');
  const client = new Client({name: 'paper-ld03-readback', version: '1'});
  try {
    await client.connect(new StreamableHTTPClientTransport(endpoint), {timeout: 10_000});
    const guide = await client.callTool({name: 'get_guide', arguments: {topic: 'paper-mcp-instructions'}});
    assert.ok(!guide.isError);
    const read = async selector => {
      const answer = await client.callTool(selector, undefined, {timeout: 30_000});
      const text = answer.content.filter(block => block.type === 'text').map(block => block.text);
      assert.ok(!answer.isError && text.length > 1 && text.slice(0, -1).some(header =>
        header.includes(scope.fileId)), `Paper response error or wrong file for ${selector.name}`);
      const body = text.at(-1);
      let data;
      try {
        data = JSON.parse(body);
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        assert.ok(!/^(error|failed)\b/i.test(body), `Paper returned error for ${selector.name}`);
        return body;
      }
      assert.ok(!data?.error, `Paper returned error for ${selector.name}`);
      return data;
    };
    return await action(read, benchRequire('typescript'));
  } finally {
    await client.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [mode, fixturePath, scopePath] = process.argv.slice(2);
  assert.ok(['plan', 'capture'].includes(mode) && fixturePath && scopePath,
    'Usage: ld03.mjs plan|capture FIXTURE.json SCOPE.json');
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
  const scope = JSON.parse(readFileSync(scopePath, 'utf8'));
  const output = mode === 'plan' ? plan(fixture, scope) :
    await withPaper(scope, (read, ts) => capture(read, ts, fixture, scope));
  console.log(JSON.stringify(output));
  if (output.blocker) process.exitCode = 1;
}
