import type { CanvasDocument, Data, EditorStore, Page, Shape } from '../contracts';
import { copy, uid, geometry, cloneTree, validateComponents, locate } from '../components/model';
import { createShape, refreshFrames } from '../document';
import { createComponentService } from '../components';
export interface LibrarySnapshot extends Data {
    id: string;
    name: string;
    version: string | number;
    enabled: boolean;
    components: Record<string, Data>;
    objects: Record<string, Shape>;
    styles: Record<string, Data>;
    variantSets: Record<string, Data>;
}
function validateSnapshot(input: Data): asserts input is LibrarySnapshot {
    if (!input?.id || !input.name || !['string', 'number'].includes(typeof input.version))
        throw Error('Library id, name and version required');
    for (const field of ['components', 'objects', 'styles'])
        if (!input[field] || typeof input[field] !== 'object' || Array.isArray(input[field]))
            throw Error(`Library ${field} must be a record`);
    for (const c of Object.values(input.components) as Data[])
        if (!input.objects[c.mainId])
            throw Error('Library main missing');
}
const mapped = (libraryId: string, id: string) => `library:${libraryId}:${id}`;
function importSnapshot(doc: CanvasDocument, snapshot: LibrarySnapshot): void {
    const pageId = `library-page:${snapshot.id}`;
    const old = doc.pagesById[pageId];
    const objects: Record<string, Shape> = {};
    const root = createShape('frame', { id: 'root', name: snapshot.name, parentId: 'root', enclosingFrameId: 'root', x: 0, y: 0, width: 1000, height: 1000, rotation: 0, box: { x: 0, y: 0, width: 0, height: 0 }, corners: [], transform: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }, inverseTransform: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }, childIds: [] });
    geometry(root);
    objects.root = root;
    const shapeId = (id: string) => id === 'root' ? 'root' : mapped(snapshot.id, id);
    for (const row of Object.values(snapshot.objects)) {
        if (row.id === 'root')
            continue;
        const s = copy(row);
        if (s.componentOuterSourceId)
            s.componentOuterSourceId = shapeId(s.componentOuterSourceId);
        if (s.componentSourceIds)
            s.componentSourceIds = Object.fromEntries(Object.entries(s.componentSourceIds).map(([key, value]) => [mapped(snapshot.id, key), shapeId(String(value))]));
        for (const field of ['componentProperties', 'propertyValues'])
            if (s[field])
                for (const propertyId of Object.keys(s[field])) {
                    const definition = Object.values(snapshot.components).flatMap(c => c.properties || []).find((p: Data) => p.id === propertyId);
                    if (definition?.type === 'swap' && s[field][propertyId])
                        s[field][propertyId] = mapped(snapshot.id, s[field][propertyId]);
                }
        s.id = shapeId(row.id);
        s.parentId = snapshot.objects[row.parentId] && row.parentId !== 'root' ? shapeId(row.parentId) : 'root';
        s.enclosingFrameId = snapshot.objects[row.enclosingFrameId] && row.enclosingFrameId !== 'root' ? shapeId(row.enclosingFrameId) : 'root';
        if (s.childIds)
            s.childIds = s.childIds.map(shapeId);
        if (s.componentId)
            s.componentId = mapped(snapshot.id, s.componentId);
        if (s.sourceId)
            s.sourceId = shapeId(s.sourceId);
        for (const key of ['fillStyleId', 'strokeStyleId', 'effectStyleId', 'textStyleId'])
            if (s[key])
                s[key] = mapped(snapshot.id, s[key]);
        const mapRuns = (r: any) => {
            if (!r || typeof r !== 'object')
                return;
            for (const key of ['fillStyleId', 'textStyleId'])
                if (r[key])
                    r[key] = mapped(snapshot.id, r[key]);
            for (const ch of r.children || [])
                mapRuns(ch);
        };
        mapRuns(s.content);
        objects[s.id] = s;
        if (s.parentId === 'root')
            root.childIds!.push(s.id);
    }
    const page: Page = { id: pageId, name: snapshot.name, objects, isLibrary: true, libraryId: snapshot.id };
    doc.pagesById[pageId] = page;
    if (!doc.pages.includes(pageId))
        doc.pages.push(pageId);
    for (const [id, c] of Object.entries(snapshot.components)) {
        const targetId = mapped(snapshot.id, id);
        (doc.components ||= {})[targetId] = { ...copy(c), properties: (c.properties || []).map((p: Data) => p.type === 'swap' && p.default ? { ...copy(p), default: mapped(snapshot.id, p.default) } : copy(p)), id: targetId, mainId: shapeId(c.mainId), mainPageId: pageId, libraryId: snapshot.id, libraryComponentId: id, variantSetId: c.variantSetId ? shapeId(c.variantSetId) : undefined };
    }
    for (const c of Object.values(snapshot.components)) {
        const main = objects[shapeId(c.mainId)];
        main.componentId = mapped(snapshot.id, c.id);
        main.isMain = true;
        main.isInstanceRoot = true;
    }
    for (const setId of new Set(Object.values(snapshot.components).map(c => c.variantSetId).filter(Boolean))) {
        const id = shapeId(setId);
        if (objects[id])
            continue;
        const mains = Object.values(snapshot.components).filter(c => c.variantSetId === setId).map(c => objects[shapeId(c.mainId)]);
        if (!mains.length)
            continue;
        const x = Math.min(...mains.map(s => s.x)), y = Math.min(...mains.map(s => s.y));
        const set = createShape('frame', { id, name: snapshot.variantSets?.[setId]?.name || 'Variants', parentId: 'root', enclosingFrameId: 'root', isVariantSet: true, childIds: mains.map(s => s.id), x, y, width: Math.max(...mains.map(s => s.x + s.width)) - x, height: Math.max(...mains.map(s => s.y + s.height)) - y });
        objects[id] = set;
        for (const main of mains) {
            const previous = objects[main.parentId];
            if (previous?.childIds)
                previous.childIds = previous.childIds.filter(key => key !== main.id);
            main.parentId = id;
        }
        root.childIds!.push(id);
    }
    refreshFrames(page);
    for (const [id, s] of Object.entries(snapshot.styles)) {
        const targetId = mapped(snapshot.id, id);
        (doc.styles ||= {})[targetId] = { ...copy(s), id: targetId, libraryId: snapshot.id, libraryStyleId: id };
    }
    if (old)
        for (const [id, s] of Object.entries(old.objects))
            if (!objects[id])
                for (const c of Object.values(doc.components || {}))
                    if (c.mainId === id)
                        c.deleted = true;
    validateComponents(doc);
}
export function createLibraryService(editor: EditorStore) {
    return {
        list() {
            return copy(Object.values(editor.doc.libraries || {}));
        },
        add(snapshot: LibrarySnapshot) {
            validateSnapshot(snapshot);
            return editor.transact('library:add', doc => {
                if (doc.libraries?.[snapshot.id])
                    throw Error('Library already linked');
                const saved = copy(snapshot);
                saved.enabled = snapshot.enabled !== false;
                (doc.libraries ||= {})[saved.id] = saved;
                importSnapshot(doc, saved);
                return copy(saved);
            });
        },
        enable(id: string, enabled: boolean) {
            return editor.transact('library:enable', doc => {
                const library = doc.libraries?.[id];
                if (!library)
                    throw Error('Unknown library');
                library.enabled = !!enabled;
                return copy(library);
            });
        },
        remove(id: string) {
            return editor.transact('library:remove', doc => {
                if (!doc.libraries?.[id])
                    throw Error('Unknown library');
                delete doc.libraries[id];
                for (const c of Object.values(doc.components || {}))
                    if (c.libraryId === id) {
                        delete c.libraryId;
                        delete c.libraryComponentId;
                    }
                for (const s of Object.values(doc.styles || {}))
                    if (s.libraryId === id) {
                        delete s.libraryId;
                        delete s.libraryStyleId;
                    }
                const page = doc.pagesById[`library-page:${id}`];
                if (page) {
                    delete page.isLibrary;
                    delete page.libraryId;
                    page.name = `${page.name} (local)`;
                }
                return true;
            });
        },
        update(id: string, snapshot: LibrarySnapshot) {
            validateSnapshot(snapshot);
            if (snapshot.id !== id)
                throw Error('Library identity mismatch');
            return editor.transact('library:update', doc => {
                const old = doc.libraries?.[id];
                if (!old)
                    throw Error('Unknown library');
                for (const [key, c] of Object.entries(old.components || {}) as [
                    string,
                    Data
                ][]) {
                    const next = snapshot.components[key];
                    if (next && (c.properties || []).some((p: Data) => !(next.properties || []).some((q: Data) => q.id === p.id && q.type === p.type)))
                        throw Error('Incompatible component property definitions');
                }
                for (const [key, style] of Object.entries(old.styles || {}) as [
                    string,
                    Data
                ][]) {
                    if (snapshot.styles[key] && snapshot.styles[key].type !== style.type)
                        throw Error('Incompatible style type');
                }
                const saved = copy(snapshot);
                saved.enabled = old.enabled;
                doc.libraries![id] = saved;
                importSnapshot(doc, saved);
                return copy(saved);
            });
        },
        insert(libraryId: string, componentId: string, options: Data = {}) {
            const library = editor.doc.libraries?.[libraryId];
            if (!library || !library.enabled)
                throw Error('Library disabled or unavailable');
            return createComponentService(editor).run('instance', { ...options, componentId: mapped(libraryId, componentId) });
        },
    };
}
export function createAssetService(editor: EditorStore) {
    const components = createComponentService(editor);
    const libraries = createLibraryService(editor);
    return {
        libraries,
        list(query = ''): Data[] {
            const grouped = new Map<string, Data>();
            for (const c of Object.values(editor.doc.components || {})) {
                if (c.deleted || (c.libraryId && !editor.doc.libraries?.[c.libraryId]?.enabled))
                    continue;
                const name = `${c.path || ''}/${c.name}`;
                if (!name.toLowerCase().includes(query.toLowerCase()))
                    continue;
                const key = c.variantSetId || c.id;
                if (grouped.has(key))
                    continue;
                const variants = c.variantSetId ? Object.values(editor.doc.components || {}).filter(v => !v.deleted && v.variantSetId === c.variantSetId) : [c];
                const first = variants[0];
                grouped.set(key, { id: key, componentId: first.id, name: c.variantSetId ? (editor.doc.pagesById[c.mainPageId]?.objects[c.variantSetId]?.name || c.name) : c.name, path: c.path || (c.name || '').split('/').slice(0, -1).join('/').trim(), pageId: c.mainPageId, pageName: editor.doc.pagesById[c.mainPageId]?.name || '', libraryId: c.libraryId, variants: variants.map(v => ({ id: v.id, name: v.name, variantProperties: copy(v.variantProperties || []) })), thumbnail: first.thumbnail });
            }
            const files = Object.values<Data>(editor.doc.assets || {}).filter((a: Data) => a.name?.toLowerCase().includes(query.toLowerCase()));
            return [...grouped.values(), ...copy(files)];
        },
        insert(componentId: string, options: Data = {}) {
            const target = editor.doc.components?.[componentId] ? componentId : Object.values(editor.doc.components || {}).find(c => c.variantSetId === componentId && !c.deleted)?.id;
            if (!target)
                throw Error('Unknown component asset');
            return components.run('instance', { ...options, componentId: target });
        },
        addFile(input: Data) {
            if (!input.name || !input.src || typeof input.src !== 'string')
                throw Error('Asset name and source required');
            if (!/^(data:|blob:|https?:|file:)/i.test(input.src))
                throw Error('Unsupported asset URL');
            return editor.transact('asset:add', doc => {
                const asset = { ...copy(input), id: input.id || uid(), kind: input.kind || 'image' };
                (doc.assets ||= {})[asset.id] = asset;
                return copy(asset);
            });
        },
        remove(id: string) {
            return editor.transact('asset:remove', doc => {
                if (!doc.assets?.[id])
                    throw Error('Unknown asset');
                delete doc.assets[id];
                return true;
            });
        },
        place(id: string, options: Data = {}) {
            return editor.transact('asset:place', doc => {
                const a = doc.assets?.[id];
                if (!a)
                    throw Error('Unknown asset');
                if (a.kind === 'font')
                    throw Error('Font assets are loaded through the font catalog');
                const page = doc.pagesById[options.pageId || editor.pageId];
                if (!page)
                    throw Error('Unknown page');
                const parentId = options.parentId || 'root';
                if (!page.objects[parentId])
                    throw Error('Unknown parent');
                const s = createShape(a.kind === 'svg' ? 'svg' : 'image', { id: uid(), name: a.name, parentId, enclosingFrameId: parentId, x: options.x || 0, y: options.y || 0, width: options.width || a.width || 100, height: options.height || a.height || 100, rotation: 0, box: { x: 0, y: 0, width: 0, height: 0 }, corners: [], transform: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }, inverseTransform: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }, image: { src: a.src, width: a.width, height: a.height, mimeType: a.mimeType }, assetId: id });
                geometry(s);
                page.objects[s.id] = s;
                (page.objects[parentId].childIds ||= []).push(s.id);
                return { selection: [s.id] };
            });
        },
    };
}
/** Hydrates existing persisted snapshots before the first editor projection. */
export function normalizeLibraries(doc: CanvasDocument): void {
    for (const input of Object.values(doc.libraries || {})) {
        validateSnapshot(input);
        const snapshot = input as LibrarySnapshot;
        if (!doc.pagesById[`library-page:${snapshot.id}`])
            importSnapshot(doc, snapshot);
        for (const page of Object.values(doc.pagesById)) {
            if (page.libraryId === snapshot.id)
                continue;
            for (const root of Object.values(page.objects)) {
                const mapStyles = (target: Data) => {
                    for (const key of ['fillStyleId', 'strokeStyleId', 'effectStyleId', 'textStyleId'])
                        if (target[key] && !doc.styles?.[target[key]] && snapshot.styles[target[key]])
                            target[key] = mapped(snapshot.id, target[key]);
                    for (const child of target.children || [])
                        mapStyles(child);
                };
                mapStyles(root);
                if (root.content && root.type === 'text')
                    mapStyles(root.content);
                for (const field of ['componentProperties', 'propertyValues'])
                    if (root[field])
                        for (const key of Object.keys(root[field])) {
                            const value = root[field][key];
                            if (typeof value === 'string' && !doc.components?.[value] && snapshot.components[value])
                                root[field][key] = mapped(snapshot.id, value);
                        }
                if (!root.isInstanceRoot || doc.components?.[root.componentId] || !snapshot.components[root.componentId])
                    continue;
                const sourceId = root.componentId;
                root.componentId = mapped(snapshot.id, sourceId);
                const stack = [root];
                const seen = new Set<string>();
                while (stack.length) {
                    const s = stack.pop()!;
                    if (seen.has(s.id))
                        throw Error('Library instance tree cycle');
                    seen.add(s.id);
                    if (s.sourceId && snapshot.objects[s.sourceId])
                        s.sourceId = mapped(snapshot.id, s.sourceId);
                    if (s.componentOuterSourceId && snapshot.objects[s.componentOuterSourceId])
                        s.componentOuterSourceId = mapped(snapshot.id, s.componentOuterSourceId);
                    if (s !== root && s.componentId && !doc.components?.[s.componentId] && snapshot.components[s.componentId])
                        s.componentId = mapped(snapshot.id, s.componentId);
                    for (const child of s.childIds || []) {
                        if (!page.objects[child])
                            throw Error('Library instance child missing');
                        stack.push(page.objects[child]);
                    }
                }
            }
        }
    }
}
export function reconcileLibraries(before: CanvasDocument, draft: CanvasDocument): void {
    for (const snapshot of Object.values(draft.libraries || {}))
        if (!before.libraries?.[snapshot.id] && !draft.pagesById[`library-page:${snapshot.id}`]) {
            validateSnapshot(snapshot);
            importSnapshot(draft, snapshot);
        }
}
