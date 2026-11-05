import { it, expect } from 'vitest';
import {readFile} from 'node:fs/promises';
import {woff2StaticNames} from '../../vite.config.mjs';
it('removes only the audited decoder naming eval and fails closed after upstream changes',async()=>{
    const file='node_modules/wawoff2/build/decompress_binding.js',source=await readFile(file,'utf8');
    const transform=woff2StaticNames().transform;
    const result=transform(source,'/'+file)!;
    expect(source.match(/new Function/g)).toHaveLength(1);
    expect(result.code).not.toContain('new Function');
    expect(result.code).toContain('function createNamedFunction(name,body){return body}');
    expect(()=>transform(source+'\n','/'+file)).toThrow('Re-audit');
    expect(transform(source,'/other/decompress_binding.js')).toBeUndefined();
});
