import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile,copyFile} from 'node:fs/promises';

const MODEL_URL='https://huggingface.co/edgetools/u2netp/resolve/25dee37ab19c5b6ad64ba6578eba63f1ae07720c/u2netp.onnx';
const MODEL_SHA256='309c8469258dda742793dce0ebea8e6dd393174f89934733ecc8b14c76f4ddd8';
const valid=bytes=>bytes.length===4574861&&createHash('sha256').update(bytes).digest('hex')===MODEL_SHA256;
export async function prepareBackgroundRemoval(){
  await mkdir('public/background-removal',{recursive:true});
  const file='public/background-removal/u2netp.onnx';
  let model=await readFile(file).catch(()=>null);
  if(!model||!valid(model)){
    const response=await fetch(MODEL_URL,{signal:AbortSignal.timeout(120000)});
    if(!response.ok)throw Error('Could not download the pinned background-removal model');
    model=Buffer.from(await response.arrayBuffer());
    if(!valid(model))throw Error('Background-removal model checksum mismatch');
    await writeFile(file,model);
  }
  for(const name of ['ort-wasm-simd-threaded.mjs','ort-wasm-simd-threaded.wasm'])await copyFile('node_modules/onnxruntime-web/dist/'+name,'public/background-removal/'+name);
  await copyFile('docs/licensing/u2netp-LICENSE.txt','public/background-removal/LICENSE.txt');
  await copyFile('docs/licensing/background-removal.md','public/background-removal/NOTICE.md');
}
