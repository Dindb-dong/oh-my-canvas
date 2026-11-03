import {test} from 'node:test';import assert from 'node:assert/strict';import {exportFileData} from '../core/export-file.mjs';
test('native export accepts supported bytes and rejects paths, MIME mismatches and empty payloads',()=>{
 for(const [ext,mime] of Object.entries({svg:'image/svg+xml',png:'image/png',jpg:'image/jpeg',webp:'image/webp',pdf:'application/pdf'}))assert.deepEqual(exportFileData({name:`Canvas.${ext}`,mime,bytes:new Uint8Array([1,2])}).bytes,Buffer.from([1,2]));
 for(const data of [{name:'../x.svg',mime:'image/svg+xml',bytes:new Uint8Array([1])},{name:'x.exe',mime:'application/x-msdownload',bytes:new Uint8Array([1])},{name:'x.svg',mime:'image/png',bytes:new Uint8Array([1])},{name:'x.svg',mime:'image/svg+xml',bytes:new Uint8Array()}])assert.throws(()=>exportFileData(data));
});
