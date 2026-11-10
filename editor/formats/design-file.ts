/** Local design-file conversion. Run in the desktop import worker, never in the renderer. */
import {createHash} from 'node:crypto';
import {inflateRawSync,zstdDecompressSync} from 'node:zlib';
import { unzipSync } from 'fflate';
import { parseFigBinary, nodeId, resolveVectorNodePaths, type FigNode } from 'openfig-core';
import type { CanvasDocument, Data, Page, Matrix } from '../contracts';
import { createDocument, createPage, createShape, insertShape, refreshFrames } from '../document';
import { assertFiniteDocument, richText } from './model';
import { parseSvgPath } from './svg';
import {validateImportedDocument} from '../mcp/import-document';
import { multiply, identity } from '../geometry';

import {DESIGN_FILE_LIMIT,documentLimits} from '../../core/capacity.mjs';
export {DESIGN_FILE_LIMIT} from '../../core/capacity.mjs';
const EXPANDED_LIMIT = 512 * 1024 * 1024;
const positionOrder = (a: FigNode, b: FigNode) => {const x=a.parentIndex?.position??'',y=b.parentIndex?.position??'';return x<y?-1:x>y?1:0;};
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const finite = (value: any, fallback = 0): number => {
    if (value === undefined) return fallback;
    if (typeof value !== 'number' || !Number.isFinite(value)) throw Error('Invalid design-file geometry');
    return value;
};
function archive(bytes: Uint8Array) {
    let total = 0, count = 0;
    const files = unzipSync(bytes, { filter: entry => {
        if (++count > 100000 || entry.originalSize > DESIGN_FILE_LIMIT || (total += entry.originalSize) > EXPANDED_LIMIT)
            throw Error('Design archive exceeds the expanded size or entry limit');
        if (entry.name.split('/').some(part => part === '..') || entry.name.startsWith('/') || entry.name.includes('\\'))
            throw Error('Invalid design archive path');
        return !entry.name.endsWith('/');
    } });
    if (Object.values(files).reduce((sum, data) => sum + data.length, 0) > EXPANDED_LIMIT) throw Error('Design archive exceeds the expanded size limit');
    return files;
}
function imageSource(bytes: Uint8Array) {
    let mime = '';
    if (bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71) mime = 'image/png';
    else if (bytes[0] === 255 && bytes[1] === 216) mime = 'image/jpeg';
    else if (text(bytes.subarray(0, 3)) === 'GIF') mime = 'image/gif';
    else if (text(bytes.subarray(0, 4)) === 'RIFF' && text(bytes.subarray(8, 12)) === 'WEBP') mime = 'image/webp';
    if (!mime) throw Error('Unsupported embedded image format');
    return `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`;
}
const rgba = (c: Data = {}) => `rgba(${Math.round(finite(c.r ?? c.red) * 255)},${Math.round(finite(c.g ?? c.green) * 255)},${Math.round(finite(c.b ?? c.blue) * 255)},${finite(c.a ?? c.alpha, 1)})`;

export function importDesignFile(bytes: Uint8Array, format: string): { document: CanvasDocument; warnings: string[] } {
    if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length > DESIGN_FILE_LIMIT) throw Error('Design file exceeds 256 MiB or is empty');
    if (!['fig', 'sketch'].includes(format)) throw Error('Unsupported design file format');
    const warnings = new Set<string>(), document = createDocument();
    document.capacity='large';
    document.pages = []; document.pagesById = {};
    const embedded = new Map<Uint8Array, string>();
    const imageRef = (bytes: Uint8Array) => {
        let id = embedded.get(bytes);
        if (!id) {
            id = 'design-' + createHash('sha256').update(bytes).digest('hex');
            (document.assets ??= {})[id] = {id, name: id, kind: 'image', src: imageSource(bytes)};
            embedded.set(bytes, id);
        }
        return {assetId: id};
    };
    let count = 0;
    const warn = (message: string) => { if (warnings.size < 40) warnings.add(message); };
    const page = (name: string) => {
        if (document.pages.length >= 100) throw Error('Design file exceeds 100 pages');
        const p = createPage(name); document.pages.push(p.id); document.pagesById[p.id] = p; return p;
    };
    const add = (p: Page, parent: string, type: string, values: Data, matrix: Matrix) => {
        if (++count > 100000) throw Error('Design file exceeds 100000 layers');
        if (values.width < 0 || values.height < 0) throw Error('Invalid design-file dimensions');
        // Convert local transforms to world coordinates; the editor rotates around the shape center.
        const width = values.width, height = values.height;
        const sx = Math.hypot(matrix.a, matrix.b), sy = Math.hypot(matrix.c, matrix.d);
        if (Math.abs(sx - 1) > .001 || Math.abs(sy - 1) > .001 || Math.abs(matrix.a * matrix.c + matrix.b * matrix.d) > .001)
            warn('Scaled or skewed transforms may differ from the source.');
        const cx = matrix.a * width / 2 + matrix.c * height / 2 + matrix.e, cy = matrix.b * width / 2 + matrix.d * height / 2 + matrix.f;
        const s = createShape(type, { ...values, x: cx - width / 2, y: cy - height / 2, rotation: Math.atan2(matrix.b, matrix.a) * 180 / Math.PI, flipY: matrix.a * matrix.d - matrix.b * matrix.c < 0, parentId: parent });
        insertShape(p, s, parent); return s;
    };
    const pathContent = (d: string, x: number, y: number) => parseSvgPath(d).map(segment => ({ command: segment.type,
        ...(segment.point ? { x: segment.point.x + x, y: segment.point.y + y } : {}),
        ...(segment.control1 ? { x1: segment.control1.x + x, y1: segment.control1.y + y } : {}),
        ...(segment.control2 ? { x2: segment.control2.x + x, y2: segment.control2.y + y } : {}) }));
    if (format === 'fig') {
        const files = bytes[0] === 0x50 && bytes[1] === 0x4b ? archive(bytes) : null;
        const binary = files ? files['canvas.fig'] : bytes;
        if (!binary || text(binary.subarray(0, 8)) !== 'fig-kiwi') throw Error('Expected a Figma Design .fig file with canvas.fig');
        // Bound inner compression too: the ZIP limit alone does not bound Kiwi chunks.
        const view = new DataView(binary.buffer, binary.byteOffset, binary.byteLength);
        let offset = 12, expanded = 0;
        for (let i = 0; i < 2; i++) {
            if (offset + 4 > binary.length) throw Error('Truncated Figma chunk');
            const length = view.getUint32(offset, true); offset += 4;
            if (offset + length > binary.length) throw Error('Truncated Figma chunk');
            const chunk = binary.subarray(offset, offset + length); offset += length;
            const zstd = chunk[0] === 0x28 && chunk[1] === 0xb5 && chunk[2] === 0x2f && chunk[3] === 0xfd;
            expanded += (zstd ? zstdDecompressSync : inflateRawSync)(chunk, {maxOutputLength: EXPANDED_LIMIT - expanded}).length;
        }
        const fig = parseFigBinary(binary);
        if (!Array.isArray(fig.nodes) || fig.nodes.length > 100000) throw Error('Figma file exceeds 100000 nodes');
        const images = new Map(Object.entries(files ?? {}).filter(([name]) => name.startsWith('images/')).map(([name, data]) => [name.slice(7), data]));
        const paints = (list: Data[] = []): Data[] => list.filter(p => p.visible !== false).flatMap<Data>(p => {
            if (p.type === 'SOLID') return [{ color: rgba(p.color), opacity: finite(p.opacity, 1) }];
            if (p.type === 'IMAGE') {
                const hash = p.image?.hash, key = typeof hash === 'string' ? hash : hash ? Array.from(hash as Uint8Array).map(b => b.toString(16).padStart(2, '0')).join('') : '';
                const data = images.get(key);
                if (data) return [{ image: imageRef(data), opacity: finite(p.opacity, 1) }];
                warn('An embedded Figma image is missing.'); return [];
            }
            warn(`Unsupported Figma paint: ${p.type}`); return [];
        });
        const active = new Set<string>();
        const visit = (node: FigNode, p: Page, parent: string, parentMatrix: Matrix, depth: number) => {
            if (node.phase === 'REMOVED') return;
            const key = nodeId(node)!;
            if (depth > 100 || active.has(key)) throw Error('Figma layer hierarchy is cyclic or too deep');
            active.add(key);
            const t = node.transform;
            const matrix = multiply(parentMatrix, t ? {a:finite(t.m00,1),b:finite(t.m10),c:finite(t.m01),d:finite(t.m11,1),e:finite(t.m02),f:finite(t.m12)} : identity());
            let children = (fig.childrenMap.get(key) ?? []).filter(n => n.phase !== 'REMOVED').sort(positionOrder);
            if (node.type === 'INSTANCE' && !children.length) {
                const masterId = node.symbolData?.symbolID;
                if (masterId) children = fig.childrenMap.get(`${masterId.sessionID}:${masterId.localID}`) ?? [];
                if (!children.length) warn('A Figma component instance has no available child layers.');
            }
            let type = ({ FRAME: node.resizeToFit ? 'group' : 'frame', GROUP: 'group', SYMBOL: 'frame', INSTANCE: 'group', ROUNDED_RECTANGLE: 'rect', RECTANGLE: 'rect', ELLIPSE: 'ellipse', TEXT: 'text', VECTOR: 'path', LINE: 'path', BOOLEAN_OPERATION: 'group' } as Data)[node.type];
            if (!type) { type = children.length ? 'group' : 'rect'; warn(`Unsupported Figma layer: ${node.type}`); }
            if (node.type === 'INSTANCE' || node.type === 'SYMBOL') warn('Figma components and instances are imported as ordinary layers; overrides may differ.');
            if (node.stackMode && node.stackMode !== 'NONE') warn('Auto layout is imported at its saved positions.');
            if (node.effects?.length) warn('Figma effects are not imported.');
            const fills = paints(node.fillPaints), values: Data = { name: node.name ?? node.type, width: finite(node.size?.x), height: finite(node.size?.y), hidden: node.visible === false, locked: node.locked === true, opacity: finite(node.opacity, 1), fills, strokes: paints(node.strokePaints).map(p => ({ ...p, width: finite(node.strokeWeight, 1) })), radii: finite(node.cornerRadius), clipContent: !node.frameMaskDisabled };
            if (type === 'text') {
                values.content = richText(node.textData?.characters ?? '', { fontFamily: node.fontName?.family ?? 'sans-serif', fontSize: finite(node.fontSize, 16), fontWeight: /bold/i.test(node.fontName?.style ?? '') ? 700 : 400, fontStyle: /italic/i.test(node.fontName?.style ?? '') ? 'italic' : 'normal', fills });
                for (const paragraph of values.content.children) paragraph.textAlign = (node.textAlignHorizontal ?? 'LEFT').toLowerCase().replace('justified', 'justify');
                values.autoResize = 'none';
                if ((node.textData as Data)?.characterStyleIDs?.length || node.derivedTextData) warn('Mixed Figma text styles may be simplified.');
            }
            const s = add(p, parent, type, values, matrix);
            if (type === 'path') {
                const geometry = resolveVectorNodePaths(fig, node);
                const d = geometry.fill.map(g => g.svgPath).join(' ') || geometry.stroke.map(g => g.svgPath).join(' ');
                if (d) { s.content = pathContent(d, s.x, s.y); s.fillRule = geometry.fill[0]?.windingRule === 'ODD' ? 'evenodd' : 'nonzero'; }
                else if (node.type === 'LINE') s.content = [{ command: 'move', x: s.x, y: s.y }, { command: 'line', x: s.x + s.width, y: s.y + s.height }];
                else warn('A Figma vector has no supported geometry.');
            }
            for (const child of children) visit(child, p, s.id, matrix, depth + 1);
            active.delete(key);
        };
        for (const n of fig.nodes.filter(n => n.type === 'CANVAS' && n.phase !== 'REMOVED' && !n.internalOnly).sort(positionOrder)) {
            const p = page(n.name ?? 'Page');
            for (const child of (fig.childrenMap.get(nodeId(n)!) ?? []).sort(positionOrder)) visit(child, p, 'root', identity(), 0);
        }
    } else {
        const files = archive(bytes);
        if (!files['document.json']) throw Error('Expected a Sketch 43+ ZIP document');
        const sketch = JSON.parse(text(files['document.json']));
        if (!Array.isArray(sketch.pages) || sketch.pages.length > 100) throw Error('Invalid Sketch page references');
        const symbols = new Map<string, Data>();
        const pages = sketch.pages.map((ref: Data) => {
            const key = `${ref._ref}.json`;
            if (!files[key]) throw Error(`Missing Sketch page: ${key}`);
            const p = JSON.parse(text(files[key]));
            const stack = [p]; let scanned = 0;
            while (stack.length) { const n = stack.pop()!; if (++scanned > 100000) throw Error('Sketch page exceeds 100000 layers'); if (n._class === 'symbolMaster') symbols.set(n.symbolID, n); stack.push(...n.layers ?? []); }
            return p;
        });
        const paints = (list: Data[] = []): Data[] => list.filter(p => p.isEnabled !== false).flatMap<Data>(p => {
            if ((p.fillType ?? 0) === 0) return [{ color: rgba(p.color), opacity: finite(p.contextSettings?.opacity, 1) }];
            if (p.fillType === 4 && p.image?._ref && files[p.image._ref]) return [{ image: imageRef(files[p.image._ref]) }];
            warn(`Unsupported Sketch paint: ${p.fillType}`); return [];
        });
        const point = (value: string, width: number, height: number) => {
            const match = /^\{\s*([-+\d.eE]+)\s*,\s*([-+\d.eE]+)\s*\}$/.exec(value);
            if (!match) throw Error('Invalid Sketch curve point');
            return { x: finite(Number(match[1])) * width, y: finite(Number(match[2])) * height };
        };
        const visit = (n: Data, p: Page, parent: string, parentMatrix: Matrix, depth: number) => {
            if (depth > 100) throw Error('Sketch layer hierarchy is too deep');
            const f = n.frame ?? {}, width = finite(f.width), height = finite(f.height), angle = -finite(n.rotation) * Math.PI / 180, a = Math.cos(angle) * (n.isFlippedHorizontal ? -1 : 1), b = Math.sin(angle) * (n.isFlippedHorizontal ? -1 : 1), c = -Math.sin(angle) * (n.isFlippedVertical ? -1 : 1), d = Math.cos(angle) * (n.isFlippedVertical ? -1 : 1);
            const matrix = multiply(parentMatrix, {a,b,c,d,e:finite(f.x)+width/2-a*width/2-c*height/2,f:finite(f.y)+height/2-b*width/2-d*height/2});
            let type = ({ artboard: 'frame', symbolMaster: 'frame', group: 'group', shapeGroup: 'group', symbolInstance: 'group', rectangle: 'rect', oval: 'ellipse', text: 'text', bitmap: 'image', shapePath: 'path', slice: 'rect' } as Data)[n._class];
            if (!type) { type = n.layers?.length ? 'group' : 'rect'; warn(`Unsupported Sketch layer: ${n._class}`); }
            const style = n.style ?? {}, fills = paints(style.fills), values: Data = { name: n.name ?? n._class ?? 'Layer', width, height, hidden: n.isVisible === false, locked: n.isLocked === true, opacity: finite(style.contextSettings?.opacity, 1), fills, strokes: paints(style.borders).map((paint, i) => ({ ...paint, width: finite(style.borders.filter((p: Data) => p.isEnabled !== false)[i]?.thickness, 1) })), clipContent: n._class === 'artboard' };
            if (style.shadows?.some((s: Data) => s.isEnabled) || style.blur?.isEnabled) warn('Sketch effects are not imported.');
            if (n.hasClippingMask) warn('Sketch clipping masks are not imported.');
            if (n._class === 'symbolMaster' || n._class === 'symbolInstance') warn('Sketch symbols are imported as ordinary layers; overrides are not imported.');
            if (type === 'text') {
                const attributes = style.textStyle?.encodedAttributes ?? n.attributedString?.attributes?.[0]?.attributes ?? {}, font = attributes.MSAttributedStringFontAttribute?.attributes ?? {}, fontName = font.name ?? 'sans-serif';
                values.content = richText(n.attributedString?.string ?? '', { fontFamily: fontName.replace(/-(Regular|Bold|Italic|Medium|Light|Semibold)$/i, ''), fontSize: finite(font.size, 16), fontWeight: /bold/i.test(fontName) ? 700 : 400, fontStyle: /italic/i.test(fontName) ? 'italic' : 'normal', fills: [{ color: rgba(attributes.MSAttributedStringColorAttribute ?? { red: 0, green: 0, blue: 0, alpha: 1 }) }] });
                values.autoResize = 'none';
                if ((n.attributedString?.attributes?.length ?? 0) > 1) warn('Mixed Sketch text styles are simplified.');
            }
            if (type === 'image') {
                const data = files[n.image?._ref];
                if (data) values.image = { ...imageRef(data), width, height };
                else throw Error('Missing embedded Sketch bitmap');
                values.fills = [];
            }
            if (type === 'rect' && n.points?.length) values.radii = n.points.map((p: Data) => finite(p.cornerRadius));
            const s = add(p, parent, type, values, matrix);
            if (type === 'path' && n.points?.length) {
                if (n.points.length > 20000) throw Error('Sketch path exceeds point limit');
                const points = n.points.map((v: Data) => ({ ...v, p: point(v.point, width, height) }));
                const commands = [`M${points[0].p.x} ${points[0].p.y}`];
                for (let i = 1; i < points.length + (n.isClosed ? 1 : 0); i++) {
                    const prev = points[(i - 1) % points.length], next = points[i % points.length];
                    if (prev.hasCurveFrom || next.hasCurveTo) { const c1 = prev.hasCurveFrom ? point(prev.curveFrom, width, height) : prev.p, c2 = next.hasCurveTo ? point(next.curveTo, width, height) : next.p; commands.push(`C${c1.x} ${c1.y} ${c2.x} ${c2.y} ${next.p.x} ${next.p.y}`); }
                    else commands.push(`L${next.p.x} ${next.p.y}`);
                }
                if (n.isClosed) commands.push('Z');
                s.content = pathContent(commands.join(' '), s.x, s.y);
            }
            let children = n.layers ?? [];
            if (n._class === 'symbolInstance') {
                const master = symbols.get(n.symbolID);
                if (master) { children = master.layers ?? []; if (width !== master.frame?.width || height !== master.frame?.height) warn('Resized Sketch symbol instances may differ from the source.'); }
                else warn('A Sketch symbol master is missing.');
            }
            for (const child of children) visit(child, p, s.id, matrix, depth + 1);
        };
        for (const raw of pages) { const p = page(raw.name ?? 'Page'); for (const child of raw.layers ?? []) visit(child, p, 'root', identity(), 0); }
    }
    if (!document.pages.length) throw Error('Design file has no pages');
    for (const p of Object.values(document.pagesById)) refreshFrames(p);
    assertFiniteDocument(document);
    document.extra = { ...document.extra, importWarnings: [...warnings], importedFrom: format };
    validateImportedDocument(document);
    if (Buffer.byteLength(JSON.stringify(document)) > documentLimits(document).bytes) throw Error('Converted design exceeds the 256 MiB canvas limit');
    return { document, warnings: [...warnings] };
}
