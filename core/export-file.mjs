const types={png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',webp:'image/webp',svg:'image/svg+xml',pdf:'application/pdf'};
export function exportFileData(data){
  if(!data||typeof data.name!=='string'||data.name.length>240||/[\\/\x00-\x1f]/.test(data.name))throw Error('Invalid export filename');
  const format=data.name.split('.').at(-1).toLowerCase();
  if(types[format]!==data.mime||!(data.bytes instanceof Uint8Array)||!data.bytes.byteLength||data.bytes.byteLength>100*1024*1024)throw Error('Invalid export data');
  return {name:data.name,format,bytes:Buffer.from(data.bytes)};
}
