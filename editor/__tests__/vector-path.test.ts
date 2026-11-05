import { describe, expect, it } from 'vitest';
import { createShape } from '../document';
import { hitTest } from '../geometry';
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
