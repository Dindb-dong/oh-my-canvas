// Package from task-owned real files; never install dependencies or copy private Git history.
import {cp, lstat, mkdir, readFile, readdir, realpath, rm, stat, statfs, writeFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const stage = path.join(root, 'work/package-stage');
const output = path.join(root, 'release');
const marker = '.omc-package-stage.json';
const owner = {owner: 'oh-my-canvas-local-packaging', projectRoot: root};
const budget = 1024 ** 3;
const prepareOnly = process.argv.slice(2).includes('--prepare-only');
if (process.argv.slice(2).some(arg => arg !== '--prepare-only')) throw Error('Usage: node scripts/package-local.mjs [--prepare-only]');

async function measure(directory) {
  let bytes = 0, allocatedBytes = 0, files = 0;
  for (const entry of await readdir(directory, {withFileTypes: true})) {
    const file = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw Error(`Unexpected staged symbolic link: ${file}`);
    if (entry.isDirectory()) {
      const nested = await measure(file);
      bytes += nested.bytes; allocatedBytes += nested.allocatedBytes; files += nested.files;
    } else {
      const info = await stat(file);
      bytes += info.size; allocatedBytes += info.blocks * 512; files++;
    }
  }
  return {bytes, allocatedBytes, files};
}

const lock = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8'));
const project = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const runtime = [], absentOptional = [];
for (const [location, entry] of Object.entries(lock.packages)) {
  if (!location || entry.dev) continue;
  if (!location.startsWith('node_modules/') || location.split('/').includes('..')) throw Error(`Unexpected lockfile package path: ${location}`);
  const packagePath = path.join(root, location);
  let installed;
  try { installed = JSON.parse(await readFile(path.join(packagePath, 'package.json'), 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT' && entry.optional) { absentOptional.push(location); continue; }
    throw error;
  }
  if (installed.version !== entry.version) throw Error(`Installed/locked version mismatch: ${location}`);
  runtime.push({location, version: entry.version, source: await realpath(packagePath)});
}
for (const name of Object.keys(project.dependencies || {})) {
  if (!runtime.some(entry => entry.location === `node_modules/${name}`)) throw Error(`Direct runtime package missing: ${name}`);
}
const electronDist = await realpath(path.join(root, 'node_modules/electron/dist'));
const builder = await realpath(path.join(root, 'node_modules/electron-builder/cli.js'));
const electronVersion = JSON.parse(await readFile(path.join(root, 'node_modules/electron/package.json'), 'utf8')).version;
if ((await readFile(path.join(electronDist, 'version'), 'utf8')).trim() !== electronVersion) throw Error('Electron package/runtime version mismatch.');
const electronSize = await measure(electronDist).catch(async error => {
  // Official macOS Electron frameworks contain internal symlinks; measure their files once.
  if (!error.message.startsWith('Unexpected staged symbolic link:')) throw error;
  let bytes = 0;
  async function visit(directory) {
    for (const entry of await readdir(directory, {withFileTypes: true})) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile()) bytes += (await stat(file)).size;
    }
  }
  await visit(electronDist);
  return {bytes};
});
const freeBefore = await statfs(root);
const availableBeforeBytes = freeBefore.bavail * freeBefore.bsize;
if (availableBeforeBytes < budget) throw Error('Less than 1 GiB available; local packaging was not started.');

const previous = await lstat(stage).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
if (previous) {
  if (!previous.isDirectory() || previous.isSymbolicLink()) throw Error(`Refusing to replace non-directory staging target: ${stage}`);
  const existingOwner = JSON.parse(await readFile(path.join(stage, marker), 'utf8'));
  if (existingOwner.owner !== owner.owner || existingOwner.projectRoot !== owner.projectRoot) throw Error(`Refusing to replace unowned staging directory: ${stage}`);
  await rm(stage, {recursive: true});
}
await mkdir(stage, {recursive: true});
await writeFile(path.join(stage, marker), JSON.stringify(owner, null, 2) + '\n');
for (const relative of ['package.json', 'package-lock.json', 'dist', 'electron', 'core', 'cli', 'build/icon.png', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'THIRD_PARTY_LICENSES.txt', 'licenses']) {
  await cp(path.join(root, relative), path.join(stage, relative), {recursive: true, dereference: true});
}
// Copy each locked location separately so an ancestor copy cannot include unrelated nested packages.
for (const entry of runtime) {
  await cp(entry.source, path.join(stage, entry.location), {
    recursive: true, dereference: true,
    filter: source => !path.relative(entry.source, source).split(path.sep).includes('node_modules'),
  });
}
for (const entry of runtime) {
  const installed = JSON.parse(await readFile(path.join(stage, entry.location, 'package.json'), 'utf8'));
  if (installed.version !== entry.version) throw Error(`Staged package version mismatch: ${entry.location}`);
}
const staged = await measure(stage);
// Budget covers the stage plus an uncompressed copy of its contents and the existing Electron runtime.
const estimatedWorkingBytes = staged.bytes * 2 + electronSize.bytes;
if (estimatedWorkingBytes >= budget) throw Error(`Packaging estimate ${estimatedWorkingBytes} bytes exceeds the 1 GiB task budget; stage retained for inspection.`);
const args = [builder, '--projectDir', stage, '--dir', '--publish', 'never',
  `--config.electronDist=${electronDist}`, `--config.electronVersion=${electronVersion}`, `--config.directories.output=${output}`,
  '--config.npmRebuild=false', '--config.nodeGypRebuild=false', '--config.buildDependenciesFromSource=false'];
const summary = {stage, output, runtimePackageLocations: runtime.length, absentOptional,
  ...staged, estimatedWorkingBytes, availableBeforeBytes, prepareOnly,
  command: [process.execPath, ...args]};
await writeFile(path.join(stage, 'preparation.json'), JSON.stringify(summary, null, 2) + '\n');
console.log(JSON.stringify(summary, null, 2));
if (!prepareOnly) {
  const child = spawn(process.execPath, args, {cwd: root, stdio: 'inherit', env: {
    ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false', ELECTRON_SKIP_BINARY_DOWNLOAD: '1',
  }});
  child.once('error', error => { console.error(error); process.exitCode = 1; });
  child.once('exit', (code, signal) => { process.exitCode = signal ? 1 : (code ?? 1); });
}
