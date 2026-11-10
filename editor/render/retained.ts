import type { Shape } from '../contracts';

export interface SceneNodeRecord {
    source: string;
    defs: string[];
    bytes: number;
}

/** Screen-only serialization cache. Export always builds an independent scene. */
export class SceneNodeCache {
    private entries = new Map<string, SceneNodeRecord>();
    private bytes = 0;
    constructor(private maxBytes = 8 * 1024 * 1024, private maxEntries = 4096) {}
    get(key: string): SceneNodeRecord | undefined {
        const entry = this.entries.get(key);
        if (entry) {
            this.entries.delete(key);
            this.entries.set(key, entry);
        }
        return entry;
    }
    put(key: string, source: string, defs: string[]): void {
        this.remove(key);
        const bytes = (source.length + defs.reduce((sum, value) => sum + value.length, 0)) * 2;
        if (bytes > this.maxBytes) return;
        this.entries.set(key, { source, defs, bytes });
        this.bytes += bytes;
        while (this.bytes > this.maxBytes || this.entries.size > this.maxEntries)
            this.remove(this.entries.keys().next().value!);
    }
    remove(key: string): void {
        const entry = this.entries.get(key);
        if (entry) this.bytes -= entry.bytes;
        this.entries.delete(key);
    }
    invalidate(ids: Iterable<string>): void {
        for (const id of ids) { this.remove(id + '\0shape'); this.remove(id + '\0mask'); }
    }
    clear(): void { this.entries.clear(); this.bytes = 0; }
    diagnostics() { return { entries: this.entries.size, bytes: this.bytes, maxBytes: this.maxBytes }; }
}

/** Include old and new ancestry: reparenting changes both containers. */
export function sceneChanges(previous: Record<string, Shape> | undefined, next: Record<string, Shape>) {
    const changed = new Set<string>(), affected = new Set<string>();
    for (const id of new Set([...Object.keys(previous ?? {}), ...Object.keys(next)]))
        if (previous?.[id] !== next[id]) changed.add(id);
    const ancestors = (objects: Record<string, Shape> | undefined, id: string) => {
        const seen = new Set<string>();
        while (id && !seen.has(id)) {
            seen.add(id); affected.add(id);
            const parent = objects?.[id]?.parentId;
            if (!parent || parent === id) break;
            id = parent;
        }
    };
    for (const id of changed) { ancestors(previous, id); ancestors(next, id); }
    return { changed, affected };
}

const SVG_NS = 'http://www.w3.org/2000/svg';
export function parseScene(source: string): SVGSVGElement {
    const holder = document.createElement('div');
    holder.innerHTML = source;
    const svg = holder.firstElementChild;
    if (!svg || svg.namespaceURI !== SVG_NS || svg.localName !== 'svg')
        throw new Error('Invalid generated scene');
    return svg as SVGSVGElement;
}

function nodeKey(node: Node): string | undefined {
    if (!(node instanceof Element)) return;
    const id = node.getAttribute('data-shape-id');
    if (id) return 'shape:' + id;
    const resource = node.getAttribute('id');
    if (resource) return 'id:' + resource;
}
function compatible(a: Node, b: Node) {
    return a.nodeType === b.nodeType && (!(a instanceof Element) || b instanceof Element && a.localName === b.localName && a.namespaceURI === b.namespaceURI);
}

/** Reuse live SVG elements, including unchanged gradients, images and text runs. */
export function reconcileScene(target: Element, source: Element, affected?: ReadonlySet<string>): void {
    const shape = source.getAttribute('data-shape-id');
    if (shape && affected && !affected.has(shape)) return;
    for (const attr of Array.from(target.attributes))
        if (!source.hasAttributeNS(attr.namespaceURI, attr.localName))
            target.removeAttributeNS(attr.namespaceURI, attr.localName);
    for (const attr of Array.from(source.attributes))
        if (target.getAttributeNS(attr.namespaceURI, attr.localName) !== attr.value)
            target.setAttributeNS(attr.namespaceURI, attr.name, attr.value);
    const keyed = new Map<string, Node[]>();
    for (const node of Array.from(target.childNodes)) {
        const key = nodeKey(node);
        if (key) { const nodes = keyed.get(key) ?? []; nodes.push(node); keyed.set(key, nodes); }
    }
    let cursor = target.firstChild;
    for (const next of Array.from(source.childNodes)) {
        const key = nodeKey(next);
        let current = key ? keyed.get(key)?.shift() : cursor && !nodeKey(cursor) && compatible(cursor, next) ? cursor : undefined;
        if (!current || !compatible(current, next)) {
            current = next.cloneNode(true);
            target.insertBefore(current, cursor);
        } else {
            if (current !== cursor) target.insertBefore(current, cursor);
            // An embedded SVG picture may contain its own data-shape-id attributes.
            // Only generated scene groups participate in document invalidation.
            if (current instanceof Element && next instanceof Element) reconcileScene(current, next, next.localName === 'svg' ? undefined : affected);
            else if (current.nodeValue !== next.nodeValue) current.nodeValue = next.nodeValue;
        }
        cursor = current.nextSibling;
    }
    while (cursor) { const next = cursor.nextSibling; cursor.remove(); cursor = next; }
}

/** Resource identifiers are stable across siblings being inserted or reordered. */
export function resourceScope(id: string, asMask = false) {
    // Encode code units rather than URI components: even unusual portable-file
    // identifiers (including lone surrogates) remain collision-free and usable.
    const safe = Array.from({ length: id.length }, (_, index) => id.charCodeAt(index).toString(16)).join('_');
    return 'node-' + safe + (asMask ? '-mask' : '-shape');
}
