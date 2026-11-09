export function canvasTitle(title) {
  if(typeof title!=='string'||!title.trim()||title.trim().length>120)throw Error('Invalid canvas title: use 1–120 characters');
  return title.trim();
}

export async function renameDocument(store,current,id,title) {
  title=canvasTitle(title);
  const record=current?.id===id?current:await store.load(id);
  try {
    await store.save({...record,title});
    record.title=title;
    record.recovered=false;
    return {id:record.id,title};
  } finally {
    if(record!==current)record.replica.destroy();
  }
}

export function createDocumentWriter(store) {
  let work=Promise.resolve();
  // Defer serialization until earlier renames have published their persisted title.
  const enqueue=task=>{const result=work.then(task);work=result.catch(()=>{});return result;};
  return {
    save:record=>enqueue(()=>store.save(record)),
    rename:(current,id,title)=>enqueue(()=>renameDocument(store,current,id,title))
  };
}
