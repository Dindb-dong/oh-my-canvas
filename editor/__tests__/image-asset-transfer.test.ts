// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Editor, createDocument, createShape, insertShape } from '../document';
import { createCommands } from '../commands';
import { createAssetService } from '../assets';
import { imageSource, portableClipboard, portableDocument, prepareAssetTransfer } from '../images/assets';
import { exportCanvasJson, importCanvasJson } from '../formats/canvas';
import { exportHtml } from '../formats/html';
import { SceneWriter } from '../render/scene';
import { inlineSVGImages } from '../export/raster';
import { installLvMcp } from '../mcp';
import { clipboardPayload, pasteProperties, prepareClipboardPayload } from '../mcp/operations';
import type { Data } from '../contracts';

const pixel = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=';
const otherPixel = 'data:image/png;base64,AQID';
const hash = 'a'.repeat(64), source = `omc-asset:sha256:${hash}`, url = `omc://canvas/assets/${hash}`;
const cleanups: Array<() => void> = [];
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()); vi.unstubAllGlobals(); });

function fixture(memory = { text: '' }, assetSource = pixel) {
    const doc = createDocument({ pageId: 'p' });
    doc.assets = { photo: { id: 'photo', kind: 'image', name: 'Photo', src: assetSource, width: 1, height: 1 } };
    insertShape(doc.pagesById.p, createShape('image', { id: 'photo', width: 20, height: 20, image: { assetId: 'photo' }, fills: [] }));
    insertShape(doc.pagesById.p, createShape('rect', { id: 'paint', width: 20, height: 20, x: 30, fills: [{ image: { assetId: 'photo' } }] }));
    const editor = new Editor(doc);
    const commands = createCommands(editor, { clipboard: { writeText: async (text: string) => { memory.text = text; }, readText: async () => memory.text } });
    cleanups.push(() => { commands.destroy(); editor.destroy(); });
    return { editor, commands, memory };
}

describe('image clipboard dependencies', () => {
    it('copies images and image fills across documents, remaps collisions, and undoes assets with layers', async () => {
        const memory = { text: '' }, from = fixture(memory), to = fixture(memory, otherPixel);
        from.editor.setSelection(['photo', 'paint']);
        await from.commands.run('edit.copy');
        const payload = JSON.parse(memory.text);
        expect(Object.keys(payload.assetDefinitions)).toEqual(['photo']);
        expect(payload.assets).toBeUndefined();
        const before = structuredClone(to.editor.doc);
        await to.commands.run('edit.paste');
        const copied = to.editor.selection.map(id => to.editor.page.objects[id]);
        const assetId = copied[0].image.assetId;
        expect(assetId).not.toBe('photo');
        expect(to.editor.doc.assets.photo.src).toBe(otherPixel);
        expect(imageSource(copied[0].image, to.editor.doc.assets)).toBe(pixel);
        expect(copied[1].fills[0].image.assetId).toBe(assetId);
        expect(to.editor.undoStep()).toBe(true);
        expect(to.editor.doc).toEqual(before);
        expect(to.editor.redoStep()).toBe(true);
        expect(imageSource(to.editor.page.objects[copied[0].id].image, to.editor.doc.assets)).toBe(pixel);
    });

    it('preserves an asset ID equal to the source layer ID and reuses existing image bytes', async () => {
        const from = fixture();
        from.editor.setSelection(['photo']);
        await from.commands.run('edit.copy');
        await from.commands.run('edit.paste');
        const pasted = from.editor.page.objects[from.editor.selection[0]];
        expect(pasted.id).not.toBe('photo');
        expect(pasted.image.assetId).toBe('photo');
        expect(Object.keys(from.editor.doc.assets)).toEqual(['photo']);
    });

    it('moves image fill dependencies with copy properties through UI and MCP paths', async () => {
        const memory = { text: '' }, from = fixture(memory), to = fixture(memory, otherPixel);
        from.editor.setSelection(['paint']); to.editor.setSelection(['paint']);
        await from.commands.run('edit.copy-properties');
        const before = structuredClone(to.editor.doc);
        await to.commands.run('edit.paste-properties');
        expect(imageSource(to.editor.page.objects.paint.fills[0].image, to.editor.doc.assets)).toBe(pixel);
        expect(to.editor.doc.assets.photo.src).toBe(otherPixel);
        expect(to.editor.undoStep()).toBe(true); expect(to.editor.doc).toEqual(before);
        const payload = clipboardPayload({ action: 'copy_properties', ids: ['paint'] }, from.editor);
        to.editor.transact('MCP paste properties', () => pasteProperties(payload, ['paint'], to.editor));
        expect(imageSource(to.editor.page.objects.paint.fills[0].image, to.editor.doc.assets)).toBe(pixel);
        expect(to.editor.undoStep()).toBe(true); expect(to.editor.doc).toEqual(before);
    });

    it('accepts legacy assets, rejects conflicting definitions and missing dependencies before mutation', () => {
        const t = fixture(), asset = t.editor.doc.assets.photo;
        const old = { shapes: [structuredClone(t.editor.page.objects.photo)], roots: ['photo'], assets: { photo: asset } };
        const prepared = prepareClipboardPayload({ ...old, kind: 'oh-my-canvas/shapes' }, createDocument());
        expect(prepared.assets).toBeUndefined(); expect(prepared.assetDefinitions.photo.src).toBe(pixel);
        const before = t.editor.doc;
        expect(() => t.commands.pastePrepared({ ...old, assetDefinitions: { photo: { ...asset, src: otherPixel } } })).toThrow(/Conflicting/);
        expect(t.editor.doc).toBe(before);
        expect(() => prepareAssetTransfer({ shapes: [{ image: { assetId: 'lost' } }] })).toThrow(/Missing clipboard image asset/);
    });

    it('retains referenced catalog images once after removal and restores catalog state with Undo', () => {
        const t = fixture(), assets = createAssetService(t.editor), before = structuredClone(t.editor.doc);
        assets.remove('photo');
        expect(assets.list()).toEqual([]);
        expect(t.editor.doc.assets.photo.deleted).toBe(true);
        expect(t.editor.page.objects.photo.image).toEqual({ assetId: 'photo' });
        expect(imageSource(t.editor.page.objects.paint.fills[0].image, t.editor.doc.assets)).toBe(pixel);
        expect(t.editor.undoStep()).toBe(true); expect(t.editor.doc).toEqual(before);
        expect(() => assets.addFile({ id: 'photo', kind: 'image', name: 'Replacement', src: otherPixel })).toThrow(/already exists/);
        expect(t.editor.doc).toEqual(before);
    });

    it('uses the canonical image contract through actual MCP copy, paste, properties, Undo and redo calls', async () => {
        const from = fixture(), to = fixture(undefined, otherPixel);
        const endpoint = (t: ReturnType<typeof fixture>) => {
            const view: any = { settled: async () => {}, measure: () => new Map(), render: () => {}, computedStyle: () => ({}) };
            const api = installLvMcp(t.editor, view, { services: { fonts: { ensure: async () => {} } } });
            cleanups.push(() => api.dispose());
            return async (tool: string, args: Data) => {
                const response = await api.handleToolCall('test', tool, args);
                expect(response.isError, JSON.stringify(response)).not.toBe(true);
                return response.structuredContent!;
            };
        };
        const copy = endpoint(from), paste = endpoint(to), before = structuredClone(to.editor.doc);
        const result = await copy('clipboard', { action: 'copy', ids: ['photo'] });
        expect(result.payload.assetDefinitions.photo.src).toBe(pixel);
        await paste('clipboard', { action: 'paste', payload: result.payload });
        expect(imageSource(to.editor.page.objects[to.editor.selection[0]].image, to.editor.doc.assets)).toBe(pixel);
        await paste('undo', {}); expect(to.editor.doc).toEqual(before);
        await paste('redo', {});
        const properties = await copy('clipboard', { action: 'copy_properties', ids: ['paint'] });
        await paste('clipboard', { action: 'paste_properties', ids: ['paint'], payload: properties.payload });
        expect(imageSource(to.editor.page.objects.paint.fills[0].image, to.editor.doc.assets)).toBe(pixel);
    });
});

describe('portable image exports', () => {
    const bytes = () => Uint8Array.from(atob(pixel.split(',')[1]), character => character.charCodeAt(0));
    const mockImage = () => {
        const fetch = vi.fn(async (_input: RequestInfo | URL) => new Response(bytes(), { headers: { 'content-type': 'image/png' } }));
        vi.stubGlobal('fetch', fetch); return fetch;
    };
    it('hydrates a bitmap once, round-trips Canvas JSON and exports image fills without workspace URLs', async () => {
        const t = fixture(undefined, source), fetch = mockImage();
        t.editor.transact('Direct source', doc => { doc.pagesById.p.objects.photo.image = { src: source }; });
        const original = t.editor.doc;
        expect(() => exportCanvasJson(original)).toThrow(/portableDocument/);
        expect(() => exportHtml(original, 'p', ['photo', 'paint'])).toThrow(/portableDocument/);
        const portable = await portableDocument(original, value => value === source ? url : value);
        expect(fetch).toHaveBeenCalledTimes(1); expect(fetch.mock.calls[0][0]).toBe(url);
        expect(original.assets.photo.src).toBe(source);
        expect(portable.pagesById.p.objects.photo.image).toEqual({ assetId: 'photo' });
        const json = JSON.stringify(exportCanvasJson(portable)), html = exportHtml(portable, 'p', ['photo', 'paint']);
        expect(json).not.toMatch(/omc-asset:|omc:\/\//); expect(html).not.toMatch(/omc-asset:|omc:\/\//);
        expect(html).toContain(pixel);
        const roundtrip = importCanvasJson(json), page = roundtrip.pagesById.p;
        expect(imageSource(page.objects.photo.image, roundtrip.assets)).toBe(pixel);
        expect(imageSource(page.objects.paint.fills[0].image, roundtrip.assets)).toBe(pixel);
    });

    it('uses hydrated assets when complex HTML export renders the retained live scene', async () => {
        const t = fixture(undefined, source); mockImage();
        t.editor.transact('Path image', doc => {
            const shape = doc.pagesById.p.objects.paint;
            shape.type = 'path'; shape.content = [{ command: 'move', x: 0, y: 0 }, { command: 'line', x: 20, y: 0 }, { command: 'line', x: 20, y: 20 }, { command: 'close' }];
            shape.fills = [{ image: { src: source } }];
        });
        const portable = await portableDocument(t.editor.doc, () => url);
        const view: any = { sceneSvg: (ids: string[], options: Data) => new SceneWriter(t.editor.page.objects, { ...options, resolveImageSource: value => value === source ? url : value }).svg(ids, options.bounds) };
        const html = exportHtml(portable, 'p', ['paint'], { view });
        expect(html).toContain(pixel); expect(html).not.toMatch(/omc-asset:|omc:\/\//);
    });

    it('hydrates direct source clipboard records without a pre-existing asset catalog', async () => {
        const fetch = mockImage();
        const payload = await portableClipboard({ kind: 'oh-my-canvas/shapes', shapes: [{ image: { src: source } }, { fills: [{ image: { src: source } }] }] }, () => url);
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(Object.keys(payload.assetDefinitions)).toEqual([hash]);
        expect(payload.shapes[0].image).toEqual({ assetId: hash });
        expect(payload.shapes[1].fills[0].image).toEqual({ assetId: hash });
        expect(Object.hasOwn(payload, 'assets')).toBe(false);
        expect(JSON.stringify(payload)).not.toContain('omc-asset:');
    });

    it('embeds each unique SVG bitmap only once and propagates byte limits', async () => {
        const fetch = mockImage(), svg = `<svg xmlns="http://www.w3.org/2000/svg">${Array.from({ length: 10 }, () => `<image href="${url}" width="10" height="10"/>`).join('')}</svg>`;
        const portable = await inlineSVGImages(svg);
        expect(fetch).toHaveBeenCalledTimes(1); expect(portable).not.toContain('omc://');
        expect(portable.match(/data:image\/png/g)).toHaveLength(10);
        await expect(inlineSVGImages(svg, { maxBytes: 5 })).rejects.toThrow(/byte limit/);
    });

    it('fails on unavailable images, aborts and enforces declared and streaming byte budgets', async () => {
        const doc = fixture(undefined, source).editor.doc;
        await expect(portableDocument(doc)).rejects.toThrow(/unavailable/);
        const fetch = vi.fn(async () => new Response(null, { status: 404 })); vi.stubGlobal('fetch', fetch);
        await expect(portableDocument(doc, () => url)).rejects.toThrow(/404/);
        const controller = new AbortController(); controller.abort(Error('Cancelled'));
        await expect(portableDocument(doc, () => url, { signal: controller.signal })).rejects.toThrow(/Cancelled/);
        expect(fetch).toHaveBeenCalledTimes(1);
        vi.stubGlobal('fetch', vi.fn(async () => new Response(bytes(), { headers: { 'content-length': '1000' } })));
        await expect(portableDocument(doc, () => url, { maxBytes: 5 })).rejects.toThrow(/byte limit/);
        const cancel = vi.fn();
        vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({ start(stream) { stream.enqueue(new Uint8Array(10)); }, cancel }))));
        await expect(portableDocument(doc, () => url, { maxBytes: 5 })).rejects.toThrow(/byte limit/);
        expect(cancel).toHaveBeenCalledOnce();
        await expect(portableDocument(doc, () => pixel, { maxBytes: 5 })).rejects.toThrow(/byte limit/);
    });
});
