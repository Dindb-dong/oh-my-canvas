/** Original journal implementation from independent editor interoperability and behavior contracts. */
import type { CanvasDocument } from '../contracts';
import { clone } from './factory';
/** Preserve identity of unchanged branches; isolation never mutates a published branch. */
export function share(before: any, after: any): any {
    if (Object.is(before, after))
        return before;
    if (!before || !after || typeof before !== 'object' || typeof after !== 'object' || Array.isArray(before) !== Array.isArray(after))
        return after;
    const keys = Object.keys(after), old = Object.keys(before);
    let equal = keys.length === old.length;
    for (const key of keys) {
        after[key] = share(before[key], after[key]);
        if (!Object.hasOwn(before, key) || after[key] !== before[key])
            equal = false;
    }
    return equal ? before : after;
}
export interface Patch {
    path: string[];
    value?: any;
    old?: any;
    remove?: boolean;
}
/** Compare JSON document values without allocating serialized copies of whole
 * documents. Pair results are scoped to one immutable diff, so shared branches
 * are inspected at most once even when their ancestors are also compared.
 */
function jsonComparer(): (before: any, after: any, arrayItem?: boolean) => boolean {
    const pairs = new WeakMap<object, WeakMap<object, boolean>>();
    const needsSerialization = Symbol('native serialization');
    const omitted = (value: any) => value === undefined || typeof value === 'function' || typeof value === 'symbol';
    const plain = (value: any) => {
        const prototype = Object.getPrototypeOf(value);
        return prototype === null || prototype === Object.prototype;
    };
    const compare = (before: any, after: any, arrayItem = false): boolean => {
        if (Object.is(before, after))
            return true;
        if (arrayItem) {
            if (omitted(before)) before = null;
            if (omitted(after)) after = null;
        }
        // JSON normalizes non-finite numbers and -0. Keep that compatibility for
        // metadata and atomic arrays; shape geometry is validated separately.
        if (typeof before === 'number' && !Number.isFinite(before)) before = null;
        if (typeof after === 'number' && !Number.isFinite(after)) after = null;
        if (before === after || omitted(before) && omitted(after))
            return true;
        const aObject = before !== null && typeof before === 'object';
        const bObject = after !== null && typeof after === 'object';
        if (aObject && (typeof before.toJSON === 'function' || !Array.isArray(before) && !plain(before)) ||
            bObject && (typeof after.toJSON === 'function' || !Array.isArray(after) && !plain(after)) ||
            typeof before === 'bigint' || typeof after === 'bigint')
            throw needsSerialization;
        if (!aObject || !bObject || Array.isArray(before) !== Array.isArray(after))
            return false;
        let compared = pairs.get(before);
        if (compared?.has(after))
            return compared.get(after)!;
        if (!compared) {
            compared = new WeakMap();
            pairs.set(before, compared);
        }
        let same: boolean;
        if (Array.isArray(before)) {
            same = before.length === after.length;
            for (let i = 0; same && i < before.length; i++)
                same = compare(before[i], after[i], true);
        }
        else {
            const keys = Object.keys(before).filter(key => !omitted(before[key]));
            const nextKeys = Object.keys(after).filter(key => !omitted(after[key]));
            same = keys.length === nextKeys.length;
            for (let i = 0; same && i < keys.length; i++)
                same = keys[i] === nextKeys[i] && compare(before[keys[i]], after[keys[i]]);
            // A custom serializer may omit an otherwise enumerable property.
            // Inspect immediate values even if the key comparison short-circuited.
            const custom = (value: any) => value && typeof value === 'object' && typeof value.toJSON === 'function';
            if (!same && (keys.some(key => custom(before[key])) || nextKeys.some(key => custom(after[key]))))
                throw needsSerialization;
        }
        compared.set(after, same);
        return same;
    };
    return (before, after, arrayItem = false) => {
        try { return compare(before, after, arrayItem); }
        catch (error) {
            if (error !== needsSerialization) throw error;
            // Serialize the original compared subtree so nested toJSON methods
            // receive the same property/index keys as the prior JSON comparison.
            return JSON.stringify(before) === JSON.stringify(after);
        }
    };
}
export function patches(before: any, after: any, path: string[] = []): Patch[] {
    const equal = jsonComparer();
    const result: Patch[] = [];
    const visit = (before: any, after: any, path: string[]): void => {
        if (equal(before, after))
            return;
        if (!before || !after || typeof before !== 'object' || typeof after !== 'object' || Array.isArray(before) || Array.isArray(after)) {
            result.push({ path, value: clone(after), old: clone(before) });
            return;
        }
        for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
            if (!(key in after))
                result.push({ path: [...path, key], remove: true });
            else if (!(key in before))
                result.push({ path: [...path, key], value: clone(after[key]) });
            else
                visit(before[key], after[key], [...path, key]);
        }
    };
    visit(before, after, path);
    return result;
}
/** Invert detached, immutable patches. Changed values can be shared by the two
 * directions because applyPatches always clones values before applying them.
 */
export function inversePatches(before: any, changes: Patch[]): Patch[] {
    return changes.map(change => {
        if (change.remove) {
            let value = before;
            for (const key of change.path)
                value = value?.[key];
            return { path: [...change.path], value: clone(value) };
        }
        return Object.hasOwn(change, 'old')
            ? { path: [...change.path], value: change.old, old: change.value }
            : { path: [...change.path], remove: true };
    });
}
export function applyPatches(doc: CanvasDocument, changes: Patch[]): CanvasDocument {
    let next: any = clone(doc);
    for (const change of changes) {
        if (!change.path.length) {
            next = clone(change.value);
            continue;
        }
        let obj = next;
        for (const key of change.path.slice(0, -1)) {
            if (!obj[key] || typeof obj[key] !== 'object')
                obj[key] = {};
            obj = obj[key];
        }
        const key = change.path.at(-1)!;
        if (change.remove)
            delete obj[key];
        else if (['childIds', 'pages'].includes(key) && Array.isArray(change.old) && Array.isArray(change.value) && Array.isArray(obj[key])) {
            const current: string[] = obj[key], old: string[] = change.old, desired: string[] = change.value;
            const merged = desired.filter(id => !old.includes(id) || current.includes(id));
            for (let i = 0; i < current.length; i++) {
                const id = current[i];
                if (old.includes(id) || merged.includes(id))
                    continue;
                let insertion = 0;
                for (let j = i - 1; j >= 0; j--) {
                    const position = merged.indexOf(current[j]);
                    if (position >= 0) {
                        insertion = position + 1;
                        break;
                    }
                }
                merged.splice(insertion, 0, id);
            }
            obj[key] = merged;
        }
        else
            obj[key] = clone(change.value);
    }
    return next;
}
