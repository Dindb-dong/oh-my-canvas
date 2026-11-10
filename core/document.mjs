import {geometricField,geometryEntries,restoreGeometry} from './geometry.mjs';
// Shared pure model adapter. Shape properties merge separately; containment is repaired
// deterministically so concurrent insert/move/delete never leaves dangling child lists.
export const ROOT = 'root';
import {documentLimits} from './capacity.mjs';
export {MAX_DOCUMENT_BYTES,MAX_STATE_BYTES,MAX_ENVELOPE_BYTES} from './capacity.mjs';
const blocked = new Set(['__proto__', 'constructor', 'prototype']);
export const same = (a, b) => a === b || JSON.stringify(a) === JSON.stringify(b);
const key = (...parts) => JSON.stringify(parts);

export function flatten(doc) {
  const out = new Map();
  for (const [field, value] of Object.entries(doc)) {
    if (field === 'pages' || field === 'pagesById' || value === undefined) continue;
    if (['components', 'styles', 'libraries'].includes(field)) {
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
    const result={pages:doc.pages,pagesById:{}};
    for(const [field,value] of Object.entries(doc))if(field!=='pages'&&field!=='pagesById'&&value!==other[field])result[field]=value;
    for(const pid of doc.pages){
      const page=doc.pagesById[pid],old=other.pagesById[pid];if(!page)continue;
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
  for (const [k, value] of entries) {
    if (value === null || value === undefined) continue;
    const p = JSON.parse(k);
    if (p.some(x => blocked.has(x))) continue;
    if (p[0] === 'meta') doc[p[1]] = value;
    else if (['components', 'styles', 'libraries'].includes(p[0])) (doc[p[0]] ??= {})[p[1]] = value;
    else if (p[0] === 'page') {
      const page = pages.get(p[1]) ?? {};
      page[p[2]] = value; pages.set(p[1], page);
    } else if(p[0]==='geometry'){
      const sk=key(p[1],p[2]),g=geometry.get(sk)??{};g[p[3]]=value;geometry.set(sk,g);
    } else if (p[0] === 'shape') {
      const sk = key(p[1], p[2]), shape = shapes.get(sk) ?? {};
      shape[p[3]] = value; shapes.set(sk, shape);
    }
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
    for (const [sk, shape] of shapes) {
      const [sp, id] = JSON.parse(sk);
      if (sp !== pid || (!shape.alive && !(recovery&&id===ROOT))) continue;
      const { alive: _, order: rank, ...s } = shape;
      s.id = id;
      restoreGeometry(s,geometry.get(sk));
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

export function applyPending(doc, patches) {
  if(!patches.length)return doc;
  const fields = flatten(doc);
  for (const patch of patches) for (const [k, v] of patch) fields.set(k, v);
  return materialize(fields);
}

export function assertDocument(doc) {
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.pages) || !doc.pages.length || doc.pages.length > 100 || !doc.pagesById) throw Error('Invalid document: pages are required');
  const limits=documentLimits(doc);let count = 0;
  for (const pid of doc.pages) {
    if (typeof pid !== 'string' || blocked.has(pid)) throw Error('Invalid page ID');
    const page = doc.pagesById[pid];
    if (!page?.objects?.[ROOT] || page.objects[ROOT].type !== 'frame') throw Error('Invalid document root');
    for (const [id, s] of Object.entries(page.objects)) {
      if (++count > limits.shapes || blocked.has(id) || !s || s.id !== id || !['frame','group','boolean','rect','ellipse','path','text','image','svg'].includes(s.type)) throw Error('Invalid or oversized shape graph');
      for (const n of ['x','y','width','height']) if (s[n] !== undefined && (!Number.isFinite(s[n]) || Math.abs(s[n]) > 1e8)) throw Error('Invalid geometry');
    }
  }
  const json = JSON.stringify(doc);
  if (new TextEncoder().encode(json).byteLength > limits.bytes) throw Error(`Document exceeds ${limits.bytes/1024/1024} MiB; use smaller embedded images`);
  return doc;
}
