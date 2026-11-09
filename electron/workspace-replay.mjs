// Workspace replies survive editor replacement; retries are limited to this live agent session.
export function createWorkspaceReplay() {
  const cache=new Map();let bytes=0;
  const remove=key=>{bytes-=cache.get(key).bytes;cache.delete(key);};
  const trim=()=>{while(cache.size>100||bytes>1024*1024)remove(cache.keys().next().value);};
  return {
    run(agent,key,name,args,task) {
      if(key===undefined)return task();
      if(typeof key!=='string'||!key||key.length>200)throw Error('Invalid idempotency key');
      const id=agent+'\0'+key,signature=JSON.stringify({name,args:Object.fromEntries(Object.entries(args).sort(([a],[b])=>a.localeCompare(b)))});
      const previous=cache.get(id);
      if(previous){if(previous.signature!==signature)throw Error('Invalid idempotency key: already used for a different request');return previous.result;}
      const entry={signature,bytes:signature.length*2,result:Promise.resolve().then(task)};
      cache.set(id,entry);bytes+=entry.bytes;trim();
      void entry.result.then(result=>{if(cache.get(id)!==entry)return;const size=JSON.stringify(result).length*2;entry.bytes+=size;bytes+=size;trim();},()=>{});
      return entry.result;
    },
    end(agent) {for(const key of cache.keys())if(!agent||key.startsWith(agent+'\0'))remove(key);}
  };
}
