/** Original cubic vector editing; endpoint and handle coordinates use world space. */
import type { Point, Shape, Data } from '../contracts';
import { pathBounds, updateGeometry, orientedPathBox, orientedPoint } from '../geometry';
type Segment = Data & {
    command: 'move' | 'line' | 'curve' | 'close';
};
const lerp = (a: Point, b: Point, t: number): Point => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
const kind = (segment: Data) => segment.command ?? segment.type;
function subpaths(segments: Segment[]): { start: number; end: number }[] {
    const paths: { start: number; end: number }[] = [];
    for (let i = 0; i < segments.length; i++) {
        if (!i || kind(segments[i]) === 'move' || kind(segments[i - 1]) === 'close')
            paths.push({ start: i, end: i + 1 });
        else
            paths.at(-1)!.end = i + 1;
    }
    return paths;
}
function checkNodes(segments: Segment[], indices: number[]): void {
    if (indices.some(index => !Number.isInteger(index) || !segments[index] || kind(segments[index]) === 'close'))
        throw new Error('Unknown path node');
}
export function pathSegments(shape: Shape): Segment[] {
    if (!Array.isArray(shape.content))
        shape.content = [];
    return shape.content;
}
export function pathNodes(shape: Shape): Data[] {
    return pathSegments(shape).map((segment, index) => ({ ...segment, index })).filter(s => kind(s) !== 'close');
}
export function pathPoint(segment: Data): Point {
    return { x: segment.x, y: segment.y };
}
function setControls(segment: Data, first: Point, second: Point): void {
    segment.command = 'curve';
    segment.x1 = first.x;
    segment.y1 = first.y;
    segment.x2 = second.x;
    segment.y2 = second.y;
    delete segment.c1;
    delete segment.c2;
}
function controls(segment: Data, from: Point): [
    Point,
    Point
] {
    return [{ x: segment.x1 ?? segment.c1?.x ?? from.x, y: segment.y1 ?? segment.c1?.y ?? from.y }, { x: segment.x2 ?? segment.c2?.x ?? segment.x, y: segment.y2 ?? segment.c2?.y ?? segment.y }];
}
export function refreshPath(shape: Shape): void {
    const segments = pathSegments(shape);
    if (segments.some(s => kind(s) !== 'close'))
        Object.assign(shape, orientedPathBox(segments, shape.transform));
    delete shape.primitive;
    for (const key of ['d', 'pathData', 'path', 'segments'])
        delete shape[key];
    updateGeometry(shape);
}
export function insertPathNode(shape: Shape, index: number, t = .5): number {
    const segments = pathSegments(shape);
    if (!Number.isInteger(index) || index < 1 || index >= segments.length || kind(segments[index]) === 'move' || kind(segments[index]) === 'close' || kind(segments[index - 1]) === 'close')
        throw new Error('Choose a segment between two nodes');
    if (!Number.isFinite(t) || t <= 0 || t >= 1)
        throw new Error('Split position must be inside the segment');
    const from = pathPoint(segments[index - 1]), segment = segments[index], to = pathPoint(segment);
    let inserted: Segment;
    if (kind(segment) === 'curve') {
        const [a, b] = controls(segment, from), ab = lerp(from, a, t), bc = lerp(a, b, t), cd = lerp(b, to, t), abc = lerp(ab, bc, t), bcd = lerp(bc, cd, t), mid = lerp(abc, bcd, t);
        inserted = { command: 'curve', ...mid };
        setControls(inserted, ab, abc);
        setControls(segment, bcd, cd);
    }
    else
        inserted = { command: 'line', ...lerp(from, to, t) };
    segments.splice(index, 0, inserted);
    refreshPath(shape);
    return index;
}
export function deletePathNodes(shape: Shape, indices: number[]): void {
    const original = pathSegments(shape), remove = new Set(indices), segments: Segment[] = [];
    checkNodes(original, indices);
    for (const { start, end } of subpaths(original)) {
        const nodes = original.slice(start, end).filter((s, i) => kind(s) !== 'close' && !remove.has(start + i));
        if (nodes.length) {
            nodes[0].command = 'move';
            for (const k of ['x1', 'y1', 'x2', 'y2', 'c1', 'c2'])
                delete nodes[0][k];
            segments.push(...nodes);
            if (nodes.length > 1 && kind(original[end - 1]) === 'close')
                segments.push({ command: 'close' });
        }
    }
    shape.content = segments;
    shape.closed = segments.some(s => kind(s) === 'close');
    refreshPath(shape);
}
export function movePathNodes(shape: Shape, indices: number[], dx: number, dy: number): void {
    const chosen = new Set(indices), segments = pathSegments(shape);
    checkNodes(segments, indices);
    if (!Number.isFinite(dx) || !Number.isFinite(dy))
        throw new Error('Path movement must be finite');
    for (const [i, s] of segments.entries())
        if (chosen.has(i) && kind(s) !== 'close') {
            s.x += dx;
            s.y += dy;
            if (kind(s) === 'curve') {
                s.x2 = (s.x2 ?? s.x - dx) + dx;
                s.y2 = (s.y2 ?? s.y - dy) + dy;
            }
            const next = segments[i + 1];
            if (next && kind(next) === 'curve') {
                next.x1 = (next.x1 ?? s.x - dx) + dx;
                next.y1 = (next.y1 ?? s.y - dy) + dy;
            }
        }
    refreshPath(shape);
}
export function setPathHandle(shape: Shape, index: number, handle: 'in' | 'out', point: Point, mode?: string): void {
    const segments = pathSegments(shape), s = segments[index];
    checkNodes(segments, [index]);
    const storedMode: string = mode ?? s.handleMode ?? shape.handleMode ?? 'free';
    const handleMode = storedMode === 'smooth' ? 'aligned' : storedMode === 'corner' ? 'free' : storedMode;
    if (!['in', 'out'].includes(handle) || !Number.isFinite(point?.x) || !Number.isFinite(point?.y))
        throw new Error('Choose a handle and finite coordinates');
    const p = pathPoint(s), incoming = handle === 'in', target = incoming ? s : segments[index + 1];
    if (!target || ['move', 'close'].includes(kind(target)) || (incoming && kind(s) === 'move'))
        throw new Error('Open endpoint has no handle on this side');
    const first = incoming ? { x: target.x1 ?? p.x, y: target.y1 ?? p.y } : point, second = incoming ? point : { x: target.x2 ?? target.x, y: target.y2 ?? target.y };
    setControls(target, first, second);
    if (['mirrored', 'symmetric', 'aligned', 'angle', 'angleLength'].includes(handleMode)) {
        const other = incoming ? segments[index + 1] : s;
        if (other && !['move', 'close'].includes(kind(other))) {
            const ox = incoming ? 'x1' : 'x2', oy = incoming ? 'y1' : 'y2', old = { x: other[ox] ?? p.x, y: other[oy] ?? p.y }, length = ['aligned', 'angle'].includes(handleMode) ? Math.hypot(old.x - p.x, old.y - p.y) : Math.hypot(point.x - p.x, point.y - p.y), angle = Math.atan2(point.y - p.y, point.x - p.x) + Math.PI, a = { x: p.x + Math.cos(angle) * length, y: p.y + Math.sin(angle) * length }, [c1, c2] = controls(other, p);
            setControls(other, incoming ? a : c1, incoming ? c2 : a);
        }
    }
    s.handleMode = handleMode;
    refreshPath(shape);
}
export function closePath(shape: Shape, closed = true, index?: number): void {
    const original = pathSegments(shape), segments: Segment[] = [];
    if (index !== undefined)
        checkNodes(original, [index]);
    for (const { start, end } of subpaths(original)) {
        if (index !== undefined && (index < start || index >= end)) {
            segments.push(...original.slice(start, end));
            continue;
        }
        const nodes = original.slice(start, end).filter(s => kind(s) !== 'close');
        segments.push(...nodes);
        if (closed && nodes.length > 1)
            segments.push({ command: 'close' });
    }
    shape.content = segments;
    shape.closed = segments.some(s => kind(s) === 'close');
    refreshPath(shape);
}
export function convertPathNode(shape: Shape, index: number, nodeKind: 'corner' | 'smooth' | 'symmetric'): void {
    const segments = pathSegments(shape), s = segments[index];
    checkNodes(segments, [index]);
    s.handleMode = nodeKind;
    const p = pathPoint(s), next = segments[index + 1];
    if (nodeKind === 'corner') {
        if (kind(s) === 'curve') {
            s.x2 = p.x;
            s.y2 = p.y;
        }
        if (next && kind(next) === 'curve') {
            next.x1 = p.x;
            next.y1 = p.y;
        }
    }
    else {
        const previous = segments[index - 1], a = previous && kind(s) !== 'move' && kind(previous) !== 'close' ? pathPoint(previous) : p, b = next && !['move', 'close'].includes(kind(next)) ? pathPoint(next) : p, dx = (b.x - a.x) / 6, dy = (b.y - a.y) / 6;
        if (previous && kind(s) !== 'move') {
            const [first] = controls(s, a);
            setControls(s, first, { x: p.x - dx, y: p.y - dy });
        }
        if (next && !['move', 'close'].includes(kind(next))) {
            const [, second] = controls(next, p);
            setControls(next, { x: p.x + dx, y: p.y + dy }, second);
        }
    }
    refreshPath(shape);
}
/** Reverse one open subpath and swap cubic handles without changing its geometry. */
export function reversePath(segments: Data[]): Segment[] {
    if (!segments.length)
        return [];
    if (segments.some(s => kind(s) === 'close') || segments.slice(1).some(s => kind(s) === 'move'))
        throw new Error('Choose one open subpath');
    const result: Segment[] = [{ command: 'move', ...pathPoint(segments.at(-1)!) }];
    for (let i = segments.length - 1; i > 0; i--) {
        const edge = segments[i], point = pathPoint(segments[i - 1]), segment: Segment = { command: kind(edge) === 'curve' ? 'curve' : 'line', ...point };
        if (kind(edge) === 'curve') {
            const [a, b] = controls(edge, point);
            setControls(segment, b, a);
        }
        result.push(segment);
    }
    return result;
}
export function joinPathEnds(shape: Shape, other?: Shape, options: Data = {}): void {
    let first = pathSegments(shape), second = other ? structuredClone(pathSegments(other)) : null;
    if (!first.length)
        throw new Error('Path is empty');
    if (subpaths(first).length !== 1 || second && subpaths(second).length !== 1)
        throw new Error('Choose one open subpath to join');
    if (second && !second.length)
        throw new Error('Path is empty');
    if (first.some(s => kind(s) === 'close'))
        throw new Error('Closed paths have no open ends');
    if (!second) {
        if (options.merge && first.length > 2) {
            const a = first[0], b = first.at(-1)!, mid = lerp(pathPoint(a), pathPoint(b), .5);
            a.x = mid.x;
            a.y = mid.y;
            b.x = mid.x;
            b.y = mid.y;
            first.pop();
        }
        closePath(shape, true);
        return;
    }
    if (second.some(s => kind(s) === 'close'))
        throw new Error('Closed paths have no open ends');
    if (options.firstStart)
        first = reversePath(first);
    if (options.secondEnd)
        second = reversePath(second);
    const end = pathPoint(first.at(-1)!), start = pathPoint(second[0]);
    if (options.merge || Math.hypot(end.x - start.x, end.y - start.y) < 1e-6) {
        const mid = lerp(end, start, .5), last = first.at(-1)!;
        last.x = mid.x;
        last.y = mid.y;
        second.shift();
    }
    else
        second[0].command = 'line';
    shape.content = [...first, ...second];
    refreshPath(shape);
}
export function regeneratePrimitive(shape: Shape, changes: Data = {}): void {
    const primitive = { ...shape.primitive, ...changes };
    if (!['polygon', 'star'].includes(primitive.kind))
        throw new Error('Path is not a polygon or star');
    const count = Math.max(3, Math.min(1000, Math.floor(primitive.count ?? 3))), ratio = Math.max(.001, Math.min(.999, primitive.ratio ?? .5)), c = { x: shape.x + shape.width / 2, y: shape.y + shape.height / 2 }, total = primitive.kind === 'star' ? count * 2 : count;
    shape.content = Array.from({ length: total }, (_, i) => {
        const angle = (-90 + i * 360 / total) * Math.PI / 180, r = primitive.kind === 'star' && i % 2 ? ratio : 1;
        return { command: i ? 'line' : 'move', x: c.x + Math.cos(angle) * shape.width * r / 2, y: c.y + Math.sin(angle) * shape.height * r / 2 };
    });
    shape.content.push({ command: 'close' });
    shape.content = shape.content.map((segment: Data) => segment.command === 'close' ? segment : { ...segment, ...orientedPoint(shape, segment as Point) });
    shape.primitive = { ...primitive, count, ...(primitive.kind === 'star' ? { ratio } : {}) };
    updateGeometry(shape);
}
