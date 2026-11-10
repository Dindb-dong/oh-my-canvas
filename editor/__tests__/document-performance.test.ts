import { describe, expect, it, vi } from 'vitest';
import { Editor, createDocument, createShape, insertShape, removeShapes } from '../document';
import { applyPatches, inversePatches, patches } from '../document/journal';
import * as geometry from '../geometry';
import type { Data, EditorOptions } from '../contracts';

function fixture(options: EditorOptions = {}, extra: Data = {}): Editor {
    const doc = createDocument(extra), page = doc.pagesById[doc.pages[0]];
    insertShape(page, createShape('rect', { id: 'a', x: 10, y: 20, width: 80, height: 40 }));
    insertShape(page, createShape('rect', { id: 'b', x: 100, y: 20, width: 80, height: 40 }));
    return new Editor(doc, options);
}

// The previous public diff semantics are the compatibility oracle, including
// JSON-equivalent undefined/missing values and atomic arrays. Keep this bounded
// test implementation independent of the optimized comparison code.
function previousPatches(before: any, after: any, path: string[] = []): any[] {
    if (Object.is(before, after) || JSON.stringify(before) === JSON.stringify(after)) return [];
    if (!before || !after || typeof before !== 'object' || typeof after !== 'object' || Array.isArray(before) || Array.isArray(after))
        return [{ path, value: structuredClone(after), old: structuredClone(before) }];
    const result: any[] = [];
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
        if (!(key in after)) result.push({ path: [...path, key], remove: true });
        else if (!(key in before)) result.push({ path: [...path, key], value: structuredClone(after[key]) });
        else result.push(...previousPatches(before[key], after[key], [...path, key]));
    }
    return result;
}

describe('document diff and history performance contracts', () => {
    it('keeps JSON patch compatibility for nested metadata, missing values and arrays', () => {
        const values = [
            undefined, null, false, true, 0, -0, 3, NaN, Infinity, 'text',
            [], [undefined, null, NaN], [null, undefined, Infinity], [1, { text: '한글', optional: undefined }],
            { optional: undefined }, {}, { a: 1, b: undefined }, { a: 2 },
            { a: 1, b: 2 }, { b: 2, a: 1 },
            { text: { value: 'before', style: ['bold'] }, childIds: ['a', 'b'] },
            { text: { value: 'after', style: ['bold'] }, childIds: ['b', 'a'] },
        ];
        for (const before of values)
            for (const after of values)
                expect(patches(before, after)).toEqual(previousPatches(before, after));
    });

    it('does not serialize unchanged assets or whole documents to produce a small patch', () => {
        const asset = { data: 'a'.repeat(256 * 1024) }, objects = Object.fromEntries(Array.from({ length: 1000 }, (_, i) => [`node-${i}`, { x: i, text: `Layer ${i}` }]));
        const before = { assets: { shared: asset }, objects }, after = { assets: before.assets, objects: { ...objects, 'node-500': { ...objects['node-500'], x: 900 } } };
        const serialize = vi.spyOn(JSON, 'stringify');
        let result: ReturnType<typeof patches>, calls: unknown[][];
        try { result = patches(before, after); calls = [...serialize.mock.calls]; }
        finally { serialize.mockRestore(); }
        expect(result!).toEqual([{ path: ['objects', 'node-500', 'x'], value: 900, old: 500 }]);
        expect(calls!).toEqual([]);
    });

    it('preserves containing keys for custom serialization inside atomic arrays', () => {
        class KeyAware {
            constructor(public tag: number) {}
            toJSON(key: string) { return key === '' ? {} : { tag: this.tag }; }
        }
        const before = { extra: [{}] }, after = { extra: [new KeyAware(2)] };
        expect(patches(before, after)).toEqual(previousPatches(before, after));
        expect(patches(before, after)).toEqual([{ path: ['extra'], value: [{ tag: 2 }], old: [{}] }]);
        class Omitted { toJSON() { return undefined; } }
        expect(patches({ extra: new Omitted(), same: 1 }, { same: 1 })).toEqual([]);
    });

    it('retains native serialization for supported non-plain metadata and custom arrays', () => {
        const values = [
            {}, null, [null], Array(1), new Date('2020-01-01T00:00:00Z'), new Date(NaN),
            '2020-01-01T00:00:00.000Z', new Map([['a', 1]]), new Set(['a']),
            new Uint8Array([1, 2]), { 0: 1, 1: 2 },
        ];
        for (const before of values)
            for (const after of values)
                expect(patches(before, after)).toEqual(previousPatches(before, after));
        const custom = Object.assign([1, 2], { toJSON: () => [3, 4] });
        expect(patches(custom, [3, 4])).toEqual(previousPatches(custom, [3, 4]));
    });

    it('inverts edits and removals while retaining concurrent sibling insertions', () => {
        const e = fixture(), before = structuredClone(e.doc), after = structuredClone(before), pageId = e.pageId;
        removeShapes(after.pagesById[pageId], ['a']);
        insertShape(after.pagesById[pageId], createShape('rect', { id: 'local' }));
        after.pagesById[pageId].objects.b.name = 'Local label';
        const changes = patches(before, after), inverse = inversePatches(before, changes), remote = structuredClone(after);
        insertShape(remote.pagesById[pageId], createShape('rect', { id: 'peer' }));
        remote.pagesById[pageId].objects.b.opacity = .5;
        const undone = applyPatches(remote, inverse);
        expect(undone.pagesById[pageId].objects.a).toEqual(before.pagesById[pageId].objects.a);
        expect(undone.pagesById[pageId].objects.local).toBeUndefined();
        expect(undone.pagesById[pageId].objects.b.opacity).toBe(.5);
        expect(undone.pagesById[pageId].objects.root.childIds).toContain('peer');
        const redone = applyPatches(undone, changes);
        expect(redone.pagesById[pageId].objects.a).toBeUndefined();
        expect(redone.pagesById[pageId].objects.local).toBeDefined();
        expect(redone.pagesById[pageId].objects.root.childIds).toContain('peer');
        expect(changes).toEqual(patches(before, after));
        e.destroy();
    });

    it('retains small reversible edits instead of unchanged asset-bearing document snapshots', () => {
        const e = fixture({}, { assets: { large: { kind: 'image', data: 'a'.repeat(256 * 1024) } } });
        e.transact('Move', doc => { doc.pagesById[e.pageId].objects.a.x = 30; });
        const historyBytes = new TextEncoder().encode(JSON.stringify((e as any).past)).byteLength;
        expect(historyBytes).toBeLessThan(12 * 1024);
        const remote = structuredClone(e.doc);
        remote.pagesById[e.pageId].objects.b.name = 'Peer';
        e.receiveDocument(remote);
        expect(e.undoStep()).toBe(true);
        expect(e.page.objects.a.x).toBe(10);
        expect(e.page.objects.b.name).toBe('Peer');
        expect(e.redoStep()).toBe(true);
        expect(e.page.objects.a.x).toBe(30);
        expect(e.doc.assets.large.data).toHaveLength(256 * 1024);
        e.destroy();
    });

    it('keeps Undo/Redo independent of mutation event listeners', () => {
        const e = fixture();
        e.on(event => {
            if (event.changes?.length) {
                const first = event.changes[0] as any;
                first.path.splice(0, first.path.length, 'other');
                first.value = 'modified by listener';
                event.changes.length = 0;
            }
        });
        e.transact('Move', doc => { doc.pagesById[e.pageId].objects.a.x = 30; });
        expect(e.undoStep()).toBe(true);
        expect(e.page.objects.a.x).toBe(10);
        expect(e.redoStep()).toBe(true);
        expect(e.page.objects.a.x).toBe(30);
        e.destroy();
    });
});

describe('geometry preparation and preview reuse', () => {
    it.each([
        ['function', () => () => undefined],
        ['symbol', () => Symbol('invalid')],
        ['weak collection', () => new WeakMap()],
        ['Proxy', () => new Proxy({ value: 1 }, {})],
        ['bigint', () => 1n],
        ['cycle', () => { const value: any = {}; value.self = value; return value; }],
    ])('rejects a %s introduced by a transaction or preview before publication', (_name, makeValue) => {
        const e = fixture(), original = e.doc, events = vi.fn();
        e.on(events);
        expect(() => e.transact('Invalid metadata', doc => { doc.extra = makeValue(); })).toThrow();
        expect(e.doc).toBe(original);
        expect(events).not.toHaveBeenCalled();
        e.begin('Invalid preview');
        expect(() => e.preview(doc => { doc.extra = makeValue(); })).toThrow();
        expect(e.doc).toBe(original);
        expect(e.activeSession).toBe(true);
        e.cancelSession();
        e.destroy();
    });

    it('preserves candidate and intermediate isolation without copying the complete document', () => {
        const e = fixture({ reconcile(_before, draft) { draft.pagesById[e.pageId].objects.b.name = 'Derived'; } }, { assets: { data: 'x'.repeat(128 * 1024) } });
        const original = e.doc;
        e.begin('Drag');
        const copy = vi.spyOn(globalThis, 'structuredClone');
        let documents: unknown[];
        try {
            e.preview(doc => { doc.pagesById[e.pageId].objects.a.x = 40; });
            documents = copy.mock.calls.map(([value]) => value).filter((value: any) => value?.pages && value?.pagesById);
        }
        finally { copy.mockRestore(); }
        expect(documents!).toHaveLength(0);
        expect(original.pagesById[e.pageId].objects.a.x).toBe(10);
        expect(e.page.objects.a.x).toBe(40);
        expect(e.page.objects.b.name).toBe('Derived');
        expect(e.doc.assets).toBe(original.assets);
        e.cancelSession();
        expect(e.doc).toBe(original);
        e.destroy();
    });

    it('does not recalculate valid geometry for style-only edits but repairs modified derived caches', () => {
        const e = fixture(), calculate = vi.spyOn(geometry, 'reconcileShapeGeometry');
        try {
            e.transact('Fill', doc => { doc.pagesById[e.pageId].objects.a.fills = [{ color: '#ff0000' }]; });
            expect(calculate).not.toHaveBeenCalled();
            e.transact('Repair derived data', doc => {
                const shape = doc.pagesById[e.pageId].objects.a;
                shape.box.x = -200;
                shape.corners[0].x = -300;
                shape.inverseTransform.a = 2;
            });
            expect(calculate).toHaveBeenCalledTimes(1);
            expect(e.page.objects.a.box.x).toBe(10);
            expect(e.page.objects.a.corners[0].x).toBe(10);
            expect(e.page.objects.a.inverseTransform.a).toBe(1);
        }
        finally { calculate.mockRestore(); e.destroy(); }
    });

    it('detaches vector content before a hook mutates path points and dimensions', () => {
        const doc = createDocument(), page = doc.pagesById[doc.pages[0]];
        insertShape(page, createShape('line', { id: 'path', x: 0, y: 0, width: 10, height: 10 }));
        const e = new Editor(doc, { reconcile(_before, candidate) {
            const path = candidate.pagesById[e.pageId].objects.path;
            path.content[0].x += 5;
            path.width = 30;
        } });
        const original = structuredClone(e.doc);
        e.transact('Move and derive', draft => { draft.pagesById[e.pageId].objects.path.x = 20; });
        expect(e.page.objects.path.content[0]).toMatchObject({ x: 25, y: 0 });
        expect(e.page.objects.path.content[1]).toMatchObject({ x: 30, y: 10 });
        expect(e.page.objects.path.box).toMatchObject({ x: 20, width: 30 });
        expect(original.pagesById[e.pageId].objects.path.content[0]).toMatchObject({ x: 0, y: 0 });
        e.destroy();
    });

    it('detaches orientation before hooks mutate the existing matrix in place', () => {
        const doc = createDocument(), page = doc.pagesById[doc.pages[0]];
        insertShape(page, createShape('line', { id: 'path', x: 0, y: 0, width: 10, height: 10 }));
        const e = new Editor(doc, { reconcile(_before, candidate) {
            Object.assign(candidate.pagesById[e.pageId].objects.path.transform, { a: 0, b: 1, c: -1, d: 0 });
        } });
        e.transact('Derive orientation', draft => { draft.pagesById[e.pageId].objects.path.name = 'Rotated'; });
        expect(e.page.objects.path.content[0]).toMatchObject({ x: 10, y: 0 });
        expect(e.page.objects.path.content[1]).toMatchObject({ x: 0, y: 10 });
        expect(e.page.objects.path.inverseTransform).toMatchObject({ a: 0, b: -1, c: 1, d: 0 });
        e.destroy();
    });

    it('preserves legacy dimension fallbacks while a hook repairs intermediate geometry', () => {
        const doc = createDocument(), page = doc.pagesById[doc.pages[0]];
        insertShape(page, createShape('line', { id: 'path', x: 0, y: 0, width: 10, height: 10 }));
        const e = new Editor(doc, { reconcile(_before, candidate) {
            const path = candidate.pagesById[e.pageId].objects.path;
            path.width = 30;
            path.height = 40;
        } });
        e.transact('Repair dimensions', draft => {
            const path = draft.pagesById[e.pageId].objects.path;
            delete (path as any).width;
            delete (path as any).height;
            path.w = 15;
            path.h = 20;
        });
        expect(e.page.objects.path.content[0]).toMatchObject({ x: 0, y: 0 });
        expect(e.page.objects.path.content[1]).toMatchObject({ x: 30, y: 40 });
        expect(e.page.objects.path.box).toMatchObject({ width: 30, height: 40 });
        e.destroy();
    });

    it('prepares each distinct preview snapshot once when rebasing active Undo/Redo history', () => {
        const reconcile = vi.fn(), e = fixture({ reconcile }), base = structuredClone(e.doc);
        e.begin('Typing');
        e.preview(doc => { doc.pagesById[e.pageId].objects.a.name = 'First'; });
        e.preview(doc => { doc.pagesById[e.pageId].objects.a.name = 'Second'; });
        e.undoSession();
        const remote = structuredClone(base);
        remote.pagesById[e.pageId].objects.b.name = 'Peer';
        reconcile.mockClear();
        e.receiveDocument(remote);
        expect(reconcile).toHaveBeenCalledTimes(3);
        expect(e.page.objects.a.name).toBe('First');
        expect(e.redoSession()).toBe(true);
        expect(e.page.objects.a.name).toBe('Second');
        expect(e.page.objects.b.name).toBe('Peer');
        e.cancelSession();
        expect(e.page.objects.a.name).toBe(base.pagesById[e.pageId].objects.a.name);
        expect(e.page.objects.b.name).toBe('Peer');
        e.destroy();
    });
});
