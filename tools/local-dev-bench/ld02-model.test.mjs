import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {withLD02Broker} from './ld02-model.mjs';

test('Atlas MCP requires actual semantic lookup and only one committed scope', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ld2-'));
  const path = join(directory, 'broker.sock');
  const entry = fileURLToPath(new URL('./ld02_atlas_model_stdio.py', import.meta.url));
  const query = {name: 'Synthetic station', receipt: 'AC-301'};
  const decoy = {...query, receipt: 'ES-300'};
  const before = {text: 'Current', gap_px: 8, radius_px: 4};
  const desired = {...query, text: 'Wrong but valid text', gap_px: 21, radius_px: 11};
  const lowercase = {...query, name: query.name.toLowerCase()};
  const audit = [];
  let writes = 0;
  try {
    await withLD02Broker(path, {
      query,
      find: selector => ({...selector, ...before}),
      edit: (selector, requested) => {
        writes++;
        assert.deepEqual(selector, query);
        assert.deepEqual(requested, {text: desired.text, gap: 21, radius: 11});
        return desired;
      },
    }, audit, async () => {
      const requests = [
        ['edit_section', desired], ['find_section', decoy],
        ['edit_section', {...desired, ...decoy}], ['edit_section', desired],
        ['find_section', lowercase], ['edit_section', {...desired, documentId: 'out-of-scope'}],
        ['edit_section', {...desired, ...lowercase}], ['edit_section', desired],
      ];
      const replies = await new Promise((resolve, reject) => {
        const python = execFile('python3', ['-B', entry, path], (error, stdout) => {
          if (error) reject(error);
          else resolve(stdout.trim().split('\n').map(line => JSON.parse(line).result));
        });
        python.stdin.end(requests.map(([name, args], id) => JSON.stringify({
          jsonrpc: '2.0', id, method: 'tools/call', params: {name, arguments: args},
        }) + '\n').join(''));
      });
      assert.deepEqual(replies.map(row => row.isError), [true, false, true, true, false, true, false, true]);
      assert.deepEqual(JSON.parse(replies[6].content[0].text), desired);
    });
    assert.equal(writes, 1);
    assert.equal(audit.filter(row => row.name === 'edit_section' && row.status === 'ok').length, 1);
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});
