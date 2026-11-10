interface Size { bytes: number; members: number; }
interface Paths { terminal: boolean; children: Map<string, Paths>; }
const encoder = new TextEncoder(), sizes = new WeakMap<object, Size>();
const fallback = Symbol('native JSON size');
const bytes = (value: string) => encoder.encode(value).byteLength;
const plain = (value: any) => value && typeof value === 'object' && !Array.isArray(value) && [null, Object.prototype].includes(Object.getPrototypeOf(value));
function pathTree(paths: readonly (readonly string[])[]): Paths {
    const root: Paths = { terminal: false, children: new Map() };
    for (const path of paths) {
        let node = root;
        for (const key of path) {
            if (node.terminal) break;
            let child = node.children.get(key);
            if (!child) { child = { terminal: false, children: new Map() }; node.children.set(key, child); }
            node = child;
        }
        node.terminal = true;
        node.children.clear();
    }
    return root;
}

/** Exact JSON UTF-8 size, including keys, punctuation, escaping and omitted
 * properties. Only immutable plain subtrees are cached. Custom serializers keep
 * native JSON behavior (including their property-key argument) via full fallback.
 * A full/untrusted validation ignores every cached value.
 */
export function documentJSONBytes(value: any, incremental = false, changes?: { before: any; paths: readonly (readonly string[])[] }): number {
    const visiting = new Set<object>();
    const measure = (input: any, arrayItem = false, previous?: any, paths?: Paths): number | undefined => {
        if (input === undefined || typeof input === 'function' || typeof input === 'symbol') return arrayItem ? 4 : undefined;
        if (!input || typeof input !== 'object') return bytes(JSON.stringify(input));
        if (visiting.has(input)) throw new TypeError('Cyclic document');
        if (incremental && sizes.has(input)) return sizes.get(input)!.bytes;
        const prototype = Object.getPrototypeOf(input);
        if (typeof input.toJSON === 'function' || !Array.isArray(input) && prototype !== Object.prototype && prototype !== null) throw fallback;
        visiting.add(input);
        let size = 2, count = 0;
        const oldSize = incremental && paths && !paths.terminal && plain(previous) ? sizes.get(previous) : undefined;
        if (oldSize && !Array.isArray(input)) {
            // Paths come only from the editor's isolated draft or immutable
            // host projection. Their complete changed-branch contract permits
            // exact member deltas without walking unchanged dictionary keys.
            // Arrays and replacements are atomic and still measured in full.
            size = oldSize.bytes; count = oldSize.members;
            for (const [key, child] of paths!.children) {
                const old = Object.getOwnPropertyDescriptor(previous, key)?.enumerable ? measure(previous[key]) : undefined;
                const next = Object.getOwnPropertyDescriptor(input, key)?.enumerable ? measure(input[key], false, previous[key], child) : undefined;
                const keyBytes = bytes(JSON.stringify(key)) + 1;
                if (old !== undefined) { size -= keyBytes + old; count--; }
                if (next !== undefined) { size += keyBytes + next; count++; }
            }
            size += Math.max(0, count - 1) - Math.max(0, oldSize.members - 1);
        }
        else if (Array.isArray(input)) {
            for (let i = 0; i < input.length; i++) { size += measure(input[i], true)! + (i ? 1 : 0); }
        }
        else for (const key of Object.keys(input)) {
            const length = measure(input[key]);
            if (length === undefined) continue;
            size += bytes(JSON.stringify(key)) + 1 + length + (count++ ? 1 : 0);
        }
        visiting.delete(input);
        sizes.set(input, { bytes: size, members: count });
        return size;
    };
    try { return measure(value, false, changes?.before, changes ? pathTree(changes.paths) : undefined)!; }
    catch (error) {
        if (error !== fallback) throw error;
        return bytes(JSON.stringify(value));
    }
}
