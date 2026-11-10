import type { Point, Rect, Shape } from '../contracts';

export interface SpatialEntry { id: string; order: number; bounds: Rect }
interface Node { bounds: Rect; left?: Node; right?: Node; entries?: SpatialEntry[] }
const overlaps = (a: Rect, b: Rect) => a.x <= b.x + b.width && a.x + a.width >= b.x && a.y <= b.y + b.height && a.y + a.height >= b.y;
function extent(entries: SpatialEntry[]): Rect {
    let x = Infinity, y = Infinity, right = -Infinity, bottom = -Infinity;
    for (const e of entries) { x = Math.min(x, e.bounds.x); y = Math.min(y, e.bounds.y); right = Math.max(right, e.bounds.x + e.bounds.width); bottom = Math.max(bottom, e.bounds.y + e.bounds.height); }
    return { x, y, width: right - x, height: bottom - y };
}
/** Broad phase only; callers preserve exact geometry, clipping and paint-order semantics. */
export class SpatialIndex {
    private root?: Node;
    constructor(entries: SpatialEntry[]) {
        const build = (items: SpatialEntry[]): Node => {
            const bounds = extent(items);
            if (items.length <= 12) return { bounds, entries: items };
            const axis = bounds.width >= bounds.height ? 'x' : 'y';
            items.sort((a, b) => a.bounds[axis] - b.bounds[axis]);
            const half = Math.floor(items.length / 2);
            return { bounds, left: build(items.slice(0, half)), right: build(items.slice(half)) };
        };
        if (entries.length) this.root = build([...entries]);
    }
    query(bounds: Rect): SpatialEntry[] {
        const result: SpatialEntry[] = [];
        const visit = (node?: Node) => {
            if (!node || !overlaps(node.bounds, bounds)) return;
            if (node.entries) { for (const entry of node.entries) if (overlaps(entry.bounds, bounds)) result.push(entry); }
            else { visit(node.left); visit(node.right); }
        };
        visit(this.root);
        return result;
    }
}

export function hitBounds(shape: Shape): Rect | null {
    const points: Point[] = [...(shape.corners ?? [])];
    if (shape.type === 'path' || shape.type === 'boolean') {
        const segments = Array.isArray(shape.content) ? shape.content : shape.segments ?? shape.path?.segments ?? shape.content?.segments;
        if (!segments && (shape.d || shape.pathData || shape.path?.d)) return null;
        for (const part of segments ?? []) {
            for (const [x, y] of [['x', 'y'], ['x1', 'y1'], ['x2', 'y2']])
                if (Number.isFinite(part[x]) && Number.isFinite(part[y])) points.push({ x: part[x], y: part[y] });
            for (const key of ['point', 'to', 'control1', 'control2', 'c1', 'c2', 'handle1', 'handle2'])
                if (Number.isFinite(part[key]?.x) && Number.isFinite(part[key]?.y)) points.push(part[key]);
        }
    }
    if (!points.length) points.push({ x: shape.x, y: shape.y }, { x: shape.x + shape.width, y: shape.y + shape.height });
    if (!points.every(p => Number.isFinite(p.x) && Number.isFinite(p.y))) return null;
    const stroke = Math.max(0, ...(shape.strokes ?? []).filter((s: any) => !s.hidden).map((s: any) => s.width ?? 1)) / 2;
    let x = Infinity, y = Infinity, right = -Infinity, bottom = -Infinity;
    for (const point of points) { x = Math.min(x, point.x); y = Math.min(y, point.y); right = Math.max(right, point.x); bottom = Math.max(bottom, point.y); }
    return { x: x - stroke, y: y - stroke, width: right - x + stroke * 2, height: bottom - y + stroke * 2 };
}

export interface AxisEntry { value: number; id: string; order: number }
/** Axis alignment is global, so use sorted scalar candidates, not a 2D viewport query. */
export class SnapIndex {
    readonly x: AxisEntry[] = [];
    readonly y: AxisEntry[] = [];
    constructor(objects: Record<string, Shape>) {
        let order = 0;
        for (const shape of Object.values(objects)) {
            if (shape.id === 'root' || shape.hidden) continue;
            for (const value of [shape.x, shape.x + shape.width / 2, shape.x + shape.width]) this.x.push({ value, id: shape.id, order: order++ });
            for (const value of [shape.y, shape.y + shape.height / 2, shape.y + shape.height]) this.y.push({ value, id: shape.id, order: order++ });
        }
        for (const axis of [this.x, this.y]) axis.sort((a, b) => a.value - b.value || a.order - b.order);
    }
    nearest(axis: 'x' | 'y', value: number, threshold: number, excluded: ReadonlySet<string>): { value: number; distance: number } {
        const entries = this[axis];
        let lo = 0, hi = entries.length;
        while (lo < hi) { const mid = (lo + hi) >>> 1; if (entries[mid].value < value - threshold) lo = mid + 1; else hi = mid; }
        let best = value, distance = threshold, order = Infinity;
        for (let i = lo; i < entries.length && entries[i].value < value + threshold; i++) {
            const entry = entries[i], next = Math.abs(entry.value - value);
            if (!excluded.has(entry.id) && (next < distance || next === distance && next < threshold && entry.order < order)) { best = entry.value; distance = next; order = entry.order; }
        }
        return { value: best, distance };
    }
}
