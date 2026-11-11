// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { Editor, createDocument, createShape, insertShape } from '../document';
import { createRenderer } from '../render';
import { inlineSVGImages, rasterizeSVG } from '../export/raster';
import { createThumbnailScheduler } from '../../src/document-thumbnail.mjs';

vi.mock('../export/raster', () => ({
    inlineSVGImages: vi.fn(async (source: string) => source),
    rasterizeSVG: vi.fn(async () => new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }))
}));
const cleanup: (() => void)[] = [];
afterEach(() => { cleanup.splice(0).reverse().forEach(fn => fn()); document.body.replaceChildren(); vi.restoreAllMocks(); vi.clearAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

function setup() {
    vi.stubGlobal('CSS', { escape: (s: string) => s });
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    Object.defineProperty(document, 'fonts', { configurable: true, value: Object.assign(new EventTarget(), { ready: Promise.resolve() }) });
    const decoded: string[] = [];
    vi.stubGlobal('Image', class { complete = true; naturalWidth = 1; set src(value: string) { decoded.push(value); } });
    const doc = createDocument(), page = doc.pagesById[doc.pages[0]];
    for (let i = 0; i < 600; i++) insertShape(page, createShape('rect', { id: `r${i}`, x: i * 1000, width: 80, height: 80 }));
    insertShape(page, createShape('frame', { id: 'remote', x: 100000, width: 500, height: 500, clipContent: true }));
    insertShape(page, createShape('image', { id: 'photo', parentId: 'remote', x: 100000, image: { src: 'https://example.invalid/remote.png' } }));
    const editor = new Editor(doc), stage = document.createElement('div'), ensure = vi.fn(async () => {});
    editor.setViewport({ zoom: 1, vport: { width: 800, height: 600 }, vbox: { x: 0, y: 0, width: 800, height: 600 } });
    document.body.append(stage);
    const view = createRenderer(editor, stage, { fonts: { ensure } });
    cleanup.push(() => editor.destroy(), () => view.destroy());
    return { editor, view, stage, ensure, decoded };
}
it('creates a viewport thumbnail without preparing any offscreen images or the full export scene', async () => {
    const { view, ensure, decoded } = setup();
    const before = view.renderDiagnostics();
    const shot = await view.thumbnailSnapshot!();
    expect(shot).toEqual({ data: 'AQID', mimeType: 'image/png' });
    expect(ensure).not.toHaveBeenCalled(); expect(decoded).toEqual([]);
    expect(view.renderDiagnostics().preparedObjects).toBe(before.preparedObjects);
    const source = vi.mocked(inlineSVGImages).mock.calls[0][0];
    expect(source).toContain('data-shape-id="r0"');
    expect(source).not.toContain('data-shape-id="r599"'); expect(source).not.toContain('remote.png');
    expect(vi.mocked(rasterizeSVG).mock.calls[0][1]).toEqual({ x: 0, y: 0, width: 800, height: 600 });
});
it('removes screen transforms and crops a translated scene to the logical thumbnail viewport', async () => {
    const { editor, view, stage } = setup();
    const svg = stage.querySelector('svg')!, anchor = svg.getAttribute('viewBox');
    editor.setViewport({ ...editor.viewport, vbox: { x: 100, y: 20, width: 800, height: 600 } });
    expect(svg.getAttribute('viewBox')).toBe(anchor); expect(svg.style.transform).toBe('translate(-500px, -320px)');
    await view.thumbnailSnapshot!();
    const source = vi.mocked(inlineSVGImages).mock.calls[0][0], parsed = new DOMParser().parseFromString(source, 'image/svg+xml').documentElement;
    expect(parsed.getAttribute('viewBox')).toBe('100 20 800 600');
    expect(parsed.getAttribute('style')).not.toContain('transform'); expect(parsed.getAttribute('style')).not.toContain('will-change');
    expect(vi.mocked(rasterizeSVG).mock.calls[0][1]).toEqual({ x: 100, y: 20, width: 800, height: 600 });
});
it('preserves the previous preview when mounted SVG exceeds the element or markup budget', async () => {
    const { view, stage } = setup(), svg = stage.querySelector('svg')!;
    const fragment = document.createDocumentFragment();
    for (let i = 0; i < 2001; i++) fragment.append(document.createElementNS('http://www.w3.org/2000/svg', 'g'));
    const holder = document.createElementNS('http://www.w3.org/2000/svg', 'g'); holder.append(fragment); svg.append(holder);
    expect(await view.thumbnailSnapshot!()).toBeNull(); holder.remove();
    svg.setAttribute('data-huge', 'x'.repeat(2 * 1024 * 1024));
    expect(await view.thumbnailSnapshot!()).toBeNull();
    expect(inlineSVGImages).not.toHaveBeenCalled(); expect(rasterizeSVG).not.toHaveBeenCalled();
});
it('ignores rename and pan after a saved preview and discards stale async captures', async () => {
    vi.useFakeTimers();
    const shot = { data: 'AQID', mimeType: 'image/png' }, save = vi.fn(async () => {});
    let release: ((value: typeof shot) => void) | undefined;
    const capture = vi.fn(async () => shot);
    let state = { id: 'document', pageId: 'page', view: { thumbnailSnapshot: capture }, objects: {}, assets: {}, viewport: {} };
    const scheduler = createThumbnailScheduler({ current: () => state, save, delay: 20 }); cleanup.push(() => scheduler.reset());
    scheduler.schedule(); await vi.advanceTimersByTimeAsync(20);
    expect(save).toHaveBeenCalledTimes(1);
    // A metadata-only edit and a pan preserve the immutable visual records.
    state = { ...state, viewport: {} }; scheduler.schedule(); await vi.advanceTimersByTimeAsync(20);
    expect(capture).toHaveBeenCalledTimes(1);
    capture.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    state = { ...state, objects: {} }; scheduler.schedule(); await vi.advanceTimersByTimeAsync(20);
    state = { ...state, pageId: 'other', objects: {}, viewport: {} }; scheduler.schedule();
    release!(shot); await vi.advanceTimersByTimeAsync(20);
    expect(save).toHaveBeenCalledTimes(2);
    expect(capture).toHaveBeenCalledTimes(3);
});
