// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { resolve } from 'node:path';
import { Editor, createDocument, createShape, insertShape } from '../document';
import { createRenderer, shapePath } from '../render';
import { loadKit } from '../render/vector';
import { installLvMcp } from '../mcp';

const cleanups: (() => void)[] = [];
afterEach(() => {
    cleanups.splice(0).reverse().forEach(fn => fn());
    document.body.replaceChildren();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});
it('reprojects actual Boolean fill rules into scene, export, and MCP after cache invalidation', async () => {
    vi.stubGlobal('CSS', { escape: (id: string) => id });
    vi.stubGlobal('FontFace', class {});
    Object.defineProperty(document, 'fonts', { configurable: true, value: Object.assign(new EventTarget(), { ready: Promise.resolve() }) });
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    const doc = createDocument(), page = doc.pagesById[doc.pages[0]];
    const square = (x: number, y: number, size: number) => [
        { command: 'move', x, y }, { command: 'line', x: x + size, y },
        { command: 'line', x: x + size, y: y + size }, { command: 'line', x, y: y + size }, { command: 'close' }
    ];
    insertShape(page, createShape('boolean', { id: 'bool', childIds: [], booleanOperation: 'union', fillRule: 'evenodd', fills: [{ color: '#000' }] }));
    insertShape(page, createShape('path', { id: 'compound', fillRule: 'nonzero', content: [...square(0, 0, 100), ...square(25, 25, 50)] }), 'bool');
    insertShape(page, createShape('rect', { id: 'extra', x: 150, y: 0, width: 20, height: 20 }), 'bool');
    const editor = new Editor(doc), stage = document.createElement('div');
    document.body.append(stage);
    const wasmUrl = resolve('node_modules/canvaskit-wasm/bin/full/canvaskit.wasm');
    const view = createRenderer(editor, stage, { wasmUrl });
    const mcp = installLvMcp(editor, view, { global: false });
    cleanups.push(() => editor.destroy(), () => view.destroy(), () => mcp.dispose());
    const kit = await loadKit(wasmUrl);
    const readAndCheckCenter = async () => {
        const result = await mcp.handleToolCall('qa', 'get_path', { id: 'bool' });
        expect(result.isError, JSON.stringify(result)).not.toBe(true);
        const geometry = result.structuredContent!;
        const path = kit.Path.MakeFromSVGString(shapePath(createShape('path', { content: geometry.segments }))!)!;
        try {
            path.setFillType(geometry.fillRule === 'evenodd' ? kit.FillType.EvenOdd : kit.FillType.Winding);
            expect(path.contains(50, 50)).toBe(true);
        }
        finally { path.delete(); }
        return geometry;
    };
    const before = await readAndCheckCenter();
    expect(before.fillRule).toBe('evenodd');
    expect(view.projectedShape('bool').fillRule).toBe('evenodd');
    editor.transact('Hide disjoint operand', draft => { draft.pagesById[editor.pageId].objects.extra.hidden = true; });
    const after = await readAndCheckCenter();
    expect(after.fillRule).toBe('nonzero');
    expect(after.revision).toBeGreaterThan(before.revision);
    expect(view.projectedShape('bool').fillRule).toBe('nonzero');
    expect(view.sceneSvg(['bool'])).toContain('fill-rule="nonzero"');
    expect(view.element('bool')!.querySelector('path[fill="#000"]')!.getAttribute('fill-rule')).toBe('nonzero');
});
