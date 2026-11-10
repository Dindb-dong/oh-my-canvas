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
export function patches(before: any, after: any, path: string[] = []): Patch[] {
    if (Object.is(before, after) || JSON.stringify(before) === JSON.stringify(after))
        return [];
    if (!before || !after || typeof before !== 'object' || typeof after !== 'object' || Array.isArray(before) || Array.isArray(after))
        return [{ path, value: clone(after), old: clone(before) }];
    const result: Patch[] = [];
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
        if (!(key in after))
            result.push({ path: [...path, key], remove: true });
        else if (!(key in before))
            result.push({ path: [...path, key], value: clone(after[key]) });
        else
            result.push(...patches(before[key], after[key], [...path, key]));
    }
    return result;
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
