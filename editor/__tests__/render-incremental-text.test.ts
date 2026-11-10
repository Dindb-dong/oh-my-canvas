// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { Editor, createDocument, createShape, insertShape, removeShapes } from '../document';
import { createRenderer, SceneWriter, type TextFragment } from '../render';
import * as text from '../render/text';
import { invalidateTextMetrics } from '../render/metric-cache';
import type { Shape } from '../contracts';

const cleanup: (() => void)[] = [];
afterEach(() => {
    cleanup.splice(0).reverse().forEach(fn => fn());
    document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});
it('remeasures only changed text, preserves other runs, and refreshes all fragments when font metrics change', async () => {
    vi.stubGlobal('CSS', { escape: (id: string) => id });
    Object.defineProperty(document, 'fonts', { configurable: true, value: Object.assign(new EventTarget(), { ready: Promise.resolve() }) });
    // Deterministic measured fragments isolate renderer invalidation from native
    // glyph layout, which is covered by the desktop render acceptance journey.
    let ascent = 12;
    const measure = vi.spyOn(text, 'measureTextScene').mockImplementation((objects: Record<string, Shape>) => ({
        fragments: new Map(Object.values(objects).map(shape => [shape.id, [{
            text: String(shape.content), x: shape.x, y: shape.y, width: shape.width, height: 16, baseline: shape.y + ascent, paragraph: 0,
            style: { color: '#123456', fontFamily: 'sans-serif', fontSize: '16px', fontWeight: '400', fontStyle: 'normal', letterSpacing: '0px' }
        }] as TextFragment[]])),
        textSizes: new Map(Object.values(objects).map(shape => [shape.id, { width: shape.width, height: 16, scrollWidth: shape.width, scrollHeight: 16 }]))
    }));
    const doc = createDocument(), page = doc.pagesById[doc.pages[0]];
    for (const shape of [createShape('text', { id: 'a', content: 'First' }), createShape('text', { id: 'b', x: 200, content: 'Second' }), createShape('rect', { id: 'box' })]) insertShape(page, shape);
    const editor = new Editor(doc), stage = document.createElement('div'); document.body.append(stage);
    const view = createRenderer(editor, stage); cleanup.push(() => editor.destroy(), () => view.destroy());
    const a = view.element('a')!.querySelector('text'), b = view.element('b')!.querySelector('text'); measure.mockClear();
    editor.transact('Move rectangle', draft => { draft.pagesById[editor.pageId].objects.box.x = 20; });
    expect(measure).not.toHaveBeenCalled(); expect(view.element('a')!.querySelector('text')).toBe(a);
    editor.transact('Edit one text', draft => { const shape = draft.pagesById[editor.pageId].objects.a; shape.content = 'Updated'; shape.x = 25; });
    expect(measure).toHaveBeenCalledTimes(1); expect(Object.keys(measure.mock.calls[0][0])).toEqual(['a']);
    expect(view.element('a')!.querySelector('text')).toBe(a); expect(a!.textContent).toBe('Updated'); expect(a!.getAttribute('x')).toBe('25');
    expect(view.element('b')!.querySelector('text')).toBe(b); expect(b!.textContent).toBe('Second');
    const exported = view.sceneSvg(['a', 'b']);
    const expected = new SceneWriter(editor.page.objects, { exporting: true, textFragments: new Map(['a', 'b'].map(id => [id, view.textFragments(id)])) }).svg(['a', 'b'], view.bounds(['a', 'b']));
    expect(exported).toBe(expected); expect(exported).toContain('Updated'); expect(exported).toContain('Second');
    ascent = 15; measure.mockClear(); invalidateTextMetrics(); await view.settled();
    expect(measure).toHaveBeenCalledTimes(1); expect(Object.keys(measure.mock.calls[0][0])).toEqual(['a', 'b']);
    expect(a!.getAttribute('y')).toBe('15'); expect(b!.getAttribute('y')).toBe('15');
    expect(view.textFragments('a')[0].baseline).toBe(15);
    editor.transact('Delete text', draft => { removeShapes(draft.pagesById[editor.pageId], ['a']); });
    expect(view.textFragments('a')).toEqual([]); expect(view.textSize('a')).toBeUndefined(); expect(view.sceneSvg()).not.toContain('Updated');
});
