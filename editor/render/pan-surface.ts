import type { Rect, Viewport } from '../contracts';

const contains = (outer: Rect, inner: Rect) => outer.x <= inner.x && outer.y <= inner.y &&
    outer.x + outer.width >= inner.x + inner.width && outer.y + outer.height >= inner.y + inner.height;

export interface SurfaceViewport {
    bounds: Rect;
    width: number;
    height: number;
    x: number;
    y: number;
    translated: boolean;
}

/** Keep the SVG coordinate system fixed during pan. Only its bounded screen
 * surface moves; geometry, hit testing and exported world coordinates do not. */
export class PanSurface {
    private anchor?: { bounds: Rect; width: number; height: number; viewportWidth: number; viewportHeight: number; zoom: number };
    reanchors = 0;
    translated = false;
    update(viewport: Viewport, enabled: boolean): SurfaceViewport {
        const { zoom, vport, vbox } = viewport;
        const bounds = { x: vbox.x, y: vbox.y, width: vport.width / zoom, height: vport.height / zoom };
        this.translated = enabled && [zoom, bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite) &&
            zoom > 0 && bounds.width > 0 && bounds.height > 0;
        if (!this.translated) {
            this.anchor = undefined;
            return { bounds, width: vport.width, height: vport.height, x: 0, y: 0, translated: false };
        }
        if (!this.anchor || this.anchor.zoom !== zoom || this.anchor.viewportWidth !== vport.width ||
            this.anchor.viewportHeight !== vport.height || !contains(this.anchor.bounds, bounds)) {
            // Whole CSS-pixel padding avoids introducing a half-pixel raster
            // offset just because a viewport has an odd width or height.
            const padX = Math.ceil(vport.width / 2), padY = Math.ceil(vport.height / 2);
            const width = vport.width + padX * 2, height = vport.height + padY * 2;
            this.anchor = { bounds: { x: bounds.x - padX / zoom, y: bounds.y - padY / zoom, width: width / zoom, height: height / zoom },
                width, height, viewportWidth: vport.width, viewportHeight: vport.height, zoom };
            this.reanchors++;
        }
        const anchor = this.anchor;
        return { bounds: anchor.bounds, width: anchor.width, height: anchor.height,
            x: (anchor.bounds.x - bounds.x) * zoom, y: (anchor.bounds.y - bounds.y) * zoom, translated: true };
    }
    clear() { this.anchor = undefined; this.translated = false; }
}
