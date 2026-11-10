// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Editor, createDocument, createShape, insertShape } from '../document';
import { createRenderer } from '../render';
import { ViewportPreparation } from '../render/viewport';
import type { Shape } from '../contracts';

const cleanups: (() => void)[] = [];
beforeEach(() => {
    vi.stubGlobal('CSS', { escape: (s: string) => s });
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    Object.defineProperty(document, 'fonts', { configurable: true, value: Object.assign(new EventTarget(), { ready: Promise.resolve() }) });
});
afterEach(() => { cleanups.splice(0).reverse().forEach(fn => fn()); document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function fixture(extra: Shape[] = [], options = {}) {
    const doc = createDocument(), page = doc.pagesById[doc.pages[0]];
    for (let i = 0; i < 600; i++) insertShape(page, createShape('rect', { id: `r${i}`, x: i * 1000, width: 80, height: 80, fills: [{ color: '#abcdef' }] }));
    for (const shape of extra) insertShape(page, shape);
    const editor = new Editor(doc), stage = document.createElement('div');
    editor.setViewport({ zoom: 1, vport: { width: 800, height: 600 }, vbox: { x: 0, y: 0, width: 800, height: 600 } });
    document.body.append(stage);
    const view = createRenderer(editor, stage, options);
    cleanups.push(() => editor.destroy(), () => view.destroy());
    return { editor, stage, view };
}
it('mounts an overscanned root window while offscreen measurement, styling and export retain the complete document', () => {
    const t = fixture();
    expect(t.view.renderDiagnostics()).toMatchObject({ viewportCulling: true, preparedRoots: 2, preparedObjects: 3 });
    expect(t.view.element('r0')).not.toBeNull(); expect(t.view.element('r100')).toBeNull();
    expect(t.view.measure(['r100']).get('r100')).toMatchObject({ x: 100000, w: 80 });
    expect(t.view.computedStyle('r100', ['background-color'])).toEqual({ 'background-color': '#abcdef' });
    expect(t.view.sceneSvg(['r100'])).toContain('100000');
    expect(t.view.sceneSvg()).toContain('data-shape-id="r599"');
    expect(t.view.element('r100')).toBeNull();
    t.editor.setViewport({ ...t.editor.viewport, vbox: { x: 100000, y: 0, width: 800, height: 600 } });
    expect(t.view.element('r100')).not.toBeNull(); expect(t.view.element('r0')).toBeNull();
    expect(t.view.renderDiagnostics().preparedObjects).toBeLessThan(6);
    t.editor.transact('Change offscreen fill', doc => { doc.pagesById[t.editor.pageId].objects.r0.fills = [{ color: '#123456' }]; });
    t.editor.setViewport({ ...t.editor.viewport, vbox: { x: 0, y: 0, width: 800, height: 600 } });
    expect(t.view.element('r0')!.querySelector('path')!.getAttribute('fill')).toBe('#123456');
});
it('retains overflowing children and unknown effects, keeps complete mask siblings, and disables culling for backdrop dependencies', () => {
    const t = fixture([
        createShape('group', { id: 'overflow', x: 10000, width: 100, height: 100 }),
        createShape('rect', { id: 'near-child', parentId: 'overflow', x: 50, width: 40, height: 40 }),
        createShape('rect', { id: 'effect', x: 10000, effects: [{ type: 'dropShadow', offset: { x: -10000, y: 0 } }] }),
        createShape('frame', { id: 'mask-group', x: 100, width: 100, height: 100, isMaskGroup: true, maskType: 'alpha' }),
        createShape('rect', { id: 'mask', parentId: 'mask-group', hidden: true }),
        createShape('rect', { id: 'masked', parentId: 'mask-group', x: 110 })
    ]);
    expect(t.view.element('near-child')).not.toBeNull(); expect(t.view.element('effect')).not.toBeNull();
    expect(t.stage.querySelector('mask')!.children).toHaveLength(0);
    expect(t.view.element('masked')).not.toBeNull();
    t.editor.transact('Add glass', doc => { doc.pagesById[t.editor.pageId].objects.r1.backgroundBlur = 8; });
    expect(t.view.element('r599')).not.toBeNull();
    expect(t.view.renderDiagnostics().preparedObjects).toBe(Object.keys(t.editor.page.objects).length);
});
it('defers image preparation outside clipped offscreen frames, resolves immutable sources, and pins selected roots', async () => {
    const decoded: string[] = [];
    vi.stubGlobal('Image', class { complete = true; naturalWidth = 1; set src(value: string) { decoded.push(value); } });
    const ref = 'omc-asset:sha256:' + 'a'.repeat(64), url = 'omc://canvas/assets/' + 'a'.repeat(64);
    const t = fixture([
        createShape('frame', { id: 'offscreen', x: 10000, width: 500, height: 500, clipContent: true }),
        createShape('image', { id: 'photo', parentId: 'offscreen', x: 10000, image: { src: ref } })
    ], { resolveImageSource: (source: string) => source === ref ? url : source });
    expect(decoded).toEqual([]); expect(t.view.element('photo')).toBeNull();
    t.editor.setSelection(['photo']);
    expect(decoded).toEqual([url]);
    expect(t.view.element('photo')!.ownerSVGElement!.querySelector('pattern image')!.getAttribute('href')).toBe(url);
    t.editor.setSelection([]);
    expect(t.view.element('photo')).toBeNull();
    await t.view.settled();
    expect(t.view.sceneSvg(['offscreen'])).toContain(url);
    expect(t.view.sceneSvg(['offscreen'])).not.toContain(ref);
});
it('never guesses bounds for unbounded text but permits culling its clipped frame', () => {
    const doc = createDocument(), objects = doc.pagesById[doc.pages[0]].objects;
    for (let i = 0; i < 520; i++) objects[`r${i}`] = createShape('rect', { id: `r${i}`, x: 10000 });
    objects.root.childIds = ['frame', 'loose', 'path'];
    objects.frame = createShape('frame', { id: 'frame', x: 10000, width: 100, height: 100, clipContent: true, childIds: ['text'] });
    objects.text = createShape('text', { id: 'text', parentId: 'frame', x: 10000 });
    objects.loose = createShape('text', { id: 'loose', x: 10000 });
    objects.path = createShape('path', { id: 'path', x: 10000, width: 20, height: 20 });
    objects.path.content = [{ command: 'move', x: 50, y: 50 }, { command: 'curve', x1: 0, y1: 0, x2: 100, y2: 100, x: 50, y: 100 }];
    const preparation = new ViewportPreparation();
    preparation.update(objects, { x: 0, y: 0, width: 800, height: 600 });
    expect(preparation.roots).toEqual(['loose', 'path']);
    expect(preparation.objects.text).toBeUndefined();
    expect(preparation.update(objects, { x: 10, y: 0, width: 800, height: 600 })).toBe(false);
});
it.each(['background-blur', 'BACKDROP_BLUR'])('retains backdrop source roots for the %s effect representation', type => {
    const t = fixture([createShape('rect', { id: 'glass', x: 10, width: 100, height: 100, effects: [{ type, radius: 8 }] })]);
    expect(t.view.element('r599')).not.toBeNull();
    expect(t.view.renderDiagnostics().preparedObjects).toBe(Object.keys(t.editor.page.objects).length);
    t.editor.transact('Remove backdrop effect', doc => { doc.pagesById[t.editor.pageId].objects.glass.effects = []; });
    expect(t.view.element('r599')).toBeNull();
    expect(t.view.element('glass')).not.toBeNull();
});
