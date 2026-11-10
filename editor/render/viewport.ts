import type { Data, Rect, Shape } from '../contracts';
import { hitBounds } from './spatial';

const intersects = (a: Rect, b: Rect) => a.x <= b.x + b.width && a.x + a.width >= b.x && a.y <= b.y + b.height && a.y + a.height >= b.y;
const contains = (a: Rect, b: Rect) => a.x <= b.x && a.y <= b.y && a.x + a.width >= b.x + b.width && a.y + a.height >= b.y + b.height;
function union(a: Rect, b: Rect): Rect {
    const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
    return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y };
}

/** Backdrop filters can sample other roots, so screen preparation must keep them. */
export function hasBackdropDependency(shape: Shape): boolean {
    if (shape.hidden || shape.visible === false) return false;
    if (!shape.backgroundBlurHidden && Number(shape.backgroundBlur)) return true;
    return !!shape.effects?.some((effect: Data) => {
        const type = String(effect.type).replace(/[-_]/g, '').toLowerCase();
        return (type === 'backgroundblur' || type === 'backdropblur') && Number(effect.radius ?? effect.blur);
    });
}

function hasFilterDependency(shape: Shape): boolean {
    return !!(shape.effects?.some((effect: Data) => !effect.hidden && effect.visible !== false) ||
        shape.shadows?.some((shadow: Data) => !shadow.hidden) ||
        !shape.blurHidden && shape.blur || !shape.backgroundBlurHidden && shape.backgroundBlur);
}

/** Removing a child can change a sibling's mask or an ancestor's filtered output.
 * Those subtrees remain complete even when their individual children are offscreen. */
function keepChildrenTogether(shape: Shape): boolean {
    return shape.type === 'boolean' || shape.type === 'svg' || hasFilterDependency(shape) ||
        shape.isMaskGroup !== false && !!(shape.isMaskGroup || shape.maskType || shape.maskMode || shape.mask?.mode);
}

/** A conservative screen-only bound. Unknown ink is retained, never silently clipped.
 * Clipped frames bound their descendants, including unknown text/SVG ink. */
export function subtreeScreenBounds(objects: Record<string, Shape>, id: string, memo = new Map<string, Rect | null>(), visiting = new Set<string>(), geometryCache?: WeakMap<Shape, Rect | null>): Rect | null {
    if (memo.has(id)) return memo.get(id)!;
    const shape = objects[id];
    if (!shape || visiting.has(id)) return null;
    visiting.add(id);
    const finish = (value: Rect | null) => { visiting.delete(id); memo.set(id, value); return value; };
    if (shape.hidden || shape.visible === false) return finish({ x: shape.x, y: shape.y, width: 0, height: 0 });
    // These may produce ink beyond their declared geometry. Keep their output until
    // a measured/compositing-aware bound is available.
    if (shape.type === 'text' || shape.type === 'svg' || hasFilterDependency(shape))
        return finish(null);
    const geometry = geometryCache?.has(shape) ? geometryCache.get(shape)! : hitBounds(shape);
    geometryCache?.set(shape, geometry);
    if (!geometry) return finish(null);
    let bounds: Rect = geometry;
    // Miter joins and arbitrary path markers can extend beyond a path's geometry.
    // Frame/primitive strokes also conservatively retain their own ink for now.
    if (shape.strokes?.some((stroke: any) => !stroke.hidden && stroke.visible !== false && (stroke.width ?? 1) > 0)) return finish(null);
    if (!shape.clipContent || shape.clip) {
        for (const child of shape.childIds ?? []) {
            if (objects[child]?.hidden || objects[child]?.visible === false) continue;
            const childBounds = subtreeScreenBounds(objects, child, memo, visiting, geometryCache);
            if (!childBounds) return finish(null);
            bounds = union(bounds, childBounds);
        }
    }
    return finish(bounds);
}

/** Retain an overscanned scene while the viewport stays inside its prepared area.
 * An unbounded ancestor does not force independently bounded children to be mounted. */
export class ViewportPreparation {
    private source?: Record<string, Shape>;
    private area?: Rect;
    private allRoots: string[] = [];
    private bounds = new Map<string, Rect | null>();
    private geometry = new WeakMap<Shape, Rect | null>();
    private selectedKey = '';
    private backdrop = false;
    private count = 0;
    roots: string[] = [];
    objects: Record<string, Shape> = {};
    enabled = false;
    update(source: Record<string, Shape>, viewport: Rect, selected: string[] = []): boolean {
        let sourceChanged = this.source !== source;
        if (sourceChanged) {
            this.source = source;
            this.allRoots = source.root?.childIds ?? Object.values(source).filter(s => s.parentId === 'root' && s.id !== 'root').map(s => s.id);
            this.count = Object.keys(source).length;
        }
        const enabled = this.count > 512 && viewport.width > 0 && viewport.height > 0;
        if (sourceChanged || enabled !== this.enabled) {
            sourceChanged = true;
            this.enabled = enabled;
            this.backdrop = this.enabled && Object.values(source).some(hasBackdropDependency);
            this.bounds = new Map();
            if (this.enabled && !this.backdrop) for (const id of this.allRoots) subtreeScreenBounds(source, id, this.bounds, new Set(), this.geometry);
        }
        const selectedNodes = new Set(selected.filter(id => !!source[id])), selectedAncestors = new Set<string>();
        for (let id of selectedNodes) {
            const seen = new Set<string>();
            while (source[id] && !seen.has(id)) { seen.add(id); selectedAncestors.add(id); id = source[id].parentId; }
        }
        const selectedKey = [...selectedNodes].sort().join('\0');
        if (!sourceChanged && selectedKey === this.selectedKey && this.area && contains(this.area, viewport)) return false;
        this.selectedKey = selectedKey;
        this.area = { x: viewport.x - viewport.width / 2, y: viewport.y - viewport.height / 2, width: viewport.width * 2, height: viewport.height * 2 };
        let objects: Record<string, Shape> = source, next = this.allRoots;
        if (this.enabled && !this.backdrop) {
            objects = {};
            const visit = (id: string, wholeSubtree = false) => {
                const shape = source[id];
                if (!shape || objects[id]) return;
                const bounds = wholeSubtree ? null : subtreeScreenBounds(source, id, this.bounds, new Set(), this.geometry);
                if (!wholeSubtree && !selectedAncestors.has(id) && bounds && !intersects(bounds, this.area!)) return;
                objects[id] = shape;
                const keepChildren = wholeSubtree || selectedNodes.has(id) || keepChildrenTogether(shape);
                for (const child of shape.childIds ?? []) visit(child, keepChildren);
            };
            if (source.root) objects.root = source.root;
            for (const id of this.allRoots) visit(id);
            next = this.allRoots.filter(id => !!objects[id]);
        }
        // Descendant membership can change while every root remains mounted. A new
        // subset invalidates retained ancestor serialization through sceneChanges().
        const changed = sourceChanged || next.length !== this.roots.length || next.some((id, index) => id !== this.roots[index]) ||
            Object.keys(objects).length !== Object.keys(this.objects).length || Object.keys(objects).some(id => !this.objects[id]);
        if (!changed) return false;
        this.roots = [...next];
        this.objects = objects;
        return true;
    }
    clear() { this.source = undefined; this.area = undefined; this.objects = {}; this.roots = []; this.bounds.clear(); this.geometry = new WeakMap(); }
}
