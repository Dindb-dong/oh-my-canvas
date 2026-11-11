import { describe, expect, it, vi } from 'vitest';
import { Editor, createDocument, createPage, createShape, insertShape } from '../document';
import { applyPatches, patches } from '../document/journal';
import { documentJSONBytes } from '../document/size';
import { changeScope } from '../document/changes';
import { applyLayout } from '../layout';
import type { CanvasDocument } from '../contracts';

const nativeBytes = (value: any) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
function simple() {
    const doc = createDocument(), page = doc.pagesById[doc.pages[0]];
    insertShape(page, createShape('rect', { id: 'a', x: 10 }));
    insertShape(page, createShape('rect', { id: 'b', x: 200 }));
    return new Editor(doc);
}

describe('incremental transaction boundaries', () => {
    it('renames one page in a 46-page, 40,020-shape document without cloning shapes or assets', () => {
        const doc: CanvasDocument = { pages: [], pagesById: {}, capacityProfile: 'large-library', assets: { image: { src: 'omc-asset:sha256:' + 'a'.repeat(64) } } };
        const template = createShape('rect');
        for (let p = 0; p < 46; p++) {
            const page = createPage(`Page ${p}`, `page-${p}`);
            for (let n = 0; n < 869; n++) {
                const id = `shape-${p}-${n}`;
                page.objects[id] = { ...template, id };
                page.objects.root.childIds!.push(id);
            }
            doc.pages.push(page.id); doc.pagesById[page.id] = page;
        }
        const editor = new Editor(doc), before = editor.doc, events: any[] = [];
        editor.on(event => events.push(event));
        const copy = vi.spyOn(globalThis, 'structuredClone');
        let clonedShapes: any[] = [];
        try {
            editor.transact('Rename page', draft => { draft.pagesById['page-0'].name = 'Renamed'; });
            clonedShapes = copy.mock.calls.map(([value]) => value).filter((value: any) => value?.pagesById || value?.type && value?.parentId);
        }
        finally { copy.mockRestore(); }
        expect(clonedShapes).toEqual([]);
        expect(editor.doc.pagesById['page-0'].objects).toBe(before.pagesById['page-0'].objects);
        expect(editor.doc.pagesById['page-45']).toBe(before.pagesById['page-45']);
        expect(editor.doc.assets).toBe(before.assets);
        expect(events).toHaveLength(1);
        expect(events[0].changes).toEqual([{ path: ['pagesById', 'page-0', 'name'], value: 'Renamed', old: 'Page 0' }]);
        expect(events[0].changedShapeIds).toEqual({});
        expect(editor.undoStep()).toBe(true);
        expect(editor.doc.pagesById['page-0'].name).toBe('Page 0');
        editor.destroy();
    }, 60000);

    it('keeps native structuredClone and detached candidate semantics for custom mutators', () => {
        const editor = simple(), before = editor.doc;
        let retained: CanvasDocument;
        const returned = editor.transact('Clone candidate', draft => {
            retained = draft;
            const copied = structuredClone(draft);
            copied.pagesById[editor.pageId].objects.a.x = 999;
            draft.pagesById[editor.pageId].objects.b.name = 'Changed';
            return draft.pagesById[editor.pageId].objects.b;
        });
        editor.transact('Another edit', draft => { draft.pagesById[editor.pageId].objects.a.name = 'Later'; });
        retained!.pagesById[editor.pageId].objects.a.x = 700;
        returned.x = 800;
        expect(before.pagesById[editor.pageId].objects.b.name).not.toBe('Changed');
        expect(editor.page.objects.a.x).toBe(10);
        expect(editor.page.objects.b.name).toBe('Changed');
        expect(editor.page.objects.b.x).toBe(200);
        editor.destroy();
    });

    it('validates changed dependency graphs and preserves local previews across incremental host projections', () => {
        const editor = simple(), base = editor.doc, page = editor.pageId;
        editor.begin('Move');
        editor.preview(draft => { draft.pagesById[page].objects.a.x = 30; });
        const remote = applyPatches(base, [{ path: ['pagesById', page, 'objects', 'b', 'name'], value: 'Peer' }]);
        editor.receiveDocument(remote, { incremental: true });
        expect(editor.page.objects.a.x).toBe(30);
        expect(editor.page.objects.b.name).toBe('Peer');
        editor.cancelSession();
        expect(editor.page.objects.a.x).toBe(10);
        expect(editor.page.objects.b.name).toBe('Peer');
        const valid = editor.doc, invalid = applyPatches(valid, [{ path: ['pagesById', page, 'objects', 'a', 'parentId'], value: 'missing' }]);
        expect(() => editor.receiveDocument(invalid, { incremental: true })).toThrow();
        expect(editor.doc).toBe(valid);
        editor.destroy();
    });

    it('includes derived shape edits in preview invalidation and keeps rejected drafts atomic', () => {
        const doc = createDocument(), page = doc.pagesById[doc.pages[0]];
        insertShape(page, createShape('rect', { id: 'a' })); insertShape(page, createShape('rect', { id: 'b' }));
        const editor = new Editor(doc, { reconcile(_before, draft) { draft.pagesById[page.id].objects.b.x = draft.pagesById[page.id].objects.a.x + 200; } });
        const before = editor.doc, events: any[] = []; editor.on(event => events.push(event));
        editor.begin('Drag'); editor.preview(draft => { draft.pagesById[page.id].objects.a.x = 50; });
        expect(new Set(events[0].changedShapeIds[page.id])).toEqual(new Set(['a', 'b']));
        expect(before.pagesById[page.id].objects.b.x).toBe(0);
        expect(() => editor.preview(draft => { draft.pagesById[page.id].objects.a.width = -1; })).toThrow();
        expect(editor.page.objects.a.x).toBe(50);
        editor.cancelSession(); expect(editor.doc).toBe(before); editor.destroy();
    });
    it('validates and normalizes previously inactive pages when they become active', () => {
        const doc = createDocument(), dormant = createPage('Dormant', 'dormant');
        insertShape(dormant, createShape('rect', { id: 'shape', x: 10 }));
        dormant.objects.shape.x = 30;
        doc.pagesById[dormant.id] = dormant;
        const editor = new Editor(doc);
        editor.transact('Activate page', draft => { draft.pages.push(dormant.id); });
        expect(editor.doc.pagesById[dormant.id].objects.shape.box.x).toBe(30);
        const derived = new Editor(doc, { reconcile(_before, draft) { if (draft.extra?.activate && !draft.pages.includes(dormant.id)) draft.pages.push(dormant.id); } });
        derived.transact('Activate through reconciliation', draft => { draft.extra = { activate: true }; });
        expect(derived.doc.pagesById[dormant.id].objects.shape.box.x).toBe(30);
        derived.destroy();
        const broken = createPage('Broken', 'broken'); delete (broken.objects as any).root;
        // Inactive legacy entries are permitted by the full constructor, but
        // adding them to the visible page list must run the graph boundary.
        const seed = createDocument(); seed.pagesById.broken = broken;
        const rejecting = new Editor(seed), before = rejecting.doc;
        expect(() => rejecting.transact('Activate invalid page', draft => { draft.pages.push('broken'); })).toThrow();
        expect(rejecting.doc).toBe(before);
        rejecting.destroy(); editor.destroy();
    });
    it('restores derived frame membership when reconciliation reverses an initial reparent', () => {
        const doc = createDocument(), page = doc.pagesById[doc.pages[0]];
        insertShape(page, createShape('frame', { id: 'left', childIds: [] }));
        insertShape(page, createShape('frame', { id: 'right', childIds: [] }));
        insertShape(page, createShape('rect', { id: 'a' }), 'left');
        const move = (draft: CanvasDocument, target: string) => {
            const objects = draft.pagesById[page.id].objects, shape = objects.a;
            objects[shape.parentId].childIds = objects[shape.parentId].childIds!.filter(id => id !== shape.id);
            objects[target].childIds!.push(shape.id); shape.parentId = target;
        };
        const editor = new Editor(doc, { reconcile(_before, draft) { move(draft, 'left'); } }), before = editor.doc;
        editor.transact('Reparent then restore', draft => move(draft, 'right'));
        expect(editor.page.objects.a.parentId).toBe('left');
        expect(editor.page.objects.a.enclosingFrameId).toBe('left');
        expect(editor.doc).toBe(before);
        editor.destroy();
    });
});

describe('exact incremental document sizing', () => {
    it('remeasures mutable full snapshots and custom serializers after string-cache reuse', () => {
        const custom = { value: '한글', toJSON(key: string) { return { key, value: this.value }; } };
        const value: any = { text: 'initial', array: [undefined, NaN, -0, true], nested: { count: 1 }, custom };
        for (const text of ['initial', '"\\\n\ud800', '😀'.repeat(1000), 'changed']) {
            value.text = text; value.nested.count *= 1e7; custom.value = text;
            expect(documentJSONBytes(value)).toBe(nativeBytes(value));
        }
        delete value.custom;
        expect(documentJSONBytes(value)).toBe(nativeBytes(value));
        value.nested.cycle = value;
        expect(() => documentJSONBytes(value)).toThrow(/Cyclic/);
    });
    it('matches native JSON bytes for escapes, array omissions, repeated objects and custom serializers', () => {
        const shared = { text: '한글 😀 \ud800 " \\ \n', optional: undefined };
        const values = [{ shared, again: shared, array: [undefined, NaN, Infinity, -0, null] }, { a: new Date('2020-01-01'), b: new Uint8Array([1, 2]) }];
        class KeyAware { toJSON(key: string) { return { key }; } }
        values.push({ nested: { value: new KeyAware() }, array: [new KeyAware()] } as any);
        for (const value of values) {
            expect(documentJSONBytes(value)).toBe(nativeBytes(value));
            expect(documentJSONBytes({ ...value, extra: 'new' }, true)).toBe(nativeBytes({ ...value, extra: 'new' }));
        }
    });
    it('does not let a cached unchanged subtree hide oversized or cyclic local writes', () => {
        const editor = simple(), before = editor.doc;
        expect(() => editor.transact('Oversize', draft => { draft.extra = 'x'.repeat(16 * 1024 * 1024); })).toThrow(/16 MiB/);
        expect(editor.doc).toBe(before);
        expect(() => editor.transact('Cycle', draft => { const value: any = {}; value.self = value; draft.extra = value; })).toThrow();
        expect(editor.doc).toBe(before);
        editor.destroy();
    });
    it('keeps exact cached dictionary totals across additions, removals, omissions and atomic arrays', () => {
        let before: any = { pagesById: { p: { objects: { a: { text: '😀', optional: undefined }, b: { width: 2 } } } }, extra: { alone: 1 } };
        expect(documentJSONBytes(before)).toBe(nativeBytes(before));
        const edits = [
            [{ path: ['pagesById', 'p', 'objects', 'a', 'text'], value: '한글 \\ "\n' }],
            [{ path: ['pagesById', 'p', 'objects', 'a', 'optional'], value: [undefined, 3, { label: 'x' }] }],
            [{ path: ['pagesById', 'p', 'objects', 'b'], remove: true }],
            [{ path: ['pagesById', 'p', 'objects', 'new'], value: { width: 10 } }],
            [{ path: ['extra', 'alone'], remove: true }],
            [{ path: ['extra', 'omitted'], value: undefined }],
            [{ path: ['extra', 'omitted'], value: 'now present' }],
            [{ path: ['extra'], value: { replaced: true, empty: {} } }],
            [{ path: ['pagesById', 'p', 'objects', 'a', 'optional', '1'], value: 9000 }],
        ];
        for (const changes of edits) {
            const after = applyPatches(before, changes);
            expect(documentJSONBytes(after, true, { before, paths: changes.map(change => change.path) })).toBe(nativeBytes(after));
            before = after;
        }
        const cycle: any = { ...before }; cycle.cycle = cycle;
        expect(() => documentJSONBytes(cycle, true, { before, paths: [['cycle']] })).toThrow(/Cyclic/);
    });
});

describe('affected layout dependencies', () => {
    it('matches full layout for child resize and parent constraints without touching independent pages', () => {
        const before = createDocument(), page = before.pagesById[before.pages[0]], extra = createPage('Other');
        before.pages.push(extra.id); before.pagesById[extra.id] = extra;
        insertShape(page, createShape('frame', { id: 'row', width: 400, height: 100, layout: { type: 'flex', gap: 10 }, childIds: [] }));
        insertShape(page, createShape('rect', { id: 'a', width: 40, height: 20 }), 'row');
        insertShape(page, createShape('rect', { id: 'b', width: 60, height: 20 }), 'row');
        insertShape(page, createShape('frame', { id: 'fixed', x: 500, width: 200, height: 100, childIds: [] }));
        insertShape(page, createShape('rect', { id: 'anchored', x: 520, width: 50, horizontalConstraint: 'right' }), 'fixed');
        applyLayout(before);
        for (const [id, width] of [['a', 80], ['fixed', 300]] as const) {
            const full = structuredClone(before), scoped = structuredClone(before);
            full.pagesById[page.id].objects[id].width = width;
            scoped.pagesById[page.id].objects[id].width = width;
            const scope = changeScope(before, scoped, [['pagesById', page.id, 'objects', id]]);
            applyLayout(full, before); applyLayout(scoped, before, {}, scope);
            expect(scoped).toEqual(full);
        }
    });
});
