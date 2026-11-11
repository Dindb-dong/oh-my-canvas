import {assertDocument,assertDocumentChanges} from './document.mjs';

const catalogs=['assets','components','styles','libraries'];
const own=(value,key)=>Object.prototype.hasOwnProperty.call(value??{},key);

/** A real subset of pages, never placeholder roots for data not loaded yet. */
export function pageProjection(document,pageIds){
  const wanted=new Set(pageIds),pages=document.pages.filter(id=>wanted.has(id));
  if(!pages.length)throw Error('A page projection needs a real page');
  if(pages.length===document.pages.length)return document;
  return {...document,pages,pagesById:Object.fromEntries(pages.map(id=>[id,document.pagesById[id]]))};
}

/** Add complete, previously unpublished pages without replacing any live page
 * or catalog definition. Pending local edits are subsequently rebased by the
 * normal revision/ACK contract. The host supplies only newly required catalogs.
 */
export function mergePageDocuments(before,batch,{order}={}){
  assertDocument(batch);
  const seen=new Set(before.pages);
  for(const id of batch.pages){
    if(seen.has(id)||own(before.pagesById,id))throw Error('A loading batch cannot replace an existing page');
    seen.add(id);
  }
  const pages=order??[...before.pages,...batch.pages];
  if(pages.length!==seen.size||new Set(pages).size!==pages.length||pages.some(id=>!seen.has(id)))throw Error('Invalid loaded page order');
  const document={...before,pages,pagesById:{...before.pagesById,...Object.fromEntries(batch.pages.map(id=>[id,batch.pagesById[id]]))}};
  for(const key of catalogs){
    const additions=Object.entries(batch[key]??{}).filter(([id])=>!own(before[key],id));
    if(additions.length)document[key]={...before[key],...Object.fromEntries(additions)};
  }
  return assertDocumentChanges(before,document);
}

/** While a subset is visible, edits stay inside its loaded page namespaces.
 * Cross-page topology and existing shared-definition changes require the full
 * document so an unseen dependency cannot be accidentally removed.
 */
export function assertLoadedPageChanges(document,changes){
  const pages=new Set(document.pages);
  for(const [key,value] of changes){
    const p=JSON.parse(key);
    if(p[0]==='page'){
      if(!pages.has(p[1])||['alive','order','id','objects'].includes(p[2]))throw Error('Wait for all pages before changing the page list');
    }else if(p[0]==='shape'||p[0]==='geometry'){
      if(!pages.has(p[1]))throw Error('This page is still loading');
    }else if(catalogs.includes(p[0])){
      if(value==null||own(document[p[0]],p[1]))throw Error('Wait for all pages before changing shared definitions');
    }else if(p[0]==='meta')throw Error('Wait for all pages before changing document settings');
  }
}
