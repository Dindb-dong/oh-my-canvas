import {imageSource as assetSource} from '../images/assets';
import type { Data, EditorStore, Measured, Rect, RenderView, Shape } from '../contracts';
import { SceneWriter, boundsOf, textHTML, num, shapePath, type TextFragment } from './scene';
export { shapePath, boundsOf, textHTML, SceneWriter } from './scene';
export type { SceneOptions } from './scene';
export type { TextFragment } from './scene';
import { combinePaths } from './vector';
import { measureTextScene } from './text';
import { textMetricRevision } from './metric-cache';
import { SceneNodeCache, sceneChanges, parseScene, reconcileScene, resourceScope } from './retained';
import { hasBackdropDependency, ViewportPreparation, type ViewportChanges } from './viewport';
export { measureTextScene } from './text';
export { combinePaths } from './vector';
let thumbnailNamespace = 0;
let sceneNamespace = 0;
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
    let visualRevision = 0, booleanRevision = 0, pendingRender = false, cancelScheduled: (() => void) | undefined;
    const nodeCache = new SceneNodeCache(), scenePrefix = 'omc-view-' + (++sceneNamespace);
    const preparation = new ViewportPreparation();
    let preparedPage = '', preparedSource: Record<string, Shape> | undefined;
    let observedPage = editor.pageId, observedSource = editor.page.objects;
    let pendingShapeIds: Set<string> | undefined = new Set();
    const viewportBounds = () => ({ x: editor.viewport.vbox.x, y: editor.viewport.vbox.y, width: editor.viewport.vport.width / editor.viewport.zoom, height: editor.viewport.vport.height / editor.viewport.zoom });
    function prepareScreen() {
        const source = editor.page.objects, pageId = editor.pageId;
        const changes: ViewportChanges | undefined = pendingShapeIds && preparedSource && preparedPage === pageId && observedPage === pageId && observedSource === source ?
            { before: preparedSource, after: source, ids: pendingShapeIds } : undefined;
        const changed = preparation.update(source, viewportBounds(), editor.selection, changes);
        preparedPage = observedPage = pageId; preparedSource = observedSource = source;
        pendingShapeIds = new Set();
        return changed;
    }
    const screenObjects = () => preparation.objects;
    const resolveImageSource = (source: string): string => options.resolveImageSource?.(source) ?? source;
    function resourceVisible(shape: Shape, objects: Record<string, Shape>, cache: Map<string, boolean>, seen = new Set<string>()): boolean {
        if (cache.has(shape.id)) return cache.get(shape.id)!;
        if (seen.has(shape.id)) return false;
        seen.add(shape.id);
        const parent = objects[shape.parentId];
        const visible = !shape.hidden && shape.visible !== false && (!parent || parent.id === shape.id || resourceVisible(parent, objects, cache, seen));
        cache.set(shape.id, visible);
        return visible;
    }
    let renderedObjects: Record<string, Shape> | undefined, renderedPage = '', renderedKey = '';
    let previousImages: Record<string, Shape> | undefined, previousBooleans: Record<string, Shape> | undefined;
    let resolvedSource: Record<string, Shape> | undefined, resolvedRevision = -1, resolved: Record<string, Shape>;
    const booleanProjections = new Map<string, { source: Shape; content: Data[]; shape: Shape }>();
    let lastRender = { mode: 'full', generatedNodes: 0, cachedNodes: 0, changedNodes: 0 };
    const booleans = new Map<string, {
        signature: string;
        promise: Promise<void>;
        content?: Data[];
        bounds?: Rect;
        fillRule?: string;
        error?: unknown;
    }>();
    function resolvedObjects() {
        if (resolvedSource === editor.page.objects && resolvedRevision === booleanRevision) return resolved;
        const result = { ...editor.page.objects };
        for (const [id, entry] of booleans)
            if (result[id] && entry.content) {
                const source = result[id], previous = booleanProjections.get(id);
                if (previous?.source === source && previous.content === entry.content) { result[id] = previous.shape; continue; }
                result[id] = {
                    ...result[id], ...(entry.bounds ? { ...entry.bounds, box: { ...entry.bounds }, corners: [{ x: entry.bounds.x, y: entry.bounds.y }, { x: entry.bounds.x + entry.bounds.width, y: entry.bounds.y }, { x: entry.bounds.x + entry.bounds.width, y: entry.bounds.y + entry.bounds.height }, { x: entry.bounds.x, y: entry.bounds.y + entry.bounds.height }] } : {}), content: entry.content, fillRule: entry.fillRule, transform: {
                        a: 1, b: 0, c: 0, d: 1, e: 0, f: 0
                    }, inverseTransform: {
                        a: 1, b: 0, c: 0, d: 1, e: 0, f: 0
                    }, rotation: 0
                };
                booleanProjections.set(id, { source, content: entry.content, shape: result[id] });
            }
        for (const id of booleanProjections.keys()) if (!booleans.get(id)?.content || !result[id]) booleanProjections.delete(id);
        resolvedSource = editor.page.objects; resolvedRevision = booleanRevision; resolved = result;
        return result;
    }
    function discoverBooleans(objects = screenObjects()) {
        if (previousBooleans === objects) return;
        previousBooleans = objects;
        const visibility = new Map<string, boolean>();
        const signature = (shape: Shape): any[] => [shape.booleanOperation ?? shape.operation, shapePath(shape), shape.transform, shape.fillRule, shape.hidden, (shape.childIds ?? []).map(id => objects[id] ? signature(objects[id]) : null)];
        for (const shape of Object.values(objects)) {
            if (shape.type !== 'boolean' || !shape.childIds?.length || !resourceVisible(shape, objects, visibility))
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
                    booleanRevision++;
                    return;
                }
                const operation = shape.booleanOperation ?? shape.operation ?? 'union';
                const result = await combinePaths(operands, operation, { wasmUrl: options.wasmUrl, objects });
                if (destroyed || booleans.get(shape.id) !== entry) return;
                entry.content = result.segments;
                entry.bounds = result.bounds;
                entry.fillRule = result.fillRule;
                booleanRevision++;
                requestRender();
            })().catch(error => {
                entry.error = error;
            });
        }
        for (const id of booleans.keys())
            if (!editor.page.objects[id] || editor.page.objects[id].type !== 'boolean' || !editor.page.objects[id].childIds?.length) {
                booleans.delete(id);
                booleanRevision++;
            }
    }
    function roots() {
        const root = editor.page.objects.root;
        return root?.childIds ?? Object.values(editor.page.objects).filter(s => s.parentId === 'root' && s.id !== 'root').map(s => s.id);
    }
    let visibleSource: Record<string, Shape> | undefined, visible: Shape[] = [];
    function visibleShapes() {
        const objects = editor.page.objects;
        if (visibleSource === objects) return visible;
        visibleSource = objects; visible = [];
        const seen = new Set<string>(), stack = [...roots()].reverse();
        while (stack.length) {
            const id = stack.pop()!, shape = objects[id];
            if (!shape || seen.has(id)) continue;
            seen.add(id);
            if (shape.hidden || shape.visible === false) continue;
            visible.push(shape); stack.push(...[...shape.childIds ?? []].reverse());
        }
        return visible;
    }
    let previousAssets=editor.doc.assets,assetRevision=0;
    const assetUrls=new Map<string,{src:string;url:string}>();
    function displaySource(image: Data) {
        const src=assetSource(image,editor.doc.assets);
        if (!image.assetId || !src.startsWith('data:')) return src;
        const old=assetUrls.get(image.assetId);
        if(old?.src===src)return old.url;
        if(old)URL.revokeObjectURL(old.url);
        const comma = src.indexOf(','), header = src.slice(5, comma);
        let bytes: Uint8Array;
        try {
            if (header.endsWith(';base64')) {
                const decoded = atob(src.slice(comma + 1)); bytes = Uint8Array.from(decoded, character => character.charCodeAt(0));
            } else bytes = new TextEncoder().encode(decodeURIComponent(src.slice(comma + 1)));
        } catch { return src; }
        const url=URL.createObjectURL(new Blob([bytes as BlobPart],{type:header.split(';')[0]}));
        assetUrls.set(image.assetId,{src,url});return url;
    }
    function imageSource(s: Shape) {
        return [s.image ? displaySource(s.image) : '', ...(s.fills ?? []).filter((p: Data) => p.type === 'image' || p.image).map((p: Data) => displaySource(p.image ?? p))].filter(Boolean);
    }
    function discoverImages(objects = screenObjects()) {
        if(previousAssets!==editor.doc.assets){previousAssets=editor.doc.assets;assetRevision++;previousImages=undefined;images.clear();}
        if (previousImages === objects) return;
        previousImages = objects;
        const active = new Set<string>();
        const visibility = new Map<string, boolean>();
        for (const s of Object.values(objects)) {
            if (!resourceVisible(s, objects, visibility)) continue;
            for (const src of imageSource(s)) {
                active.add(src);
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
                    image.src = resolveImageSource(src);
                    if (image.complete)
                        finish(!image.naturalWidth);
                });
                images.set(src, record);
            }
        }
        for (const src of images.keys()) if (!active.has(src)) images.delete(src);
        for(const [id,entry] of assetUrls)if(!active.has(entry.url)){URL.revokeObjectURL(entry.url);assetUrls.delete(id);}
    }
    let fontRevision = 0, measuredMetricRevision = -1, measuredFontRevision = -1;
    const measuredText = new Map<string, Shape>();
    function measureText(objects = screenObjects()) {
        const all = measuredMetricRevision !== textMetricRevision() || measuredFontRevision !== fontRevision;
        if (all) measuredText.clear();
        const changed: Record<string, Shape> = {}, live = new Set<string>();
        const visibility = new Map<string, boolean>();
        for (const shape of Object.values(objects)) {
            if (shape.type !== 'text' || !resourceVisible(shape, editor.page.objects, visibility)) continue;
            live.add(shape.id);
            if (all || measuredText.get(shape.id) !== shape) changed[shape.id] = shape;
        }
        for (const id of measuredText.keys()) if (!editor.page.objects[id]) {
            measuredText.delete(id); fragments.delete(id); textSizes.delete(id);
        }
        if (!Object.keys(changed).length) { measuredMetricRevision = textMetricRevision(); measuredFontRevision = fontRevision; return; }
        const measured = measureTextScene(changed, measurements, { ...options, assets: editor.doc.assets, resolveImageSource });
        for (const shape of Object.values(changed)) measuredText.set(shape.id, shape);
        measuredMetricRevision = textMetricRevision(); measuredFontRevision = fontRevision;
        for (const [id, list] of measured.fragments)
            fragments.set(id, list);
        for (const [id, size] of measured.textSizes)
            textSizes.set(id, size);
    }
    let renderedOutlines = !!editor.showOutlines, lastZoom = editor.viewport.zoom;
    function layerElement(id: string): Element | null {
        const svg = scene.firstElementChild;
        if (!svg) return null;
        // Imported pictures own nested SVG trees and may repeat document IDs in
        // their attributes. Only the outer scene contains generated layer groups.
        for (const element of svg.querySelectorAll(`[data-shape-id="${CSS.escape(id)}"]`))
            if (element.closest('svg') === svg) return element;
        return null;
    }
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
        visualRevision++;
        for (const listener of renderListeners)
            listener();
    }
    function render() {
        const phaseStart = performance.now();
        if (destroyed)
            return;
        cancelScheduled?.(); cancelScheduled = undefined; pendingRender = false;
        revision++;
        prepareScreen();
        discoverImages();
        discoverBooleans();
        measureText();
        options.onTiming?.({ phase: 'render.measureText', ms: performance.now() - phaseStart });
        renderedOutlines = !!editor.showOutlines;
        const vp = editor.viewport, bounds = { x: vp.vbox.x, y: vp.vbox.y, width: vp.vport.width / vp.zoom, height: vp.vport.height / vp.zoom };
        const svgStart = performance.now();
        const projected = resolvedObjects(), objects = preparation.objects === editor.page.objects ? projected : Object.fromEntries(Object.keys(preparation.objects).map(id => [id, projected[id]])), key = `${editor.pageId}:${assetRevision}:${fontRevision}:${measuredMetricRevision}:${renderedOutlines}:${renderedOutlines ? 1 / vp.zoom : ''}`;
        // Backdrop blur reads earlier siblings, so its invalidation is deliberately
        // scene-wide until dependency-aware compositing has its own parity coverage.
        const backdrop = Object.values(objects).some(hasBackdropDependency);
        const reset = key !== renderedKey || renderedPage !== editor.pageId || backdrop;
        const changes = sceneChanges(renderedObjects, objects);
        if (!reset && !changes.changed.size && scene.firstElementChild) {
            lastRender = { mode: 'unchanged', generatedNodes: 0, cachedNodes: 0, changedNodes: 0 };
            updateViewport();
            return;
        }
        if (reset) nodeCache.clear(); else nodeCache.invalidate(changes.affected);
        const writer = new SceneWriter(objects, { assets: editor.doc.assets, imageSource: displaySource, textFragments: fragments, typography: options, resolveImageSource, outlines: renderedOutlines, outlineWidth: 1 / vp.zoom, idPrefix: scenePrefix, stableIds: true, ...(!backdrop ? { nodeCache } : {}) });
        const svg = scene.firstElementChild as SVGSVGElement | null;
        const maskAncestor = (id: string) => {
            const seen = new Set<string>();
            let shape = objects[id];
            while (shape && !seen.has(shape.id)) {
                seen.add(shape.id);
                if (shape.isMaskGroup || shape.maskType || shape.maskMode || shape.mask?.mode) return true;
                if (shape.parentId === shape.id) break;
                shape = objects[shape.parentId];
            }
            return false;
        };
        // A leaf edit does not require parsing its unchanged siblings or parent.
        // Structural edits and compositing dependencies take the retained full path.
        const leafEdit = !reset && !!svg && changes.changed.size > 0 && [...changes.changed].every(id => {
            const old = renderedObjects?.[id], next = objects[id];
            return old && next && old.parentId === next.parentId && !old.childIds?.length && !next.childIds?.length && !old.hidden && old.visible !== false && !next.hidden && next.visible !== false && !maskAncestor(id) && !!layerElement(id);
        });
        let bytes = 0, attachMs = 0;
        if (leafEdit) {
            const definitions = svg!.querySelector('defs')!;
            const resources = new Map(Array.from(definitions.children).map(node => [node.id, node]));
            for (const id of changes.changed) {
                // The bounded serialization cache can evict a leaf in a large scene.
                // Stable resource scopes let the live DOM remain the authority for
                // its old definitions, so eviction never turns a leaf edit into a
                // full-scene parse or requires retaining another source snapshot.
                const prefix = scenePrefix + '-' + resourceScope(id) + '-';
                const previousIds = [...resources.keys()].filter(resource => resource.startsWith(prefix));
                const source = writer.node(objects[id]), record = nodeCache.get(id + '\0shape');
                // Oversized entries may be intentionally absent from the bounded cache.
                const defs = record?.defs ?? writer.defs;
                bytes += source.length + defs.reduce((sum, value) => sum + value.length, 0);
                const domStart = performance.now();
                const patch = parseScene(`<svg xmlns="http://www.w3.org/2000/svg"><defs>${defs.join('')}</defs>${source}</svg>`);
                const next = patch.lastElementChild!, current = layerElement(id);
                if (!current) throw new Error('Retained scene lost an edited layer');
                reconcileScene(current, next);
                const nextDefinitions = Array.from(patch.firstElementChild!.children), nextIds = new Set(nextDefinitions.map(node => node.id));
                for (const resource of previousIds) {
                    if (!nextIds.has(resource)) { resources.get(resource)?.remove(); resources.delete(resource); }
                }
                for (const node of nextDefinitions) {
                    const previous = resources.get(node.id);
                    if (previous) reconcileScene(previous, node);
                    else { definitions.append(node); resources.set(node.id, node); }
                }
                attachMs += performance.now() - domStart;
                writer.defs.length = 0;
            }
        } else {
            const source = writer.svg(preparation.roots, bounds); bytes = source.length;
            const domStart = performance.now(), next = parseScene(source);
            if (svg && renderedPage === editor.pageId) reconcileScene(svg, next, reset ? undefined : changes.affected);
            else scene.replaceChildren(next);
            attachMs = performance.now() - domStart;
        }
        lastRender = { mode: leafEdit ? 'leaf' : 'full', generatedNodes: writer.generatedNodes, cachedNodes: writer.cachedNodes, changedNodes: changes.changed.size };
        options.onTiming?.({ phase: 'render.serializeSvg', ms: performance.now() - svgStart - attachMs, bytes, ...lastRender });
        options.onTiming?.({ phase: 'render.attachSvg', ms: attachMs, ...lastRender });
        renderedObjects = objects; renderedKey = key; renderedPage = editor.pageId;
        updateViewport();
    }
    function requestRender() {
        if (destroyed) return;
        pendingRender = true; revision++;
        if (cancelScheduled) return;
        if (typeof requestAnimationFrame === 'function') {
            const frame = requestAnimationFrame(() => { cancelScheduled = undefined; flushPending(); });
            cancelScheduled = () => cancelAnimationFrame(frame);
        } else {
            const timer = setTimeout(() => { cancelScheduled = undefined; flushPending(); }, 0);
            cancelScheduled = () => clearTimeout(timer);
        }
    }
    function flushPending() { if (pendingRender) render(); }
    async function settled() {
        if (settling)
            return settling;
        settling = (async () => {
            let stable = false;
            for (let attempt = 0; attempt < 4; attempt++) {
                flushPending();
                const start = revision;
                // Full settling is an explicit measurement/export contract; interactive
                // render preparation remains scoped to the screen and its overscan.
                discoverImages(editor.page.objects);
                discoverBooleans(editor.page.objects);
                const text = Object.values(editor.page.objects).filter(s => s.type === 'text').map(s => typeof s.content === 'string' ? s.content : JSON.stringify(s.content ?? s.text ?? '')).join('');
                await bounded(options.fonts?.ensure ? options.fonts.ensure(text) : document.fonts.ready, 15000);
                const metricsChanged = measuredMetricRevision !== textMetricRevision() || measuredFontRevision !== fontRevision;
                measureText(editor.page.objects);
                await Promise.all([...images.values()].map(i => i.promise));
                await bounded(Promise.all([...booleans.values()].map(entry => entry.promise)), 20000);
                for (const entry of booleans.values())
                    if (entry.error)
                        throw new Error('Boolean geometry could not be computed', { cause: entry.error });
                if (pendingRender || metricsChanged || measuredMetricRevision !== textMetricRevision() || renderedOutlines !== !!editor.showOutlines)
                    render();
                await new Promise<void>(resolve => setTimeout(resolve, 0));
                if (start === revision && !pendingRender) {
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
        flushPending();
        measureText(Object.fromEntries(ids.filter(id => editor.page.objects[id]).map(id => [id, editor.page.objects[id]])));
        const result = new Map<string, Measured>();
        if (!ids.length) return result;
        const objects = resolvedObjects();
        for (const id of ids) {
            const s = objects[id];
            if (!s)
                continue;
            let b = boundsOf([s]);
            const element = layerElement(id);
            if (!element) {
                if (!preparation.enabled) continue;
                let ancestor: Shape | undefined = s, hidden = false;
                const seen = new Set<string>();
                while (ancestor && !seen.has(ancestor.id)) {
                    seen.add(ancestor.id);
                    if (ancestor.hidden || ancestor.visible === false) { hidden = true; break; }
                    ancestor = editor.page.objects[ancestor.parentId];
                }
                if (hidden) continue;
            }
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
        assets: Data | undefined;
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
        const assets = editor.doc.assets;
        const key = pageId + '\0' + id, signature = fontRevision + ":" + textMetricRevision() + JSON.stringify(objects), cached = thumbnailCache.get(key);
        if (cached?.signature === signature && cached.assets === assets)
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
                const measured = measureTextScene(objects, holder, { ...options, assets, resolveImageSource }), bounds = boundsOf([objects[id]]);
                const svg = new SceneWriter(objects, { assets, textFragments: measured.fragments, typography: options, resolveImageSource, idPrefix: 'omc-thumb-' + (++thumbnailNamespace) }).svg([id], bounds);
                const { inlineSVGImages } = await import('../export/raster');
                return inlineSVGImages(svg);
            }
            finally {
                holder.remove();
            }
        })();
        thumbnailCache.set(key, { signature, assets, promise });
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
        async thumbnailSnapshot({ signal } = {}) {
            signal?.throwIfAborted();
            const svg = scene.firstElementChild as SVGSVGElement | null;
            if (destroyed || pendingRender || !svg) return null;
            // Automatic library previews must never invoke full-page settling.
            // Snapshot only the already prepared viewport, with a bounded walk
            // before serialization (an individual inline image can also be huge).
            const walk = document.createTreeWalker(svg, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
            let node: Node | null = svg, nodes = 0, characters = 0;
            while (node) {
                if (++nodes > 2000) return null;
                if (node.nodeType === Node.ELEMENT_NODE) {
                    const element = node as Element;
                    characters += element.tagName.length * 2 + 5;
                    for (const attribute of element.attributes) characters += attribute.name.length + attribute.value.length + 4;
                } else characters += node.nodeValue?.length ?? 0;
                if (characters > 2 * 1024 * 1024) return null;
                node = walk.nextNode();
            }
            const b = viewportBounds();
            if (![b.x, b.y, b.width, b.height].every(Number.isFinite) || b.width <= 0 || b.height <= 0) return null;
            const version = visualRevision, snapshot = svg.cloneNode(true) as SVGSVGElement;
            snapshot.style.removeProperty('width'); snapshot.style.removeProperty('height'); snapshot.style.overflow = 'hidden';
            snapshot.setAttribute('width', String(b.width)); snapshot.setAttribute('height', String(b.height));
            const source = new XMLSerializer().serializeToString(snapshot);
            const { inlineSVGImages, rasterizeSVG } = await import('../export/raster');
            const embedded = await inlineSVGImages(source, { signal, maxBytes: 8 * 1024 * 1024 });
            signal?.throwIfAborted();
            if (destroyed || visualRevision !== version) return null;
            // Library previews are best effort and use available system fonts;
            // explicit screenshots still settle and embed the export font set.
            const scale = Math.min(1, Math.sqrt(80000 / (b.width * b.height)));
            const blob = await rasterizeSVG(embedded, b, scale, 'image/png');
            signal?.throwIfAborted();
            if (destroyed || visualRevision !== version) return null;
            return { data: await blobBase64(blob), mimeType: 'image/png' };
        },
        get renderRevision() { return visualRevision; },
        get geometryRevision() { return booleanRevision; },
        renderDiagnostics() { return { ...lastRender, ...nodeCache.diagnostics(), pending: pendingRender, viewportCulling: preparation.enabled, preparedObjects: Object.keys(preparation.objects).length, preparedRoots: preparation.roots.length }; },
        flush: flushPending,
        onRender(listener: () => void) {
            renderListeners.add(listener);
            return () => renderListeners.delete(listener);
        },
        textFragments(id: string) {
            flushPending();
            if (editor.page.objects[id]) measureText({ [id]: editor.page.objects[id] });
            return (fragments.get(id) ?? []).map(fragment => ({ ...fragment, style: { ...fragment.style } }));
        },
        render, settled, measure, computedStyle(id, keys) {
            flushPending();
            const s = resolvedObjects()[id];
            if (!s)
                return {};
            let group = layerElement(id), probe: HTMLElement | undefined;
            if (!group && preparation.enabled) {
                measureText({ [id]: editor.page.objects[id] });
                probe = document.createElement('div');
                probe.innerHTML = new SceneWriter(resolvedObjects(), { assets: editor.doc.assets, textFragments: fragments, typography: options, resolveImageSource }).svg([id], boundsOf([s]));
                measurements.append(probe);
                group = probe.querySelector(`[data-shape-id="${CSS.escape(id)}"]`);
            }
            const el = group?.querySelector('[data-run]') ?? group?.querySelector('path:not([data-geometry]),image,svg') ?? group;
            if (!el) {
                probe?.remove();
                return {};
            }
            const style = getComputedStyle(el);
            const derived: Record<string, string> = {
                width: s.width + 'px', height: s.height + 'px', left: s.x + 'px', top: s.y + 'px', opacity: String(s.opacity ?? 1), display: s.layout?.type === 'flex' ? 'flex' : s.layout?.type === 'grid' ? 'grid' : 'block', ...(s.layout?.direction ? { 'flex-direction': s.layout.direction } : {})
            };
            if (s.fills?.[0]?.color)
                derived['background-color'] = s.fills[0].color;
            const selected = keys ?? ['fill', 'stroke', 'opacity', 'font-family', 'font-size', 'font-weight', 'font-style', 'line-height', 'letter-spacing', 'color', 'mix-blend-mode'];
            const result = Object.fromEntries(selected.map(k => [k, derived[k] ?? style.getPropertyValue(k)]));
            probe?.remove();
            return result;
        }, element(id) {
            flushPending();
            return layerElement(id) as HTMLElement | null;
        }, sceneSvg(ids?: string[], opts: Data = {}) {
            flushPending();
            measureText(editor.page.objects);
            const chosen = ids?.length ? ids : roots();
            const bounds = opts.bounds ?? boundsOf(chosen.map(id => resolvedObjects()[id]).filter(Boolean));
            return new SceneWriter(resolvedObjects(), { assets: editor.doc.assets, ...opts, exporting: true, textFragments: fragments, resolveImageSource }).svg(chosen, bounds);
        }, bounds(ids: string[]) {
            return boundsOf(ids.map(id => resolvedObjects()[id]).filter(Boolean));
        }, projectedShape(id: string) {
            return resolvedObjects()[id];
        }, textLines(id: string) {
            flushPending();
            if (editor.page.objects[id]) measureText({ [id]: editor.page.objects[id] });
            return (fragments.get(id)??[]).map(fragment=>({...fragment,style:{...fragment.style}}));
        }, textSize(id: string) {
            flushPending();
            if (editor.page.objects[id]) measureText({ [id]: editor.page.objects[id] });
            const size=textSizes.get(id);return size?{...size}:undefined;
        }, async screenshot(id, opts = {}) {
            await settled();
            let board = editor.selection[0];
            while (board && editor.page.objects[board]?.parentId !== 'root' && editor.page.objects[board]?.parentId !== board)
                board = editor.page.objects[board]?.parentId;
            const chosen = id ?? (board && editor.page.objects[board]?.type === 'frame' ? board : undefined) ?? roots().find(id => editor.page.objects[id]?.type === 'frame') ?? roots()[0];
            const chosenIds = !id && opts.scope === 'page' ? roots() : chosen ? [chosen] : [];
            if (!chosenIds.length)
                throw new Error('No layer available for screenshot');
            const objects = resolvedObjects(), b = boundsOf(chosenIds.map(key => objects[key]));
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
            const { rasterizeSVG, inlineSVGImages } = await import('../export/raster');
            let source = view.sceneSvg(chosenIds, { bounds: b });
            const css = await options.fonts?.embeddedCss?.();
            if (css)
                source = source.replace('<defs>', '<defs><style>' + css.replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</style>');
            const blob = await rasterizeSVG(await inlineSVGImages(source), b, scale, 'image/png');
            const data = await blobBase64(blob);
            return { data, mimeType: 'image/png', slices };
        }, imageCacheDiagnostics(){return {loadedImages:images.size,assetURLs:assetUrls.size};}, destroy() {
            destroyed = true;
            cancelScheduled?.(); cancelScheduled = undefined; pendingRender = false;
            off();
            scene.remove();
            measurements.remove();
            renderListeners.clear();
            thumbnailCache.clear();
            images.clear();
            for(const {url} of assetUrls.values())URL.revokeObjectURL(url);assetUrls.clear();
            booleans.clear();
            booleanProjections.clear();
            fragments.clear();
            textSizes.clear();
            measuredText.clear(); nodeCache.clear(); renderedObjects = undefined; resolvedSource = undefined;
            preparation.clear();
        }
    };
    const off = editor.on(event => {
        const source = editor.page.objects;
        if (event.page || observedPage !== editor.pageId) {
            preparation.clear(); pendingShapeIds = undefined;
        } else if (source !== observedSource) {
            // Absence means unknown, whereas an explicit empty scope means no
            // shape changed. Union every skipped preview up to the next render.
            if (!event.changedShapeIds) pendingShapeIds = undefined;
            else if (pendingShapeIds) for (const id of event.changedShapeIds[editor.pageId] ?? []) pendingShapeIds.add(id);
        }
        observedPage = editor.pageId; observedSource = source;
        if (event.changes || event.projection || event.page || renderedOutlines !== !!editor.showOutlines)
            render();
        else if (event.deltas) {
            if (editor.undo.blocked) requestRender(); else render();
        }
        else if (event.viewport) {
            if (pendingRender || prepareScreen()) render(); else updateViewport();
        }
        else if (event.selection && preparation.enabled && prepareScreen()) {
            render();
        }
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
