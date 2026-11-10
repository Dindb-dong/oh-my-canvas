// Storage, source decoding, and a single network envelope are independent budgets.
// Large imported libraries opt into more geometry without widening the wire limit.
export const MAX_DOCUMENT_BYTES=16*1024*1024;
export const MAX_STATE_BYTES=16*1024*1024;
export const MAX_LARGE_STATE_BYTES=256*1024*1024;
export const MAX_LARGE_BYTES=MAX_LARGE_STATE_BYTES;
export const MAX_ENVELOPE_BYTES=24*1024*1024;
export const MAX_PORTABLE_BYTES=384*1024*1024;
export const MAX_DESIGN_INPUT_BYTES=256*1024*1024;
export const MAX_DESIGN_EXPANDED_BYTES=512*1024*1024;
export const DESIGN_FILE_LIMIT=MAX_DESIGN_INPUT_BYTES;
export function documentLimits(doc){
  const large=doc?.capacity==='large'||doc?.capacityProfile==='large-library';
  const bytes=large?MAX_LARGE_STATE_BYTES:MAX_DOCUMENT_BYTES,objects=large?100000:20000;
  return {documentBytes:bytes,stateBytes:bytes,objects,pages:100,bytes,shapes:objects};
}
