import { describe, it, expect } from 'vitest';
import { createDocument, createShape, createPage, insertShape, validateDocument } from '../document';
import { importCanvasJson, exportCanvasJson, importHtml, exportHtml, importSvg, parseSvgPath } from '../formats';
import { textValue } from '../formats/model';
import { sampleCanvas, blankCanvas } from '../../src/sample.js';
// Independently authored synthetic interchange documents; no application/user fixtures.
describe('FMT-02 / DOC-02 Canvas interchange', () => {
    it.each([sampleCanvas, blankCanvas])('opens the authored host sample/default without invalid legacy types', make => {
        const d = importCanvasJson(make());
        validateDocument(d);
        expect(Object.values(d.pagesById[d.pages[0]].objects).some(s => s.type === 'figure')).toBe(false);
    });
    it('places legacy boards vertically with 100 gap and gives missing IDs/default sizes', () => {
        const doc = importCanvasJson({ pages: [
                { children: [{
                            type: 'figure', subType: 'ellipse', x: 12, y: 9, width: 20, height: 30
                        }] }, { height: 240, children: [] }, { children: [] }
            ] });
        const page = doc.pagesById[doc.pages[0]], boards = page.objects.root.childIds!.map(id => page.objects[id]);
        expect(boards.map(s => [
            s.x, s.y, s.width, s.height
        ])).toEqual([
            [
                0, 0, 1000, 1000
            ], [
                0, 1100, 1000, 240
            ], [
                0, 1440, 1000, 1000
            ]
        ]);
        expect(page.objects[boards[0].childIds![0]].type).toBe('ellipse');
        expect(new Set(Object.keys(page.objects)).size).toBe(5);
        validateDocument(doc);
    });
    it('obeys explicit placement and frame-local geometry and path control coordinates', () => {
        const doc = importCanvasJson({ pages: [{
                    id: 'b', width: 500, height: 300, children: [{
                            id: 'f', type: 'group', editorFrame: {
                                x: 40, y: 30, width: 100, height: 80
                            }, children: [{
                                    id: 'p', type: 'figure', x: 5, y: 6, width: 10, height: 10, editorPath: { content: 'M0 0 C2 3 4 5 10 10 Z' }
                                }]
                        }]
                }] }, { placement: () => ({ x: 100, y: 200 }) });
        const o = doc.pagesById[doc.pages[0]].objects;
        expect([
            o.f.x, o.f.y, o.p.x, o.p.y
        ]).toEqual([
            140, 230, 145, 236
        ]);
        expect(o.p.content).toEqual([
            {
                command: 'move', x: 145, y: 236
            }, {
                command: 'curve', x: 155, y: 246, x1: 147, y1: 239, x2: 149, y2: 241
            }, { command: 'close' }
        ]);
        expect(importCanvasJson(exportCanvasJson(doc)).pagesById[doc.pages[0]].objects.p.content).toEqual(o.p.content);
    });
    it('retains all advanced wrappers, unknown metadata, multipage association, roots and domain records', () => {
        const input = {
            opaque: { keep: ['metadata', 3] }, extra: { source: 'synthetic' }, editorPages: [{
                    id: 'one', name: 'First', guides: [{ axis: 'x', position: 20 }], mystery: 9
                }, { id: 'two', name: 'Second' }], editorComponents: { c: {
                    id: 'c', name: 'Main', mainId: 'b', opaque: 'yes'
                } }, editorStyles: { s: {
                    id: 's', type: 'paint', paints: [{ color: '#123' }]
                } }, editorLibraries: { lib: {
                    id: 'lib', version: 3, enabled: false, opaque: true
                } }, pages: [{
                    id: 'b', editorPage: 'one', width: 200, height: 100, editorFrame: {
                        x: 30, y: 40, width: 200, height: 100, clipContent: true, omitFillOnExport: true
                    }, editorComponent: { isMain: true, componentId: 'c' }, children: [{
                            id: 'x', type: 'figure', x: 5, y: 6, width: 30, height: 20, customBlob: { a: 1 }, editorLayout: {
                                hSizing: 'fill', vSizing: 'hug', minWidth: 5, maxWidth: 99, absolute: true, horizontalConstraint: 'scale', verticalConstraint: 'bottom', future: 33
                            }, editorStyle: {
                                fills: [{ gradient: {
                                            type: 'diamond', x1: 0, y1: 0, x2: 1, y2: 1, aspect: 2, stops: [{ offset: 0, color: '#000' }, { offset: 1, color: '#fff' }]
                                        } }], strokes: [{
                                        color: '#a00', width: 3, dashes: [1, 2], startCap: 'arrow'
                                    }], shadows: [{
                                        style: 'inner', offsetX: 2, offsetY: 3, blur: 4, spread: 1, color: '#000'
                                    }], backgroundBlur: 2, radiusTopLeft: 7, unknown: 'style'
                            }, editorStyleRef: { fillStyleId: 's' }, editorVector: {
                                cornerSmoothing: .3, strokeSides: {
                                    top: 2, right: 0, bottom: 1, left: 0
                                }, primitive: {
                                    kind: 'star', count: 7, ratio: .4
                                }
                            }, editorMask: { isMaskGroup: true, maskType: 'luminance' }, editorGrid: { gridCell: {
                                    row: 2, column: 3, rowSpan: 2, columnSpan: 1
                                } }, editorExport: { exportSettings: [{
                                        format: 'webp', suffix: '@2x', constraint: { type: 'scale', value: 2 }
                                    }] }
                        }]
                }, {
                    id: 'tboard', editorPage: 'two', children: [{
                            id: 't', type: 'text', text: 'Two\nlines', editorText: {
                                content: {
                                    type: 'richText', verticalAlign: 'center', children: [{
                                            textAlign: 'right', listType: 'bullet', children: [{
                                                    text: 'Two', fontWeight: 700, fontFamily: 'Example', fills: [{ color: '#00f' }], highlight: { color: '#ff0' }
                                                }]
                                        }, { children: [{ text: 'lines' }] }]
                                }, autoResize: 'none', lineBreak: 'syllable', truncate: true, maxLines: 2, leadingTrim: 'capHeight', future: 'text'
                            }
                        }]
                }], editorRootLayers: { two: [{
                        id: 'loose', type: 'group', x: 17, y: 19, width: 20, height: 20, editorBool: { booleanOperation: 'exclude', future: 'boolean' }, children: []
                    }] }
        };
        const doc = importCanvasJson(input), encoded = exportCanvasJson(doc), again = importCanvasJson(encoded), o = again.pagesById.one.objects;
        expect(again.pages).toEqual(['one', 'two']);
        expect(encoded.editorPages).toEqual(input.editorPages);
        expect(encoded.pages.map((p: any) => p.editorPage)).toEqual(['one', 'two']);
        expect(encoded.opaque).toEqual(input.opaque);
        expect(again.components?.c.mainPageId).toBe('one');
        expect(encoded.editorComponents.c.mainPageId).toBeUndefined();
        expect(again.styles).toEqual(input.editorStyles);
        expect(again.libraries).toEqual(input.editorLibraries);
        expect(o.x.customBlob).toEqual({ a: 1 });
        expect(o.x.hSizing).toBe('fill');
        expect(o.x.vSizing).toBe('hug');
        expect(o.x.minWidth).toBe(5);
        expect(o.x.horizontalConstraint).toBe('scale');
        expect(o.x.fills).toEqual(input.pages[0].children[0].editorStyle.fills);
        expect(o.x.strokes).toEqual(input.pages[0].children[0].editorStyle.strokes);
        expect(o.x.shadows).toEqual(input.pages[0].children[0].editorStyle.shadows);
        expect(o.x.fillStyleId).toBe('s');
        expect(o.x.maskType).toBe('luminance');
        expect(o.x.gridCell.rowSpan).toBe(2);
        expect(o.x.exportSettings[0].suffix).toBe('@2x');
        expect(o.x.legacy.editorLayout.future).toBe(33);
        expect(o.x.legacy.editorStyle.unknown).toBe('style');
        expect(again.pagesById.two.objects.loose.booleanOperation).toBe('exclude');
        expect(again.pagesById.two.objects.t.content).toEqual(input.pages[1].children[0].editorText.content);
        expect(again.pagesById.two.objects.t.legacy.editorText.future).toBe('text');
        validateDocument(again);
    });
    it('visible legacy text wins without discarding first run style; null style clears paints', () => {
        const doc = importCanvasJson({ pages: [{ children: [{
                            id: 't', type: 'text', text: 'Changed', fill: '#a00', editorStyle: { fills: null }, editorText: { content: { type: 'richText', children: [{ children: [{ text: 'Old', fontWeight: 800 }] }] } }
                        }] }] });
        const t = doc.pagesById[doc.pages[0]].objects.t;
        expect(textValue(t)).toBe('Changed');
        expect(t.content.children[0].children[0].fontWeight).toBe(800);
        expect(t.fills).toEqual([]);
        expect(exportCanvasJson(doc).pages[0].children[0].editorStyle.fills).toBeNull();
    });
    it('does not mutate caller models and preserves arbitrary current-model fields', () => {
        const doc = createDocument(), page = doc.pagesById[doc.pages[0]], s = createShape('rect', { id: 'opaque', extra: { nested: [1, 2] } });
        insertShape(page, s);
        const original = structuredClone(doc), result = importCanvasJson(doc);
        result.pagesById[page.id].objects.opaque.extra.nested.push(3);
        expect(doc).toEqual(original);
    });
    it.each([
        null, [], { pagesById: {} }, { pages: [{ width: -1 }] }
    ])('rejects malformed/negative geometry %#', (input) => expect(() => importCanvasJson(input)).toThrow());
});
describe('FMT-01 HTML inert parser and shared layout', () => {
    it('imports rich runs/br, entity decoding and names/refs without browser heading defaults', () => {
        const result = importHtml('<h1 data-name="Title" data-ref="hero">A &amp; <strong>B</strong><br><em>C</em></h1>');
        const s = result.objects[result.rootIds[0]];
        expect(s.type).toBe('text');
        expect(s.name).toBe('Title');
        expect(s.dataRef).toBe('hero');
        expect(textValue(s)).toBe('A & B\nC');
        expect(s.content.children[0].children[1].fontWeight).toBe('700');
        expect(s.content.children[1].children[0].fontStyle).toBe('italic');
        expect(s.content.children[0].children[0].fontSize).toBe(16);
    });
    it('lays ordinary blocks vertically and converts flex/grid, sides, images, ellipse and warnings', () => {
        const r = importHtml('<div style="display:flex;flex-direction:column;padding:10px;gap:7px;width:200px"><div data-ref="a" style="width:30px;height:20px;background:#123;border:2px solid #456;border-radius:4px"></div><div data-ref="b" style="width:40px;height:10px;border-radius:50%"></div><img src="data:image/png;base64,AA==" width="10" height="8"></div>');
        const root = r.objects[r.rootIds[0]], a = r.shapes.find(s => s.dataRef === 'a')!, b = r.shapes.find(s => s.dataRef === 'b')!;
        expect([
            a.x, a.y, a.width, a.height
        ]).toEqual([
            10, 10, 30, 20
        ]);
        expect([
            b.x, b.y, b.type
        ]).toEqual([
            10, 37, 'ellipse'
        ]);
        expect(root.height).toBe(72);
        expect(a.radii).toEqual([
            4, 4, 4, 4
        ]);
        expect(a.strokes[0]).toMatchObject({ width: 2, color: '#456' });
        expect(r.shapes.find(s => s.type === 'image')?.image.src).toContain('data:image/png');
        const g = importHtml('<div style="display:grid;grid-template-columns:repeat(2,1fr);width:200px;height:100px"><div style="width:20px;height:10px;grid-column:2;grid-row:1"></div></div>');
        expect(g.objects[g.rootIds[0]].layout.columns).toHaveLength(2);
        expect(g.shapes.find(s => s.gridCell)?.gridCell).toMatchObject({ column: 2, row: 1 });
        expect(importHtml('<div style="width:20px;height:10px;margin:4px;float:left;--custom:blue"></div>').warnings.join(' ')).toMatch(/margin.*float.*--custom/);
    });
    it('preserves inline SVG as picture with original XML viewBox/gradient case', () => {
        const r = importHtml('<svg viewBox="0 0 20 10" width="40" height="20"><defs><linearGradient id="g"><stop offset="0" stop-color="#000"/></linearGradient></defs><rect width="20" height="10" fill="url(#g)"/></svg>');
        const s = r.objects[r.rootIds[0]];
        expect(s.type).toBe('svg');
        expect(s.svg).toContain('viewBox=');
        expect(s.svg).toContain('linearGradient');
        expect(s.viewBox).toBe('0 0 20 10');
    });
    it('exports rich paragraphs with explicit breaks and aliases', () => {
        const doc = createDocument(), p = doc.pagesById[doc.pages[0]];
        insertShape(p, createShape('text', { id: 't', content: { type: 'richText', children: [{ children: [{ text: 'One', fontWeight: 700 }] }, { children: [{ text: 'Two' }] }] } }));
        const html = exportHtml(doc, p.id, ['t'], { alias: () => 'n1' });
        expect(html).toContain('data-id="n1"');
        expect(textValue(importHtml(html).shapes.find(s => s.type === 'text')!)).toBe('One\nTwo');
        expect(() => exportHtml(doc, p.id, ['t'], { limit: 2 })).toThrow(/limit/);
    });
    it.each([
        '<script>alert(1)</script>', '<div onclick="run()"></div>', '<style>div{color:red}</style>', '<iframe src="https://example.invalid"></iframe>', '<div class="red"></div>', '<img src="java\nscript:alert(1)">', '<div style="background:url(javascript:alert(1))"></div>'
    ])('rejects executable/unsupported styling surface %s', html => expect(() => importHtml(html)).toThrow());
    it.each([
        '<div title="unfinished>', '<!-- missing close', '<div style="width:expression(alert(1))"></div>'
    ])('rejects malformed or executable CSS %s', html => expect(() => importHtml(html)).toThrow());
});
describe('FMT-02 SVG analytic conversion', () => {
    it('bounds curved paths by their extrema rather than their control hull', () => {
        const r = importSvg('<svg width="30" height="20"><path d="M0 0 Q10 10 20 0"/></svg>'), p = r.shapes.find(s => s.type === 'path')!;
        expect(p.x).toBeCloseTo(0, 8);
        expect(p.y).toBeCloseTo(0, 8);
        expect(p.width).toBeCloseTo(20, 8);
        expect(p.height).toBeCloseTo(5, 8);
    });
    it('accepts compact arc flags and rejects out-of-grammar flags', () => {
        expect(parseSvgPath('M0 0 A10 10 0 0110 10').at(-1)?.point).toEqual({ x: 10, y: 10 });
        expect(() => parseSvgPath('M0 0 A10 10 0 2 1 10 10')).toThrow(/flag/);
    });
    it('normalizes relative/smooth/quadratic and arc commands to editable cubics', () => {
        const segments = parseSvgPath('M1 2 h3 v4 l5 6 q3 0 6 3 t6 3 c1 2 3 4 5 6 s3 4 5 6 a10 10 0 0 1 10 10 z');
        expect(segments.map(s => s.type)).toEqual([
            'move', 'line', 'line', 'line', 'curve', 'curve', 'curve', 'curve', 'curve', 'close'
        ]);
        expect(segments[3].point).toEqual({ x: 9, y: 12 });
        expect(segments[4].control1).toEqual({ x: 11, y: 12 });
        expect(segments[5].control1).toEqual({ x: 17, y: 17 });
        expect(segments.at(-2)?.point).toEqual({ x: 41, y: 40 });
    });
    it('preserves affine/skew transforms, viewBox meet alignment and editable paint', () => {
        const r = importSvg('<svg width="200" height="100" viewBox="0 0 100 100"><g transform="translate(10 5)"><rect id="box" x="0" y="0" width="20" height="10" fill="#123" transform="skewX(45)"/></g></svg>');
        const s = r.shapes.find(s => s.name === 'box')!;
        expect(s.type).toBe('rect');
        expect(s.corners.map(p => [Math.round(p.x), Math.round(p.y)])).toEqual([
            [60, 5], [80, 5], [90, 15], [70, 15]
        ]);
        expect(s.fills[0].color).toBe('#123');
    });
    it('converts local path points to world coordinates under transforms and resolves use', () => {
        const r = importSvg('<svg width="100" height="100"><defs><path id="d" d="M0 0 L10 0 L10 10 Z"/></defs><use href="#d" x="7" y="9" transform="scale(2)"/></svg>');
        const p = r.shapes.find(s => s.type === 'path')!;
        expect(p.content[0]).toEqual({
            command: 'move', x: 14, y: 18
        });
        expect(p.content[2]).toEqual({
            command: 'line', x: 34, y: 38
        });
    });
    it('keeps unsupported effects/group clipping and positioned text as safe source pictures', () => {
        const r = importSvg('<svg width="80" height="40"><defs><clipPath id="clip"><rect width="20" height="20"/></clipPath></defs><g clip-path="url(#clip)"><rect width="40" height="20"/></g><text x="1" y="10"><tspan x="4">a</tspan></text></svg>');
        expect(r.rootIds.map(id => r.objects[id].type)).toEqual(['svg', 'svg']);
        expect(r.warnings).toHaveLength(2);
        expect(r.shapes[0].svg).toContain('clipPath');
    });
    it.each([
        '<svg><script/></svg>', '<svg><image href="javascript:alert(1)"/></svg>', '<svg><use id="x" href="#x"/></svg>', '<svg><path d="M0 0 L"/></svg>'
    ])('rejects unsafe/cyclic/malformed input %s', svg => expect(() => importSvg(svg)).toThrow());
});


describe('FMT-02 static SVG security boundary', () => {
    it.each(['animate', 'set', 'animateMotion', 'animateTransform', 'animateColor', 'discard', 'mpath', 'animation'])(
        'rejects SMIL mutation element %s inside a preserved unsupported picture', tag => {
            const svg = `<svg xmlns="http://www.w3.org/2000/svg"><switch><a href="#"><${tag} attributeName="href" values="javascript:globalThis.astraSentinel=1" to="javascript:globalThis.astraSentinel=1" dur="1ms" fill="freeze"/><rect width="20" height="20"/></a></switch></svg>`;
            expect(() => importSvg(svg)).toThrow(/Unsafe element/);
        }
    );
    it('rejects namespaced mutation tags using the shared local-name policy', () => {
        expect(() => importSvg('<svg xmlns="http://www.w3.org/2000/svg" xmlns:s="http://www.w3.org/2000/svg"><switch><s:animate attributeName="href" values="javascript:alert(1)"/></switch></svg>')).toThrow(/Unsafe element/);
    });
    it('preserves ordinary static unsupported graphics', () => {
        const result = importSvg('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="30"><switch><a href="#details"><rect width="20" height="10" fill="green"/></a></switch></svg>');
        const pictures = Object.values(result.objects).filter(s => s.type === 'svg');
        expect(pictures).toHaveLength(1);
        expect(pictures[0].svg).toContain('<switch');
        expect(pictures[0].svg).toContain('fill="green"');
    });
});
