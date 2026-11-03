import {readFile,mkdir,writeFile} from 'node:fs/promises';import path from 'node:path';import {pathToFileURL} from 'node:url';import assert from 'node:assert/strict';
const baseline=process.argv.find(a=>a.startsWith('--baseline='))?.slice(11);
const file=JSON.parse(await readFile('docs/design/system/component-library.omc','utf8'));
const results={document:'component-library.omc',samples:12,excludes:['Electron rendering','IPC','fsync'],runs:{}};
for(const [name,dir] of [['current',path.resolve('core')],...(baseline?[['baseline',path.resolve(baseline)]]:[])]){
 const {Replica}=await import(pathToFileURL(path.join(dir,'replica.mjs'))),{changesBetween}=await import(pathToFileURL(path.join(dir,'document.mjs')));
 for(const mode of ['clone','shared']){
  const r=new Replica({state:Buffer.from(file.state,'base64')}),times=[];
  try{for(let i=0;i<13;i++){
   const start=performance.now(),before=r.document,pid=before.pages[0],page=before.pagesById[pid],id=Object.keys(page.objects).find(id=>id!=='root');
   const after=mode==='clone'?structuredClone(before):{...before,pagesById:{...before.pagesById,[pid]:{...page,objects:{...page.objects,[id]:{...page.objects[id]}}}}};
   after.pagesById[pid].objects[id].name='Benchmark '+i;r.patch(changesBetween(before,after),'benchmark');assert.equal(r.document.pagesById[pid].objects[id].name,'Benchmark '+i);
   if(i)times.push(performance.now()-start);
  }}finally{r.destroy();}
  const sorted=[...times].sort((a,b)=>a-b);results.runs[name+'-'+mode]={medianMs:sorted[Math.floor(sorted.length/2)],p95Ms:sorted[Math.ceil(sorted.length*.95)-1],samplesMs:times};
 }
}
if(baseline)for(const mode of ['clone','shared'])results.runs['speedup-'+mode]=results.runs['baseline-'+mode].medianMs/results.runs['current-'+mode].medianMs;
await mkdir('docs/qa',{recursive:true});await writeFile('docs/qa/edit-performance.json',JSON.stringify(results,null,2));console.log(JSON.stringify(results,null,2));
