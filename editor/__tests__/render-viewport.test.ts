// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Editor, createDocument, createPage, createShape, insertShape } from '../document';
import { createRenderer } from '../render';
import { ViewportPreparation } from '../render/viewport';
import * as text from '../render/text';
import type { EditorEvent, Shape } from '../contracts';

const cleanups: (() => void)[] = [];
beforeEach(() => {
    vi.stubGlobal('CSS', { escape: (s: string) => s });
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    Object.defineProperty(document, 'fonts', { configurable: true, value: Object.assign(new EventTarget(), { ready: Promise.resolve() }) });
});
afterEach(() => { cleanups.splice(0).reverse().forEach(fn => fn()); document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function fixture(extra: Shape[] = [], options = {}, paddingParent = 'root', filterEvent?: (event: EditorEvent) => EditorEvent) {
    const doc = createDocument(), page = doc.pagesById[doc.pages[0]];
    for (const shape of extra) insertShape(page, shape);
    for (let i = 0; i < 600; i++) insertShape(page, createShape('rect', { id: `r${i}`, parentId: paddingParent, x: i * 1000, width: 80, height: 80, fills: [{ color: '#abcdef' }] }));
    const editor = new Editor(doc), stage = document.createElement('div');
    if (filterEvent) { const on = editor.on.bind(editor); editor.on = listener => on(event => listener(filterEvent(event))); }
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
it('defers image preparation outside clipped offscreen frames, resolves immutable sources, and pins selected ancestry', async () => {
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
it('prunes bounded child subtrees under a stroked ancestor and refreshes them without changing the root set', () => {
    vi.spyOn(text, 'measureTextScene').mockReturnValue({ fragments: new Map(), textSizes: new Map() });
    const t = fixture([
        createShape('group', { id: 'board', width: 12000, height: 1000, strokes: [{ color: '#a855f7', width: 1 }] }),
        createShape('frame', { id: 'near-frame', parentId: 'board', width: 200, height: 200, clipContent: true }),
        createShape('text', { id: 'near-text', parentId: 'near-frame' }),
        createShape('frame', { id: 'far-frame', parentId: 'board', x: 10000, width: 200, height: 200, clipContent: true }),
        createShape('text', { id: 'far-text', parentId: 'far-frame', x: 10000 }),
        // Loose text may overflow its box; it has no safe screen bound yet.
        createShape('text', { id: 'unknown-text', parentId: 'board', x: 20000 })
    ], {}, 'board');
    const board = t.view.element('board');
    expect(t.view.renderDiagnostics()).toMatchObject({ preparedRoots: 1, preparedObjects: 7 });
    expect(t.view.element('near-text')).not.toBeNull(); expect(t.view.element('far-frame')).toBeNull();
    expect(t.view.element('unknown-text')).not.toBeNull();
    expect(t.view.sceneSvg()).toContain('data-shape-id="far-text"');
    t.editor.setViewport({ ...t.editor.viewport, vbox: { x: 10000, y: 0, width: 800, height: 600 } });
    expect(t.view.element('board')).toBe(board); expect(t.view.element('near-frame')).toBeNull();
    expect(t.view.element('far-text')).not.toBeNull(); expect(t.view.element('r10')).not.toBeNull();
    expect(t.view.element('r0')).toBeNull(); expect(t.view.renderDiagnostics().preparedRoots).toBe(1);
    t.editor.transact('Edit culled nested child', doc => { doc.pagesById[t.editor.pageId].objects.r0.fills = [{ color: '#123456' }]; });
    t.editor.setViewport({ ...t.editor.viewport, vbox: { x: 0, y: 0, width: 800, height: 600 } });
    expect(t.view.element('r0')!.querySelector('path')!.getAttribute('fill')).toBe('#123456');
    expect(t.view.element('far-frame')).toBeNull(); expect(t.view.element('near-text')).not.toBeNull();
});
it('pins a selected child and its ancestry without mounting unrelated offscreen siblings', () => {
    const t = fixture([
        createShape('group', { id: 'board', width: 30000, height: 1000, strokes: [{ color: '#a855f7', width: 1 }] }),
        createShape('frame', { id: 'first', parentId: 'board', x: 10000, width: 200, height: 200, clipContent: true }),
        createShape('rect', { id: 'first-child', parentId: 'first', x: 10000 }),
        createShape('frame', { id: 'second', parentId: 'board', x: 20000, width: 200, height: 200, clipContent: true }),
        createShape('rect', { id: 'second-child', parentId: 'second', x: 20000 })
    ], {}, 'board');
    t.editor.setSelection(['first-child']);
    expect(t.view.element('first')).not.toBeNull(); expect(t.view.element('first-child')).not.toBeNull();
    expect(t.view.element('second')).toBeNull(); expect(t.view.element('r100')).toBeNull();
    t.editor.setSelection(['second-child']);
    expect(t.view.element('first')).toBeNull(); expect(t.view.element('second-child')).not.toBeNull();
    t.editor.setSelection(['board']);
    expect(t.view.element('first-child')).not.toBeNull(); expect(t.view.element('r599')).not.toBeNull();
    t.editor.setSelection([]);
    expect(t.view.element('first')).toBeNull(); expect(t.view.element('second')).toBeNull();
});
it.each([
    { effects: [{ type: 'dropShadow', offset: { x: -10000, y: 0 } }] },
    { shadows: [{ offsetX: -10000, blur: 10 }] },
    { blur: 10000 },
    { isMaskGroup: true, maskType: 'alpha' },
    { type: 'boolean', booleanOperation: 'subtract' }
])('keeps sibling/filter dependencies together below an unbounded ancestor (%j)', dependency => {
    const doc = createDocument(), objects = doc.pagesById[doc.pages[0]].objects;
    for (let i = 0; i < 520; i++) objects[`r${i}`] = createShape('rect', { id: `r${i}`, x: 10000 });
    objects.root.childIds = ['board'];
    objects.board = createShape('group', { id: 'board', width: 12000, strokes: [{ width: 1 }], childIds: ['dependency'] });
    objects.dependency = createShape('group', { id: 'dependency', parentId: 'board', childIds: ['first', 'far'], ...dependency });
    objects.first = createShape('rect', { id: 'first', parentId: 'dependency', width: 100, height: 100 });
    objects.far = createShape('rect', { id: 'far', parentId: 'dependency', x: 10000, width: 100, height: 100 });
    const preparation = new ViewportPreparation();
    preparation.update(objects, { x: 0, y: 0, width: 800, height: 600 });
    expect(preparation.objects.first).toBe(objects.first);
    expect(preparation.objects.far).toBe(objects.far);
});
it('unions queued preview scopes and consumes them safely during selection, cancellation, Undo, and page changes', () => {
    const callbacks: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callbacks.push(callback); return callbacks.length; });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    const t = fixture(), initial = t.editor.page.objects;
    const update = vi.spyOn(ViewportPreparation.prototype, 'update');
    t.editor.begin('Drag');
    t.editor.preview(doc => { doc.pagesById[t.editor.pageId].objects.r20.x = 20; });
    t.editor.preview(doc => { doc.pagesById[t.editor.pageId].objects.r21.x = 30; });
    expect(callbacks).toHaveLength(1); expect(t.stage.querySelector('[data-shape-id="r20"]')).toBeNull();
    callbacks[0](0);
    expect(t.view.element('r20')).not.toBeNull(); expect(t.view.element('r21')).not.toBeNull();
    const span = update.mock.calls[0][3]!;
    expect(span.before).toBe(initial); expect(span.after).toBe(t.editor.page.objects);
    expect(span.ids).toEqual(new Set(['r20', 'r21']));
    update.mockClear(); const previous = t.editor.page.objects;
    t.editor.preview(doc => { doc.pagesById[t.editor.pageId].objects.r22.x = 40; });
    t.editor.setSelection(['r23']);
    expect(t.view.element('r22')).not.toBeNull(); expect(t.view.element('r23')).not.toBeNull();
    expect(update.mock.calls[0][3]).toEqual({ before: previous, after: t.editor.page.objects, ids: new Set(['r22']) });
    update.mockClear(); const selectedSource = t.editor.page.objects;
    t.editor.preview(doc => { doc.pagesById[t.editor.pageId].objects.r24.x = 150; });
    t.editor.setViewport({ ...t.editor.viewport, vbox: { x: 100, y: 0, width: 800, height: 600 } });
    expect(t.view.element('r24')).not.toBeNull();
    expect(update.mock.calls[0][3]).toEqual({ before: selectedSource, after: t.editor.page.objects, ids: new Set(['r24']) });
    t.editor.cancelSession();
    expect(t.view.element('r20')).toBeNull(); expect(t.view.element('r21')).toBeNull(); expect(t.view.element('r22')).toBeNull();
    expect(t.view.element('r24')).toBeNull();
    t.editor.setSelection([]);
    t.editor.transact('Bring into view', doc => { doc.pagesById[t.editor.pageId].objects.r30.x = 50; });
    expect(t.view.element('r30')).not.toBeNull();
    t.editor.undoStep(); expect(t.view.element('r30')).toBeNull();
    t.editor.redoStep(); expect(t.view.element('r30')).not.toBeNull();
    const first = t.editor.pageId;
    t.editor.transact('Add page', doc => { const page = createPage('Other', 'other'); doc.pages.push(page.id); doc.pagesById[page.id] = page; });
    update.mockClear(); t.editor.setPage('other');
    expect(update.mock.calls[0][3]).toBeUndefined(); expect(t.view.element('r30')).toBeNull();
    t.editor.setPage(first); expect(t.view.element('r30')).not.toBeNull();
});
it('keeps an unknown event gap unknown until preparation has consumed the full source', () => {
    const callbacks: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callbacks.push(callback); return callbacks.length; });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    let omitScope = false;
    const t = fixture([], {}, 'root', event => { const { changedShapeIds, ...legacy } = event; return omitScope ? legacy : event; });
    const update = vi.spyOn(ViewportPreparation.prototype, 'update');
    t.editor.begin('Legacy event gap');
    t.editor.preview(doc => { doc.pagesById[t.editor.pageId].objects.r20.x = 20; });
    omitScope = true;
    t.editor.preview(doc => { doc.pagesById[t.editor.pageId].objects.r21.x = 30; });
    omitScope = false;
    t.editor.preview(doc => { doc.pagesById[t.editor.pageId].objects.r22.x = 40; });
    callbacks[0](0);
    expect(update.mock.calls[0][3]).toBeUndefined();
    for (const id of ['r20', 'r21', 'r22']) expect(t.view.element(id)).not.toBeNull();
    update.mockClear(); const before = t.editor.page.objects;
    t.editor.preview(doc => { doc.pagesById[t.editor.pageId].objects.r23.x = 50; });
    callbacks[1](0);
    expect(update.mock.calls[0][3]).toEqual({ before, after: t.editor.page.objects, ids: new Set(['r23']) });
    t.editor.cancelSession();
    for (const id of ['r20', 'r21', 'r22', 'r23']) expect(t.view.element(id)).toBeNull();
});
