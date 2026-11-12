import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile,copyFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const MODEL_URL='https://huggingface.co/edgetools/u2netp/resolve/25dee37ab19c5b6ad64ba6578eba63f1ae07720c/u2netp.onnx';
const MODEL_SHA256='309c8469258dda742793dce0ebea8e6dd393174f89934733ecc8b14c76f4ddd8';
const valid=bytes=>bytes?.length===4574861&&createHash('sha256').update(bytes).digest('hex')===MODEL_SHA256;
const browserAssets='public/background-removal';

async function prepareModel(directory){
  await mkdir(directory,{recursive:true});
  const file=join(directory,'u2netp.onnx');
  let model=await readFile(file).catch(()=>null);
  if(!valid(model)){
    model=await readFile(join(browserAssets,'u2netp.onnx')).catch(()=>null);
    if(!valid(model)){
      const response=await fetch(MODEL_URL,{signal:AbortSignal.timeout(120000)});
      if(!response.ok)throw Error('Could not download the pinned background-removal model');
      model=Buffer.from(await response.arrayBuffer());
      if(!valid(model))throw Error('Background-removal model checksum mismatch');
    }
    await writeFile(file,model);
  }
  await copyFile('docs/licensing/u2netp-LICENSE.txt',join(directory,'LICENSE.txt'));
  await copyFile('docs/licensing/background-removal.md',join(directory,'NOTICE.md'));
}

export async function prepareBackgroundRemoval(){
  await prepareModel(browserAssets);
  for(const name of ['ort-wasm-simd-threaded.mjs','ort-wasm-simd-threaded.wasm'])await copyFile('node_modules/onnxruntime-web/dist/'+name,join(browserAssets,name));
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  if(process.argv.length!==4||process.argv[2]!=='--native')throw Error('Usage: node scripts/prepare-background-removal.mjs --native <native runtime directory>');
  await prepareModel(join(process.argv[3],'background-removal'));
}
