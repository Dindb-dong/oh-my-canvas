import { describe, it, expect } from 'vitest';
import { validateShapeProperties, validateTextStyleProperties, validateJson } from '../mcp/properties';

describe('MCP structured property boundaries', () => {
    it('accepts inspector-native paint, layout, text, guide and export representations', () => {
        expect(() => validateShapeProperties({
            fills: [{ gradient: { type: 'linear', x1: 0, y1: 0, x2: 1, y2: 1, aspect: 1, stops: [{ offset: 0, color: '#f00' }, { offset: 1, color: '#00f' }] } }],
            strokes: [{ color: '#000', width: 2, dash: [1, 3], startCap: 'arrow', endCap: 'circle' }],
            layout: { type: 'grid', columns: [{ type: 'fixed', size: 100 }, '1fr', 'auto'], rows: 2, gap: { row: 10, column: 5 }, padding: [10, 20] },
            gridCell: { row: 1, column: 1, rowSpan: 2, columnSpan: 1, hAlign: 'start' },
            shadows: [{ style: 'drop', offsetX: -2, offsetY: 4, blur: 8, spread: 0, color: '#000', opacity: .2 }],
            guides: [{ axis: 'x', position: 20 }], layoutGrids: [{ pattern: 'columns', count: 4, size: 10, gutter: 8, opacity: .1 }],
            radii: [2, 4, 6, 8], autoResize: 'widthAndHeight', truncate: true, maxLines: 2, leadingTrim: 'capHeight',
            exportSettings: [{ format: 'png', constraint: { type: 'scale', value: 2 }, suffix: '@2x' }],
            content: { type: 'richText', children: [{ textAlign: 'left', lineHeight: 24, children: [{ text: 'Hello', fontFamily: 'IBM Plex Sans', fontSize: 18, fills: [{ color: '#123456' }] }] }] }
        })).not.toThrow();
        expect(() => validateShapeProperties({ layout: null, image: { src: 'https://example.com/image.png', width: 10, height: 20, crop: { x: 0, y: 0, width: 1, height: 1 } } })).not.toThrow();
    });

    it.each([
        { fills: [null] },
        { fills: [{ gradient: { stops: [null] } }] },
        { fills: [{ gradient: { stops: [{ offset: 'start', color: '#fff' }] } }] },
        { strokes: [{ dash: [1, null] }] },
        { shadows: [null] },
        { shadows: [{ blur: 'wide' }] },
        { layout: { type: 'grid', columns: [null] } },
        { layout: { type: 'grid', columns: 1000000000 } },
        { layout: { type: 'grid', columns: { children: [] } } },
        { layout: { type: 'flex', padding: { top: 'large' } } },
        { layout: { gap: [1, 2] } },
        { gridCell: { rowSpan: 0 } },
        { guides: [{ axis: 'z', position: 0 }] },
        { guides: [{ axis: 'x', position: 'middle' }] },
        { layoutGrids: [null] },
        { content: [{ command: 'curve', x: 1, y: 2 }] },
        { content: [{ command: 'move', x: 'left', y: 1 }] },
        { content: { children: [null] } },
        { content: { children: [{ children: null }] } },
        { content: { children: [{ children: [{ text: 42 }] }] } },
        { content: { children: [{ lineHeight: 'large', children: [{ text: 'Hello' }] }] } },
        { width: '100' }, { hidden: 'false' }, { radius: -1 }, { opacity: 2 }, { id: 'spoofed' },
    ])('rejects malformed native fields before mutation %#', value => {
        expect(() => validateShapeProperties(value)).toThrow();
    });

    it('validates complete path segments and rich text style types', () => {
        expect(() => validateShapeProperties({ content: [{ command: 'move', x: 0, y: 0 }, { command: 'curve', x: 20, y: 20, x1: 3, y1: 4, x2: 9, y2: 12 }, { command: 'close' }] })).not.toThrow();
        expect(() => validateTextStyleProperties({ fontSize: 24, fills: [{ color: '#f00' }], listLevel: 1, lineHeight: 28 })).not.toThrow();
        expect(() => validateTextStyleProperties({ fills: [null] })).toThrow();
        expect(() => validateTextStyleProperties({ fontSize: 'large' })).toThrow();
        expect(() => validateTextStyleProperties({ text: 'Unexpected replacement' })).toThrow(/Unsupported/);
    });

    it('checks nested URL sources and JSON primitives without evaluating them', () => {
        for (const src of ['file:///private/data', 'javascript:alert(1)', 'j a v a s c r i p t:alert(1)', 'data:text/html;base64,AAAA'])
            expect(() => validateShapeProperties({ fills: [{ image: { src } }] })).toThrow(/Unsafe/);
        expect(() => validateShapeProperties({ image: { src: { path: '/private/data' } } })).toThrow(/Unsafe/);
        expect(() => validateJson(JSON.parse('{"__proto__":{"polluted":true}}'))).toThrow(/Unsafe/);
        expect(() => validateJson({ arbitrary: new Date() })).toThrow(/JSON records/);
        expect(() => validateJson({ arbitrary: () => 1 })).toThrow(/JSON values/);
        expect(() => validateJson({ arbitrary: 1n })).toThrow(/JSON values/);
        expect(() => validateShapeProperties({ fills: [{ image: { src: 'data:image/png;base64,AAAA' } }] })).not.toThrow();
        expect(() => validateJson({ assetDefinitions: { font: { kind: 'font', family: 'Test', src: 'data:font/woff2;base64,AAAA' } } })).not.toThrow();
        expect(() => validateJson({ assetDefinitions: { font: { kind: 'font', family: 'Test', src: 'file:///private/font.woff2' } } })).toThrow(/Unsafe/);
    });
});
