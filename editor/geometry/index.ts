/** Original implementation from the independent interoperability contract and affine algebra. */
import type { Point, Rect, Matrix, Shape, Viewport, Data } from '../contracts';
export const identity = (): Matrix => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
export const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));
export function multiply(a: Matrix, b: Matrix): Matrix {
    return { a: a.a * b.a + a.c * b.b, b: a.b * b.a + a.d * b.b, c: a.a * b.c + a.c * b.d, d: a.b * b.c + a.d * b.d, e: a.a * b.e + a.c * b.f + a.e, f: a.b * b.e + a.d * b.f + a.f };
}
export function inverse(m: Matrix): Matrix {
    const det = m.a * m.d - m.b * m.c;
    if (Math.abs(det) < 1e-12)
        throw new Error('Singular transformation');
    return { a: m.d / det, b: -m.b / det, c: -m.c / det, d: m.a / det, e: (m.c * m.f - m.d * m.e) / det, f: (m.b * m.e - m.a * m.f) / det };
}
export const transformPoint = (p: Point, m: Matrix): Point => ({ x: m.a * p.x + m.c * p.y + m.e, y: m.b * p.x + m.d * p.y + m.f });
export const add = (a: Point, b: Point): Point => ({ x: a.x + b.x, y: a.y + b.y });
export const subtract = (a: Point, b: Point): Point => ({ x: a.x - b.x, y: a.y - b.y });
export const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
export function rotationMatrix(angle: number, flipX = false, flipY = false): Matrix {
    const r = angle * Math.PI / 180, c = Math.cos(r), s = Math.sin(r), x = flipX ? -1 : 1, y = flipY ? -1 : 1;
    return { a: c * x, b: s * x, c: -s * y, d: c * y, e: 0, f: 0 };
}
export function rectOf(value: any): Rect {
    return { x: Number(value.x ?? 0), y: Number(value.y ?? 0), width: Number(value.width ?? value.w ?? 0), height: Number(value.height ?? value.h ?? 0) };
}
export function normalizeRect(r: Rect): Rect {
    return { x: Math.min(r.x, r.x + r.width), y: Math.min(r.y, r.y + r.height), width: Math.abs(r.width), height: Math.abs(r.height) };
}
export function center(r: Rect): Point {
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
}
export function rectCorners(r: Rect): Point[] {
    return [{ x: r.x, y: r.y }, { x: r.x + r.width, y: r.y }, { x: r.x + r.width, y: r.y + r.height }, { x: r.x, y: r.y + r.height }];
}
export function bounds(points: Point[]): Rect {
    if (!points.length)
        return { x: 0, y: 0, width: 0, height: 0 };
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of points) {
        minX = Math.min(minX, p.x);
        minY = Math.min(minY, p.y);
        maxX = Math.max(maxX, p.x);
        maxY = Math.max(maxY, p.y);
    }
    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}
export function unionBounds(rects: Rect[]): Rect {
    return bounds(rects.flatMap(rectCorners));
}
export function boxGeometry(input: any): Pick<Shape, 'box' | 'corners' | 'transform' | 'inverseTransform' | 'rotation'> {
    const box = rectOf(input), rotation = Number(input.rotation ?? 0), matrix = input.transform ? { ...input.transform, e: 0, f: 0 } : rotationMatrix(rotation, !!input.flipX, !!input.flipY), origin = center(box);
    return { box, corners: rectCorners(box).map(p => add(transformPoint(subtract(p, origin), matrix), origin)), transform: matrix, inverseTransform: inverse(matrix), rotation };
}
export function updateGeometry(shape: Shape): Shape {
    Object.assign(shape, boxGeometry(shape));
    return shape;
}
function vectorContent(shape: Shape): boolean {
    return Array.isArray(shape.content) && ['path', 'boolean'].includes(shape.type);
}
function mapBetweenBoxes(shape: Shape, old: Rect, oldMatrix: Matrix, next: Rect, nextMatrix: Matrix): void {
    if (!vectorContent(shape))
        return;
    const inv = inverse(oldMatrix), oldCenter = center(old), nextCenter = center(next);
    shape.content = mapPathPoints(shape.content, p => {
        const local = transformPoint(subtract(p, oldCenter), inv), scaled = { x: local.x * (old.width ? next.width / old.width : 1), y: local.y * (old.height ? next.height / old.height : 1) };
        return add(transformPoint(scaled, nextMatrix), nextCenter);
    });
}
/** Direct scalar inspector/layout edits receive the same vector mapping as gesture helpers. */
export function reconcileShapeGeometry(before: Shape | undefined, after: Shape): void {
    const orientationChanged = !!before && (before.rotation !== after.rotation || !!before.flipX !== !!after.flipX || !!before.flipY !== !!after.flipY);
    const desired = orientationChanged ? rotationMatrix(after.rotation, !!after.flipX, !!after.flipY) : after.transform ?? rotationMatrix(after.rotation, !!after.flipX, !!after.flipY);
    if (before && vectorContent(after) && JSON.stringify(before.content) === JSON.stringify(after.content)) {
        const changed = ['x', 'y', 'width', 'height'].some(key => before[key] !== after[key]) || orientationChanged || ['a', 'b', 'c', 'd'].some(key => (before.transform ?? identity())[key as keyof Matrix] !== desired[key as keyof Matrix]);
        if (changed)
            mapBetweenBoxes(after, rectOf(before), before.transform ?? identity(), rectOf(after), desired);
    }
    after.transform = { ...desired, e: 0, f: 0 };
    updateGeometry(after);
}
export function setShapeOrientation(shape: Shape, rotation: number, flipX = !!shape.flipX, flipY = !!shape.flipY): void {
    const before = shape.transform ?? rotationMatrix(shape.rotation, !!shape.flipX, !!shape.flipY), next = rotationMatrix(rotation, flipX, flipY), box = rectOf(shape);
    mapBetweenBoxes(shape, box, before, box, next);
    shape.rotation = rotation;
    shape.flipX = flipX;
    shape.flipY = flipY;
    shape.transform = next;
    updateGeometry(shape);
}
export function orientedPoint(shape: Shape, p: Point): Point {
    const c = center(shape);
    return add(transformPoint(subtract(p, c), shape.transform ?? rotationMatrix(shape.rotation)), c);
}
export function unorientPoint(shape: Shape, p: Point): Point {
    const c = center(shape);
    return add(transformPoint(subtract(p, c), inverse(shape.transform ?? rotationMatrix(shape.rotation))), c);
}
export const shapeBounds = (shape: Shape): Rect => bounds(boxGeometry(shape).corners);
export const containsPoint = (r: Rect, p: Point) => p.x >= r.x && p.y >= r.y && p.x <= r.x + r.width && p.y <= r.y + r.height;
export function flattenPath(content: Data[], precision = .25): {
    points: Point[];
    closed: boolean;
}[] {
    const paths: {
        points: Point[];
        closed: boolean;
    }[] = [];
    let current: {
        points: Point[];
        closed: boolean;
    } | undefined, previous: Point | undefined;
    const mid = (a: Point, b: Point) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
    const lineDistance = (p: Point, a: Point, b: Point) => {
        const length = Math.hypot(b.x - a.x, b.y - a.y);
        return length ? Math.abs((b.x - a.x) * (a.y - p.y) - (a.x - p.x) * (b.y - a.y)) / length : distance(p, a);
    };
    function curve(a: Point, b: Point, c: Point, d: Point, out: Point[], depth = 0): void {
        if (depth >= 18 || (Math.max(lineDistance(b, a, d), lineDistance(c, a, d)) <= precision && distance(a, b) + distance(b, c) + distance(c, d) - distance(a, d) <= precision)) {
            out.push(d);
            return;
        }
        const ab = mid(a, b), bc = mid(b, c), cd = mid(c, d), abc = mid(ab, bc), bcd = mid(bc, cd), m = mid(abc, bcd);
        curve(a, ab, abc, m, out, depth + 1);
        curve(m, bcd, cd, d, out, depth + 1);
    }
    for (const s of content) {
        if (s.command === 'close') {
            if (current)
                current.closed = true;
            previous = current?.points[0];
            continue;
        }
        const p = { x: s.x, y: s.y };
        if (s.command === 'move' || !current) {
            current = { points: [p], closed: false };
            paths.push(current);
        }
        else if (s.command === 'curve' && previous)
            curve(previous, { x: s.x1, y: s.y1 }, { x: s.x2, y: s.y2 }, p, current.points);
        else
            current.points.push(p);
        previous = p;
    }
    return paths;
}
export function hitTest(shape: Shape, p: Point, tolerance = 0): boolean {
    if (vectorContent(shape)) {
        const paths = flattenPath(shape.content, Math.max(.05, tolerance / 4)), painted = (shape.fills ?? []).some((paint: Data) => !paint.hidden && (paint.opacity ?? 1) > 0), stroke = Math.max(0, ...(shape.strokes ?? []).filter((s: Data) => !s.hidden).map((s: Data) => s.width ?? 1)) / 2 + tolerance;
        let winding = 0, crossings = 0;
        for (const path of paths) {
            const points = path.points;
            for (let i = 0; i < points.length; i++) {
                const a = points[i], b = points[(i + 1) % points.length], dx = b.x - a.x, dy = b.y - a.y, length = dx * dx + dy * dy, t = length ? clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / length, 0, 1) : 0;
                if ((i < points.length - 1 || path.closed) && Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy) <= stroke)
                    return true;
                if ((a.y > p.y) !== (b.y > p.y)) {
                    const x = a.x + (p.y - a.y) * (b.x - a.x) / (b.y - a.y);
                    if (x > p.x) {
                        crossings++;
                        winding += b.y > a.y ? 1 : -1;
                    }
                }
            }
        }
        return painted && (shape.fillRule === 'evenodd' ? crossings % 2 === 1 : winding !== 0);
    }
    const q = unorientPoint(shape, p), r = rectOf(shape);
    if (shape.type === 'ellipse') {
        const rx = r.width / 2 + tolerance, ry = r.height / 2 + tolerance, c = center(r);
        return rx > 0 && ry > 0 && ((q.x - c.x) / rx) ** 2 + ((q.y - c.y) / ry) ** 2 <= 1;
    }
    return containsPoint({ x: r.x - tolerance, y: r.y - tolerance, width: r.width + 2 * tolerance, height: r.height + 2 * tolerance }, q);
}
export const intersects = (a: Rect, b: Rect) => a.x <= b.x + b.width && a.x + a.width >= b.x && a.y <= b.y + b.height && a.y + a.height >= b.y;
export function screenToWorld(point: Point, viewport: Viewport): Point;
export function screenToWorld(viewport: Viewport, point: Point): Point;
export function screenToWorld(first: Point | Viewport, second: Point | Viewport): Point {
    const viewport = ('vbox' in first ? first : second) as Viewport, point = ('vbox' in first ? second : first) as Point;
    return { x: viewport.vbox.x + point.x / viewport.zoom, y: viewport.vbox.y + point.y / viewport.zoom };
}
export function worldToScreen(point: Point, viewport: Viewport): Point;
export function worldToScreen(viewport: Viewport, point: Point): Point;
export function worldToScreen(first: Point | Viewport, second: Point | Viewport): Point {
    const viewport = ('vbox' in first ? first : second) as Viewport, point = ('vbox' in first ? second : first) as Point;
    return { x: (point.x - viewport.vbox.x) * viewport.zoom, y: (point.y - viewport.vbox.y) * viewport.zoom };
}
export function zoomAt(viewport: Viewport, zoom: number, anchor: Point = { x: viewport.vport.width / 2, y: viewport.vport.height / 2 }): Viewport {
    zoom = clamp(zoom, 0.01, 200);
    const p = screenToWorld(anchor, viewport);
    return { vport: { ...viewport.vport }, zoom, vbox: { x: p.x - anchor.x / zoom, y: p.y - anchor.y / zoom, width: viewport.vport.width / zoom, height: viewport.vport.height / zoom } };
}
export function fitViewport(viewport: Viewport, rect: Rect, padding = 64): Viewport {
    const z = clamp(Math.min((viewport.vport.width - 2 * padding) / Math.max(rect.width, 1), (viewport.vport.height - 2 * padding) / Math.max(rect.height, 1)), 0.01, 200), c = center(rect);
    return { vport: { ...viewport.vport }, zoom: z, vbox: { x: c.x - viewport.vport.width / (2 * z), y: c.y - viewport.vport.height / (2 * z), width: viewport.vport.width / z, height: viewport.vport.height / z } };
}
export function panViewport(viewport: Viewport, dx: number, dy: number): Viewport {
    return { ...viewport, vbox: { ...viewport.vbox, x: viewport.vbox.x + dx / viewport.zoom, y: viewport.vbox.y + dy / viewport.zoom } };
}
/** Walk only coordinate-bearing vector fields; metadata and radii remain untouched. */
export function mapPathPoints(value: any, map: (p: Point) => Point): any {
    if (Array.isArray(value))
        return value.map(v => mapPathPoints(v, map));
    if (!value || typeof value !== 'object')
        return value;
    const result: Data = { ...value };
    if (typeof value.x === 'number' && typeof value.y === 'number')
        Object.assign(result, map({ x: value.x, y: value.y }));
    for (const suffix of ['1', '2'])
        if (typeof value['x' + suffix] === 'number' && typeof value['y' + suffix] === 'number') {
            const p = map({ x: value['x' + suffix], y: value['y' + suffix] });
            result['x' + suffix] = p.x;
            result['y' + suffix] = p.y;
        }
    for (const [k, v] of Object.entries(value))
        if (v && typeof v === 'object')
            result[k] = mapPathPoints(v, map);
    return result;
}
export function moveShape(shape: Shape, dx: number, dy: number): Shape {
    shape.x += dx;
    shape.y += dy;
    if (vectorContent(shape))
        shape.content = mapPathPoints(shape.content, p => ({ x: p.x + dx, y: p.y + dy }));
    return updateGeometry(shape);
}
export function resizeShape(shape: Shape, rect: Rect): Shape {
    const old = rectOf(shape), next = normalizeRect(rect), oldMatrix = shape.transform ?? rotationMatrix(shape.rotation, !!shape.flipX, !!shape.flipY);
    if (rect.width < 0)
        shape.flipX = !shape.flipX;
    if (rect.height < 0)
        shape.flipY = !shape.flipY;
    const matrix = rect.width < 0 || rect.height < 0 ? rotationMatrix(shape.rotation, !!shape.flipX, !!shape.flipY) : oldMatrix;
    mapBetweenBoxes(shape, old, oldMatrix, next, matrix);
    Object.assign(shape, next);
    shape.transform = matrix;
    return updateGeometry(shape);
}
export function transformShapes(shapes: Shape[], matrix: Matrix): void {
    for (const shape of shapes) {
        const oldCenter = center(shape), newCenter = transformPoint(oldCenter, matrix), linear = { ...matrix, e: 0, f: 0 }, combined = multiply(linear, shape.transform ?? identity()), sx = Math.hypot(combined.a, combined.b) || 1, sy = Math.hypot(combined.c, combined.d) || 1;
        if (vectorContent(shape))
            shape.content = mapPathPoints(shape.content, p => transformPoint(p, matrix));
        shape.width *= sx;
        shape.height *= sy;
        shape.x = newCenter.x - shape.width / 2;
        shape.y = newCenter.y - shape.height / 2;
        shape.transform = { a: combined.a / sx, b: combined.b / sx, c: combined.c / sy, d: combined.d / sy, e: 0, f: 0 };
        shape.rotation = Math.atan2(shape.transform.b, shape.transform.a) * 180 / Math.PI;
        updateGeometry(shape);
    }
}
export function orientedPathBox(content: Data[], matrix: Matrix): Rect {
    const local = pathBounds(mapPathPoints(content, p => transformPoint(p, inverse(matrix)))), worldCenter = transformPoint(center(local), matrix);
    return { x: worldCenter.x - local.width / 2, y: worldCenter.y - local.height / 2, width: local.width, height: local.height };
}
export function applyConstraints(child: Shape, before: Rect, after: Rect): void {
    const c = child.constraints ?? {}, dx = after.x - before.x, dy = after.y - before.y, dw = after.width - before.width, dh = after.height - before.height, r = rectOf(child);
    for (const axis of ['x', 'y'] as const) {
        const horizontal = axis === 'x', size = horizontal ? 'width' : 'height', mode = child[horizontal ? 'horizontalConstraint' : 'verticalConstraint'] ?? c[horizontal ? 'horizontal' : 'vertical'] ?? c[axis] ?? 'start', delta = horizontal ? dw : dh, shift = horizontal ? dx : dy, oldSize = horizontal ? before.width : before.height, newSize = horizontal ? after.width : after.height;
        if (mode === 'scale' && oldSize) {
            r[axis] = after[axis] + (r[axis] - before[axis]) * newSize / oldSize;
            r[size] *= newSize / oldSize;
        }
        else {
            r[axis] += shift + (mode === 'end' || mode === 'right' || mode === 'bottom' ? delta : mode === 'center' ? delta / 2 : 0);
            if (mode === 'stretch' || mode === 'both' || mode === 'leftRight' || mode === 'topBottom'||mode==='leftAndRight'||mode==='topAndBottom')
                r[size] = Math.max(0, r[size] + delta);
        }
    }
    resizeShape(child, r);
}
export function snapPoint(point: Point, targets: Point[], threshold: number, grid?: number): Point {
    const result = { ...point };
    if (grid && grid > 0) {
        result.x = Math.round(result.x / grid) * grid;
        result.y = Math.round(result.y / grid) * grid;
    }
    for (const axis of ['x', 'y'] as const) {
        let distance = threshold;
        for (const target of targets) {
            const d = Math.abs(point[axis] - target[axis]);
            if (d < distance) {
                distance = d;
                result[axis] = target[axis];
            }
        }
    }
    return result;
}
export function polygonPoints(rect: Rect, count = 3, star = false, innerRatio = .5, angle = -90): Point[] {
    const c = center(rect), n = Math.max(3, Math.floor(count)), total = star ? n * 2 : n;
    return Array.from({ length: total }, (_, i) => {
        const a = (angle + i * 360 / total) * Math.PI / 180, r = star && i % 2 ? innerRatio : 1;
        return { x: c.x + Math.cos(a) * rect.width * r / 2, y: c.y + Math.sin(a) * rect.height * r / 2 };
    });
}
/** Cubic extrema are solved analytically instead of using the control polygon. */
export function pathBounds(segments: any[]): Rect {
    const points: Point[] = [];
    let previous: Point | undefined, start: Point | undefined;
    const evaluate = (a: number, b: number, c: number, d: number, t: number) => ((1 - t) ** 3) * a + 3 * ((1 - t) ** 2) * t * b + 3 * (1 - t) * t * t * c + t * t * t * d;
    function roots(a: number, b: number, c: number, d: number): number[] {
        const A = -a + 3 * b - 3 * c + d, B = 2 * (a - 2 * b + c), C = b - a;
        if (Math.abs(A) < 1e-12)
            return Math.abs(B) < 1e-12 ? [] : [-C / B];
        const disc = B * B - 4 * A * C;
        if (disc < 0)
            return [];
        return [(-B + Math.sqrt(disc)) / (2 * A), (-B - Math.sqrt(disc)) / (2 * A)];
    }
    for (const segment of segments) {
        const command = segment.command ?? segment.type;
        if (command === 'close') {
            if (start)
                points.push(start);
            previous = start;
            continue;
        }
        const p = { x: segment.x, y: segment.y };
        if (!Number.isFinite(p.x) || !Number.isFinite(p.y))
            continue;
        points.push(p);
        if (command === 'move') {
            start = p;
            previous = p;
            continue;
        }
        if (command === 'curve' && previous) {
            const a = previous, b = { x: segment.x1 ?? segment.c1?.x ?? a.x, y: segment.y1 ?? segment.c1?.y ?? a.y }, c = { x: segment.x2 ?? segment.c2?.x ?? p.x, y: segment.y2 ?? segment.c2?.y ?? p.y };
            for (const t of [...roots(a.x, b.x, c.x, p.x), ...roots(a.y, b.y, c.y, p.y)])
                if (t > 0 && t < 1)
                    points.push({ x: evaluate(a.x, b.x, c.x, p.x, t), y: evaluate(a.y, b.y, c.y, p.y, t) });
        }
        previous = p;
    }
    return bounds(points);
}
export const getBounds = shapeBounds;
export const invert = inverse;
