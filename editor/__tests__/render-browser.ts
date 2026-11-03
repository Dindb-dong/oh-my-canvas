/** Independently authored browser/decoder oracles after barrier f86e063. */
import {Replica} from '../../core/replica.mjs';
import {changesBetween} from '../../core/document.mjs';
import {mountEditor} from '../index';
import {nativeTextCacheDiagnostics,invalidateTextMetrics,retainTextMetric,cachedTextMetric} from '../render/metric-cache';
import { Editor, createDocument, createShape, createPage, insertShape,moveTree } from '../document';
import { createRenderer, combinePaths, shapePath } from '../render';
import {importHtml,importSvg} from '../formats';
import { createExporter } from '../export';
import { applyLayout, measureTextLayout } from '../layout';
import { createFontCatalog } from '../fonts';
import { updateGeometry, rotationMatrix } from '../geometry';
import type { Data, Shape, CanvasDocument } from '../contracts';
let assertions = 0;
const cases: Data[] = [];
let faces: Data[] = [];
let active: ReturnType<typeof fixture> | undefined;
function assert(value: any, message: string, detail?: any) {
    assertions++;
    if (!value)
        throw new Error(message + (detail === undefined ? '' : ': ' + JSON.stringify(detail)));
}
function near(actual: number, expected: number, message: string, tolerance = .5) {
    assert(Math.abs(actual - expected) <= tolerance, message, { actual, expected, tolerance });
}
async function run(name: string, requirements: string[], test: () => Promise<void> | void) {
    const start = performance.now();
    try {
        await test();
        cases.push({ name, requirements, pass: true, ms: Math.round(performance.now() - start) });
    }
    catch (error) {
        cases.push({
            name, requirements, pass: false, error: String(error), stack: error instanceof Error ? error.stack : undefined
        });
    }
    finally {
        active?.destroy();
        active = undefined;
    }
}
function fixture(shapes: Data[] = [], opts: Data = {}) {
    const doc = createDocument({ pageId: 'qa-page' }), page = doc.pagesById['qa-page'];
    const board = createShape('frame', {
        id: 'board', x: 0, y: 0, width: opts.width ?? 400, height: opts.height ?? 300, clipContent: true, fills: [{ color: '#ffffff' }], ...opts.board
    });
    insertShape(page, board);
    for (const spec of shapes) {
        const shape = createShape(spec.type ?? 'rect', spec);
        insertShape(page, shape, spec.parentId ?? 'board');
    }
    const stage = document.createElement('div');
    stage.id = 'render-qa-stage';
    Object.assign(stage.style, {
        position: 'absolute', left: '0', top: '0', width: '1000px', height: '800px', background: '#fff'
    });
    document.body.append(stage);
    const fonts = createFontCatalog(faces as any, { defaultFamily: 'IBM Plex Sans' });
    const editor = new Editor(doc, { reconcile: (before, draft) => applyLayout(draft, before, { defaultFamily: 'IBM Plex Sans', fallbacks: ['Noto Sans KR', 'sans-serif'] }) });
    const view = createRenderer(editor, stage, { fonts, defaultFamily: 'IBM Plex Sans', fallbacks: ['Noto Sans KR', 'sans-serif'], wasmUrl: 'omc://canvas/canvaskit.wasm' });
    const exporter = createExporter(editor, view, { fonts });
    const result = {
        doc, editor, view, fonts, exporter, stage, destroy() {
            view.destroy();
            fonts.destroy();
            editor.destroy();
            stage.remove();
        }
    };
    active = result;
    return result;
}
const text = (id: string, value: string, props: Data = {}) => ({
    type: 'text', id, x: 10, y: 10, width: 180, height: 80, autoResize: 'none', content: { type: 'richText', children: [{ children: [{ text: value, fontFamily: 'Arial', fontSize: 20, fills: [{ color: '#111111' }] }] }] }, ...props
});
async function pixels(blob: Blob) {
    const bitmap = await createImageBitmap(blob);
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    return { width: canvas.width, height: canvas.height, data: ctx.getImageData(0, 0, canvas.width, canvas.height).data, at(x: number, y: number) {
            return [...this.data.subarray((Math.floor(y) * canvas.width + Math.floor(x)) * 4, (Math.floor(y) * canvas.width + Math.floor(x)) * 4 + 4)];
        } };
}
function rgb(actual: number[], expected: number[], message: string, tolerance = 3) {
    for (let index = 0; index < expected.length; index++)
        near(actual[index], expected[index], message + ' channel ' + index, tolerance);
}
function layoutDocument(layout: Data, children: Data[], size = { width: 320, height: 180 }) {
    const doc = createDocument({ pageId: 'layout' }), page = doc.pagesById.layout;
    insertShape(page, createShape('frame', {
        id: 'layout-parent', x: 20, y: 30, ...size, layout
    }));
    for (const spec of children)
        insertShape(page, createShape(spec.type ?? 'rect', { width: 40, height: 30, ...spec }), 'layout-parent');
    return doc;
}
function nativeFlex(layout: Data, children: Data[], size = { width: 320, height: 180 }) {
    const parent = document.createElement('div');
    Object.assign(parent.style, {
        position: 'fixed', left: '-10000px', top: '0', display: 'flex', boxSizing: 'border-box', width: size.width + 'px', height: size.height + 'px', flexDirection: layout.direction, flexWrap: layout.wrap ? 'wrap' : 'nowrap', justifyContent: layout.justifyContent === 'start' ? 'flex-start' : layout.justifyContent === 'end' ? 'flex-end' : layout.justifyContent, alignItems: layout.alignItems, alignContent: layout.alignContent ?? 'normal', rowGap: (layout.gap?.row ?? 0) + 'px', columnGap: (layout.gap?.column ?? 0) + 'px', padding: `${layout.padding.top}px ${layout.padding.right}px ${layout.padding.bottom}px ${layout.padding.left}px`
    });
    document.body.append(parent);
    for (const child of children) {
        const node = document.createElement('div');
        Object.assign(node.style, { width: (child.width ?? 40) + 'px', height: (child.height ?? 30) + 'px', flexShrink: '0' });
        parent.append(node);
    }
    const origin = parent.getBoundingClientRect();
    const result = [...parent.children].map(node => {
        const rect = node.getBoundingClientRect();
        return { x: rect.x - origin.x, y: rect.y - origin.y, width: rect.width, height: rect.height };
    });
    parent.remove();
    return result;
}
export async function runAll(inputs: Data[]) {
    faces = inputs;
    const original = document.createElement('div');
    original.id = 'qa-preserved-host';
    while (document.body.firstChild)
        original.append(document.body.firstChild);
    original.style.display = 'none';
    document.body.append(original);
    document.body.style.margin = '0';
    await run('native CSS flex directions, wrapping and distribution', ['LAY-01'], () => {
        const differences: Data[] = [];
        const children = [{ id: 'a', width: 60, height: 24 }, { id: 'b', width: 50, height: 35 }, { id: 'c', width: 70, height: 20 }, { id: 'd', width: 80, height: 28 }];
        for (const direction of ['row', 'row-reverse', 'column', 'column-reverse'])
            for (const justifyContent of ['start', 'center', 'end', 'space-between', 'space-around', 'space-evenly'])
                for (const wrap of [false, true]) {
                    const layout = {
                        type: 'flex', direction, justifyContent, wrap, alignItems: 'center', alignContent: 'start', gap: { row: 9, column: 11 }, padding: { top: 10, right: 14, bottom: 12, left: 16 }
                    };
                    const doc = layoutDocument(layout, children), oracle = nativeFlex(layout, children);
                    applyLayout(doc);
                    children.forEach((child, index) => {
                        const shape = doc.pagesById.layout.objects[child.id];
                        for (const axis of ['x', 'y'] as const) {
                            assertions++;
                            const actual = shape[axis] - (axis === 'x' ? 20 : 30), expected = oracle[index][axis];
                            if (Math.abs(actual - expected) > .5)
                                differences.push({
                                    direction, justifyContent, wrap, id: child.id, axis, actual, expected
                                });
                        }
                    });
                }
        assert(!differences.length, 'all native flex combinations match', differences.slice(0, 12));
    });
    await run('native CSS grid fixed tracks, spans and cell alignment', ['LAY-02'], () => {
        const layout = {
            type: 'grid', columns: [{ type: 'fixed', size: 80 }, { type: 'fixed', size: 100 }, { type: 'fixed', size: 70 }], rows: [{ type: 'fixed', size: 40 }, { type: 'fixed', size: 60 }], gap: { row: 7, column: 9 }, padding: { top: 8, right: 9, bottom: 10, left: 11 }
        };
        const children = [{ id: 'a', width: 30, height: 20, gridCell: { row: 1, column: 1, hAlign: 'center', vAlign: 'end' } }, { id: 'b', width: 50, height: 30, gridCell: {
                    row: 2, column: 2, columnSpan: 2, hAlign: 'end', vAlign: 'center'
                } }];
        const doc = layoutDocument(layout, children);
        applyLayout(doc);
        const a = doc.pagesById.layout.objects.a, b = doc.pagesById.layout.objects.b;
        near(a.x, 20 + 11 + 25, 'grid cell center x');
        near(a.y, 30 + 8 + 20, 'grid end y');
        near(b.x, 20 + 11 + 80 + 9 + 100 + 9 + 70 - 50, 'span end x');
        near(b.y, 30 + 8 + 40 + 7 + 15, 'grid center y');
    });
    await run('browser measured baseline, auto sizing and stable repeated reflow', ['LAY-01', 'TEXT-03'], () => {
        const layout = {
            type: 'flex', direction: 'row', alignItems: 'baseline', gap: { row: 0, column: 12 }, padding: { top: 10, right: 0, bottom: 0, left: 8 }
        };
        const one = text('t1', 'Baseline', { width: 100, height: 70 }), two = text('t2', 'Mixed', { width: 100, height: 70, content: { type: 'richText', children: [{ children: [{ text: 'Mixed', fontFamily: 'Arial', fontSize: 36 }] }] } });
        const doc = layoutDocument(layout, [one, two]);
        applyLayout(doc);
        const a = doc.pagesById.layout.objects.t1, b = doc.pagesById.layout.objects.t2;
        near(a.y + measureTextLayout(a).baseline, b.y + measureTextLayout(b).baseline, 'mixed font native baselines');
        const once = JSON.stringify(doc);
        applyLayout(doc);
        assert(JSON.stringify(doc) === once, 'reflow is idempotent');
    });
    await run('plain frame resizing constraints and percentages', ['LAY-02'], () => {
        const doc = layoutDocument(undefined as any, [{
                id: 'left', x: 30, y: 40, width: 40, height: 20, horizontalConstraint: 'left'
            }, {
                id: 'right', x: 200, y: 40, width: 40, height: 20, horizontalConstraint: 'right'
            }, {
                id: 'stretch', x: 30, y: 90, width: 180, height: 20, horizontalConstraint: 'leftAndRight'
            }, {
                id: 'percent', x: 52, y: 120, width: 80, height: 20, absolute: true, inlineStyles: { width: '25%', left: '10%' }
            }]);
        const before = structuredClone(doc), parent = doc.pagesById.layout.objects['layout-parent'];
        parent.width += 100;
        updateGeometry(parent);
        applyLayout(doc, before);
        const objects = doc.pagesById.layout.objects;
        near(objects.left.x, 30, 'left anchor');
        near(objects.right.x, 300, 'right anchor');
        near(objects.stretch.width, 280, 'stretch width');
        near(objects.percent.width, 105, 'quarter width after resize');
        near(objects.percent.x, 62, 'percentage left after resize');
    });
    await run('nested hug/fill/min-max reflow and rotated layout/constraints', ['LAY-01', 'LAY-02', 'GEO-01'], () => {
        const doc = layoutDocument({
            type: 'flex', direction: 'column', alignItems: 'stretch', gap: { row: 8, column: 0 }, padding: { top: 10, right: 10, bottom: 10, left: 10 }
        }, [], { width: 300, height: 100 });
        const page = doc.pagesById.layout, parent = page.objects['layout-parent'];
        parent.vSizing = 'hug';
        insertShape(page, createShape('frame', {
            id: 'nested', width: 100, height: 50, hSizing: 'fill', vSizing: 'hug', layout: { type: 'flex', direction: 'row', gap: { row: 0, column: 10 }, padding: { top: 5, right: 5, bottom: 5, left: 5 } }
        }), 'layout-parent');
        insertShape(page, createShape('text', text('wrap', 'Native wrapping produces several lines of editable text', {
            width: 80, height: 30, autoResize: 'height', hSizing: 'fill', minWidth: 80, maxWidth: 120
        })), 'nested');
        insertShape(page, createShape('rect', { id: 'fixed', width: 60, height: 20 }), 'nested');
        applyLayout(doc);
        near(page.objects.nested.width, 280, 'nested fills parent inner width');
        near(page.objects.wrap.width, 120, 'max width caps fill');
        assert(page.objects.wrap.height > 30, 'nested text reflows height');
        near(page.objects.nested.height, page.objects.wrap.height + 10, 'nested hugs reflowed text');
        near(parent.height, page.objects.nested.height + 20, 'ancestor hugs nested reflow');
        const once = JSON.stringify(doc);
        applyLayout(doc);
        assert(JSON.stringify(doc) === once, 'nested measured reflow remains idempotent');
        const rotated = layoutDocument({ type: 'flex', direction: 'row', gap: { row: 0, column: 0 }, padding: { top: 10, right: 0, bottom: 0, left: 10 } }, [{ id: 'rotated-child', width: 40, height: 30, rotation: 30 }]);
        const rp = rotated.pagesById.layout.objects['layout-parent'];
        rp.rotation = 30;
        rp.transform = rotationMatrix(30);
        updateGeometry(rp);
        applyLayout(rotated);
        const child = rotated.pagesById.layout.objects['rotated-child'], cx = rp.x + rp.width / 2, cy = rp.y + rp.height / 2, dx = (rp.x + 10 + 20) - cx, dy = (rp.y + 10 + 15) - cy;
        near(child.x + 20, cx + Math.cos(Math.PI / 6) * dx - Math.sin(Math.PI / 6) * dy, 'rotated local->world center x');
        near(child.y + 15, cy + Math.sin(Math.PI / 6) * dx + Math.cos(Math.PI / 6) * dy, 'rotated local->world center y');
        const constrained = layoutDocument(undefined as any, [{
                id: 'rc', x: 130, y: 130, width: 20, height: 20, rotation: 90, horizontalConstraint: 'right'
            }], { width: 200, height: 100 });
        const cp = constrained.pagesById.layout.objects['layout-parent'];
        cp.rotation = 90;
        cp.transform = rotationMatrix(90);
        updateGeometry(cp);
        const before = structuredClone(constrained);
        cp.width = 300;
        updateGeometry(cp);
        applyLayout(constrained, before);
        near(constrained.pagesById.layout.objects.rc.x, 180, 'rotated right constraint world x');
        near(constrained.pagesById.layout.objects.rc.y, 180, 'rotated right constraint world y');
    });
    await run('native CSS automatic grid intrinsic tracks', ['LAY-02'], () => {
        const layout = {
            type: 'grid', columns: [{ type: 'fixed', size: 80 }, { type: 'auto' }, { type: 'auto' }], rows: [{ type: 'fixed', size: 50 }], gap: { row: 0, column: 9 }, padding: { top: 8, right: 10, bottom: 8, left: 10 }
        };
        const children = [{ id: 'ga', width: 40, height: 20 }, { id: 'gb', width: 80, height: 25 }, { id: 'gc', width: 30, height: 15 }];
        const doc = layoutDocument(layout, children);
        applyLayout(doc);
        const parent = document.createElement('div');
        Object.assign(parent.style, {
            position: 'fixed', left: '-10000px', top: '0', display: 'grid', boxSizing: 'border-box', width: '320px', height: '180px', padding: '8px 10px', gridTemplateColumns: '80px auto auto', gridTemplateRows: '50px', columnGap: '9px', justifyItems: 'start', alignItems: 'start'
        });
        document.body.append(parent);
        for (const child of children) {
            const item = document.createElement('div');
            item.style.width = child.width + 'px';
            item.style.height = child.height + 'px';
            parent.append(item);
        }
        const origin = parent.getBoundingClientRect();
        children.forEach((child, index) => {
            const actual = doc.pagesById.layout.objects[child.id], expected = parent.children[index].getBoundingClientRect();
            near(actual.x - 20, expected.x - origin.x, 'auto grid ' + child.id + ' x');
            near(actual.y - 30, expected.y - origin.y, 'auto grid ' + child.id + ' y');
        });
        parent.remove();
    });
    await run('imported absolute HTML remains draggable and responsive across parent moves/resizes',['FMT-01','GEO-02','LAY-02','HIST-01'],async()=>{
        const f=fixture([],{width:1000,height:800});const imported=importHtml('<div style="position:absolute;left:300px;top:300px;width:100px;height:80px;background:#008800"></div>',{parentId:'board',width:1000,height:800});const id=imported.rootIds[0];
        f.editor.transact('import absolute HTML',draft=>{const page=draft.pagesById['qa-page'];Object.assign(page.objects,imported.objects);page.objects.board.childIds!.push(...imported.rootIds);});await f.view.settled();near(f.editor.page.objects[id].x,300,'imported left');
        f.editor.begin('drag imported absolute');f.editor.preview(draft=>moveTree(draft.pagesById['qa-page'],id,45,20));near(f.editor.page.objects[id].x,345,'imported absolute preview preserves user x');near(f.editor.page.objects[id].y,320,'imported absolute preview preserves user y');f.editor.commitSession();near(Number.parseFloat(f.editor.page.objects[id].inlineStyles.left),345,'CSS left follows explicit drag');assert(f.editor.undoStep(),'drag has history step');near(f.editor.page.objects[id].x,300,'undo imported drag');assert(f.editor.redoStep(),'drag redo');near(f.editor.page.objects[id].x,345,'redo imported drag');
        const relative=importHtml('<div style="position:absolute;left:10%;top:20%;width:25%;height:10%;background:#000088"></div>',{parentId:'board',width:1000,height:800});const rid=relative.rootIds[0];f.editor.transact('import percentages',draft=>{const page=draft.pagesById['qa-page'];Object.assign(page.objects,relative.objects);page.objects.board.childIds!.push(...relative.rootIds);});
        f.editor.transact('move and resize percentages',draft=>{const page=draft.pagesById['qa-page'];moveTree(page,rid,50,40);page.objects[rid].width=300;page.objects[rid].height=100;});near(f.editor.page.objects[rid].x,150,'percentage child direct move');near(f.editor.page.objects[rid].width,300,'percentage child direct resize');assert(f.editor.page.objects[rid].inlineStyles.left==='15%','drag keeps updated percentage anchor');assert(f.editor.page.objects[rid].inlineStyles.width==='30%','resize keeps updated percentage width');
        f.editor.transact('responsive parent resize',draft=>{const board=draft.pagesById['qa-page'].objects.board;board.width=1200;board.height=1000;});near(f.editor.page.objects[rid].x,180,'updated left responds to parent width');near(f.editor.page.objects[rid].y,250,'updated top responds to parent height');near(f.editor.page.objects[rid].width,360,'updated width stays responsive');near(f.editor.page.objects[rid].height,125,'updated height stays responsive');
        const metadata=JSON.stringify(f.editor.page.objects[rid].inlineStyles);f.editor.transact('move full parent subtree',draft=>moveTree(draft.pagesById['qa-page'],'board',80,90));near(f.editor.page.objects[rid].x,260,'parent subtree moves child coherently');assert(JSON.stringify(f.editor.page.objects[rid].inlineStyles)===metadata,'parent subtree move keeps local CSS anchors unchanged');f.editor.transact('resize moved parent',draft=>{const board=draft.pagesById['qa-page'].objects.board;board.width=1400;board.height=1200;});near(f.editor.page.objects[rid].x,290,'responsive anchor after parent move');near(f.editor.page.objects[rid].y,390,'responsive top after parent move');
    });
    await run('fonts Unicode lazy loading, variable catalog, fallback and cleanup', ['AST-01', 'TEXT-01'], async () => {
        const f = fixture([text('known', 'English 한글 😀', { content: { type: 'richText', children: [{ children: [{ text: 'English 한글 😀', fontFamily: 'IBM Plex Sans', fontSize: 24 }] }] } }), text('unknown', 'Missing', { y: 100, content: { type: 'richText', children: [{ children: [{ text: 'Missing', fontFamily: 'Definitely Absent QA Font 4931', fontSize: 20 }] }] } })]);
        await f.view.settled();
        const catalog = f.fonts.catalog();
        assert(catalog.some(group => group.family === 'IBM Plex Sans'), 'IBM catalog');
        for (const group of catalog) {
            const keys = new Set();
            for (const face of group.faces) {
                assert(typeof face.weight === 'number', 'catalog weight numeric');
                const key = face.weight + '/' + face.style;
                assert(!keys.has(key), 'catalog faces deduplicated');
                keys.add(key);
            }
        }
        assert(f.view.measure(['unknown']).get('unknown')?.fontFallback, 'unknown font warns');
        assert(!f.view.measure(['known']).get('known')?.fontFallback, 'loaded known family does not warn');
        const css = await f.fonts.embeddedCss();
        assert(css.includes('data:'), 'loaded font embeds actual bytes');
        assert(css.includes('unicode-range'), 'unicode font ranges retained');
    });
    await run('rich multiline CJK emoji content and measured SVG text positions', ['TEXT-01', 'TEXT-03'], async () => {
        const value = 'Hello 한글 😀 mixed words and wrapping continue';
        const rich = { type: 'richText', verticalAlign: 'center', children: [{ lineHeight: 1.4, paragraphSpacing: 7, children: [{
                            text: value, fontFamily: 'IBM Plex Sans', fontSize: 22, fontWeight: 500, fills: [{ color: '#183a22' }]
                        }, {
                            text: ' BOLD', fontFamily: 'IBM Plex Sans', fontSize: 26, fontWeight: 700, textDecoration: 'underline', highlight: { color: '#ffff00' }
                        }] }, { listType: 'bullet', listLevel: 1, paragraphIndent: 4, children: [{ text: 'Second paragraph', fontFamily: 'IBM Plex Sans', fontSize: 18 }] }] };
        const f = fixture([text('rich', value, { width: 180, height: 220, content: rich })], { width: 240, height: 260 });
        await f.view.settled();
        const lines = f.view.textLines('rich');
        assert(new Set(lines.map((line: Data) => line.y)).size > 3, 'text wraps across native lines');
        assert(lines.some((line: Data) => line.text.includes('😀')), 'emoji grapheme preserved');
        assert(lines.map((line: Data) => line.text).join('').includes('Hello 한글'), 'CJK content preserved');
        const svg = await f.exporter.svg(['board']);
        const parsed = new DOMParser().parseFromString(svg, 'image/svg+xml');
        assert(!parsed.querySelector('parsererror'), 'SVG XML parses');
        for (const line of lines) {
            const matches = [...parsed.querySelectorAll('text')].filter(node => node.textContent === line.text && Math.abs(Number(node.getAttribute('x')) - line.x) < .01);
            assert(matches.some(node => Math.abs(Number(node.getAttribute('y')) - line.baseline) < .01), 'SVG baseline exactly shares measured fragment');
        }
        const png = await f.exporter.raster('board');
        const image = await pixels(png!);
        assert(image.width === 240 && image.height === 260, 'rich raster native dimensions');
    });
    await run('rectangle clipping independent of path geometry and mask removal', ['PAINT-02'], async () => {
        const f = fixture([{
                type: 'path', id: 'path', x: 10, y: 10, width: 100, height: 100, content: [{ command: 'move', x: 10, y: 10 }, { command: 'line', x: 110, y: 10 }, { command: 'line', x: 110, y: 110 }, { command: 'line', x: 10, y: 110 }, { command: 'close' }], fills: [{ color: '#ff0000' }], clip: { x: 25, y: 25, width: 50, height: 50 }
            }], { width: 130, height: 130 });
        await f.view.settled();
        const image = await pixels((await f.exporter.raster('board'))!);
        rgb(image.at(20, 20), [255, 255, 255, 255], 'outside legacy rectangle');
        rgb(image.at(50, 50), [255, 0, 0, 255], 'inside legacy rectangle');
        rgb(image.at(100, 100), [255, 255, 255, 255], 'far outside rectangle');
    });
    await run('alpha/luminance/vector/group/text masks actual raster coverage', ['PAINT-02'], async () => {
        for (const mode of ['alpha', 'luminance', 'vector']) {
            const f = fixture([{
                    type: 'group', id: 'maskgroup', x: 0, y: 0, width: 100, height: 100, isMaskGroup: true, maskType: mode
                }, {
                    id: 'mask', parentId: 'maskgroup', x: 10, y: 10, width: 40, height: 80, fills: [{ color: mode === 'luminance' ? '#808080' : '#000000', opacity: .5 }]
                }, {
                    id: 'ink', parentId: 'maskgroup', x: 0, y: 0, width: 100, height: 100, fills: [{ color: '#ff0000' }]
                }], { width: 100, height: 100 });
            await f.view.settled();
            const image = await pixels((await f.exporter.raster('board'))!);
            rgb(image.at(80, 50), [255, 255, 255, 255], mode + ' outside');
            if (mode === 'vector')
                rgb(image.at(30, 50), [255, 0, 0, 255], 'vector ignores mask paint opacity');
            else
                assert(image.at(30, 50)[1] > 100 && image.at(30, 50)[1] < 230, mode + ' retains mask transparency');
            f.editor.transact('disable mask', draft => {
                draft.pagesById['qa-page'].objects.maskgroup.isMaskGroup = false;
            });
            await f.view.settled();
            const disabled = await pixels((await f.exporter.raster('board'))!);
            rgb(disabled.at(80, 50), [255, 0, 0, 255], mode + ' mask toggle off');
            f.destroy();
            active = undefined;
        }
        const f = fixture([{
                type: 'group', id: 'maskgroup', x: 0, y: 0, width: 160, height: 100, isMaskGroup: true, maskType: 'vector'
            }, text('glyph', 'H', {
                parentId: 'maskgroup', x: 10, y: 5, width: 80, height: 85, content: { type: 'richText', children: [{ children: [{ text: 'H', fontFamily: 'Arial', fontSize: 80, fills: [{ color: '#000000', opacity: .1 }] }] }] }
            }), {
                id: 'ink', parentId: 'maskgroup', x: 0, y: 0, width: 160, height: 100, fills: [{ color: '#0000ff' }]
            }], { width: 160, height: 100 });
        await f.view.settled();
        const image = await pixels((await f.exporter.raster('board'))!);
        assert(image.at(17, 40)[2] > 200, 'glyph stroke blue');
        rgb(image.at(42, 25), [255, 255, 255, 255], 'glyph counter is transparent');
        rgb(image.at(120, 40), [255, 255, 255, 255], 'text mask excludes unrelated bounding box');
    });
    await run('ordered fills, gradients, stroke and shadow raster pixels', ['PAINT-01'], async () => {
        const f = fixture([{
                id: 'stack', x: 10, y: 10, width: 80, height: 60, fills: [{ color: '#0000ff' }, { color: '#ff0000', opacity: .5 }], strokes: [{ color: '#00ff00', width: 8, align: 'inside' }]
            }, {
                id: 'linear', x: 110, y: 10, width: 100, height: 60, fills: [{ gradient: {
                            type: 'linear', x1: 0, y1: 0, x2: 1, y2: 0, stops: [{ offset: 0, color: '#000000' }, { offset: 1, color: '#ffffff' }]
                        } }]
            }, {
                id: 'shadow', x: 230, y: 10, width: 40, height: 40, fills: [{ color: '#ff0000' }], shadows: [{
                        style: 'drop', offsetX: 12, offsetY: 0, blur: 0, spread: 0, color: '#000000'
                    }]
            }], { width: 300, height: 100 });
        await f.view.settled();
        const image = await pixels((await f.exporter.raster('board'))!);
        rgb(image.at(50, 40), [128, 0, 127, 255], 'ordered translucent fill');
        rgb(image.at(12, 30), [0, 255, 0, 255], 'inside aligned stroke');
        assert(image.at(115, 30)[0] < 30 && image.at(205, 30)[0] > 225, 'linear gradient left-to-right');
        rgb(image.at(278, 30), [0, 0, 0, 255], 'drop shadow offset visible');
        for (const type of ['radial', 'angular', 'diamond']) {
            f.editor.transact('gradient', draft => {
                draft.pagesById['qa-page'].objects.linear.fills = [{ gradient: {
                            type, x1: .5, y1: .5, x2: 1, y2: .5, aspect: .8, stops: [{ offset: 0, color: '#ff0000' }, { offset: 1, color: '#0000ff' }]
                        } }];
            });
            await f.view.settled();
            const sample = await pixels((await f.exporter.raster('board'))!);
            const a = type === 'angular' ? sample.at(130, 40) : sample.at(160, 40), b = type === 'angular' ? sample.at(190, 40) : sample.at(205, 40);
            assert(a.slice(0, 3).reduce((sum, channel, index) => sum + Math.abs(channel - b[index]), 0) > 30, type + ' produces spatially varying paint', { a, b });
        }
    });
    await run('image fit crop tile and numerical adjustments', ['PAINT-02'], async () => {
        const source = document.createElement('canvas');
        source.width = 40;
        source.height = 20;
        const context = source.getContext('2d')!;
        context.fillStyle = '#ff0000';
        context.fillRect(0, 0, 20, 20);
        context.fillStyle = '#0000ff';
        context.fillRect(20, 0, 20, 20);
        const src = source.toDataURL();
        const f = fixture([{
                type: 'image', id: 'fit', x: 10, y: 10, width: 80, height: 80, fills: [], objectFit: 'contain', image: { src, width: 40, height: 20 }
            }, {
                type: 'image', id: 'crop', x: 110, y: 10, width: 80, height: 80, fills: [], objectFit: 'cover', crop: { x: .5, y: 0, width: .5, height: 1 }, image: { src, width: 40, height: 20 }
            }, {
                id: 'tile', x: 210, y: 10, width: 100, height: 80, fills: [{ image: { id: src, width: 40, height: 20, scaleMode: 'tile' } }]
            }], { width: 330, height: 110 });
        await f.view.settled();
        const image = await pixels((await f.exporter.raster('board'))!);
        rgb(image.at(25, 15), [255, 255, 255, 255], 'contain letterbox');
        rgb(image.at(25, 40), [255, 0, 0, 255], 'contain actual red');
        rgb(image.at(135, 50), [0, 0, 255, 255], 'crop natural right half');
        rgb(image.at(215, 30), [255, 0, 0, 255], 'tile first red');
        rgb(image.at(235, 30), [0, 0, 255, 255], 'tile first blue');
        rgb(image.at(255, 30), [255, 0, 0, 255], 'tile repeats');
        f.editor.transact('desaturate', draft => {
            draft.pagesById['qa-page'].objects.fit.adjust = { saturation: -1 };
        });
        await f.view.settled();
        const gray = await pixels((await f.exporter.raster('board'))!);
        const value = gray.at(25, 40);
        near(value[0], value[1], 'desaturation green', 2);
        near(value[1], value[2], 'desaturation blue', 2);
    });
    await run('all sixteen blend modes against native canvas compositor', ['PAINT-01'], async () => {
        const modes = ['normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten', 'color-dodge', 'color-burn', 'hard-light', 'soft-light', 'difference', 'exclusion', 'hue', 'saturation', 'color', 'luminosity'];
        const f = fixture([{
                id: 'bottom', x: 0, y: 0, width: 40, height: 40, fills: [{ color: '#2d6ea0' }]
            }, {
                id: 'top', x: 0, y: 0, width: 40, height: 40, fills: [{ color: '#d38d3b' }], opacity: .7
            }], { width: 40, height: 40 });
        for (const mode of modes) {
            f.editor.transact('blend', draft => {
                draft.pagesById['qa-page'].objects.top.blendMode = mode;
            });
            await f.view.settled();
            const image = await pixels((await f.exporter.raster('board'))!);
            const canvas = document.createElement('canvas');
            canvas.width = canvas.height = 1;
            const context = canvas.getContext('2d')!;
            context.fillStyle = '#2d6ea0';
            context.fillRect(0, 0, 1, 1);
            context.globalAlpha = .7;
            context.globalCompositeOperation = (mode === 'normal' ? 'source-over' : mode) as GlobalCompositeOperation;
            context.fillStyle = '#d38d3b';
            context.fillRect(0, 0, 1, 1);
            rgb(image.at(20, 20), [...context.getImageData(0, 0, 1, 1).data], mode + ' native compositor', 3);
        }
    });
    await run('nested group vector mask silhouette and inner/background blur', ['PAINT-02', 'PAINT-01'], async () => {
        const f = fixture([{
                type: 'group', id: 'maskgroup', x: 0, y: 0, width: 160, height: 100, isMaskGroup: true, maskType: 'vector'
            }, {
                type: 'group', id: 'geometry', parentId: 'maskgroup', x: 0, y: 0, width: 100, height: 100
            }, {
                id: 'left', parentId: 'geometry', x: 10, y: 10, width: 20, height: 80
            }, {
                id: 'right', parentId: 'geometry', x: 70, y: 10, width: 20, height: 80
            }, {
                id: 'ink', parentId: 'maskgroup', x: 0, y: 0, width: 160, height: 100, fills: [{ color: '#00aa00' }]
            }], { width: 160, height: 100 });
        await f.view.settled();
        const image = await pixels((await f.exporter.raster('board'))!);
        rgb(image.at(20, 40), [0, 170, 0, 255], 'first descendant silhouette');
        rgb(image.at(80, 40), [0, 170, 0, 255], 'second descendant silhouette');
        rgb(image.at(50, 40), [255, 255, 255, 255], 'group gap excluded from vector mask');
        f.destroy();
        active = undefined;
        const blur = fixture([{
                id: 'red', x: 0, y: 0, width: 80, height: 100, fills: [{ color: '#ff0000' }]
            }, {
                id: 'blue', x: 80, y: 0, width: 80, height: 100, fills: [{ color: '#0000ff' }]
            }, {
                id: 'glass', x: 50, y: 20, width: 60, height: 60, fills: [], backgroundBlur: 16
            }, {
                id: 'inner', x: 10, y: 120, width: 80, height: 60, fills: [{ color: '#ff0000' }], shadows: [{
                        style: 'inner', offsetX: 8, offsetY: 0, blur: 4, spread: 0, color: '#000000'
                    }]
            }], { width: 160, height: 200 });
        await blur.view.settled();
        const result = await pixels((await blur.exporter.raster('board'))!);
        const boundary = result.at(79, 45);
        assert(boundary[0] > 40 && boundary[2] > 40, 'backdrop blur blends the existing scene boundary', boundary);
        assert(result.at(12, 145)[0] < result.at(50, 145)[0] - 50, 'inner shadow darkens inside edge');
    });
    await run('native leading trim and grapheme-safe truncation', ['TEXT-01', 'TEXT-03'], async () => {
        const plain = createShape('text', text('plain', 'Typography', { width: 200, height: 80, autoResize: 'height' }));
        const trimmed = createShape('text', { ...plain, id: 'trimmed', leadingTrim: 'capHeight' });
        const normal = measureTextLayout(plain), trim = measureTextLayout(trimmed);
        assert(trim.height <= normal.height, 'leading trim does not increase native text height');
        const f = fixture([text('truncated', '😀😀😀😀😀😀😀😀', { width: 50, height: 30, truncate: true, maxLines: 1 })], { width: 100, height: 80 });
        await f.view.settled();
        const fragments = f.view.textLines('truncated');
        assert(fragments.length > 0, 'truncated glyphs present');
        const value = fragments.map((fragment: Data) => fragment.text).join('');
        assert(value === value.toWellFormed(), 'truncation does not split surrogate pairs', value);
        assert(new Set(fragments.map((fragment: Data) => fragment.y)).size === 1, 'max one native line');
    });
    await run('stroke alignment, dash gaps, endpoint decorations and independent corners', ['PAINT-01'], async () => {
        const f = fixture([{
                id: 'inside', x: 20, y: 20, width: 60, height: 40, fills: [], strokes: [{ color: '#ff0000', width: 10, align: 'inside' }]
            }, {
                id: 'outside', x: 110, y: 20, width: 60, height: 40, fills: [], strokes: [{ color: '#0000ff', width: 10, align: 'outside' }]
            }, {
                type: 'path', id: 'dashed', x: 20, y: 100, width: 150, height: 0, content: [{ command: 'move', x: 20, y: 100 }, { command: 'line', x: 170, y: 100 }], fills: [], strokes: [{
                        color: '#008800', width: 4, dashes: [10, 10], startCap: 'circle', endCap: 'diamond'
                    }]
            }, {
                id: 'corners', x: 210, y: 20, width: 60, height: 60, radiusTopLeft: 25, radiusTopRight: 0, radiusBottomLeft: 0, radiusBottomRight: 0, fills: [{ color: '#000000' }]
            }], { width: 300, height: 130 });
        await f.view.settled();
        const image = await pixels((await f.exporter.raster('board'))!);
        rgb(image.at(21, 40), [255, 0, 0, 255], 'inside stroke inside');
        rgb(image.at(15, 40), [255, 255, 255, 255], 'inside stroke does not extend out');
        rgb(image.at(105, 40), [0, 0, 255, 255], 'outside stroke outside');
        rgb(image.at(115, 40), [255, 255, 255, 255], 'outside stroke does not extend in');
        rgb(image.at(25, 100), [0, 136, 0, 255], 'dash painted segment');
        rgb(image.at(35, 100), [255, 255, 255, 255], 'dash gap clear');
        rgb(image.at(211, 21), [255, 255, 255, 255], 'rounded top left excludes corner');
        rgb(image.at(269, 21), [0, 0, 0, 255], 'independent square top right');
        const svg = await f.exporter.svg(['board']), doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
        assert(doc.querySelectorAll('marker').length === 2, 'two endpoint decoration definitions');
        assert(!!doc.querySelector('marker circle'), 'circle endpoint actual vector');
        assert([...doc.querySelectorAll('marker path')].some(path => path.getAttribute('d') === 'M5 0L10 5L5 10L0 5Z'), 'diamond endpoint actual vector');
    });
    await run('renderer lifecycle and unchanged hover/viewport DOM identity', ['UI-01', 'TEXT-03'], async () => {
        const f = fixture([text('lifecycle', 'Stable native text')]);
        await f.view.settled();
        const original = f.view.element('lifecycle'), before = document.querySelectorAll('[aria-hidden=true]').length;
        let renders = 0;
        const off = f.view.onRender(() => renders++);
        f.editor.setHover('lifecycle');
        f.editor.setSelection(['lifecycle']);
        assert(f.view.element('lifecycle') === original, 'hover/selection retains native node');
        f.editor.setViewport({ vport: { width: 1000, height: 800 }, vbox: { x: 10, y: 20, width: 500, height: 400 }, zoom: 2 });
        assert(f.view.element('lifecycle') === original, 'viewport retains native node');
        assert(renders === 1, 'only viewport invokes viewport refresh');
        near(f.view.measure(['lifecycle']).get('lifecycle')!.x, 10, 'measure world x invariant under zoom');
        off();
        f.destroy();
        active = undefined;
        assert(document.querySelectorAll('[aria-hidden=true]').length < before, 'measurement root disposed');
        assert(!document.querySelector('#render-qa-stage'), 'stage removed');
    });
    await run('boolean analytic bounds and live operand cache invalidation', ['VEC-02', 'GEO-01'], async () => {
        const a = createShape('rect', {
            id: 'a', x: 0, y: 0, width: 100, height: 80
        }), b = createShape('rect', {
            id: 'b', x: 50, y: 20, width: 100, height: 80
        });
        for (const [operation, expected] of [['union', { x: 0, y: 0, width: 150, height: 100 }], ['intersect', { x: 50, y: 20, width: 50, height: 60 }], ['subtract', { x: 0, y: 0, width: 100, height: 80 }], ['exclude', { x: 0, y: 0, width: 150, height: 100 }]] as const) {
            const result = await combinePaths([a, b], operation, { wasmUrl: 'omc://canvas/canvaskit.wasm' });
            for (const key of ['x', 'y', 'width', 'height'] as const)
                near(result.bounds[key], expected[key], operation + ' ' + key, .001);
            assert(result.segments.every(segment => ['move', 'line', 'curve', 'close'].includes(segment.command)), 'canonical path verbs');
        }
        const f = fixture([{
                type: 'boolean', id: 'bool', x: 10, y: 10, width: 100, height: 100, booleanOperation: 'union', content: [], fills: [{ color: '#ff0000' }]
            }, {
                id: 'a', parentId: 'bool', x: 10, y: 10, width: 40, height: 40
            }, {
                id: 'b', parentId: 'bool', x: 60, y: 10, width: 40, height: 40
            }], { width: 240, height: 120 });
        await f.view.settled();
        near(f.view.bounds(['bool']).width, 90, 'initial bool projected bounds');
        f.editor.transact('move operand', draft => {
            draft.pagesById['qa-page'].objects.b.x = 150;
        });
        await f.view.settled();
        near(f.view.bounds(['bool']).width, 180, 'live boolean updated bounds');
        const exported = await pixels((await f.exporter.raster('bool'))!);
        assert(exported.width === 180, 'bool export avoids stale crop');
    });
    await run('SVG PNG JPEG WebP and PDF actual decoding and screenshot sizing', ['EXP-01', 'TEXT-03'], async () => {
        const f = fixture([{
                id: 'solid', x: 10, y: 10, width: 60, height: 50, fills: [{ color: '#175c32' }]
            }], { width: 200, height: 180 });
        await f.view.settled();
        for (const type of ['image/png', 'image/jpeg', 'image/webp']) {
            const blob = await f.exporter.raster('board', { type, scale: 1.5 });
            assert(blob?.type === type, type + ' encoded MIME');
            const image = await pixels(blob!);
            assert(image.width === 300 && image.height === 270, type + ' decoded dimensions');
            rgb(image.at(50, 50), [23, 92, 50, 255], type + ' pixel', type === 'image/jpeg' ? 5 : 2);
        }
        const png = await f.exporter.png('board', 2, { x: 0, y: 0, width: 100, height: 60 });
        const image = await pixels(new Blob([new Uint8Array(png!).buffer], { type: 'image/png' }));
        assert(image.width === 200 && image.height === 120, 'PNG fixed bounds/scale');
        const pdf = await f.exporter.pdf('board');
        const bytes = new Uint8Array(await pdf.arrayBuffer());
        const ascii = new TextDecoder('latin1').decode(bytes);
        assert(ascii.startsWith('%PDF-1.4'), 'PDF magic');
        assert(ascii.includes('/MediaBox [0 0 200 180]'), 'PDF world units');
        const start = Number(ascii.match(/startxref\n(\d+)/)?.[1]);
        assert(new TextDecoder().decode(bytes.subarray(start, start + 4)) === 'xref', 'PDF xref byte offset valid');
        const jpegStart = ascii.indexOf('stream\n') + 7, length = Number(ascii.match(/\/Filter \/DCTDecode \/Length (\d+)/)?.[1]);
        const jpeg = await pixels(new Blob([bytes.slice(jpegStart, jpegStart + length)], { type: 'image/jpeg' }));
        assert(jpeg.width === 200 && jpeg.height === 180, 'PDF embedded JPEG decodes');
        const shot = await f.view.screenshot('board', { mode: 'overview' });
        assert(shot.mimeType === 'image/png' && !shot.data.startsWith('data:'), 'screenshot raw base64');
        const decoded = await pixels(await (await fetch('data:image/png;base64,' + shot.data)).blob());
        assert(decoded.width * decoded.height <= 340000, 'overview bounded pixels');
    });
    await run('screenshot slices and resource failure diagnostics', ['EXP-01', 'TEXT-03'], async () => {
        const f = fixture([{
                type: 'image', id: 'broken', x: 20, y: 20, width: 80, height: 80, image: { src: 'data:image/png;base64,AAAA' }
            }], { width: 400, height: 3200 });
        await f.view.settled();
        assert(f.view.measure(['broken']).get('broken')?.imageFailed, 'broken image diagnostic');
        f.editor.transact('remove invalid source', draft => {
            const page = draft.pagesById['qa-page'];
            delete page.objects.broken;
            page.objects.board.childIds = [];
        });
        await f.view.settled();
        const shot = await f.view.screenshot('board', { mode: 'slice', slice: 1 });
        assert(shot.slices === 3, 'slice count has 120 overlap');
        const decoded = await pixels(await (await fetch('data:image/png;base64,' + shot.data)).blob());
        assert(decoded.width === 400 && decoded.height === 1568, 'slice actual dimensions');
    });
    await run('cross-page source thumbnails share paints/text with unique SVG IDs and no editor mutation',['AST-01','CMP-01','PAINT-01','TEXT-03'],async()=>{
        const gradient={type:'linear',x1:0,y1:0,x2:1,y2:0,stops:[{offset:0,color:'#ff0000'},{offset:1,color:'#0000ff'}]};
        const f=fixture([{id:'active-gradient',x:10,y:10,width:100,height:80,fills:[{gradient}]}]);
        const other=createPage('Source page','thumbnail-page');insertShape(other,createShape('frame',{id:'thumbnail-main',x:500,y:400,width:180,height:100,clipContent:true,fills:[{gradient}]}));insertShape(other,createShape('text',text('thumbnail-text','OTHER PAGE',{x:510,y:420,width:160,height:60})),'thumbnail-main');
        f.editor.transact('add source page',draft=>{draft.pages.push(other.id);draft.pagesById[other.id]=other;});f.editor.setSelection(['active-gradient']);await f.view.settled();const originalPage=f.editor.pageId,originalSelection=[...f.editor.selection],original=JSON.stringify(f.editor.doc);let edits=0;const off=f.editor.on(event=>{if(event.changes)edits++;});
        const source=await f.view.thumbnailSvg!('thumbnail-page','thumbnail-main'),second=await f.view.thumbnailSvg!('qa-page','board');off();
        assert(f.editor.pageId===originalPage,'thumbnail keeps active page');assert(JSON.stringify(f.editor.selection)===JSON.stringify(originalSelection),'thumbnail keeps selection');assert(JSON.stringify(f.editor.doc)===original&&edits===0,'thumbnail has no durable document mutation');assert(source.includes('OTHER PAGE'),'cross-page actual source text');assert(!source.includes('@font-face')&&!source.includes('data:font'),'thumbnail does not embed font payloads');
        const firstDoc=new DOMParser().parseFromString(source,'image/svg+xml'),secondDoc=new DOMParser().parseFromString(second,'image/svg+xml');assert(!firstDoc.querySelector('parsererror'),'thumbnail SVG parses');const ids=new Set([...firstDoc.querySelectorAll('[id]')].map(node=>node.id));assert(ids.size>0,'thumbnail has real gradient definitions');assert([...secondDoc.querySelectorAll('[id]')].every(node=>!ids.has(node.id)),'thumbnail definitions cannot collide');assert(firstDoc.documentElement.getAttribute('viewBox')==='500 400 180 100','source bounds fit cross-page source');
        const wrapper=document.createElement('div');wrapper.style.cssText='position:absolute;left:450px;top:0;width:180px;height:100px';wrapper.innerHTML=source;document.body.append(wrapper);const svg=wrapper.firstElementChild as SVGSVGElement;svg.style.width='100%';svg.style.height='100%';assert(svg.querySelector('text')?.getBoundingClientRect().width!>50,'inline thumbnail actually renders source glyphs with shared fonts');wrapper.remove();
    });
    await run('native save adapter awaits completion, cancel and errors', ['EXP-02'], async () => {
        const f = fixture();
        let completed = false;
        const awaited = createExporter(f.editor, f.view, { exportFile: async () => {
                await new Promise(resolve => setTimeout(resolve, 15));
                completed = true;
                return { saved: true };
            } });
        const result = await awaited.saveFile!(new Blob(['x']), 'fixture.txt');
        assert(completed && typeof result === 'object' && result !== null && 'saved' in result && result.saved, 'save promise awaits host completion');
        const canceled = createExporter(f.editor, f.view, { exportFile: async () => ({ canceled: true }) });
        const cancelResult = await canceled.saveFile!(new Blob(['x']), 'cancel.txt');
        assert(typeof cancelResult === 'object' && cancelResult !== null && 'canceled' in cancelResult && cancelResult.canceled, 'cancel is returned');
        const failed = createExporter(f.editor, f.view, { exportFile: async () => {
                throw new Error('QA write failure');
            } });
        let error = '';
        try {
            await failed.saveFile!(new Blob(['x']), 'failed.txt');
        }
        catch (value) {
            error = String(value);
        }
        assert(error.includes('QA write failure'), 'write failure is propagated');
    });
    await run('concurrent imported percent geometry survives Replica merge and parent resize', ['LAYOUT-01'], async()=>{
        const f=fixture([{id:'imported',x:100,y:60,width:80,height:40,absolute:true,inlineStyles:{left:'25%',top:'20%',width:'20%',height:'13.333333333%'}}]);
        const seed=new Replica({document:structuredClone(f.editor.doc)}),a=new Replica({state:seed.state}),b=new Replica({state:seed.state});
        const make=(replica:any)=>new Editor(structuredClone(replica.document),{reconcile:(old,draft)=>applyLayout(draft,old)});const ea=make(a),eb=make(b);
        const baseA=ea.doc,baseB=eb.doc;ea.transact('x',draft=>moveTree(draft.pagesById['qa-page'],'imported',40,0));eb.transact('y',draft=>moveTree(draft.pagesById['qa-page'],'imported',0,30));
        a.patch(changesBetween(baseA,ea.doc),'x');b.patch(changesBetween(baseB,eb.doc),'y');a.receive(b.state);b.receive(a.state);ea.receiveDocument(a.document);eb.receiveDocument(b.document);
        for(const editor of [ea,eb]){near(editor.page.objects.imported.x,140,'merged canonical X');near(editor.page.objects.imported.y,90,'merged canonical Y');editor.transact('rename',draft=>draft.pagesById['qa-page'].objects.imported.name='kept');near(editor.page.objects.imported.x,140,'generic projection preserves X');near(editor.page.objects.imported.y,90,'generic projection preserves Y');editor.transact('parent resize',draft=>{draft.pagesById['qa-page'].objects.board.width=800;draft.pagesById['qa-page'].objects.board.height=600;});near(editor.page.objects.imported.x,280,'merged X ratio survives parent resize');near(editor.page.objects.imported.y,180,'merged Y ratio survives parent resize');editor.destroy();}
        seed.destroy();a.destroy();b.destroy();
    });
    await run('active SVG animation rejected at import and stripped from raw exported shapes', ['EXP-01','PAINT-02'], async()=>{
        const variants=['<animate attributeName="href" values="javascript:parent.astraSentinel=1" dur="1ms" fill="freeze"/>','<set attributeName="href" to="javascript:parent.astraSentinel=1" begin="0s"/>','<animateMotion dur="1ms" path="M0 0L1 1"/>','<animateTransform attributeName="transform" type="translate" from="0" to="1" dur="1ms"/>','<discard begin="1ms"/>'];
        const raw=(animation:string)=>`<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40"><switch><a href="#details">${animation}<rect width="80" height="40" fill="green"/></a></switch></svg>`;
        for(const animation of variants){let rejected=false;try{importSvg(raw(animation));}catch{rejected=true;}assert(rejected,'active SVG import rejected');}
        const staticImport=importSvg(raw(''));assert(staticImport.shapes.length>0,'static unsupported SVG remains importable');
        const f=fixture(variants.map((animation,index)=>({id:'svg-security-'+index,type:'svg',x:index*80,y:0,width:80,height:40,svg:raw(animation),content:raw(animation)})),{width:400,height:50});await f.view.settled();
        const source=await f.exporter.svg(['board']),parsed=new DOMParser().parseFromString(source,'image/svg+xml');assert(!parsed.querySelector('animate,set,animateMotion,animateTransform,discard'),'export removes all active SVG elements');assert(parsed.querySelectorAll('rect[fill="green"]').length===variants.length,'export preserves static vector artwork');
        (globalThis as any).astraSentinel=0;(globalThis as any).svgSecuritySource=source;
    });
    await run('saved asset fonts load before initial layout and reopen, with projected Undo/Redo ownership', ['TEXT-01','TEXT-03'], async()=>{
        const source=faces.find(face=>face.family==='IBM Plex Sans'&&(!face.unicodeRange||String(face.unicodeRange).includes('0000')) )??faces[0];
        const blob=await(await fetch(source.url)).blob(),dataUrl=await new Promise<string>((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result));reader.onerror=()=>reject(reader.error);reader.readAsDataURL(blob);});
        const family='QA Saved Asset Family',doc=createDocument({pageId:'saved-font'}),page=doc.pagesById['saved-font'];
        const shape=createShape('text',{id:'saved-font-text',x:30,y:40,width:5,height:5,autoResize:'widthAndHeight',fontFamily:family,content:{type:'richText',children:[{children:[{text:'WWWWiiii Saved user font',fontFamily:family,fontSize:40}]}]}});insertShape(page,shape);
        doc.assets={saved:{id:'saved',name:'Saved user font',kind:'font',src:dataUrl,family}};
        const oracle=new FontFace(family,`url(${JSON.stringify(dataUrl)})`,{weight:'100 900'});await oracle.load();document.fonts.add(oracle);const expected=measureTextLayout(shape);document.fonts.delete(oracle);invalidateTextMetrics();
        const root=document.createElement('div');root.style.cssText='position:absolute;width:1000px;height:800px';document.body.append(root);
        const options={faces:[],defaultFamily:'sans-serif',wasmUrl:'omc://canvas/canvaskit.wasm'};
        let handle=await mountEditor(root,{...options,document:doc});
        try{
            assert(handle.fonts.catalog().find((font:Data)=>font.family===family)?.faces.every((face:Data)=>face.status==='loaded'),'saved face loaded before facade readiness');
            const first=handle.editor.page.objects['saved-font-text'];near(first.width,expected.width,'initial autosize uses saved font width');near(first.height,expected.height,'initial autosize uses saved font height');
            const persisted=structuredClone(handle.editor.doc);await handle.destroy();assert(![...document.fonts].some(face=>face.family===family),'destroy removes owned asset FontFace');
            handle=await mountEditor(root,{...options,document:persisted});near(handle.editor.page.objects['saved-font-text'].width,expected.width,'reopen saved font width stable');near(handle.editor.page.objects['saved-font-text'].height,expected.height,'reopen saved font height stable');
            const loadedInk=handle.view.textLines('saved-font-text').reduce((sum:number,line:Data)=>sum+line.width,0);handle.assets.remove('saved');const fallbackInk=handle.view.textLines('saved-font-text').reduce((sum:number,line:Data)=>sum+line.width,0);assert(Math.abs(loadedInk-fallbackInk)>.05,'font removal immediately refreshes scene fragments');assert(!handle.fonts.catalog().some((font:Data)=>font.family===family),'asset removal unregisters face');
            handle.editor.undoStep();await handle.view.settled();assert(handle.fonts.catalog().some((font:Data)=>font.family===family&&font.faces.every((face:Data)=>face.status==='loaded')),'Undo restores and loads asset face');
            handle.editor.redoStep();assert(!handle.fonts.catalog().some((font:Data)=>font.family===family),'Redo removes face');
            const remote=structuredClone(handle.editor.doc);remote.assets={remote:{id:'remote',name:'Projected font',kind:'font',src:dataUrl,family}};handle.editor.receiveDocument(remote);await handle.view.settled();assert(handle.fonts.catalog().some((font:Data)=>font.family===family),'projected font asset registered');
            const deleted=structuredClone(handle.editor.doc);deleted.assets={};handle.editor.receiveDocument(deleted);assert(!handle.fonts.catalog().some((font:Data)=>font.family===family),'projected removal unregisters face');
            const releasePrepared=await handle.fonts.prepareAssets([{name:'prepared',kind:'font',src:dataUrl,family:'QA Prepared Asset'}]);handle.assets.addFile({id:'prepared',name:'prepared',kind:'font',src:dataUrl,family:'QA Prepared Asset'});releasePrepared();assert(handle.fonts.catalog().find((font:Data)=>font.family==='QA Prepared Asset')?.faces.every((face:Data)=>face.status==='loaded'),'file preflight adopts loaded face synchronously');handle.editor.undoStep();assert(!handle.fonts.catalog().some((font:Data)=>font.family==='QA Prepared Asset'),'Undo prepared import removes face');
            const cancelPrepared=await handle.fonts.prepareAssets([{kind:'font',src:dataUrl,family:'QA Cancelled Asset'}]);cancelPrepared();assert(![...document.fonts].some(face=>face.family==='QA Cancelled Asset'),'cancelled file preflight releases temporary face');
            handle.assets.addFile({id:'broken-font',name:'Broken font',kind:'font',src:'data:font/woff2;base64,AAAA',family:'QA Broken Asset'});await handle.view.settled();assert(handle.fonts.catalog().find((font:Data)=>font.family==='QA Broken Asset')?.faces.some((face:Data)=>face.errors?.length),'font load failure observable in catalog');
        }finally{await handle.destroy();root.remove();}
        assert(![...document.fonts].some(face=>face.family===family||face.family==='QA Prepared Asset'||face.family==='QA Broken Asset'),'font assets disposed across reopen/removal/failure');
    });
    await run('native typography cache reuse, invalidation, isolation and bounded retention', ['TEXT-01','TEXT-03'], async()=>{
        const f=fixture([text('cache-text','Cache metrics 한글 😀',{width:160,height:100})]);await f.view.settled();
        const shape=f.editor.page.objects['cache-text'];invalidateTextMetrics();
        const first=measureTextLayout(shape),before=nativeTextCacheDiagnostics();
        first.width=999999;const second=measureTextLayout(shape),after=nativeTextCacheDiagnostics();
        assert(second.width!==999999,'caller cannot poison cached layout measurements');
        assert(after.hits===before.hits+1&&after.misses===before.misses,'identical typography reuses native metrics');
        measureTextLayout({...shape,width:80});assert(nativeTextCacheDiagnostics().misses===after.misses+1,'width invalidates wrapping');
        measureTextLayout({...shape,content:'Different measured text'});assert(nativeTextCacheDiagnostics().misses===after.misses+2,'text invalidates metrics');
        const lines=f.view.textLines('cache-text')!;if(lines.length){const original=lines[0].text;lines[0].text='poison';lines[0].style.fontSize='999px';assert(f.view.textLines('cache-text')![0].text===original,'caller cannot poison scene fragments');}
        const revision=nativeTextCacheDiagnostics().revision;
        f.fonts.add([{...faces[0],family:'QA Cache Font'}] as any);assert(nativeTextCacheDiagnostics().revision>revision,'adding a catalog face invalidates fallback window');
        measureTextLayout({...shape,fontFamily:'QA Cache Font'});const pending=nativeTextCacheDiagnostics().revision;
        await f.fonts.ensure('Cache','QA Cache Font');assert(nativeTextCacheDiagnostics().revision>pending,'loaded face invalidates before ensure returns');
        // Exercise retention directly: unusually large authored HTML signatures must obey byte bounds.
        const large='x'.repeat(2*1024*1024);for(let i=0;i<4;i++)retainTextMetric(large+i,{width:i});
        const bounded=nativeTextCacheDiagnostics();assert(bounded.bytes<=8*1024*1024&&bounded.entries<=4096,'retention bounded by key/value bytes and entry count');
        assert(cachedTextMetric(large+'0')===undefined,'least recent oversized-key entry evicted');invalidateTextMetrics();
    });
    // Keep a genuine rendered gallery mounted for screenshot/background verification.
    const gallery = fixture([{
            id: 'green', x: 25, y: 25, width: 170, height: 100, radiusTopLeft: 22, radiusTopRight: 4, cornerSmoothing: .6, fills: [{ color: '#1d6238' }], shadows: [{
                    style: 'drop', offsetX: 0, offsetY: 6, blur: 12, spread: 0, color: '#000000', opacity: .2
                }]
        }, text('gallery-text', 'Independent rendering 한글 😀', {
            x: 30, y: 145, width: 300, height: 100, content: { type: 'richText', children: [{ children: [{ text: 'Independent rendering 한글 😀', fontFamily: 'IBM Plex Sans', fontSize: 26, fontWeight: 600 }] }] }
        })], { width: 380, height: 280 });
    await gallery.view.settled();
    return { cases, assertions, fonts: gallery.fonts.catalog(), barrier: 'f86e063' };
}
export async function backgroundCapture() {
    const start = performance.now();
    try {
        await active!.view.settled();
        const shot = await active!.view.screenshot('board', { mode: 'overview' });
        const image = await pixels(await (await fetch('data:image/png;base64,' + shot.data)).blob());
        return { pass: image.width === 380 && image.height === 280, ms: Math.round(performance.now() - start), width: image.width, height: image.height };
    }
    catch (error) {
        return { pass: false, error: String(error) };
    }
}
export async function artifacts() {
    const f = active!;
    const result: Data = { svg: await f.exporter.svg(['board']) };
    for (const format of ['png', 'jpeg', 'webp', 'pdf']) {
        const blob = format === 'pdf' ? await f.exporter.pdf('board') : (await f.exporter.raster('board', { type: 'image/' + format }))!;
        const bytes = new Uint8Array(await blob.arrayBuffer());
        let binary = '';
        for (let index = 0; index < bytes.length; index += 8192)
            binary += String.fromCharCode(...bytes.subarray(index, index + 8192));
        result[format] = btoa(binary);
    }
    return result;
}
export function currentDocument() {
    return active!.editor.doc;
}

export async function profileLarge(input:CanvasDocument,inputs:Data[]){
 const timings:Data[]=[];const report=(phase:string,start:number,extra:Data={})=>{const record={phase,ms:performance.now()-start,...extra};timings.push(record);console.log('RENDER_PROFILE '+JSON.stringify(record));};
 document.body.replaceChildren();const root=document.createElement('div');root.style.cssText='position:absolute;inset:0;width:1500px;height:900px';document.body.append(root);const options={defaultFamily:'IBM Plex Sans',fallbacks:['Noto Sans KR','sans-serif'],faces:inputs as any,wasmUrl:'omc://canvas/canvaskit.wasm',onTiming:(record:Data)=>{timings.push(record);console.log('RENDER_PROFILE '+JSON.stringify(record));}};
 const documentCopy=structuredClone(input);let start=performance.now();const catalog=createFontCatalog(inputs as any,options);report('fonts.create',start);start=performance.now();const sample=Object.values(documentCopy.pagesById).flatMap(page=>Object.values(page.objects)).filter(shape=>shape.type==='text').map(shape=>JSON.stringify(shape.content)).join('');await catalog.ensure(sample);report('fonts.ensure',start);
 const expected=inputs.filter(face=>{if(!face.unicodeRange)return true;const intervals=String(face.unicodeRange).split(',').map(token=>{const descriptor=token.trim().slice(2);if(descriptor.includes('?'))return [Number.parseInt(descriptor.replaceAll('?','0'),16),Number.parseInt(descriptor.replaceAll('?','f'),16)];const parts=descriptor.split('-');return [Number.parseInt(parts[0],16),Number.parseInt(parts[1]??parts[0],16)];});return [...sample].some(character=>intervals.some(([low,high])=>character.codePointAt(0)!>=low&&character.codePointAt(0)!<=high));});const css=await catalog.embeddedCss();const loadedRules=(css.match(/@font-face/g)??[]).length;assert(loadedRules===expected.length,'same loaded Unicode slices as independent interval oracle',{loadedRules,expected:expected.length});assert(loadedRules<inputs.length,'large document does not bypass laziness by preloading all slices');assert(timings.find(record=>record.phase==='fonts.ensure')!.ms<2500,'large Unicode selection and IO bounded below 2.5 seconds');report('fonts.subsetOracle',performance.now(),{inputCodeUnits:sample.length,uniqueCodePoints:new Set([...sample]).size,totalFaces:inputs.length,expectedFaces:expected.length,loadedFaces:loadedRules});
 start=performance.now();applyLayout(documentCopy,undefined,options);report('layout.initial',start);start=performance.now();const editor=new Editor(documentCopy);report('editor.constructor',start);const stage=document.createElement('div');stage.style.cssText='position:relative;width:1000px;height:800px';root.append(stage);start=performance.now();const view=createRenderer(editor,stage,{...options,fonts:catalog});report('renderer.constructor',start);start=performance.now();await view.settled();report('renderer.settled',start);view.destroy();editor.destroy();catalog.destroy();stage.remove();start=performance.now();const handle=await mountEditor(root,{...options,document:structuredClone(input)});report('facade.mount',start,{nodes:root.querySelectorAll('*').length});assert(timings.find(record=>record.phase==='facade.mount')!.ms<5000,'large facade mount stays below five seconds');const renameSamples:number[]=[];for(let index=0;index<5;index++){
 const before=nativeTextCacheDiagnostics(),renameStart=performance.now();handle.editor.transact('Profile small rename',draft=>{const page=draft.pagesById[draft.pages[0]],shape=Object.values(page.objects)[0];shape.name='Profile '+index;});await handle.view.settled();const after=nativeTextCacheDiagnostics();renameSamples.push(performance.now()-renameStart);report('facade.rename',renameStart,{metricHits:after.hits-before.hits,metricMisses:after.misses-before.misses});if(index>0)assert(after.misses===before.misses,'small rename reuses all native typography measurements after initial reconciliation');}
 report('facade.renameSummary',performance.now(),{samples:renameSamples,median:[...renameSamples].sort((a,b)=>a-b)[2],cache:nativeTextCacheDiagnostics()});await handle.destroy();return {timings,assertions,objects:Object.values(input.pagesById).reduce((sum,page)=>sum+Object.keys(page.objects).length,0)};
}

export async function mountSvgSecurityFrame(){const iframe=document.createElement('iframe');iframe.id='svg-security-frame';iframe.style.cssText='position:fixed;left:0;top:0;width:420px;height:80px;background:white;z-index:2147483647';document.body.append(iframe);const ready=new Promise<void>(resolve=>iframe.onload=()=>resolve());iframe.srcdoc=(globalThis as any).svgSecuritySource;await ready;await new Promise(resolve=>setTimeout(resolve,100));return {links:iframe.contentDocument?.querySelectorAll('a').length??0,sentinel:(globalThis as any).astraSentinel};}
export function finishSvgSecurityFrame(){const sentinel=(globalThis as any).astraSentinel;document.querySelector('#svg-security-frame')?.remove();return {sentinel};}
