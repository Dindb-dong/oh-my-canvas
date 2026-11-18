import {readdirSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import path from 'node:path';

let count=0;
for(const directory of ['scripts','native/tests','tools/local-dev-bench']) {
  for(const file of readdirSync(directory,{recursive:true})) {
    if(!/\.[cm]?js$/.test(file))continue;
    const result=spawnSync(process.execPath,['--check',path.join(directory,file)],{stdio:'inherit'});
    if(result.status!==0)process.exit(result.status??1);
    count++;
  }
}
console.log(`PASS syntax checks for ${count} development files`);
