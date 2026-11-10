// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { Editor, createDocument, createShape, insertShape } from '../document';
import { createRenderer } from '../render';
import { invalidateTextMetrics } from '../render/metric-cache';

const cleanup: (() => void)[] = [];
afterEach(() => {
    cleanup.splice(0).reverse().forEach(fn => fn());
    document.body.replaceChildren();
    vi.restoreAllMocks(); vi.unstubAllGlobals();
});
function setup(options = {}) {
    vi.stubGlobal('CSS', { escape: (s: string) => s });
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    const fonts = Object.assign(new EventTarget(), { ready: Promise.resolve() });
    Object.defineProperty(document, 'fonts', { configurable: true, value: fonts });
    const doc = createDocument(), page = doc.pagesById[doc.pages[0]];
    for (let i = 0; i < 100; i++) insertShape(page, createShape('rect', { id: `r${i}`, x: i * 12, width: 10, height: 10 }));
    const editor = new Editor(doc), stage = document.createElement('div'), attach = vi.fn();
    document.body.append(stage);
    const view = createRenderer(editor, stage, { ...options, onTiming: (t: { phase: string }) => { if (t.phase === 'render.attachSvg') attach(); } });
    cleanup.push(() => editor.destroy(), () => view.destroy());
    return { editor, view, attach, fonts };
}
it('retains the rendered DOM for unchanged settling and updates an edited element in place', async () => {
    const { editor, view, attach } = setup();
    const initial = view.element('r0'); attach.mockClear();
    await view.settled(); await view.settled();
    expect(attach).not.toHaveBeenCalled(); expect(view.element('r0')).toBe(initial);
    editor.transact('Move', doc => { doc.pagesById[editor.pageId].objects.r0.x = 32; });
    await view.settled();
    expect(attach).toHaveBeenCalledTimes(1); expect(view.element('r0')).toBe(initial);
    expect(view.measure(['r0']).get('r0')!.x).toBe(32);
});
it('still renders font completion and font metrics invalidated by ensure', async () => {
    let invalidate = false;
    const { view, attach, fonts } = setup({ fonts: { ensure: async () => { if (invalidate) { invalidate = false; invalidateTextMetrics(); } } } });
    await view.settled(); attach.mockClear();
    fonts.dispatchEvent(new Event('loadingdone'));
    await view.settled(); expect(attach).toHaveBeenCalledTimes(1);
    attach.mockClear(); invalidate = true;
    await view.settled(); expect(attach).toHaveBeenCalledTimes(1);
    attach.mockClear(); await view.settled(); expect(attach).not.toHaveBeenCalled();
});
it('rechecks resources when a document changes during ensure', async () => {
    let finish: (() => void) | undefined, wait = false;
    const ensure = vi.fn(() => wait ? new Promise<void>(resolve => { finish = resolve; wait = false; }) : Promise.resolve());
    const { editor, view, attach } = setup({ fonts: { ensure } });
    await view.settled(); ensure.mockClear(); attach.mockClear(); wait = true;
    const pending = view.settled();
    editor.transact('Move during resource loading', doc => { doc.pagesById[editor.pageId].objects.r0.x = 44; });
    finish!(); await pending;
    expect(ensure).toHaveBeenCalledTimes(2); expect(attach).toHaveBeenCalledTimes(1);
    expect(view.measure(['r0']).get('r0')!.x).toBe(44);
});
it('resolves page objects once for a multi-layer diagnostics call', () => {
    const { editor, view } = setup();
    const enumerate = vi.fn(Reflect.ownKeys);
    editor.page.objects = new Proxy(editor.page.objects, { ownKeys: enumerate });
    expect(view.measure([]).size).toBe(0); expect(enumerate).not.toHaveBeenCalled();
    const result = view.measure(Array.from({ length: 100 }, (_, i) => `r${i}`));
    expect(result.size).toBe(100); expect(enumerate).toHaveBeenCalledTimes(1);
});
it('still waits for newly discovered image decoding without replacing unchanged SVG', async () => {
    let image: { onload?: () => void } | undefined, decoded: (() => void) | undefined;
    vi.stubGlobal('Image', class {
        complete = false;
        naturalWidth = 10;
        onload?: () => void;
        onerror?: () => void;
        constructor() { image = this; }
        set src(_value: string) {}
        decode() { return new Promise<void>(resolve => { decoded = resolve; }); }
    });
    const { editor, view, attach } = setup();
    editor.transact('Add image', doc => {
        insertShape(doc.pagesById[editor.pageId], createShape('image', { id: 'image', width: 20, height: 20, image: { src: 'data:image/png;base64,AA==' } }));
    });
    attach.mockClear(); let complete = false;
    const pending = view.settled().then(() => { complete = true; });
    await Promise.resolve(); expect(complete).toBe(false);
    image!.onload!(); await Promise.resolve(); expect(complete).toBe(false);
    decoded!(); await pending;
    expect(complete).toBe(true); expect(attach).not.toHaveBeenCalled();
    expect(view.measure(['image']).get('image')!.imageFailed).toBeUndefined();
});
