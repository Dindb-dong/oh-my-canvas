import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createReadStream} from 'node:fs';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {extname, join} from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

import {benchRequire} from './replays/mcp.mjs';

const scripts = fileURLToPath(new URL('.', import.meta.url));
const {chromium} = benchRequire('playwright');
const mime = {'.html': 'text/html', '.css': 'text/css', '.mjs': 'text/javascript', '.png': 'image/png'};

test('LD05 source fixtures retain behavior through scheduled patches at all widths', async t => {
  const work = await mkdtemp(join(tmpdir(), 'omc-ld05-test-'));
  t.after(() => rm(work, {recursive: true, force: true}));
  const browser = await chromium.launch({channel: 'chrome', headless: true});
  t.after(() => browser.close());

  for (const family of ['route-board', 'supply-ledger']) {
    const root = join(work, family);
    const contract = JSON.parse(execFileSync('python3', [join(scripts, 'ld05_contract.py'), family]));
    const run = (action, ...args) => JSON.parse(execFileSync(
      'python3', [join(scripts, 'ld05_source.py'), action, family, root, ...args],
      {env: {...process.env, PYTHONDONTWRITEBYTECODE: '1'}},
    ));
    const initial = run('prepare');
    assert.equal(initial.fixture_sha256, contract.fixture_sha256);
    const component = contract.cycles[0].source_state.component;
    const app = await readFile(join(root, 'app.mjs'), 'utf8');
    const card = await readFile(join(root, 'card.mjs'), 'utf8');
    assert.ok(app.startsWith(`import {${component} as createCard} from './card.mjs';`));
    assert.ok(card.includes(`export {createCard as ${component}};`));
    for (const name of ['app.mjs', 'card.mjs']) execFileSync(process.execPath, ['--check', join(root, name)]);
    const serve = createServer((request, response) => {
      const path = request.url === '/' ? 'index.html' : request.url.slice(1);
      if (!Object.hasOwn(initial.files, path)) {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, {'Content-Type': mime[extname(path)], 'Cache-Control': 'no-store'});
      createReadStream(join(root, path)).pipe(response);
    });
    await new Promise(resolve => serve.listen(0, '127.0.0.1', resolve));
    try {
      const seenHashes = new Set([initial.source_sha256]);
      for (const [index, cycle] of contract.cycles.entries()) {
        const changed = run('patch', '--cycle', String(index + 1));
        assert.ok(!seenHashes.has(changed.source_sha256));
        seenHashes.add(changed.source_sha256);
        assert.equal(changed.files['card.mjs'], initial.files['card.mjs']);
        assert.equal(changed.files['theme.css'], initial.files['theme.css']);
        for (const width of contract.widths) {
          const page = await browser.newPage({viewport: {width, height: 850}});
          try {
            page.setDefaultTimeout(5000);
            const origin = 'http://127.0.0.1:' + serve.address().port;
            await page.route('**/*', route => route.request().url().startsWith(origin + '/')
              ? route.continue() : route.abort());
            await page.goto(origin);
            assert.equal(await page.evaluate(async name => {
              const module = await import('./card.mjs');
              return typeof module[name] === 'function' && module[name] === module.createCard;
            }, component), true);
            const state = cycle.source_state;
            const toggle = page.getByRole('button', {name: state.check_control_name});
            assert.equal(await page.locator('#state').innerText(), state.keyboard_before);
            await toggle.press('Space');
            assert.equal(await page.locator('#state').innerText(), state.keyboard_after);
            assert.equal(await toggle.getAttribute('aria-pressed'), 'true');
            if (index >= 1) {
              const input = page.getByLabel(state.field_name);
              await input.press('Enter');
              assert.equal(await input.getAttribute('aria-invalid'), 'true');
              assert.equal(await page.locator('#field-error').innerText(), state.invalid_result);
              await input.fill(state.submitted_value);
              await input.press('Enter');
              assert.equal(await page.locator('#saved').innerText(),
                state.valid_result + ': ' + state.submitted_value);
            }
            if (index === 2) await page.getByLabel('Show extra item').check();
            assert.deepEqual(await page.locator('.card h2').allTextContents(), state.cards);
            assert.ok(await page.locator('.card img').first().evaluate(img => img.complete && img.naturalWidth === 64));
            assert.ok(await page.locator('html').evaluate(el => el.scrollWidth <= el.clientWidth));
            if (index === 2) {
              await page.getByLabel('Show extra item').uncheck();
              assert.deepEqual(await page.locator('.card h2').allTextContents(),
                contract.cycles[0].source_state.cards);
            }
          } finally {
            await page.close();
          }
        }
      }
    } finally {
      await new Promise((resolve, reject) => serve.close(error => error ? reject(error) : resolve()));
    }
  }
});
