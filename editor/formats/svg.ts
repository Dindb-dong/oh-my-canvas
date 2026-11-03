import type { Data, Matrix, Point, Shape } from '../contracts';
import { identity, multiply, transformPoint, bounds, boxGeometry, pathBounds } from '../geometry';
import { shape, uid, richText } from './model';
import { parseMarkup, cssDeclarations, serializeNode, type MarkupNode } from './markup';
import type { Imported, ImportOptions } from './html';
import { measureTextLayout } from '../layout';
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
function arc(from: Point, to: Point, rx: number, ry: number, angle: number, large: number, sweep: number): Data[] {
    rx = Math.abs(rx);
    ry = Math.abs(ry);
    if (!rx || !ry || from.x === to.x && from.y === to.y)
        return [{ type: 'line', point: to }];
    const phi = angle * Math.PI / 180, c = Math.cos(phi), s = Math.sin(phi), dx = (from.x - to.x) / 2, dy = (from.y - to.y) / 2, x = c * dx + s * dy, y = -s * dx + c * dy, lambda = x * x / (rx * rx) + y * y / (ry * ry);
    if (lambda > 1) {
        rx *= Math.sqrt(lambda);
        ry *= Math.sqrt(lambda);
    }
    const factor = (large === sweep ? -1 : 1) * Math.sqrt(Math.max(0, (rx * rx * ry * ry - rx * rx * y * y - ry * ry * x * x) / (rx * rx * y * y + ry * ry * x * x))), cxp = factor * rx * y / ry, cyp = -factor * ry * x / rx, cx = c * cxp - s * cyp + (from.x + to.x) / 2, cy = s * cxp + c * cyp + (from.y + to.y) / 2;
    const start = Math.atan2((y - cyp) / ry, (x - cxp) / rx);
    let delta = Math.atan2((-y - cyp) / ry, (-x - cxp) / rx) - start;
    if (sweep && delta < 0)
        delta += Math.PI * 2;
    if (!sweep && delta > 0)
        delta -= Math.PI * 2;
    const count = Math.ceil(Math.abs(delta) / (Math.PI / 2)), segments: Data[] = [];
    const p = (a: number) => ({ x: cx + rx * c * Math.cos(a) - ry * s * Math.sin(a), y: cy + rx * s * Math.cos(a) + ry * c * Math.sin(a) }), derivative = (a: number) => ({ x: -rx * c * Math.sin(a) - ry * s * Math.cos(a), y: -rx * s * Math.sin(a) + ry * c * Math.cos(a) });
    for (let i = 0; i < count; i++) {
        const a = start + delta * i / count, b = start + delta * (i + 1) / count, k = 4 / 3 * Math.tan((b - a) / 4), p0 = p(a), p1 = p(b), d0 = derivative(a), d1 = derivative(b);
        segments.push({ type: 'curve', control1: { x: p0.x + k * d0.x, y: p0.y + k * d0.y }, control2: { x: p1.x - k * d1.x, y: p1.y - k * d1.y }, point: i === count - 1 ? to : p1 });
    }
    return segments;
}
/** SVG path grammar interpreted into editable world-coordinate cubic segments. */
export function parseSvgPath(value: string): Data[] {
    const tokens = value.match(/[a-zA-Z]|[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:e[-+]?\d+)?/g) ?? [], segments: Data[] = [];
    let index = 0, command = '', p: Point = { x: 0, y: 0 }, start = { ...p }, lastControl: Point | null = null, lastKind = '';
    const take = () => {
        const t = tokens[index++];
        if (t === undefined || /[a-z]/i.test(t) && !/^[-+]?\d/.test(t))
            throw new Error('Invalid SVG path');
        const n = Number(t);
        if (!Number.isFinite(n))
            throw new Error('Invalid SVG path number');
        return n;
    };
    while (index < tokens.length) {
        if (/^[a-z]$/i.test(tokens[index]))
            command = tokens[index++];
        if (!command)
            throw new Error('SVG path command missing');
        const upper = command.toUpperCase(), relative = command !== upper, point = () => { const x = take(), y = take(); return { x: x + (relative ? p.x : 0), y: y + (relative ? p.y : 0) }; };
        if (upper === 'Z') {
            segments.push({ type: 'close' });
            p = { ...start };
            lastControl = null;
            command = '';
            continue;
        }
        const old = { ...p };
        switch (upper) {
            case 'M':
                p = point();
                start = { ...p };
                segments.push({ type: 'move', point: p });
                command = relative ? 'l' : 'L';
                break;
            case 'L':
                p = point();
                segments.push({ type: 'line', point: p });
                break;
            case 'H':
                p = { x: take() + (relative ? p.x : 0), y: p.y };
                segments.push({ type: 'line', point: p });
                break;
            case 'V':
                p = { x: p.x, y: take() + (relative ? p.y : 0) };
                segments.push({ type: 'line', point: p });
                break;
            case 'C': {
                const c1 = point(), c2 = point();
                p = point();
                segments.push({ type: 'curve', control1: c1, control2: c2, point: p });
                lastControl = c2;
                break;
            }
            case 'S': {
                const c1 = lastControl && ['C', 'S'].includes(lastKind) ? { x: 2 * p.x - lastControl.x, y: 2 * p.y - lastControl.y } : { ...p }, c2 = point();
                p = point();
                segments.push({ type: 'curve', control1: c1, control2: c2, point: p });
                lastControl = c2;
                break;
            }
            case 'Q':
            case 'T': {
                const q: Point = upper === 'Q' ? point() : lastControl && ['Q', 'T'].includes(lastKind) ? { x: 2 * p.x - lastControl.x, y: 2 * p.y - lastControl.y } : { ...p };
                p = point();
                segments.push({ type: 'curve', control1: { x: old.x + 2 / 3 * (q.x - old.x), y: old.y + 2 / 3 * (q.y - old.y) }, control2: { x: p.x + 2 / 3 * (q.x - p.x), y: p.y + 2 / 3 * (q.y - p.y) }, point: p });
                lastControl = q;
                break;
            }
            case 'A': {
                const flag = () => { const token = tokens[index]; if (!token || !/^([01])/.test(token))
                    throw new Error('Invalid SVG arc flag'); const value = Number(token[0]); if (token.length === 1)
                    index++;
                else
                    tokens[index] = token.slice(1); return value; };
                const rx = take(), ry = take(), a = take(), large = flag(), sweep = flag();
                p = point();
                segments.push(...arc(old, p, rx, ry, a, large, sweep));
                break;
            }
            default: throw new Error(`Unsupported SVG path command ${command}`);
        }
        if (!['C', 'S', 'Q', 'T'].includes(upper))
            lastControl = null;
        lastKind = upper;
        if (segments.length > 50000)
            throw new Error('SVG path too complex');
    }
    return segments;
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
        const definitions = [...defs.values()].filter(value => ['clippath', 'mask', 'filter', 'lineargradient', 'radialgradient', 'pattern', 'symbol'].includes(value.tag)).map(serializeNode).join('');
        const source = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><defs>${definitions}</defs><g transform="matrix(${m.a} ${m.b} ${m.c} ${m.d} ${m.e - (options.x ?? 0)} ${m.f - (options.y ?? 0)})">${serializeNode({ ...n, attrs: { ...n.attrs, transform: '' } })}</g></svg>`;
        return shape('svg', { ...common, x: options.x ?? 0, y: options.y ?? 0, width, height, rotation: 0, fills: [], strokes: [], svg: source, viewBox: `0 0 ${width} ${height}`, image: { src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(source)}`, width, height, mimeType: 'image/svg+xml' }, svgOriginal: serializeNode(n) });
    }
    function walk(n: MarkupNode, parent: string, parentMatrix: Matrix, inherited: Data, seen: Set<string>): string | null {
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
            return walk({ ...source, attrs: { ...source.attrs, ...Object.fromEntries(Object.entries(n.attrs).filter(([k]) => !['href', 'xlink:href', 'x', 'y', 'transform'].includes(k))) } }, parent, m, attrs, new Set([...seen, ref]));
        }
        const id = makeId(), common: Data = { id, name: n.attrs['data-name'] ?? n.attrs.id ?? n.tag, parentId: parent, enclosingFrameId: parent, opacity: num(attrs.opacity, 1), fills: paint(attrs.fill, num(attrs['fill-opacity'], 1)), strokes: attrs.stroke && attrs.stroke !== 'none' ? paint(attrs.stroke, num(attrs['stroke-opacity'], 1)).map(p => ({ ...p, width: num(attrs['stroke-width'], 1), cap: attrs['stroke-linecap'], join: attrs['stroke-linejoin'], dashes: attrs['stroke-dasharray']?.split(/[ ,]+/).map(Number) })) : [], fillRule: attrs['fill-rule'], svgAttributes: { ...n.attrs } };
        const paintRef = /url\(#([^)]*)\)/.exec(attrs.fill ?? '');
        const paintDef = paintRef ? defs.get(paintRef[1]) : undefined;
        const positionedText = n.tag === 'text' && n.children.some(child => child.tag === 'tspan' && ['x', 'y', 'dx', 'dy', 'rotate'].some(key => child.attrs[key] !== undefined));
        if (attrs['clip-path'] || attrs.mask || attrs.filter || paintDef && (paintDef.attrs.gradientunits === 'userSpaceOnUse' || paintDef.attrs.gradienttransform) || positionedText) {
            const image = picture(n, m, common, `SVG effects or positioned text on ${common.name} preserved as a picture`);
            objects[id] = image;
            return id;
        }
        let s: Shape;
        if (['g', 'svg', 'symbol', 'a'].includes(n.tag)) {
            s = shape('group', { ...common, x: 0, y: 0, width: 0, height: 0, childIds: [] });
            objects[id] = s;
            for (const child of n.children) {
                const cid = walk(child, id, m, attrs, seen);
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
                segments = parseSvgPath(n.attrs.d ?? '');
            else if (n.tag === 'line')
                segments = [{ type: 'move', point: { x: num(n.attrs.x1), y: num(n.attrs.y1) } }, { type: 'line', point: { x: num(n.attrs.x2), y: num(n.attrs.y2) } }];
            else {
                const values = (n.attrs.points?.match(/[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:e[-+]?\d+)?/gi) ?? []).map(Number);
                if (values.length % 2)
                    throw new Error('Odd SVG point coordinate');
                segments = Array.from({ length: values.length / 2 }, (_, i) => ({ type: i ? 'line' : 'move', point: { x: values[i * 2], y: values[i * 2 + 1] } }));
                if (n.tag === 'polygon')
                    segments.push({ type: 'close' });
            }
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
        objects[id] = s;
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
