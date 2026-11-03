/** Canvas interchange, implemented from independently recorded serialization contracts. */
import type { CanvasDocument, Data, Page, Shape, ShapeType } from '../contracts';
import { boxGeometry } from '../geometry';
import { createPage, insertShape, refreshFrames } from '../document';
import { assertFiniteDocument, copy, documentModel, richText, shape, textValue, uid } from './model';
import { parseSvgPath } from './svg';
const extensionFields: Record<string, string[]> = {
    editorLayout: ['layout', 'hSizing', 'vSizing', 'widthSizing', 'heightSizing', 'minWidth', 'minHeight', 'maxWidth', 'maxHeight', 'absolute', 'gridCell', 'constraints', 'horizontalConstraint', 'verticalConstraint', 'alignSelf'],
    editorText: ['content', 'autoResize', 'lineBreak', 'truncate', 'maxLines', 'leadingTrim', 'textBackground'],
    editorBool: ['booleanOperation', 'operation', 'operands', 'fills', 'strokes', 'shadows', 'blur', 'blurHidden', 'backgroundBlur', 'backgroundBlurHidden'],
    editorComponent: ['componentId', 'isMain', 'isInstanceRoot', 'sourceId', 'overrides', 'isVariantSet', 'componentPropertyRefs', 'componentProperties'],
    editorFrame: ['clipContent', 'omitFillOnExport', 'isVariantSet', 'guides', 'layoutGrids', 'fills', 'strokes', 'shadows', 'blur', 'backgroundBlur', 'opacity', 'blendMode'],
    editorMask: ['mask', 'maskMode', 'isMask', 'isMaskGroup', 'maskType'],
    editorGrid: ['gridCell', 'layoutGrids'], editorExport: ['exportSettings'],
    editorStyleRef: ['fillStyleId', 'strokeStyleId', 'textStyleId', 'effectStyleId'],
    editorVector: ['strokeSides', 'radii', 'cornerSmoothing', 'strokeCap', 'strokeJoin', 'strokeDashes', 'fillRule', 'primitive', 'transform', 'flipX', 'flipY'],
    editorStyle: ['fills', 'strokes', 'effects', 'shadows', 'opacity', 'blendMode', 'blur', 'blurHidden', 'backgroundBlur', 'backgroundBlurHidden', 'radiusTopLeft', 'radiusTopRight', 'radiusBottomRight', 'radiusBottomLeft'],
};
function extensions(raw: Data): Data {
    const result: Data = {};
    for (const [extension, keys] of Object.entries(extensionFields)) {
        const value = raw[extension];
        if (value && typeof value === 'object')
            for (const key of keys)
                if (key in value)
                    result[key] = copy(value[key]);
    }
    if (['flex', 'grid'].includes(raw.editorLayout?.type))
        result.layout = copy(raw.editorLayout);
    return result;
}
function legacyType(raw: Data): ShapeType {
    if (raw.editorBool)
        return 'boolean';
    if (raw.editorPath)
        return 'path';
    if (raw.type === 'figure')
        return raw.subType === 'ellipse' ? 'ellipse' : 'rect';
    if (['frame', 'group', 'boolean', 'rect', 'ellipse', 'path', 'text', 'image', 'svg'].includes(raw.type))
        return raw.type;
    return raw.children ? 'group' : 'rect';
}
function flatSegments(content: string, x: number, y: number): Data[] {
    return parseSvgPath(content).map(segment => {
        const result: Data = { command: segment.type };
        if (segment.point) {
            result.x = segment.point.x + x;
            result.y = segment.point.y + y;
        }
        if (segment.control1) {
            result.x1 = segment.control1.x + x;
            result.y1 = segment.control1.y + y;
        }
        if (segment.control2) {
            result.x2 = segment.control2.x + x;
            result.y2 = segment.control2.y + y;
        }
        return result;
    });
}
function svgPath(s: Shape): string {
    return (s.segments ?? s.content ?? []).map((segment: Data) => {
        const command = segment.command ?? segment.type, p = segment.point ?? segment, c1 = segment.control1 ?? { x: segment.x1, y: segment.y1 }, c2 = segment.control2 ?? { x: segment.x2, y: segment.y2 };
        if (command === 'close')
            return 'Z';
        if (command === 'move' || command === 'line')
            return `${command === 'move' ? 'M' : 'L'}${p.x - s.x} ${p.y - s.y}`;
        if (command === 'curve')
            return `C${c1.x - s.x} ${c1.y - s.y} ${c2.x - s.x} ${c2.y - s.y} ${p.x - s.x} ${p.y - s.y}`;
        return '';
    }).join(' ');
}
export function importCanvasJson(input: any, options: Data = {}): CanvasDocument {
    const raw = typeof input === 'string' ? JSON.parse(input) : copy(input);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
        throw new Error('Expected Canvas JSON object');
    if (raw.pagesById) {
        assertFiniteDocument(raw);
        return raw;
    }
    const doc = documentModel();
    doc.legacy = copy(raw);
    for (const key of ['pages', 'editorPages', 'editorComponents', 'editorStyles', 'editorLibraries', 'editorRootLayers'])
        delete doc.legacy[key];
    doc.extra = copy(raw.extra ?? {});
    doc.components = copy(raw.editorComponents ?? {});
    doc.styles = copy(raw.editorStyles ?? {});
    doc.libraries = copy(raw.editorLibraries ?? {});
    const metadata = Array.isArray(raw.editorPages) ? raw.editorPages : [];
    if (metadata.length) {
        doc.pages = [];
        doc.pagesById = {};
        for (const value of metadata) {
            if (!value?.id || doc.pagesById[value.id])
                throw new Error('Invalid editor page metadata');
            const page = createPage(value.name ?? 'Page', value.id);
            Object.assign(page, copy(value), { objects: page.objects });
            doc.pages.push(page.id);
            doc.pagesById[page.id] = page;
        }
    }
    const ids = new Set(['root']);
    function idFor(value: any) { const id = typeof value === 'string' && value && value !== 'root' && !ids.has(value) ? value : uid(); ids.add(id); return id; }
    const pageFor = (board: Data): Page => {
        const ref = board.editorPage;
        const id = typeof ref === 'string' ? ref : ref?.id ?? ref?.pageId;
        if (id && doc.pagesById[id])
            return doc.pagesById[id];
        if (id) {
            const page = createPage(ref?.name ?? 'Page', id);
            doc.pages.push(id);
            doc.pagesById[id] = page;
            return page;
        }
        return doc.pagesById[doc.pages[0]];
    };
    const add = (rawLayer: Data, page: Page, parentId: string, ox: number, oy: number, board = false, placement?: Data): string => {
        const ext = extensions(rawLayer), frame = rawLayer.editorFrame ?? {};
        let type = board ? 'frame' : legacyType(rawLayer);
        if (rawLayer.editorFrame && !board)
            type = 'frame';
        const id = idFor(rawLayer.id), x = placement?.x ?? Number(frame.x ?? rawLayer.x ?? 0) + ox, y = placement?.y ?? Number(frame.y ?? rawLayer.y ?? 0) + oy, width = Number(frame.width ?? rawLayer.width ?? (board ? raw.width ?? 1000 : 100)), height = Number(frame.height ?? rawLayer.height ?? (board ? raw.height ?? 1000 : 100));
        const values: Data = { ...copy(rawLayer), ...ext, type, id, x, y, width, height, parentId, enclosingFrameId: parentId, legacy: copy(rawLayer) };
        delete values.children;
        delete values.legacy.children;
        delete values.childIds;
        if (rawLayer.fill !== undefined && !('fills' in ext))
            values.fills = rawLayer.fill === null ? [] : [{ color: rawLayer.fill, opacity: 1 }];
        if (rawLayer.stroke !== undefined && !('strokes' in ext))
            values.strokes = rawLayer.stroke === null ? [] : [{ color: rawLayer.stroke, width: Number(rawLayer.strokeWidth ?? 1) }];
        if (rawLayer.background !== undefined && !('fills' in ext))
            values.fills = rawLayer.background === null ? [] : [{ color: rawLayer.background }];
        if (rawLayer.cornerRadius !== undefined && !values.radii)
            values.radii = rawLayer.cornerRadius;
        if (type === 'text') {
            let content = ext.content ?? rawLayer.content;
            if (typeof content === 'string')
                content = richText(content);
            if (!content?.children)
                content = richText(String(rawLayer.text ?? ''), Object.fromEntries(['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'lineHeight', 'letterSpacing', 'textDecoration'].filter(k => rawLayer[k] !== undefined).map(k => [k, rawLayer[k]])));
            const stored = content.children.map((p: Data) => (p.children ?? []).map((r: Data) => r.text ?? '').join('')).join('\n');
            if (rawLayer.text !== undefined && rawLayer.text !== stored) {
                const first = content.children[0]?.children?.[0] ?? {};
                content = richText(String(rawLayer.text), Object.fromEntries(Object.entries(first).filter(([key]) => key !== 'text')));
            }
            values.content = content;
        }
        if (type === 'path') {
            const d = rawLayer.editorPath?.content;
            if (typeof d === 'string') {
                values.content = flatSegments(d, x, y);
                values.segments = copy(values.content);
            }
            else if (Array.isArray(rawLayer.content)) {
                values.content = copy(rawLayer.content);
                values.segments = copy(rawLayer.segments ?? rawLayer.content);
            }
        }
        if (type === 'boolean') {
            values.booleanOperation = ext.booleanOperation ?? ext.operation ?? rawLayer.booleanOperation ?? 'union';
            values.operation = values.booleanOperation;
        }
        if (type === 'image' || type === 'svg')
            values.image ??= { src: rawLayer.src ?? rawLayer.url ?? '', width, height };
        if (['frame', 'group', 'boolean'].includes(type))
            values.childIds = [];
        const s = shape(type, values);
        if (board)
            s.clipContent = ext.clipContent ?? true;
        insertShape(page, s, parentId);
        for (const child of rawLayer.children ?? [])
            add(child, page, id, s.x, s.y);
        return id;
    };
    const nextY = new Map<string, number>();
    for (const [index, board] of (raw.pages ?? []).entries()) {
        const page = pageFor(board), frame = board.editorFrame ?? {};
        const callbackPosition = options.column?.(board, index);
        const position = options.placeBoard?.(board, index) ?? options.placement?.(board, index) ?? (typeof callbackPosition === 'number' ? { x: callbackPosition, y: nextY.get(page.id) ?? 0 } : callbackPosition) ?? (Number.isFinite(frame.x) && Number.isFinite(frame.y) ? { x: frame.x, y: frame.y } : { x: Number(board.x ?? 0), y: nextY.get(page.id) ?? 0 });
        const id = add(board, page, 'root', 0, 0, true, position);
        nextY.set(page.id, position.y + page.objects[id].height + 100);
    }
    // This transparent bookkeeping extension preserves layers that are not legacy boards.
    for (const [pageId, layers] of Object.entries(raw.editorRootLayers ?? {})) {
        const page = doc.pagesById[pageId];
        if (!page)
            continue;
        for (const layer of layers as Data[])
            add(layer, page, 'root', 0, 0);
    }
    for (const page of Object.values(doc.pagesById))
        refreshFrames(page);
    for (const component of Object.values(doc.components ?? {})) {
        const owner = Object.values(doc.pagesById).find(page => page.objects[component.mainId]);
        if (owner)
            component.mainPageId = owner.id;
    }
    assertFiniteDocument(doc);
    return doc;
}
export function exportCanvasJson(doc: CanvasDocument, options: Data = {}): Data {
    assertFiniteDocument(copy(doc));
    const rootLayers: Record<string, Data[]> = {};
    const convert = (s: Shape, page: Page, ox: number, oy: number): Data => {
        const out: Data = { ...copy(s.legacy ?? {}) };
        for (const [key, value] of Object.entries(s))
            if (!['box', 'corners', 'transform', 'inverseTransform', 'parentId', 'enclosingFrameId', 'childIds', 'legacy', 'content'].includes(key))
                out[key] = copy(value);
        out.id = s.id;
        out.type = s.type === 'rect' || s.type === 'ellipse' ? 'figure' : s.type;
        if (s.type === 'rect' || s.type === 'ellipse')
            out.subType = s.type;
        out.x = s.x - ox;
        out.y = s.y - oy;
        out.width = s.width;
        out.height = s.height;
        out.rotation = s.rotation;
        if (s.fills?.[0]?.color)
            out.fill = s.fills[0].color;
        else
            delete out.fill;
        if (s.strokes?.[0]?.color) {
            out.stroke = s.strokes[0].color;
            out.strokeWidth = s.strokes[0].width ?? 1;
        }
        else {
            delete out.stroke;
            delete out.strokeWidth;
        }
        if (s.type === 'text') {
            out.text = textValue(s);
            const run = s.content?.children?.[0]?.children?.[0];
            if (run)
                for (const key of ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'letterSpacing'])
                    if (run[key] !== undefined)
                        out[key] = copy(run[key]);
        }
        if (s.image)
            out.src = s.image.src;
        for (const [extension, keys] of Object.entries(extensionFields)) {
            const record: Data = { ...copy(s.legacy?.[extension] ?? {}) };
            for (const key of keys)
                if (s[key] !== undefined && !(record[key] === null && Array.isArray(s[key]) && s[key].length === 0))
                    record[key] = copy(s[key]);
            if (Object.keys(record).length)
                out[extension] = record;
        }
        if (s.type === 'frame')
            out.editorFrame = { ...out.editorFrame, x: s.x - ox, y: s.y - oy, width: s.width, height: s.height };
        if (s.type === 'path')
            out.editorPath = { ...copy(s.legacy?.editorPath ?? {}), content: svgPath(s) };
        if (s.childIds)
            out.children = s.childIds.map(id => convert(page.objects[id], page, s.x, s.y));
        return out;
    };
    const boards: Data[] = [];
    for (const pageId of options.pageId ? [options.pageId] : doc.pages) {
        const page = doc.pagesById[pageId];
        if (!page)
            throw new Error('Page not found');
        rootLayers[page.id] = [];
        for (const id of page.objects.root.childIds ?? []) {
            const s = page.objects[id], out = convert(s, page, 0, 0);
            if (s.type === 'frame') {
                out.editorPage = page.id;
                out.background = s.fills?.[0]?.color;
                boards.push(out);
            }
            else
                rootLayers[page.id].push(out);
        }
    }
    const components = copy(doc.components ?? {});
    for (const component of Object.values(components))
        delete component.mainPageId;
    return { ...copy(doc.legacy ?? {}), width: boards[0]?.width ?? 1000, height: boards[0]?.height ?? 1000, pages: boards, editorPages: doc.pages.map(id => { const { objects, ...metadata } = doc.pagesById[id]; return copy(metadata); }), editorComponents: components, editorStyles: copy(doc.styles ?? {}), editorLibraries: copy(doc.libraries ?? {}), editorRootLayers: rootLayers, extra: copy(doc.extra ?? {}) };
}
