// Document validation must still visit mutable/untrusted trees in full. Only
// immutable strings are shared here; never cache a document's validation proof.
const encoder=new TextEncoder(),strings=new Map();
const MAX_STRINGS=4096,MAX_STRING_LENGTH=128;

export const utf8Bytes=value=>encoder.encode(value).byteLength;

/** Exact quoted JSON string size. Bounded admission avoids retaining large
 * names, image payloads or an unbounded collection of document-controlled keys.
 * Property names and short scalar strings use the same immutable value cache.
 */
export function jsonStringBytes(value){
  if(value.length>MAX_STRING_LENGTH)return utf8Bytes(JSON.stringify(value));
  const cached=strings.get(value);
  if(cached!==undefined)return cached;
  const bytes=utf8Bytes(JSON.stringify(value));
  if(strings.size===MAX_STRINGS)strings.delete(strings.keys().next().value);
  strings.set(value,bytes);
  return bytes;
}

/** JSON uses the ordinary decimal number representation (including -0 -> 0)
 * and ASCII literals. Avoid allocating tiny UTF-8 arrays for each such value.
 * Less common primitives retain native JSON behavior, including BigInt errors.
 */
export function jsonPrimitiveBytes(value){
  if(value===null)return 4;
  if(typeof value==='string')return jsonStringBytes(value);
  if(typeof value==='boolean')return value?4:5;
  if(typeof value==='number')return Number.isFinite(value)?String(value).length:4;
  const encoded=JSON.stringify(value);
  return encoded===undefined?undefined:utf8Bytes(encoded);
}
