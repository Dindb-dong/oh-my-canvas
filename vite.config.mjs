import { defineConfig } from 'vite';
import {createHash} from 'node:crypto';
export const alias={};
export function woff2StaticNames() {
  return {name:'woff2-static-function-names',enforce:'pre',transform(code,id) {
    if(!id.replaceAll('\\','/').endsWith('/wawoff2/build/decompress_binding.js'))return;
    if(createHash('sha256').update(code).digest('hex')!=='112a89e7497a856698103e2ce530d2b6fc27668c0cd56f45bcbf7850d73b7c2b')throw Error('Re-audit the WOFF2 decoder before changing its CSP transform');
    const start=code.indexOf('function createNamedFunction(name,body){'),end=code.indexOf('function extendError(',start);
    if(start<0||end<0)throw Error('WOFF2 naming helper was not found');
    // Emscripten only uses generated names for debugging; keep the callable without runtime eval.
    return {code:code.slice(0,start)+'function createNamedFunction(name,body){return body}'+code.slice(end),map:null};
  }};
}
export default defineConfig({ plugins:[woff2StaticNames()], base: './', build: { target: 'es2022' }, server: { host: '127.0.0.1', port: 5179, strictPort: true } });
