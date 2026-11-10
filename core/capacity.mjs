// Ordinary canvases retain their existing budget; imported libraries opt into bounded large storage.
export const MAX_DOCUMENT_BYTES=16*1024*1024;
export const MAX_STATE_BYTES=16*1024*1024;
export const MAX_LARGE_BYTES=256*1024*1024;
export const MAX_ENVELOPE_BYTES=384*1024*1024;
export const DESIGN_FILE_LIMIT=256*1024*1024;
export function documentLimits(doc){return doc?.capacity==='large'?{bytes:MAX_LARGE_BYTES,shapes:100000}:{bytes:MAX_DOCUMENT_BYTES,shapes:20000};}
