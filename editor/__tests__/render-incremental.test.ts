// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { Editor, createDocument, createPage, createShape, insertShape, reparentShapes, removeShapes } from '../document';
import { createRenderer, SceneWriter } from '../render';
import { SceneNodeCache, parseScene, resourceScope } from '../render/retained';
import type { Data, Shape } from '../contracts';

const cleanup: (() => void)[] = [];
afterEach(() => {
    cleanup.splice(0).reverse().forEach(fn => fn());
    document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});
const gradient = (color: string) => ({ type: 'linear', gradient: { type: 'linear', stops: [{ offset: 0, color }, { offset: 1, color: '#ffffff' }] } });
function setup(shapes: Shape[]) {
    vi.stubGlobal('CSS', { escape: (s: string) => s });
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    Object.defineProperty(document, 'fonts', { configurable: true, value: Object.assign(new EventTarget(), { ready: Promise.resolve() }) });
    const doc = createDocument(), page = doc.pagesById[doc.pages[0]];
    for (const shape of shapes) insertShape(page, shape);
    const editor = new Editor(doc), stage = document.createElement('div'), timings: Data[] = [];
    document.body.append(stage);
    const view = createRenderer(editor, stage, { onTiming: (record: Data) => timings.push(record) });
    cleanup.push(() => editor.destroy(), () => view.destroy());
    return { editor, view, stage, timings };
}
function canonical(node: Node): unknown {
    if (!(node instanceof Element)) return node.textContent;
    const normalize = (text: string) => text.replace(/omc-view-\d+/g, 'screen');
    const children = Array.from(node.childNodes);
    if (node.localName === 'defs') children.sort((a, b) => (a as Element).id.localeCompare((b as Element).id));
    return [node.localName, Array.from(node.attributes).map(attr => [attr.name, normalize(attr.value)]).sort(([a], [b]) => a.localeCompare(b)), children.map(canonical)];
}
function expectFreshScene(editor: Editor, stage: HTMLElement) {
    const live = stage.querySelector('svg')!, vp = editor.viewport;
    const expected = parseScene(new SceneWriter(editor.page.objects, { stableIds: true, idPrefix: 'screen' }).svg(editor.page.objects.root.childIds!, { x: vp.vbox.x, y: vp.vbox.y, width: vp.vport.width / vp.zoom, height: vp.vport.height / vp.zoom }));
    // Viewport-only CSS belongs to the host; compare every actual drawable/definition.
    expect(Array.from(live.children).map(canonical)).toEqual(Array.from(expected.children).map(canonical));
}
it('serializes and patches one edited leaf while preserving a large board and its other SVG nodes', () => {
    const frame = createShape('frame', { id: 'board', width: 2000, height: 2000 });
    const { editor, view, stage } = setup([frame, ...Array.from({ length: 250 }, (_, i) => createShape('rect', { id: `r${i}`, parentId: 'board', x: i * 12, width: 10, height: 10 }))]);
    const board = view.element('board'), untouched = view.element('r249'), edited = view.element('r0'), path = edited!.querySelector('path');
    editor.transact('Move and recolor', doc => { const shape = doc.pagesById[editor.pageId].objects.r0; shape.x = 35; shape.fills = [{ color: '#ff0000' }]; });
    expect(view.element('board')).toBe(board); expect(view.element('r249')).toBe(untouched);
    expect(view.element('r0')).toBe(edited); expect(edited!.querySelector('path')).toBe(path);
    expect(path!.getAttribute('fill')).toBe('#ff0000'); expect(view.measure(['r0']).get('r0')!.x).toBe(35);
    expect(view.renderDiagnostics()).toMatchObject({ mode: 'leaf', generatedNodes: 1, changedNodes: 1 });
    expectFreshScene(editor, stage);
});
it('keeps gradient references stable after insertion, reordering, and unrelated deletion', () => {
    const { editor, view, stage } = setup([createShape('rect', { id: 'a', fills: [gradient('#f00')] }), createShape('rect', { id: 'b', x: 120, fills: [gradient('#00f')] })]);
    const b = view.element('b'), fill = b!.querySelector('path')!.getAttribute('fill'), resource = stage.querySelector(fill!.slice(4, -1))!;
    editor.transact('Insert sibling before b', doc => { const page = doc.pagesById[editor.pageId]; insertShape(page, createShape('rect', { id: 'c', fills: [gradient('#0f0')] })); page.objects.root.childIds = ['c', 'b', 'a']; });
    expect(view.element('b')).toBe(b); expect(b!.querySelector('path')!.getAttribute('fill')).toBe(fill);
    expect(stage.querySelector(fill!.slice(4, -1))).toBe(resource);
    expectFreshScene(editor, stage);
    editor.transact('Remove first sibling', doc => { removeShapes(doc.pagesById[editor.pageId], ['c']); });
    expect(view.element('b')).toBe(b); expectFreshScene(editor, stage);
});
it('updates and removes only a leaf\'s obsolete gradient/filter definitions', () => {
    const { editor, view, stage } = setup([createShape('rect', { id: 'a', fills: [gradient('#f00')], blur: 2 }), createShape('rect', { id: 'b', fills: [gradient('#00f')] })]);
    const oldFill = view.element('a')!.querySelector('path')!.getAttribute('fill')!, b = view.element('b');
    editor.transact('Replace gradient', doc => { const s = doc.pagesById[editor.pageId].objects.a; s.fills = [{ color: '#123456' }]; s.blur = 0; });
    expect(stage.querySelector(oldFill.slice(4, -1))).toBeNull(); expect(view.element('b')).toBe(b);
    expect(stage.querySelectorAll('linearGradient')).toHaveLength(1); expect(stage.querySelectorAll('filter')).toHaveLength(0);
    expectFreshScene(editor, stage);
});
it('retains decoded image elements during unrelated edits and updates image sources and adjustments in place', async () => {
    vi.stubGlobal('Image', class { complete = true; naturalWidth = 1; src = ''; });
    const first = 'data:image/png;base64,AA==', second = 'data:image/png;base64,AQ==';
    const { editor, view, stage } = setup([
        createShape('image', { id: 'photo', image: { src: first }, adjust: { contrast: .2 } }),
        createShape('rect', { id: 'other' })
    ]);
    const image = stage.querySelector('pattern image'), filter = stage.querySelector('filter');
    editor.transact('Move sibling', doc => { doc.pagesById[editor.pageId].objects.other.x = 50; });
    expect(stage.querySelector('pattern image')).toBe(image); expect(stage.querySelector('filter')).toBe(filter);
    editor.transact('Change picture', doc => { const shape = doc.pagesById[editor.pageId].objects.photo; shape.image.src = second; shape.adjust.contrast = .8; });
    await view.settled();
    expect(stage.querySelector('pattern image')).toBe(image); expect(image!.getAttribute('href')).toBe(second);
    expect(stage.querySelector('filter')).toBe(filter);
    expect(view.sceneSvg(['photo'])).toContain(second); expect(view.sceneSvg(['photo'])).not.toContain(first);
    expectFreshScene(editor, stage);
});
it('preserves child order, clipping, and masks when structural changes require the general path', () => {
    const { editor, view, stage } = setup([
        createShape('frame', { id: 'left', width: 300, height: 300, clipContent: true }),
        createShape('rect', { id: 'child', parentId: 'left', fills: [gradient('#f00')] }),
        createShape('frame', { id: 'right', x: 400, width: 300, height: 300, isMaskGroup: true, maskType: 'alpha' }),
        createShape('ellipse', { id: 'mask', parentId: 'right', x: 400 }),
        createShape('rect', { id: 'masked', parentId: 'right', x: 400, fills: [gradient('#00f')] })
    ]);
    editor.transact('Edit mask', doc => { doc.pagesById[editor.pageId].objects.mask.width = 80; });
    expect(view.renderDiagnostics().mode).toBe('full'); expectFreshScene(editor, stage);
    editor.transact('Reparent', doc => { reparentShapes(doc.pagesById[editor.pageId], ['child'], 'right'); });
    expectFreshScene(editor, stage);
    editor.undoStep(); expectFreshScene(editor, stage);
});
it('invalidates retained descendants when hiding parents, switching mask modes, or replacing the page', () => {
    const { editor, view, stage } = setup([
        createShape('frame', { id: 'board', width: 300, height: 300, isMaskGroup: true, maskType: 'alpha' }),
        createShape('ellipse', { id: 'mask', parentId: 'board', fills: [gradient('#f00')] }),
        createShape('rect', { id: 'child', parentId: 'board', fills: [gradient('#00f')] })
    ]);
    editor.transact('Switch to vector mask', doc => { doc.pagesById[editor.pageId].objects.board.maskType = 'vector'; });
    expectFreshScene(editor, stage);
    editor.transact('Disable mask', doc => { doc.pagesById[editor.pageId].objects.board.isMaskGroup = false; });
    expect(stage.querySelectorAll('mask')).toHaveLength(0); expect(view.element('mask')).not.toBeNull(); expectFreshScene(editor, stage);
    editor.transact('Hide container', doc => { doc.pagesById[editor.pageId].objects.board.hidden = true; });
    expect(view.element('child')).toBeNull(); expectFreshScene(editor, stage);
    editor.undoStep(); expect(view.element('child')).not.toBeNull(); expectFreshScene(editor, stage);
    const firstPage = editor.pageId;
    editor.transact('Add second page', doc => { const next = createPage('Other', 'second'); insertShape(next, createShape('rect', { id: 'other-page', fills: [gradient('#0f0')] })); doc.pages.push(next.id); doc.pagesById[next.id] = next; });
    editor.setPage('second'); expect(view.element('child')).toBeNull(); expectFreshScene(editor, stage);
    editor.setPage(firstPage); expect(view.element('child')).not.toBeNull(); expect(view.element('other-page')).toBeNull(); expectFreshScene(editor, stage);
});
it('invalidates copied backdrop content when an earlier layer changes', () => {
    const { editor, view, stage } = setup([createShape('rect', { id: 'background', fills: [{ color: '#f00' }] }), createShape('rect', { id: 'glass', x: 10, backgroundBlur: 8 }), createShape('rect', { id: 'glass2', x: 20, backgroundBlur: 6 })]);
    editor.transact('Change behind glass', doc => { doc.pagesById[editor.pageId].objects.background.fills = [{ color: '#00ff00' }]; });
    expect(view.renderDiagnostics().mode).toBe('full'); expectFreshScene(editor, stage);
    expect(stage.querySelectorAll('[fill="#f00"]')).toHaveLength(0);
    expect(stage.querySelectorAll('[fill="#00ff00"]').length).toBeGreaterThan(1);
});
it('updates embedded SVG content with its own diagnostic attributes during a structural scene update', () => {
    const picture = (fill: string) => `<svg xmlns="http://www.w3.org/2000/svg"><g data-shape-id="picture-group"><rect width="10" height="10" fill="${fill}"/></g></svg>`;
    const { editor, view, stage } = setup([createShape('svg', { id: 'picture', svg: picture('#f00') })]);
    editor.transact('Replace picture and insert sibling', doc => {
        const page = doc.pagesById[editor.pageId]; page.objects.picture.svg = picture('#00f'); insertShape(page, createShape('rect', { id: 'new' }));
    });
    expect(view.element('picture')!.querySelector('svg')!.querySelector('rect')!.getAttribute('fill')).toBe('#00f'); expectFreshScene(editor, stage);
});
it('patches and measures the generated layer when an earlier embedded picture repeats its ID', () => {
    const { editor, view, stage } = setup([
        createShape('svg', { id: 'picture', svg: '<svg xmlns="http://www.w3.org/2000/svg"><g data-shape-id="target"><rect width="10" height="10" fill="#00ff00"/></g></svg>' }),
        createShape('rect', { id: 'target', x: 200, fills: [{ color: '#ff0000' }] })
    ]);
    const picture = stage.querySelector('[data-shape-id="picture"]')!, beforePicture = canonical(picture);
    const [embedded, target] = stage.querySelectorAll('[data-shape-id="target"]');
    const embeddedRect = embedded.querySelector('rect')!, targetGeometry = target.querySelector('[data-geometry]')!;
    vi.spyOn(embeddedRect, 'getBoundingClientRect').mockReturnValue({ x: 900, y: 900, right: 910, bottom: 910, width: 10, height: 10 } as DOMRect);
    const readGeometry = vi.spyOn(targetGeometry, 'getBoundingClientRect');
    const nativeStyle = getComputedStyle, styleReads: Element[] = [];
    vi.stubGlobal('getComputedStyle', (element: Element) => { styleReads.push(element); return nativeStyle(element); });
    expect(view.element('target')).toBe(target);
    editor.transact('Change real target', doc => { doc.pagesById[editor.pageId].objects.target.fills = [{ color: '#0000ff' }]; });
    expect(view.renderDiagnostics().mode).toBe('leaf'); expect(view.element('target')).toBe(target);
    expect(target.querySelector('path')!.getAttribute('fill')).toBe('#0000ff');
    expect(canonical(picture)).toEqual(beforePicture); expect(embeddedRect.getAttribute('fill')).toBe('#00ff00');
    expect(view.measure(['target']).get('target')!.x).toBe(200); expect(readGeometry).toHaveBeenCalledTimes(1);
    view.computedStyle('target', ['fill']); expect(styleReads).toEqual([target.querySelector('path')!]);
    expectFreshScene(editor, stage);
});
it('keeps offscreen measurement, styles, and complete SVG export after incremental edits', () => {
    const { editor, view, stage } = setup([createShape('rect', { id: 'near' }), createShape('rect', { id: 'far', x: 10000, y: 20000 })]);
    editor.transact('Edit offscreen object', doc => { doc.pagesById[editor.pageId].objects.far.fills = [{ color: '#abcdef' }]; });
    expect(view.measure(['far']).get('far')).toMatchObject({ x: 10000, y: 20000 });
    expect(view.computedStyle('far', ['background-color'])).toEqual({ 'background-color': '#abcdef' });
    expect(view.sceneSvg(['far'])).toContain('#abcdef'); expect(view.sceneSvg(['far'])).toContain('10000');
    expectFreshScene(editor, stage);
});
it('coalesces gesture previews and flushes pending work without waiting for a background animation frame', async () => {
    const frames: FrameRequestCallback[] = [], canceled = vi.fn();
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.push(callback); return frames.length; });
    vi.stubGlobal('cancelAnimationFrame', canceled);
    const { editor, view, timings } = setup([createShape('rect', { id: 'a' })]);
    timings.length = 0; editor.begin('Drag');
    for (let x = 1; x <= 20; x++) editor.preview(doc => { doc.pagesById[editor.pageId].objects.a.x = x; });
    expect(frames).toHaveLength(1); expect(timings.filter(t => t.phase === 'render.attachSvg')).toHaveLength(0);
    await view.settled();
    expect(canceled).toHaveBeenCalledTimes(1); expect(view.measure(['a']).get('a')!.x).toBe(20);
    expect(timings.filter(t => t.phase === 'render.attachSvg')).toHaveLength(1);
    editor.commitSession(); frames[0](0);
    expect(timings.filter(t => t.phase === 'render.attachSvg')).toHaveLength(1);
    editor.undoStep(); expect(view.measure(['a']).get('a')!.x).toBe(0);
});
it('cancels a queued preview synchronously and releases its scheduler on destroy', () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.push(callback); return frames.length; });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    const { editor, view, stage } = setup([createShape('rect', { id: 'a' })]);
    editor.begin('Drag'); editor.preview(doc => { doc.pagesById[editor.pageId].objects.a.x = 50; });
    editor.cancelSession();
    expect(view.renderDiagnostics().pending).toBe(false); expect(view.measure(['a']).get('a')!.x).toBe(0);
    editor.begin('Drag'); editor.preview(doc => { doc.pagesById[editor.pageId].objects.a.x = 90; });
    view.destroy(); frames.forEach(callback => callback(0)); expect(stage.children).toHaveLength(0);
});
it('bounds serialization cache memory and gives unusual shape identifiers distinct namespaces', () => {
    const cache = new SceneNodeCache(100, 3);
    for (let i = 0; i < 20; i++) cache.put(String(i), 'x'.repeat(15), []);
    expect(cache.diagnostics()).toMatchObject({ entries: 3, bytes: 90 });
    cache.put('huge', 'x'.repeat(100), []); expect(cache.get('huge')).toBeUndefined();
    expect(new Set(['a_b', 'a%5fb', 'a b', '\ud800', '한글'].map(id => resourceScope(id))).size).toBe(5);
    cache.clear(); expect(cache.diagnostics().bytes).toBe(0);
});
