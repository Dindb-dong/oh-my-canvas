import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {mkdtemp, rm} from 'node:fs/promises';
import {createConnection} from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {withLD03Broker} from './ld03-model.mjs';

test('LD03 broker offers only scoped reads and four bounded writes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ld3-'));
  const path = join(dir, 'broker.sock');
  const archive = {accent: '#002233', spacing_px: 12};
  let target = {accent: '#cc2211', spacing_px: 8};
  const inspect = () => ({archive, target});
  const events = [];
  function request(name, args) {
    return new Promise((resolve, reject) => {
      const socket = createConnection(path);
      let data = '';
      socket.setEncoding('utf8');
      socket.on('connect', () => socket.write(JSON.stringify({name, arguments: args}) + '\n'));
      socket.on('data', chunk => { data += chunk; });
      socket.on('end', () => resolve(JSON.parse(data)));
      socket.on('error', reject);
    });
  }
  try {
    await withLD03Broker(path, {inspect, apply: next => { target = next; return inspect(); }}, events, async () => {
      assert.deepEqual(await request('inspect_shared_values', {}), {result: inspect()});
      const replies = await new Promise((resolve, reject) => {
        const entry = fileURLToPath(new URL('./ld03_model_stdio.py', import.meta.url));
        const python = execFile('python3', ['-B', entry, path], (error, stdout) => {
          if (error) reject(error);
          else resolve(stdout.trim().split('\n').map(line => JSON.parse(line).result));
        });
        python.stdin.end([
          {jsonrpc: '2.0', id: 1, method: 'tools/list'},
          {jsonrpc: '2.0', id: 2, method: 'tools/call', params: {name: 'inspect_shared_values', arguments: {}}},
        ].map(event => JSON.stringify(event) + '\n').join(''));
      });
      assert.deepEqual(replies[0].tools.map(tool => tool.name), ['inspect_shared_values', 'set_shared_values']);
      assert.deepEqual(JSON.parse(replies[1].content[0].text), inspect());
      assert.ok((await request('inspect_shared_values', [])).error);
      assert.ok((await request('set_variable', {documentId: 'elsewhere'})).error);
      assert.ok((await request('set_shared_values', {accent: '#000000', spacing_px: 4, documentId: 'elsewhere'})).error);
      assert.ok((await request('set_shared_values', {accent: '#000000', spacing_px: 4.4})).error);
      for (let spacing_px = 20; spacing_px < 24; spacing_px++) {
        const {result} = await request('set_shared_values', {accent: '#136B62', spacing_px});
        assert.deepEqual(result, {target: {accent: '#136b62', spacing_px}, archive});
      }
      assert.equal((await request('set_shared_values', {accent: '#111111', spacing_px: 9})).error, 'Write limit reached');
      assert.deepEqual(await request('inspect_shared_values', {}), {result: inspect()});
    });
    assert.equal(events.filter(event => event.name === 'set_shared_values' && event.status === 'ok').length, 4);
    assert.equal(events.filter(event => event.status === 'rejected').length, 5);
  } finally {
    await rm(dir, {recursive: true, force: true});
  }
});
