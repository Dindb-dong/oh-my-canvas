/** Local design-file conversion. Run in the desktop import worker, never in the renderer. */
import {createHash} from 'node:crypto';
import {inflateRawSync,zstdDecompressSync} from 'node:zlib';
import { unzipSync } from 'fflate';
import { parseFigBinary, nodeId, resolveVectorNodePaths, type FigNode } from 'openfig-core';
import type { CanvasDocument, Data, Page, Matrix } from '../contracts';
import { createDocument, createPage, createShape, insertShape, refreshFrames, validateDocument } from '../document';
import { richText } from './model';
import { parseSvgPath } from './svg';
import {validateImportedDocument} from '../mcp/import-document';
import { multiply, identity } from '../geometry';
import { assetRef } from '../../core/asset-refs.mjs';

import {DESIGN_FILE_LIMIT} from '../../core/capacity.mjs';
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
function imageMimeType(bytes: Uint8Array) {
    let mime = '';
    if (bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71) mime = 'image/png';
    else if (bytes[0] === 255 && bytes[1] === 216) mime = 'image/jpeg';
    else if (text(bytes.subarray(0, 3)) === 'GIF') mime = 'image/gif';
    else if (text(bytes.subarray(0, 4)) === 'RIFF' && text(bytes.subarray(8, 12)) === 'WEBP') mime = 'image/webp';
    if (!mime) throw Error('Unsupported embedded image format');
    return mime;
}
const rgba = (c: Data = {}) => `rgba(${Math.round(finite(c.r ?? c.red) * 255)},${Math.round(finite(c.g ?? c.green) * 255)},${Math.round(finite(c.b ?? c.blue) * 255)},${finite(c.a ?? c.alpha, 1)})`;

export interface DesignImportBlob { hash: string; mimeType: string; bytes: Uint8Array; }
export interface DesignImportResult { document: CanvasDocument; warnings: string[]; blobs?: DesignImportBlob[]; timings: Record<string, number>; }
export interface DesignImportManifest {
    format: string;
    pages: { id: string; name: string; index: number; sourceId?: string }[];
    pageCount: number;
    timings: Record<string, number>;
}
export interface DesignImportBatch extends DesignImportResult {
    sequence: number;
    pageIds: string[];
    completedPages: number;
    totalPages: number;
}
export interface DesignImportSummary {
    complete: true;
    pageCount: number;
    objectCount: number;
    assetCount: number;
    warnings: string[];
    timings: Record<string, number>;
}
interface ImportOptions { binaryAssets?: boolean; batchPages?: number; batchObjects?: number; }
type ImportEvent = { type: 'manifest'; value: DesignImportManifest } | { type: 'batch'; value: DesignImportBatch };
interface PageSource { page: Page; sourceId?: string; convert: () => void; }

/** Convert without suspending. Existing callers retain the complete-file API. */
export function importDesignFile(bytes: Uint8Array, format: string, options: { binaryAssets?: boolean } = {}): DesignImportResult {
    const step = designImportSteps(bytes, format, options).next();
    if (!step.done) throw Error('Unexpected progressive design import');
    return step.value as DesignImportResult;
}

/** Callbacks consume read-only page batches. Desktop worker messages clone the
 * document and transfer each blob once, before waiting for durable publication. */
export async function importDesignFileProgressively(bytes: Uint8Array, format: string, options: ImportOptions & {
    onManifest?: (value: DesignImportManifest) => void | Promise<void>;
    onBatch: (value: DesignImportBatch) => void | Promise<void>;
    signal?: AbortSignal;
}): Promise<DesignImportSummary> {
    if (typeof options.onBatch !== 'function') throw Error('Progressive design import requires onBatch');
    const steps = designImportSteps(bytes, format, options, true);
    const check = () => { if (options.signal?.aborted) throw options.signal.reason ?? new DOMException('Design import cancelled', 'AbortError'); };
    const consume = async (run: () => void | Promise<void>) => {
        if (!options.signal) return run();
        let abort!: () => void;
        const aborted = new Promise<never>((_, reject) => {
            abort = () => { try { check(); } catch (error) { reject(error); } };
            options.signal!.addEventListener('abort', abort, { once: true });
        });
        try { await Promise.race([Promise.resolve().then(() => { check(); return run(); }), aborted]); }
        finally { options.signal.removeEventListener('abort', abort); }
    };
    try {
        while (true) {
            check();
            const step = steps.next();
            if (step.done) return step.value as DesignImportSummary;
            const event = step.value;
            if (event.type === 'manifest') await consume(() => options.onManifest?.(event.value));
            else await consume(() => options.onBatch(event.value));
        }
    } finally { steps.return(undefined as never); }
}

function* designImportSteps(bytes: Uint8Array, format: string, options: ImportOptions, progressive = false): Generator<ImportEvent, DesignImportResult | DesignImportSummary, void> {
    if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length > DESIGN_FILE_LIMIT) throw Error('Design file exceeds 256 MiB or is empty');
    if (!['fig', 'sketch'].includes(format)) throw Error('Unsupported design file format');
    const batchPages = options.batchPages ?? 4, batchObjects = options.batchObjects ?? 4000;
    if (!Number.isInteger(batchPages) || batchPages < 1 || batchPages > 4 || !Number.isInteger(batchObjects) || batchObjects < 1 || batchObjects > 4000)
        throw Error('Invalid design import batch limits');
    const started = performance.now(), timings: Record<string, number> = {};
    let consumerWait = 0;
    const activeElapsed = () => performance.now() - started - consumerWait;
    const timed = <T>(name: string, run: () => T): T => { const start = performance.now(); try { return run(); } finally { timings[name] = (timings[name] ?? 0) + performance.now() - start; } };
    const timingSnapshot = () => {
        const total = activeElapsed();
        const measured = ['archive', 'decompressionPreflight', 'decode', 'batchValidation', 'validation'].reduce((sum, key) => sum + (timings[key] ?? 0), 0);
        return { ...timings, total, conversion: Math.max(0, total - measured), ...(progressive ? { consumerWait } : {}) };
    };
    function* emit(event: ImportEvent): Generator<ImportEvent, void, void> {
        const paused = performance.now();
        yield event;
        consumerWait += performance.now() - paused;
    }
    const warnings = new Set<string>(), document = createDocument();
    document.capacity='large';
    document.pages = []; document.pagesById = {};
    const embedded = new Map<Uint8Array, string>();
    const blobs = new Map<string, DesignImportBlob>();
    const pageAssets = new Map<string, Set<string>>();
    let currentAssets = new Set<string>(), sources: PageSource[] = [];
    const imageRef = (bytes: Uint8Array) => {
        let id = embedded.get(bytes);
        if (!id) {
            if (bytes.byteLength > 64 * 1024 * 1024) throw Error('Embedded image exceeds the 64 MiB asset limit');
            const hash = createHash('sha256').update(bytes).digest('hex'), mimeType = imageMimeType(bytes);
            id = 'design-' + hash;
            if (!document.assets?.[id]) {
                const src = options.binaryAssets ? assetRef(hash) : `data:${mimeType};base64,${Buffer.from(bytes).toString('base64')}`;
                (document.assets ??= {})[id] = {id, name: id, kind: 'image', src};
                if (options.binaryAssets) blobs.set(hash, { hash, mimeType, bytes: bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes : Uint8Array.from(bytes) });
            }
            embedded.set(bytes, id);
        }
        currentAssets.add(id);
        return {assetId: id};
    };
    let count = 0;
    const warn = (message: string) => { if (warnings.size < 40) warnings.add(message); };
    const add = (p: Page, parent: string, type: string, values: Data, matrix: Matrix) => {
        if (++count > 100000) throw Error('Design file exceeds 100000 layers');
        if (values.width < 0 || values.height < 0) throw Error('Invalid design-file dimensions');
        // Convert local transforms to world coordinates; the editor rotates around the shape center.
        const width = values.width, height = values.height;
        const cx = matrix.a * width / 2 + matrix.c * height / 2 + matrix.e, cy = matrix.b * width / 2 + matrix.d * height / 2 + matrix.f;
        const s = createShape(type, { ...values, x: cx - width / 2, y: cy - height / 2, transform: { ...matrix, e: 0, f: 0 }, rotation: Math.atan2(matrix.b, matrix.a) * 180 / Math.PI, flipY: matrix.a * matrix.d - matrix.b * matrix.c < 0, parentId: parent });
        insertShape(p, s, parent); return s;
    };
    const pathContent = (d: string, matrix: Matrix) => {
        const world = (p: { x: number; y: number }) => ({ x: matrix.a * p.x + matrix.c * p.y + matrix.e, y: matrix.b * p.x + matrix.d * p.y + matrix.f });
        return parseSvgPath(d).map(segment => {
            const p = segment.point && world(segment.point), c1 = segment.control1 && world(segment.control1), c2 = segment.control2 && world(segment.control2);
            return { command: segment.type, ...(p ?? {}), ...(c1 ? { x1: c1.x, y1: c1.y } : {}), ...(c2 ? { x2: c2.x, y2: c2.y } : {}) };
        });
    };
    if (format === 'fig') {
        const files = bytes[0] === 0x50 && bytes[1] === 0x4b ? timed('archive', () => archive(bytes)) : null;
        const binary = files ? files['canvas.fig'] : bytes;
        if (!binary || text(binary.subarray(0, 8)) !== 'fig-kiwi') throw Error('Expected a Figma Design .fig file with canvas.fig');
        // Bound inner compression too: the ZIP limit alone does not bound Kiwi chunks.
        if (binary.length < 12) throw Error('Truncated Figma header');
        const view = new DataView(binary.buffer, binary.byteOffset, binary.byteLength);
        let offset = 12, expanded = 0;
        for (let i = 0; i < 2; i++) {
            if (offset + 4 > binary.length) throw Error('Truncated Figma chunk');
            const length = view.getUint32(offset, true); offset += 4;
            if (offset + length > binary.length) throw Error('Truncated Figma chunk');
            const chunk = binary.subarray(offset, offset + length); offset += length;
            const zstd = chunk[0] === 0x28 && chunk[1] === 0xb5 && chunk[2] === 0x2f && chunk[3] === 0xfd;
            if (expanded >= EXPANDED_LIMIT) throw Error('Figma chunks exceed the expanded size limit');
            expanded += timed('decompressionPreflight', () => (zstd ? zstdDecompressSync : inflateRawSync)(chunk, {maxOutputLength: EXPANDED_LIMIT - expanded}).length);
        }
        const fig = timed('decode', () => parseFigBinary(binary));
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
            if (!key) throw Error('Figma layer has no source ID');
            if (depth > 100 || active.has(key)) throw Error('Figma layer hierarchy is cyclic or too deep');
            active.add(key);
            const t = node.transform;
            const matrix = multiply(parentMatrix, t ? {a:finite(t.m00,1),b:finite(t.m10),c:finite(t.m01),d:finite(t.m11,1),e:finite(t.m02),f:finite(t.m12)} : identity());
            let children = (fig.childrenMap.get(key) ?? []).filter(n => n.phase !== 'REMOVED').sort(positionOrder);
            if (node.type === 'INSTANCE' && !children.length) {
                const masterId = node.symbolData?.symbolID;
                if (masterId) children = (fig.childrenMap.get(`${masterId.sessionID}:${masterId.localID}`) ?? []).filter(n => n.phase !== 'REMOVED').sort(positionOrder);
                if (!children.length) warn('A Figma component instance has no available child layers.');
            }
            let type = ({ FRAME: node.resizeToFit ? 'group' : 'frame', GROUP: 'group', SYMBOL: 'frame', INSTANCE: 'group', ROUNDED_RECTANGLE: 'rect', RECTANGLE: 'rect', ELLIPSE: 'ellipse', TEXT: 'text', VECTOR: 'path', LINE: 'path', BOOLEAN_OPERATION: 'group' } as Data)[node.type];
            if (!type) { type = children.length ? 'group' : 'rect'; warn(`Unsupported Figma layer: ${node.type}`); }
            if (node.type === 'INSTANCE' || node.type === 'SYMBOL') warn('Figma components and instances are imported as ordinary layers; overrides may differ.');
            if (node.stackMode && node.stackMode !== 'NONE') warn('Auto layout is imported at its saved positions.');
            if (node.effects?.length) warn('Figma effects are not imported.');
            if (node.isMask || node.maskType) warn('Figma masks are not fully imported.');
            if (node.type === 'BOOLEAN_OPERATION') warn('Figma boolean operations are imported as editable groups.');
            if (Object.keys(node).some(key => /variable/i.test(key))) warn('Figma variable bindings are not imported.');
            if (node.blendMode && !['NORMAL', 'PASS_THROUGH'].includes(node.blendMode)) warn('Figma blend modes may differ from the source.');
            const fills = paints(node.fillPaints), values: Data = { name: node.name ?? node.type, width: finite(node.size?.x), height: finite(node.size?.y), hidden: node.visible === false, locked: node.locked === true, opacity: finite(node.opacity, 1), fills, strokes: paints(node.strokePaints).map(p => ({ ...p, width: finite(node.strokeWeight, 1) })), radii: finite(node.cornerRadius), clipContent: !node.frameMaskDisabled };
            if (type === 'text') {
                values.content = richText(node.textData?.characters ?? '', { fontFamily: node.fontName?.family ?? 'sans-serif', fontSize: finite(node.fontSize, 16), fontWeight: /bold/i.test(node.fontName?.style ?? '') ? 700 : 400, fontStyle: /italic/i.test(node.fontName?.style ?? '') ? 'italic' : 'normal', fills });
                for (const paragraph of values.content.children) paragraph.textAlign = (node.textAlignHorizontal ?? 'LEFT').toLowerCase().replace('justified', 'justify');
                values.autoResize = 'none';
                if ((node.textData as Data)?.characterStyleIDs?.length || node.derivedTextData) warn('Mixed Figma text styles may be simplified.');
            }
            const s = add(p, parent, type, values, matrix);
            s.importSource = { format: 'fig', nodeId: key, nodeType: node.type };
            if (type === 'path') {
                const geometry = resolveVectorNodePaths(fig, node);
                const d = geometry.fill.map(g => g.svgPath).join(' ') || geometry.stroke.map(g => g.svgPath).join(' ');
                if (d) { s.content = pathContent(d, matrix); s.fillRule = geometry.fill[0]?.windingRule === 'ODD' ? 'evenodd' : 'nonzero'; }
                else if (node.type === 'LINE') s.content = pathContent(`M0 0L${s.width} ${s.height}`, matrix);
                else warn('A Figma vector has no supported geometry.');
            }
            for (const child of children) visit(child, p, s.id, matrix, depth + 1);
            active.delete(key);
        };
        const canvases = fig.nodes.filter(n => n.type === 'CANVAS' && n.phase !== 'REMOVED' && !n.internalOnly).sort(positionOrder);
        if (canvases.length > 100) throw Error('Design file exceeds 100 pages');
        sources = canvases.map(n => {
            const p = createPage(n.name ?? 'Page');
            p.importSource = { format: 'fig', nodeId: nodeId(n), nodeType: 'CANVAS' };
            return { page: p, sourceId: nodeId(n) ?? undefined, convert: () => {
                for (const child of (fig.childrenMap.get(nodeId(n)!) ?? []).sort(positionOrder)) visit(child, p, 'root', identity(), 0);
            } };
        });
    } else {
        const files = timed('archive', () => archive(bytes));
        if (!files['document.json']) throw Error('Expected a Sketch 43+ ZIP document');
        const sketch = JSON.parse(text(files['document.json']));
        if (!Array.isArray(sketch.pages) || sketch.pages.length > 100) throw Error('Invalid Sketch page references');
        const symbols = new Map<string, Data>();
        let scanned = 0;
        const pages = sketch.pages.map((ref: Data) => {
            const key = `${ref._ref}.json`;
            if (!files[key]) throw Error(`Missing Sketch page: ${key}`);
            const p = JSON.parse(text(files[key]));
            const stack = [{ node: p, depth: 0 }];
            while (stack.length) {
                const { node: n, depth } = stack.pop()!;
                if (!n || typeof n !== 'object' || Array.isArray(n)) throw Error('Invalid Sketch layer');
                if (++scanned > 100000) throw Error('Sketch file exceeds 100000 layers');
                if (depth > 100) throw Error('Sketch layer hierarchy is too deep');
                if (n._class === 'symbolMaster') symbols.set(n.symbolID, n);
                if (n.layers !== undefined && !Array.isArray(n.layers)) throw Error('Invalid Sketch child layers');
                if (scanned + stack.length + (n.layers?.length ?? 0) > 100000) throw Error('Sketch file exceeds 100000 layers');
                for (const child of n.layers ?? []) stack.push({ node: child, depth: depth + 1 });
            }
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
            s.importSource = { format: 'sketch', ...(typeof n.do_objectID === 'string' ? { nodeId: n.do_objectID } : {}), nodeType: n._class ?? 'unknown' };
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
                s.content = pathContent(commands.join(' '), matrix);
            }
            let children = n.layers ?? [];
            if (n._class === 'symbolInstance') {
                const master = symbols.get(n.symbolID);
                if (master) { children = master.layers ?? []; if (width !== master.frame?.width || height !== master.frame?.height) warn('Resized Sketch symbol instances may differ from the source.'); }
                else warn('A Sketch symbol master is missing.');
            }
            for (const child of children) visit(child, p, s.id, matrix, depth + 1);
        };
        sources = pages.map((raw: Data) => {
            const p = createPage(raw.name ?? 'Page');
            return { page: p, ...(typeof raw.do_objectID === 'string' ? { sourceId: raw.do_objectID } : {}), convert: () => {
                for (const child of raw.layers ?? []) visit(child, p, 'root', identity(), 0);
            } };
        });
    }
    if (!sources.length) throw Error('Design file has no pages');
    if (progressive) yield* emit({ type: 'manifest', value: {
        format, pages: sources.map(({ page, sourceId }, index) => ({ id: page.id, name: page.name ?? 'Page', index, ...(sourceId ? { sourceId } : {}) })),
        pageCount: sources.length, timings: timingSnapshot(),
    } });
    const emittedBlobs = new Set<string>();
    let pendingPages: Page[] = [], pendingObjects = 0, completedPages = 0, sequence = 0;
    function* publish(): Generator<ImportEvent, void, void> {
        const ids = pendingPages.map(p => p.id), assets: Data = {};
        for (const id of ids) for (const assetId of pageAssets.get(id) ?? []) assets[assetId] = document.assets![assetId];
        const batchDocument = { ...document, pages: ids, pagesById: Object.fromEntries(pendingPages.map(p => [p.id, p])), assets,
            extra: { ...document.extra, importWarnings: [...warnings], importedFrom: format, importFidelity: 'unverified' } };
        timed('batchValidation', () => { validateImportedDocument(batchDocument); validateDocument(batchDocument); });
        const batchBlobs: DesignImportBlob[] = [];
        if (options.binaryAssets) for (const id of Object.keys(assets)) {
            const hash = id.slice('design-'.length);
            if (!emittedBlobs.has(hash)) { batchBlobs.push(blobs.get(hash)!); emittedBlobs.add(hash); }
        }
        completedPages += ids.length;
        if (!sequence) timings.firstPageReady = activeElapsed();
        yield* emit({ type: 'batch', value: { sequence: ++sequence, document: batchDocument, pageIds: ids,
            completedPages, totalPages: sources.length, warnings: [...warnings], ...(options.binaryAssets ? { blobs: batchBlobs } : {}), timings: timingSnapshot() } });
        pendingPages = []; pendingObjects = 0;
    }
    for (const source of sources) {
        currentAssets = new Set();
        source.convert();
        const p = source.page;
        refreshFrames(p);
        document.pages.push(p.id); document.pagesById[p.id] = p; pageAssets.set(p.id, currentAssets);
        if (!progressive) continue;
        const objects = Object.keys(p.objects).length;
        // The next complete page can reveal that a group would exceed its
        // object budget. Never split a page or its symbol/image dependencies.
        if (pendingPages.length && pendingObjects + objects > batchObjects) yield* publish();
        pendingPages.push(p); pendingObjects += objects;
        if (!sequence || pendingPages.length >= batchPages || pendingObjects >= batchObjects) yield* publish();
    }
    if (pendingPages.length) yield* publish();
    document.extra = { ...document.extra, importWarnings: [...warnings], importedFrom: format, importFidelity: 'unverified' };
    timed('validation', () => { validateImportedDocument(document); validateDocument(document); });
    if (progressive) return { complete: true, pageCount: document.pages.length, objectCount: count + document.pages.length,
        assetCount: Object.keys(document.assets ?? {}).length, warnings: [...warnings], timings: timingSnapshot() };
    return { document, warnings: [...warnings], ...(options.binaryAssets ? { blobs: [...blobs.values()] } : {}), timings: timingSnapshot() };
}
