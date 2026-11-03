import {spawn} from 'node:child_process';
// Build on launch so the same sandboxed app protocol and CSP are used in dev and release.
const build=spawn(process.platform==='win32'?'npm.cmd':'npm',['run','build'],{stdio:'inherit'});
await new Promise((resolve,reject)=>build.on('exit',code=>code===0?resolve():reject(Error('Build failed'))));
const child=spawn(process.platform==='win32'?'node_modules/.bin/electron.cmd':'node_modules/.bin/electron',['.','--debug-ui'],{stdio:'inherit'});
child.on('exit',code=>process.exit(code||0));
