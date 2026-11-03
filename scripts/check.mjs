import {readdirSync} from 'node:fs';import {spawnSync} from 'node:child_process';import path from 'node:path';
let count=0;
for(const dir of ['core','electron','src','cli','scripts'])for(const file of readdirSync(dir)){
  if(!/\.(mjs|cjs|js)$/.test(file))continue;
  const r=spawnSync(process.execPath,['--check',path.join(dir,file)],{stdio:'inherit'});if(r.status)process.exit(r.status);count++;
}
console.log(`PASS syntax checks for ${count} application files`);
