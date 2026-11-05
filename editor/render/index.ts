import type { Data, EditorStore, Measured, Rect, RenderView, Shape } from '../contracts';
import { SceneWriter, boundsOf, textHTML, num, shapePath, type TextFragment } from './scene';
export { shapePath, boundsOf, textHTML, SceneWriter } from './scene';
export type { SceneOptions } from './scene';
export type { TextFragment } from './scene';
import { combinePaths } from './vector';
import { measureTextScene } from './text';
import { textMetricRevision } from './metric-cache';
export { measureTextScene } from './text';
export { combinePaths } from './vector';
let thumbnailNamespace = 0;
export function createRenderer(editor: EditorStore, stage: HTMLElement, options: Data = {}): RenderView {
    const scene = document.createElement('div');
    scene.className = 'canvas-scene';
    scene.id = 'view';
    Object.assign(scene.style, { position: 'absolute', inset: '0', pointerEvents: 'none', overflow: 'visible' });
    stage.append(scene);
    const measurements = document.createElement('div');
    measurements.setAttribute('aria-hidden', 'true');
    Object.assign(measurements.style, {
        position: 'fixed', left: '-100000px', top: '0', visibility: 'hidden', pointerEvents: 'none', contain: 'layout style', width: 'max-content'
    });
    document.body.append(measurements);
    const fragments = new Map<string, TextFragment[]>(), textSizes = new Map<string, {
        width: number;
        height: number;
        scrollWidth: number;
        scrollHeight: number;
    }>(), images = new Map<string, {
        promise: Promise<void>;
        failed: boolean;
    }>();
    const renderListeners = new Set<() => void>();
    let destroyed = false, revision = 0, settling: Promise<void> | undefined;
    const booleans = new Map<string, {
        signature: string;
        promise: Promise<void>;
        content?: Data[];
        bounds?: Rect;
        fillRule?: string;
        error?: unknown;
    }>();
    function resolvedObjects() {
        const result = { ...editor.page.objects };
        for (const [id, entry] of booleans)
            if (result[id] && entry.content)
                result[id] = {
                    ...result[id], ...(entry.bounds ? { ...entry.bounds, box: { ...entry.bounds }, corners: [{ x: entry.bounds.x, y: entry.bounds.y }, { x: entry.bounds.x + entry.bounds.width, y: entry.bounds.y }, { x: entry.bounds.x + entry.bounds.width, y: entry.bounds.y + entry.bounds.height }, { x: entry.bounds.x, y: entry.bounds.y + entry.bounds.height }] } : {}), content: entry.content, fillRule: entry.fillRule, transform: {
                        a: 1, b: 0, c: 0, d: 1, e: 0, f: 0
                    }, inverseTransform: {
                        a: 1, b: 0, c: 0, d: 1, e: 0, f: 0
                    }, rotation: 0
                };
        return result;
    }
    function discoverBooleans() {
        const objects = editor.page.objects;
        const signature = (shape: Shape): any[] => [shape.booleanOperation ?? shape.operation, shapePath(shape), shape.transform, shape.fillRule, shape.hidden, (shape.childIds ?? []).map(id => objects[id] ? signature(objects[id]) : null)];
        for (const shape of Object.values(objects)) {
            if (shape.type !== 'boolean' || !shape.childIds?.length)
                continue;
            const key = JSON.stringify(signature(shape));
            if (booleans.get(shape.id)?.signature === key)
                continue;
            const entry: {
                signature: string;
                promise: Promise<void>;
                content?: Data[];
                bounds?: Rect;
                fillRule?: string;
                error?: unknown;
            } = { signature: key, promise: Promise.resolve() };
            booleans.set(shape.id, entry);
            entry.promise = (async () => {
                const operands = shape.childIds!.map(id => objects[id]).filter(child => child && !child.hidden);
                if (!operands.length) {
                    entry.content = [];
                    entry.fillRule = 'nonzero';
                    if (!destroyed)
                        render();
                    return;
                }
                const operation = shape.booleanOperation ?? shape.operation ?? 'union';
                const result = await combinePaths(operands, operation, { wasmUrl: options.wasmUrl, objects });
                entry.content = result.segments;
                entry.bounds = result.bounds;
                entry.fillRule = result.fillRule;
                if (!destroyed)
                    render();
            })().catch(error => {
                entry.error = error;
            });
        }
        for (const id of booleans.keys())
            if (!objects[id])
                booleans.delete(id);
    }
    function roots() {
        const root = editor.page.objects.root;
        return root?.childIds ?? Object.values(editor.page.objects).filter(s => s.parentId === 'root' && s.id !== 'root').map(s => s.id);
    }
    function imageSource(s: Shape) {
        return [s.image?.src, ...(s.fills ?? []).filter((p: Data) => p.type === 'image' || p.image).map((p: Data) => p.image?.src ?? p.image?.id ?? p.src)].filter(Boolean) as string[];
    }
    function discoverImages() {
        for (const s of Object.values(editor.page.objects))
            for (const src of imageSource(s)) {
                if (images.has(src))
                    continue;
                const record = { promise: Promise.resolve(), failed: false };
                record.promise = new Promise<void>(resolve => {
                    const image = new Image();
                    let complete = false;
                    const finish = (failed: boolean) => {
                        if (complete)
                            return;
                        complete = true;
                        clearTimeout(timer);
                        record.failed = failed;
                        resolve();
                    };
                    const timer = setTimeout(() => finish(true), 15000);
                    image.onload = () => {
                        image.decode().then(() => finish(false), () => finish(true));
                    };
                    image.onerror = () => finish(true);
                    image.src = src;
                    if (image.complete)
                        finish(!image.naturalWidth);
                });
                images.set(src, record);
            }
    }
    let previousTextKey = '', fontRevision = 0;
    function measureText() {
        const key = fontRevision + ":" + textMetricRevision() + JSON.stringify(Object.values(editor.page.objects).filter(shape => shape.type === 'text'));
        if (key === previousTextKey)
            return;
        previousTextKey = key;
        const measured = measureTextScene(editor.page.objects, measurements, options);
        fragments.clear();
        for (const [id, list] of measured.fragments)
            fragments.set(id, list);
        textSizes.clear();
        for (const [id, size] of measured.textSizes)
            textSizes.set(id, size);
    }
    let renderedOutlines = !!editor.showOutlines, lastZoom = editor.viewport.zoom;
    function updateViewport() {
        const svg = scene.firstElementChild as SVGSVGElement | null;
        if (!svg)
            return;
        const vp = editor.viewport;
        svg.setAttribute('viewBox', `${vp.vbox.x} ${vp.vbox.y} ${vp.vport.width / vp.zoom} ${vp.vport.height / vp.zoom}`);
        svg.style.width = '100%';
        svg.style.height = '100%';
        svg.style.overflow = 'visible';
        svg.setAttribute('preserveAspectRatio', 'none');
        if (editor.showOutlines && lastZoom !== vp.zoom)
            for (const path of svg.querySelectorAll('[stroke="#6366f1"]'))
                path.setAttribute('stroke-width', String(1 / vp.zoom));
        lastZoom = vp.zoom;
        for (const listener of renderListeners)
            listener();
    }
    function render() {
        const phaseStart = performance.now();
        if (destroyed)
            return;
        revision++;
        discoverImages();
        discoverBooleans();
        measureText();
        options.onTiming?.({ phase: 'render.measureText', ms: performance.now() - phaseStart });
        renderedOutlines = !!editor.showOutlines;
        const vp = editor.viewport, bounds = { x: vp.vbox.x, y: vp.vbox.y, width: vp.vport.width / vp.zoom, height: vp.vport.height / vp.zoom };
        const svgStart = performance.now();
        const source = new SceneWriter(resolvedObjects(), { textFragments: fragments, typography: options, outlines: renderedOutlines, outlineWidth: 1 / vp.zoom }).svg(roots(), bounds);
        options.onTiming?.({ phase: 'render.serializeSvg', ms: performance.now() - svgStart, bytes: source.length });
        const domStart = performance.now();
        scene.innerHTML = source;
        options.onTiming?.({ phase: 'render.attachSvg', ms: performance.now() - domStart });
        updateViewport();
    }
    async function settled() {
        if (settling)
            return settling;
        settling = (async () => {
            let stable = false;
            for (let attempt = 0; attempt < 4; attempt++) {
                const start = revision;
                discoverImages();
                discoverBooleans();
                const text = Object.values(editor.page.objects).filter(s => s.type === 'text').map(s => typeof s.content === 'string' ? s.content : JSON.stringify(s.content ?? s.text ?? '')).join('');
                await bounded(options.fonts?.ensure ? options.fonts.ensure(text) : document.fonts.ready, 15000);
                await Promise.all([...images.values()].map(i => i.promise));
                await bounded(Promise.all([...booleans.values()].map(entry => entry.promise)), 20000);
                for (const entry of booleans.values())
                    if (entry.error)
                        throw new Error('Boolean geometry could not be computed', { cause: entry.error });
                render();
                await new Promise<void>(resolve => setTimeout(resolve, 0));
                if (start + 1 === revision) {
                    stable = true;
                    break;
                }
            }
            if (!stable)
                throw new Error('Scene kept changing while waiting for settled layout');
        })().finally(() => {
            settling = undefined;
        });
        return settling;
    }
    function measure(ids: string[]) {
        const result = new Map<string, Measured>();
        for (const id of ids) {
            const s = resolvedObjects()[id];
            if (!s)
                continue;
            let b = boundsOf([s]);
            const element = scene.querySelector(`[data-shape-id="${CSS.escape(id)}"]`);
            if (!element)
                continue;
            if (element) {
                const r = (element.querySelector('[data-geometry]') ?? element).getBoundingClientRect(), origin = stage.getBoundingClientRect(), zoom = editor.viewport.zoom;
                if (r.width || r.height) {
                    const matrix = (scene.firstElementChild as SVGSVGElement).getScreenCTM();
                    if (matrix) {
                        const inverse = matrix.inverse(), a = new DOMPoint(r.x, r.y).matrixTransform(inverse), z = new DOMPoint(r.right, r.bottom).matrixTransform(inverse);
                        b = { x: a.x, y: a.y, width: z.x - a.x, height: z.y - a.y };
                    }
                    else
                        b = { x: editor.viewport.vbox.x + (r.x - origin.x) / zoom, y: editor.viewport.vbox.y + (r.y - origin.y) / zoom, width: r.width / zoom, height: r.height / zoom };
                }
            }
            const t = textSizes.get(id);
            const parent = editor.page.objects[s.parentId];
            const pb = parent ? boundsOf([parent]) : undefined;
            const fallback = s.type === 'text' ? fontFallback(s, options) : undefined;
            result.set(id, {
                x: b.x, y: b.y, w: b.width, h: b.height, scrollW: t?.scrollWidth ?? b.width, scrollH: t?.scrollHeight ?? b.height, clippedText: !!t && (t.scrollHeight > s.height + .5 || t.scrollWidth > s.width + .5), overflowParent: !!pb && parent?.id !== 'root' && (b.x < pb.x || b.y < pb.y || b.x + b.width > pb.x + pb.width || b.y + b.height > pb.y + pb.height), ...(fallback ? { fontFallback: fallback } : {}), ...(imageSource(s).some(src => images.get(src)?.failed) ? { imageFailed: true } : {})
            });
        }
        return result;
    }
    const thumbnailCache = new Map<string, {
        signature: string;
        promise: Promise<string>;
    }>();
    async function thumbnailSvg(pageId: string, id: string): Promise<string> {
        if (destroyed)
            throw new Error('Renderer is destroyed');
        const page = editor.doc.pagesById[pageId];
        if (!page?.objects[id])
            throw new Error(`Unknown thumbnail source: ${pageId}/${id}`);
        const objects: Record<string, Shape> = {};
        const collect = (shapeId: string) => {
            if (objects[shapeId])
                return;
            const shape = page.objects[shapeId];
            if (!shape)
                throw new Error(`Missing thumbnail descendant: ${shapeId}`);
            objects[shapeId] = shape;
            for (const child of shape.childIds ?? [])
                collect(child);
        };
        collect(id);
        const key = pageId + '\0' + id, signature = fontRevision + ":" + textMetricRevision() + JSON.stringify(objects), cached = thumbnailCache.get(key);
        if (cached?.signature === signature)
            return cached.promise;
        const promise = (async () => {
            const text = Object.values(objects).filter(shape => shape.type === 'text').flatMap(shape => (shape.content?.children ?? []).flatMap((paragraph: Data) => (paragraph.children ?? []).map((run: Data) => run.text ?? ''))).join('');
            await bounded(options.fonts?.ensure?.(text) ?? document.fonts.ready, 15000);
            const resolve = async (shapeId: string): Promise<void> => {
                const shape = objects[shapeId];
                for (const child of shape.childIds ?? [])
                    await resolve(child);
                if (shape.type === 'boolean' && shape.childIds?.length) {
                    const operands = shape.childIds.map(child => objects[child]).filter(child => !child.hidden);
                    if (!operands.length) {
                        objects[shapeId] = { ...shape, content: [] };
                        return;
                    }
                    const result = await combinePaths(operands, shape.booleanOperation ?? shape.operation ?? 'union', { wasmUrl: options.wasmUrl, objects });
                    objects[shapeId] = {
                        ...shape, ...result.bounds, box: { ...result.bounds }, corners: [{ x: result.bounds.x, y: result.bounds.y }, { x: result.bounds.x + result.bounds.width, y: result.bounds.y }, { x: result.bounds.x + result.bounds.width, y: result.bounds.y + result.bounds.height }, { x: result.bounds.x, y: result.bounds.y + result.bounds.height }], content: result.segments, rotation: 0, transform: {
                            a: 1, b: 0, c: 0, d: 1, e: 0, f: 0
                        }, inverseTransform: {
                            a: 1, b: 0, c: 0, d: 1, e: 0, f: 0
                        }
                    };
                }
            };
            await bounded(resolve(id), 20000);
            if (destroyed)
                throw new Error('Renderer is destroyed');
            const holder = document.createElement('div');
            Object.assign(holder.style, {
                position: 'fixed', left: '-100000px', top: '0', visibility: 'hidden', pointerEvents: 'none', contain: 'layout style', width: 'max-content'
            });
            document.body.append(holder);
            try {
                const measured = measureTextScene(objects, holder, options), bounds = boundsOf([objects[id]]);
                return new SceneWriter(objects, { textFragments: measured.fragments, typography: options, idPrefix: 'omc-thumb-' + (++thumbnailNamespace) }).svg([id], bounds);
            }
            finally {
                holder.remove();
            }
        })();
        thumbnailCache.set(key, { signature, promise });
        if (thumbnailCache.size > 200)
            thumbnailCache.delete(thumbnailCache.keys().next().value!);
        promise.catch(() => {
            if (thumbnailCache.get(key)?.promise === promise)
                thumbnailCache.delete(key);
        });
        return promise;
    }
    const view: RenderView = {
        thumbnailSvg,
        onRender(listener: () => void) {
            renderListeners.add(listener);
            return () => renderListeners.delete(listener);
        },
        textFragments(id: string) {
            return (fragments.get(id) ?? []).map(fragment => ({ ...fragment, style: { ...fragment.style } }));
        },
        render, settled, measure, computedStyle(id, keys) {
            const s = resolvedObjects()[id];
            if (!s)
                return {};
            const group = scene.querySelector(`[data-shape-id="${CSS.escape(id)}"]`);
            const el = group?.querySelector('[data-run]') ?? group?.querySelector('path:not([data-geometry]),image,svg') ?? group;
            if (!el)
                return {};
            const style = getComputedStyle(el);
            const derived: Record<string, string> = {
                width: s.width + 'px', height: s.height + 'px', left: s.x + 'px', top: s.y + 'px', opacity: String(s.opacity ?? 1), display: s.layout?.type === 'flex' ? 'flex' : s.layout?.type === 'grid' ? 'grid' : 'block', ...(s.layout?.direction ? { 'flex-direction': s.layout.direction } : {})
            };
            if (s.fills?.[0]?.color)
                derived['background-color'] = s.fills[0].color;
            const selected = keys ?? ['fill', 'stroke', 'opacity', 'font-family', 'font-size', 'font-weight', 'font-style', 'line-height', 'letter-spacing', 'color', 'mix-blend-mode'];
            return Object.fromEntries(selected.map(k => [k, derived[k] ?? style.getPropertyValue(k)]));
        }, element(id) {
            return scene.querySelector<HTMLElement>(`[data-shape-id="${CSS.escape(id)}"]`);
        }, sceneSvg(ids?: string[], opts: Data = {}) {
            const chosen = ids?.length ? ids : roots();
            const bounds = opts.bounds ?? boundsOf(chosen.map(id => resolvedObjects()[id]).filter(Boolean));
            return new SceneWriter(resolvedObjects(), { ...opts, exporting: true, textFragments: fragments }).svg(chosen, bounds);
        }, bounds(ids: string[]) {
            return boundsOf(ids.map(id => resolvedObjects()[id]).filter(Boolean));
        }, projectedShape(id: string) {
            return resolvedObjects()[id];
        }, textLines(id: string) {
            return (fragments.get(id)??[]).map(fragment=>({...fragment,style:{...fragment.style}}));
        }, textSize(id: string) {
            const size=textSizes.get(id);return size?{...size}:undefined;
        }, async screenshot(id, opts = {}) {
            await settled();
            let board = editor.selection[0];
            while (board && editor.page.objects[board]?.parentId !== 'root' && editor.page.objects[board]?.parentId !== board)
                board = editor.page.objects[board]?.parentId;
            const chosen = id ?? (board && editor.page.objects[board]?.type === 'frame' ? board : undefined) ?? roots().find(id => editor.page.objects[id]?.type === 'frame') ?? roots()[0];
            if (!chosen)
                throw new Error('No layer available for screenshot');
            const b = boundsOf([resolvedObjects()[chosen]]);
            let scale = 1, slices = 1;
            if (opts.mode === 'overview')
                scale = Math.min(1, Math.sqrt(340000 / (b.width * b.height)));
            else {
                const height = 1568, step = height - 120;
                slices = Math.max(1, Math.ceil(Math.max(0, b.height - 120) / step));
                const slice = Math.max(0, Math.min(slices - 1, num(opts.slice)));
                b.y += slice * step;
                b.height = Math.min(height, b.height - slice * step);
            }
            const { rasterizeSVG } = await import('../export/raster');
            let source = view.sceneSvg([chosen], { bounds: b });
            const css = await options.fonts?.embeddedCss?.();
            if (css)
                source = source.replace('<defs>', '<defs><style>' + css.replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</style>');
            const blob = await rasterizeSVG(source, b, scale, 'image/png');
            const data = await blobBase64(blob);
            return { data, mimeType: 'image/png', slices };
        }, destroy() {
            destroyed = true;
            off();
            scene.remove();
            measurements.remove();
            renderListeners.clear();
            thumbnailCache.clear();
            images.clear();
            booleans.clear();
            fragments.clear();
            textSizes.clear();
        }
    };
    const off = editor.on(event => {
        if (event.changes || event.deltas || event.projection || event.page || renderedOutlines !== !!editor.showOutlines)
            render();
        else if (event.viewport)
            updateViewport();
    });
    const loaded = () => {
        fontRevision++;
        if (!destroyed)
            render();
    };
    document.fonts.addEventListener('loadingdone', loaded);
    const destroy = view.destroy;
    view.destroy = () => {
        document.fonts.removeEventListener('loadingdone', loaded);
        destroy();
    };
    render();
    return view;
}
async function bounded(promise: Promise<any>, ms: number) {
    let timer: ReturnType<typeof setTimeout>;
    await Promise.race([promise, new Promise<void>((_, reject) => {
            timer = setTimeout(() => reject(new Error('Rendering resources did not settle within the time limit')), ms);
        })]).finally(() => clearTimeout(timer));
}
function fontFallback(shape: Shape, options: Data) {
    const requested = [shape.fontFamily ?? options.defaultFamily, ...(shape.content?.children ?? []).flatMap((paragraph: Data) => (paragraph.children ?? []).map((run: Data) => run.fontFamily))].filter(Boolean) as string[];
    const catalog: Data[] = options.fonts?.catalog?.() ?? [];
    const generic = new Set(['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'ui-serif', 'ui-sans-serif', 'ui-monospace', 'ui-rounded', 'emoji', 'math', 'fangsong']);
    const canvas = document.createElement('canvas'), context = canvas.getContext('2d');
    const available = (family: string) => {
        if (generic.has(family.toLowerCase()))
            return true;
        const registered = catalog.find(group => group.family === family);
        if (registered)
            return registered.faces.some((face: Data) => face.status === 'loaded') && document.fonts.check(`16px ${JSON.stringify(family)}`);
        if (!context)
            return false;
        const sample = 'BESbswy 0123456789 abcxyz';
        return ['monospace', 'serif'].some(base => {
            context.font = `72px ${base}`;
            const fallback = context.measureText(sample).width;
            context.font = `72px ${JSON.stringify(family)},${base}`;
            return Math.abs(context.measureText(sample).width - fallback) > .01;
        });
    };
    return requested.some(family => !available(family)) ? (options.fallbacks ?? ['sans-serif']).join(', ') : undefined;
}
async function blobBase64(blob: Blob) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = '';
    for (let i = 0; i < bytes.length; i += 8192)
        binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
    return btoa(binary);
}
