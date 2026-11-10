import {geometricField,geometryEntries,restoreGeometry} from './geometry.mjs';
import {jsonPrimitiveBytes,jsonStringBytes,utf8Bytes} from './json-bytes.mjs';
// Shared pure model adapter. Shape properties merge separately; containment is repaired
// deterministically so concurrent insert/move/delete never leaves dangling child lists.
export const ROOT = 'root';
import {documentLimits} from './capacity.mjs';
export {documentLimits,MAX_DOCUMENT_BYTES,MAX_STATE_BYTES,MAX_ENVELOPE_BYTES,MAX_LARGE_STATE_BYTES,MAX_PORTABLE_BYTES,MAX_DESIGN_INPUT_BYTES,MAX_DESIGN_EXPANDED_BYTES} from './capacity.mjs';
const blocked = new Set(['__proto__', 'constructor', 'prototype']);
const validatedDocuments = new WeakSet(), objectCounts = new WeakMap(), jsonSizes = new WeakMap();
// Exact JSON UTF-8 size, including escapes, punctuation, omitted properties and
// array nulls. Only immutable, previously validated branches reuse cached sizes.
function jsonBytes(value,reuse=false,name='',stack=new Set()){
  if(value&&typeof value.toJSON==='function'){
    const encoded=JSON.stringify({[name]:value});
    return encoded==='{}'?undefined:utf8Bytes(encoded)-jsonStringBytes(name)-3;
  }
  if(value===null||typeof value!=='object'){
    return jsonPrimitiveBytes(value);
  }
  const proto=Object.getPrototypeOf(value);
  if(!Array.isArray(value)&&proto!==Object.prototype&&proto!==null){
    const encoded=JSON.stringify({[name]:value});return encoded==='{}'?undefined:utf8Bytes(encoded)-jsonStringBytes(name)-3;
  }
  if(reuse&&jsonSizes.has(value))return jsonSizes.get(value);
  if(stack.has(value))throw Error('Cyclic document value');stack.add(value);
  let bytes=2,count=0;
  if(Array.isArray(value))for(let i=0;i<value.length;i++){
    const size=jsonBytes(value[i],reuse,String(i),stack);bytes+=(size??4)+(count++?1:0);
  }else for(const [k,v] of Object.entries(value)){
    const size=jsonBytes(v,reuse,k,stack);if(size===undefined)continue;
    bytes+=jsonStringBytes(k)+1+size+(count++?1:0);
  }
  stack.delete(value);jsonSizes.set(value,bytes);return bytes;
}
export const same = (a, b) => a === b || JSON.stringify(a) === JSON.stringify(b);
const key = (...parts) => JSON.stringify(parts);

export function flatten(doc) {
  const out = new Map();
  for (const [field, value] of Object.entries(doc)) {
    if (field === 'pages' || field === 'pagesById' || value === undefined) continue;
    if (['components', 'styles', 'libraries', 'assets'].includes(field)) {
      for (const [id, item] of Object.entries(value || {})) out.set(key(field, id), item);
    } else out.set(key('meta', field), value);
  }
  doc.pages.forEach((pid, index) => {
    const page = doc.pagesById[pid];
    if (!page) return;
    out.set(key('page', pid, 'alive'), true);
    out.set(key('page', pid, 'order'), index);
    for (const [field, value] of Object.entries(page)) {
      if (field !== 'objects' && value !== undefined) out.set(key('page', pid, field), value);
    }
    for (const [id, shape] of Object.entries(page.objects)) {
      out.set(key('shape', pid, id, 'alive'), true);
      for (const [field, value] of Object.entries(shape)) {
        if (field !== 'childIds' && field !== 'enclosingFrameId' && !geometricField(shape,field) && value !== undefined) out.set(key('shape', pid, id, field), value);
      }
      for(const [field,value] of geometryEntries(shape))out.set(key('geometry',pid,id,field),value);
      if (shape.childIds) shape.childIds.forEach((child, order) => out.set(key('shape', pid, child, 'order'), order));
    }
  });
  return out;
}

export function changesBetween(before, after) {
  // Editor documents are immutable: unchanged shape references cannot contain edits.
  // Diff only changed entities, while retaining complete sibling ranks and page order.
  const view = (doc, other) => {
    const result={pages:doc.pages,pagesById:{}},otherPages=new Set(other.pages);
    for(const [field,value] of Object.entries(doc))if(field!=='pages'&&field!=='pagesById'&&value!==other[field])result[field]=value;
    for(const pid of doc.pages){
      const page=doc.pagesById[pid],old=otherPages.has(pid)?other.pagesById[pid]:undefined;if(!page)continue;
      if(page===old&&doc.pages===other.pages)continue;
      const objects={};for(const [id,shape] of Object.entries(page.objects))if(shape!==old?.objects[id])objects[id]=shape;
      result.pagesById[pid]={...page,objects};
    }
    return result;
  };
  const a = flatten(view(before,after)), b = flatten(view(after,before)), changes = [];
  for (const [k, v] of b) if (!same(a.get(k), v)) changes.push([k, v]);
  for (const k of a.keys()) if (!b.has(k)) {
    const p = JSON.parse(k);
    // A stale edit cannot resurrect a concurrently deleted entity.
    // Preserve tombstoned properties for undo and the deterministic last-page root.
    const entityAlive=p[0]==='page'?key('page',p[1],'alive'):['shape','geometry'].includes(p[0])?key('shape',p[1],p[2],'alive'):null;
    if(entityAlive&&!b.has(entityAlive)&&p.at(-1)!=='alive')continue;
    changes.push([k, p.at(-1) === 'alive' ? false : null]);
  }
  return changes;
}

export function materialize(entries) {
  const pages = new Map(), shapes = new Map(), geometry = new Map(), doc = { pages: [], pagesById: {} };
  const entityEntries = new Map();
  for (const [k, value] of entries) {
    const p = JSON.parse(k);
    if (p.some(x => blocked.has(x))) continue;
    if(['components','styles','libraries','assets'].includes(p[0])){
      if(!entityEntries.has(p[0]))entityEntries.set(p[0],new Map());
      entityEntries.get(p[0]).set(p[1],value);continue;
    }
    if (value === null || value === undefined) continue;
    if (p[0] === 'meta') doc[p[1]] = value;
    else if (p[0] === 'page') {
      const page = pages.get(p[1]) ?? {};
      page[p[2]] = value; pages.set(p[1], page);
    } else if(p[0]==='geometry'){
      const sk=key(p[1],p[2]),g=geometry.get(sk)??{};g[p[3]]=value;geometry.set(sk,g);
    } else if (p[0] === 'shape') {
      const bucket = shapes.get(p[1]) ?? new Map(), shape = bucket.get(p[2]) ?? {};
      shape[p[3]] = value; bucket.set(p[2], shape); shapes.set(p[1], bucket);
    }
  }
  for(const [field,entries] of entityEntries){
    // Read legacy entity maps held in one meta register. Individual entries and
    // tombstones win independently of Y.Map insertion/merge iteration order.
    doc[field]={...doc[field]};
    for(const [id,value] of entries)if(value==null)delete doc[field][id];else doc[field][id]=value;
  }
  const ordered = [...pages].filter(([, p]) => p.alive).sort((a, b) => a[1].order - b[1].order || (a[0]<b[0]?-1:a[0]>b[0]?1:0));
  // Independent valid deletions (or Undo after a remote deletion) can remove every
  // page. Project the lexically first historical page as a blank, editable canvas.
  // Only its root is restored; deliberately deleted content stays deleted.
  const recovery=!ordered.length&&pages.size?[...pages].sort((a,b)=>a[0]<b[0]?-1:a[0]>b[0]?1:0)[0]:null;
  if(recovery)ordered.push(recovery);
  for (const [pid, raw] of ordered) {
    const { alive, order, ...page } = raw;
    page.id = pid; page.objects = {};
    const ranks = new Map();
    for (const [id, shape] of shapes.get(pid) ?? []) {
      if (!shape.alive && !(recovery&&id===ROOT)) continue;
      const { alive: _, order: rank, ...s } = shape;
      s.id = id;
      restoreGeometry(s,geometry.get(key(pid,id)));
      if (['frame', 'group', 'boolean'].includes(s.type)) s.childIds = [];
      page.objects[id] = s; ranks.set(id, rank ?? 0);
    }
    const root = page.objects[ROOT];
    if (!root) continue;
    root.parentId = ROOT; root.enclosingFrameId = ROOT;
    const ids = Object.keys(page.objects).sort();
    for (const id of ids) {
      if (id === ROOT) continue;
      const s = page.objects[id], seen = new Set([id]);
      let parent = s.parentId, invalid = false;
      while (parent !== ROOT) {
        const p = page.objects[parent];
        if (!p?.childIds || seen.has(parent)) { invalid = true; break; }
        seen.add(parent); parent = p.parentId;
      }
      if (invalid || !page.objects[s.parentId]?.childIds) s.parentId = ROOT;
    }
    // Build child lists from parent links, never from an LWW array.
    for (const id of ids) {
      if (id === ROOT) continue;
      const s = page.objects[id];
      page.objects[s.parentId].childIds.push(id);
      let parent = page.objects[s.parentId];
      while (parent.id !== ROOT && parent.type !== 'frame') parent = page.objects[parent.parentId];
      s.enclosingFrameId = parent.id;
    }
    for (const s of Object.values(page.objects)) s.childIds?.sort((a, b) => ranks.get(a) - ranks.get(b) || (a<b?-1:a>b?1:0));
    doc.pages.push(pid); doc.pagesById[pid] = page;
  }
  return doc;
}

/** Translate the editor's detached path journal into canonical CRDT fields. The
 * editor already knows which entities changed; do not discover them a second
 * time by walking every page and shape. Canonical geometry and sibling ranks
 * still flow through flatten, exactly as in the full diff. */
export function changesFromPatches(before,after,patches) {
  if(!Array.isArray(patches))return changesBetween(before,after);
  const pages=new Map(),metadata=new Set(),entities=new Map();let pageOrder=false;
  for(const patch of patches){
    const p=patch?.path;if(!Array.isArray(p)||!p.length)return changesBetween(before,after);
    if(p.some(x=>typeof x!=='string'||blocked.has(x)))throw Error('Invalid editor patch path');
    if(p[0]==='pages'){pageOrder=true;continue;}
    if(p[0]==='pagesById'){
      if(p.length<2)return changesBetween(before,after);
      const pid=p[1];
      if(p.length<4||p[2]!=='objects')pages.set(pid,null);
      else if(!pages.has(pid))pages.set(pid,new Set([p[3]]));
      else pages.get(pid)?.add(p[3]);
    }else if(['components','styles','libraries','assets'].includes(p[0])&&p.length>1){
      if(!entities.has(p[0]))entities.set(p[0],new Set());entities.get(p[0]).add(p[1]);
    }else metadata.add(p[0]);
  }
  if(pageOrder)for(const pid of new Set([...before.pages,...after.pages]))if(!pages.has(pid))pages.set(pid,new Set());
  const beforePages=new Set(before.pages),afterPages=new Set(after.pages);
  const view=doc=>{
    const result={pages:doc.pages,pagesById:{}};
    for(const field of metadata)if(Object.hasOwn(doc,field))result[field]=doc[field];
    for(const [field,ids] of entities)if(!metadata.has(field)){
      const values={};for(const id of ids)if(Object.hasOwn(doc[field]??{},id))values[id]=doc[field][id];result[field]=values;
    }
    for(const [pid,ids] of pages){
      const page=doc.pagesById[pid];if(!page)continue;
      // Metadata patches cannot alter shape data. A newly created/deleted page
      // needs its complete graph, while an existing page-name edit needs none.
      const old=beforePages.has(pid)?before.pagesById[pid]:undefined,next=afterPages.has(pid)?after.pagesById[pid]:undefined;
      let objects={};
      if(!old||!next)objects=page.objects;
      else if(ids===null){
        if(old.objects!==next.objects)objects=page.objects;
      }else for(const id of ids)if(Object.hasOwn(page.objects,id))objects[id]=page.objects[id];
      result.pagesById[pid]={...page,objects};
    }
    return result;
  };
  const a=flatten(view(before)),b=flatten(view(after)),out=[];
  for(const [k,v] of b)if(!same(a.get(k),v))out.push([k,v]);
  for(const k of a.keys())if(!b.has(k)){
    const p=JSON.parse(k),alive=p[0]==='page'?key('page',p[1],'alive'):['shape','geometry'].includes(p[0])?key('shape',p[1],p[2],'alive'):null;
    if(alive&&!b.has(alive)&&p.at(-1)!=='alive')continue;
    out.push([k,p.at(-1)==='alive'?false:null]);
  }
  return out;
}

export function fieldParts(k){
  if(typeof k!=='string'||k.length>10000)throw Error('Invalid field key');
  const p=JSON.parse(k);
  if(!Array.isArray(p)||p.some(x=>typeof x!=='string'||!x||blocked.has(x)))throw Error('Invalid field key');
  const n=p[0]==='meta'||['components','styles','libraries','assets'].includes(p[0])?2:p[0]==='page'?3:['shape','geometry'].includes(p[0])?4:0;
  if(!n||p.length!==n)throw Error('Invalid field key');return p;
}

/** Apply a validated field delta to an immutable projection. Scalar edits retain
 * every unrelated page/shape. Topology changes use the canonical containment
 * repair so remote deletion/reparent/reorder behavior stays deterministic. */
export function projectChanges(before,changes){
  if(!changes.length)return before;
  const decoded=changes.map(row=>{
    if(!Array.isArray(row)||row.length!==2)throw Error('Invalid field change');
    return [fieldParts(row[0]),row[1]];
  });
  if(decoded.some(([p])=>p[0]==='page'&&['alive','order','id','objects'].includes(p[2])||p[0]==='shape'&&['alive','order','parentId','type','id','childIds','enclosingFrameId'].includes(p[3])||p[0]==='meta'&&['pages','pagesById','assets','components','styles','libraries'].includes(p[1]))){
    const fields=flatten(before);for(const [k,v] of changes)fields.set(k,v);return materialize(fields);
  }
  const next={...before},copiedPages=new Set(),copiedObjects=new Set(),copiedMaps=new Set(),shapeEdits=new Map();
  const getPage=pid=>{
    if(!before.pagesById[pid])return null;
    if(!copiedPages.has(pid)){
      if(!copiedPages.size)next.pagesById={...before.pagesById};
      next.pagesById[pid]={...before.pagesById[pid]};copiedPages.add(pid);
    }return next.pagesById[pid];
  };
  for(const [p,value] of decoded){
    if(p[0]==='meta'){
      if(value==null)delete next[p[1]];else next[p[1]]=value;
    }else if(['components','styles','libraries','assets'].includes(p[0])){
      if(!copiedMaps.has(p[0])){next[p[0]]={...before[p[0]]};copiedMaps.add(p[0]);}
      if(value==null)delete next[p[0]][p[1]];else next[p[0]][p[1]]=value;
    }else if(p[0]==='page'){
      const page=getPage(p[1]);if(page){if(value==null)delete page[p[2]];else page[p[2]]=value;}
    }else{
      const source=before.pagesById[p[1]]?.objects[p[2]];if(!source)continue;
      const sk=key(p[1],p[2]);let edit=shapeEdits.get(sk);
      if(!edit){
        const page=getPage(p[1]);if(!copiedObjects.has(p[1])){page.objects={...page.objects};copiedObjects.add(p[1]);}
        edit={shape:{...source},geometry:Object.fromEntries(geometryEntries(source))};page.objects[p[2]]=edit.shape;shapeEdits.set(sk,edit);
      }
      const target=p[0]==='geometry'?edit.geometry:edit.shape;
      if(value==null)delete target[p[3]];else target[p[3]]=value;
    }
  }
  for(const edit of shapeEdits.values())restoreGeometry(edit.shape,edit.geometry);
  return next;
}

export function applyPending(doc, patches) {
  if(!patches.length)return doc;
  return projectChanges(doc,patches.flat());
}

export function assertDocument(doc) {
  const limits=documentLimits(doc);
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.pages) || !doc.pages.length || doc.pages.length > limits.pages || !doc.pagesById) throw Error('Invalid document: pages are required');
  let count = 0;
  for (const pid of doc.pages) {
    if (typeof pid !== 'string' || blocked.has(pid)) throw Error('Invalid page ID');
    const page = doc.pagesById[pid];
    if (!page?.objects?.[ROOT] || page.objects[ROOT].type !== 'frame') throw Error('Invalid document root');
    for (const [id, s] of Object.entries(page.objects)) {
      if (++count > limits.objects || blocked.has(id) || !s || s.id !== id || !['frame','group','boolean','rect','ellipse','path','text','image','svg'].includes(s.type)) throw Error('Invalid or oversized shape graph');
      for (const n of ['x','y','width','height']) if (s[n] !== undefined && (!Number.isFinite(s[n]) || Math.abs(s[n]) > 1e8)) throw Error('Invalid geometry');
    }
    objectCounts.set(page.objects,Object.keys(page.objects).length);
  }
  if (jsonBytes(doc,false) > limits.documentBytes) throw Error(`Document exceeds ${limits.documentBytes/1024/1024} MiB; use referenced image assets`);
  validatedDocuments.add(doc);
  return doc;
}

/** Local immutable candidate validation. The trusted previous projection must
 * itself have passed full validation; remote/import inputs still use the full
 * boundary. Unchanged branches carry their existing proof and exact byte size. */
export function assertDocumentChanges(before,doc){
  if(!validatedDocuments.has(before))return assertDocument(doc);
  const limits=documentLimits(doc);
  if(!doc||!Array.isArray(doc.pages)||!doc.pages.length||doc.pages.length>limits.pages||!doc.pagesById)throw Error('Invalid document: pages are required');
  const previouslyActive=new Set(before.pages);
  let count=0;
  for(const pid of doc.pages){
    if(typeof pid!=='string'||blocked.has(pid))throw Error('Invalid page ID');
    // Inactive pages are serialized but the full validator has not established
    // shape/geometry validity for them. Activation must validate every shape,
    // even if the dormant page and its objects retained their identity.
    const page=doc.pagesById[pid],old=previouslyActive.has(pid)?before.pagesById[pid]:undefined;
    if(!page?.objects?.[ROOT]||page.objects[ROOT].type!=='frame')throw Error('Invalid document root');
    if(page.objects===old?.objects&&objectCounts.has(page.objects)){count+=objectCounts.get(page.objects);continue;}
    let objects=0;
    for(const [id,s] of Object.entries(page.objects)){
      objects++;
      if(s===old?.objects[id])continue;
      if(blocked.has(id)||!s||s.id!==id||!['frame','group','boolean','rect','ellipse','path','text','image','svg'].includes(s.type))throw Error('Invalid or oversized shape graph');
      for(const n of ['x','y','width','height'])if(s[n]!==undefined&&(!Number.isFinite(s[n])||Math.abs(s[n])>1e8))throw Error('Invalid geometry');
    }
    objectCounts.set(page.objects,objects);count+=objects;
  }
  if(count>limits.objects)throw Error('Invalid or oversized shape graph');
  if(jsonBytes(doc,true)>limits.documentBytes)throw Error(`Document exceeds ${limits.documentBytes/1024/1024} MiB; use referenced image assets`);
  validatedDocuments.add(doc);return doc;
}
export const assertDocumentIncremental=(doc,before)=>assertDocumentChanges(before,doc);
