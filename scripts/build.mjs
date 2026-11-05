import {build as viteBuild} from 'vite';
import {build} from 'esbuild';
import {writeDistributionLicenses} from './license-inventory.mjs';
import {writeNativeNotices} from './native-license-notices.mjs';
import {prepareBackgroundRemoval} from './prepare-background-removal.mjs';
import {promises as fs} from 'node:fs';
import path from 'node:path';
await fs.mkdir('public/fonts',{recursive:true});
await fs.copyFile('node_modules/canvaskit-wasm/bin/full/canvaskit.wasm','public/canvaskit.wasm');
await fs.copyFile('node_modules/@fontsource-variable/ibm-plex-sans/files/ibm-plex-sans-latin-wght-normal.woff2','public/fonts/plex.woff2');
const css=await fs.readFile('node_modules/@fontsource-variable/noto-sans-kr/index.css','utf8');
const faces=[{family:'IBM Plex Sans',url:'/fonts/plex.woff2',weight:'100 900',style:'normal'}];
for(const block of css.matchAll(/@font-face\s*\{([^}]+)\}/g)){
  const file=block[1].match(/url\(\.\/files\/([^)]+)\)/)?.[1];
  const unicodeRange=block[1].match(/unicode-range:\s*([^;]+);/)?.[1];
  if(!file)continue;
  await fs.copyFile(path.join('node_modules/@fontsource-variable/noto-sans-kr/files',file),path.join('public/fonts',file));
  faces.push({family:'Noto Sans KR',url:'/fonts/'+file,weight:'100 900',style:'normal',unicodeRange});
}
await fs.writeFile('src/fonts.json',JSON.stringify(faces));
await prepareBackgroundRemoval();
await viteBuild();
await writeDistributionLicenses('dist/licenses');
await writeNativeNotices('dist/licenses');
await fs.mkdir('dist/licenses/tabler-icons',{recursive:true});
for(const name of ['LICENSE','manifest.json'])await fs.copyFile('editor/ui/icons/tabler/'+name,'dist/licenses/tabler-icons/'+name);

await build({entryPoints:['electron/preload.cjs'],bundle:true,platform:'node',external:['electron'],outfile:'dist/preload.cjs'});
await build({entryPoints:['editor/mcp/defs.ts'],bundle:true,format:'esm',platform:'node',outfile:'dist/tool-defs.mjs'});
await build({entryPoints:['cli/mcp.mjs'],bundle:true,format:'cjs',platform:'node',outfile:'dist/mcp-cli.cjs'});
