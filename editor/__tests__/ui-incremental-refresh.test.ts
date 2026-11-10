// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Editor, createDocument, createPage, createShape, insertShape } from "../document";
import { createCanvasInteraction } from "../interaction/canvas";
import { createInspector } from "../ui/inspector";
import { createRenderer } from "../render";
import type { EditorServices, Shape } from "../contracts";

const cleanups: Array<() => void> = [];
beforeEach(() => {
    vi.stubGlobal("CSS", { escape: (value: string) => value });
    HTMLDialogElement.prototype.showModal = function() { this.open = true; };
    HTMLDialogElement.prototype.close = function() { this.open = false; this.dispatchEvent(new Event("close")); };
});
afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup();
    document.body.replaceChildren();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});
function fixture(extra: Shape[] = []) {
    const doc = createDocument(), page = doc.pagesById[doc.pages[0]];
    for (const shape of [createShape("rect", { id: "selected", x: 10, y: 20, width: 40, height: 30 }),
        createShape("rect", { id: "other", x: 200, y: 20, width: 40, height: 30 }), ...extra])
        insertShape(page, shape);
    const editor = new Editor(doc);
    editor.setSelection(["selected"]);
    return editor;
}
function canvasFixture(extra: Shape[] = []) {
    const editor = fixture(extra), stage = document.createElement("div"), overlay = document.createElement("div");
    stage.append(overlay);
    document.body.append(stage);
    Object.defineProperties(stage, { clientWidth: { value: 800 }, clientHeight: { value: 600 } });
    const frames = new Map<number, FrameRequestCallback>();
    let frameId = 0, revision = 0;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId; });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
    const listeners = new Set<() => void>();
    const publish = () => { revision++; for (const listener of listeners) listener(); };
    // The scene subscription precedes interaction mounting in the workspace.
    const off = editor.on(event => {
        if (event.changes || event.viewport || event.page || event.deltas && !editor.undo.blocked) publish();
    });
    const canvas = createCanvasInteraction(stage, overlay, {
        editor, view: { element: () => null, get renderRevision() { return revision; },
            onRender: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); } }
    } as unknown as EditorServices, { active: false, exit: async () => {} } as any,
    { context: () => {}, changed: () => {}, importFiles: async () => {} });
    cleanups.push(() => { canvas.destroy(); off(); editor.destroy(); });
    return { editor, stage, overlay, canvas, frames, publish };
}
function inspectorFixture() {
    const editor = fixture(), root = document.createElement("div");
    document.body.append(root);
    const inspector = createInspector(root, { editor, commands: {} } as unknown as EditorServices,
        { active: false } as any, {} as any, {});
    cleanups.push(() => { inspector.destroy(); editor.destroy(); });
    const field = (label: string) => root.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
    return { editor, root, inspector, field };
}

it("updates the page inspector on a page-and-viewport event without carrying the old page's focused draft", () => {
    const t = inspectorFixture(), originalPage = t.editor.pageId;
    t.editor.transact("Add page", doc => {
        const page = createPage("Examples", "examples");
        doc.pages.push(page.id); doc.pagesById[page.id] = page;
        doc.pagesById[originalPage].name = "Cover";
    });
    t.editor.setSelection([]);
    const oldName = t.field("Name");
    oldName.focus(); oldName.value = "Uncommitted Cover draft";
    t.editor.setPage("examples");
    expect(t.field("Name").value).toBe("Examples");
    expect(t.field("Name")).not.toBe(oldName);
    const rebuilds = t.inspector.diagnostics.rebuilds;
    t.editor.setViewport({ ...t.editor.viewport, vbox: { ...t.editor.viewport.vbox, x: 100 } });
    expect(t.inspector.diagnostics.rebuilds).toBe(rebuilds);
    t.field("Name").value = "Edited Examples";
    t.field("Name").dispatchEvent(new Event("change", { bubbles: true }));
    expect(t.editor.page.name).toBe("Edited Examples");
    expect(t.editor.doc.pagesById[originalPage].name).toBe("Cover");
    t.editor.setPage(originalPage);
    expect(t.field("Name").value).toBe("Cover");
});

it("does not transfer a focused inspector draft to a different selected layer", () => {
    const t = inspectorFixture(), oldName = t.field("Name");
    oldName.focus(); oldName.value = "Uncommitted selected-layer draft";
    t.editor.setSelection(["other"]);
    expect(t.field("Name").value).toBe(t.editor.page.objects.other.name);
    expect(t.field("Name")).not.toBe(oldName);
});

it("builds one overlay for a committed scene change and none for duplicate frame notifications", () => {
    const t = canvasFixture(), initial = t.canvas.diagnostics.overlayBuilds;
    t.editor.transact("Move", doc => { doc.pagesById[t.editor.pageId].objects.selected.x = 75; });
    expect(t.canvas.diagnostics.overlayBuilds - initial).toBe(1);
    expect(t.overlay.querySelector<HTMLElement>(".selection-outline")!.style.left).toBe("75px");
    const outline = t.overlay.querySelector(".selection-outline");
    t.canvas.flush();
    expect(t.overlay.querySelector(".selection-outline")).toBe(outline);
    t.editor.setHover("other");
    expect(t.canvas.diagnostics.overlayBuilds - initial).toBe(1);
});

it("coalesces preview overlays with the rendered frame while applying every preview and synchronously flushing commit and Undo", () => {
    const t = canvasFixture(), initial = t.canvas.diagnostics.overlayBuilds;
    expect(t.editor.begin("Move gesture")).toBe(true);
    for (let x = 11; x <= 110; x++) {
        t.editor.preview(doc => { doc.pagesById[t.editor.pageId].objects.selected.x = x; });
        expect(t.editor.page.objects.selected.x).toBe(x);
    }
    expect(t.canvas.diagnostics.overlayBuilds - initial).toBe(0);
    expect(t.frames.size).toBe(1);
    t.publish();
    expect(t.canvas.diagnostics.overlayBuilds - initial).toBe(1);
    expect(t.frames.size).toBe(0);
    expect(t.overlay.querySelector<HTMLElement>(".selection-outline")!.style.left).toBe("110px");
    t.editor.preview(doc => { doc.pagesById[t.editor.pageId].objects.selected.x = 125; });
    expect(t.editor.commitSession()).toBe(true);
    expect(t.frames.size).toBe(0);
    expect(t.overlay.querySelector<HTMLElement>(".selection-outline")!.style.left).toBe("125px");
    expect(t.editor.undoStep()).toBe(true);
    expect(t.overlay.querySelector<HTMLElement>(".selection-outline")!.style.left).toBe("10px");
    expect(t.editor.undoStep()).toBe(false);
});

it("restores cancelled previews synchronously and cancels scheduled overlay work on destroy", () => {
    const t = canvasFixture();
    t.editor.begin("Cancelled gesture");
    t.editor.preview(doc => { doc.pagesById[t.editor.pageId].objects.selected.x = 99; });
    t.publish();
    t.editor.cancelSession();
    expect(t.frames.size).toBe(0);
    expect(t.overlay.querySelector<HTMLElement>(".selection-outline")!.style.left).toBe("10px");
    expect(t.editor.undoStep()).toBe(false);
    t.editor.begin("Pending gesture");
    t.editor.preview(doc => { doc.pagesById[t.editor.pageId].objects.selected.x = 50; });
    const callback = [...t.frames.values()][0], builds = t.canvas.diagnostics.overlayBuilds;
    t.canvas.destroy();
    expect(t.frames.size).toBe(0);
    callback(0);
    expect(t.canvas.diagnostics.overlayBuilds).toBe(builds);
});

it("keeps real renderer and pointer gesture overlays in one frame, including DOM-read and pointerup flushes", async () => {
    const frames = new Map<number, FrameRequestCallback>();
    let frameId = 0, sceneRenders = 0;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId; });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    Object.defineProperty(document, "fonts", { configurable: true, value: Object.assign(new EventTarget(), { ready: Promise.resolve() }) });
    const editor = fixture(), stage = document.createElement("div"), overlay = document.createElement("div");
    editor.snapping = false;
    stage.setPointerCapture = () => {};
    stage.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600, toJSON: () => ({}) });
    Object.defineProperties(stage, { clientWidth: { value: 800 }, clientHeight: { value: 600 } });
    document.body.append(stage);
    const view = createRenderer(editor, stage, { onTiming: (record: { phase: string }) => { if (record.phase === "render.attachSvg") sceneRenders++; } });
    stage.append(overlay);
    const canvas = createCanvasInteraction(stage, overlay, { editor, view } as unknown as EditorServices,
        { active: false, exit: async () => {} } as any, { context: () => {}, changed: () => {}, importFiles: async () => {} });
    cleanups.push(() => { canvas.destroy(); view.destroy(); editor.destroy(); });
    await view.settled();
    sceneRenders = 0;
    const initial = canvas.diagnostics.overlayBuilds;
    const send = (type: string, x: number) => {
        const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, buttons: type === "pointerup" ? 0 : 1, clientX: x, clientY: 30 });
        Object.defineProperty(event, "pointerId", { value: 1 });
        (type === "pointerup" ? window : stage).dispatchEvent(event);
    };
    send("pointerdown", 20);
    for (let x = 30; x <= 120; x++) send("pointermove", x);
    expect(editor.page.objects.selected.x).toBe(110);
    expect(sceneRenders).toBe(0);
    expect(canvas.diagnostics.overlayBuilds).toBe(initial);
    const [id, callback] = [...frames.entries()][0];
    frames.delete(id); callback(16);
    expect(frames.size).toBe(0);
    expect(sceneRenders).toBe(1);
    expect(canvas.diagnostics.overlayBuilds - initial).toBe(1);
    expect(overlay.querySelector<HTMLElement>(".selection-outline")!.style.left).toBe("110px");
    send("pointermove", 140);
    expect(view.element("selected")).not.toBeNull();
    expect(view.measure(["selected"]).get("selected")!.x).toBe(130);
    expect(frames.size).toBe(0);
    expect(sceneRenders).toBe(2);
    expect(canvas.diagnostics.overlayBuilds - initial).toBe(2);
    expect(overlay.querySelector<HTMLElement>(".selection-outline")!.style.left).toBe("130px");
    send("pointermove", 160);
    send("pointerup", 160);
    expect(editor.page.objects.selected.x).toBe(150);
    expect(canvas.active).toBe(false);
    expect(frames.size).toBe(0);
    expect(sceneRenders).toBe(3);
    expect(canvas.diagnostics.overlayBuilds - initial).toBe(3);
    expect(overlay.querySelector<HTMLElement>(".selection-outline")!.style.left).toBe("150px");
    expect(editor.undoStep()).toBe(true);
    expect(view.measure(["selected"]).get("selected")!.x).toBe(10);
    expect(overlay.querySelector<HTMLElement>(".selection-outline")!.style.left).toBe("10px");
});

it("retains visible grid DOM across selection and unrelated edits, culling only offscreen decorations", () => {
    const grid = { pattern: "columns", count: 25, gutter: 2, color: "#123456", opacity: 0.2 };
    const offscreen = Array.from({ length: 50 }, (_, index) => createShape("frame", {
        id: `off-${index}`, x: 5000 + index * 300, y: 20, width: 200, height: 200, childIds: [], layoutGrids: [grid]
    }));
    const t = canvasFixture([createShape("frame", { id: "visible", x: 20, y: 20, width: 200, height: 200,
        childIds: [], layoutGrids: [grid] }), ...offscreen, createShape("frame", { id: "guide-owner", x: 4000,
        y: 20, width: 200, height: 50, childIds: [], guides: [{ axis: "x", position: -3900 }] })]);
    const visible = t.overlay.querySelector('[data-frame-grid="visible"]');
    expect(visible?.children).toHaveLength(25);
    expect(t.overlay.querySelectorAll("[data-frame-grid]")).toHaveLength(1);
    // Frame guides may lie outside the frame itself: test the line, not its owner.
    expect(t.overlay.querySelector<HTMLElement>(".frame-decorations .guide-line")!.style.left).toBe("100px");
    const initial = t.canvas.diagnostics.decorationBuilds;
    t.editor.setSelection(["other"]);
    t.editor.transact("Unrelated movement", doc => { doc.pagesById[t.editor.pageId].objects.other.x = 250; });
    expect(t.overlay.querySelector('[data-frame-grid="visible"]')).toBe(visible);
    expect(t.canvas.diagnostics.decorationBuilds).toBe(initial);
    t.editor.setViewport({ ...t.editor.viewport, vbox: { x: 5000, y: 0, width: 800, height: 600 } });
    expect(t.overlay.querySelector('[data-frame-grid="visible"]')).toBeNull();
    expect(t.overlay.querySelector('[data-frame-grid="off-0"]')).not.toBeNull();
    expect(t.overlay.querySelectorAll("[data-frame-grid]").length).toBeLessThan(5);
    expect(t.editor.page.objects["off-49"]).toBeDefined();
});

it("keeps a rotated grid that crosses the viewport edge even with a different imported affine matrix", () => {
    const t = canvasFixture([createShape("frame", { id: "rotated-grid", x: 805, y: 200, width: 20, height: 200,
        rotation: 90, transform: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }, childIds: [], layoutGrids: [{ pattern: "grid", size: 8 }] })]);
    expect(t.overlay.querySelector('[data-frame-grid="rotated-grid"]')).not.toBeNull();
});

it("retains inspector controls across unrelated edits and geometry changes without creating a blur transaction", () => {
    const t = inspectorFixture(), x = t.field("X"), width = t.field("W");
    const initial = t.inspector.diagnostics.rebuilds;
    t.editor.transact("Other layer", doc => { doc.pagesById[t.editor.pageId].objects.other.name = "Changed elsewhere"; });
    expect(t.field("X")).toBe(x);
    expect(t.inspector.diagnostics.rebuilds).toBe(initial);
    for (let value = 11; value <= 30; value++)
        t.editor.transact("Move", doc => { doc.pagesById[t.editor.pageId].objects.selected.x = value; });
    t.editor.transact("Resize", doc => { doc.pagesById[t.editor.pageId].objects.selected.width = 100; });
    expect(t.inspector.diagnostics.rebuilds).toBe(initial);
    expect(t.inspector.diagnostics.geometryUpdates).toBe(21);
    expect(t.field("X")).toBe(x);
    expect(x.value).toBe("30");
    expect(t.field("W")).toBe(width);
    expect(width.value).toBe("100");
    const commits = vi.fn();
    const off = t.editor.on(event => { if (event.changes) commits(); });
    x.focus(); x.blur(); width.focus(); width.blur();
    expect(commits).not.toHaveBeenCalled();
    off();
    expect(t.editor.undoStep()).toBe(true);
    expect(t.field("W").value).toBe("40");
});

it("preserves a focused dirty inspector value during geometry updates and commits the user's value once", () => {
    const t = inspectorFixture(), x = t.field("X");
    x.focus();
    x.value = "87";
    t.editor.transact("Remote move", doc => {
        doc.pagesById[t.editor.pageId].objects.selected.x = 45;
        doc.pagesById[t.editor.pageId].objects.selected.y = 65;
    });
    expect(document.activeElement).toBe(x);
    expect(x.value).toBe("87");
    expect(t.field("Y").value).toBe("65");
    const commits = vi.fn();
    const off = t.editor.on(event => { if (event.changes) commits(); });
    x.blur();
    expect(t.editor.page.objects.selected.x).toBe(87);
    expect(commits).toHaveBeenCalledTimes(1);
    off();
    expect(t.editor.undoStep()).toBe(true);
    expect(t.editor.page.objects.selected.x).toBe(45);
});

it("synchronizes focused clean fields after remote geometry without turning blur into an edit", () => {
    const t = inspectorFixture(), x = t.field("X"), commits = vi.fn();
    x.focus();
    const remote = structuredClone(t.editor.doc);
    remote.pagesById[t.editor.pageId].objects.selected.x = 92;
    t.editor.receiveDocument(remote);
    expect(t.field("X")).toBe(x);
    expect(document.activeElement).toBe(x);
    expect(x.value).toBe("92");
    const off = t.editor.on(event => { if (event.changes) commits(); });
    x.blur();
    expect(commits).not.toHaveBeenCalled();
    expect(t.editor.page.objects.selected.x).toBe(92);
    off();
});

it("shows the reconciled minimum width after a focused commit, including a clamped no-op", () => {
    const t = inspectorFixture(), width = t.field("W"), commits = vi.fn();
    const off = t.editor.on(event => { if (event.changes) commits(); });
    width.focus();
    width.value = "-10";
    width.dispatchEvent(new Event("change", { bubbles: true }));
    expect(t.editor.page.objects.selected.width).toBe(0.01);
    expect(t.field("W")).toBe(width);
    expect(width.value).toBe("0.01");
    expect(document.activeElement).toBe(width);
    width.value = "-20";
    width.dispatchEvent(new Event("change", { bubbles: true }));
    expect(width.value).toBe("0.01");
    width.blur();
    expect(commits).toHaveBeenCalledTimes(1);
    off();
    expect(t.editor.undoStep()).toBe(true);
    expect(t.field("W").value).toBe("40");
});

it("keeps dirty text composition mounted across unrelated edits and falls back for changed inspector structure", () => {
    const t = inspectorFixture(), name = t.field("Name");
    name.focus();
    name.dispatchEvent(new CompositionEvent("compositionstart", { data: "한" }));
    name.value = "한글 레이어";
    t.editor.transact("Other layer", doc => { doc.pagesById[t.editor.pageId].objects.other.x = 250; });
    expect(t.field("Name")).toBe(name);
    expect(document.activeElement).toBe(name);
    expect(name.value).toBe("한글 레이어");
    name.dispatchEvent(new CompositionEvent("compositionend", { data: "한글 레이어" }));
    name.blur();
    expect(t.editor.page.objects.selected.name).toBe("한글 레이어");
    const previous = t.field("X"), initial = t.inspector.diagnostics.rebuilds;
    t.editor.transact("Change kind", doc => { doc.pagesById[t.editor.pageId].objects.selected.type = "ellipse"; });
    expect(t.field("X")).not.toBe(previous);
    expect(t.inspector.diagnostics.rebuilds).toBe(initial + 1);
});

it("uses current dimensions from a retained inspector action after resizing", () => {
    const t = inspectorFixture();
    const clip = [...t.root.querySelectorAll("button")].find(button => button.textContent === "Clip rectangle")!;
    t.editor.transact("Resize", doc => {
        doc.pagesById[t.editor.pageId].objects.selected.width = 220;
        doc.pagesById[t.editor.pageId].objects.selected.height = 130;
    });
    expect(clip.isConnected).toBe(true);
    clip.click();
    expect(JSON.parse(document.querySelector<HTMLTextAreaElement>(".omc-dialog textarea")!.value)).toMatchObject({ width: 220, height: 130 });
});
