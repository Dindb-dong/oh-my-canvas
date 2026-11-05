import * as ort from 'onnxruntime-web/wasm';
import {imageTensor,maskPixels} from './mask';

const scope=self as unknown as {onmessage:(event:MessageEvent<{pixels:Uint8ClampedArray;base:string}>)=>Promise<void>;postMessage:(message:unknown,transfer?:Transferable[])=>void};
scope.onmessage=async(event)=>{
    let session:ort.InferenceSession|undefined;
    try {
        ort.env.wasm.numThreads=1;
        ort.env.wasm.proxy=false;
        ort.env.wasm.wasmPaths=event.data.base;
        session=await ort.InferenceSession.create(new URL('u2netp.onnx',event.data.base).href,{executionProviders:['wasm']});
        const input=new ort.Tensor('float32',imageTensor(event.data.pixels),[1,3,320,320]);
        try {
            const output=await session.run({[session.inputNames[0]]:input});
            try {const pixels=maskPixels(output[session.outputNames[0]].data as Float32Array);scope.postMessage({pixels},[pixels.buffer as ArrayBuffer]);}
            finally {for(const tensor of Object.values(output))tensor.dispose();}
        } finally {input.dispose();}
    } catch(error) {scope.postMessage({error:error instanceof Error?error.message:String(error)});}
    finally {await session?.release();}
};
