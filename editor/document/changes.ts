import type { CanvasDocument, EditorChangeScope, Shape } from '../contracts';

/** Identity comparisons are valid only for the immutable editor/host contract. */
export function changedPaths(before: CanvasDocument, after: CanvasDocument): string[][] {
    if (before === after) return [];
    const paths: string[][] = [];
    for (const field of new Set([...Object.keys(before), ...Object.keys(after)])) {
        if (before[field] === after[field]) continue;
        if (field !== 'pagesById') { paths.push([field]); continue; }
        for (const id of new Set([...Object.keys(before.pagesById), ...Object.keys(after.pagesById)])) {
            const old = before.pagesById[id], page = after.pagesById[id];
            if (old === page) continue;
            if (!old || !page) { paths.push(['pagesById', id]); continue; }
            for (const key of new Set([...Object.keys(old), ...Object.keys(page)])) {
                if (old[key] === page[key]) continue;
                if (key !== 'objects') { paths.push(['pagesById', id, key]); continue; }
                for (const shape of new Set([...Object.keys(old.objects), ...Object.keys(page.objects)]))
                    if (old.objects[shape] !== page.objects[shape]) paths.push(['pagesById', id, 'objects', shape]);
            }
        }
    }
    return paths;
}

function topologyChanged(before: Shape | undefined, after: Shape | undefined): boolean {
    return !before || !after || before.id !== after.id || before.type !== after.type || before.parentId !== after.parentId ||
        before.childIds !== after.childIds && JSON.stringify(before.childIds) !== JSON.stringify(after.childIds);
}

export function changeScope(before: CanvasDocument, after: CanvasDocument, paths = changedPaths(before, after)): EditorChangeScope {
    const pages = new Set<string>(), topologyPages = new Set<string>(), shapes = new Map<string, Set<string>>(), documentFields = new Set<string>();
    const add = (pageId: string, id: string) => {
        const ids = shapes.get(pageId) ?? new Set<string>(); ids.add(id); shapes.set(pageId, ids);
        if (topologyChanged(before.pagesById[pageId]?.objects[id], after.pagesById[pageId]?.objects[id])) topologyPages.add(pageId);
    };
    for (const path of paths) {
        if (path[0] !== 'pagesById') {
            documentFields.add(path[0]);
            // The page index may retain inactive entries. Activating one is a
            // graph boundary even when its object map identity is unchanged.
            if (path[0] === 'pages' && Array.isArray(after.pages)) for (const id of after.pages) {
                if (before.pages.includes(id)) continue;
                pages.add(id); topologyPages.add(id);
                for (const key of Object.keys(after.pagesById[id]?.objects ?? {})) add(id, key);
            }
            continue;
        }
        const pageId = path[1];
        if (!pageId) {
            for (const id of new Set([...Object.keys(before.pagesById), ...Object.keys(after.pagesById)])) {
                pages.add(id); topologyPages.add(id);
                for (const key of Object.keys(after.pagesById[id]?.objects ?? {})) add(id, key);
            }
            continue;
        }
        pages.add(pageId);
        if (path.length < 3 || path[2] === 'objects' && path.length < 4) {
            topologyPages.add(pageId);
            for (const id of new Set([...Object.keys(before.pagesById[pageId]?.objects ?? {}), ...Object.keys(after.pagesById[pageId]?.objects ?? {})])) add(pageId, id);
        }
        else if (path[2] === 'objects') add(pageId, path[3]);
    }
    return { paths, pages: [...pages], shapes, topologyPages, documentFields };
}
