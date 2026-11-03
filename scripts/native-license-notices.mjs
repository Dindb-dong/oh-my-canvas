// Offline packaging: an updated CanvasKit binary requires a new native notice audit.
import {readFile, mkdir, copyFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = path.join(root, 'licenses/native');
const sha256 = data => createHash('sha256').update(data).digest('hex');

export async function writeNativeNotices(directory) {
  const manifest = JSON.parse(await readFile(path.join(source, 'manifest.json'), 'utf8'));
  const pkg = JSON.parse(await readFile(path.join(root, 'node_modules/canvaskit-wasm/package.json'), 'utf8'));
  const wasm = await readFile(path.join(root, manifest.binary.packagePath));
  if (pkg.version !== manifest.binary.packageVersion || wasm.length !== manifest.binary.bytes || sha256(wasm) !== manifest.binary.sha256) {
    throw new Error('CanvasKit native notice audit mismatch. Re-audit the installed package version and full WASM binary, then update licenses/native; builds never download notices automatically.');
  }
  // Validate every preserved source before writing any notices into the distribution.
  const files = await Promise.all(manifest.files.map(async entry => {
    const relative = entry.file;
    if (path.isAbsolute(relative) || relative.split(/[\\/]/).includes('..')) throw new Error(`Invalid native notice path: ${relative}`);
    const data = await readFile(path.join(source, relative));
    if (data.length !== entry.bytes || sha256(data) !== entry.sha256) throw new Error(`Native notice checksum mismatch: ${relative}`);
    return relative;
  }));
  const target = path.join(directory, 'native');
  for (const relative of ['manifest.json', ...files]) {
    const output = path.join(target, relative);
    await mkdir(path.dirname(output), {recursive: true});
    await copyFile(path.join(source, relative), output);
  }
}
