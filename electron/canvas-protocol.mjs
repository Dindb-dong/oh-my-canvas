import {promises as fs} from 'node:fs';
import path from 'node:path';
import {assetResponse} from './document-assets.mjs';

const mime={'.html':'text/html','.js':'application/javascript','.mjs':'application/javascript','.css':'text/css','.wasm':'application/wasm','.woff2':'font/woff2','.png':'image/png','.svg':'image/svg+xml','.json':'application/json'};
const policy="default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data: blob:; connect-src 'self' data: blob:; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-src 'none'";

export function createCanvasProtocolHandler({directory,assets}){
  const base=path.resolve(directory);
  return async request=>{
    const url=new URL(request.url);if(url.hostname!=='canvas')return new Response('Not found',{status:404});
    let name;try{name=decodeURIComponent(url.pathname);}catch{return new Response('Invalid path',{status:400});}
    // Vite also emits application JS, CSS and fonts under /assets/. Only exact
    // content-addressed image paths belong to the document blob store.
    const image=/^\/assets\/([a-f0-9]{64})$/.exec(name);
    if(image)return assetResponse(assets,image[1]);
    const file=path.resolve(base,'.'+name);if(!file.startsWith(base+path.sep))return new Response('Forbidden',{status:403});
    try{return new Response(await fs.readFile(file),{headers:{'Content-Type':mime[path.extname(file)]||'application/octet-stream','Content-Security-Policy':policy}});}catch{return new Response('Not found',{status:404});}
  };
}
