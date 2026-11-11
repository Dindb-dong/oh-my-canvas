/** Original validation implementation from independent editor interoperability and behavior contracts. */
import type { CanvasDocument, EditorChangeScope, Page, Shape } from '../contracts';
import { documentLimits } from '../../core/document.mjs';
import { ROOT_ID } from './factory';
import { documentJSONBytes } from './size';
const objectCounts = new WeakMap<object, number>();
function validateHeader(doc: CanvasDocument, incremental = false): void {
    if (!doc || !Array.isArray(doc.pages) || !doc.pages.length || !doc.pagesById || new Set(doc.pages).size !== doc.pages.length)
        throw new Error('Invalid document pages');
    const limits = documentLimits(doc);
    if (doc.pages.length > limits.pages) throw new Error('Document page limit exceeded');
    let count = 0;
    for (const pageId of doc.pages) {
        const page = doc.pagesById[pageId];
        if (!page || page.id !== pageId || !page.objects)
            throw new Error('Invalid page');
        let size = incremental ? objectCounts.get(page.objects) : undefined;
        if (size === undefined) { size = Object.keys(page.objects).length; objectCounts.set(page.objects, size); }
        count += size;
    }
    if (count > limits.objects) throw new Error('Document object limit exceeded');
}
function validateShape(shape: Shape | undefined, id: string): void {
    if (!shape || shape.id !== id || !['frame', 'group', 'boolean', 'rect', 'ellipse', 'path', 'text', 'image', 'svg'].includes(shape.type))
        throw new Error('Invalid layer');
    for (const key of ['x', 'y', 'width', 'height', 'rotation'])
        if (!Number.isFinite(shape[key]) || Math.abs(shape[key]) > 1e9)
            throw new Error(`Invalid ${key}`);
    if (shape.width < 0 || shape.height < 0) throw new Error('Negative layer dimensions');
    if (shape.transform) {
        const m = shape.transform;
        if (!(['a', 'b', 'c', 'd'] as const).every(k => Number.isFinite(m[k]) && Math.abs(m[k]) <= 1e9) || Math.abs(m.a * m.d - m.b * m.c) < 1e-12)
            throw new Error('Invalid layer orientation');
    }
    if (['path', 'boolean'].includes(shape.type) && Array.isArray(shape.content)) {
        for (const segment of shape.content) {
            if (!segment || !['move', 'line', 'curve', 'close'].includes(segment.command)) throw new Error('Invalid path command');
            if (segment.command === 'close') continue;
            const keys = segment.command === 'curve' ? ['x', 'y', 'x1', 'y1', 'x2', 'y2'] : ['x', 'y'];
            if (!keys.every(key => Number.isFinite(segment[key]) && Math.abs(segment[key]) <= 1e9)) throw new Error('Invalid path coordinates');
        }
    }
    if (shape.childIds !== undefined && (!Array.isArray(shape.childIds) || !['frame', 'group', 'boolean'].includes(shape.type) || new Set(shape.childIds).size !== shape.childIds.length))
        throw new Error('Invalid children');
}
function validatePage(page: Page): void {
        const root = page.objects[ROOT_ID];
        if (!root || root.type !== 'frame' || root.parentId !== ROOT_ID || !Array.isArray(root.childIds))
            throw new Error('Invalid root');
        const visited = new Set<string>();
        const stack = [ROOT_ID];
        while (stack.length) {
            const id = stack.pop()!;
            if (typeof id !== 'string' || !id || visited.has(id))
                throw new Error('Cyclic, invalid or multiply parented layer');
            visited.add(id);
            const shape = page.objects[id];
            validateShape(shape, id);
            if (shape.childIds !== undefined) {
                for (const childId of shape.childIds) {
                    if (page.objects[childId]?.parentId !== id)
                        throw new Error('Parent/child mismatch');
                    stack.push(childId);
                }
            }
        }
        if (visited.size !== Object.keys(page.objects).length)
            throw new Error('Orphaned layers');
}
function validateSize(doc: CanvasDocument, incremental: boolean, before?: CanvasDocument, scope?: EditorChangeScope): void {
    const limit = documentLimits(doc).documentBytes;
    if (documentJSONBytes(doc, incremental, before && scope ? { before, paths: scope.paths } : undefined) > limit) throw new Error(`Document exceeds ${limit / 1024 / 1024} MiB limit`);
}
/** Normalization may add derived fields to an otherwise validated fresh tree. */
export function validateDocumentSize(doc: CanvasDocument): void { validateSize(doc, false); }
/** Import, external replacements and untrusted snapshots always traverse fully. */
export function validateDocument(doc: CanvasDocument): void {
    validateHeader(doc);
    for (const id of doc.pages) validatePage(doc.pagesById[id]);
    validateSize(doc, false);
}
/** Only a validated immutable baseline is eligible for this path. Structural
 * changes still verify the entire affected page, including orphan/cycle checks.
 */
export function validateDocumentChanges(before: CanvasDocument, doc: CanvasDocument, scope: EditorChangeScope): void {
    for (const [pageId] of scope.shapes) {
        const previous = before.pagesById[pageId]?.objects, objects = doc.pagesById[pageId]?.objects;
        const count = previous && objectCounts.get(previous);
        if (!previous || !objects || count === undefined || scope.topologyPages.has(pageId)) continue;
        // Scalar edits preserve dictionary membership. Structural edits retain
        // the complete count and graph walk below.
        objectCounts.set(objects, count);
    }
    validateHeader(doc, true);
    for (const id of scope.pages) {
        const page = doc.pagesById[id];
        if (!page) continue;
        if (!before.pagesById[id] || scope.topologyPages.has(id)) validatePage(page);
        else for (const shape of scope.shapes.get(id) ?? []) validateShape(page.objects[shape], shape);
    }
    validateSize(doc, true, before, scope);
}
