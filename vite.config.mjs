import { defineConfig } from 'vite';
import {createHash} from 'node:crypto';
export const alias={};
const decoderReady=`new Promise((resolve,reject) => {
  const timer=setTimeout(()=>reject(new Error('WOFF2 decoder initialization timed out')),15000);
  const ready=()=>{clearTimeout(timer);resolve();};
  const failed=reason=>{clearTimeout(timer);reject(new Error('WOFF2 decoder initialization failed: '+String(reason)));};
  if(em_module.calledRun) {
    if(typeof em_module.decompress==='function')ready();else failed('decoder unavailable');
  } else {em_module.onRuntimeInitialized=ready;em_module.onAbort=failed;}
})`;
const staticInvoker=`function craftInvokerFunction(humanName,argTypes,classType,cppInvokerFunc,cppTargetFunc) {
  var expected=argTypes.length-2;
  if(expected<0)throwBindingError('argTypes array size mismatch');
  var method=argTypes[1]!==null&&classType!==null;
  var needsStack=argTypes.slice(1).some(function(type){return type!==null&&type.destructorFunction===undefined});
  return function() {
    if(arguments.length!==expected)throwBindingError('function '+humanName+' called with '+arguments.length+' arguments, expected '+expected);
    var destructors=needsStack?[]:null,wired=[],types=[],rv;
    try {
      if(method){wired.push(argTypes[1].toWireType(destructors,this));types.push(argTypes[1]);}
      for(var index=0;index<expected;index++){
        wired.push(argTypes[index+2].toWireType(destructors,arguments[index]));
        types.push(argTypes[index+2]);
      }
      rv=cppInvokerFunc.apply(null,[cppTargetFunc].concat(wired));
    } finally {
      if(needsStack)runDestructors(destructors);
      else for(var index=0;index<types.length;index++)if(types[index].destructorFunction!==null)types[index].destructorFunction(wired[index]);
    }
    if(argTypes[0].name!=='void')return argTypes[0].fromWireType(rv);
  };
}`;
export function woff2StaticNames() {
  return {name:'woff2-static-invokers',enforce:'pre',transform(code,id) {
    const file=id.replaceAll('\\','/');
    if(file.endsWith('/wawoff2/decompress.js')) {
      if(createHash('sha256').update(code).digest('hex')!=='f9dee5dcd810246083df4c8f09e3ae096dbecb6da61727d669b6e85006a64bef')throw Error('Re-audit the WOFF2 wrapper before changing its readiness guard');
      return {code:code.replace('new Promise(resolve => {\n  em_module.onRuntimeInitialized = resolve\n})', decoderReady),map:null};
    }
    if(!file.endsWith('/wawoff2/build/decompress_binding.js'))return;
    if(createHash('sha256').update(code).digest('hex')!=='112a89e7497a856698103e2ce530d2b6fc27668c0cd56f45bcbf7850d73b7c2b')throw Error('Re-audit the WOFF2 decoder before changing its CSP transform');
    const names=code.indexOf('function createNamedFunction(name,body){'),afterNames=code.indexOf('function extendError(',names);
    const invoker=code.indexOf('function craftInvokerFunction('),afterInvoker=code.indexOf('function ensureOverloadTable(',invoker);
    if(names<0||afterNames<0||invoker<afterNames||afterInvoker<0)throw Error('WOFF2 binding helpers were not found');
    // Replace Emscripten's dynamic binding generation with the same ABI conversions under CSP.
    return {code:code.slice(0,names)+'function createNamedFunction(name,body){return body}'+code.slice(afterNames,invoker)+staticInvoker+code.slice(afterInvoker)+';module.exports=Module;',map:null};
  }};
}
export default defineConfig({ plugins:[woff2StaticNames()], base: './', build: { target: 'es2022', rollupOptions: { input: ['index.html','document.html'] } }, server: { host: '127.0.0.1', port: 5179, strictPort: true } });
