/** Original tree implementation from independent editor interoperability and behavior contracts. */
import type { CanvasDocument, Page, Shape, Data } from '../contracts';
import { updateGeometry, moveShape, resizeShape, rectOf } from '../geometry';
import { ROOT_ID, newId, clone, createPage } from './factory';
export function descendants(page: Page, id: string, includeSelf = false): Shape[] {
    const result: Shape[] = [], seen = new Set<string>(), stack = [id];
    while (stack.length) {
        const key = stack.pop()!;
        if (seen.has(key))
            throw new Error('Cyclic layer tree');
        seen.add(key);
        const shape = page.objects[key];
        if (!shape)
            throw new Error(`Missing layer ${key}`);
        result.push(shape);
        stack.push(...[...(shape.childIds ?? [])].reverse());
    }
    return includeSelf ? result : result.slice(1);
}
export function ancestors(page: Page, id: string): Shape[] {
    const result: Shape[] = [], seen = new Set([id]);
    let s = page.objects[id];
    while (s && s.id !== ROOT_ID) {
        const p = page.objects[s.parentId];
        if (!p)
            throw new Error(`Missing parent ${s.parentId}`);
        if (seen.has(p.id))
            throw new Error('Cyclic parent chain');
        seen.add(p.id);
        result.push(p);
        s = p;
    }
    return result;
}
export function topLevelIds(page: Page, ids: string[]): string[] {
    const set = new Set(ids), order = new Map(descendants(page, ROOT_ID, true).map((shape, index) => [shape.id, index]));
    return [...set].filter(id => id !== ROOT_ID && page.objects[id] && !ancestors(page, id).some(s => set.has(s.id))).sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
}
export function enclosingFrame(page: Page, parentId: string): string {
    let current = page.objects[parentId];
    while (current) {
        if (current.type === 'frame')
            return current.id;
        if (current.id === ROOT_ID)
            break;
        current = page.objects[current.parentId];
    }
    return ROOT_ID;
}
export function refreshFrames(page: Page, id = ROOT_ID): void {
    const start = page.objects[id];
    if (!start)
        throw new Error('Unknown layer');
    const stack: [
        string,
        string
    ][] = [[id, id === ROOT_ID ? ROOT_ID : enclosingFrame(page, start.parentId)]], seen = new Set<string>();
    while (stack.length) {
        const [key, frame] = stack.pop()!;
        if (seen.has(key))
            throw new Error('Cyclic layer tree');
        seen.add(key);
        const shape = page.objects[key];
        if (!shape)
            throw new Error('Missing child');
        shape.enclosingFrameId = frame;
        for (const childId of shape.childIds ?? [])
            stack.push([childId, shape.type === 'frame' ? shape.id : frame]);
    }
}
export function insertShape(page: Page, shape: Shape, parentId = shape.parentId ?? ROOT_ID, index?: number): Shape {
    const parent = page.objects[parentId];
    if (!parent || !Array.isArray(parent.childIds))
        throw new Error('Destination is not a container');
    if (page.objects[shape.id])
        throw new Error(`Duplicate layer ${shape.id}`);
    shape.parentId = parentId;
    shape.enclosingFrameId = enclosingFrame(page, parentId);
    page.objects[shape.id] = shape;
    parent.childIds.splice(index === undefined ? parent.childIds.length : Math.max(0, index), 0, shape.id);
    return shape;
}
export function removeShapes(page: Page, ids: string[]): void {
    for (const id of topLevelIds(page, ids)) {
        const shape = page.objects[id];
        const parent = page.objects[shape.parentId];
        parent.childIds = parent.childIds!.filter(key => key !== id);
        for (const s of descendants(page, id, true))
            delete page.objects[s.id];
    }
}
export function reparentShapes(page: Page, ids: string[], parentId: string, index?: number): void {
    const parent = page.objects[parentId];
    if (!parent?.childIds)
        throw new Error('Destination is not a container');
    const top = topLevelIds(page, ids);
    if (top.some(id => id === parentId || descendants(page, id).some(s => s.id === parentId)))
        throw new Error('Cannot parent a layer inside itself');
    for (const id of top) {
        const s = page.objects[id], old = page.objects[s.parentId];
        old.childIds = old.childIds!.filter(key => key !== id);
    }
    parent.childIds.splice(index === undefined ? parent.childIds.length : Math.max(0, index), 0, ...top);
    for (const id of top) {
        page.objects[id].parentId = parentId;
        refreshFrames(page, id);
    }
}
export function remapReferences(value: any, mapping: Map<string, string>, key = ''): any {
    // Asset IDs occupy their own namespace, even when equal to a layer ID.
    if (key === 'assetId') return value;
    if (typeof value === 'string')
        return /(?:Id|Ids|source|target)$/.test(key) ? mapping.get(value) ?? value : value;
    if (Array.isArray(value))
        return value.map(v => remapReferences(v, mapping, key));
    if (value && typeof value === 'object')
        return Object.fromEntries(Object.entries(value).map(([k, v]) => [['objects', 'overrides', 'sourceMap', 'instanceMap'].includes(key) ? mapping.get(k) ?? k : k, key === 'componentSourceIds' && typeof v === 'string' ? mapping.get(v) ?? v : remapReferences(v, mapping, k)]));
    return value;
}
export function isEditable(page: Page, id: string): boolean {
    const s = page.objects[id];
    return !!s && id !== ROOT_ID && ![s, ...ancestors(page, id)].some(node => node.locked || node.hidden);
}
export function cloneShapes(page: Page, ids: string[], options: Data = {}): Shape[] {
    const roots = topLevelIds(page, ids), all = roots.flatMap(id => descendants(page, id, true)), mapping = new Map(all.map(s => [s.id, newId()])), copies = all.map(s => remapReferences(clone(s), mapping));
    for (const s of copies) {
        const previous = s.id;
        s.id = mapping.get(previous)!;
        s.parentId = roots.includes(previous) ? options.parentId ?? s.parentId : s.parentId;
        moveShape(s, options.dx ?? 0, options.dy ?? 0);
    }
    for (const root of roots) {
        const copy = copies.find(s => s.id === mapping.get(root))!;
        insertShape(page, copy, copy.parentId, options.index);
    }
    for (const s of copies)
        if (!page.objects[s.id])
            page.objects[s.id] = s;
    for (const id of roots)
        refreshFrames(page, mapping.get(id)!);
    return roots.map(id => page.objects[mapping.get(id)!]);
}
/** Container constraints are reconciled centrally by applyLayout(doc,before). */
export function resizeTree(page: Page, id: string, rect: ReturnType<typeof rectOf>): void {
    const shape = page.objects[id];
    if (!shape)
        throw new Error('Unknown layer');
    resizeShape(shape, rect);
}
export function moveTree(page: Page, id: string, dx: number, dy: number): void {
    for (const s of descendants(page, id, true))
        moveShape(s, dx, dy);
}
export function addPage(doc: CanvasDocument, name?: string): Page {
    const page = createPage(name ?? `Page ${doc.pages.length + 1}`);
    doc.pages.push(page.id);
    doc.pagesById[page.id] = page;
    return page;
}
export function deletePage(doc: CanvasDocument, id: string): void {
    if (!doc.pagesById[id])
        throw new Error('Unknown page');
    if (doc.pages.length === 1)
        throw new Error('A document needs one page');
    doc.pages = doc.pages.filter(key => key !== id);
    delete doc.pagesById[id];
}
export function duplicatePage(doc: CanvasDocument, id: string): Page {
    const original = doc.pagesById[id];
    if (!original)
        throw new Error('Unknown page');
    const page = clone(original);
    page.id = newId('page');
    page.name = `${page.name ?? 'Page'} copy`;
    const map = new Map(Object.keys(page.objects).map(key => [key, key === ROOT_ID ? ROOT_ID : newId()]));
    page.objects = Object.fromEntries(Object.values(page.objects).map(s => {
        s.id = map.get(s.id)!;
        s.parentId = map.get(s.parentId)!;
        s.enclosingFrameId = map.get(s.enclosingFrameId) ?? ROOT_ID;
        s.childIds = s.childIds?.map(key => map.get(key)!);
        const remapped = remapReferences(s, map);
        return [s.id, remapped];
    }));
    doc.pages.splice(doc.pages.indexOf(id) + 1, 0, page.id);
    doc.pagesById[page.id] = page;
    return page;
}
