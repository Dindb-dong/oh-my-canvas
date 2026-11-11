/** Import owns new namespaces only. A separate Yjs client lets a large complete
 * page enter atomically without the ordinary small-edit field-count limit.
 * Replica derives and validates the canonical addition; there is no caller-
 * supplied bypass flag and untrusted CRDT updates retain Replica.receive.
 */
export function appendImportedPages(replica,batch){
  return replica.appendNewPages(batch);
}
