const failure=(code,message)=>Object.assign(Error(`[${code}] ${message}`),{code});
const knownInputFailure=error=>{
  if(error?.code)return ['bad_args','invalid_document','document_limit'].includes(error.code);
  if(error instanceof SyntaxError)return true;
  return /Invalid (?:patch|base64)|Non-canonical base64|Asset exceeds|Unsupported external asset MIME type|Cyclic document asset data/i.test(error?.message??'');
};
const retry=error=>failure('commit_retry',error?.message??String(error));
const rejected=error=>failure('commit_rejected',error?.message??String(error));

/** Called inside the document manager's serialized entry-operation queue.
 * acceptedSeq means applied (or explicitly discarded); seq means durable.
 * No later request may skip a slot whose validation/asset preparation failed.
 */
export async function commitDocument(entry,data,{store,save,confirmGeneration,acknowledgment}){
  const seq=data?.seq,generation=entry.generation;
  if(!Number.isSafeInteger(seq)||seq<1)throw rejected(Error('Invalid edit sequence'));
  if(data.discard!==undefined&&typeof data.discard!=='boolean')throw rejected(Error('Invalid edit discard flag'));
  if(data.discard&&(!Array.isArray(data.changes)||data.changes.length))throw rejected(Error('Discard requires an empty edit'));
  const accepted=entry.acceptedSeq??entry.seq??0;
  if(seq>accepted+1)throw failure('sequence_gap',`Edit sequence ${accepted+1} must be resolved before ${seq}`);
  let discarded=false;
  if(seq===accepted+1){
    if(data.discard){entry.acceptedSeq=seq;discarded=true;}
    else{
      let changes;
      try{changes=await store.prepareChanges(data.changes);}
      catch(error){throw knownInputFailure(error)?rejected(error):retry(error);}
      confirmGeneration(entry,generation);
      entry.committingSeq=seq;
      try{entry.record.replica.patch(changes,data.label,data.group);entry.acceptedSeq=seq;}
      catch(error){
        // A listener can fail after publication. Such an accepted write must
        // retain its slot and retry durability, never be treated as rejected.
        if(entry.acceptedSeq>=seq)throw retry(error);
        throw /Invalid|exceeds?|too large|limit|geometry|unsupported|cyclic|negative/i.test(error?.message??'')?rejected(error):retry(error);
      }
      finally{delete entry.committingSeq;}
    }
  }
  // Even duplicates retry fsync. A prior accepted request can have lost its ACK
  // or failed while saving; a discard retry must not erase that original edit.
  const durable=entry.acceptedSeq??accepted;
  try{await save(entry);}
  catch(error){throw retry(error);}
  confirmGeneration(entry,generation);
  entry.seq=Math.max(entry.seq??0,durable);
  return {...acknowledgment(entry),...(data.discard?{discarded}:{})};
}
