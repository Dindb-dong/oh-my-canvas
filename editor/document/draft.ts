import type { CanvasDocument } from '../contracts';
import { share } from './journal';

type Kind = 'document' | 'pages' | 'page' | 'objects' | 'definitions';
interface Entry {
    value?: any;
    child?: DraftNode;
}
interface Descriptors { keys: string[]; properties: PropertyDescriptorMap; }
const descriptors = new WeakMap<object, Descriptors>(), drafts = new WeakMap<object, DraftNode>();

/** A transaction draft is an ordinary, structured-cloneable object. Accessors
 * detach only the entities a mutator actually reads; no Proxy escapes into
 * commands, shape helpers or user reconciliation hooks. Published objects are
 * never handed to a mutator. An untouched page's object index is not allocated.
 */
class DraftNode {
    readonly value: any;
    private entries = new Map<string, Entry>();
    private descriptors: Descriptors;
    constructor(private base: any, private kind: Kind, private path: string[], private changed: Map<string, string[]>) {
        let shared = descriptors.get(base);
        if (!shared) {
            shared = { keys: Object.keys(base), properties: Object.create(null) };
            for (const key of shared.keys) shared.properties[key] = {
                enumerable: true, configurable: true,
                get: function (this: object) { return drafts.get(this)!.read(key); },
                set: function (this: object, value: any) { drafts.get(this)!.entries.set(key, { value }); },
            };
            descriptors.set(base, shared);
        }
        this.descriptors = shared;
        this.value = Object.create(Object.getPrototypeOf(base), shared.properties);
        drafts.set(this.value, this);
    }
    private read(key: string): any {
        let entry = this.entries.get(key);
        if (!entry) {
            entry = {};
            const value = this.base[key], kind = this.childKind(key);
            if (kind && value && typeof value === 'object' && !Array.isArray(value)) {
                entry.child = new DraftNode(value, kind, [...this.path, key], this.changed);
                entry.value = entry.child.value;
            }
            else entry.value = structuredClone(value);
            this.entries.set(key, entry);
        }
        return entry.value;
    }
    private childKind(key: string): Kind | undefined {
        if (this.kind === 'document') {
            if (key === 'pagesById') return 'pages';
            if (['components', 'styles', 'libraries', 'assets'].includes(key)) return 'definitions';
        }
        if (this.kind === 'pages') return 'page';
        if (this.kind === 'page' && key === 'objects') return 'objects';
        return undefined;
    }
    collectPaths(paths: Map<string, string[]>): void {
        for (const key of Object.keys(this.value)) {
            const entry = this.entries.get(key), descriptor = Object.getOwnPropertyDescriptor(this.value, key)!;
            if (descriptor.get && descriptor.get === this.descriptors.properties[key]?.get) {
                if (!entry) continue;
                if (entry.child) { entry.child.collectPaths(paths); continue; }
            }
            const path = [...this.path, key];
            paths.set(JSON.stringify(path), path);
        }
        for (const key of this.descriptors.keys) if (!Object.hasOwn(this.value, key)) {
            const path = [...this.path, key]; paths.set(JSON.stringify(path), path);
        }
    }
    checkpoint(values: Map<string, any>): void {
        for (const key of Object.keys(this.value)) {
            const entry = this.entries.get(key), descriptor = Object.getOwnPropertyDescriptor(this.value, key)!;
            const original = descriptor.get && descriptor.get === this.descriptors.properties[key]?.get;
            if (original && !entry) continue;
            if (original && entry?.child) { entry.child.checkpoint(values); continue; }
            const next = share(this.base[key], structuredClone(original ? entry!.value : this.value[key]));
            const path = [...this.path, key], encoded = JSON.stringify(path);
            values.set(encoded, next);
            if (!Object.hasOwn(this.base, key) || next !== this.base[key]) this.changed.set(encoded, path);
        }
        for (const key of this.descriptors.keys) if (!Object.hasOwn(this.value, key)) {
            const path = [...this.path, key], encoded = JSON.stringify(path);
            values.set(encoded, undefined); this.changed.set(encoded, path);
        }
    }
    finish(): any {
        const keys = Object.keys(this.value);
        let result = this.base, sameKeys = keys.length === this.descriptors.keys.length;
        const writable = () => {
            // Spread defines own data properties, including an own __proto__
            // key, without invoking setters on Object.prototype.
            if (result === this.base) result = Object.setPrototypeOf({ ...this.base }, Object.getPrototypeOf(this.base));
            return result;
        };
        for (const key of keys) {
            const entry = this.entries.get(key), descriptor = Object.getOwnPropertyDescriptor(this.value, key)!;
            let next: any;
            const original = descriptor.get && descriptor.get === this.descriptors.properties[key]?.get;
            if (original) {
                if (!entry) next = this.base[key];
                else if (entry.child) next = entry.child.finish();
                else next = share(this.base[key], structuredClone(entry.value));
            }
            else next = share(this.base[key], structuredClone(this.value[key]));
            if (!Object.hasOwn(this.base, key) || next !== this.base[key]) {
                if (!Object.hasOwn(this.base, key)) sameKeys = false;
                Object.defineProperty(writable(), key, { value: next, enumerable: true, configurable: true, writable: true });
                if (!entry?.child || !original) {
                    const path = [...this.path, key];
                    this.changed.set(JSON.stringify(path), path);
                }
            }
        }
        for (const key of this.descriptors.keys) if (!Object.hasOwn(this.value, key)) {
            delete writable()[key];
            const path = [...this.path, key];
            this.changed.set(JSON.stringify(path), path);
        }
        // Reuse only schema descriptors, never mutable values or draft nodes.
        // A drag keeps its object-index keys, so subsequent frames allocate no
        // per-layer closures or tracking entries for untouched shapes.
        if (sameKeys && result !== this.base) descriptors.set(result, this.descriptors);
        return result;
    }
}

export function documentDraft(before: CanvasDocument) {
    const paths = new Map<string, string[]>(), node = new DraftNode(before, 'document', [], paths);
    return {
        base: before, draft: node.value as CanvasDocument,
        possiblePaths: () => { const accessed = new Map<string, string[]>(); node.collectPaths(accessed); return [...accessed.values()]; },
        checkpoint: () => {
            const values = new Map<string, any>(); node.checkpoint(values);
            return { paths: [...paths.values()], get: (path: string[]) => {
                // A replaced ancestor is an atomic detached value. Otherwise
                // unchanged paths continue to read the immutable input tree.
                // Callers request leaves (pages or a shape), never a parent
                // dictionary whose separately captured children changed.
                for (let length = path.length; length > 0; length--) {
                    const key = JSON.stringify(path.slice(0, length));
                    if (!values.has(key)) continue;
                    let value = values.get(key);
                    for (const part of path.slice(length)) value = value?.[part];
                    return value;
                }
                let value: any = before;
                for (const part of path) value = value?.[part];
                return value;
            } };
        },
        finish: () => ({ document: node.finish() as CanvasDocument, paths: [...paths.values()] }),
    };
}
