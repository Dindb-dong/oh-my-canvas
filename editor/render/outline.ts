import type { Data, FontFaceInput, Shape } from '../contracts';
import type { Font, PathCommand } from 'fontkit';
import { shapePath, type TextFragment } from './scene';
import { canonicalSegments, loadKit } from './vector';
import { orientedPoint } from '../geometry';

export interface OutlinePart { segments: Data[]; fills: Data[]; fillRule?: string; }
const visible = (paint: Data) => paint.visible !== false && !paint.hidden;
function solid(paint: Data) {
    if (paint.gradient || paint.image || paint.type && !['solid', 'color'].includes(paint.type))
        throw new Error('Outline currently requires solid paints; the original layer was kept');
    return { color: paint.color ?? '#000000', ...(paint.opacity !== undefined ? { opacity: paint.opacity } : {}) };
}
function orient(shape: Shape, segments: Data[]): Data[] {
    if (shape.type === 'path' || shape.type === 'boolean')
        return segments;
    return segments.map(segment => {
        if (segment.command === 'close') return segment;
        const result: Data = { ...segment, ...orientedPoint(shape, segment as { x: number; y: number }) };
        for (const suffix of ['1', '2'])
            if (segment['x' + suffix] !== undefined) {
                const point = orientedPoint(shape, { x: segment['x' + suffix], y: segment['y' + suffix] });
                result['x' + suffix] = point.x;
                result['y' + suffix] = point.y;
            }
        return result;
    });
}
export async function outlineStroke(shape: Shape, options: Data = {}): Promise<OutlinePart[]> {
    if (!['path', 'boolean', 'rect', 'ellipse'].includes(shape.type))
        throw new Error('Select a vector layer to outline its stroke');
    const strokes = (shape.strokes ?? []).filter(visible);
    if (!strokes.length)
        throw new Error('This layer has no visible stroke');
    const kit = await loadKit(options.wasmUrl), source = kit.Path.MakeFromSVGString(shapePath(shape));
    if (!source) throw new Error('The source path is invalid');
    try {
        source.setFillType(shape.fillRule === 'evenodd' ? kit.FillType.EvenOdd : kit.FillType.Winding);
        const result: OutlinePart[] = [];
        const fills = (shape.fills ?? []).filter(visible);
        if (fills.length)
            result.push({ segments: orient(shape, canonicalSegments(kit, source.toCmds())), fills: fills.map(solid), fillRule: shape.fillRule });
        for (const stroke of strokes) {
            const width = stroke.width ?? stroke.thickness ?? 1, alignment = stroke.align ?? stroke.alignment ?? 'center';
            if (!Number.isFinite(width) || width <= 0)
                throw new Error('Stroke width must be positive');
            if (alignment !== 'center' || stroke.dashes?.length || stroke.dash?.length || ['dotted', 'dashed'].includes(stroke.style) || shape.strokeDashArray?.length || stroke.sides || shape.strokeSides || stroke.startArrow || stroke.endArrow || shape.startArrow || shape.endArrow || [stroke.startCap, stroke.endCap, shape.startCap, shape.endCap].some(cap => cap && cap !== 'none'))
                throw new Error('Outline supports centered solid strokes without dashes, side overrides, or arrowheads');
            const cap = stroke.cap ?? stroke.lineCap ?? 'butt', join = stroke.join ?? stroke.lineJoin ?? 'miter';
            if (!['butt', 'round', 'square'].includes(cap) || !['miter', 'round', 'bevel'].includes(join))
                throw new Error('Unsupported stroke cap or join');
            const path = source.makeStroked({ width, cap: cap === 'round' ? kit.StrokeCap.Round : cap === 'square' ? kit.StrokeCap.Square : kit.StrokeCap.Butt, join: join === 'round' ? kit.StrokeJoin.Round : join === 'bevel' ? kit.StrokeJoin.Bevel : kit.StrokeJoin.Miter, miter_limit: stroke.miterLimit ?? 4, precision: 2 });
            if (!path) throw new Error('The stroke could not be outlined');
            try {
                result.push({ segments: orient(shape, canonicalSegments(kit, path.toCmds())), fills: [solid(stroke)], fillRule: 'nonzero' });
            }
            finally { path.delete(); }
        }
        return result;
    }
    finally { source.delete(); }
}

function families(value: string): string[] {
    return (value.match(/"[^"]*"|'[^']*'|[^,]+/g) ?? []).map(part => part.trim().replace(/^['"]|['"]$/g, ''));
}
function inRange(code: number, range?: string) {
    if (!range) return true;
    return range.split(',').some(part => {
        const match = /^\s*U\+([\da-f?]+)(?:-([\da-f]+))?\s*$/i.exec(part);
        if (!match) return false;
        const start = parseInt(match[1].replace(/\?/g, '0'), 16), end = parseInt(match[2] ?? match[1].replace(/\?/g, 'f'), 16);
        return code >= start && code <= end;
    });
}
function weightDistance(input: FontFaceInput, weight: number) {
    const values = String(input.weight ?? 400).split(/\s+/).map(value => value === 'normal' ? 400 : value === 'bold' ? 700 : Number(value));
    return values.every(Number.isFinite) ? Math.max(values[0] - weight, weight - (values[1] ?? values[0]), 0) : Infinity;
}
export function glyphSegments(commands: PathCommand[], x: number, baseline: number, scale: number): Data[] {
    const segments: Data[] = [];
    let current = { x: 0, y: 0 };
    const point = (values: number[], offset = 0) => ({ x: x + values[offset] * scale, y: baseline - values[offset + 1] * scale });
    for (const item of commands) {
        const args = item.args;
        if (item.command === 'closePath') { segments.push({ command: 'close' }); continue; }
        if (item.command === 'moveTo' || item.command === 'lineTo') {
            current = point(args);
            segments.push({ command: item.command === 'moveTo' ? 'move' : 'line', ...current });
        }
        else if (item.command === 'quadraticCurveTo') {
            const control = point(args), end = point(args, 2);
            segments.push({ command: 'curve', x1: current.x + (control.x - current.x) * 2 / 3, y1: current.y + (control.y - current.y) * 2 / 3, x2: end.x + (control.x - end.x) * 2 / 3, y2: end.y + (control.y - end.y) * 2 / 3, ...end });
            current = end;
        }
        else if (item.command === 'bezierCurveTo') {
            const first = point(args), second = point(args, 2), end = point(args, 4);
            segments.push({ command: 'curve', x1: first.x, y1: first.y, x2: second.x, y2: second.y, ...end });
            current = end;
        }
        else throw new Error('Unsupported font outline command');
    }
    return segments;
}
export async function outlineText(shape: Shape, fragments: TextFragment[], sources: FontFaceInput[], options: Data = {}): Promise<OutlinePart[]> {
    if (shape.type !== 'text') throw new Error('Select text to create outlines');
    if (fragments.reduce((length, fragment) => length + fragment.text.length, 0) > 8192)
        throw new Error('Outline text in selections of at most 8192 characters');
    if (shape.textBackground || shape.strokes?.some(visible))
        throw new Error('Remove text backgrounds and text strokes before outlining; the original was kept');
    const { create } = await import('fontkit');
    const loaded = new Map<string, Promise<Font>>();
    async function load(input: FontFaceInput) {
        let promise = loaded.get(input.url);
        if (!promise) {
            promise = (async () => {
                const response = await fetch(input.url, { signal: options.signal });
                if (!response.ok) throw new Error(`Could not load font ${input.family}`);
                const bytes = await response.arrayBuffer();
                if (bytes.byteLength > 20 * 1024 * 1024) throw new Error('Font is too large to outline');
                // Fontkit's browser build consumes Uint8Array; its Node-oriented typings require Buffer.
                let data = new Uint8Array(bytes);
                if (String.fromCharCode(...data.slice(0, 4)) === 'wOF2') {
                    if (data.length < 48 || new DataView(bytes).getUint32(16) > 20 * 1024 * 1024)
                        throw new Error('Decompressed font is too large to outline');
                    const { default: decompress } = await import('wawoff2/decompress.js');
                    data = new Uint8Array(await decompress(data));
                }
                const font = create(data as Buffer) as Font;
                if (!font.unitsPerEm) throw new Error('Font collections require an individual font face');
                return font;
            })();
            loaded.set(input.url, promise);
        }
        return promise;
    }
    const result: OutlinePart[] = [];
    for (const fragment of fragments) {
        if (!fragment.text) continue;
        const style = fragment.style, size = parseFloat(style.fontSize), weight = Number(style.fontWeight) || 400, spacing = parseFloat(style.letterSpacing) || 0;
        if (!Number.isFinite(size) || size <= 0) throw new Error('Text font size is invalid');
        if (style.textDecorationLine && style.textDecorationLine !== 'none' || style.backgroundColor && !['transparent', 'rgba(0, 0, 0, 0)'].includes(style.backgroundColor))
            throw new Error('Remove text decorations and highlights before outlining; the original was kept');
        const paints = style.paints ? JSON.parse(style.paints).filter(visible) : [{ color: style.color }];
        if (!paints.length) paints.push({ color: style.color });
        const fills = paints.map(solid);
        if (!sources.some(input => input.family.toLowerCase() === families(style.fontFamily)[0]?.toLowerCase()))
            throw new Error('Outlining needs the actual font file for the primary family; import or choose a bundled font');
        const ordered = families(style.fontFamily).flatMap(family => sources.filter(input => input.family.toLowerCase() === family.toLowerCase()).sort((a, b) => Number((a.style ?? 'normal') !== (style.fontStyle ?? 'normal')) - Number((b.style ?? 'normal') !== (style.fontStyle ?? 'normal')) || weightDistance(a, weight) - weightDistance(b, weight)));
        if (!ordered.length) throw new Error('Outlining needs the actual font file; import or choose a bundled font');
        const chunks: { text: string; font: Font; input: FontFaceInput }[] = [];
        for (const { segment } of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(fragment.text)) {
            const codes = [...segment].map(character => character.codePointAt(0)!);
            let choice: { font: Font; input: FontFaceInput } | undefined;
            for (const input of ordered) {
                if (!codes.every(code => inRange(code, input.unicodeRange))) continue;
                const font = await load(input);
                if (codes.every(code => font.hasGlyphForCodePoint(code))) { choice = { font, input }; break; }
            }
            if (!choice) throw new Error(`The applied font file is unavailable for ${JSON.stringify(segment)}; choose or import that font`);
            if ((choice.input.style ?? 'normal') !== (style.fontStyle ?? 'normal'))
                throw new Error('Synthetic font styles cannot be outlined accurately; import the matching face');
            const previous = chunks.at(-1);
            if (previous?.input === choice.input) previous.text += segment;
            else chunks.push({ text: segment, ...choice });
        }
        let cursor = fragment.x;
        const segments: Data[] = [];
        for (const chunk of chunks) {
            let font = chunk.font;
            if (weightDistance(chunk.input, weight) > 0)
                throw new Error('Synthetic font weights cannot be outlined accurately; import the matching weight');
            const axes: Record<string, number> = {};
            if (font.variationAxes?.wght) axes.wght = weight;
            for (const setting of (style.fontVariationSettings ?? '').matchAll(/["']([\w ]{4})["']\s+(-?[\d.]+)/g))
                axes[setting[1]] = Number(setting[2]);
            if (Object.keys(axes).length) font = font.getVariation(axes);
            const features = { ...(spacing ? { liga: false, clig: false } : {}), ...(style.fontVariantCaps === 'small-caps' ? { smcp: true } : {}) };
            const run = font.layout(chunk.text, features), scale = size / font.unitsPerEm;
            for (let index = 0; index < run.glyphs.length; index++) {
                const glyph = run.glyphs[index], position = run.positions[index];
                if (glyph.id === 0 || glyph.layers?.length) throw new Error('Missing or color glyphs cannot be outlined as a monochrome path');
                segments.push(...glyphSegments(glyph.path.commands, cursor + position.xOffset * scale, fragment.baseline - position.yOffset * scale, scale));
                cursor += position.xAdvance * scale + spacing;
            }
        }
        const expected = fragment.width;
        if (Math.abs(cursor - fragment.x - expected) > Math.max(.75, expected * .015))
            throw new Error('Font shaping differs from the rendered text; the original was kept');
        if (segments.length) result.push({ segments: orient(shape, segments), fills, fillRule: 'nonzero' });
    }
    if (!result.length) throw new Error('The selected text has no visible outlines');
    return result;
}
