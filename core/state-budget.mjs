import * as Y from 'yjs';

// This bound applies only to our atomic fields-map register writes, not arbitrary
// Y.Text/Y.Array edits. A live register is a singleton ContentAny item. Replacing
// it can leave its encoded payload intact (Undo) or shrink it (GC); it cannot
// split an existing text/list payload. New payloads and deletion intervals are
// present in the transaction's actual V1 update. Merging structs/delete intervals
// can only remove payload or change count/length varuints. At most one old
// register and one appended item per write affect those headers. Each safe-
// integer V1 varuint needs at most eight bytes; 64 bytes per write plus 64 for
// the outer/client headers conservatively covers those changes. We deliberately
// do not subtract overwritten values or assume that Undo permits GC.
//
// Pending updates or other shared types use exact full-state encoding instead.
// Remote/history boundaries and checkpoint reads also reset the bound exactly.
export const STATE_BOUND_FRAMING_BYTES = 64;

export function supportsLocalMapBound(doc, keys) {
  if (doc.store.pendingStructs || doc.store.pendingDs) return false;
  const fields = doc.getMap('fields');
  for (const key of keys) {
    const item = fields._map.get(key);
    if (!item) continue;
    if (!(item instanceof Y.Item) || item.parent !== fields || item.parentSub !== key) return false;
    if (!(item.content instanceof Y.ContentAny) && !(item.deleted && item.content instanceof Y.ContentDeleted)) return false;
    if (!item.deleted && item.length !== 1) return false;
  }
  return true;
}

export function localMapStateBound(previousBytes, updateBytes, writes) {
  if (![previousBytes, updateBytes, writes].every(value => Number.isSafeInteger(value) && value >= 0)) return null;
  const bound = previousBytes + updateBytes + STATE_BOUND_FRAMING_BYTES * (writes + 1);
  return Number.isSafeInteger(bound) ? bound : null;
}

// A scratch map encodes all newly assigned values with GC disabled. For existing
// singleton registers, the live transaction adds at most one origin ID (two
// varuints), one singleton deletion interval and affected client/count headers
// per write. Reserving 256 bytes/write exceeds those safe-integer V1 fields even
// when scratch and live client identifiers have different encoded widths. The
// complete previous state remains in the bound; no old payload is subtracted.
export function scratchMapStateBound(previousBytes, scratchBytes, writes) {
  if (![previousBytes, scratchBytes, writes].every(value => Number.isSafeInteger(value) && value >= 0)) return null;
  const bound = previousBytes + scratchBytes + 256 * (writes + 1);
  return Number.isSafeInteger(bound) ? bound : null;
}

/** A complete, independent client's new map keys cannot replace, split or
 * delete any existing struct. Its V1 client block is copied unchanged into the
 * combined state, and the old delete set is unchanged. Only the outer number
 * of clients can grow (at most eight bytes for a safe-integer varuint); the
 * scratch encoding already includes its own client-count and empty-delete-set
 * headers. Sixteen extra bytes conservatively cover all outer framing.
 *
 * Prove these restrictions from the actual docs, not caller-supplied counts.
 * Pending causal data, another root/shared type, used keys, client collisions,
 * or deleted/split items require the ordinary full-state preflight instead.
 */
export function independentMapStateBound(live, scratch, previousBytes, scratchBytes) {
  if (![previousBytes,scratchBytes].every(value=>Number.isSafeInteger(value)&&value>=0)) return null;
  if(live.store.pendingStructs||live.store.pendingDs||scratch.store.pendingStructs||scratch.store.pendingDs||scratch.store.clients.size!==1||scratch.share.size!==1)return null;
  const [[client,structs]]=scratch.store.clients,fields=scratch.share.get('fields'),current=live.getMap('fields');
  if(!(fields instanceof Y.Map)||live.clientID===client||live.store.clients.has(client)||!structs.length)return null;
  let clock=0;
  for(const item of structs){
    if(!(item instanceof Y.Item)||item.id.client!==client||item.id.clock!==clock||item.deleted||item.length!==1||item.origin||item.rightOrigin||item.parent!==fields||typeof item.parentSub!=='string'||!(item.content instanceof Y.ContentAny)||current._map.has(item.parentSub))return null;
    clock++;
  }
  const bound=previousBytes+scratchBytes+16;
  return Number.isSafeInteger(bound)?bound:null;
}
