import { describe, expect, it, vi } from 'vitest';
import { Editor, createDocument, createPage, createShape, insertShape } from '../document';
import { applyPatches } from '../document/journal';
import { assertDocument, assertDocumentChanges, projectChanges } from '../../core/document.mjs';
import type { CanvasDocument, EditorOptions } from '../contracts';

function fixture(options: EditorOptions = {}): Editor {
    const doc = createDocument(), first = doc.pagesById[doc.pages[0]], second = createPage('Unchanged page', 'other');
    insertShape(first, createShape('rect', { id: 'a', x: 10 }));
    insertShape(first, createShape('rect', { id: 'b', x: 100 }));
    for (let index = 0; index < 20; index++) insertShape(second, createShape('rect', { id: `other-${index}`, x: index * 20 }));
    doc.pages.push(second.id); doc.pagesById[second.id] = second;
    const editor = new Editor(doc, { validate: assertDocument, validateChanges: assertDocumentChanges, ...options });
    // The mount boundary establishes the proof on the normalized editor root.
    assertDocument(editor.doc);
    return editor;
}

function renameWithoutReadingOtherShapes(editor: Editor): void {
    const untouched = editor.doc.pagesById.other.objects;
    const entries = vi.spyOn(Object, 'entries');
    let inspected: unknown[];
    try {
        editor.transact('Rename page', draft => { draft.pagesById[editor.pageId].name = 'Renamed'; });
        inspected = entries.mock.calls.map(([value]) => value);
    }
    finally { entries.mockRestore(); }
    expect(inspected!).not.toContain(untouched);
    expect(editor.doc.pagesById.other.objects).toBe(untouched);
}

describe('host validation of published document projections', () => {
    it('keeps the first page rename incremental after final import diagnostics arrive', () => {
        const editor = fixture(), before = editor.doc;
        const remote = projectChanges(before, [[JSON.stringify(['meta', 'extra']), { importWarnings: ['Review unsupported effect'] }]]);
        editor.receiveDocument(remote, { incremental: true });
        expect(editor.doc.extra.importWarnings).toEqual(['Review unsupported effect']);
        renameWithoutReadingOtherShapes(editor);
        expect(editor.undoStep()).toBe(true);
        expect(editor.doc.extra.importWarnings).toEqual(['Review unsupported effect']);
        expect(editor.page.name).toBe(before.pagesById[editor.pageId].name);
        editor.destroy();
    });

    it('fully validates a normalized snapshot before publishing its exact shared identity', () => {
        let editor: Editor, validated: CanvasDocument | undefined;
        const validate = vi.fn((document: CanvasDocument) => {
            expect(editor.doc).not.toBe(document);
            expect(document.pagesById[editor.pageId].objects.a.box.x).toBe(30);
            assertDocument(document); validated = document;
        });
        const incremental = vi.fn(assertDocumentChanges);
        editor = fixture({ validate, validateChanges: incremental });
        const before = editor.doc, incoming = structuredClone(before), listener = vi.fn();
        incoming.pagesById[editor.pageId].objects.a.x = 30;
        editor.on(listener); editor.receiveDocument(incoming);
        expect(validate).toHaveBeenCalledOnce();
        expect(incremental).not.toHaveBeenCalled();
        expect(editor.doc).toBe(validated);
        expect(editor.doc).not.toBe(incoming);
        expect(editor.doc.pagesById.other).toBe(before.pagesById.other);
        expect(listener).toHaveBeenCalledOnce();
        renameWithoutReadingOtherShapes(editor);
        editor.destroy();
    });

    it.each([true, false])('rejects a host constraint before publication (incremental=%s)', incremental => {
        const editor = fixture(), before = editor.doc, page = editor.pageId, listener = vi.fn();
        editor.setSelection(['a']); editor.on(listener);
        // Core geometry is bounded at 1e8; the editor graph boundary alone
        // accepts this value. This must fail at the actual host boundary.
        const incoming = applyPatches(before, [{ path: ['pagesById', page, 'objects', 'a', 'x'], value: 2e8 }]);
        expect(() => editor.receiveDocument(incoming, { incremental })).toThrow(/geometry/);
        expect(editor.doc).toBe(before);
        expect(editor.selection).toEqual(['a']);
        expect(listener).not.toHaveBeenCalled();
        expect(editor.undoStep()).toBe(false);
        editor.destroy();
    });

    it.each([true, false])('rejects a host constraint without rebasing a live gesture (incremental=%s)', incremental => {
        const editor = fixture(), baseline = editor.doc, page = editor.pageId;
        editor.begin('Drag');
        editor.preview(draft => { draft.pagesById[page].objects.a.x = 20; });
        editor.preview(draft => { draft.pagesById[page].objects.a.x = 30; });
        const preview = editor.doc, listener = vi.fn(); editor.on(listener);
        const incoming = applyPatches(baseline, [{ path: ['pagesById', page, 'objects', 'b', 'x'], value: 2e8 }]);
        expect(() => editor.receiveDocument(incoming, { incremental })).toThrow(/geometry/);
        expect(editor.doc).toBe(preview);
        expect(editor.activeSession).toBe(true);
        expect(listener).not.toHaveBeenCalled();
        expect(editor.undoSession()).toBe(true); expect(editor.page.objects.a.x).toBe(20);
        expect(editor.redoSession()).toBe(true); expect(editor.page.objects.a.x).toBe(30);
        editor.cancelSession(); expect(editor.doc).toBe(baseline);
        expect(editor.page.objects.b.x).toBe(100);
        editor.destroy();
    });

    it('validates the incoming baseline before rebasing previews and preserves its proof on cancel', () => {
        const validated = new WeakSet<object>(), pairs: [CanvasDocument, CanvasDocument][] = [];
        const editor = fixture({ validateChanges(before, after) {
            expect(validated.has(before)).toBe(true);
            assertDocumentChanges(before, after); validated.add(after); pairs.push([before, after]);
        } });
        const baseline = editor.doc, page = editor.pageId; validated.add(baseline);
        editor.begin('Drag'); editor.preview(draft => { draft.pagesById[page].objects.a.x = 30; });
        const remote = projectChanges(baseline, [[JSON.stringify(['meta', 'extra']), { importWarnings: ['Review imported component'] }]]);
        pairs.length = 0; editor.receiveDocument(remote, { incremental: true });
        expect(pairs[0]).toEqual([baseline, remote]);
        expect(pairs[0][1]).toBe(remote);
        expect(pairs.slice(1).every(([before]) => before === remote)).toBe(true);
        expect(editor.page.objects.a.x).toBe(30);
        editor.cancelSession(); expect(editor.doc).toBe(remote);
        expect(editor.doc.extra.importWarnings).toEqual(['Review imported component']);
        renameWithoutReadingOtherShapes(editor);
        editor.destroy();
    });

    it('validates the published baseline when sharing a no-op snapshot returns the existing root', () => {
        const validate = vi.fn(assertDocument), editor = fixture({ validate }), before = editor.doc;
        editor.receiveDocument(structuredClone(before));
        expect(editor.doc).toBe(before);
        expect(validate).toHaveBeenCalledWith(before);
        editor.destroy();
    });
});
