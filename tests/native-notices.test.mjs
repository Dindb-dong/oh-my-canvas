import test from 'node:test';
import assert from 'node:assert/strict';
import {cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const sha256 = data => createHash('sha256').update(data).digest('hex');
const json = async file => JSON.parse(await readFile(file, 'utf8'));

test('native manifest covers the installed locked WASM and every preserved notice byte', async () => {
  const manifest = await json(path.join(root, 'licenses/native/manifest.json'));
  const lock = await json(path.join(root, 'package-lock.json'));
  const pkg = await json(path.join(root, 'node_modules/canvaskit-wasm/package.json'));
  assert.equal(manifest.binary.packageVersion, lock.packages['node_modules/canvaskit-wasm'].version);
  assert.equal(pkg.version, manifest.binary.packageVersion);
  const wasm = await readFile(path.join(root, manifest.binary.packagePath));
  assert.equal(wasm.length, manifest.binary.bytes);
  assert.equal(sha256(wasm), manifest.binary.sha256);
  const names = new Set();
  for (const entry of manifest.files) {
    assert.ok(!path.isAbsolute(entry.file) && !entry.file.split(/[\\/]/).includes('..'), `Unsafe native notice path: ${entry.file}`);
    assert.ok(!names.has(entry.file), `Duplicate native notice: ${entry.file}`);
    names.add(entry.file);
    const bytes = await readFile(path.join(root, 'licenses/native', entry.file));
    assert.equal(bytes.length, entry.bytes, entry.file);
    assert.equal(sha256(bytes), entry.sha256, entry.file);
  }
  async function inventory(directory, prefix = '') {
    const found = [];
    for (const item of await readdir(directory, {withFileTypes: true})) {
      const relative = prefix + item.name;
      if (item.isDirectory()) found.push(...await inventory(path.join(directory, item.name), relative + '/'));
      else { assert.ok(item.isFile(), `Native notice must be a regular file: ${relative}`); found.push(relative); }
    }
    return found;
  }
  assert.deepEqual((await inventory(path.join(root, 'licenses/native'))).sort(), ['manifest.json', ...names].sort(), 'Every preserved native file must be hash-recorded');
  for (const component of manifest.components) {
    assert.ok(component.noticeFiles.length, `${component.name} has no notice`);
    for (const file of component.noticeFiles) assert.ok(names.has(file), `${component.name}: ${file}`);
  }
});

test('offline native writer preserves all notices and rejects isolated tampering before publishing output', async t => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'omc-native-notices-'));
  try {
    const manifest = await json(path.join(root, 'licenses/native/manifest.json'));
    const isolatedNative = path.join(temporary, 'licenses/native');
    const isolatedPackage = path.join(temporary, 'node_modules/canvaskit-wasm/package.json');
    const isolatedWasm = path.join(temporary, manifest.binary.packagePath);
    await cp(path.join(root, 'licenses/native'), isolatedNative, {recursive: true});
    await mkdir(path.join(temporary, 'scripts'), {recursive: true});
    const modulePath = path.join(temporary, 'scripts/native-license-notices.mjs');
    await cp(path.join(root, 'scripts/native-license-notices.mjs'), modulePath);
    await mkdir(path.dirname(isolatedWasm), {recursive: true});
    await cp(path.join(root, 'node_modules/canvaskit-wasm/package.json'), isolatedPackage);
    await cp(path.join(root, manifest.binary.packagePath), isolatedWasm);
    const {writeNativeNotices} = await import(pathToFileURL(modulePath));
    const validOutput = path.join(temporary, 'valid');
    await writeNativeNotices(validOutput);
    for (const file of ['manifest.json', ...manifest.files.map(entry => entry.file)]) {
      assert.deepEqual(await readFile(path.join(validOutput, 'native', file)), await readFile(path.join(isolatedNative, file)), file);
    }
    const cases = [
      {name: 'package version', file: isolatedPackage, mutate: bytes => Buffer.from(JSON.stringify({...JSON.parse(bytes), version: '0.0.0-tampered'})), error: /native notice audit mismatch/},
      {name: 'same-size WASM change', file: isolatedWasm, mutate: bytes => { const changed = Buffer.from(bytes); changed[changed.length - 1] ^= 1; return changed; }, error: /native notice audit mismatch/},
      {name: 'preserved notice change', file: path.join(isolatedNative, manifest.files[0].file), mutate: bytes => Buffer.concat([bytes, Buffer.from('\nTampered isolated test notice\n')]), error: /Native notice checksum mismatch/},
    ];
    for (const [index, item] of cases.entries()) {
      await t.test(item.name, async () => {
        const before = await readFile(item.file);
        const output = path.join(temporary, `invalid-${index}`);
        try {
          await writeFile(item.file, item.mutate(before));
          await assert.rejects(writeNativeNotices(output), item.error);
          await assert.rejects(stat(path.join(output, 'native')), {code: 'ENOENT'});
        } finally { await writeFile(item.file, before); }
      });
    }
  } finally { await rm(temporary, {recursive: true, force: true}); }
});
