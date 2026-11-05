// Exact current-byte and ASAR-path evidence, not a source-authorship or legal-clearance audit.
import assert from 'node:assert/strict';
import {readFile, readdir, mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {listPackage, extractFile, statFile} from '@electron/asar';
import {execFileSync} from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const primary = execFileSync('git',['worktree','list','--porcelain'],{cwd:root,encoding:'utf8'}).split('\n')[0].slice(9);
const output = path.join(primary,'internal/docs/vector-authoring/delivery');
const bundle = 'release/mac-arm64/Oh My Canvas.app';
const archivePath = `${bundle}/Contents/Resources/app.asar`;
const archive = path.join(root, archivePath);
const sha256 = data => createHash('sha256').update(data).digest('hex');
const manifest = JSON.parse(await readFile(path.join(root, 'licenses/native/manifest.json'), 'utf8'));
const lock = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8'));
const entries = listPackage(archive).map(name => name.replace(/^\//, ''));
const entrySet = new Set(entries);
const excludedPaths = entries.filter(name => /(?:^|\/)(?:vendor|apps)(?:\/|$)/.test(name) || /(?:^|\/)(?:konva-fallback\.[^/]+|synthetic\.ts)$/.test(name));
const checks = [], mismatches = [];
const currentDistFiles = await files('dist');
// electron-builder places the standalone CLI only in extraResources.
const asarDistFiles = currentDistFiles.filter(file => file !== 'dist/mcp-cli.cjs');
const unexpectedDistFiles = entries.filter(name => name.startsWith('dist/') && !statFile(archive, name).files && !asarDistFiles.includes(name));
for (const target of unexpectedDistFiles) mismatches.push({target, group: 'dist', error: 'Packaged dist file is absent from the current dist tree'});
async function compare(target, source, group) {
  const expected = await readFile(path.join(root, source));
  let actual;
  try {
    assert.ok(entrySet.has(target), `Missing ASAR path: ${target}`);
    actual = extractFile(archive, target);
  } catch (error) {
    mismatches.push({target, source, group, error: error.message});
    return;
  }
  const expectedSha256 = sha256(expected), actualSha256 = sha256(actual);
  const equal = expected.length === actual.length && expectedSha256 === actualSha256;
  checks.push({target, source, group, bytes: actual.length, sha256: actualSha256, equal});
  if (!equal) mismatches.push({target, source, group, expectedBytes: expected.length, actualBytes: actual.length, expectedSha256, actualSha256});
}
async function files(directory) {
  const out = [];
  for (const entry of await readdir(path.join(root, directory), {withFileTypes: true})) {
    const relative = `${directory}/${entry.name}`;
    if (entry.isDirectory()) out.push(...await files(relative));
    else if (entry.isFile()) out.push(relative);
    else throw Error(`Unexpected source symlink/nonregular file: ${relative}`);
  }
  return out.sort();
}
// Compare every current dist file, including all assets, WASM, fonts and native/npm notices.
for (const relative of asarDistFiles) await compare(relative, relative, 'dist');
for (const directory of ['core', 'electron', 'cli']) {
  for (const relative of await files(directory)) await compare(relative, relative, directory);
}
for (const relative of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) await compare(relative, relative, 'root');
// electron-builder strips build/scripts/devDependencies from package.json by design.
const currentPackage = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const packagedPackage = JSON.parse(extractFile(archive, 'package.json').toString('utf8'));
const runtimePackageFields = ['name', 'version', 'main', 'type', 'license', 'dependencies'];
for (const field of runtimePackageFields) {
  try { assert.deepEqual(packagedPackage[field], currentPackage[field]); }
  catch { mismatches.push({target: 'package.json', group: 'runtime-package', error: `Runtime package field differs: ${field}`}); }
}
const license = await readFile(path.join(root, 'LICENSE'), 'utf8');
assert.ok(!entries.some(name=>name.startsWith('node_modules/lucide/')), 'Removed icon dependency must not ship');
for(const name of ['LICENSE','manifest.json'])await compare('dist/licenses/tabler-icons/'+name,'editor/ui/icons/tabler/'+name,'tabler-original');
assert.match(license, /MIT License/);
assert.match(license, /Permission is hereby granted, free of charge/);
await compare('dist/licenses/native/manifest.json', 'licenses/native/manifest.json', 'native-original');
for (const entry of manifest.files) {
  const source = `licenses/native/${entry.file}`;
  const original = await readFile(path.join(root, source));
  assert.equal(original.length, entry.bytes, source);
  assert.equal(sha256(original), entry.sha256, source);
  await compare(`dist/licenses/native/${entry.file}`, source, 'native-original');
}
assert.equal(lock.packages['node_modules/canvaskit-wasm'].version, manifest.binary.packageVersion);
const installedCanvasKit = JSON.parse(await readFile(path.join(root, 'node_modules/canvaskit-wasm/package.json'), 'utf8'));
assert.equal(installedCanvasKit.version, manifest.binary.packageVersion);
const wasm = await readFile(path.join(root, manifest.binary.packagePath));
assert.equal(wasm.length, manifest.binary.bytes);
assert.equal(sha256(wasm), manifest.binary.sha256);
await compare('dist/canvaskit.wasm', manifest.binary.packagePath, 'audited-wasm');
for (const file of ['LICENSE', 'LICENSES.chromium.html']) {
  await compare(`dist/licenses/electron-${file}`, `node_modules/electron/dist/${file}`, 'electron-original');
}
for (const relative of await files('public/fonts')) await compare(`dist/fonts/${path.basename(relative)}`, relative, 'font-original');
// The standalone CLI sits outside app.asar for Electron Node-mode execution.
const standalone = await readFile(path.join(root, bundle, 'Contents/Resources/mcp-cli.cjs'));
const currentCli = await readFile(path.join(root, 'dist/mcp-cli.cjs'));
const standaloneCliMatches = standalone.equals(currentCli);
if (!standaloneCliMatches) mismatches.push({target: 'Contents/Resources/mcp-cli.cjs', group: 'standalone-cli', error: 'Standalone CLI differs from current dist/mcp-cli.cjs'});
const passed = !mismatches.length && !excludedPaths.length;
const report = {schemaVersion: 1, at: new Date().toISOString(), passed,
  archive: archivePath, archiveSha256: sha256(await readFile(archive)),
  scope: 'ASAR path inventory and exact current file bytes only. No compiled-code AST analysis, source-authorship proof, exhaustive restricted-source detection, legal clearance or reproducible-build claim.',
  indexedPaths: entries.length, excludedPathPatterns: ['vendor/** at any depth', 'apps/** at any depth', 'konva-fallback.*', 'synthetic.ts'], excludedPaths, unexpectedDistFiles, runtimePackageFields,
  canvasKit: {...manifest.binary}, rootLicenseSha256: sha256(Buffer.from(license)),
  standaloneCli: {matchesCurrentDist: standaloneCliMatches, bytes: standalone.length, sha256: sha256(standalone)},
  groups: Object.fromEntries([...new Set(checks.map(item => item.group))].map(group => [group, checks.filter(item => item.group === group).length])),
  mismatches, checks};
await mkdir(output, {recursive: true});
await writeFile(path.join(output,'package-provenance.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({passed, indexedPaths: entries.length, comparedFiles: checks.length, excludedPaths, mismatches, report: path.join(output,'package-provenance.json')}, null, 2));
if (!passed) process.exitCode = 1;
