/** Fresh independent algebraic and vector expectations; authored after the implementation barrier. */
import { describe, it, expect } from 'vitest';
import { createShape } from '../document';
import { identity, rotationMatrix, multiply, inverse, transformPoint, boxGeometry, screenToWorld, worldToScreen, zoomAt, fitViewport, panViewport, moveShape, resizeShape, setShapeOrientation, transformShapes, reconcileShapeGeometry, pathBounds, hitTest, applyConstraints, snapPoint, orientedPathBox } from '../geometry';
import { insertPathNode, movePathNodes, deletePathNodes, setPathHandle, closePath, reversePath, joinPathEnds, regeneratePrimitive } from '../commands/path';
const near = (actual: {
    x: number;
    y: number;
}, expected: {
    x: number;
    y: number;
}) => {
    expect(actual.x).toBeCloseTo(expected.x, 8);
    expect(actual.y).toBeCloseTo(expected.y, 8);
};
const curve = () => createShape('path', { x: 0, y: 0, width: 100, height: 75, content: [{ command: 'move', x: 0, y: 0 }, { command: 'curve', x1: 0, y1: 100, x2: 100, y2: 100, x: 100, y: 0 }] });
const cubic = (a: any, b: any, t: number) => ({ x: (1 - t) ** 3 * a.x + 3 * (1 - t) ** 2 * t * b.x1 + 3 * (1 - t) * t * t * b.x2 + t ** 3 * b.x, y: (1 - t) ** 3 * a.y + 3 * (1 - t) ** 2 * t * b.y1 + 3 * (1 - t) * t * t * b.y2 + t ** 3 * b.y });
describe('GEO-01 affine and viewport algebra', () => {
    it.each([0, 15, 90, 123, -45, 270])('round-trips matrix and viewport at angle %s', angle => {
        const m = { ...rotationMatrix(angle, true, false), e: 27, f: -19 }, p = { x: -13.25, y: 48.75 };
        near(transformPoint(transformPoint(p, m), inverse(m)), p);
        const unit = multiply(m, inverse(m));
        for (const key of ['a', 'b', 'c', 'd', 'e', 'f'] as const)
            expect(unit[key]).toBeCloseTo(identity()[key], 10);
        const v = { zoom: 2.5, vport: { width: 800, height: 600 }, vbox: { x: -50, y: 20, width: 320, height: 240 } };
        near(screenToWorld(worldToScreen(p, v), v), p);
        near(screenToWorld(v, worldToScreen(v, p)), p);
    });
    it('rotates selection corners about box center, with a true inverse', () => {
        const g = boxGeometry({ x: 10, y: 20, width: 40, height: 20, rotation: 90 });
        near(g.corners[0], { x: 40, y: 10 });
        near(g.corners[2], { x: 20, y: 50 });
        expect(g.transform.e).toBe(0);
        expect(g.transform.f).toBe(0);
    });
    it('keeps a zoom anchor fixed and bounds zoom to the public limits', () => {
        const v = { zoom: 1, vport: { width: 800, height: 600 }, vbox: { x: 30, y: -10, width: 800, height: 600 } }, anchor = { x: 125, y: 370 }, point = screenToWorld(anchor, v);
        near(screenToWorld(anchor, zoomAt(v, 3.7, anchor)), point);
        expect(zoomAt(v, 1000).zoom).toBe(200);
        expect(zoomAt(v, 0).zoom).toBe(.01);
        const p = panViewport(v, 40, -20);
        expect(p.vbox.x).toBe(70);
        expect(p.vbox.y).toBe(-30);
    });
    it('fits a mathematical box with requested padding', () => {
        const v = { zoom: 1, vport: { width: 800, height: 600 }, vbox: { x: 0, y: 0, width: 800, height: 600 } }, fit = fitViewport(v, { x: 100, y: 200, width: 200, height: 100 }, 50);
        expect(fit.zoom).toBe(3.5);
        near(worldToScreen({ x: 200, y: 250 }, fit), { x: 400, y: 300 });
    });
    it('maps already-oriented world path coordinates exactly once on rotate/resize/move', () => {
        const s = createShape('line', { x: 0, y: 0, width: 100, height: 100 });
        setShapeOrientation(s, 90);
        near(s.content[0], { x: 100, y: 0 });
        near(s.content[1], { x: 0, y: 100 });
        resizeShape(s, { x: 10, y: 20, width: 200, height: 100 });
        near(s.content[0], { x: 160, y: -30 });
        near(s.content[1], { x: 60, y: 170 });
        moveShape(s, 5, -10);
        near(s.content[0], { x: 165, y: -40 });
    });
    it('transforms a path and its world box through a composite affine mapping', () => {
        const s = createShape('line', { x: 0, y: 0, width: 20, height: 10 });
        transformShapes([s], { a: 0, b: 2, c: -2, d: 0, e: 100, f: 50 });
        near(s.content[0], { x: 100, y: 50 });
        near(s.content[1], { x: 80, y: 90 });
        expect(s.width).toBeCloseTo(40);
        expect(s.height).toBeCloseTo(20);
        expect(s.rotation).toBeCloseTo(90);
    });
    it('reconciles scalar edits without applying a second transform to explicitly edited content', () => {
        const before = createShape('line', { x: 0, y: 0, width: 10, height: 10 }), after = structuredClone(before);
        after.x = 20;
        after.rotation = 90;
        reconcileShapeGeometry(before, after);
        near(after.content[0], { x: 30, y: 0 });
        const explicit = structuredClone(after);
        explicit.content[0].x = 99;
        explicit.x = 25;
        reconcileShapeGeometry(after, explicit);
        expect(explicit.content[0].x).toBe(99);
    });
    it('applies left/right/both/center/scale constraint arithmetic', () => {
        for (const [mode, x, w] of [['left', 10, 20], ['right', 110, 20], ['both', 10, 120], ['center', 60, 20], ['scale', 20, 40]] as const) {
            const s = createShape('rect', { x: 10, y: 10, width: 20, height: 20, horizontalConstraint: mode });
            applyConstraints(s, { x: 0, y: 0, width: 100, height: 100 }, { x: 0, y: 0, width: 200, height: 100 });
            expect(s.x).toBe(x);
            expect(s.width).toBe(w);
        }
    });
    it('snaps each axis independently and respects grid fallback', () => {
        expect(snapPoint({ x: 9, y: 19 }, [{ x: 10, y: 100 }, { x: 100, y: 20 }], 3)).toEqual({ x: 10, y: 20 });
        expect(snapPoint({ x: 9, y: 19 }, [], 0, 8)).toEqual({ x: 8, y: 16 });
    });
});
describe('VEC-02 analytic paths and editable nodes', () => {
    it('finds the cubic derivative maximum rather than the control polygon', () => {
        expect(pathBounds(curve().content)).toEqual({ x: 0, y: 0, width: 100, height: 75 });
        const s = curve();
        setShapeOrientation(s, 90);
        const b = orientedPathBox(s.content, s.transform);
        expect(b.width).toBeCloseTo(100);
        expect(b.height).toBeCloseTo(75);
    });
    it('splits a cubic into exactly equivalent halves', () => {
        const s = curve(), original = structuredClone(s.content);
        expect(insertPathNode(s, 1, .4)).toBe(1);
        near(s.content[1], cubic(original[0], original[1], .4));
        for (const t of [.1, .25, .75, .99]) {
            const actual = t <= .4 ? cubic(s.content[0], s.content[1], t / .4) : cubic(s.content[1], s.content[2], (t - .4) / .6);
            near(actual, cubic(original[0], original[1], t));
        }
    });
    it('moves endpoints together with attached incoming/outgoing handles', () => {
        const s = curve();
        insertPathNode(s, 1, .5);
        const old = structuredClone(s.content);
        movePathNodes(s, [1], 5, -3);
        near(s.content[1], { x: old[1].x + 5, y: old[1].y - 3 });
        expect(s.content[1].x2).toBe(old[1].x2 + 5);
        expect(s.content[2].x1).toBe(old[2].x1 + 5);
    });
    it('mirrors handle angle and length while keeping cubic fields canonical', () => {
        const s = curve();
        insertPathNode(s, 1, .5);
        const p = s.content[1];
        setPathHandle(s, 1, 'out', { x: p.x + 20, y: p.y + 10 }, 'symmetric');
        expect(s.content[1].x2).toBeCloseTo(p.x - 20);
        expect(s.content[1].y2).toBeCloseTo(p.y - 10);
        expect(s.content[2].x1).toBeCloseTo(p.x + 20);
        expect(s.content[2].y1).toBeCloseTo(p.y + 10);
        expect(s.content[1].command).toBe('curve');
    });
    it('preserves an opposite handle length in aligned mode', () => {
        const s = curve();
        insertPathNode(s, 1, .5);
        const p = s.content[1], length = Math.hypot(p.x2 - p.x, p.y2 - p.y);
        setPathHandle(s, 1, 'out', { x: p.x + 40, y: p.y }, 'aligned');
        expect(Math.hypot(p.x2 - p.x, p.y2 - p.y)).toBeCloseTo(length);
        expect(p.y2).toBeCloseTo(p.y);
    });
    it('deletes nodes, reopens/closes, and reverses cubic control direction', () => {
        const s = curve(), reversed = reversePath(s.content);
        near({ x: reversed[0].x, y: reversed[0].y }, { x: 100, y: 0 });
        expect(reversed[1].x1).toBe(100);
        expect(reversed[1].x2).toBe(0);
        closePath(s);
        expect(s.content.at(-1).command).toBe('close');
        closePath(s, false);
        expect(s.content.at(-1).command).toBe('curve');
        deletePathNodes(s, [0]);
        expect(s.content[0].command).toBe('move');
    });
    it('joins two open paths and merges coincident endpoints without duplicate nodes', () => {
        const a = createShape('path', { content: [{ command: 'move', x: 0, y: 0 }, { command: 'line', x: 10, y: 0 }] }), b = createShape('path', { content: [{ command: 'move', x: 10, y: 0 }, { command: 'line', x: 20, y: 0 }] });
        joinPathEnds(a, b);
        expect(a.content).toHaveLength(3);
        expect(a.content.map((p: any) => p.x)).toEqual([0, 10, 20]);
    });
    it('regenerates editable star count and ratio while preserving orientation', () => {
        const s = createShape('star', { x: 0, y: 0, width: 100, height: 100, rotation: 90 });
        regeneratePrimitive(s, { count: 7, ratio: .25 });
        expect(s.content).toHaveLength(15);
        expect(s.primitive).toEqual({ kind: 'star', count: 7, ratio: .25 });
        near(s.content[0], { x: 100, y: 50 });
    });
    it('hits true cubic strokes and honors evenodd holes', () => {
        const s = curve();
        s.fills = [];
        s.strokes = [{ color: '#000', width: 2 }];
        expect(hitTest(s, { x: 50, y: 75 }, .1)).toBe(true);
        expect(hitTest(s, { x: 50, y: 0 }, .1)).toBe(false);
        const hole = createShape('path', { fills: [{ color: '#000' }], fillRule: 'evenodd', content: [{ command: 'move', x: 0, y: 0 }, { command: 'line', x: 100, y: 0 }, { command: 'line', x: 100, y: 100 }, { command: 'line', x: 0, y: 100 }, { command: 'close' }, { command: 'move', x: 25, y: 25 }, { command: 'line', x: 75, y: 25 }, { command: 'line', x: 75, y: 75 }, { command: 'line', x: 25, y: 75 }, { command: 'close' }] });
        expect(hitTest(hole, { x: 10, y: 10 })).toBe(true);
        expect(hitTest(hole, { x: 50, y: 50 })).toBe(false);
    });
});
it('supports serialized leftAndRight/topAndBottom constraint names',()=>{const s=createShape('rect',{x:10,y:20,width:30,height:40,horizontalConstraint:'leftAndRight',verticalConstraint:'topAndBottom'});applyConstraints(s,{x:0,y:0,width:100,height:100},{x:0,y:0,width:150,height:130});expect([s.x,s.y,s.width,s.height]).toEqual([10,20,80,70]);});
