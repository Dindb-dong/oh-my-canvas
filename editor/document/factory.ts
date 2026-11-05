/** Original factory implementation from independent editor interoperability and behavior contracts. */
import type { CanvasDocument, Page, Shape, Data } from '../contracts';
import { boxGeometry, polygonPoints, orientedPoint } from '../geometry';
import { validateDocument } from './validation';
import { normalizePathContent } from '../geometry/svg-path';
export const ROOT_ID = 'root';
export function newId(prefix = 'shape'): string {
    return `${prefix}-${globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`}`;
}
export function clone<T>(value: T): T {
    return structuredClone(value);
}
export function createShape(type: string, props: Data = {}): Shape {
    if (!['frame', 'group', 'boolean', 'rect', 'ellipse', 'path', 'text', 'image', 'svg', 'polygon', 'star', 'line', 'arrow', 'pencil', 'pen'].includes(type))
        throw new Error('Unknown shape type');
    const drawing = ['polygon', 'star', 'line', 'arrow', 'pencil', 'pen'].includes(type);
    const shape: Shape = { id: newId(), type: (drawing ? 'path' : type) as Shape['type'], parentId: ROOT_ID, enclosingFrameId: ROOT_ID, x: 0, y: 0, width: 100, height: 100, name: type[0]?.toUpperCase() + type.slice(1), opacity: 1, hidden: false, locked: false, fills: [{ color: '#cbd5e1', opacity: 1 }], strokes: [], ...boxGeometry(props), ...clone(props) };
    if (['frame', 'group', 'boolean'].includes(shape.type))
        shape.childIds ??= [];
    if(shape.type==='group')shape.fills=props.fills??[];
    normalizePathContent(shape);
    if (shape.type === 'frame') {
        shape.clipContent ??= false;
        shape.fills = props.fills ?? [{ color: '#ffffff', opacity: 1 }];
    }
    if (shape.type === 'path') {
        if (type === 'polygon' || type === 'star')
            shape.primitive = { kind: type, count: props.count ?? props.sides ?? props.primitive?.count ?? (type === 'star' ? 5 : 3), ...(type === 'star' ? { ratio: props.ratio ?? props.innerRatio ?? props.primitive?.ratio ?? .5 } : {}) };
        if (!shape.content) {
            const points = shape.primitive ? polygonPoints(shape, shape.primitive.count, shape.primitive.kind === 'star', shape.primitive.ratio ?? .5) : drawing ? [{ x: shape.x, y: shape.y }, { x: shape.x + shape.width, y: shape.y + shape.height }] : [];
            shape.content = points.map((point, index) => ({ command: index ? 'line' : 'move', ...point }));
            if (shape.primitive)
                shape.content.push({ command: 'close' });
            shape.content = shape.content.map((segment: Data) => segment.command === 'close' ? segment : { ...segment, ...orientedPoint(shape, segment as {
                    x: number;
                    y: number;
                }) });
        }
        if (['line', 'arrow', 'pencil', 'pen'].includes(type)) {
            shape.fills = [];
            shape.strokes = props.strokes ?? [{ color: '#111827', width: 1, ...(type === 'arrow' ? { endCap: 'arrow' } : {}) }];
        }
    }
    if (shape.type === 'text') {
        shape.content ??= { type: 'richText', verticalAlign: 'top', children: [{ children: [{ text: props.text ?? '', fontFamily: 'sans-serif', fontSize: 16, fills: [{ color: '#111827' }] }] }] };
        shape.autoResize ??= 'height';
        shape.fills = props.fills ?? [];
    }
    Object.assign(shape, boxGeometry(shape));
    return shape;
}
export function createPage(name = 'Page 1', id = newId('page')): Page {
    return { id, name, objects: { root: createShape('frame', { id: ROOT_ID, name: 'Root', parentId: ROOT_ID, enclosingFrameId: ROOT_ID, width: 1000, height: 1000, fills: [], childIds: [] }) } };
}
export function createDocument(options: Data = {}): CanvasDocument {
    if (options.pages && options.pagesById) {
        const doc = clone(options) as CanvasDocument;
        for (const page of Object.values(doc.pagesById))
            for (const shape of Object.values(page.objects))
                normalizePathContent(shape);
        validateDocument(doc);
        return doc;
    }
    const page = createPage(options.pageName ?? 'Page 1', options.pageId);
    return { ...clone(options), pages: [page.id], pagesById: { [page.id]: page }, components: options.components ?? {}, styles: options.styles ?? {}, libraries: options.libraries ?? {} };
}
