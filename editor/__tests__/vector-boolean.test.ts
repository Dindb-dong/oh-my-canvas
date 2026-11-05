import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { combinePaths, loadKit } from '../render/vector';
import { shapePath } from '../render/scene';
import { createShape } from '../document';
import { importSvg } from '../formats';

const wasmUrl = resolve('node_modules/canvaskit-wasm/bin/full/canvaskit.wasm');
describe('CanvasKit Boolean flattening', () => {
    it('flattens an actual subtract result into closed cubic contours with its hole intact', async () => {
        const outer = createShape('ellipse', { id: 'outer', x: 0, y: 0, width: 100, height: 100 });
        const inner = createShape('ellipse', { id: 'inner', x: 25, y: 25, width: 50, height: 50 });
        const cut = await combinePaths([outer, inner], 'subtract', { wasmUrl });
        const source = createShape('boolean', { id: 'ring', ...cut.bounds, content: cut.segments, fillRule: cut.fillRule, childIds: ['outer', 'inner'], booleanOperation: 'subtract' });
        const flat = await combinePaths([source], 'flatten', { wasmUrl, objects: { outer, inner } });
        expect(flat.segments.filter(s => s.command === 'move')).toHaveLength(2);
        expect(flat.segments.filter(s => s.command === 'close')).toHaveLength(2);
        expect(flat.segments.some(s => s.command === 'curve')).toBe(true);
        expect(flat.bounds).toEqual({ x: 0, y: 0, width: 100, height: 100 });
        const kit = await loadKit(wasmUrl), path = kit.Path.MakeFromSVGString(shapePath(createShape('path', { content: flat.segments }))!)!;
        try {
            path.setFillType(flat.fillRule === 'evenodd' ? kit.FillType.EvenOdd : kit.FillType.Winding);
            expect(path.contains(50, 50)).toBe(false);
            expect(path.contains(10, 50)).toBe(true);
            expect(path.contains(110, 50)).toBe(false);
        }
        finally { path.delete(); }
    });
    it('retains evenodd holes and disjoint contours from a single imported native path', async () => {
        const parsed = importSvg('<svg width="120" height="100"><path fill-rule="evenodd" d="M0 0H100V100H0ZM25 25H75V75H25ZM110 0H120V10H110Z"/></svg>');
        const source = parsed.shapes.find(s => s.type === 'path')!;
        const before = structuredClone(source), flat = await combinePaths([source], 'flatten', { wasmUrl });
        expect(source).toEqual(before);
        expect(flat.segments.filter(s => s.command === 'move')).toHaveLength(3);
        const kit = await loadKit(wasmUrl), path = kit.Path.MakeFromSVGString(shapePath(createShape('path', { content: flat.segments }))!)!;
        try {
            path.setFillType(flat.fillRule === 'evenodd' ? kit.FillType.EvenOdd : kit.FillType.Winding);
            expect(path.contains(50, 50)).toBe(false);
            expect(path.contains(10, 50)).toBe(true);
            expect(path.contains(115, 5)).toBe(true);
        }
        finally { path.delete(); }
    });
});
