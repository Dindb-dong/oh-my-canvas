import { expect, it } from 'vitest';
import { PanSurface } from '../render/pan-surface';
import type { Viewport } from '../contracts';

const viewport = (x = -100, y = 5800, zoom = 1, width = 980, height = 761): Viewport => ({ zoom, vport: { width, height }, vbox: { x, y, width: width / zoom, height: height / zoom } });
it('keeps SVG bounds fixed throughout a pan and maps world coordinates to the current camera', () => {
    const surface = new PanSurface(), first = surface.update(viewport(), true);
    expect(first.x).toBe(-490); expect(first.y).toBe(-381);
    expect(first.width).toBe(1960); expect(first.height).toBe(1523);
    for (const [x, y] of [[-100, 5800], [150, 6000], [-250, 5600]]) {
        const current = viewport(x, y), result = surface.update(current, true);
        expect(result.bounds).toBe(first.bounds);
        for (const point of [{ x: 1032, y: 15131 }, { x: -50, y: 5900 }]) {
            const rendered = { x: (point.x - result.bounds.x) * current.zoom + result.x, y: (point.y - result.bounds.y) * current.zoom + result.y };
            expect(rendered.x).toBeCloseTo((point.x - x) * current.zoom, 10);
            expect(rendered.y).toBeCloseTo((point.y - y) * current.zoom, 10);
        }
    }
    expect(surface.reanchors).toBe(1);
});
it('reanchors on overscan exit, zoom, resize, and explicit reset', () => {
    const surface = new PanSurface(), first = surface.update(viewport(), true);
    const outside = surface.update(viewport(500, 5800), true); expect(outside.bounds).not.toBe(first.bounds);
    const zoomed = surface.update(viewport(500, 5800, 2), true); expect(zoomed.width).toBe(outside.width); expect(zoomed.bounds.width).toBe(outside.bounds.width / 2);
    const resized = surface.update(viewport(500, 5800, 2, 600, 400), true); expect(resized.width).toBe(1200); expect(resized.height).toBe(800);
    surface.clear(); expect(surface.update(viewport(500, 5800, 2, 600, 400), true).bounds).not.toBe(resized.bounds);
    expect(surface.reanchors).toBe(5);
});
it('uses direct viewport bounds for backdrop/small scenes and rejects invalid surface dimensions', () => {
    const surface = new PanSurface(); surface.update(viewport(), true);
    const direct = surface.update(viewport(30, 40), false);
    expect(direct).toMatchObject({ bounds: { x: 30, y: 40, width: 980, height: 761 }, x: 0, y: 0, translated: false });
    expect(surface.update(viewport(30, 40, 1, 0, 400), true).translated).toBe(false);
    expect(surface.update(viewport(), true).translated).toBe(true);
});
