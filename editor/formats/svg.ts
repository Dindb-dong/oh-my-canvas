import type { Data, Matrix, Point, Shape } from '../contracts';
import { identity, multiply, transformPoint, bounds, boxGeometry, pathBounds } from '../geometry';
import { shape, uid, richText } from './model';
import { parseMarkup, cssDeclarations, escapeAttr, escapeText, type MarkupNode } from './markup';
import type { Imported, ImportOptions } from './html';
import { measureTextLayout } from '../layout';
import { parseSvgPath } from '../geometry/svg-path';
export { parseSvgPath } from '../geometry/svg-path';
export const SVG_IMPORT_LIMITS = { layers: 2000, segments: 10000, visits: 20000, depth: 100, fallbackBytes: 4 * 1024 * 1024, retainedBytes: 16 * 1024 * 1024 } as const;
const num = (v: any, d = 0) => {
    const n = parseFloat(v);
    if (!Number.isFinite(n))
        return d;
    const unit = typeof v === 'string' ? /[a-z]+$/i.exec(v)?.[0].toLowerCase() : undefined;
    return n * ({ in: 96, cm: 96 / 2.54, mm: 96 / 25.4, pt: 96 / 72, pc: 16 } as Data)[unit ?? ''] || n;
};
function matrix(value = ''): Matrix {
    let m = identity();
    for (const match of value.matchAll(/([a-z]+)\s*\(([^)]*)\)/gi)) {
        const v = (match[2].match(/[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:e[-+]?\d+)?/gi) ?? []).map(Number);
        let n = identity();
        switch (match[1].toLowerCase()) {
            case 'matrix':
                if (v.length === 6)
                    n = { a: v[0], b: v[1], c: v[2], d: v[3], e: v[4], f: v[5] };
                break;
            case 'translate':
                n.e = v[0] ?? 0;
                n.f = v[1] ?? 0;
                break;
            case 'scale':
                n.a = v[0] ?? 1;
                n.d = v[1] ?? n.a;
                break;
            case 'rotate': {
                const a = (v[0] ?? 0) * Math.PI / 180, c = Math.cos(a), s = Math.sin(a), x = v[1] ?? 0, y = v[2] ?? 0;
                n = { a: c, b: s, c: -s, d: c, e: x - c * x + s * y, f: y - s * x - c * y };
                break;
            }
            case 'skewx':
                n.c = Math.tan((v[0] ?? 0) * Math.PI / 180);
                break;
            case 'skewy':
                n.b = Math.tan((v[0] ?? 0) * Math.PI / 180);
                break;
        }
        m = multiply(m, n);
    }
    return m;
}
export function importSvg(text: string, options: ImportOptions = {}): Imported {
    const parsed = parseMarkup(text, { svg: true }), svg = parsed.children.find(n => n.tag === 'svg');
    if (!svg)
        throw new Error('Expected SVG root');
    const defs = new Map<string, MarkupNode>();
    const collect = (n: MarkupNode) => {
        if (n.attrs.id)
            defs.set(n.attrs.id, n);
        n.children.forEach(collect);
    };
    collect(svg);
    const viewBox = (svg.attrs.viewbox?.match(/[-+\d.e]+/gi) ?? []).map(Number), width = num(svg.attrs.width, viewBox[2] ?? options.width ?? 100), height = num(svg.attrs.height, viewBox[3] ?? options.height ?? 100), objects: Record<string, Shape> = {}, rootIds: string[] = [], warnings: string[] = [], makeId = options.id ?? uid;
    const encoder = new TextEncoder(), bytes = (value: string) => encoder.encode(value).length;
    let layers = 0, visits = 0, segmentCount = 0, fallbackBytes = 0, retainedBytes = 0, definitions: string | undefined;
    const retain = (value: Shape) => {
        const size = bytes(JSON.stringify(value));
        if (retainedBytes + size > SVG_IMPORT_LIMITS.retainedBytes)
            throw new Error('SVG exceeds the retained data byte limit');
        retainedBytes += size;
        objects[value.id] = value;
    };
    function serializeLimited(node: MarkupNode, limit: number): string {
        const parts: string[] = [];
        let length = 0;
        const append = (part: string) => {
            length += bytes(part);
            if (length > limit)
                throw new Error('SVG exceeds the fallback picture byte limit');
            parts.push(part);
        };
        const walk = (value: MarkupNode) => {
            if (value.tag === '#text') { append(escapeText(value.text)); return; }
            append(`<${value.sourceTag ?? value.tag}`);
            for (const [key, content] of Object.entries(value.attrs))
                append(` ${value.sourceNames?.[key] ?? key}="${escapeAttr(content)}"`);
            append('>');
            value.children.forEach(walk);
            append(`</${value.sourceTag ?? value.tag}>`);
        };
        walk(node);
        return parts.join('');
    }
    const vbWidth = viewBox[2] || width, vbHeight = viewBox[3] || height;
    let scaleX = width / vbWidth, scaleY = height / vbHeight;
    const aspect = svg.attrs.preserveaspectratio ?? 'xMidYMid meet';
    let alignX = 0, alignY = 0;
    if (!aspect.includes('none')) {
        const scale = aspect.includes('slice') ? Math.max(scaleX, scaleY) : Math.min(scaleX, scaleY);
        scaleX = scaleY = scale;
        alignX = (width - vbWidth * scale) * (aspect.includes('xMin') ? 0 : aspect.includes('xMax') ? 1 : .5);
        alignY = (height - vbHeight * scale) * (aspect.includes('YMin') ? 0 : aspect.includes('YMax') ? 1 : .5);
    }
    const initial = multiply({ a: scaleX, b: 0, c: 0, d: scaleY, e: (options.x ?? 0) + alignX - (viewBox[0] ?? 0) * scaleX, f: (options.y ?? 0) + alignY - (viewBox[1] ?? 0) * scaleY }, matrix(svg.attrs.transform));
    const paint = (value: string | undefined, opacity: number): Data[] => {
        if (value === 'none')
            return [];
        const ref = /url\(#([^)]*)\)/.exec(value ?? '');
        if (ref) {
            const def = defs.get(ref[1]);
            if (def && ['lineargradient', 'radialgradient'].includes(def.tag)) {
                const coordinate = (v: string | undefined, d: number) => v?.endsWith('%') ? num(v) / 100 : num(v, d);
                const radial = def.tag === 'radialgradient', cx = coordinate(def.attrs.cx, .5), cy = coordinate(def.attrs.cy, .5), radius = coordinate(def.attrs.r, .5);
                return [{ opacity, gradient: { type: radial ? 'radial' : 'linear', x1: radial ? cx : coordinate(def.attrs.x1, 0), y1: radial ? cy : coordinate(def.attrs.y1, 0), x2: radial ? cx + radius : coordinate(def.attrs.x2, 1), y2: radial ? cy : coordinate(def.attrs.y2, 0), aspect: 1, stops: def.children.filter(n => n.tag === 'stop').map(n => { const c = cssDeclarations(n.attrs.style ?? ''); return { offset: coordinate(n.attrs.offset, 0), color: c['stop-color'] ?? n.attrs['stop-color'] ?? '#000', opacity: num(c['stop-opacity'] ?? n.attrs['stop-opacity'], 1) }; }) } }];
            }
            warnings.push(`Unsupported SVG paint ${value}`);
            return [];
        }
        return [{ color: value ?? '#000', opacity }];
    };
    const transformSegments = (segments: Data[], m: Matrix) => segments.map(s => {
        const out = { ...s };
        for (const key of ['point', 'control1', 'control2'])
            if (out[key])
                out[key] = transformPoint(out[key], m);
        return out;
    });
    function picture(n: MarkupNode, m: Matrix, common: Data, reason: string): Shape {
        warnings.push(reason);
        const remaining = SVG_IMPORT_LIMITS.fallbackBytes - fallbackBytes;
        if (definitions === undefined) {
            const parts: string[] = [];
            let length = 0;
            for (const value of defs.values())
                if (['clippath', 'mask', 'filter', 'lineargradient', 'radialgradient', 'pattern', 'symbol'].includes(value.tag)) {
                    const source = serializeLimited(value, remaining / 4 - length);
                    length += bytes(source);
                    parts.push(source);
                }
            definitions = parts.join('');
        }
        const original = serializeLimited(n, remaining), body = serializeLimited({ ...n, attrs: { ...n.attrs, transform: '' } }, remaining);
        const prefix = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><defs>`, middle = `</defs><g transform="matrix(${m.a} ${m.b} ${m.c} ${m.d} ${m.e - (options.x ?? 0)} ${m.f - (options.y ?? 0)})">`, suffix = '</g></svg>';
        // URI escaping costs at most three ASCII bytes per UTF-8 byte, plus the raw SVG copy.
        const cost = 4 * (bytes(prefix) + bytes(definitions) + bytes(middle) + bytes(body) + bytes(suffix)) + bytes(original) + 100;
        if (cost > remaining)
            throw new Error('SVG exceeds the fallback picture byte limit');
        fallbackBytes += cost;
        const source = prefix + definitions + middle + body + suffix;
        return shape('svg', { ...common, x: options.x ?? 0, y: options.y ?? 0, width, height, rotation: 0, fills: [], strokes: [], svg: source, viewBox: `0 0 ${width} ${height}`, image: { src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(source)}`, width, height, mimeType: 'image/svg+xml' }, svgOriginal: original });
    }
    function walk(n: MarkupNode, parent: string, parentMatrix: Matrix, inherited: Data, seen: Set<string>, depth = 0): string | null {
        if (++visits > SVG_IMPORT_LIMITS.visits || depth > SVG_IMPORT_LIMITS.depth)
            throw new Error('SVG expansion exceeds the traversal limit');
        if (n.tag === '#text' || ['defs', 'lineargradient', 'radialgradient', 'stop', 'clippath', 'mask', 'title', 'desc', 'metadata'].includes(n.tag))
            return null;
        const attrs = { ...Object.fromEntries(Object.entries(inherited).filter(([key]) => ['fill', 'fill-rule', 'fill-opacity', 'stroke', 'stroke-width', 'stroke-opacity', 'stroke-linecap', 'stroke-linejoin', 'stroke-dasharray', 'font-family', 'font-size', 'font-weight', 'font-style', 'text-anchor', 'visibility'].includes(key))), ...n.attrs, ...cssDeclarations(n.attrs.style ?? '') };
        if (attrs.display === 'none')
            return null;
        let m = multiply(parentMatrix, matrix(n.attrs.transform));
        if (n.tag === 'use') {
            const ref = (n.attrs.href ?? n.attrs['xlink:href'] ?? '').replace(/^#/, '');
            if (seen.has(ref))
                throw new Error('Cyclic SVG use');
            const source = defs.get(ref);
            if (!source) {
                warnings.push(`Missing SVG reference ${ref}`);
                return null;
            }
            m = multiply(m, { ...identity(), e: num(n.attrs.x), f: num(n.attrs.y) });
            return walk({ ...source, attrs: { ...source.attrs, ...Object.fromEntries(Object.entries(n.attrs).filter(([k]) => !['href', 'xlink:href', 'x', 'y', 'transform'].includes(k))) } }, parent, m, attrs, new Set([...seen, ref]), depth + 1);
        }
        if (++layers > SVG_IMPORT_LIMITS.layers)
            throw new Error('SVG exceeds the 2000 layer limit');
        const id = makeId(), common: Data = { id, name: n.attrs['data-name'] ?? n.attrs.id ?? n.tag, parentId: parent, enclosingFrameId: parent, opacity: num(attrs.opacity, 1), fills: paint(attrs.fill, num(attrs['fill-opacity'], 1)), strokes: attrs.stroke && attrs.stroke !== 'none' ? paint(attrs.stroke, num(attrs['stroke-opacity'], 1)).map(p => ({ ...p, width: num(attrs['stroke-width'], 1), cap: attrs['stroke-linecap'], join: attrs['stroke-linejoin'], dashes: attrs['stroke-dasharray']?.split(/[ ,]+/).map(Number) })) : [], fillRule: attrs['fill-rule'], svgAttributes: { ...n.attrs } };
        const paintRef = /url\(#([^)]*)\)/.exec(attrs.fill ?? '');
        const paintDef = paintRef ? defs.get(paintRef[1]) : undefined;
        const positionedText = n.tag === 'text' && n.children.some(child => child.tag === 'tspan' && ['x', 'y', 'dx', 'dy', 'rotate'].some(key => child.attrs[key] !== undefined));
        if (attrs['clip-path'] || attrs.mask || attrs.filter || paintDef && (paintDef.attrs.gradientunits === 'userSpaceOnUse' || paintDef.attrs.gradienttransform) || positionedText) {
            const image = picture(n, m, common, `SVG effects or positioned text on ${common.name} preserved as a picture`);
            retain(image);
            return id;
        }
        let s: Shape;
        if (['g', 'svg', 'symbol', 'a'].includes(n.tag)) {
            s = shape('group', { ...common, x: 0, y: 0, width: 0, height: 0, childIds: [] });
            retain(s);
            for (const child of n.children) {
                const cid = walk(child, id, m, attrs, seen, depth + 1);
                if (cid)
                    s.childIds!.push(cid);
            }
            const b = bounds(s.childIds!.flatMap(cid => objects[cid].corners));
            Object.assign(s, b, boxGeometry(b));
            return id;
        }
        if (n.tag === 'path' || ['polyline', 'polygon', 'line'].includes(n.tag)) {
            let segments: Data[] = [];
            if (n.tag === 'path')
                segments = parseSvgPath(n.attrs.d ?? '', SVG_IMPORT_LIMITS.segments - segmentCount);
            else if (n.tag === 'line')
                segments = [{ type: 'move', point: { x: num(n.attrs.x1), y: num(n.attrs.y1) } }, { type: 'line', point: { x: num(n.attrs.x2), y: num(n.attrs.y2) } }];
            else {
                const values: number[] = [];
                for (const match of (n.attrs.points ?? '').matchAll(/[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:e[-+]?\d+)?/gi)) {
                    if (values.length >= (SVG_IMPORT_LIMITS.segments - segmentCount) * 2)
                        throw new Error('SVG exceeds the 10000 segment limit');
                    values.push(Number(match[0]));
                }
                if (values.length % 2)
                    throw new Error('Odd SVG point coordinate');
                segments = Array.from({ length: values.length / 2 }, (_, i) => ({ type: i ? 'line' : 'move', point: { x: values[i * 2], y: values[i * 2 + 1] } }));
                if (n.tag === 'polygon')
                    segments.push({ type: 'close' });
            }
            if (segmentCount + segments.length > SVG_IMPORT_LIMITS.segments)
                throw new Error('SVG exceeds the 10000 segment limit');
            segmentCount += segments.length;
            segments = transformSegments(segments, m);
            const canonical = segments.map(segment => segment.type === 'close' ? { command: 'close' } : segment.type === 'curve' ? { command: 'curve', x: segment.point.x, y: segment.point.y, x1: segment.control1.x, y1: segment.control1.y, x2: segment.control2.x, y2: segment.control2.y } : { command: segment.type, x: segment.point.x, y: segment.point.y });
            const b = pathBounds(canonical);
            s = shape('path', { ...common, ...b, segments: canonical, content: canonical, closed: segments.at(-1)?.type === 'close' });
        }
        else if (['rect', 'circle', 'ellipse', 'image', 'text'].includes(n.tag)) {
            const x = n.tag === 'circle' || n.tag === 'ellipse' ? num(attrs.cx) - num(attrs.rx ?? attrs.r) : num(attrs.x), y = n.tag === 'circle' || n.tag === 'ellipse' ? num(attrs.cy) - num(attrs.ry ?? attrs.r) : num(attrs.y), w = n.tag === 'circle' || n.tag === 'ellipse' ? num(attrs.rx ?? attrs.r) * 2 : num(attrs.width, n.tag === 'text' ? 100 : 0), h = n.tag === 'circle' || n.tag === 'ellipse' ? num(attrs.ry ?? attrs.r) * 2 : num(attrs.height, n.tag === 'text' ? num(attrs['font-size'], 16) * 1.2 : 0), center = transformPoint({ x: x + w / 2, y: y + h / 2 }, m), sx = Math.hypot(m.a, m.b), sy = Math.hypot(m.c, m.d), type = n.tag === 'rect' ? 'rect' : n.tag === 'image' ? 'image' : n.tag === 'text' ? 'text' : 'ellipse';
            s = shape(type, { ...common, x: center.x - w * sx / 2, y: center.y - h * sy / 2, width: w * sx, height: h * sy, rotation: Math.atan2(m.b, m.a) * 180 / Math.PI, transform: { a: sx ? m.a / sx : 1, b: sx ? m.b / sx : 0, c: sy ? m.c / sy : 0, d: sy ? m.d / sy : 1, e: 0, f: 0 }, radii: n.tag === 'rect' ? num(attrs.rx ?? attrs.ry) : undefined });
            if (type === 'image')
                s.image = { src: attrs.href ?? attrs['xlink:href'] ?? '', width: w, height: h, mimeType: undefined };
            if (type === 'text') {
                const runs: Data[] = [];
                const content = (node: MarkupNode, style: Data) => {
                    const next = { ...style, ...node.attrs, ...cssDeclarations(node.attrs.style ?? '') };
                    if (node.tag === '#text')
                        runs.push({ text: node.text, fontFamily: next['font-family'] ?? 'serif', fontSize: num(next['font-size'], 16) * sy, fontWeight: next['font-weight'] ?? 400, fontStyle: next['font-style'], fills: paint(next.fill, 1) });
                    else
                        for (const child of node.children)
                            content(child, next);
                };
                content(n, attrs);
                s.content = { type: 'richText', verticalAlign: 'top', children: [{ textAlign: 'left', children: runs }] };
                s.autoResize = 'widthAndHeight';
                const metric = typeof document !== 'undefined' ? measureTextLayout(s, options) : { width: s.width, height: s.height, baseline: 0 };
                s.svgBaseline = { x: num(attrs.x), y: num(attrs.y), needsMeasurement: typeof document === 'undefined' };
                s.width = metric.width;
                s.height = metric.height;
                const fontScale = sy || 1, orientation = { a: m.a / fontScale, b: m.b / fontScale, c: m.c / fontScale, d: m.d / fontScale, e: 0, f: 0 };
                const desired = transformPoint({ x: num(attrs.x), y: num(attrs.y) }, m), anchorX = attrs['text-anchor'] === 'middle' ? s.width / 2 : attrs['text-anchor'] === 'end' ? s.width : 0;
                const offset = transformPoint({ x: anchorX - s.width / 2, y: metric.baseline - s.height / 2 }, orientation);
                s.x = desired.x - offset.x - s.width / 2;
                s.y = desired.y - offset.y - s.height / 2;
                s.transform = orientation;
                Object.assign(s, boxGeometry(s));
            }
        }
        else
            s = picture(n, m, common, `SVG ${n.tag} preserved as a picture`);
        retain(s);
        return id;
    }
    for (const node of svg.children) {
        const id = walk(node, options.parentId ?? 'root', initial, svg.attrs, new Set());
        if (id) {
            objects[id].opacity = (objects[id].opacity ?? 1) * num(svg.attrs.opacity, 1);
            rootIds.push(id);
        }
    }
    return { objects, rootIds, shapes: Object.values(objects), warnings: [...new Set(warnings)], width, height };
}
