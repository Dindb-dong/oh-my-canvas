// Local evidence only. SPDX metadata and file presence do not establish authorship
// or complete binary-license compliance (notably Chromium and CanvasKit).
import {readFile,readdir,stat,mkdir,writeFile,copyFile} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
const sha256 = data => createHash('sha256').update(data).digest('hex');
const readJson = async file => JSON.parse(await readFile(file,'utf8'));
const exists = async file => !!await stat(file).catch(()=>null);
const noticeName = name => /^(licen[sc]e|copying|notice)([.-]|$)/i.test(name);

export async function collectDependencyEvidence() {
  const lock = await readJson('package-lock.json');
  const root = lock.packages[''];
  const packages = [], notices = [];
  for (const [location, entry] of Object.entries(lock.packages)) {
    if (!location) continue;
    const installed = await exists(path.join(location,'package.json'));
    const actual = installed ? await readJson(path.join(location,'package.json')) : null;
    const name = entry.name || location.split('node_modules/').at(-1);
    if (actual && actual.version !== entry.version) throw Error(`Lock/install version mismatch: ${location}`);
    const files = installed ? (await readdir(location)).filter(noticeName).sort() : [];
    const licenseFiles = [];
    for (const file of files) {
      const source = path.join(location,file);
      if (!(await stat(source)).isFile()) continue;
      const bytes = await readFile(source);
      licenseFiles.push({file,sha256:sha256(bytes),bytes:bytes.length});
      if (!entry.dev) notices.push({location,name,version:entry.version,file,text:bytes.toString('utf8')});
    }
    if (!entry.dev && (!installed || !licenseFiles.length)) throw Error(`Runtime license evidence missing: ${location}`);
    packages.push({location,name,version:entry.version,license:entry.license || 'UNKNOWN',
      installedLicense:actual?.license ?? null,developmentOnly:!!entry.dev,optional:!!entry.optional,
      installed,directRuntime:Object.hasOwn(root.dependencies || {},name) && location===`node_modules/${name}`,
      directDevelopment:Object.hasOwn(root.devDependencies || {},name) && location===`node_modules/${name}`,
      licenseFiles});
  }
  const count = list => Object.fromEntries([...new Set(list.map(x=>x.license))].sort().map(license=>[license,list.filter(x=>x.license===license).length]));
  const runtime = packages.filter(x=>!x.developmentOnly);
  const evidence = {schemaVersion:1,lockfileSha256:sha256(await readFile('package-lock.json')),
    counting:'Lockfile package locations, including optional platform packages and duplicate versions. Runtime means not marked dev, not a tree-shaken bundle attribution. Electron runtime is separately distributed despite devDependency placement.',
    summary:{directRuntime:Object.keys(root.dependencies || {}).length,directDevelopment:Object.keys(root.devDependencies || {}).length,
      lockfileLocations:packages.length,uniqueNameVersions:new Set(packages.map(x=>`${x.name}@${x.version}`)).size,
      runtimeLocations:runtime.length,developmentOnlyLocations:packages.length-runtime.length,
      installedLocations:packages.filter(x=>x.installed).length,runtimeLicenseCounts:count(runtime),allLicenseCounts:count(packages)},packages};
  const text = ['# Third-party npm runtime license texts',
    'Generated from the locked, locally installed runtime packages by scripts/license-inventory.mjs.',
    'These materials keep their original terms. node-forge is used under its BSD-3-Clause option.',
    'Electron/Chromium and bundled-font notices also accompany the distribution. CanvasKit embedded third-party coverage requires separate review.',
    ...notices.map(x=>`\n${'='.repeat(72)}\n${x.name}@${x.version} — ${x.location}/${x.file}\n${'='.repeat(72)}\n${x.text}`)].join('\n')+'\n';
  return {evidence,text};
}

export async function writeDistributionLicenses(directory) {
  const {text} = await collectDependencyEvidence();
  await mkdir(directory,{recursive:true});
  await writeFile(path.join(directory,'npm-runtime.txt'),text);
  for (const file of ['LICENSE','LICENSES.chromium.html']) {
    await copyFile(path.join('node_modules/electron/dist',file),path.join(directory,`electron-${file}`));
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const {evidence,text} = await collectDependencyEvidence();
  await mkdir('docs/licensing',{recursive:true});
  await writeFile('docs/licensing/dependencies.json',JSON.stringify(evidence,null,2)+'\n');
  await writeFile('THIRD_PARTY_LICENSES.txt',text);
  console.log(JSON.stringify(evidence.summary,null,2));
}
