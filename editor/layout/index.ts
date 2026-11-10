import type { CanvasDocument, Data, EditorChangeScope, Rect, Shape } from '../contracts';
import { cachedTextMetric, retainTextMetric, textMetricKey } from '../render/metric-cache';
import { textHTML } from '../render/scene';
import { applyConstraints, moveShape, resizeShape } from '../geometry';
const finite = (value: any, fallback = 0): number => Number.isFinite(Number(value)) ? Number(value) : fallback;
const limit = (value: number, min: any, max: any) => Math.max(finite(min), Math.min(finite(max, Infinity), value));
const mode = (shape: Shape, axis: 'width' | 'height') => shape[axis === 'width' ? 'hSizing' : 'vSizing'] ?? shape[axis + 'Sizing'] ?? shape.layoutSizing?.[axis] ?? 'fixed';
function padding(layout: Data): number[] {
    const p = layout.padding ?? 0;
    if (typeof p === 'number')
        return [p, p, p, p];
    if (Array.isArray(p))
        return p.length === 2 ? [p[0], p[1], p[0], p[1]] : [p[0] ?? 0, p[1] ?? 0, p[2] ?? p[0] ?? 0, p[3] ?? p[1] ?? 0];
    return [p.top ?? 0, p.right ?? 0, p.bottom ?? 0, p.left ?? 0].map(v => finite(v));
}
function gaps(layout: Data) {
    return { row: finite(layout.gap?.row ?? layout.rowGap, finite(layout.gap)), column: finite(layout.gap?.column ?? layout.columnGap, finite(layout.gap)) };
}
const wraps = (layout: Data) => layout.wrap === true || layout.wrap === 'wrap' || layout.wrap === 'wrap-reverse';
function alignment(value: string, free: number, count: number): {
    offset: number;
    extra: number;
} {
    if (free < 0 && ['space-between', 'space-around', 'space-evenly'].includes(value))
        return { offset: 0, extra: 0 };
    if (value === 'center')
        return { offset: free / 2, extra: 0 };
    if (value === 'end' || value === 'flex-end')
        return { offset: free, extra: 0 };
    if (value === 'space-between' && count > 1)
        return { offset: 0, extra: free / (count - 1) };
    if (value === 'space-around' && count)
        return { offset: free / (2 * count), extra: free / count };
    if (value === 'space-evenly' && count)
        return { offset: free / (count + 1), extra: free / (count + 1) };
    return { offset: 0, extra: 0 };
}
function childrenOf(objects: Record<string, Shape>, parent: Shape) {
    return (parent.childIds ?? []).map(id => objects[id]).filter((child): child is Shape => !!child && !child.hidden && !child.absolute && child.layoutPositioning !== 'absolute');
}
function constrained(shape: Shape, axis: 'width' | 'height', value: number) {
    return limit(value, shape[axis === 'width' ? 'minWidth' : 'minHeight'], shape[axis === 'width' ? 'maxWidth' : 'maxHeight']);
}
/** Keep imported CSS anchors in sync with explicit edits, in the parent's local content space. */
function reconcileInlineGeometry(objects: Record<string, Shape>, previous: Record<string, Shape>, ids = Object.keys(objects)): void {
    const local = (shape: Shape, parent: Shape) => {
        const [top, right, bottom, left] = padding(parent.layout ?? {}), matrix = parent.inverseTransform ?? { a: 1, b: 0, c: 0, d: 1 }, cx = parent.x + parent.width / 2, cy = parent.y + parent.height / 2, dx = shape.x + shape.width / 2 - cx, dy = shape.y + shape.height / 2 - cy;
        return {
            x: cx + matrix.a * dx + matrix.c * dy - shape.width / 2 - parent.x - left, y: cy + matrix.b * dx + matrix.d * dy - shape.height / 2 - parent.y - top, width: shape.width, height: shape.height, contentWidth: Math.max(0, parent.width - left - right), contentHeight: Math.max(0, parent.height - top - bottom)
        };
    };
    for (const id of ids) {
        const shape = objects[id];
        const old = previous[shape.id], css = shape.inlineStyles;
        if (!old || !css || shape.id === shape.parentId)
            continue;
        const parent = objects[shape.parentId], oldParent = previous[old.parentId];
        if (!parent || !oldParent)
            continue;
        const reparented = shape.parentId !== old.parentId, geometryChanged = shape.x !== old.x || shape.y !== old.y || shape.width !== old.width || shape.height !== old.height;
        const current = local(geometryChanged || reparented ? shape : old, geometryChanged || reparented ? parent : oldParent);
        let next: Data | undefined;
        const update = (key: string, value: number, extent: number) => {
            const original = css[key];
            if (original === undefined || !Number.isFinite(value))
                return;
            if (typeof original !== 'number' && (typeof original !== 'string' || !/^[-+]?\d*\.?\d+(?:px|%)?$/.test(original.trim())))
                return;
            const percent = typeof original === 'string' && original.trim().endsWith('%') && extent > 0;
            const numeric = Math.round((percent ? value / extent * 100 : value) * 1e9) / 1e9;
            const valueText = typeof original === 'number' ? numeric : `${numeric}${percent ? '%' : 'px'}`;
            if(original===valueText)return;
            const target: Data = next ?? { ...css };
            next = target;
            target[key] = valueText;
        };
        if (shape.absolute) {
            update('left', current.x, current.contentWidth);
            update('top', current.y, current.contentHeight);
        }
        if (shape.maxWidth !== old.maxWidth && css['max-width'] === old.inlineStyles?.['max-width']) {
            const target: Data = next ?? { ...css };
            next = target;
            if (Number.isFinite(shape.maxWidth)) target['max-width'] = `${shape.maxWidth}px`;
            else delete target['max-width'];
        }
        update('width', current.width, current.contentWidth);
        update('height', current.height, current.contentHeight);
        if (next)
            shape.inlineStyles = next;
    }
}
const appearanceFields = new Set(['name', 'fills', 'strokes', 'opacity', 'shadows', 'blur', 'blurHidden', 'backgroundBlur', 'backgroundBlurHidden', 'locked', 'fillStyleId', 'strokeStyleId', 'effectStyleId', 'box', 'corners', 'inverseTransform', 'enclosingFrameId', 'pathContentVersion']);
/** Fixed, non-layout containers isolate sibling subtrees. Layout ancestors
 * remain a unit because intrinsic sizing and distribution can affect siblings.
 * Structural edits conservatively retain the complete affected-page pass.
 */
function affectedRoots(objects: Record<string, Shape>, previous: Record<string, Shape>, scope: EditorChangeScope, pageId: string): string[] {
    if (scope.topologyPages.has(pageId)) return ['root'];
    const roots = new Set<string>();
    const changed = scope.shapes.get(pageId);
    // Ancestors outside this complete change scope are immutable. Inspect them
    // without opening a mutable draft of their potentially large child list.
    const inspect = (id: string) => changed?.has(id) ? objects[id] : previous[id];
    for (const id of scope.shapes.get(pageId) ?? []) {
        let shape = objects[id];
        const old = previous[id];
        if (!shape) continue;
        if (old && Object.keys({ ...old, ...shape }).every(key => appearanceFields.has(key) || old[key] === shape[key])) continue;
        const seen = new Set<string>();
        while (shape.parentId !== shape.id) {
            if (seen.has(shape.id)) throw new Error('Cyclic layout parent chain');
            seen.add(shape.id);
            const parent = inspect(shape.parentId);
            if (!parent?.layout || parent.layout.type === 'none') break;
            shape = parent;
        }
        roots.add(shape.id);
    }
    return [...roots].filter(id => {
        const seen = new Set<string>(); let shape = objects[id];
        while (shape && shape.parentId !== shape.id) {
            if (seen.has(shape.id)) throw new Error('Cyclic layout parent chain');
            seen.add(shape.id);
            if (roots.has(shape.parentId)) return false;
            shape = inspect(shape.parentId);
        }
        return true;
    });
}
/** Measure intrinsic containers bottom-up, then assign available space top-down. */
export function applyLayout(doc: CanvasDocument, before?: CanvasDocument, options: Data = {}, scope?: EditorChangeScope): void {
    const pageIds = scope ? [...new Set([...scope.shapes.keys(), ...scope.topologyPages])] : Object.keys(doc.pagesById);
    for (const pageId of pageIds) {
        const page = doc.pagesById[pageId];
        if (!page) continue;
        const objects = page.objects;
        const roots = scope && before ? affectedRoots(objects, before.pagesById[pageId]?.objects ?? {}, scope, pageId) : ['root'];
        if (!roots.length) continue;
        const selected = new Set<string>(), stack = [...roots];
        while (stack.length) {
            const id = stack.pop()!;
            if (selected.has(id)) throw new Error('Cyclic or shared layout child');
            selected.add(id);
            const shape = objects[id];
            if (shape) stack.push(...shape.childIds ?? []);
        }
        const selectedIds = [...selected].filter(id => !!objects[id]);
        const place = (shape: Shape, rect: Rect) => {
            const dx = rect.x - shape.x, dy = rect.y - shape.y;
            resizeShape(shape, { ...rect, width: constrained(shape, 'width', rect.width), height: constrained(shape, 'height', rect.height) });
            const shift = (id: string) => {
                const child = objects[id];
                if (!child)
                    return;
                moveShape(child, dx, dy);
                for (const nested of child.childIds ?? [])
                    shift(nested);
            };
            if (dx || dy)
                for (const id of shape.childIds ?? [])
                    shift(id);
        };
        if (before)
            reconcileInlineGeometry(objects, before.pagesById[page.id]?.objects ?? {}, selectedIds);
        if (before) {
            const previous = before.pagesById[page.id]?.objects ?? {};
            for (const id of selectedIds) {
                const shape = objects[id];
                // A fixed ancestor outside the selected dependency subtree has
                // unchanged dimensions, so it cannot trigger constraints.
                if (scope && !selected.has(shape.parentId) && !scope.shapes.get(pageId)?.has(shape.parentId) && !scope.topologyPages.has(pageId)) continue;
                const oldParent = previous[shape.parentId], parent = objects[shape.parentId], old = previous[shape.id];
                if (!old || !parent || !oldParent || shape.parentId === shape.id)
                    continue;
                if (parent.layout && !shape.absolute)
                    continue;
                if (parent.width === oldParent.width && parent.height === oldParent.height)
                    continue;
                // Explicit child edits already express their requested geometry; constraints apply to unchanged children.
                if (shape.x !== old.x || shape.y !== old.y || shape.width !== old.width || shape.height !== old.height)
                    continue;
                const proxy = { ...shape, horizontalConstraint: shape.horizontalConstraint === 'leftAndRight' ? 'stretch' : shape.horizontalConstraint, verticalConstraint: shape.verticalConstraint === 'topAndBottom' ? 'stretch' : shape.verticalConstraint, constraints: { horizontal: shape.horizontalConstraint === 'leftAndRight' ? 'stretch' : shape.horizontalConstraint ?? shape.constraints?.horizontal, vertical: shape.verticalConstraint === 'topAndBottom' ? 'stretch' : shape.verticalConstraint ?? shape.constraints?.vertical } };
                const oldCenter = { x: oldParent.x + oldParent.width / 2, y: oldParent.y + oldParent.height / 2 }, inverse = oldParent.inverseTransform ?? { a: 1, b: 0, c: 0, d: 1 };
                const dx = shape.x + shape.width / 2 - oldCenter.x, dy = shape.y + shape.height / 2 - oldCenter.y;
                proxy.x = oldCenter.x + inverse.a * dx + inverse.c * dy - shape.width / 2;
                proxy.y = oldCenter.y + inverse.b * dx + inverse.d * dy - shape.height / 2;
                applyConstraints(proxy, oldParent, parent);
                const center = { x: parent.x + parent.width / 2, y: parent.y + parent.height / 2 }, matrix = parent.transform ?? { a: 1, b: 0, c: 0, d: 1 };
                const px = proxy.x + proxy.width / 2 - center.x, py = proxy.y + proxy.height / 2 - center.y;
                place(shape, { x: center.x + matrix.a * px + matrix.c * py - proxy.width / 2, y: center.y + matrix.b * px + matrix.d * py - proxy.height / 2, width: proxy.width, height: proxy.height });
            }
        }
        const prepareWidths = (parent: Shape) => {
            const layout = parent.layout ?? {};
            const [padTop, padRight, padBottom, padLeft] = padding(layout);
            const contentWidth = Math.max(0, parent.width - padLeft - padRight), contentHeight = Math.max(0, parent.height - padTop - padBottom);
            for (const id of parent.childIds ?? []) {
                const child = objects[id];
                if (!child)
                    continue;
                const css = child.inlineStyles ?? {};
                const oldParent = before?.pagesById[page.id]?.objects[parent.id], oldChild = before?.pagesById[page.id]?.objects[child.id];
                const responsive = !!before && (!oldChild || !oldParent || parent.width !== oldParent.width || parent.height !== oldParent.height);
                const percentage = (value: any, extent: number, fallback: number) => typeof value === 'string' && /^[-+]?\d*\.?\d+%$/.test(value.trim()) ? parseFloat(value) * extent / 100 : fallback;
                if (mode(parent, 'width') !== 'hug' && typeof css['max-width'] === 'string' && /^[-+]?\d*\.?\d+%$/.test(css['max-width'].trim()))
                    child.maxWidth = Math.max(0, percentage(css['max-width'], contentWidth, child.maxWidth));
                const width = !responsive || mode(parent, 'width') === 'hug' ? child.width : percentage(css.width, contentWidth, child.width), height = !responsive || mode(parent, 'height') === 'hug' ? child.height : percentage(css.height, contentHeight, child.height);
                let x = child.x, y = child.y;
                if (child.absolute && responsive) {
                    const pos = (value: any, extent: number) => typeof value === 'string' && value.endsWith('%') ? parseFloat(value) * extent / 100 : typeof value === 'number' || typeof value === 'string' && /^[-+]?\d*\.?\d+(px)?$/.test(value) ? parseFloat(String(value)) : undefined;
                    const left = pos(css.left, contentWidth), top = pos(css.top, contentHeight);
                    if (left !== undefined || top !== undefined) {
                        const inverse = parent.inverseTransform ?? { a: 1, b: 0, c: 0, d: 1 }, matrix = parent.transform ?? { a: 1, b: 0, c: 0, d: 1 }, cx = parent.x + parent.width / 2, cy = parent.y + parent.height / 2, dx = child.x + child.width / 2 - cx, dy = child.y + child.height / 2 - cy;
                        const localX = left !== undefined ? parent.x + padLeft + left : cx + inverse.a * dx + inverse.c * dy - width / 2, localY = top !== undefined ? parent.y + padTop + top : cy + inverse.b * dx + inverse.d * dy - height / 2;
                        const lx = localX + width / 2 - cx, ly = localY + height / 2 - cy;
                        x = cx + matrix.a * lx + matrix.c * ly - width / 2;
                        y = cy + matrix.b * lx + matrix.d * ly - height / 2;
                    }
                }
                if (x !== child.x || y !== child.y || width !== child.width || height !== child.height)
                    place(child, { x, y, width, height });
            }
            if (!parent.layout || mode(parent, 'width') === 'hug')
                return;
            const children = childrenOf(objects, parent), [top, right, bottom, left] = padding(layout), gap = gaps(layout), available = Math.max(0, parent.width - left - right);
            const assign = (child: Shape, width: number) => {
                if (width !== child.width)
                    resizeShape(child, { x: child.x, y: child.y, width: constrained(child, 'width', width), height: child.height });
            };
            if (layout.type === 'grid') {
                const tracks = trackSizes(layout.columns, children, 'width', available, gap.column, false);
                children.forEach((child, index) => {
                    if (mode(child, 'width') !== 'fill')
                        return;
                    const cell = child.gridCell ?? {}, column = Math.max(0, finite(cell.column, index % tracks.length + 1) - 1), span = Math.max(1, finite(cell.columnSpan, 1));
                    assign(child, tracks.slice(column, column + span).reduce((a, b) => a + b, 0) + Math.max(0, span - 1) * gap.column);
                });
            }
            else if (String(layout.direction).startsWith('column')) {
                for (const child of children)
                    if (mode(child, 'width') === 'fill' || (child.alignSelf ?? layout.alignItems) === 'stretch')
                        assign(child, available);
            }
            else {
                const lines: Shape[][] = [[]];
                let occupied = 0;
                for (const child of children) {
                    const width = mode(child, 'width') === 'fill' ? 0 : child.width;
                    if (wraps(layout) && occupied && occupied + gap.column + width > available) {
                        lines.push([]);
                        occupied = 0;
                    }
                    lines.at(-1)!.push(child);
                    occupied += width + (occupied ? gap.column : 0);
                }
                for (const line of lines) {
                    const fills = line.filter(child => mode(child, 'width') === 'fill'), fixed = line.filter(child => mode(child, 'width') !== 'fill').reduce((sum, child) => sum + child.width, 0), share = Math.max(0, (available - fixed - Math.max(0, line.length - 1) * gap.column) / Math.max(1, fills.length));
                    for (const child of fills)
                        assign(child, share);
                }
            }
        };
        const baselines = new Map<string, number>();
        const baselineOf = (shape: Shape) => finite(shape.baseline, baselines.get(shape.id) ?? shape.height);
        const visited = new Set<string>();
        const measure = (shape: Shape, force = false) => {
            if (visited.has(shape.id) && !force)
                return;
            visited.add(shape.id);
            prepareWidths(shape);
            for (const id of shape.childIds ?? [])
                if (objects[id])
                    measure(objects[id], force);
            if (shape.type === 'text' && typeof document !== 'undefined') {
                const metric = measureTextLayout(shape, options);
                baselines.set(shape.id, metric.baseline);
                if (shape.autoResize && shape.autoResize !== 'none')
                    place(shape, { x: shape.x, y: shape.y, width: shape.autoResize === 'widthAndHeight' ? metric.width : shape.width, height: metric.height });
            }
            const boundedWidth = constrained(shape, 'width', shape.width), boundedHeight = constrained(shape, 'height', shape.height);
            if (boundedWidth !== shape.width || boundedHeight !== shape.height)
                place(shape, { x: shape.x, y: shape.y, width: boundedWidth, height: boundedHeight });
            const layout = shape.layout;
            if (!layout || layout.type === 'none')
                return;
            const children = childrenOf(objects, shape), [top, right, bottom, left] = padding(layout), gap = gaps(layout);
            let width = shape.width, height = shape.height;
            if (layout.type === 'grid') {
                const columns = trackSizes(layout.columns, children, 'width', Infinity, gap.column, true);
                const rows = trackSizes(layout.rows, children, 'height', Infinity, gap.row, true, Math.max(1, columns.length));
                if (mode(shape, 'width') === 'hug')
                    width = columns.reduce((a, b) => a + b, 0) + Math.max(0, columns.length - 1) * gap.column + left + right;
                if (mode(shape, 'height') === 'hug')
                    height = rows.reduce((a, b) => a + b, 0) + Math.max(0, rows.length - 1) * gap.row + top + bottom;
            }
            else {
                const vertical = String(layout.direction).startsWith('column'), main = vertical ? 'height' : 'width', cross = vertical ? 'width' : 'height';
                const mainGap = vertical ? gap.row : gap.column;
                const total = children.reduce((sum, child) => sum + child[main], 0) + Math.max(0, children.length - 1) * mainGap;
                let extent = Math.max(0, ...children.map(child => child[cross]));
                if (wraps(layout) && mode(shape, main) !== 'hug') {
                    const available = vertical ? shape.height - top - bottom : shape.width - left - right;
                    const crossGap = vertical ? gap.column : gap.row;
                    let occupied = 0, lineExtent = 0, totalExtent = 0;
                    for (const child of children) {
                        if (occupied && occupied + mainGap + child[main] > available) {
                            totalExtent += lineExtent + crossGap;
                            occupied = 0;
                            lineExtent = 0;
                        }
                        occupied += child[main] + (occupied ? mainGap : 0);
                        lineExtent = Math.max(lineExtent, child[cross]);
                    }
                    extent = totalExtent + lineExtent;
                }
                if (mode(shape, main) === 'hug') {
                    if (vertical)
                        height = total + top + bottom;
                    else
                        width = total + left + right;
                }
                if (mode(shape, cross) === 'hug') {
                    if (vertical)
                        width = extent + left + right;
                    else
                        height = extent + top + bottom;
                }
            }
            if (width !== shape.width || height !== shape.height)
                place(shape, { x: shape.x, y: shape.y, width, height });
        };
        const arrange = (shape: Shape) => {
            measure(shape, true);
            const placeItem = (child: Shape, rect: Rect) => {
                const center = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }, origin = { x: shape.x + shape.width / 2, y: shape.y + shape.height / 2 }, matrix = shape.transform ?? { a: 1, b: 0, c: 0, d: 1 };
                const dx = center.x - origin.x, dy = center.y - origin.y;
                place(child, { ...rect, x: origin.x + matrix.a * dx + matrix.c * dy - rect.width / 2, y: origin.y + matrix.b * dx + matrix.d * dy - rect.height / 2 });
            };
            const layout = shape.layout;
            if (layout && layout.type !== 'none') {
                const children = childrenOf(objects, shape), [top, right, bottom, left] = padding(layout), gap = gaps(layout);
                const inner = { x: shape.x + left, y: shape.y + top, width: Math.max(0, shape.width - left - right), height: Math.max(0, shape.height - top - bottom) };
                if (layout.type === 'grid') {
                    const cols = trackSizes(layout.columns, children, 'width', inner.width, gap.column, mode(shape, 'width') === 'hug');
                    const rows = trackSizes(layout.rows, children, 'height', inner.height, gap.row, mode(shape, 'height') === 'hug', Math.max(1, cols.length));
                    children.forEach((child, index) => {
                        const cell = child.gridCell ?? {}, column = Math.max(0, finite(cell.column, index % cols.length + 1) - 1), row = Math.max(0, finite(cell.row, Math.floor(index / cols.length) + 1) - 1);
                        const spanX = Math.max(1, finite(cell.columnSpan, 1)), spanY = Math.max(1, finite(cell.rowSpan, 1));
                        const availableWidth = cols.slice(column, column + spanX).reduce((a, b) => a + b, 0) + gap.column * (spanX - 1), availableHeight = rows.slice(row, row + spanY).reduce((a, b) => a + b, 0) + gap.row * (spanY - 1);
                        const width = mode(child, 'width') === 'fill' ? availableWidth : child.width, height = mode(child, 'height') === 'fill' ? availableHeight : child.height;
                        const x = inner.x + cols.slice(0, column).reduce((a, b) => a + b, 0) + column * gap.column + alignment(cell.hAlign ?? layout.justifyItems, availableWidth - width, 1).offset;
                        const y = inner.y + rows.slice(0, row).reduce((a, b) => a + b, 0) + row * gap.row + alignment(cell.vAlign ?? layout.alignItems, availableHeight - height, 1).offset;
                        placeItem(child, { x, y, width, height });
                    });
                }
                else {
                    const vertical = String(layout.direction).startsWith('column'), reverse = String(layout.direction).endsWith('reverse'), main = vertical ? 'height' : 'width', cross = vertical ? 'width' : 'height';
                    const available = inner[main], across = inner[cross], mainGap = vertical ? gap.row : gap.column, crossGap = vertical ? gap.column : gap.row;
                    const items = children, lines: Shape[][] = [[]];
                    let used = 0;
                    for (const child of items) {
                        const extent = mode(child, main) === 'fill' ? 0 : child[main];
                        if (wraps(layout) && used && used + mainGap + extent > available) {
                            lines.push([]);
                            used = 0;
                        }
                        lines.at(-1)!.push(child);
                        used += extent + (used ? mainGap : 0);
                    }
                    if (reverse)
                        for (const line of lines)
                            line.reverse();
                    const extents = lines.map(line => Math.max(0, ...line.map(child => child[cross])));
                    const required = extents.reduce((a, b) => a + b, 0) + Math.max(0, lines.length - 1) * crossGap;
                    const content = alignment(layout.alignContent ?? 'start', across - required, lines.length);
                    let crossPosition = content.offset;
                    lines.forEach((line, lineIndex) => {
                        const fills = line.filter(child => mode(child, main) === 'fill');
                        let remaining = available - line.filter(child => !fills.includes(child)).reduce((sum, child) => sum + child[main], 0) - Math.max(0, line.length - 1) * mainGap;
                        const allocations = new Map<Shape, number>();
                        let pending = [...fills];
                        while (pending.length) {
                            const share = remaining / pending.length;
                            const clamped = pending.filter(child => constrained(child, main, share) !== share);
                            if (!clamped.length) {
                                for (const child of pending)
                                    allocations.set(child, Math.max(0, share));
                                break;
                            }
                            for (const child of clamped) {
                                const value = constrained(child, main, share);
                                allocations.set(child, value);
                                remaining -= value;
                            }
                            pending = pending.filter(child => !clamped.includes(child));
                        }
                        const sizes = line.map(child => allocations.get(child) ?? child[main]);
                        const free = available - sizes.reduce((a, b) => a + b, 0) - Math.max(0, line.length - 1) * mainGap;
                        const justify = layout.justifyContent ?? 'start';
                        const overflowFallback = (free < 0 && ['space-between', 'space-around', 'space-evenly'].includes(justify)) || (justify === 'space-between' && line.length === 1);
                        const effectiveJustify = overflowFallback ? (reverse && justify === 'space-between' ? 'end' : 'start') : reverse ? (justify === 'start' || justify === 'flex-start' ? 'end' : justify === 'end' || justify === 'flex-end' ? 'start' : justify) : justify;
                        const distribution = alignment(effectiveJustify, free, line.length);
                        let position = distribution.offset;
                        const extent = !wraps(layout) ? across : extents[lineIndex] + (layout.alignContent === 'stretch' ? (across - required) / lines.length : 0);
                        const baseline = Math.max(0, ...line.map(child => baselineOf(child)));
                        line.forEach((child, index) => {
                            const align = child.alignSelf ?? layout.alignItems ?? 'start';
                            let crossSize = child[cross];
                            if (align === 'stretch' || mode(child, cross) === 'fill')
                                crossSize = extent;
                            crossSize = constrained(child, cross, crossSize);
                            const crossOffset = align === 'baseline' && !vertical ? baseline - baselineOf(child) : alignment(align, extent - crossSize, 1).offset;
                            placeItem(child, { x: inner.x + (vertical ? crossPosition + crossOffset : position), y: inner.y + (vertical ? position : crossPosition + crossOffset), width: vertical ? crossSize : sizes[index], height: vertical ? sizes[index] : crossSize });
                            position += sizes[index] + mainGap + distribution.extra;
                        });
                        crossPosition += extent + crossGap + content.extra;
                    });
                }
            }
            for (const id of shape.childIds ?? [])
                if (objects[id])
                    arrange(objects[id]);
        };
        for (const id of roots) {
            const root = objects[id];
            if (root) { measure(root); arrange(root); }
        }
    }
}
function trackSizes(input: any, children: Shape[], axis: 'width' | 'height', available: number, gap: number, hug: boolean, columns = 1): number[] {
    const count = Array.isArray(input) ? Math.max(1, input.length) : Math.max(1, finite(input, axis === 'width' ? 1 : Math.ceil(children.length / columns)));
    const tracks: Data[] = (Array.isArray(input) ? input : Array.from({ length: count }, () => ({ type: 'auto' }))).map(track => typeof track === 'number' ? { type: 'fixed', size: track } : typeof track === 'string' ? track.endsWith('fr') ? { type: 'fr', weight: finite(track.slice(0, -2), 1) } : /^\d+(\.\d+)?(px)?$/.test(track) ? { type: 'fixed', size: parseFloat(track) } : { type: 'auto' } : track);
    const sizes = Array.from({ length: count }, (_, i) => tracks[i]?.type === 'fixed' ? finite(tracks[i].size ?? tracks[i].value) : typeof tracks[i] === 'number' ? finite(tracks[i]) : 0);
    children.forEach((child, index) => {
        const cell = child.gridCell ?? {};
        const start = Math.max(0, finite(cell[axis === 'width' ? 'column' : 'row'], axis === 'width' ? index % count + 1 : Math.floor(index / columns) + 1) - 1), span = Math.max(1, finite(cell[axis === 'width' ? 'columnSpan' : 'rowSpan'], 1));
        const end = Math.min(count, start + span), autos = Array.from({ length: Math.max(0, end - start) }, (_, n) => start + n).filter(i => tracks[i]?.type !== 'fixed' && typeof tracks[i] !== 'number');
        const fixed = sizes.slice(start, end).reduce((a, b) => a + b, 0) + gap * Math.max(0, end - start - 1), deficit = Math.max(0, child[axis] - fixed);
        if (autos.length)
            for (const i of autos)
                sizes[i] += deficit / autos.length;
    });
    const autos = tracks.map((track, i) => ({ track, i })).filter(({ track }) => track?.type !== 'fixed' && typeof track !== 'number');
    if (!hug && Number.isFinite(available) && autos.length) {
        const free = Math.max(0, available - sizes.reduce((a, b) => a + b, 0) - gap * Math.max(0, count - 1));
        const weight = autos.reduce((sum, { track }) => sum + finite(track.weight, 1), 0);
        for (const { i, track } of autos)
            sizes[i] += free * finite(track.weight, 1) / Math.max(weight, 1);
    }
    return sizes;
}
export function measureTextLayout(shape: Shape, options: Data = {}): {
    width: number;
    height: number;
    scrollWidth: number;
    scrollHeight: number;
    baseline: number;
} {
    const html = textHTML(shape, options), key = textMetricKey('layout', shape.width, shape.height, html);
    const cached = cachedTextMetric<{
        width: number;
        height: number;
        scrollWidth: number;
        scrollHeight: number;
        baseline: number;
    }>(key);
    if (cached)
        return { ...cached };
    const holder = document.createElement('div');
    Object.assign(holder.style, {
        position: 'fixed', left: '-100000px', top: '0', visibility: 'hidden', width: `${shape.width}px`, height: (shape.autoResize ?? 'none') === 'none' ? `${shape.height}px` : 'max-content'
    });
    holder.innerHTML = html;
    document.body.append(holder);
    try {
        const root = holder.firstElementChild as HTMLElement;
        const r = root.getBoundingClientRect();
        const run = root.querySelector('[data-run]');
        const marker = document.createElement('span');
        Object.assign(marker.style, {
            display: 'inline-block', width: '0', height: '0', padding: '0', verticalAlign: 'baseline'
        });
        run?.prepend(marker);
        const baseline = marker.getBoundingClientRect().top - r.top;
        marker.remove();
        const result = {
            width: Math.max(1, r.width), height: Math.max(1, r.height, root.scrollHeight), scrollWidth: root.scrollWidth, scrollHeight: root.scrollHeight, baseline
        };
        retainTextMetric(key, { ...result });
        return result;
    }
    finally {
        holder.remove();
    }
}
