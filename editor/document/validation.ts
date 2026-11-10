/** Original validation implementation from independent editor interoperability and behavior contracts. */
import {documentLimits} from '../../core/capacity.mjs';
import type { CanvasDocument } from '../contracts';
import { ROOT_ID } from './factory';
export function validateDocument(doc: CanvasDocument): void {
    if (!doc || !Array.isArray(doc.pages) || !doc.pages.length || !doc.pagesById || new Set(doc.pages).size !== doc.pages.length)
        throw new Error('Invalid document pages');
    for (const pageId of doc.pages) {
        const page = doc.pagesById[pageId];
        if (!page || page.id !== pageId || !page.objects)
            throw new Error('Invalid page');
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
            if (!shape || shape.id !== id || !['frame', 'group', 'boolean', 'rect', 'ellipse', 'path', 'text', 'image', 'svg'].includes(shape.type))
                throw new Error('Invalid layer');
            for (const key of ['x', 'y', 'width', 'height', 'rotation'])
                if (!Number.isFinite(shape[key]) || Math.abs(shape[key]) > 1e9)
                    throw new Error(`Invalid ${key}`);
            if (shape.width < 0 || shape.height < 0)
                throw new Error('Negative layer dimensions');
            if (shape.transform) {
                const m = shape.transform;
                if (!(['a', 'b', 'c', 'd'] as const).every(k => Number.isFinite(m[k]) && Math.abs(m[k]) <= 1e9) || Math.abs(m.a * m.d - m.b * m.c) < 1e-12)
                    throw new Error('Invalid layer orientation');
            }
            if (['path', 'boolean'].includes(shape.type) && Array.isArray(shape.content)) {
                for (const segment of shape.content) {
                    if (!segment || !['move', 'line', 'curve', 'close'].includes(segment.command))
                        throw new Error('Invalid path command');
                    if (segment.command === 'close')
                        continue;
                    const keys = segment.command === 'curve' ? ['x', 'y', 'x1', 'y1', 'x2', 'y2'] : ['x', 'y'];
                    if (!keys.every(key => Number.isFinite(segment[key]) && Math.abs(segment[key]) <= 1e9))
                        throw new Error('Invalid path coordinates');
                }
            }
            if (shape.childIds !== undefined) {
                if (!Array.isArray(shape.childIds) || !['frame', 'group', 'boolean'].includes(shape.type) || new Set(shape.childIds).size !== shape.childIds.length)
                    throw new Error('Invalid children');
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
    const limit=documentLimits(doc).bytes;
    if (new TextEncoder().encode(JSON.stringify(doc)).byteLength > limit)
        throw new Error(`Document exceeds ${limit/1024/1024} MiB limit`);
}
