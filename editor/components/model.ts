import type { CanvasDocument, Data, Page, Shape } from '../contracts';
import { clone, newId, descendants, createShape, refreshFrames, removeShapes } from '../document';
import { updateGeometry, moveShape } from '../geometry';
export const copy = clone;
export const uid = () => newId('component');
export const subtree = (page: Page, id: string) => descendants(page, id, true);
export const geometry = (shape: Shape): void => {
    updateGeometry(shape);
};
export const translate = (shape: Shape, dx: number, dy: number): void => {
    moveShape(shape, dx, dy);
};
export function locate(doc: CanvasDocument, id: string): {
    page: Page;
    shape: Shape;
} | undefined {
    for (const page of Object.values(doc.pagesById))
        if (page.objects[id])
            return { page, shape: page.objects[id] };
}
export function detachTree(page: Page, id: string): void {
    for (const s of subtree(page, id)) {
        delete s.componentId;
        delete s.sourceId;
        delete s.isMain;
        delete s.isInstanceRoot;
        delete s.overrides;
        delete s.componentPropertyRefs;
        delete s.componentProperties;
        delete s.propertyValues;
        delete s.componentOuterSourceId;
        delete s.componentSourceIds;
    }
}
export function eraseTree(page: Page, id: string): void {
    if (page.objects[id])
        removeShapes(page, [id]);
}
export function frame(page: Page, ids: string[], name: string): Shape {
    const rows = ids.map(id => page.objects[id]);
    if (rows.some(s => !s))
        throw Error('Missing selected shape');
    const parent = rows[0].parentId;
    if (rows.some(s => s.parentId !== parent))
        throw Error('Selection must share a parent');
    const x = Math.min(...rows.map(s => s.x)), y = Math.min(...rows.map(s => s.y));
    const s = createShape('frame', { id: uid(), name, parentId: parent, enclosingFrameId: rows[0].enclosingFrameId, x, y, width: Math.max(...rows.map(s => s.x + s.width)) - x, height: Math.max(...rows.map(s => s.y + s.height)) - y, rotation: 0, box: { x: 0, y: 0, width: 0, height: 0 }, corners: [], transform: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }, inverseTransform: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }, childIds: ids.slice() });
    geometry(s);
    const p = page.objects[parent];
    if (p) {
        const at = Math.min(...ids.map(id => p.childIds?.indexOf(id) ?? 0));
        p.childIds = (p.childIds || []).filter(k => !ids.includes(k));
        p.childIds.splice(at, 0, s.id);
    }
    page.objects[s.id] = s;
    for (const r of rows) {
        r.parentId = s.id;
        r.enclosingFrameId = s.id;
    }
    refreshFrames(page, s.id);
    return s;
}
export function cloneTree(source: Page, rootId: string, target: Page, parentId: string, dx = 0, dy = 0, linked = false, componentId?: string): Shape {
    const rows = subtree(source, rootId), ids = new Map(rows.map(s => [s.id, uid()]));
    for (const row of rows) {
        const s = copy(row);
        s.id = ids.get(row.id)!;
        s.parentId = ids.get(row.parentId) || parentId;
        s.enclosingFrameId = ids.get(row.enclosingFrameId) || parentId;
        if (s.childIds)
            s.childIds = s.childIds.map(k => ids.get(k)!);
        if (linked) {
            s.sourceId = row.id;
            if (row.isInstanceRoot && row.id !== rootId)
                s.componentOuterSourceId = row.id;
            s.overrides = copy(row.overrides || []);
            s.componentSourceIds = { ...(s.componentSourceIds || {}), [componentId || rootId]: row.id };
            delete s.isMain;
            if (row.id === rootId) {
                s.isInstanceRoot = true;
                s.componentId = componentId;
            }
            else if (!row.isInstanceRoot)
                delete s.componentId;
        }
        translate(s, dx, dy);
        target.objects[s.id] = s;
    }
    const root = target.objects[ids.get(rootId)!];
    (target.objects[parentId].childIds ||= []).push(root.id);
    return root;
}
export function component(doc: CanvasDocument, id: string): Data {
    const c = doc.components?.[id];
    if (!c || c.deleted)
        throw Error(`Unknown component ${id}`);
    return c;
}
export function validateComponents(doc: CanvasDocument): void {
    const graph = new Map<string, Set<string>>();
    for (const c of Object.values(doc.components || {})) {
        if (c.deleted)
            continue;
        const page = doc.pagesById[c.mainPageId];
        if (!page?.objects[c.mainId])
            continue;
        const edges = new Set<string>();
        for (const s of subtree(page, c.mainId))
            if (s.id !== c.mainId && s.isInstanceRoot && s.componentId)
                edges.add(s.componentId);
        graph.set(c.id, edges);
    }
    const seen = new Set<string>(), active = new Set<string>();
    const visit = (id: string) => {
        if (active.has(id))
            throw Error('Component dependency cycle');
        if (seen.has(id))
            return;
        active.add(id);
        for (const dep of graph.get(id) || [])
            visit(dep);
        active.delete(id);
        seen.add(id);
    };
    for (const id of graph.keys())
        visit(id);
}
export function validateVariants(doc: CanvasDocument, setId: string): void {
    const rows = Object.values(doc.components || {}).filter(c => !c.deleted && c.variantSetId === setId);
    const seen = new Set<string>();
    let axes: string[] | undefined;
    for (const c of rows) {
        const props = c.variantProperties || [];
        const names = props.map((p: Data) => p.name).sort();
        if (new Set(names).size !== names.length || !names.length || props.some((p: Data) => !p.name || !String(p.value)))
            throw Error('Variant axes and values are required');
        if (axes && JSON.stringify(axes) !== JSON.stringify(names))
            throw Error('Variants must use identical axes');
        axes = names;
        const key = JSON.stringify([...props].sort((a, b) => a.name.localeCompare(b.name)));
        if (seen.has(key))
            throw Error('Duplicate variant');
        seen.add(key);
    }
}
