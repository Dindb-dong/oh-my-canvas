import type { Data, EditorServices, Point, Shape, Tool, Viewport } from "../contracts";
import { createShape, cloneShapes, topLevelIds, removeShapes, isEditable } from "../document";
import { setPathHandle, movePathNodes, insertPathNode as splitPathNode, deletePathNodes, refreshPath, joinPathEnds, closePath, convertPathNode } from "../commands";
import { hitTest, moveShape, resizeShape, setShapeOrientation, transformShapes, unorientPoint, orientedPoint, multiply, inverse, intersects } from "../geometry";
import { el, clone, toast } from "../ui/dom";
import type { createTextSession } from "./text";
import { SpatialIndex, SnapIndex, hitBounds, type SpatialEntry } from '../render/spatial';
type TextSession = ReturnType<typeof createTextSession>;
const handles = [
    "nw",
    "n",
    "ne",
    "e",
    "se",
    "s",
    "sw",
    "w"
];
const position: Record<string, [
    number,
    number
]> = {
    nw: [0, 0],
    n: [0.5, 0],
    ne: [1, 0],
    e: [1, 0.5],
    se: [1, 1],
    s: [0.5, 1],
    sw: [0, 1],
    w: [0, 0.5]
};
const uid = () => crypto.randomUUID();
export function createCanvasInteraction(stage: HTMLElement, overlay: HTMLElement, services: EditorServices, text: TextSession, callbacks: {
    context: (event: MouseEvent, id?: string) => void;
    changed: () => void;
    importFiles: (files: File[], point: Point) => Promise<void>;
}) {
    const editor = services.editor;
    const abort = new AbortController();
    const signal = abort.signal;
    let gesture: Data | null = null, pathId: string | null = null, nodeSelection = new Set<number>(), space = false, pen: Data | null = null, marquee: HTMLElement | null = null, drawId: string | null = null, selectedGradient: Data | null = null;
    const pointers = new Map<number, Point>();
    const agents = new Map<string, string[]>();
    const decorations = el("div", "frame-decorations");
    Object.assign(decorations.style, {position: "absolute", inset: "0", pointerEvents: "none"});
    let destroyed = false, pendingOverlay: number | null = null;
    let overlayState: unknown[] | null = null, decorationState: unknown[] | null = null;
    let decorationObjects: Record<string, Shape> | null = null, decorationShapes: Shape[] = [];
    let overlayBuilds = 0, decorationBuilds = 0;
    let hitSource: Record<string, Shape> | undefined, hitRevision = -1, hitIndex: SpatialIndex | undefined, hitFallback: SpatialEntry[] = [], hitScale = 1;
    let hitCandidates = 0, snapKey: unknown, snapIndex: SnapIndex | undefined, guideOwners: string[] = [];
    let snapExcluded = new Set<string>();
    let viewportFrame: number | null = null, queuedViewport: Viewport | null = null, queuedBase: Viewport | null = null;
    function flushViewport() {
        if (viewportFrame !== null) cancelAnimationFrame(viewportFrame);
        viewportFrame = null;
        const next = queuedViewport, base = queuedBase;
        queuedViewport = queuedBase = null;
        if (!destroyed && next && editor.viewport === base) editor.setViewport(next);
    }
    function queueViewport(kind: 'pan' | 'zoom', a: number, b: number | Point) {
        if (typeof services.view.onRender !== 'function' || typeof requestAnimationFrame !== 'function') {
            if (kind === 'pan') pan(a, b as number); else zoom(a, b as Point);
            return;
        }
        if (queuedBase !== editor.viewport) { queuedViewport = editor.viewport; queuedBase = editor.viewport; }
        const v = queuedViewport ?? editor.viewport;
        if (kind === 'pan') queuedViewport = { ...v, vbox: { ...v.vbox, x: v.vbox.x - a / v.zoom, y: v.vbox.y - (b as number) / v.zoom } };
        else {
            const at = b as Point, z = Math.max(.01, Math.min(200, v.zoom * a));
            queuedViewport = { ...v, zoom: z, vbox: { x: v.vbox.x + at.x / v.zoom - at.x / z, y: v.vbox.y + at.y / v.zoom - at.y / z, width: v.vport.width / z, height: v.vport.height / z } };
        }
        if (viewportFrame === null) viewportFrame = requestAnimationFrame(() => { viewportFrame = null; flushViewport(); });
    }
    const sameState = (before: unknown[] | null, after: unknown[]) => !!before && before.length === after.length && before.every((value, index) => Object.is(value, after[index]));
    function cancelOverlayFrame() {
        if (pendingOverlay !== null) {
            cancelAnimationFrame(pendingOverlay);
            pendingOverlay = null;
        }
    }
    function scheduleOverlays() {
        // A real renderer publishes its completed frame through onRender. Keep
        // standalone interaction mounts synchronous, and never defer commands.
        if (typeof services.view.onRender !== "function" || typeof requestAnimationFrame !== "function") {
            renderOverlays(false);
            return;
        }
        if (pendingOverlay === null)
            pendingOverlay = requestAnimationFrame(() => {
                pendingOverlay = null;
                renderOverlays(false);
            });
    }
    let lastTap: {
        time: number;
        id: string | null;
    } = {
        time: 0,
        id: null
    };
    let pinch: Data | null = null;
    const world = (p: Point) => ({
        x: p.x / editor.viewport.zoom + editor.viewport.vbox.x,
        y: p.y / editor.viewport.zoom + editor.viewport.vbox.y
    });
    const local = (e: {
        clientX: number;
        clientY: number;
    }) => {
        const box = stage.getBoundingClientRect();
        return {
            x: e.clientX - box.left,
            y: e.clientY - box.top
        };
    };
    const screen = (p: Point) => ({
        x: (p.x - editor.viewport.vbox.x) * editor.viewport.zoom,
        y: (p.y - editor.viewport.vbox.y) * editor.viewport.zoom
    });
    const editable = () => topLevelIds(editor.page, editor.selection).map(id => editor.page.objects[id]).filter(s => s && isEditable(editor.page, s.id));
    const bounds = (shapes: Shape[]) => {
        const points = shapes.flatMap(s => s.corners?.length ? s.corners : [{
                x: s.x,
                y: s.y
            }, {
                x: s.x + s.width,
                y: s.y + s.height
            }]);
        if (!points.length)
            return {
                x: 0,
                y: 0,
                width: 0,
                height: 0
            };
        const x = Math.min(...points.map(p => p.x)), y = Math.min(...points.map(p => p.y));
        return {
            x,
            y,
            width: Math.max(...points.map(p => p.x)) - x,
            height: Math.max(...points.map(p => p.y)) - y
        };
    };
    function ancestorEditable(shape: Shape) {
        let s: Shape | undefined = shape;
        while (s && s.id !== "root") {
            if (s.hidden || s.locked)
                return false;
            s = editor.page.objects[s.parentId];
        }
        return true;
    }
    function hit(point: Point, deep = false) {
        const objects = editor.page.objects;
        const revision = services.view.geometryRevision ?? 0;
        if (hitSource !== objects || hitRevision !== revision) {
            hitSource = objects; hitRevision = revision; hitIndex = undefined; hitFallback = []; hitScale = 1;
            if (Object.keys(objects).length > 512) {
                const entries: SpatialEntry[] = [], seen = new Set<string>();
                let order = 0;
                const collect = (id: string) => {
                    const stored = objects[id];
                    if (!stored || seen.has(id) || stored.hidden || stored.locked) return;
                    seen.add(id);
                    const shape = stored.type === 'boolean' ? (services.view.projectedShape?.(id) ?? stored) : stored;
                    if (id !== 'root') {
                        const box = hitBounds(shape), entry = { id, order: order++, bounds: box ?? { x: 0, y: 0, width: 0, height: 0 } };
                        if (box) entries.push(entry); else hitFallback.push(entry);
                        const m = shape.transform;
                        if (m) hitScale = Math.max(hitScale, Math.abs(m.a) + Math.abs(m.c), Math.abs(m.b) + Math.abs(m.d));
                    }
                    if (stored.type !== 'boolean') for (const child of stored.childIds ?? []) collect(child);
                };
                collect('root'); hitIndex = new SpatialIndex(entries);
            }
        }
        if (hitIndex) {
            const radius = 4 / editor.viewport.zoom * hitScale;
            const candidates = [...hitIndex.query({ x: point.x - radius, y: point.y - radius, width: radius * 2, height: radius * 2 }), ...hitFallback].sort((a, b) => b.order - a.order);
            hitCandidates = candidates.length;
            for (const candidate of candidates) {
                const stored = objects[candidate.id], shape = stored.type === 'boolean' ? (services.view.projectedShape?.(stored.id) ?? stored) : stored;
                let valid = true, ancestor: Shape | undefined = shape;
                while (ancestor && ancestor.id !== 'root') {
                    if (ancestor.hidden || ancestor.locked || ancestor.type === 'frame' && ancestor.clipContent && !pointInShape(ancestor, point)) { valid = false; break; }
                    ancestor = objects[ancestor.parentId];
                }
                if (!valid || !pointInShape(shape, point)) continue;
                if (deep) return shape;
                let target = shape;
                while (target.parentId !== 'root' && objects[target.parentId] && objects[target.parentId].type !== 'frame') target = objects[target.parentId];
                return target;
            }
            return null;
        }
        const walk = (id: string): Shape | null => {
            const stored = objects[id];
            const s = stored?.type === "boolean" ? (services.view.projectedShape?.(id) ?? stored) : stored;
            if (!s || s.hidden || s.locked)
                return null;
            if (s.type === "frame" && s.id !== "root" && s.clipContent && !pointInShape(s, point))
                return null;
            for (const child of [...(s.type === "boolean" ? [] : s.childIds ?? [])].reverse()) {
                const found = walk(child);
                if (found)
                    return found;
            }
            if (id === "root" || s.locked)
                return null;
            const b = bounds([s]);
            if (!pointInShape(s, point))
                return null;
            if (deep)
                return s;
            let target = s;
            while (target.parentId !== "root" && objects[target.parentId] && objects[target.parentId].type !== "frame") {
                target = objects[target.parentId];
            }
            return target;
        };
        return walk("root");
    }
    function pointInShape(shape: Shape, point: Point) {
        return hitTest(shape, point, 4 / editor.viewport.zoom);
    }
    function parentAt(p: Point, excluded: string[] = []) {
        let found = "root";
        const walk = (id: string) => {
            const s = editor.page.objects[id];
            if (!s || excluded.includes(id) || s.hidden || s.locked)
                return;
            if (s.type === "frame" && id !== "root" && pointInShape(s, p))
                found = id;
            for (const c of s.childIds ?? [])
                walk(c);
        };
        walk("root");
        return found;
    }
    function addShape(type: string, props: Data) {
        const shape = createShape(type, {
            id: uid(),
            ...props
        });
        editor.preview(doc => {
            const page = doc.pagesById[editor.pageId];
            page.objects[shape.id] = clone(shape);
            const parent = page.objects[shape.parentId ?? "root"];
            if (!parent?.childIds)
                throw Error("Drawing target is not a container");
            parent.childIds.push(shape.id);
        });
        return shape.id;
    }
    function pan(dx: number, dy: number) {
        const v = editor.viewport;
        editor.setViewport({
            ...v,
            vbox: {
                ...v.vbox,
                x: v.vbox.x - dx / v.zoom,
                y: v.vbox.y - dy / v.zoom
            }
        });
    }
    function zoom(factor: number, at: Point) {
        const v = editor.viewport;
        const z = Math.max(0.01, Math.min(200, v.zoom * factor));
        const p = world(at);
        editor.setViewport({
            ...v,
            zoom: z,
            vbox: {
                x: p.x - at.x / z,
                y: p.y - at.y / z,
                width: v.vport.width / z,
                height: v.vport.height / z
            }
        });
    }
    function translate(s: Shape, dx: number, dy: number) {
        s.x += dx;
        s.y += dy;
        if (Array.isArray(s.content))
            for (const p of s.content) {
                for (const k of ["x", "x1", "x2"])
                    if (typeof p[k] === "number")
                        p[k] += dx;
                for (const k of ["y", "y1", "y2"])
                    if (typeof p[k] === "number")
                        p[k] += dy;
            }
    }
    function resetGeometry(s: Shape, base: Shape) {
        for (const key of [
            "x",
            "y",
            "width",
            "height",
            "rotation",
            "transform",
            "inverseTransform",
            "flipX",
            "flipY"
        ])
            s[key] = clone(base[key]);
        if (Array.isArray(base.content))
            s.content = clone(base.content);
    }
    function transformTree(doc: Data, id: string, base: Data, apply: (s: Shape, b: Shape) => void) {
        const s = doc.pagesById[editor.pageId].objects[id], b = base[id];
        if (!s || !b)
            return;
        apply(s, b);
        for (const child of b.childIds ?? [])
            transformTree(doc, child, base, apply);
    }
    function snap(p: Point, exclude: string[] = []) {
        if (editor.snapping === false)
            return {
                point: p,
                lines: []
            };
        const excluded = new Set(exclude);
        const hideChildren = (id: string) => {
            for (const child of editor.page.objects[id]?.childIds ?? []) {
                excluded.add(child);
                hideChildren(child);
            }
        };
        exclude.forEach(hideChildren);
        snapExcluded = excluded;
        const threshold = 5 / editor.viewport.zoom;
        let x = p.x, y = p.y, bx = threshold, by = threshold;
        const lines: Data[] = [];
        const key = gesture ?? editor.page.objects;
        if (snapKey !== key || !snapIndex) {
            snapKey = key; snapIndex = new SnapIndex(editor.page.objects);
            guideOwners = Object.values(editor.page.objects).filter(shape => shape.id !== 'root' && shape.guides?.length).map(shape => shape.id);
        }
        const sx = snapIndex.nearest('x', p.x, threshold, excluded), sy = snapIndex.nearest('y', p.y, threshold, excluded);
        x = sx.value; bx = sx.distance; y = sy.value; by = sy.distance;
        const frameGuides = guideOwners.map(id => editor.page.objects[id]).filter(shape => shape && !shape.hidden && !shape.flipX && !shape.flipY && Math.abs(shape.rotation % 360) < 0.000001 && ancestorEditable(shape)).flatMap(shape => (shape.guides ?? []).map((guide: Data) => ({
            ...guide,
            position: guide.position + (guide.axis === "x" ? shape.x : shape.y)
        })));
        for (const guide of [...editor.page.guides ?? [], ...frameGuides]) {
            if (guide.axis === "x" && Math.abs(guide.position - p.x) < bx) {
                x = guide.position;
                bx = Math.abs(x - p.x);
            }
            if (guide.axis === "y" && Math.abs(guide.position - p.y) < by) {
                y = guide.position;
                by = Math.abs(y - p.y);
            }
        }
        if (x !== p.x)
            lines.push({
                axis: "x",
                value: x
            });
        if (y !== p.y)
            lines.push({
                axis: "y",
                value: y
            });
        if (editor.pixelSnap) {
            x = Math.round(x);
            y = Math.round(y);
        }
        return {
            point: {
                x,
                y
            },
            lines
        };
    }
    function drawSnap(lines: Data[]) {
        overlay.querySelectorAll(".snap-line").forEach(n => n.remove());
        for (const line of lines) {
            const n = el("div", "snap-line");
            const p = screen({
                x: line.value,
                y: line.value
            });
            Object.assign(n.style, line.axis === "x" ? {
                left: `${p.x}px`,
                top: "0",
                width: "1px",
                height: "100%"
            } : {
                top: `${p.y}px`,
                left: "0",
                height: "1px",
                width: "100%"
            });
            overlay.append(n);
        }
    }
    function renderOverlays(force = true) {
        if (destroyed)
            return;
        cancelOverlayFrame();
        const state: unknown[] = [editor.pageId, editor.page.objects, editor.page.guides, editor.selection, editor.viewport,
            editor.tool, editor.showGrids, editor.showRulers, editor.pixelSnap, text.active, pathId, pen, selectedGradient,
            space, services.view.renderRevision];
        if (!force && sameState(overlayState, state))
            return;
        overlayState = state;
        overlayBuilds++;
        const retained = Array.from(overlay.querySelectorAll(".snap-line,.marquee"));
        overlay.replaceChildren(...retained, decorations);
        drawFrameDecorations();
        const selection = editor.selection.map(id => services.view.projectedShape?.(id) ?? editor.page.objects[id]).filter(Boolean);
        if (selection.length) {
            const b = selection.length === 1 ? {
                x: selection[0].x,
                y: selection[0].y,
                width: selection[0].width,
                height: selection[0].height
            } : bounds(selection), p = screen(b), z = editor.viewport.zoom;
            const outline = el("div", "selection-outline");
            Object.assign(outline.style, {
                left: `${p.x}px`,
                top: `${p.y}px`,
                width: `${b.width * z}px`,
                height: `${b.height * z}px`
            });
            if (selection.length === 1) {
                const m = selection[0].transform;
                outline.style.transform = `matrix(${m.a},${m.b},${m.c},${m.d},0,0)`;
            }
            if (selection.length === 1)
                outline.append(el("span", "selection-label", selection[0].name ?? selection[0].type));
            if (!text.active && !pathId && !pen && editor.tool === "move" && editable().length) {
                for (const name of handles) {
                    const h = el("div", "transform-handle");
                    h.dataset.handle = name;
                    h.style.left = `${position[name][0] * 100}%`;
                    h.style.top = `${position[name][1] * 100}%`;
                    h.style.cursor = `${name}-resize`;
                    h.addEventListener("pointerdown", event => beginHandle(event, name));
                    outline.append(h);
                }
                const rotate = el("div", "transform-handle rotate-handle");
                rotate.dataset.handle = "rotate";
                rotate.title = "Rotate";
                rotate.style.left = "50%";
                rotate.style.top = "-24px";
                rotate.addEventListener("pointerdown", event => beginHandle(event, "rotate"));
                outline.append(rotate);
            }
            overlay.append(outline);
        }
        if (selection.length > 1)
            for (const shape of selection) {
                const p = screen(shape), m = shape.transform, outline = el("div", "selection-outline selection-member");
                outline.dataset.id = shape.id;
                Object.assign(outline.style, {
                    left: `${p.x}px`, top: `${p.y}px`,
                    width: `${shape.width * editor.viewport.zoom}px`, height: `${shape.height * editor.viewport.zoom}px`,
                    transform: `matrix(${m.a},${m.b},${m.c},${m.d},0,0)`, pointerEvents: "none"
                });
                overlay.append(outline);
            }
        for (const [agent, ids] of agents) {
            for (const id of ids) {
                const s = editor.page.objects[id];
                if (!s)
                    continue;
                const b = bounds([s]), p = screen(b);
                const n = el("div", "agent-outline");
                n.title = agent;
                Object.assign(n.style, {
                    left: `${p.x}px`,
                    top: `${p.y}px`,
                    width: `${b.width * editor.viewport.zoom}px`,
                    height: `${b.height * editor.viewport.zoom}px`
                });
                overlay.append(n);
            }
        }
        for (const [index, guide] of (editor.page.guides ?? []).entries()) {
            const n = el("div", "guide-line");
            const p = screen({
                x: guide.position,
                y: guide.position
            });
            const coordinate = guide.axis === "x" ? p.x : p.y;
            const extent = guide.axis === "x" ? stage.clientWidth : stage.clientHeight;
            if (extent > 0 && (coordinate < -1 || coordinate > extent + 1))
                continue;
            Object.assign(n.style, guide.axis === "x" ? {
                left: `${p.x}px`,
                top: "0",
                width: "1px",
                height: "100%",
                cursor: "ew-resize"
            } : {
                top: `${p.y}px`,
                left: "0",
                height: "1px",
                width: "100%",
                cursor: "ns-resize"
            });
            n.style.pointerEvents = editor.tool === "move" ? "auto" : "none";
            n.onpointerdown = event => {
                event.stopPropagation();
                stage.setPointerCapture(event.pointerId);
                if (editor.begin("Move guide"))
                    gesture = {
                        kind: "guide",
                        index,
                        axis: guide.axis
                    };
            };
            n.ondblclick = () => editor.transact("Delete guide", doc => doc.pagesById[editor.pageId].guides.splice(index, 1));
            overlay.append(n);
        }
        if (editor.showRulers)
            drawRulers();
        if (pen)
            drawPen();
        else if (pathId && editor.tool === "move")
            drawPathNodes();
        if (selectedGradient && editor.tool === "move")
            drawGradient();
        stage.style.cursor = space ? "grab" : editor.tool === "move" ? "default" : editor.tool === "text" ? "text" : "crosshair";
    }
    function drawFrameDecorations() {
        const zoom = editor.viewport.zoom;
        stage.style.backgroundImage = editor.pixelSnap && zoom >= 4 ? "linear-gradient(to right,#b4bfd533 1px,transparent 1px),linear-gradient(to bottom,#b4bfd533 1px,transparent 1px)" : "";
        stage.style.backgroundSize = `${zoom}px ${zoom}px`;
        stage.style.backgroundPosition = `${-editor.viewport.vbox.x * zoom}px ${-editor.viewport.vbox.y * zoom}px`;
        if (decorationObjects !== editor.page.objects) {
            decorationObjects = editor.page.objects;
            decorationShapes = Object.values(decorationObjects).filter(shape => shape.id !== "root" &&
                (shape.guides?.length || shape.type === "frame" && shape.layoutGrids?.length));
        }
        const state: unknown[] = [editor.pageId, zoom, editor.viewport.vbox.x, editor.viewport.vbox.y,
            stage.clientWidth, stage.clientHeight, editor.showGrids, editor.tool];
        for (const shape of decorationShapes)
            state.push(shape, ancestorEditable(shape));
        if (sameState(decorationState, state))
            return;
        decorationState = state;
        decorationBuilds++;
        decorations.replaceChildren();
        const viewport = {x: editor.viewport.vbox.x - 1 / zoom, y: editor.viewport.vbox.y - 1 / zoom,
            width: (stage.clientWidth + 2) / zoom, height: (stage.clientHeight + 2) / zoom};
        const hasViewport = stage.clientWidth > 0 && stage.clientHeight > 0;
        for (const frame of decorationShapes)
            for (const [index, guide] of (frame.id !== "root" && !frame.hidden && !frame.flipX && !frame.flipY && Math.abs(frame.rotation % 360) < 0.000001 && ancestorEditable(frame) ? frame.guides ?? [] : []).entries()) {
                const line = el("div", "guide-line"), position = guide.position + (guide.axis === "x" ? frame.x : frame.y), p = screen({
                    x: position,
                    y: position
                });
                const lineBounds = guide.axis === "x" ? {x: position, y: frame.y, width: 1 / zoom, height: frame.height} :
                    {x: frame.x, y: position, width: frame.width, height: 1 / zoom};
                if (hasViewport && !intersects(lineBounds, viewport))
                    continue;
                Object.assign(line.style, guide.axis === "x" ? {
                    left: `${p.x}px`,
                    top: `${screen(frame).y}px`,
                    width: "1px",
                    height: `${frame.height * zoom}px`,
                    cursor: "ew-resize"
                } : {
                    top: `${p.y}px`,
                    left: `${screen(frame).x}px`,
                    height: "1px",
                    width: `${frame.width * zoom}px`,
                    cursor: "ns-resize"
                });
                line.style.pointerEvents = editor.tool === "move" ? "auto" : "none";
                line.onpointerdown = event => {
                    event.preventDefault();
                    event.stopPropagation();
                    stage.setPointerCapture(event.pointerId);
                    if (editor.begin("Move frame guide"))
                        gesture = {
                            kind: "guide",
                            index,
                            axis: guide.axis,
                            frameId: frame.id
                        };
                };
                line.ondblclick = () => editor.transact("Delete frame guide", doc => doc.pagesById[editor.pageId].objects[frame.id].guides.splice(index, 1));
                decorations.append(line);
            }
        if (editor.showGrids === false)
            return;
        for (const shape of decorationShapes) {
            if (shape.type !== "frame" || shape.hidden || shape.id === "root")
                continue;
            // Grid overlays use CSS rotation, which may differ from an imported
            // shape's arbitrary affine matrix. Cull using the pixels drawn here.
            const angle = (shape.rotation ?? 0) * Math.PI / 180, cos = Math.abs(Math.cos(angle)), sin = Math.abs(Math.sin(angle));
            const width = shape.width * cos + shape.height * sin, height = shape.width * sin + shape.height * cos;
            const gridBounds = {x: shape.x + (shape.width - width) / 2, y: shape.y + (shape.height - height) / 2, width, height};
            if (hasViewport && !intersects(gridBounds, viewport))
                continue;
            const origin = screen(shape);
            for (const grid of shape.layoutGrids ?? []) {
                if (grid.hidden)
                    continue;
                const frame = el("div");
                frame.dataset.frameGrid = shape.id;
                Object.assign(frame.style, {
                    position: "absolute",
                    pointerEvents: "none",
                    left: `${origin.x}px`,
                    top: `${origin.y}px`,
                    width: `${shape.width * zoom}px`,
                    height: `${shape.height * zoom}px`,
                    transform: `rotate(${shape.rotation ?? 0}deg)`,
                    opacity: String(grid.opacity ?? 0.1),
                    overflow: "hidden"
                });
                if (grid.pattern === "grid") {
                    const size = Math.max(1, grid.size ?? 8) * zoom, color = grid.color ?? "#557dde";
                    frame.style.backgroundImage = `linear-gradient(to right,${color} 1px,transparent 1px),linear-gradient(to bottom,${color} 1px,transparent 1px)`;
                    frame.style.backgroundSize = `${size}px ${size}px`;
                }
                else {
                    const horizontal = grid.pattern === "columns", extent = horizontal ? shape.width : shape.height, count = Math.min(1000, Math.max(1, grid.count ?? 5)), gutter = grid.gutter ?? 16, offset = grid.offset ?? 0;
                    const size = grid.align === "stretch" ? (extent - offset * 2 - gutter * (count - 1)) / count : grid.size ?? 60;
                    const total = count * size + (count - 1) * gutter, start = grid.align === "center" ? (extent - total) / 2 : grid.align === "end" ? extent - offset - total : offset;
                    for (let i = 0; i < count; i++) {
                        const band = el("div");
                        Object.assign(band.style, {
                            position: "absolute",
                            background: grid.color ?? "#557dde",
                            ...(horizontal ? {
                                left: `${(start + i * (size + gutter)) * zoom}px`,
                                width: `${size * zoom}px`,
                                height: "100%"
                            } : {
                                top: `${(start + i * (size + gutter)) * zoom}px`,
                                height: `${size * zoom}px`,
                                width: "100%"
                            })
                        });
                        frame.append(band);
                    }
                }
                decorations.append(frame);
            }
        }
    }
    function drawRulers() {
        for (const axis of ["x", "y"]) {
            const ruler = el("div", `ruler ${axis === "x" ? "horizontal" : "vertical"}`);
            const start = axis === "x" ? editor.viewport.vbox.x : editor.viewport.vbox.y;
            const size = axis === "x" ? stage.clientWidth : stage.clientHeight;
            const step = Math.pow(10, Math.ceil(Math.log10(70 / editor.viewport.zoom)));
            const first = Math.ceil(start / step) * step;
            for (let value = first; (value - start) * editor.viewport.zoom < size; value += step) {
                const tick = el("span", "ruler-tick", String(Math.round(value)));
                tick.style[axis === "x" ? "left" : "top"] = `${(value - start) * editor.viewport.zoom}px`;
                ruler.append(tick);
            }
            ruler.onpointerdown = event => {
                event.preventDefault();
                event.stopPropagation();
                stage.setPointerCapture(event.pointerId);
                if (editor.begin("Add guide")) {
                    const p = world(local(event)), selection = editor.selection.length === 1 ? editor.page.objects[editor.selection[0]] : null;
                    const frame = selection?.type === "frame" && selection.id !== "root" && !selection.flipX && !selection.flipY && Math.abs(selection.rotation % 360) < 0.000001 ? selection : null;
                    const guideAxis = axis === "x" ? "y" : "x", index = (frame?.guides ?? editor.page.guides ?? []).length;
                    editor.preview(doc => {
                        const page = doc.pagesById[editor.pageId], owner = frame ? page.objects[frame.id] : page;
                        (owner.guides ??= []).push({
                            axis: guideAxis,
                            position: (guideAxis === "x" ? p.x : p.y) - (frame ? (guideAxis === "x" ? frame.x : frame.y) : 0)
                        });
                    });
                    gesture = {
                        kind: "guide",
                        index,
                        axis: guideAxis,
                        ...(frame ? {
                            frameId: frame.id
                        } : {})
                    };
                }
            };
            overlay.append(ruler);
        }
    }
    async function beginHandle(event: PointerEvent, kind: string) {
        if (editor.tool !== "move" || pen)
            return;
        event.preventDefault();
        event.stopPropagation();
        await text.exit();
        const shapes = editable();
        if (!shapes.length || !editor.begin(kind === "rotate" ? "Rotate layers" : "Resize layers"))
            return;
        gesture = {
            kind,
            start: world(local(event)),
            // Published objects are immutable; geometry helpers only read this
            // fixed origin and copy fields into each isolated preview draft.
            base: editor.page.objects,
            bounds: shapes.length === 1 ? {
                x: shapes[0].x,
                y: shapes[0].y,
                width: shapes[0].width,
                height: shapes[0].height
            } : bounds(shapes),
            ids: shapes.map(s => s.id)
        };
        stage.setPointerCapture(event.pointerId);
    }
    function drawPathNodes(id = pathId, interactive = true) {
        const shape = editor.page.objects[id!];
        if (!shape || !Array.isArray(shape.content)) {
            pathId = null;
            return;
        }
        shape.content.forEach((node: Data, index: number) => {
            if (node.command === "close")
                return;
            const end = screen({
                x: node.x,
                y: node.y
            });
            if (node.command === "curve") {
                for (const [xkey, ykey] of [["x1", "y1"], ["x2", "y2"]]) {
                    const p = screen({
                        x: node[xkey],
                        y: node[ykey]
                    });
                    const line = el("div", "path-line");
                    const anchor = xkey === "x1" ? shape.content[index - 1] ?? node : node;
                    const a = screen(anchor);
                    Object.assign(line.style, {
                        left: `${a.x}px`,
                        top: `${a.y}px`,
                        width: `${Math.hypot(p.x - a.x, p.y - a.y)}px`,
                        transform: `rotate(${Math.atan2(p.y - a.y, p.x - a.x)}rad)`
                    });
                    overlay.append(line);
                    nodeHandle(p, index, xkey, ykey, true);
                }
            }
            nodeHandle(end, index, "x", "y", false);
        });
        function nodeHandle(point: Point, index: number, xkey: string, ykey: string, control: boolean) {
            const n = el("div", `path-node ${control ? "path-control" : ""} ${nodeSelection.has(index) ? "selected" : ""}`);
            Object.assign(n.style, {
                left: `${point.x}px`,
                top: `${point.y}px`
            });
            n.style.pointerEvents = interactive && isEditable(editor.page, shape.id) ? "auto" : "none";
            n.onpointerdown = event => {
                if (editor.tool !== "move" || !isEditable(editor.page, shape.id))
                    return;
                event.stopPropagation();
                event.preventDefault();
                stage.setPointerCapture(event.pointerId);
                if (!event.shiftKey)
                    nodeSelection.clear();
                nodeSelection.add(xkey === "x1" ? index - 1 : index);
                callbacks.changed();
                if (editor.begin("Edit path node"))
                    gesture = {
                        kind: "node",
                        index,
                        xkey,
                        ykey,
                        start: world(local(event)),
                        base: clone(shape.content),
                        ids: [shape.id]
                    };
                renderOverlays();
            };
            n.ondblclick = event => {
                if (!interactive || !isEditable(editor.page, shape.id))
                    return;
                event.stopPropagation();
                const owner = xkey === "x1" ? index - 1 : index;
                editor.transact("Change node handles", doc => convertPathNode(doc.pagesById[editor.pageId].objects[shape.id], owner, event.shiftKey ? "symmetric" : shape.content[owner].command === "curve" ? "corner" : "smooth"));
            };
            overlay.append(n);
        }
    }
    function drawPen() {
        const shape = editor.page.objects[pen!.id];
        if (!shape)
            return;
        drawPathNodes(shape.id, false);
        const last = shape.content.at(-1), from = screen(last);
        if (pen!.outgoing) {
            const to = screen(pen!.outgoing), line = el("div", "path-line"), control = el("div", "path-node path-control");
            Object.assign(line.style, {
                left: `${from.x}px`, top: `${from.y}px`, width: `${Math.hypot(to.x - from.x, to.y - from.y)}px`,
                transform: `rotate(${Math.atan2(to.y - from.y, to.x - from.x)}rad)`, pointerEvents: "none"
            });
            Object.assign(control.style, {left: `${to.x}px`, top: `${to.y}px`, pointerEvents: "none"});
            overlay.append(line, control);
        }
        if (!pen!.hover)
            return;
        const to = screen(pen!.hover), control = pen!.outgoing ? screen(pen!.outgoing) : null;
        const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg"), path = document.createElementNS(svg.namespaceURI, "path");
        svg.setAttribute("width", "100%");
        svg.setAttribute("height", "100%");
        Object.assign(svg.style, {position: "absolute", inset: "0", pointerEvents: "none", overflow: "visible"});
        svg.dataset.penPreview = "true";
        path.setAttribute("d", `M ${from.x} ${from.y} ` + (control ? `C ${control.x} ${control.y} ${to.x} ${to.y} ${to.x} ${to.y}` : `L ${to.x} ${to.y}`));
        path.setAttribute("fill", "none");
        path.setAttribute("stroke", "#2563eb");
        path.setAttribute("stroke-width", "1");
        svg.append(path);
        overlay.append(svg);
    }
    function drawGradient() {
        const shape = editor.page.objects[selectedGradient!.id];
        const gradient = shape?.[selectedGradient!.field]?.[selectedGradient!.index]?.gradient;
        if (!gradient)
            return;
        for (const endpoint of [1, 2]) {
            const p = screen({
                x: shape.x + gradient[`x${endpoint}`] * shape.width,
                y: shape.y + gradient[`y${endpoint}`] * shape.height
            });
            const n = el("div", "gradient-handle");
            n.title = `Gradient endpoint ${endpoint}`;
            Object.assign(n.style, {
                left: `${p.x}px`,
                top: `${p.y}px`
            });
            n.onpointerdown = event => {
                event.preventDefault();
                event.stopPropagation();
                if (!isEditable(editor.page, shape.id))
                    return;
                stage.setPointerCapture(event.pointerId);
                if (editor.begin("Edit gradient"))
                    gesture = {
                        kind: "gradient",
                        endpoint,
                        ...selectedGradient
                    };
            };
            overlay.append(n);
        }
    }
    async function down(event: PointerEvent) {
        if ((event.target as HTMLElement).closest(".text-edit-host,.find-bar"))
            return;
        const p = local(event);
        pointers.set(event.pointerId, p);
        if (pointers.size === 2) {
            if (pen || gesture && gesture.kind !== "pan") {
                pen = null;
                gesture = null;
                editor.cancelSession();
            }
            gesture = null;
            marquee?.remove();
            marquee = null;
            const [a, b] = Array.from(pointers.values());
            pinch = {
                distance: Math.hypot(a.x - b.x, a.y - b.y),
                center: {
                    x: (a.x + b.x) / 2,
                    y: (a.y + b.y) / 2
                },
                zoom: editor.viewport.zoom
            };
            return;
        }
        if (event.button === 2)
            return;
        const point = world(p);
        if (space || event.button === 1) {
            event.preventDefault();
            gesture = {
                kind: "pan",
                start: p
            };
            stage.setPointerCapture(event.pointerId);
            return;
        }
        if (text.active) {
            event.preventDefault();
            await text.exit(true);
            if (!pointers.has(event.pointerId)) {
                const selected = hit(point, event.metaKey || event.ctrlKey);
                editor.setSelection(selected ? [selected.id] : []);
                return;
            }
        }
        if (event.pointerType === "touch" && editor.tool === "move" && !editor.multiSelect && !hit(point)) {
            editor.setSelection([]);
            gesture = {
                kind: "pan",
                start: p
            };
            stage.setPointerCapture(event.pointerId);
            return;
        }
        if (pathId && editor.tool === "move") {
            const shape = editor.page.objects[pathId];
            if (shape && pointInShape(shape, point)) {
                if (event.altKey) {
                    insertPathNode(point);
                    return;
                }
            }
            else {
                pathId = null;
                nodeSelection.clear();
            }
        }
        if (editor.tool === "pen") {
            penDown(event, point);
            return;
        }
        if (editor.tool !== "move") {
            if (!editor.begin(`Draw ${editor.tool}`))
                return;
            const parentId = parentAt(point);
            const tool = editor.tool;
            const type = ["polygon", "star", "line", "arrow", "pencil"].includes(tool) ? "path" : tool;
            const props: Data = {
                x: point.x,
                y: point.y,
                width: 1,
                height: 1,
                parentId,
                enclosingFrameId: parentId,
                name: tool[0].toUpperCase() + tool.slice(1),
                fills: ["line", "arrow", "pencil"].includes(tool) ? [] : [{
                        color: tool === "frame" ? "#ffffff" : "#a5b8f4"
                    }],
                strokes: ["line", "arrow", "pencil"].includes(tool) ? [{
                        color: "#334155",
                        width: 2,
                        ...(tool === "arrow" ? {
                            endCap: "arrow"
                        } : {})
                    }] : []
            };
            if (type === "path")
                props.content = [{
                        command: "move",
                        ...point
                    }, {
                        command: "line",
                        ...point
                    }];
            if (tool === "text") {
                props.content = {
                    type: "richText",
                    children: [{
                            children: [{
                                    text: "",
                                    fontFamily: "IBM Plex Sans",
                                    fontSize: 24,
                                    fontWeight: 400,
                                    fills: [{
                                            color: "#252b37"
                                        }]
                                }]
                        }]
                };
                props.autoResize = "widthAndHeight";
                props.width = 1;
                props.height = 32;
            }
            drawId = addShape(type, props);
            editor.setSelection([drawId]);
            gesture = {
                kind: "draw",
                tool,
                id: drawId,
                start: point,
                points: [point]
            };
            stage.setPointerCapture(event.pointerId);
            event.preventDefault();
            return;
        }
        const shape = hit(point, event.metaKey || event.ctrlKey || event.altKey);
        if (shape && !(shape.type === "frame" && !editor.selection.includes(shape.id))) {
            if (event.shiftKey || editor.multiSelect) {
                const removing = editor.selection.includes(shape.id);
                editor.setSelection(removing ? editor.selection.filter(id => id !== shape.id) : [...editor.selection, shape.id]);
                if (removing) {
                    event.preventDefault();
                    return;
                }
            }
            else if (!editor.selection.includes(shape.id))
                editor.setSelection([shape.id]);
            const shapes = editable();
            if (shapes.length && editor.begin(event.altKey ? "Duplicate and move layers" : "Move layers")) {
                let ids = shapes.map(s => s.id);
                if (event.altKey) {
                    editor.preview(doc => {
                        ids = cloneShapes(doc.pagesById[editor.pageId], ids, {
                            dx: 0,
                            dy: 0
                        }).map(s => s.id);
                    });
                    editor.setSelection(ids);
                }
                gesture = {
                    kind: "move",
                    start: point,
                    // Capture after the duplicate preview so new IDs are part
                    // of the fixed immutable origin for the entire gesture.
                    base: editor.page.objects,
                    ids,
                    bounds: bounds(ids.map(id => editor.page.objects[id])),
                    moved: false,
                    duplicate: event.altKey
                };
            }
        }
        else {
            const additive = event.shiftKey || editor.multiSelect;
            const initial = additive ? [...editor.selection] : [];
            if (!shape && !additive)
                editor.setSelection([]);
            gesture = {
                kind: "marquee",
                start: point,
                initial,
                frame: shape?.id,
                additive,
                moved: false
            };
            marquee = el("div", "marquee");
            overlay.append(marquee);
        }
        stage.setPointerCapture(event.pointerId);
        event.preventDefault();
    }
    function move(event: PointerEvent) {
        const p = local(event);
        if (pointers.has(event.pointerId))
            pointers.set(event.pointerId, p);
        if (pinch && pointers.size === 2) {
            const [a, b] = Array.from(pointers.values());
            const center = {
                x: (a.x + b.x) / 2,
                y: (a.y + b.y) / 2
            };
            const nextDistance = Math.hypot(a.x - b.x, a.y - b.y);
            queueViewport('zoom', nextDistance / pinch.distance, pinch.center);
            queueViewport('pan', center.x - pinch.center.x, center.y - pinch.center.y);
            pinch = {
                distance: nextDistance,
                center,
                zoom: editor.viewport.zoom
            };
            return;
        }
        const g = gesture;
        if (!g) {
            if (pen) {
                pen.hover = world(p);
                renderOverlays();
            }
            if (editor.tool === "move")
                editor.setHover(hit(world(p))?.id ?? null);
            return;
        }
        if (g.kind === "pan") {
            queueViewport('pan', p.x - g.start.x, p.y - g.start.y);
            g.start = p;
            return;
        }
        let point = world(p);
        if (g.kind === "marquee") {
            if (!g.moved && Math.hypot(point.x - g.start.x, point.y - g.start.y) * editor.viewport.zoom < 4)
                return;
            g.moved = true;
            const x = Math.min(point.x, g.start.x), y = Math.min(point.y, g.start.y), w = Math.abs(point.x - g.start.x), h = Math.abs(point.y - g.start.y), a = screen({
                x,
                y
            });
            if (marquee)
                Object.assign(marquee.style, {
                    left: `${a.x}px`,
                    top: `${a.y}px`,
                    width: `${w * editor.viewport.zoom}px`,
                    height: `${h * editor.viewport.zoom}px`
                });
            const ids: string[] = [];
            const collect = (id: string) => {
                const shape = editor.page.objects[id];
                if (!shape || !isEditable(editor.page, id))
                    return;
                if (intersects(bounds([shape]), {x, y, width: w, height: h}))
                    ids.push(id);
            };
            for (const id of editor.page.objects[g.frame ?? "root"]?.childIds ?? [])
                collect(id);
            editor.setSelection(topLevelIds(editor.page, [...g.initial, ...ids]));
            return;
        }
        if (g.kind === "guide") {
            editor.preview(doc => {
                const page = doc.pagesById[editor.pageId], owner = g.frameId ? page.objects[g.frameId] : page;
                owner.guides[g.index].position = point[g.axis as "x" | "y"] - (g.frameId ? (g.axis === "x" ? owner.x : owner.y) : 0);
            });
            return;
        }
        if (g.kind === "gradient") {
            editor.preview(doc => {
                const s = doc.pagesById[editor.pageId].objects[g.id], gradient = s[g.field][g.index].gradient;
                gradient[`x${g.endpoint}`] = (point.x - s.x) / s.width;
                gradient[`y${g.endpoint}`] = (point.y - s.y) / s.height;
            });
            return;
        }
        if (g.kind === "node") {
            let dx = point.x - g.start.x, dy = point.y - g.start.y;
            if (g.xkey === "x") {
                const origin = g.base[g.index], target = {
                    x: origin.x + dx,
                    y: origin.y + dy
                }, threshold = 4 / editor.viewport.zoom;
                let x = target.x, y = target.y;
                for (const [index, node] of (g.base as Data[]).entries()) {
                    if (nodeSelection.has(index) || node.x === undefined)
                        continue;
                    if (Math.abs(node.x - target.x) < threshold)
                        x = node.x;
                    if (Math.abs(node.y - target.y) < threshold)
                        y = node.y;
                }
                if (editor.pixelSnap) {
                    x = Math.round(x);
                    y = Math.round(y);
                }
                dx = x - origin.x;
                dy = y - origin.y;
                drawSnap([...(x !== target.x ? [{
                            axis: "x",
                            value: x
                        }] : []), ...(y !== target.y ? [{
                            axis: "y",
                            value: y
                        }] : [])]);
            }
            editor.preview(doc => {
                const shape = doc.pagesById[editor.pageId].objects[g.ids[0]];
                shape.content = clone(g.base);
                if (g.xkey === "x")
                    movePathNodes(shape, [...nodeSelection], dx, dy);
                else {
                    const index = g.xkey === "x1" ? g.index - 1 : g.index, mode = shape.content[index].handleMode ?? shape.handleMode ?? "free";
                    setPathHandle(shape, index, g.xkey === "x1" ? "out" : "in", {
                        x: g.base[g.index][g.xkey] + dx,
                        y: g.base[g.index][g.ykey] + dy
                    }, event.shiftKey ? "symmetric" : mode === "smooth" ? "aligned" : mode === "corner" ? "free" : mode);
                }
            });
            return;
        }
        if (g.kind === "pen-handle") {
            if (!g.moved && Math.hypot(point.x - g.start.x, point.y - g.start.y) * editor.viewport.zoom < 3)
                return;
            g.moved = true;
            const previous = g.index > 0 ? editor.page.objects[g.id].content[g.index - 1] : null;
            const incoming = {
                x: point.x,
                y: point.y
            };
            if (pen) {
                pen.outgoing = incoming;
                if (g.index === 0) {
                    const start = editor.page.objects[g.id].content[0];
                    pen.firstIncoming = {
                        x: 2 * start.x - point.x,
                        y: 2 * start.y - point.y
                    };
                }
            }
            if (g.index > 0)
                editor.preview(doc => {
                    const node = doc.pagesById[editor.pageId].objects[g.id].content[g.index];
                    node.command = "curve";
                    node.x1 = g.previousOutgoing?.x ?? previous.x;
                    node.y1 = g.previousOutgoing?.y ?? previous.y;
                    node.x2 = node.x - (point.x - node.x);
                    node.y2 = node.y - (point.y - node.y);
                    refreshPath(doc.pagesById[editor.pageId].objects[g.id]);
                });
            renderOverlays();
            return;
        }
        if (g.kind === "draw") {
            let dx = point.x - g.start.x, dy = point.y - g.start.y;
            if (event.shiftKey && !["line", "arrow", "pencil"].includes(g.tool)) {
                const length = Math.max(Math.abs(dx), Math.abs(dy));
                dx = Math.sign(dx || 1) * length;
                dy = Math.sign(dy || 1) * length;
            }
            editor.preview(doc => {
                const s = doc.pagesById[editor.pageId].objects[g.id];
                if (g.tool === "pencil") {
                    if (Math.hypot(point.x - g.points.at(-1).x, point.y - g.points.at(-1).y) > 1 / editor.viewport.zoom)
                        g.points.push(point);
                    s.content = g.points.map((p: Point, i: number) => ({
                        command: i ? "line" : "move",
                        ...p
                    }));
                    const xs = g.points.map((p: Point) => p.x), ys = g.points.map((p: Point) => p.y);
                    s.x = Math.min(...xs);
                    s.y = Math.min(...ys);
                    s.width = Math.max(1, Math.max(...xs) - s.x);
                    s.height = Math.max(1, Math.max(...ys) - s.y);
                }
                else {
                    s.x = Math.min(g.start.x, g.start.x + dx);
                    s.y = Math.min(g.start.y, g.start.y + dy);
                    s.width = Math.max(1, Math.abs(dx));
                    s.height = Math.max(1, Math.abs(dy));
                    if (g.tool === "line" || g.tool === "arrow")
                        s.content = [{
                                command: "move",
                                ...g.start
                            }, {
                                command: "line",
                                x: g.start.x + dx,
                                y: g.start.y + dy
                            }];
                    if (g.tool === "polygon" || g.tool === "star") {
                        const count = g.tool === "star" ? 10 : 5, cx = s.x + s.width / 2, cy = s.y + s.height / 2;
                        s.primitive = {
                            kind: g.tool,
                            count: 5,
                            ratio: 0.5
                        };
                        s.content = Array.from({
                            length: count
                        }, (_, i) => {
                            const ratio = g.tool === "star" && i % 2 ? 0.5 : 1, angle = i * Math.PI * 2 / count - Math.PI / 2;
                            return {
                                command: i ? "line" : "move",
                                x: cx + Math.cos(angle) * s.width / 2 * ratio,
                                y: cy + Math.sin(angle) * s.height / 2 * ratio
                            };
                        });
                        s.content.push({
                            command: "close"
                        });
                    }
                    if (g.tool === "text" && Math.abs(dx) > 4) {
                        s.autoResize = "height";
                        s.height = Math.max(32, s.height);
                    }
                }
            });
            return;
        }
        if (g.kind === "move") {
            let dx = point.x - g.start.x, dy = point.y - g.start.y;
            if (!g.moved && Math.hypot(dx, dy) * editor.viewport.zoom < 4)
                return;
            g.moved = true;
            if (event.shiftKey) {
                if (Math.abs(dx) > Math.abs(dy))
                    dy = 0;
                else
                    dx = 0;
            }
            const snapped = snap({
                x: g.bounds.x + dx,
                y: g.bounds.y + dy
            }, g.ids);
            dx = snapped.point.x - g.bounds.x;
            dy = snapped.point.y - g.bounds.y;
            editor.preview(doc => {
                for (const id of g.ids)
                    transformTree(doc, id, g.base, (s, b) => {
                        resetGeometry(s, b);
                        translate(s, dx, dy);
                    });
            });
            drawSnap(snapped.lines);
            return;
        }
        if (g.kind === "rotate") {
            const b = g.bounds, c = {
                x: b.x + b.width / 2,
                y: b.y + b.height / 2
            };
            let delta = (Math.atan2(point.y - c.y, point.x - c.x) - Math.atan2(g.start.y - c.y, g.start.x - c.x)) * 180 / Math.PI;
            if (event.shiftKey)
                delta = Math.round(delta / 15) * 15;
            const angle = delta * Math.PI / 180;
            editor.preview(doc => {
                for (const id of g.ids)
                    transformTree(doc, id, g.base, (s, b) => {
                        resetGeometry(s, b);
                        const cx = b.x + b.width / 2 - c.x, cy = b.y + b.height / 2 - c.y;
                        const x = c.x + cx * Math.cos(angle) - cy * Math.sin(angle) - b.width / 2, y = c.y + cx * Math.sin(angle) + cy * Math.cos(angle) - b.height / 2;
                        moveShape(s, x - b.x, y - b.y);
                        setShapeOrientation(s, (b.rotation ?? 0) + delta);
                    });
            });
            return;
        }
        if (handles.includes(g.kind)) {
            const b = g.bounds, single = g.ids.length === 1 ? g.base[g.ids[0]] : null, grab = single ? unorientPoint(single, g.start) : g.start;
            if (single)
                point = unorientPoint(single, point);
            const handlePosition = position[g.kind], raw = {
                x: b.x + handlePosition[0] * b.width + point.x - grab.x,
                y: b.y + handlePosition[1] * b.height + point.y - grab.y
            };
            const snapped = snap(single ? orientedPoint(single, raw) : raw, g.ids);
            drawSnap(snapped.lines);
            point = single ? unorientPoint(single, snapped.point) : snapped.point;
            const horizontal = g.kind.includes("w") || g.kind.includes("e"), vertical = g.kind.includes("n") || g.kind.includes("s"), centerX = b.x + b.width / 2, centerY = b.y + b.height / 2;
            let width = horizontal ? Math.max(1, g.kind.includes("w") ? b.x + b.width - point.x : point.x - b.x) : b.width;
            let height = vertical ? Math.max(1, g.kind.includes("n") ? b.y + b.height - point.y : point.y - b.y) : b.height;
            if (event.altKey) {
                if (horizontal)
                    width = Math.max(1, Math.abs(point.x - centerX) * 2);
                if (vertical)
                    height = Math.max(1, Math.abs(point.y - centerY) * 2);
            }
            if (event.shiftKey || single?.constrainProportions) {
                const ratio = b.width / b.height;
                if (horizontal && !vertical)
                    height = width / ratio;
                else if (vertical && !horizontal)
                    width = height * ratio;
                else if (width / height > ratio)
                    height = width / ratio;
                else
                    width = height * ratio;
            }
            const left = event.altKey ? centerX - width / 2 : g.kind.includes("w") ? b.x + b.width - width : g.kind.includes("e") ? b.x : centerX - width / 2;
            const top = event.altKey ? centerY - height / 2 : g.kind.includes("n") ? b.y + b.height - height : g.kind.includes("s") ? b.y : centerY - height / 2;
            const sx = width / Math.max(1, b.width), sy = height / Math.max(1, b.height);
            const center = single ? orientedPoint(single, {
                x: left + width / 2,
                y: top + height / 2
            }) : {
                x: left + width / 2,
                y: top + height / 2
            };
            const rect = {
                x: center.x - width / 2,
                y: center.y - height / 2,
                width,
                height
            };
            const scale = {
                a: sx,
                b: 0,
                c: 0,
                d: sy,
                e: 0,
                f: 0
            };
            const linear = single ? multiply(multiply(single.transform, scale), inverse(single.transform)) : scale;
            const oldCenter = {
                x: b.x + b.width / 2,
                y: b.y + b.height / 2
            };
            const matrix = {
                ...linear,
                e: center.x - linear.a * oldCenter.x - linear.c * oldCenter.y,
                f: center.y - linear.b * oldCenter.x - linear.d * oldCenter.y
            };
            editor.preview(doc => {
                for (const id of g.ids) {
                    if (single?.type === "frame") {
                        const shape = doc.pagesById[editor.pageId].objects[id];
                        resetGeometry(shape, g.base[id]);
                        resizeShape(shape, rect);
                    }
                    else
                        transformTree(doc, id, g.base, (shape, base) => {
                            resetGeometry(shape, base);
                            if (single && shape.id === id)
                                resizeShape(shape, rect);
                            else
                                transformShapes([shape], matrix);
                        });
                }
            });
        }
    }
    function up(event: PointerEvent) {
        pointers.delete(event.pointerId);
        if (pinch) {
            if (pointers.size < 2)
                pinch = null;
            return;
        }
        const g = gesture;
        gesture = null;
        overlay.querySelectorAll(".snap-line").forEach(n => n.remove());
        marquee?.remove();
        marquee = null;
        if (!g)
            return;
        if (g.kind === "marquee") {
            if (!g.moved && g.frame)
                editor.setSelection(g.additive ? [...new Set([...g.initial, g.frame])] : [g.frame]);
            return;
        }
        if (g.kind === "pan")
            return;
        if (g.kind === "pen-handle")
            return;
        if (g.kind === "guide") {
            const p = local(event);
            if (p.x < 0 || p.y < 0 || p.x > stage.clientWidth || p.y > stage.clientHeight)
                editor.preview(doc => {
                    const page = doc.pagesById[editor.pageId], owner = g.frameId ? page.objects[g.frameId] : page;
                    owner.guides.splice(g.index, 1);
                });
        }
        if (g.kind === "draw") {
            const s = editor.page.objects[g.id];
            if (g.tool === "text") {
                text.start(g.id, false, true).catch(error => toast(String(error), "error"));
            }
            else {
                if (s && s.width <= 1 && s.height <= 1)
                    editor.preview(doc => {
                        const shape = doc.pagesById[editor.pageId].objects[g.id];
                        shape.width = 100;
                        shape.height = 100;
                        if (["line", "arrow", "pencil"].includes(g.tool))
                            shape.content = [{
                                    command: "move",
                                    x: shape.x,
                                    y: shape.y
                                }, {
                                    command: "line",
                                    x: shape.x + 100,
                                    y: shape.y + 100
                                }];
                        if (["polygon", "star"].includes(g.tool)) {
                            const count = g.tool === "star" ? 10 : 5;
                            shape.primitive = {
                                kind: g.tool,
                                count: 5,
                                ratio: 0.5
                            };
                            shape.content = Array.from({
                                length: count
                            }, (_, i) => {
                                const ratio = g.tool === "star" && i % 2 ? 0.5 : 1, angle = i * Math.PI * 2 / count - Math.PI / 2;
                                return {
                                    command: i ? "line" : "move",
                                    x: shape.x + 50 + Math.cos(angle) * 50 * ratio,
                                    y: shape.y + 50 + Math.sin(angle) * 50 * ratio
                                };
                            });
                            shape.content.push({
                                command: "close"
                            });
                        }
                    });
                editor.commitSession();
            }
            editor.setTool("move");
            drawId = null;
        }
        else {
            if (g.kind === "node" && g.xkey === "x" && nodeSelection.size === 1) {
                const index = [...nodeSelection][0], active = editor.page.objects[g.ids[0]], last = active.content.findLastIndex((node: Data) => node.command !== "close");
                if ((index === 0 || index === last) && active.content.filter((node: Data) => node.command === "move").length === 1 && !active.content.some((node: Data) => node.command === "close")) {
                    const endpoint = active.content[index];
                    let joined = false;
                    for (const other of Object.values(editor.page.objects)) {
                        if (other.type !== "path" || !isEditable(editor.page, other.id) || !Array.isArray(other.content) || other.content.filter((node: Data) => node.command === "move").length !== 1 || other.content.some((node: Data) => node.command === "close"))
                            continue;
                        const otherLast = other.content.findLastIndex((node: Data) => node.command !== "close");
                        for (const otherIndex of [0, otherLast]) {
                            if (other.id === active.id && (otherIndex === index || other.content.some((node: Data) => node.command === "close")))
                                continue;
                            const target = other.content[otherIndex];
                            if (!target || Math.hypot(target.x - endpoint.x, target.y - endpoint.y) > 6 / editor.viewport.zoom)
                                continue;
                            editor.preview(doc => {
                                const page = doc.pagesById[editor.pageId];
                                if (other.id === active.id)
                                    closePath(page.objects[active.id]);
                                else {
                                    joinPathEnds(page.objects[active.id], page.objects[other.id], {
                                        firstStart: index === 0,
                                        secondEnd: otherIndex === otherLast
                                    });
                                    removeShapes(page, [other.id]);
                                }
                            });
                            joined = true;
                            break;
                        }
                        if (joined)
                            break;
                    }
                }
            }
            if (g.kind === "move" && g.moved && !event.altKey) {
                const center = world(local(event)), parent = parentAt(center, g.ids);
                editor.preview(doc => {
                    const page = doc.pagesById[editor.pageId];
                    for (const id of g.ids) {
                        const s = page.objects[id];
                        if (!s || s.parentId === parent || g.ids.includes(parent))
                            continue;
                        let walk = page.objects[parent];
                        let cyclic = false;
                        while (walk && walk.id !== "root") {
                            if (walk.id === id) {
                                cyclic = true;
                                break;
                            }
                            walk = page.objects[walk.parentId];
                        }
                        if (cyclic)
                            continue;
                        const old = page.objects[s.parentId];
                        if (old?.childIds)
                            old.childIds = old.childIds.filter(c => c !== id);
                        (page.objects[parent].childIds ??= []).push(id);
                        s.parentId = parent;
                        s.enclosingFrameId = parent;
                    }
                });
            }
            editor.commitSession();
        }
        if (event.pointerType === "touch" && g.kind === "move" && !g.moved) {
            const now = performance.now(), id = editor.selection[0] ?? null;
            if (id && lastTap.id === id && now - lastTap.time < 350) {
                const shape = editor.page.objects[id];
                if (shape?.type === "text")
                    text.start(id, false).catch(error => toast(String(error), "error"));
                else if (shape?.type === "path") {
                    pathId = id;
                    renderOverlays();
                }
            }
            lastTap = {
                time: now,
                id
            };
        }
        renderOverlays(false);
        callbacks.changed();
    }
    function penDown(event: PointerEvent, point: Point) {
        let previousOutgoing: Point | undefined;
        if (pen)
            delete pen.hover;
        if (!pen) {
            if (!editor.begin("Draw pen path"))
                return;
            const parentId = parentAt(point), id = addShape("path", {
                x: point.x,
                y: point.y,
                width: 0,
                height: 0,
                parentId,
                enclosingFrameId: parentId,
                name: "Pen",
                content: [{
                        command: "move",
                        ...point
                    }],
                fills: [],
                strokes: [{
                        color: "#334155",
                        width: 2
                    }]
            });
            pen = {
                id
            };
            editor.setSelection([id]);
        }
        else {
            const shape = editor.page.objects[pen.id], first = shape.content[0];
            if (shape.content.length > 2 && Math.hypot(first.x - point.x, first.y - point.y) * editor.viewport.zoom < 8) {
                editor.preview(doc => {
                    const target = doc.pagesById[editor.pageId].objects[pen!.id], last = target.content.at(-1);
                    if (pen!.outgoing || pen!.firstIncoming)
                        target.content.push({
                            command: "curve",
                            x1: pen!.outgoing?.x ?? last.x,
                            y1: pen!.outgoing?.y ?? last.y,
                            x2: pen!.firstIncoming?.x ?? first.x,
                            y2: pen!.firstIncoming?.y ?? first.y,
                            x: first.x,
                            y: first.y
                        });
                    target.content.push({
                        command: "close"
                    });
                    refreshPath(target);
                });
                finishPen();
                return;
            }
            previousOutgoing = pen.outgoing;
            editor.preview(doc => {
                const target = doc.pagesById[editor.pageId].objects[pen!.id];
                target.content.push(previousOutgoing ? {
                    command: "curve",
                    x1: previousOutgoing.x,
                    y1: previousOutgoing.y,
                    x2: point.x,
                    y2: point.y,
                    ...point
                } : {
                    command: "line",
                    ...point
                });
                refreshPath(target);
            });
            delete pen.outgoing;
        }
        const index = editor.page.objects[pen.id].content.length - 1;
        gesture = {
            kind: "pen-handle",
            id: pen.id,
            index,
            start: point,
            previousOutgoing
        };
        stage.setPointerCapture(event.pointerId);
        event.preventDefault();
        renderOverlays();
    }
    function finishPen(tool: Tool = "move") {
        if (!pen)
            return;
        const id = pen.id;
        pen = null;
        gesture = null;
        const shape = editor.page.objects[id];
        if (shape?.content?.length < 2)
            editor.cancelSession();
        else
            editor.commitSession();
        editor.setTool(tool);
        pathId = tool === "move" && editor.page.objects[id] ? id : null;
        renderOverlays();
    }
    function insertPathNode(point: Point) {
        if (!pathId)
            return;
        editor.transact("Insert path node", doc => {
            const shape = doc.pagesById[editor.pageId].objects[pathId!], list = shape.content;
            let nearest = 1, distance = Infinity, bestT = 0.5;
            for (let index = 1; index < list.length; index++) {
                const a = list[index - 1], b = list[index];
                if (a.x === undefined || b.x === undefined || b.command === "move")
                    continue;
                for (let sample = 1; sample < 40; sample++) {
                    const t = sample / 40, u = 1 - t;
                    const p = b.command === "curve" ? {
                        x: u * u * u * a.x + 3 * u * u * t * b.x1 + 3 * u * t * t * b.x2 + t * t * t * b.x,
                        y: u * u * u * a.y + 3 * u * u * t * b.y1 + 3 * u * t * t * b.y2 + t * t * t * b.y
                    } : {
                        x: a.x + t * (b.x - a.x),
                        y: a.y + t * (b.y - a.y)
                    };
                    const d = Math.hypot(point.x - p.x, point.y - p.y);
                    if (d < distance) {
                        distance = d;
                        nearest = index;
                        bestT = t;
                    }
                }
            }
            const inserted = splitPathNode(shape, nearest, bestT);
            nodeSelection = new Set([inserted]);
        });
    }
    function deleteNodes() {
        if (!pathId || !nodeSelection.size || !isEditable(editor.page, pathId))
            return false;
        editor.transact("Delete path nodes", doc => {
            const s = doc.pagesById[editor.pageId].objects[pathId!];
            deletePathNodes(s, [...nodeSelection]);
        });
        nodeSelection.clear();
        renderOverlays();
        return true;
    }
    function cancelInteraction() {
        pen = null;
        gesture = null;
        pathId = null;
        drawId = null;
        pointers.clear();
        pinch = null;
        marquee?.remove();
        marquee = null;
        overlay.querySelectorAll(".snap-line").forEach(n => n.remove());
        nodeSelection.clear();
        editor.cancelSession();
        renderOverlays(false);
    }
    function nodeKey(event: KeyboardEvent) {
        if (event.key === "Escape" && (pen || gesture || pathId)) {
            event.preventDefault();
            cancelInteraction();
            return true;
        }
        if (event.key === "Enter" && pen) {
            event.preventDefault();
            finishPen();
            return true;
        }
        if (!pathId || text.active || !isEditable(editor.page, pathId))
            return false;
        if (["Delete", "Backspace"].includes(event.key) && nodeSelection.size) {
            event.preventDefault();
            return deleteNodes();
        }
        if (event.key.startsWith("Arrow") && nodeSelection.size) {
            event.preventDefault();
            const step = event.shiftKey ? 10 : 1, dx = event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0, dy = event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0;
            editor.transact("Nudge path nodes", doc => movePathNodes(doc.pagesById[editor.pageId].objects[pathId!], [...nodeSelection], dx, dy));
            return true;
        }
        if (event.key.toLowerCase() === "j" && nodeSelection.size) {
            event.preventDefault();
            const shape = editor.page.objects[pathId], last = shape.content.findLastIndex((node: Data) => node.command !== "close");
            if (nodeSelection.has(0) && nodeSelection.has(last))
                editor.transact("Join selected endpoints", doc => joinPathEnds(doc.pagesById[editor.pageId].objects[pathId!], undefined, {
                    merge: event.metaKey || event.ctrlKey
                }));
            return true;
        }
        return false;
    }
    stage.addEventListener("pointerdown", event => {
        flushViewport();
        down(event).catch(error => {
            cancelInteraction();
            toast(String(error), "error");
        });
    }, {
        signal
    });
    stage.addEventListener("pointermove", event => {
        try {
            move(event);
        }
        catch (error) {
            cancelInteraction();
            toast(String(error), "error");
        }
    }, {
        signal
    });
    window.addEventListener("pointerup", event => {
        try {
            flushViewport();
            up(event);
        }
        catch (error) {
            cancelInteraction();
            toast(String(error), "error");
        }
    }, {
        signal
    });
    stage.addEventListener("pointercancel", () => {
        cancelInteraction();
    }, {
        signal
    });
    stage.addEventListener("wheel", event => {
        event.preventDefault();
        if (event.ctrlKey || event.metaKey)
            queueViewport('zoom', Math.exp(-event.deltaY * 0.01), local(event));
        else
            queueViewport('pan', -event.deltaX, -event.deltaY);
    }, {
        signal,
        passive: false
    });
    stage.addEventListener("dblclick", event => {
        const point = world(local(event)), shape = hit(point, true);
        if (editor.tool === "pen") {
            if (pen)
                editor.preview(doc => {
                    const target = doc.pagesById[editor.pageId].objects[pen!.id], nodes = target.content;
                    // The second click of a double-click has already appended its endpoint.
                    while (nodes.length > 1 && nodes.at(-1).command === "line" && nodes.at(-1).x === nodes.at(-2).x && nodes.at(-1).y === nodes.at(-2).y)
                        nodes.pop();
                    refreshPath(target);
                });
            finishPen();
            return;
        }
        if (shape?.type === "text")
            text.start(shape.id);
        else if (shape?.type === "path") {
            pathId = shape.id;
            editor.setSelection([shape.id]);
            renderOverlays();
        }
        else if (shape?.childIds?.length)
            editor.setSelection(shape.childIds);
    }, {
        signal
    });
    stage.addEventListener("contextmenu", event => {
        event.preventDefault();
        const shape = hit(world(local(event)), event.metaKey);
        if (shape && !editor.selection.includes(shape.id))
            editor.setSelection([shape.id]);
        callbacks.context(event, shape?.id);
    }, {
        signal
    });
    stage.addEventListener("dragover", event => {
        if (event.dataTransfer?.types.includes("Files")) {
            event.preventDefault();
            event.dataTransfer.dropEffect = "copy";
        }
    }, {
        signal
    });
    stage.addEventListener("drop", event => {
        if (event.dataTransfer?.files.length) {
            event.preventDefault();
            callbacks.importFiles(Array.from(event.dataTransfer.files), world(local(event))).catch(e => toast(String(e), "error"));
        }
    }, {
        signal
    });
    window.addEventListener("keydown", event => {
        if ((event.target as HTMLElement).closest("input,textarea,select,[contenteditable=true]"))
            return;
        if (event.code === "Space") {
            space = true;
            stage.style.cursor = "grab";
            event.preventDefault();
        }
        if (event.key === "Escape")
            cancelInteraction();
        if (event.key === "Enter" && pen) {
            finishPen();
            event.preventDefault();
        }
        if ((event.key === "Delete" || event.key === "Backspace") && deleteNodes()) {
            event.preventDefault();
            event.stopImmediatePropagation();
        }
    }, {
        signal
    });
    window.addEventListener("keyup", event => {
        if (event.code === "Space") {
            space = false;
            renderOverlays();
        }
    }, {
        signal
    });
    let interactionPage = editor.pageId;
    const unsubscribe = editor.on(event => {
        if (event.changes || event.deltas || event.projection || event.page) {
            const changed = (event as Data).changedShapeIds?.[editor.pageId] as string[] | undefined;
            if (!changed || changed.some(id => !snapExcluded.has(id))) snapKey = undefined;
        }
        if (editor.pageId !== interactionPage) {
            interactionPage = editor.pageId;
            pen = null;
            gesture = null;
            pathId = null;
            selectedGradient = null;
            pointers.clear();
            pinch = null;
            marquee?.remove();
            marquee = null;
            nodeSelection.clear();
        }
        if (pathId && (editor.selection.length !== 1 || editor.selection[0] !== pathId)) {
            pathId = null;
            nodeSelection.clear();
        }
        if (event.tool) {
            pathId = null;
            nodeSelection.clear();
            selectedGradient = null;
            if (pen && editor.tool !== "pen")
                finishPen(editor.tool);
            else if (gesture)
                cancelInteraction();
        }
        if (pen && !editor.page.objects[pen.id]) {
            pen = null;
            gesture = null;
            editor.cancelSession();
        }
        if (event.hover)
            return;
        if (event.deltas && editor.undo.blocked && !event.changes && !event.projection && !event.page && !event.selection && !event.tool)
            scheduleOverlays();
        else
            renderOverlays(false);
    });
    const offRender = services.view.onRender?.(() => renderOverlays(false)) ?? (() => {
    });
    renderOverlays();
    return {
        render: renderOverlays,
        flush: () => { flushViewport(); renderOverlays(false); },
        get diagnostics() {
            return {overlayBuilds, decorationBuilds, pendingOverlay: pendingOverlay !== null, pendingViewport: viewportFrame !== null, hitCandidates};
        },
        world,
        screen,
        hit,
        zoom,
        pan,
        fit(ids = editor.selection) {
            const shapes = (ids.length ? ids : Object.keys(editor.page.objects)).map(id => editor.page.objects[id]).filter(s => s && s.id !== "root" && !s.hidden);
            if (!shapes.length)
                return;
            const b = bounds(shapes), v = editor.viewport, z = Math.min((stage.clientWidth - 100) / Math.max(1, b.width), (stage.clientHeight - 100) / Math.max(1, b.height), 4);
            editor.setViewport({
                ...v,
                zoom: Math.max(0.02, z),
                vbox: {
                    x: b.x + b.width / 2 - stage.clientWidth / z / 2,
                    y: b.y + b.height / 2 - stage.clientHeight / z / 2,
                    width: stage.clientWidth / z,
                    height: stage.clientHeight / z
                }
            });
        },
        editPath(id: string) {
            text.exit();
            pathId = id;
            nodeSelection.clear();
            editor.setSelection([id]);
            renderOverlays();
            callbacks.changed();
        },
        selectPathNode(index: number) {
            const node = pathId && editor.page.objects[pathId]?.content?.[index];
            if (!node || node.command === "close")
                return;
            nodeSelection = new Set([index]);
            renderOverlays();
            callbacks.changed();
        },
        get selectedPathNodes() {
            return [...nodeSelection].filter(index => {
                const node = pathId && editor.page.objects[pathId]?.content?.[index];
                return node && node.command !== "close";
            });
        },
        editGradient(id: string, field: string, index: number) {
            selectedGradient = {
                id,
                field,
                index
            };
            renderOverlays();
        },
        highlightAgent(agent: string, ids: string[]) {
            if (ids.length)
                agents.set(agent, ids);
            else
                agents.delete(agent);
            renderOverlays();
        },
        finishPen,
        key: nodeKey,
        deleteNodes,
        get pathId() {
            return pathId;
        },
        get active() {
            return !!gesture || !!pen;
        },
        destroy() {
            destroyed = true;
            if (viewportFrame !== null) cancelAnimationFrame(viewportFrame);
            viewportFrame = null; queuedViewport = queuedBase = null;
            hitSource = undefined; hitIndex = undefined; hitFallback = []; snapIndex = undefined; snapKey = undefined; guideOwners = [];
            cancelOverlayFrame();
            abort.abort();
            unsubscribe();
            offRender();
            if (gesture || pen)
                editor.cancelSession();
            overlay.replaceChildren();
        }
    };
}
