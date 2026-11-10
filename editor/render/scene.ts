import type { Data, Shape, Rect, Point } from '../contracts';
import { unsafeMarkupElement, safeUrl, cssDeclarations } from '../formats/markup';
import { resourceScope, type SceneNodeCache } from './retained';
export const escape = (s: any) => String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;'
}[c]!));
export const num = (v: any, d = 0) => Number.isFinite(Number(v)) ? Number(v) : d;
export const color = (c: any): string => {
    if (typeof c === 'string')
        return c;
    if (!c)
        return '#000000';
    if (c.color !== undefined)
        return color(c.color);
    if (c.hex)
        return c.hex;
    const unit = Math.max(num(c.r), num(c.g), num(c.b)) <= 1 ? 255 : 1;
    return `rgba(${num(c.r) * unit},${num(c.g) * unit},${num(c.b) * unit},${num(c.a, 1)})`;
};
export function shapeMatrix(s: Shape) {
    if (s.type === 'path' || s.type === 'boolean')
        return 'matrix(1 0 0 1 0 0)';
    const m = s.transform ?? { a: 1, b: 0, c: 0, d: 1 };
    const cx = s.x + s.width / 2, cy = s.y + s.height / 2;
    return `matrix(${m.a} ${m.b} ${m.c} ${m.d} ${cx - m.a * cx - m.c * cy} ${cy - m.b * cx - m.d * cy})`;
}
export function shapePath(s: Shape): string {
    const x = s.x, y = s.y, w = s.width, h = s.height;
    if (s.type === 'ellipse')
        return `M${x + w / 2},${y} A${w / 2},${h / 2} 0 1 1 ${x + w / 2},${y + h} A${w / 2},${h / 2} 0 1 1 ${x + w / 2},${y}Z`;
    if (s.type === 'path' || s.type === 'boolean') {
        const canonical = Array.isArray(s.content);
        if (!canonical && (s.d || s.pathData))
            return String(s.d ?? s.pathData);
        if (!canonical && s.path?.d)
            return s.path.d;
        const segments = canonical ? s.content : s.segments ?? s.path?.segments ?? s.content?.segments ?? [];
        if (canonical || segments.length)
            return segments.map((seg: Data) => {
                const p = seg.point ?? seg.to ?? seg;
                const type = String(seg.type ?? seg.command ?? 'line').toLowerCase();
                const c1 = seg.control1 ?? seg.c1 ?? seg.handle1;
                const c2 = seg.control2 ?? seg.c2 ?? seg.handle2;
                if (type === 'close' || type === 'z')
                    return 'Z';
                if (type === 'move' || type === 'm')
                    return `M${num(p.x)} ${num(p.y)}`;
                if (type === 'curve' || type === 'cubic' || type === 'c')
                    return `C${num(c1?.x ?? seg.x1)} ${num(c1?.y ?? seg.y1)} ${num(c2?.x ?? seg.x2)} ${num(c2?.y ?? seg.y2)} ${num(p.x)} ${num(p.y)}`;
                if (type === 'quadratic' || type === 'q')
                    return `Q${num(c1?.x ?? seg.x1)} ${num(c1?.y ?? seg.y1)} ${num(p.x)} ${num(p.y)}`;
                return `L${num(p.x)} ${num(p.y)}`;
            }).join(' ');
        const primitive = s.primitive ?? s.path?.primitive;
        if (primitive) {
            const count = Math.max(3, num(primitive.count ?? primitive.sides ?? primitive.points, (primitive.kind ?? primitive.type) === 'star' ? 5 : 3));
            const star = (primitive.kind ?? primitive.type) === 'star';
            const n = star ? count * 2 : count;
            return Array.from({ length: n }, (_, i) => {
                const a = -Math.PI / 2 + i * Math.PI * 2 / n, r = star && i % 2 ? num(primitive.ratio ?? primitive.innerRadius, .4) : 1;
                return `${i ? 'L' : 'M'}${x + w / 2 + Math.cos(a) * w / 2 * r} ${y + h / 2 + Math.sin(a) * h / 2 * r}`;
            }).join(' ') + 'Z';
        }
        if (Array.isArray(s.content) || s.segments)
            return '';
        return `M${x} ${y}L${x + w} ${y + h}`;
    }
    const r = s.radii ?? s.cornerRadius ?? s.radius ?? [s.radiusTopLeft ?? 0, s.radiusTopRight ?? 0, s.radiusBottomRight ?? 0, s.radiusBottomLeft ?? 0];
    const values = typeof r === 'number' ? [r, r, r, r] : Array.isArray(r) ? r : [r.topLeft ?? 0, r.topRight ?? 0, r.bottomRight ?? 0, r.bottomLeft ?? 0];
    const [a, b, c, d] = values.map((v: any) => Math.min(w / 2, h / 2, Math.max(0, num(v))));
    const smoothing = Math.min(1, num(s.cornerSmoothing ?? s.smoothing));
    const k = .55228475 + (1 - .55228475) * smoothing * .25;
    return `M${x + a} ${y}H${x + w - b}C${x + w - b + k * b} ${y} ${x + w} ${y + b - k * b} ${x + w} ${y + b}V${y + h - c}C${x + w} ${y + h - c + k * c} ${x + w - c + k * c} ${y + h} ${x + w - c} ${y + h}H${x + d}C${x + d - k * d} ${y + h} ${x} ${y + h - d + k * d} ${x} ${y + h - d}V${y + a}C${x} ${y + a - k * a} ${x + a - k * a} ${y} ${x + a} ${y}Z`;
}
export interface TextFragment {
    text: string;
    x: number;
    y: number;
    width: number;
    height: number;
    baseline: number;
    style: Record<string, string>;
    paragraph: number;
}
export interface SceneOptions {
    bounds?: Rect;
    idPrefix?: string;
    omitFill?: boolean;
    exporting?: boolean;
    outlines?: boolean;
    outlineWidth?: number;
    typography?: Data;
    textFragments?: Map<string, TextFragment[]>;
    /** Screen-only retained serialization; omitted by every export path. */
    nodeCache?: SceneNodeCache;
    stableIds?: boolean;
}
const blends = new Set(['normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten', 'color-dodge', 'color-burn', 'hard-light', 'soft-light', 'difference', 'exclusion', 'hue', 'saturation', 'color', 'luminosity']);
const blend = (v: any) => {
    const s = String(v ?? 'normal').replace(/_/g, '-').replace(/[A-Z]/g, m => '-' + m.toLowerCase()).replace(/^-/, '');
    return blends.has(s) ? s : 'normal';
};
export function textHTML(s: Shape, options: Data = {}): string {
    const content = s.content ?? {};
    const paragraphs = typeof content === 'string' ? [{ children: [{ text: content }] }] : content.children ?? s.paragraphs ?? [{ children: [{ text: s.text ?? '' }] }];
    const rich = paragraphs.map((p: Data, pi: number) => {
        const align = p.textAlign ?? s.textAlign ?? 'left', line = p.lineHeight ?? p.children?.[0]?.lineHeight ?? s.lineHeight ?? 1.2;
        const lh = typeof line === 'object' ? (line.unit === 'percent' ? `${line.value}%` : `${line.value}px`) : num(line) > 4 ? `${num(line)}px` : String(line);
        const list = p.listType && p.listType !== 'none';
        const marker = list ? (p.listType === 'ordered' ? `${pi + 1}.` : '•') : '';
        return `<div data-paragraph="${pi}" style="position:relative;font-size:${num(p.children?.[0]?.fontSize ?? s.fontSize, 16)}px;margin:0;padding:0;white-space:pre-wrap;overflow-wrap:${s.lineBreak === 'anywhere' ? 'anywhere' : 'break-word'};text-align:${escape(align)};line-height:${lh};margin-bottom:${num(p.paragraphSpacing)}px;text-indent:${num(p.paragraphIndent)}px;padding-left:${num(p.listLevel) * (num(s.fontSize, 16) * 1.5) + (list ? 24 : 0)}px;${s.leadingTrim ? 'text-box-trim:trim-both;text-box-edge:cap alphabetic;' : ''}">${marker ? `<span data-run="true" style="position:absolute;left:${num(p.listLevel) * 24}px">${marker}</span>` : ''}${(p.children ?? [{ text: p.text ?? '' }]).map((r: Data) => {
            const family = r.fontFamily ?? s.fontFamily ?? options.defaultFamily ?? 'sans-serif';
            const size = num(r.fontSize ?? s.fontSize, 16);
            const fills = r.fills ?? s.fills ?? [];
            const fill = fills.find((p: Data) => p.visible !== false && !p.hidden);
            const c = fill ? color(fill.color ?? fill) : r.color ?? s.color ?? '#111827';
            const deco = r.textDecoration ?? 'none';
            return `<span data-run="true" data-paints="${escape(JSON.stringify(fills))}" style="font-family:${escape(family)},${escape((options.fallbacks ?? ['sans-serif']).join(','))};font-size:${size}px;font-weight:${escape(r.fontWeight ?? s.fontWeight ?? 400)};font-style:${escape(r.fontStyle ?? s.fontStyle ?? 'normal')};font-variation-settings:${escape(r.fontVariationSettings ?? 'normal')};letter-spacing:${num(r.letterSpacing ?? s.letterSpacing)}px;color:${escape(c)};font-variant-caps:${(r.textTransform ?? s.textTransform) === 'smallCaps' ? 'small-caps' : 'normal'};text-transform:${escape((r.textTransform ?? s.textTransform) === 'smallCaps' ? 'none' : r.textTransform ?? s.textTransform ?? 'none')};text-decoration:${escape(deco)};text-decoration-style:${escape(r.textDecorationStyle ?? 'solid')};text-decoration-thickness:${typeof r.textDecorationThickness === 'number' ? r.textDecorationThickness + 'px' : escape(r.textDecorationThickness ?? 'auto')};background:${escape(r.highlight ? `color-mix(in srgb, ${color(r.highlight)} ${num(r.highlight.opacity, 1) * 100}%, transparent)` : 'transparent')}">${fill && (fill.gradient || fill.image || fills.length > 1 || num(fill.opacity, 1) !== 1) ? `<span style="color:transparent;background-image:${escape(cssPaintLayers(fills))};background-clip:text;-webkit-background-clip:text;background-size:100% 100%">${escape(r.text ?? '') || '<br/>'}</span>` : escape(r.text ?? '') || '<br/>'}</span>`;
        }).join('')}</div>`;
    }).join('');
    const vertical = content.verticalAlign ?? s.verticalAlign ?? 'top';
    const auto = s.autoResize ?? 'none';
    return `<div xmlns="http://www.w3.org/1999/xhtml" data-text="${escape(s.id)}" style="box-sizing:border-box;width:${auto === 'widthAndHeight' ? 'max-content' : '100%'};${auto === 'widthAndHeight' && Number.isFinite(s.maxWidth) ? `max-width:${Math.max(0, s.maxWidth)}px;` : ''}height:${auto === 'none' ? '100%' : 'auto'};font-size:${num(s.fontSize, 16)}px;font-family:${escape(s.fontFamily ?? options.defaultFamily ?? 'sans-serif')};display:flex;flex-direction:column;justify-content:${vertical === 'middle' || vertical === 'center' ? 'center' : vertical === 'bottom' ? 'flex-end' : 'flex-start'};overflow:${s.truncate ? 'hidden' : 'visible'};background:transparent;"><div data-paragraphs="true" style="${s.truncate || s.maxLines ? `display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:${num(s.maxLines, 1)};overflow:hidden;` : ''}">${rich}</div></div>`;
}
export class SceneWriter {
    defs: string[] = [];
    counter = 0;
    generatedNodes = 0;
    cachedNodes = 0;
    private scope = '';
    constructor(public objects: Record<string, Shape>, public options: SceneOptions = {}) {
    }
    id(prefix: string) {
        return (this.options.idPrefix ?? 'omc') + (this.scope ? '-' + this.scope : '') + '-' + prefix + '-' + (++this.counter);
    }
    paint(p: Data, s: Shape): {
        value: string;
        opacity: number;
    } {
        const type = String(p.type ?? (p.gradient ? p.gradient.type : p.image ? 'image' : 'solid')).toLowerCase();
        const opacity = num(p.opacity, 1);
        if (type === 'solid')
            return { value: color(p.color ?? p), opacity };
        if (type === 'image') {
            const image = p.image ?? p;
            const adjust = p.adjust ?? image.adjust;
            const adjustment = this.imageAdjustment(adjust);
            const href = image.src ?? image.url ?? image.id ?? p.src ?? '';
            const id = this.id('image');
            const mode = p.objectFit ?? p.scaleMode ?? image.scaleMode ?? p.mode ?? 'fill';
            const tile = mode === 'tile';
            const iw = num(image.width, s.width) * num(image.tileScale ?? p.tileScale, 1), ih = num(image.height, s.height) * num(image.tileScale ?? p.tileScale, 1);
            const transform = p.transform ?? p.imageTransform;
            const crop = p.crop ?? image.crop;
            const preserve = image.preserveAspectRatio === false ? 'none' : (mode === 'fit' || mode === 'contain') ? 'xMidYMid meet' : mode === 'crop' || mode === 'fill' || mode === 'cover' ? 'xMidYMid slice' : 'none';
            let x = 0, y = 0, w = tile ? iw : s.width, h = tile ? ih : s.height;
            if (crop) {
                w = s.width / num(crop.width, 1);
                h = s.height / num(crop.height, 1);
                x -= num(crop.x) * w;
                y -= num(crop.y) * h;
            }
            this.defs.push(`<pattern id="${id}" patternUnits="userSpaceOnUse" x="${s.x}" y="${s.y}" width="${tile ? iw : s.width}" height="${tile ? ih : s.height}"${transform ? ` patternTransform="matrix(${[transform.a, transform.b, transform.c, transform.d, transform.e, transform.f].map(v => num(v)).join(' ')})"` : ''}><image${adjustment} href="${escape(href)}" x="${x}" y="${y}" width="${w}" height="${h}" preserveAspectRatio="${preserve}"/></pattern>`);
            return { value: `url(#${id})`, opacity };
        }
        const gradient = p.gradient ?? p;
        const stops = gradient.stops ?? p.stops ?? [{ offset: 0, color: '#000' }, { offset: 1, color: '#fff' }];
        const id = this.id(type);
        const stopString = stops.map((v: Data) => `<stop offset="${num(v.offset ?? v.position)}" stop-color="${escape(color(v.color))}" stop-opacity="${num(v.opacity, 1)}"/>`).join('');
        const start = gradient.start ?? { x: num(gradient.x1, 0), y: num(gradient.y1, .5) }, end = gradient.end ?? { x: num(gradient.x2, 1), y: num(gradient.y2, .5) };
        if (type === 'linear' || type === 'linear-gradient')
            this.defs.push(`<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${s.x + num(start.x) * s.width}" y1="${s.y + num(start.y) * s.height}" x2="${s.x + num(end.x, 1) * s.width}" y2="${s.y + num(end.y, .5) * s.height}">${stopString}</linearGradient>`);
        else if (type === 'radial' || type === 'radial-gradient')
            this.defs.push(`<radialGradient id="${id}" gradientUnits="userSpaceOnUse" cx="${s.x + num(gradient.center?.x ?? start.x, .5) * s.width}" cy="${s.y + num(gradient.center?.y ?? start.y, .5) * s.height}" r="${num(gradient.radius, Math.hypot((end.x - start.x) * s.width, (end.y - start.y) * s.height))}" gradientTransform="translate(${s.x + start.x * s.width} ${s.y + start.y * s.height}) rotate(${Math.atan2((end.y - start.y) * s.height, (end.x - start.x) * s.width) * 180 / Math.PI}) scale(1 ${num(gradient.aspect, 1)}) translate(${-s.x - start.x * s.width} ${-s.y - start.y * s.height})">${stopString}</radialGradient>`);
        else {
            const angular = type === 'angular' || type === 'conic';
            const canvas = document.createElement('canvas');
            canvas.width = 256;
            canvas.height = 256;
            const ctx = canvas.getContext('2d')!;
            if (angular) {
                const g = ctx.createConicGradient((gradient.angle !== undefined ? num(gradient.angle) * Math.PI / 180 : Math.atan2(end.y - start.y, end.x - start.x)), num(start.x, .5) * 256, num(start.y, .5) * 256);
                for (const stop of stops)
                    g.addColorStop(Math.max(0, Math.min(1, num(stop.offset ?? stop.position))), colorWithOpacity(stop.color, num(stop.opacity, 1)));
                ctx.fillStyle = g;
                ctx.fillRect(0, 0, 256, 256);
            }
            else {
                const temp = document.createElement('canvas');
                temp.width = stops.length * 256;
                temp.height = 1;
                const tc = temp.getContext('2d')!;
                const g = tc.createLinearGradient(0, 0, temp.width, 0);
                for (const stop of stops)
                    g.addColorStop(Math.max(0, Math.min(1, num(stop.offset ?? stop.position))), colorWithOpacity(stop.color, num(stop.opacity, 1)));
                tc.fillStyle = g;
                tc.fillRect(0, 0, temp.width, 1);
                const pixels = tc.getImageData(0, 0, temp.width, 1).data, out = ctx.createImageData(256, 256);
                for (let y = 0; y < 256; y++)
                    for (let x = 0; x < 256; x++) {
                        const angle = Math.atan2((end.y - start.y) * s.height, (end.x - start.x) * s.width), radius = Math.max(1e-9, Math.hypot((end.x - start.x) * s.width, (end.y - start.y) * s.height)), dx = (x / 256 - start.x) * s.width, dy = (y / 256 - start.y) * s.height, u = (dx * Math.cos(angle) + dy * Math.sin(angle)) / radius, v = (-dx * Math.sin(angle) + dy * Math.cos(angle)) / (radius * Math.max(.0001, num(gradient.aspect, 1)));
                        const d = Math.min(1, Math.abs(u) + Math.abs(v)), i = Math.floor(d * (temp.width - 1)) * 4, j = (y * 256 + x) * 4;
                        out.data.set(pixels.subarray(i, i + 4), j);
                    }
                ctx.putImageData(out, 0, 0);
            }
            this.defs.push(`<pattern id="${id}" x="${s.x}" y="${s.y}" width="${s.width}" height="${s.height}" patternUnits="userSpaceOnUse"><image href="${canvas.toDataURL()}" x="0" y="0" width="${s.width}" height="${s.height}" preserveAspectRatio="none"/></pattern>`);
        }
        return { value: `url(#${id})`, opacity };
    }
    imageAdjustment(adjust?: Data) {
        if (!adjust)
            return '';
        const id = this.id('imageadjust');
        const exposure = Math.pow(2, num(adjust.exposure)), contrast = 1 + num(adjust.contrast), saturation = Math.max(0, 1 + num(adjust.saturation)), temperature = num(adjust.temperature) * .1, tint = num(adjust.tint) * .1;
        const table = Array.from({ length: 17 }, (_, i) => {
            const v = i / 16;
            const lift = num(adjust.shadows) * (1 - v) * (1 - v) * .25;
            const highlight = num(adjust.highlights) * v * v * .25;
            return Math.max(0, Math.min(1, (v * exposure - .5) * contrast + .5 + lift + highlight));
        }).join(' ');
        this.defs.push(`<filter id="${id}" color-interpolation-filters="sRGB"><feComponentTransfer><feFuncR type="table" tableValues="${table}"/><feFuncG type="table" tableValues="${table}"/><feFuncB type="table" tableValues="${table}"/></feComponentTransfer><feColorMatrix type="saturate" values="${saturation}"/><feColorMatrix type="matrix" values="1 0 0 0 ${temperature + tint / 2} 0 1 0 0 ${-tint} 0 0 1 0 ${-temperature + tint / 2} 0 0 0 1 0"/></filter>`);
        return ` filter="url(#${id})"`;
    }
    effects(s: Shape) {
        const effects = [...(s.effects ?? []), ...(s.shadows ?? []).map((e: Data) => ({ ...e, type: e.style === 'inner' ? 'innerShadow' : 'dropShadow', offset: { x: e.offsetX, y: e.offsetY }, visible: !e.hidden })), ...(!s.blurHidden && s.blur ? [{ type: 'blur', radius: s.blur }] : [])].filter((e: Data) => e.visible !== false && !e.hidden);
        if (!effects.length)
            return '';
        const id = this.id('effects');
        let result = 'SourceGraphic';
        const ops: string[] = [];
        for (const e of effects) {
            const type = String(e.type ?? '').toLowerCase().replace(/[-_]/g, '');
            const next = this.id('result');
            if (type === 'blur' || type === 'layerblur') {
                ops.push(`<feGaussianBlur in="${result}" stdDeviation="${num(e.radius ?? e.blur) / 2}" result="${next}"/>`);
                result = next;
            }
            if (type === 'dropshadow' || type === 'shadow' || type === 'innershadow') {
                const dx = num(e.offset?.x ?? e.x), dy = num(e.offset?.y ?? e.y), blur = num(e.blur ?? e.radius) / 2, spread = num(e.spread);
                const mask = this.id('shadowmask');
                if (spread)
                    ops.push(`<feMorphology in="SourceAlpha" operator="${type === 'innershadow' ? (spread < 0 ? 'dilate' : 'erode') : (spread < 0 ? 'erode' : 'dilate')}" radius="${Math.abs(spread)}" result="${mask}"/>`);
                ops.push(`<feGaussianBlur in="${spread ? mask : 'SourceAlpha'}" stdDeviation="${blur}" result="${mask}b"/><feOffset in="${mask}b" dx="${dx}" dy="${dy}" result="${mask}o"/>`);
                if (type === 'innershadow')
                    ops.push(`<feComposite in="SourceAlpha" in2="${mask}o" operator="out" result="${mask}i"/>`);
                ops.push(`<feFlood flood-color="${escape(color(e.color ?? '#000'))}" flood-opacity="${num(e.opacity, 1)}" result="${mask}c"/><feComposite in="${mask}c" in2="${mask}${type === 'innershadow' ? 'i' : 'o'}" operator="in" result="${mask}f"/><feMerge result="${next}">${type === 'innershadow' ? `<feMergeNode in="${result}"/><feMergeNode in="${mask}f"/>` : `<feMergeNode in="${mask}f"/><feMergeNode in="${result}"/>`}</feMerge>`);
                result = next;
            }
        }
        if (!ops.length)
            return '';
        this.defs.push(`<filter id="${id}" x="-100%" y="-100%" width="300%" height="300%" color-interpolation-filters="sRGB">${ops.join('')}</filter>`);
        return ` filter="url(#${id})"`;
    }
    node(s: Shape, asMask = false, backdrop = ''): string {
        const key = s.id + (asMask ? '\0mask' : '\0shape');
        const cached = this.options.nodeCache?.get(key);
        if (cached) {
            this.cachedNodes++;
            this.defs.push(...cached.defs);
            return cached.source;
        }
        const scope = this.scope, counter = this.counter, start = this.defs.length;
        if (this.options.stableIds) { this.scope = resourceScope(s.id, asMask); this.counter = 0; }
        this.generatedNodes++;
        try {
            const source = this.writeNode(s, asMask, backdrop);
            this.options.nodeCache?.put(key, source, this.defs.slice(start));
            return source;
        } finally {
            if (this.options.stableIds) { this.scope = scope; this.counter = counter; }
        }
    }
    private writeNode(s: Shape, asMask = false, backdrop = ''): string {
        if (s.hidden || s.visible === false)
            return '';
        const path = shapePath(s), transform = shapeMatrix(s);
        const clip = s.clipContent || s.clip;
        let clipping = '', bodyClipping = '';
        if (clip) {
            const worldId = this.id('clip');
            const legacy = typeof s.clip === 'object';
            const clipShape: Shape = legacy ? {
                ...s, type: 'rect', x: s.x + num(s.clip.x), y: s.y + num(s.clip.y), width: num(s.clip.width, s.width), height: num(s.clip.height, s.height), radii: num(s.clip.radius), cornerSmoothing: 0
            } : s;
            const path = shapePath(clipShape), matrix = shapeMatrix({ ...s, type: 'rect' });
            this.defs.push(`<clipPath id="${worldId}" clipPathUnits="userSpaceOnUse"><path d="${escape(path)}" transform="${matrix}"/></clipPath>`);
            clipping = ` clip-path="url(#${worldId})"`;
            bodyClipping = clipping;
            if (legacy && s.type !== 'path' && s.type !== 'boolean') {
                const localId = this.id('localclip');
                this.defs.push(`<clipPath id="${localId}" clipPathUnits="userSpaceOnUse"><path d="${escape(path)}"/></clipPath>`);
                bodyClipping = ` clip-path="url(#${localId})"`;
            }
        }
        const attrs = `data-shape-id="${escape(s.id)}" transform="${transform}" opacity="${num(s.opacity, 1)}" style="mix-blend-mode:${blend(s.blendMode)};isolation:isolate;${(s.effects ?? []).filter((e: Data) => String(e.type).replace(/[-_]/g, '').toLowerCase() === 'backgroundblur' || String(e.type).replace(/[-_]/g, '').toLowerCase() === 'backdropblur').map((e: Data) => `backdrop-filter:blur(${num(e.radius ?? e.blur)}px);`).join('')}"`;
        let body = '';
        if (s.type === 'text') {
            const fragments = this.options.textFragments?.get(s.id);
            if (s.textBackground) {
                const bg = typeof s.textBackground === 'object' ? s.textBackground : { fills: [{ color: s.textBackground }] };
                const padding = num(bg.padding);
                for (const p of bg.fills ?? []) {
                    const paint = this.paint(p, s);
                    body += `<rect x="${s.x - padding}" y="${s.y - padding}" width="${s.width + padding * 2}" height="${s.height + padding * 2}" rx="${num(bg.radius)}" fill="${escape(paint.value)}" fill-opacity="${paint.opacity}"/>`;
                }
            }
            if (fragments) {
                body += fragments.map(f => {
                    const paints: Data[] = f.style.paints ? JSON.parse(f.style.paints).filter((p: Data) => !p.hidden && p.visible !== false) : [];
                    if (!paints.length)
                        paints.push({ color: f.style.color });
                    const background = f.style.backgroundColor && f.style.backgroundColor !== 'rgba(0, 0, 0, 0)' ? `<rect x="${f.x}" y="${f.y}" width="${f.width}" height="${f.height}" fill="${escape(f.style.backgroundColor)}"/>` : '';
                    const textTag = (attributes: string) => `<text data-run="true" x="${f.x}" y="${f.baseline}" font-family="${escape(f.style.fontFamily)}" font-size="${escape(f.style.fontSize)}" font-weight="${escape(f.style.fontWeight)}" font-style="${escape(f.style.fontStyle)}" letter-spacing="${escape(f.style.letterSpacing)}" style="font-variation-settings:${escape(f.style.fontVariationSettings ?? 'normal')};line-height:${escape(f.style.lineHeight ?? 'normal')};color:${escape(f.style.color)}" ${attributes} xml:space="preserve">${escape(f.text)}</text>`;
                    const strokes = this.options.outlines ? '' : (s.strokes ?? []).filter((stroke: Data) => !stroke.hidden && stroke.visible !== false).map((stroke: Data) => {
                        const paint = this.paint(stroke, s), width = num(stroke.width, 1), align = stroke.align ?? 'center';
                        let clip = '', effective = width;
                        if (align === 'inside') {
                            const id = this.id('textstrokeclip');
                            this.defs.push(`<clipPath id="${id}">${textTag('fill="white"')}</clipPath>`);
                            clip = `clip-path="url(#${id})"`;
                            effective *= 2;
                        }
                        else if (align === 'outside') {
                            const id = this.id('textstrokemask');
                            this.defs.push(`<mask id="${id}" maskUnits="userSpaceOnUse" x="${s.x - width * 4}" y="${s.y - width * 4}" width="${s.width + width * 8}" height="${s.height + width * 8}"><rect x="${s.x - width * 4}" y="${s.y - width * 4}" width="${s.width + width * 8}" height="${s.height + width * 8}" fill="white"/>${textTag('fill="black"')}</mask>`);
                            clip = `mask="url(#${id})"`;
                            effective *= 2;
                        }
                        return textTag(`fill="none" stroke="${escape(paint.value)}" stroke-opacity="${paint.opacity}" stroke-width="${effective}" stroke-linejoin="${escape(stroke.join ?? 'miter')}" stroke-linecap="${escape(stroke.cap ?? 'butt')}" stroke-dasharray="${escape((stroke.dashes ?? []).join(' '))}" ${clip}`);
                    }).join('');
                    return background + paints.map(p => {
                        const paint = this.paint(p, s);
                        return `<text data-run="true" x="${f.x}" y="${f.baseline}" font-family="${escape(f.style.fontFamily)}" font-size="${escape(f.style.fontSize)}" font-weight="${escape(f.style.fontWeight)}" font-style="${escape(f.style.fontStyle)}" letter-spacing="${escape(f.style.letterSpacing)}" style="font-variation-settings:${escape(f.style.fontVariationSettings ?? 'normal')};line-height:${escape(f.style.lineHeight ?? 'normal')};color:${escape(f.style.color)}" fill="${this.options.outlines ? 'none' : escape(paint.value)}" stroke="${this.options.outlines ? '#6366f1' : 'none'}" stroke-width="${this.options.outlineWidth ?? .5}" fill-opacity="${paint.opacity}" text-decoration="${escape(f.style.textDecorationLine)}" text-decoration-style="${escape(f.style.textDecorationStyle)}" text-decoration-thickness="${escape(f.style.textDecorationThickness)}" font-variant="${f.style.fontVariantCaps === 'small-caps' ? 'small-caps' : 'normal'}" xml:space="preserve">${escape(f.text)}</text>`;
                    }).join('') + strokes;
                }).join('');
            }
            else
                body += `<foreignObject x="${s.x}" y="${s.y}" width="${Math.max(1, s.width)}" height="${Math.max(1, s.height)}" overflow="visible">${textHTML(s, this.options.typography)}</foreignObject>`;
        }
        else if (s.type === 'svg' && s.svg) {
            const raw = sanitizeSVG(String(s.svg));
            body = `<svg x="${s.x}" y="${s.y}" width="${s.width}" height="${s.height}" viewBox="${escape(s.viewBox ?? `0 0 ${s.width} ${s.height}`)}">${raw.replace(/^.*?<svg[^>]*>/s, '').replace(/<\/svg>\s*$/, '')}</svg>`;
        }
        else {
            let fills = (s.fills ?? (s.fill ? [{ type: 'solid', color: s.fill }] : [])).filter((p: Data) => p.visible !== false && !p.hidden);
            if ((s.type === 'image' || s.type === 'svg') && s.image)
                fills = [...fills, {
                        type: 'image', image: s.image, objectFit: s.objectFit, crop: s.crop, adjust: s.adjust
                    }];
            if (asMask && !fills.length)
                fills = [{ color: '#fff' }];
            if (this.options.exporting && (s.omitFillOnExport || (this.options.omitFill && s.type === 'frame')))
                fills = [];
            if (this.options.outlines)
                fills = [];
            for (const p of fills) {
                const paint = this.paint(p, s);
                body += `<path d="${escape(path)}" fill="${escape(paint.value)}" fill-opacity="${paint.opacity}" fill-rule="${escape(s.fillRule ?? 'nonzero')}" style="mix-blend-mode:${blend(p.blendMode)}"/>`;
            }
            for (const stroke of this.options.outlines ? [{ color: '#6366f1', width: this.options.outlineWidth ?? 1 }] : s.strokes ?? []) {
                if (stroke.visible === false || stroke.hidden)
                    continue;
                const paint = this.paint(stroke, s), w = num(stroke.width ?? stroke.thickness, 1), alignment = stroke.align ?? stroke.alignment ?? 'center';
                let extra = '', sw = w;
                if (alignment === 'inside' || alignment === 'inner') {
                    const id = this.id('strokeclip');
                    this.defs.push(`<clipPath id="${id}"><path d="${escape(path)}"/></clipPath>`);
                    extra = ` clip-path="url(#${id})"`;
                    sw = w * 2;
                }
                if (alignment === 'outside' || alignment === 'outer') {
                    const id = this.id('strokemask');
                    this.defs.push(`<mask id="${id}" maskUnits="userSpaceOnUse" x="${s.x - w * 4}" y="${s.y - w * 4}" width="${s.width + w * 8}" height="${s.height + w * 8}"><rect x="${s.x - w * 4}" y="${s.y - w * 4}" width="${s.width + w * 8}" height="${s.height + w * 8}" fill="white"/><path d="${escape(path)}" fill="black"/></mask>`);
                    extra = ` mask="url(#${id})"`;
                    sw = w * 2;
                }
                const sides = stroke.sides ?? s.strokeSides;
                let d = path;
                if (sides && s.type !== 'path' && s.type !== 'ellipse') {
                    const keys = ['top', 'right', 'bottom', 'left'];
                    const pts = [[s.x, s.y, s.x + s.width, s.y], [s.x + s.width, s.y, s.x + s.width, s.y + s.height], [s.x + s.width, s.y + s.height, s.x, s.y + s.height], [s.x, s.y + s.height, s.x, s.y]];
                    d = keys.map((key, i) => sides[key] === false || sides[key] === 0 ? '' : `M${pts[i][0]} ${pts[i][1]}L${pts[i][2]} ${pts[i][3]}`).join('');
                }
                const marker = (kind: any, start: boolean) => {
                    if (!kind || kind === 'none')
                        return '';
                    const id = this.id('endpoint'), size = w * 4;
                    const triangle = kind === 'triangle' || kind === 'triangleArrow';
                    const shape = kind === 'circle' ? `<circle cx="5" cy="5" r="4"/>` : kind === 'diamond' ? '<path d="M5 0L10 5L5 10L0 5Z"/>' : kind === 'square' ? '<rect x="1" y="1" width="8" height="8"/>' : triangle ? '<path d="M1 1L9 5L1 9Z"/>' : '<path d="M1 1L9 5L1 9" fill="none" stroke="context-stroke" stroke-width="2"/>';
                    this.defs.push(`<marker id="${id}" viewBox="0 0 10 10" refX="${start ? 1 : 9}" refY="5" markerWidth="${size}" markerHeight="${size}" markerUnits="userSpaceOnUse" orient="auto-start-reverse" fill="${escape(paint.value)}">${shape}</marker>`);
                    return ` marker-${start ? 'start' : 'end'}="url(#${id})"`;
                };
                const strokeMarkup = (strokePath: string, strokeWidth: number) => `<path d="${escape(strokePath)}" fill="none" stroke="${escape(paint.value)}" stroke-opacity="${paint.opacity}" stroke-width="${strokeWidth}" stroke-linecap="${escape(stroke.cap ?? stroke.lineCap ?? 'butt')}" stroke-linejoin="${escape(stroke.join ?? stroke.lineJoin ?? 'miter')}" stroke-miterlimit="${num(stroke.miterLimit, 4)}" stroke-dasharray="${escape((stroke.dash ?? stroke.dashes ?? (stroke.style === 'dotted' ? [w, w] : stroke.style === 'dashed' ? [w * 3, w * 2] : [])).join?.(' ') ?? stroke.dash ?? 'none')}" stroke-dashoffset="${num(stroke.dashOffset)}"${extra}${marker(stroke.startCap ?? s.startCap, true)}${marker(stroke.endCap ?? s.endCap, false)}/>`;
                if (sides && s.type !== 'path' && s.type !== 'ellipse') {
                    const edges = [['top', s.x, s.y, s.x + s.width, s.y], ['right', s.x + s.width, s.y, s.x + s.width, s.y + s.height], ['bottom', s.x + s.width, s.y + s.height, s.x, s.y + s.height], ['left', s.x, s.y + s.height, s.x, s.y]];
                    for (const [side, x1, y1, x2, y2] of edges) {
                        const value = sides[String(side)];
                        if (value === false || value === 0)
                            continue;
                        body += strokeMarkup(`M${x1} ${y1}L${x2} ${y2}`, typeof value === 'number' ? value * (sw / w) : sw);
                    }
                }
                else
                    body += strokeMarkup(d, sw);
            }
        }
        const children = (s.type === 'boolean' ? [] : s.childIds ?? []).map(id => this.objects[id]).filter(Boolean);
        let descendants = '';
        const mode = s.isMaskGroup === false ? undefined : s.maskType ?? s.maskMode ?? s.mask?.mode ?? (s.isMaskGroup ? 'alpha' : undefined);
        if (mode && children.length) {
            const mask = children[0], id = this.id('mask');
            if (mode === 'vector') {
                this.defs.push(`<mask id="${id}" maskUnits="userSpaceOnUse" x="${s.x}" y="${s.y}" width="${s.width}" height="${s.height}" style="mask-type:alpha">${this.vectorMask(mask)}</mask>`);
                descendants = `<g mask="url(#${id})">${this.siblings(children.slice(1), backdrop)}</g>`;
            }
            else {
                this.defs.push(`<mask id="${id}" maskUnits="userSpaceOnUse" x="${s.x}" y="${s.y}" width="${s.width}" height="${s.height}" style="mask-type:${mode === 'luminance' ? 'luminance' : 'alpha'}">${this.node(mask, true)}</mask>`);
                descendants = `<g mask="url(#${id})">${this.siblings(children.slice(1), backdrop)}</g>`;
            }
        }
        else
            descendants = this.siblings(children, backdrop);
        // Children already use world coordinates; cancel the parent's affine transform for their independent world matrices.
        if (descendants) {
            const m = s.inverseTransform ?? inverse(s.transform);
            const cx = s.x + s.width / 2, cy = s.y + s.height / 2;
            const inv = `matrix(${m.a} ${m.b} ${m.c} ${m.d} ${cx - m.a * cx - m.c * cy} ${cy - m.b * cx - m.d * cy})`;
            descendants = `<g transform="${inv}"${clipping}>${descendants}</g>`;
        }
        const geometry = s.type === 'path' || s.type === 'boolean' ? `<path data-geometry="true" d="${escape(path)}" fill="none" stroke="none"/>` : `<rect data-geometry="true" x="${s.x}" y="${s.y}" width="${s.width}" height="${s.height}" fill="none" stroke="none"/>`;
        return `<g ${attrs}${this.options.outlines ? '' : this.effects(s)}>${geometry}${this.options.outlines ? '' : this.backdrop(s, backdrop)}${s.clip ? `<g${bodyClipping}>${body}</g>` : body}${descendants}</g>`;
    }
    /** White vector coverage deliberately ignores mask paint opacity, effects and image alpha. */
    vectorMask(shape: Shape): string {
        if (shape.hidden || shape.visible === false)
            return '';
        if (shape.type === 'group') {
            let geometry = (shape.childIds ?? []).map(id => this.objects[id]).filter(Boolean).map(child => this.vectorMask(child)).join('');
            if (shape.clip) {
                const id = this.id('vectormaskclip'), clip = shape.clip;
                const rect: Shape = {
                    ...shape, type: 'rect', x: shape.x + num(clip.x), y: shape.y + num(clip.y), width: num(clip.width, shape.width), height: num(clip.height, shape.height), radii: num(clip.radius), cornerSmoothing: 0
                };
                this.defs.push(`<clipPath id="${id}" clipPathUnits="userSpaceOnUse"><path d="${escape(shapePath(rect))}" transform="${shapeMatrix({ ...shape, type: 'rect' })}"/></clipPath>`);
                geometry = `<g clip-path="url(#${id})">${geometry}</g>`;
            }
            return geometry;
        }
        if (shape.type === 'text') {
            const fragments = this.options.textFragments?.get(shape.id);
            if (!fragments)
                throw new Error('Vector text masks require settled browser text measurements');
            return `<g transform="${shapeMatrix(shape)}">${fragments.map(fragment => `<text x="${fragment.x}" y="${fragment.baseline}" fill="white" font-family="${escape(fragment.style.fontFamily)}" font-size="${escape(fragment.style.fontSize)}" font-weight="${escape(fragment.style.fontWeight)}" font-style="${escape(fragment.style.fontStyle)}" letter-spacing="${escape(fragment.style.letterSpacing)}" font-variant="${fragment.style.fontVariantCaps === 'small-caps' ? 'small-caps' : 'normal'}" style="font-variation-settings:${escape(fragment.style.fontVariationSettings ?? 'normal')}" xml:space="preserve">${escape(fragment.text)}</text>`).join('')}</g>`;
        }
        return `<path d="${escape(shapePath(shape))}" transform="${shapeMatrix(shape)}" fill="white" fill-rule="${escape(shape.fillRule ?? 'nonzero')}"/>`;
    }
    siblings(shapes: Shape[], backdrop = '') {
        let content = '';
        for (const shape of shapes)
            content += this.node(shape, false, backdrop + content);
        return content;
    }
    backdrop(s: Shape, previous: string) {
        const blur = !s.backgroundBlurHidden ? num(s.backgroundBlur) : 0;
        if (!blur || !previous)
            return '';
        const clip = this.id('backdropclip'), filter = this.id('backdropfilter');
        this.defs.push(`<clipPath id="${clip}"><path d="${escape(shapePath(s))}" transform="${shapeMatrix(s)}"/></clipPath><filter id="${filter}" x="-100%" y="-100%" width="300%" height="300%"><feGaussianBlur stdDeviation="${blur / 2}"/></filter>`);
        const m = s.inverseTransform ?? inverse(s.transform), cx = s.x + s.width / 2, cy = s.y + s.height / 2;
        return `<g transform="matrix(${m.a} ${m.b} ${m.c} ${m.d} ${cx - m.a * cx - m.c * cy} ${cy - m.b * cx - m.d * cy})"><g clip-path="url(#${clip})"><g filter="url(#${filter})">${previous}</g></g></g>`;
    }
    svg(ids: string[], bounds: Rect) {
        const content = this.siblings(ids.map(id => this.objects[id]).filter(Boolean));
        return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${bounds.width}" height="${bounds.height}" viewBox="${bounds.x} ${bounds.y} ${bounds.width} ${bounds.height}"><defs>${this.defs.join('')}</defs>${content}</svg>`;
    }
}
function inverse(m: Data = { a: 1, b: 0, c: 0, d: 1 }) {
    const det = m.a * m.d - m.b * m.c;
    return det ? { a: m.d / det, b: -m.b / det, c: -m.c / det, d: m.a / det } : { a: 1, b: 0, c: 0, d: 1 };
}
export function boundsOf(shapes: Shape[]): Rect {
    const pts = shapes.flatMap(s => s.corners?.length ? s.corners : [{ x: s.x, y: s.y }, { x: s.x + s.width, y: s.y + s.height }]);
    if (!pts.length)
        return { x: 0, y: 0, width: 1, height: 1 };
    const x = Math.min(...pts.map(p => p.x)), y = Math.min(...pts.map(p => p.y));
    return { x, y, width: Math.max(1, Math.max(...pts.map(p => p.x)) - x), height: Math.max(1, Math.max(...pts.map(p => p.y)) - y) };
}
function sanitizeSVG(source: string): string {
    const doc = new DOMParser().parseFromString(source, 'image/svg+xml');
    if (doc.querySelector('parsererror'))
        throw new Error('Malformed SVG picture');
    // Raw JSON/OMC pictures bypass the markup importer. Apply the same static
    // element policy here before exposing the picture in any exported document.
    for (const node of [...doc.querySelectorAll('*')]) {
        if (unsafeMarkupElement(node.localName)) {
            if (node === doc.documentElement)
                throw new Error('Unsafe SVG picture root');
            node.remove();
            continue;
        }
        for (const attribute of [...node.attributes]) {
            const name = attribute.localName.toLowerCase(), value = attribute.value;
            if (name.startsWith('on') || name === 'srcdoc' ||
                ((name === 'href' || name === 'src') && !safeUrl(value))) {
                node.removeAttributeNode(attribute);
            }
            else if (name === 'style') {
                try {
                    cssDeclarations(value);
                }
                catch {
                    node.removeAttributeNode(attribute);
                }
            }
        }
    }
    return new XMLSerializer().serializeToString(doc.documentElement);
}
function cssPaintLayers(paints: Data[]): string {
    return [...paints].reverse().filter(p => !p.hidden && p.visible !== false).map(p => {
        if (p.image)
            return `url(${JSON.stringify(p.image.src ?? p.image.id)})`;
        const shape = { x: 0, y: 0, width: 256, height: 256 } as Shape;
        const writer = new SceneWriter({});
        const paint = writer.paint(p, shape);
        const source = `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><defs>${writer.defs.join('')}</defs><rect width="256" height="256" fill="${escape(paint.value)}" fill-opacity="${paint.opacity}"/></svg>`;
        return `url("data:image/svg+xml,${encodeURIComponent(source)}")`;
    }).join(',');
}
function colorWithOpacity(value: any, opacity: number): string {
    if (opacity === 1)
        return color(value);
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const context = canvas.getContext('2d')!;
    context.fillStyle = color(value);
    context.fillRect(0, 0, 1, 1);
    const pixel = context.getImageData(0, 0, 1, 1).data;
    return `rgba(${pixel[0]},${pixel[1]},${pixel[2]},${pixel[3] / 255 * opacity})`;
}
