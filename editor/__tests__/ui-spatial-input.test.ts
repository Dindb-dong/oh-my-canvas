// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { Editor, createDocument, createShape, insertShape } from '../document';
import { createCanvasInteraction } from '../interaction/canvas';
import { SnapIndex } from '../render/spatial';
import type { EditorServices } from '../contracts';

const cleanups: (() => void)[] = [];
afterEach(() => { cleanups.splice(0).reverse().forEach(fn => fn()); document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function fixture() {
    vi.stubGlobal('CSS', { escape: (s: string) => s });
    const doc = createDocument(), page = doc.pagesById[doc.pages[0]];
    for (let i = 0; i < 1000; i++) insertShape(page, createShape('rect', { id: `r${i}`, x: i * 1000, width: 100, height: 100 }));
    insertShape(page, createShape('group', { id: 'group', x: 10000, width: 100, height: 100 }));
    insertShape(page, createShape('rect', { id: 'overflow', parentId: 'group', x: 20, y: 20, width: 30, height: 30 }));
    insertShape(page, createShape('frame', { id: 'clip', x: 8000, width: 100, height: 100, clipContent: true }));
    insertShape(page, createShape('rect', { id: 'clipped', parentId: 'clip', x: 25, y: 25, width: 30, height: 30 }));
    const editor = new Editor(doc), stage = document.createElement('div'), overlay = document.createElement('div');
    editor.setViewport({ zoom: 1, vport: { width: 800, height: 600 }, vbox: { x: 0, y: 0, width: 800, height: 600 } });
    stage.append(overlay); document.body.append(stage);
    stage.setPointerCapture = () => {};
    const frames = new Map<number, FrameRequestCallback>(); let nextFrame = 0;
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { frames.set(++nextFrame, cb); return nextFrame; });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
    const canvas = createCanvasInteraction(stage, overlay, { editor, view: { element: () => null, onRender: () => () => {} } } as unknown as EditorServices,
        { active: false, exit: async () => {} } as any, { context() {}, changed() {}, importFiles: async () => {} });
    cleanups.push(() => { canvas.destroy(); editor.destroy(); });
    return { editor, canvas, stage, frames };
}
it('narrows hit candidates while preserving overflow, z-order, grouping and ancestor clipping', () => {
    const t = fixture();
    expect(t.canvas.hit({ x: 30, y: 30 })?.id).toBe('group');
    expect(t.canvas.hit({ x: 30, y: 30 }, true)?.id).toBe('overflow');
    expect(t.canvas.diagnostics.hitCandidates).toBeLessThan(10);
    expect(t.canvas.hit({ x: 500030, y: 30 }, true)?.id).toBe('r500');
    t.editor.transact('Hide group', doc => { doc.pagesById[t.editor.pageId].objects.group.hidden = true; });
    expect(t.canvas.hit({ x: 30, y: 30 }, true)?.id).toBe('r0');
    expect(t.canvas.hit({ x: -500, y: -500 })).toBeNull();
});
it('coalesces wheel updates to one frame without losing accumulated distance, flushes on demand and cancels after destroy', () => {
    const t = fixture(), events = vi.fn();
    const off = t.editor.on(event => { if (event.viewport) events(); }); cleanups.push(off);
    for (let i = 0; i < 100; i++) t.stage.dispatchEvent(new WheelEvent('wheel', { deltaX: 2, deltaY: 3, bubbles: true, cancelable: true }));
    expect(events).not.toHaveBeenCalled(); expect(t.frames.size).toBe(1);
    const [id, callback] = [...t.frames][0]; t.frames.delete(id); callback(16);
    expect(events).toHaveBeenCalledTimes(1); expect(t.editor.viewport.vbox).toMatchObject({ x: 200, y: 300 });
    t.stage.dispatchEvent(new WheelEvent('wheel', { deltaX: 10, deltaY: 20, bubbles: true, cancelable: true }));
    t.canvas.flush(); expect(t.editor.viewport.vbox).toMatchObject({ x: 210, y: 320 }); expect(t.frames.size).toBe(0);
    t.stage.dispatchEvent(new WheelEvent('wheel', { deltaX: 100, bubbles: true, cancelable: true }));
    t.canvas.destroy(); expect(t.frames.size).toBe(0); expect(t.editor.viewport.vbox.x).toBe(210);
});
it('does not overwrite a newer externally selected viewport with a queued wheel position', () => {
    const t = fixture();
    t.stage.dispatchEvent(new WheelEvent('wheel', { deltaX: 100, bubbles: true, cancelable: true }));
    t.editor.setViewport({ ...t.editor.viewport, vbox: { x: 9000, y: 0, width: 800, height: 600 } });
    t.canvas.flush(); expect(t.editor.viewport.vbox.x).toBe(9000);
});
it('keeps global axis snapping and original tie order while skipping excluded candidates', () => {
    const a = createShape('rect', { id: 'a', x: 12, y: 10000, width: 20, height: 20 });
    const b = createShape('rect', { id: 'b', x: 8, y: -10000, width: 20, height: 20 });
    const index = new SnapIndex({ a, b });
    expect(index.nearest('x', 10, 5, new Set())).toEqual({ value: 12, distance: 2 });
    expect(index.nearest('x', 10, 5, new Set(['a']))).toEqual({ value: 8, distance: 2 });
    expect(index.nearest('x', 10, 2, new Set())).toEqual({ value: 10, distance: 2 });
});
