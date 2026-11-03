// Read-only inspection of the selected source history before its first remote push.
import {execFileSync} from 'node:child_process';
import {mkdir,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const git=(...args)=>execFileSync('git',args,{maxBuffer:128*1024*1024});
const commits=git('rev-list','--reverse','HEAD').toString().trim().split('\n');
const files=new Map(),failures=[];
const excluded=/(?:^|\/)(?:node_modules|dist|release|work|\.worktrees|\.omx|profiles?|userdata|user-data|recon|vendor|apps|\.aws|\.ssh)(?:\/|$)|(?:^|\/)\.env(?:\.|$)|(?:^|\/)(?:source-comparison|source-provenance)\.json$/i;
const textFile=/\.(?:[cm]?js|ts|tsx|jsx|json|md|txt|html?|css|ya?ml|svg|toml|ini|xml|py|sh|omc)$/i;
const sensitive=[
 ['absolute home path',new RegExp('(?:/[U]sers/[^/\\s]+/|/[h]ome/[^/\\s]+/|[A-Z]:\\\\Users\\\\[^\\\\\\s]+\\\\)')],
 ['private key',new RegExp(['-----BEGIN','(?:RSA |EC |OPENSSH )?PRIVATE KEY-----'].join(' '))],
 ['AWS access identifier',new RegExp('\\b(?:AKIA|ASIA)[A-Z0-9]{16}\\b')],
 ['service token',new RegExp('\\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|xox[baprs]-[A-Za-z0-9-]{20,})\\b')]
];
for(const commit of commits){
 for(const entry of git('ls-tree','-r','-z',commit).toString().split('\0').filter(Boolean)){
  const [meta,file]=entry.split('\t'),[mode,type,oid]=meta.split(' ');
  if(excluded.test(file)||!['100644','100755'].includes(mode)||type!=='blob')failures.push({commit,file,reason:'Excluded path or nonregular source entry'});
  files.set(oid,files.get(oid)||file);
 }
}
let bytes=0,textBlobs=0;
for(const [oid,file] of files){
 const size=Number(git('cat-file','-s',oid).toString());bytes+=size;
 if(size>=100*1024*1024)failures.push({file,reason:'GitHub file size limit'});
 if(!textFile.test(file))continue;
 textBlobs++;const text=git('cat-file','blob',oid).toString('utf8');
 for(const [reason,pattern] of sensitive)if(pattern.test(text))failures.push({file,reason});
}
const report={passed:!failures.length,commits:commits.length,rootCommit:commits[0],head:commits.at(-1),uniqueBlobs:files.size,textBlobs,inspectedBytes:bytes,scope:'HEAD-reachable source history only; excluded paths, regular files, file size and explicit credential/home-path patterns. No legal-clearance or exhaustive secret-detection claim. Binary screenshot content needs separate visual review.',failures};
await mkdir('work',{recursive:true});await writeFile('work/upload-history.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));assert.equal(failures.length,0,'Source history needs review before upload');
