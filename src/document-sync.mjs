const error=(code,message)=>Object.assign(Error(message),{code});

export const commitErrorMessage=value=>String(value?.message??value).replace(/\[commit_(?:retry|rejected)\]\s*/g,'');
export function permanentCommitFailure(value){
  const message=String(value?.message??value);
  if(value?.code==='commit_retry'||/\[commit_retry\]|\[sequence_gap\]/.test(message))return false;
  return value?.code==='commit_rejected'||/\[commit_rejected\]/.test(message);
}

/** Invoke only from the renderer's serial queue. Retrying a later edit first
 * drains every earlier pending slot, including accepted writes awaiting fsync.
 */
export async function drainPendingCommits({getProjection,commit,project,refresh,onRejected=()=>{},onFailure=()=>{}},through=Infinity){
  for(;;){
    const projection=getProjection();
    const item=projection.pending.filter(item=>item.seq<=through).sort((a,b)=>a.seq-b.seq)[0];
    if(!item)return;
    let acknowledgment;
    try{acknowledgment=await commit(item);}
    catch(failure){
      onFailure(failure);
      if(!permanentCommitFailure(failure))throw failure;
      // Consuming a rejected slot is an explicit host operation. If the host
      // already accepted the original write, discard=false preserves it and
      // the same call retries durability before returning its acknowledgment.
      acknowledgment=await commit({seq:item.seq,changes:[],discard:true});
      if(acknowledgment.discarded===true){projection.reject(item.seq);onRejected(item.seq,failure);}
      await project(acknowledgment);
      await refresh(acknowledgment.revision);
      if(getProjection().pending.some(p=>p.seq===item.seq))throw error('commit_unacknowledged','The rejected edit was not resolved by the document host');
      continue;
    }
    await project(acknowledgment);
    if(getProjection().pending.some(p=>p.seq===item.seq))throw error('commit_unacknowledged','The edit is still waiting for durable acknowledgment');
  }
}

export function createDocumentWriteQueue({drain,wait,flush,invokeHistory,project}){
  let work=Promise.resolve();
  const enqueue=operation=>{const task=work.then(operation);work=task.catch(()=>{});return task;};
  return {
    commit:through=>enqueue(()=>drain(through)),
    flush:through=>enqueue(async()=>{await drain(through);await wait();await flush();}),
    history:(action,args,through,signal)=>enqueue(async()=>{
      signal?.throwIfAborted();await drain(through);await wait();signal?.throwIfAborted();
      const snapshot=await invokeHistory(action,args);if(snapshot)await project(snapshot);return !!snapshot;
    }),
  };
}

/** A delta arriving during an in-flight snapshot can raise the missing revision.
 * Keep fetching until that highest revision is present; never lose the newer
 * resync request behind an older shared Promise. Forced refreshes also require
 * a request started after the force call, even when revisions are unchanged.
 */
export function createSnapshotResync({snapshot,accept,getRevision,maxAttempts=8}){
  let target=-1,forced=0,completed=0,running=null;
  const note=revision=>{
    if(!Number.isSafeInteger(revision)||revision<0)throw error('invalid_revision','Invalid resynchronization revision');
    target=Math.max(target,revision);
  };
  const request=(revision=getRevision(),{force=false}={})=>{
    note(revision);if(force)forced++;
    if(!running&&(getRevision()<target||completed<forced)){
      let attempts=0;
      const start=()=>{
        const task=(async()=>{
          while(getRevision()<target||completed<forced){
            if(attempts++>=maxAttempts)throw error('resync_required',`Canvas synchronization did not reach revision ${target}; retry after the canvas settles`);
            const forceAtStart=forced,value=await snapshot();
            if(!value?.document)throw error('invalid_snapshot','The document host did not return a complete snapshot');
            await accept(value);completed=Math.max(completed,forceAtStart);
          }
        })();
        running=task.then(()=>{
          running=null;
          // A delta can arrive in the microtask between loop completion and
          // clearing the shared Promise. Include that request in this result.
          if(getRevision()<target||completed<forced)return start();
        },failure=>{running=null;throw failure;});
        return running;
      };
      start();
    }
    return running??Promise.resolve();
  };
  return {request,note,wait:()=>request(Math.max(target,getRevision())),get target(){return target;},get pending(){return running;}};
}
