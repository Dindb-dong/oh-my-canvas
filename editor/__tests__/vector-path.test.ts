import { describe, expect, it } from 'vitest';
import { createDocument, createShape, Editor, insertShape } from '../document';
import { hitTest, setShapeOrientation } from '../geometry';
import { exportCanvasJson, importCanvasJson, importSvg, parseSvgPath } from '../formats';
import { shapeMatrix, shapePath } from '../render/scene';
import { assertDocument, flatten, materialize } from '../../core/document.mjs';
import { closePath, convertPathNode, deletePathNodes, insertPathNode, joinPathEnds, movePathNodes, setPathHandle } from '../commands/path';

const compound = (closed = true) => createShape('path', { fillRule: 'evenodd', fills: [{ color: '#000' }], content: [
    { command: 'move', x: 0, y: 0 }, { command: 'line', x: 100, y: 0 }, { command: 'line', x: 100, y: 100 }, { command: 'line', x: 0, y: 100 },
    ...(closed ? [{ command: 'close' }] : []),
    { command: 'move', x: 25, y: 25 }, { command: 'line', x: 25, y: 75 }, { command: 'line', x: 75, y: 75 }, { command: 'line', x: 75, y: 25 },
    ...(closed ? [{ command: 'close' }] : []),
] });

describe('compound path editing', () => {
    it('closes every contour independently and preserves an evenodd hole', () => {
        const path = compound(false);
        closePath(path);
        expect(path.content.map((s: any) => s.command)).toEqual(['move', 'line', 'line', 'line', 'close', 'move', 'line', 'line', 'line', 'close']);
        expect(hitTest(path, { x: 10, y: 10 })).toBe(true);
        expect(hitTest(path, { x: 50, y: 50 })).toBe(false);
        closePath(path);
        expect(path.content.filter((s: any) => s.command === 'close')).toHaveLength(2);
    });

    it('opens only the indexed contour while preserving other closures', () => {
        const path = compound(), outer = structuredClone(path.content.slice(0, 5));
        closePath(path, false, 6);
        expect(path.content.slice(0, 5)).toEqual(outer);
        expect(path.content.at(-1).command).toBe('line');
        expect(path.closed).toBe(true);
        closePath(path, false);
        expect(path.content.some((s: any) => s.command === 'close')).toBe(false);
        expect(path.closed).toBe(false);
    });

    it('does not turn the next contour into a handle or mirror across its move', () => {
        const path = compound(false), next = structuredClone(path.content.slice(4));
        expect(() => setPathHandle(path, 3, 'out', { x: 10, y: 20 })).toThrow('Open endpoint');
        setPathHandle(path, 3, 'in', { x: 10, y: 20 }, 'symmetric');
        expect(path.content.slice(4)).toEqual(next);
        convertPathNode(path, 3, 'smooth');
        expect(path.content.slice(4)).toEqual(next);
        convertPathNode(path, 4, 'smooth');
        expect(path.content[4].command).toBe('move');
        expect(path.content[5].x1).toBeCloseTo(25);
    });

    it('retains move boundaries when deleting the first node of an open contour', () => {
        const path = compound(false), outer = structuredClone(path.content.slice(0, 4));
        deletePathNodes(path, [4]);
        expect(path.content.slice(0, 4)).toEqual(outer);
        expect(path.content[4]).toMatchObject({ command: 'move', x: 25, y: 75 });
        expect(path.content.filter((s: any) => s.command === 'move')).toHaveLength(2);
    });

    it('deletes a whole contour without leaking its close onto another contour', () => {
        const path = compound(), inner = structuredClone(path.content.slice(5));
        deletePathNodes(path, [0, 1, 2, 3]);
        expect(path.content).toEqual(inner);
        deletePathNodes(path, [1, 2, 3]);
        expect(path.content).toEqual([{ command: 'move', x: 25, y: 25 }]);
        expect(path.closed).toBe(false);
    });

    it('moves a contour endpoint without modifying its adjacent contour', () => {
        const path = compound(false), inner = structuredClone(path.content.slice(4));
        movePathNodes(path, [3], 4, 5);
        expect(path.content[3]).toMatchObject({ x: 4, y: 105 });
        expect(path.content.slice(4)).toEqual(inner);
    });

    it('rejects ambiguous compound joins before mutating either path', () => {
        const path = compound(false), other = compound(false), before = structuredClone(path.content);
        expect(() => joinPathEnds(path)).toThrow('one open subpath');
        expect(() => joinPathEnds(path, other, { merge: true })).toThrow('one open subpath');
        expect(path.content).toEqual(before);
    });

    it('rejects invalid indices and nonfinite edits without changing geometry', () => {
        const path = compound(), before = structuredClone(path.content);
        expect(() => insertPathNode(path, .5)).toThrow('Choose a segment');
        expect(() => insertPathNode(path, 5)).toThrow('Choose a segment');
        expect(() => deletePathNodes(path, [4])).toThrow('Unknown path node');
        expect(() => movePathNodes(path, [0], NaN, 0)).toThrow('finite');
        expect(() => setPathHandle(path, 1, 'in', { x: Infinity, y: 0 })).toThrow('finite');
        expect(() => closePath(path, false, 99)).toThrow('Unknown path node');
        expect(path.content).toEqual(before);
    });
});

describe('canonical editable path persistence', () => {
    it('bounds parsing before retaining oversized paths and expanded arcs', () => {
        expect(() => parseSvgPath('M0 0 L1 1 L2 2', 2)).toThrow('too complex');
        expect(() => parseSvgPath('M0 0 A10 10 0 1 1 10 10', 1)).toThrow('too complex');
        expect(() => parseSvgPath(' '.repeat(2000001))).toThrow('too complex');
        expect(parseSvgPath('M0 0 L1 1', 2)).toHaveLength(2);
    });
    it('renders and exports edited rotated SVG content instead of its imported aliases', () => {
        const imported = importSvg('<svg width="100" height="100"><path transform="rotate(20 50 50)" d="M10 10 L90 10 L50 80 Z"/></svg>');
        const path = imported.shapes.find(s => s.type === 'path')!;
        movePathNodes(path, [1], 7, -4);
        setShapeOrientation(path, 90);
        expect(path.segments).toBeUndefined();
        const expected = path.content.map((s: any) => s.command === 'close' ? 'Z' : `${s.command === 'move' ? 'M' : 'L'}${s.x} ${s.y}`).join(' ');
        expect(shapePath(path)).toBe(expected);
        expect(shapeMatrix(path)).toBe('matrix(1 0 0 1 0 0)');
        const doc = createDocument(), page = doc.pagesById[doc.pages[0]];
        insertShape(page, path);
        const saved = exportCanvasJson(doc), reopened = importCanvasJson(saved).pagesById[page.id].objects[path.id];
        reopened.content.forEach((segment: any, index: number) => {
            expect(segment.command).toBe(path.content[index].command);
            if (segment.command !== 'close') {
                expect(segment.x).toBeCloseTo(path.content[index].x, 8);
                expect(segment.y).toBeCloseTo(path.content[index].y, 8);
            }
        });
        expect(shapePath(reopened)).toBe(shapePath(path));
        const persisted = assertDocument(materialize(flatten(doc))).pagesById[page.id].objects[path.id];
        persisted.content.forEach((segment: any, index: number) => {
            if (segment.command !== 'close') {
                expect(segment.x).toBeCloseTo(path.content[index].x, 8);
                expect(segment.y).toBeCloseTo(path.content[index].y, 8);
            }
        });
    });

    it('does not resurrect stale SVG aliases after all editable nodes are deleted', () => {
        const path = createShape('path', { content: [], segments: [{ command: 'move', x: 10, y: 10 }], d: 'M0 0L100 100', pathData: 'M1 1L2 2' });
        expect(shapePath(path)).toBe('');
        const legacy = { ...path };
        delete legacy.content;
        expect(shapePath(legacy)).toBe('M0 0L100 100');
    });

    it.each([
        { d: 'M10 20 L30 40' }, { pathData: 'M10 20 L30 40' }, { path: { d: 'M10 20 L30 40' } },
        { segments: [{ type: 'move', point: { x: 10, y: 20 } }, { type: 'line', point: { x: 30, y: 40 } }] },
        { path: { segments: [{ command: 'move', x: 10, y: 20 }, { command: 'line', x: 30, y: 40 }] } },
    ])('normalizes a legacy path and keeps subsequent deletion empty: %j', legacy => {
        const path = createShape('path', { id: 'legacy', ...legacy });
        expect(shapePath(path)).toBe('M10 20 L30 40');
        expect(path.content).toEqual([{ command: 'move', x: 10, y: 20 }, { command: 'line', x: 30, y: 40 }]);
        const doc = createDocument(), page = doc.pagesById[doc.pages[0]];
        insertShape(page, path);
        const reopened = importCanvasJson(exportCanvasJson(doc));
        expect(shapePath(reopened.pagesById[page.id].objects.legacy)).toBe('M10 20 L30 40');
        deletePathNodes(path, [0, 1]);
        expect(shapePath(path)).toBe('');
        expect(path).not.toHaveProperty('d');
        expect(path).not.toHaveProperty('pathData');
        expect(path).not.toHaveProperty('path');
        expect(path).not.toHaveProperty('segments');
        expect(shapePath(importCanvasJson(exportCanvasJson(doc)).pagesById[page.id].objects.legacy)).toBe('');
    });

    it('normalizes legacy paths in raw document loading and preserves intentional empty content', () => {
        const doc = createDocument(), page = doc.pagesById[doc.pages[0]], path = createShape('path', { id: 'raw', d: 'M2 3 L4 5' });
        insertShape(page, path);
        delete path.content;
        const imported = importCanvasJson(doc);
        expect(shapePath(imported.pagesById[page.id].objects.raw)).toBe('M2 3 L4 5');
        const editor = new Editor(doc);
        expect(editor.page.objects.raw.content).toEqual([{ command: 'move', x: 2, y: 3 }, { command: 'line', x: 4, y: 5 }]);
        editor.destroy();
        path.content = [];
        expect(shapePath(createDocument(doc).pagesById[page.id].objects.raw)).toBe('');
    });

    it.each([
        { d: 'M10 20 L30 40' },
        { segments: [{ command: 'move', x: 10, y: 20 }, { command: 'line', x: 30, y: 40 }] },
    ])('recovers baseline factory empty-content aliases from saved raw documents: %j', aliases => {
        const doc = createDocument(), page = doc.pagesById[doc.pages[0]];
        // Baseline abc7b84 createShape auto-added [] even when legacy geometry was supplied.
        const old = createShape('path', { id: 'old', ...aliases });
        old.content = [];
        delete old.pathContentVersion;
        insertShape(page, old);
        const editor = new Editor(doc);
        for (const loaded of [createDocument(doc), importCanvasJson(doc), editor.doc]) {
            const recovered = loaded.pagesById[page.id].objects.old;
            expect(shapePath(recovered)).toBe('M10 20 L30 40');
            expect(recovered.pathContentVersion).toBe(1);
        }
        editor.destroy();
    });

    it('recovers the baseline portable d-only fixture while authoritative new empty segments stay empty', () => {
        // Baseline exportCanvasJson kept d but serialized auto-added [] as an empty editorPath d.
        const old = { editorPages: [{ id: 'saved' }], pages: [], editorRootLayers: { saved: [{
            id: 'old', type: 'path', x: 0, y: 0, width: 100, height: 100,
            d: 'M10 20 L30 40', editorPath: { content: '' }, editorText: { content: [] },
            editorFrame: { fills: [{ color: '#000' }], strokes: [], opacity: 1 },
            editorBool: { fills: [{ color: '#000' }], strokes: [] },
        }] } };
        expect(shapePath(importCanvasJson(old).pagesById.saved.objects.old)).toBe('M10 20 L30 40');
        const modern = structuredClone(old);
        Object.assign(modern.editorRootLayers.saved[0].editorPath, { segments: [] });
        expect(shapePath(importCanvasJson(modern).pagesById.saved.objects.old)).toBe('');
    });

    it('retains native portable paths above the SVG import budget', () => {
        const d = 'M0 0 ' + Array.from({ length: 10000 }, (_, i) => `L${i + 1} 0`).join(' ');
        expect(parseSvgPath(d)).toHaveLength(10001);
        const doc = importCanvasJson({ pages: [{ id: 'board', children: [{ id: 'long', type: 'path', editorPath: { content: d } }] }] });
        expect(doc.pagesById[doc.pages[0]].objects.long.content).toHaveLength(10001);
        expect(() => importSvg(`<svg><path d="${d}"/></svg>`)).toThrow('complex');
        expect(() => parseSvgPath('M0 0 ' + 'L1 1 '.repeat(50000))).toThrow('complex');
    });

    it.each([
        ['M1E2 0 L2E2 0', 'M100 0 L200 0'],
        ['M.5e-2 0 L1 1', 'M0.005 0 L1 1'],
    ])('normalizes valid exponent notation %s', (d, expected) => {
        expect(shapePath(createShape('path', { d }))).toBe(expected);
    });

    it('rejects nonfinite legacy exponent coordinates', () => {
        expect(() => createShape('path', { d: 'M1e999 0 L1 1' })).toThrow('number');
    });

    it('preserves per-node handle modes through portable local coordinates and the next edit', () => {
        const path = createShape('path', { id: 'modes', x: 50, y: 30, content: [
            { command: 'move', x: 50, y: 30 },
            { command: 'curve', x1: 60, y1: 30, x2: 70, y2: 40, x: 80, y: 40, handleMode: 'symmetric' },
            { command: 'curve', x1: 90, y1: 40, x2: 100, y2: 50, x: 110, y: 50, handleMode: 'free' },
        ] });
        const doc = createDocument(), page = doc.pagesById[doc.pages[0]];
        insertShape(page, path);
        const reopened = importCanvasJson(exportCanvasJson(doc)).pagesById[page.id].objects.modes;
        expect(reopened.content).toEqual(path.content);
        setPathHandle(reopened, 1, 'out', { x: 95, y: 48 });
        expect(reopened.content[1]).toMatchObject({ x2: 65, y2: 32, handleMode: 'symmetric' });
        expect(reopened.content[2]).toMatchObject({ x1: 95, y1: 48 });
    });

    it.each([
        ['symmetric', undefined, undefined, 'symmetric', 20],
        [undefined, 'symmetric', undefined, 'symmetric', 20],
        ['smooth', 'symmetric', undefined, 'aligned', 10],
        ['corner', 'symmetric', undefined, 'free', 10],
        ['symmetric', undefined, 'free', 'free', 10],
    ])('defaults to node/shape modes and honors explicit free (%s/%s/%s)', (nodeMode, shapeMode, explicitMode, expectedMode, length) => {
        const path = createShape('path', { handleMode: shapeMode, content: [
            { command: 'move', x: 0, y: 0 },
            { command: 'curve', x1: 10, y1: 0, x2: 40, y2: 0, x: 50, y: 0, handleMode: nodeMode },
            { command: 'curve', x1: 60, y1: 0, x2: 90, y2: 0, x: 100, y: 0 },
        ] });
        setPathHandle(path, 1, 'out', { x: 50, y: 20 }, explicitMode as string | undefined);
        expect(path.content[1].handleMode).toBe(expectedMode);
        const incoming = path.content[1];
        expect(Math.hypot(incoming.x2 - incoming.x, incoming.y2 - incoming.y)).toBeCloseTo(Number(length));
        if (expectedMode === 'free')
            expect(incoming).toMatchObject({ x2: 40, y2: 0 });
        else {
            expect(incoming.x2).toBeCloseTo(50);
            expect(incoming.y2).toBeCloseTo(-Number(length));
        }
    });

    it('preserves image restoration and outline source metadata through interchange and CRDT fields', () => {
        const doc = createDocument(), page = doc.pagesById[doc.pages[0]], originalImage = { src: 'data:image/png;base64,b3JpZ2luYWw=', width: 2, height: 2, mimeType: 'image/png' };
        const image = createShape('image', { id: 'photo', image: { ...originalImage, src: 'data:image/png;base64,bWFza2Vk' }, originalImage });
        const path = createShape('path', { id: 'outlined', content: [{ command: 'move', x: 1, y: 2 }, { command: 'line', x: 3, y: 4 }], outlineSourceId: 'source', originalHidden: false });
        insertShape(page, image);
        insertShape(page, path);
        const exported = exportCanvasJson(doc);
        expect(exported.editorRootLayers[page.id].every((s: any) => !s.editorFrame && !s.editorBool)).toBe(true);
        for (const restored of [importCanvasJson(exported), assertDocument(materialize(flatten(doc)))]) {
            expect(restored.pagesById[page.id].objects.photo.type).toBe('image');
            expect(restored.pagesById[page.id].objects.outlined.type).toBe('path');
            expect(restored.pagesById[page.id].objects.photo.originalImage).toEqual(originalImage);
            expect(restored.pagesById[page.id].objects.outlined).toMatchObject({ outlineSourceId: 'source', originalHidden: false });
        }
    });

    it('does not reclassify styled layers as boolean/frame during portable round trips', () => {
        const doc = createDocument(), page = doc.pagesById[doc.pages[0]];
        for (const type of ['rect', 'ellipse', 'group', 'boolean', 'text', 'image', 'svg'])
            insertShape(page, createShape(type, { id: type, fills: [{ color: '#123456' }], strokes: [{ color: '#000', width: 2 }] }));
        const reopened = importCanvasJson(exportCanvasJson(doc));
        for (const type of ['rect', 'ellipse', 'group', 'boolean', 'text', 'image', 'svg'])
            expect(reopened.pagesById[page.id].objects[type].type).toBe(type);
    });
});
