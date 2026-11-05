// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { Editor, createDocument, createPage, createShape, insertShape } from "../document";
import { createCanvasInteraction } from "../interaction/canvas";
import type { EditorServices } from "../contracts";
const cleanups: Array<() => void> = [];
afterEach(() => {
    cleanups.splice(0).forEach(fn => fn());
    document.body.replaceChildren();
});
function setup(frame = false) {
    const doc = createDocument(), page = doc.pagesById[doc.pages[0]];
    if (frame)
        insertShape(page, createShape("frame", {id: "frame", x: 20, y: 20, width: 500, height: 300, childIds: []}));
    for (const [id, x] of [["a", 100], ["b", 240]] as const)
        insertShape(page, createShape("rect", {id, x, y: 100, width: 80, height: 60, parentId: frame ? "frame" : "root"}));
    const editor = new Editor(doc);
    editor.snapping = false;
    const stage = document.createElement("div"), overlay = document.createElement("div");
    stage.append(overlay);
    document.body.append(stage);
    stage.getBoundingClientRect = () => ({x: 0, y: 0, left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600, toJSON: () => ({})});
    stage.setPointerCapture = () => {};
    Object.defineProperty(stage, "clientWidth", {value: 800});
    Object.defineProperty(stage, "clientHeight", {value: 600});
    const canvas = createCanvasInteraction(stage, overlay, {
        editor, view: {element: () => null}
    } as unknown as EditorServices, {active: false, exit: async () => {}} as any, {
        context: () => {}, changed: () => {}, importFiles: async () => {}
    });
    cleanups.push(() => {canvas.destroy(); editor.destroy();});
    function send(type: string, x: number, y: number, options: MouseEventInit = {}) {
        const event = new MouseEvent(type, {bubbles: true, cancelable: true, button: 0, buttons: type === "pointerup" ? 0 : 1, clientX: x, clientY: y, ...options});
        Object.defineProperty(event, "pointerId", {value: 1});
        (type === "pointerup" ? window : stage).dispatchEvent(event);
    }
    function click(x: number, y: number, options: MouseEventInit = {}) {
        send("pointerdown", x, y, options);
        send("pointerup", x, y, options);
    }
    return {editor, stage, overlay, canvas, send, click};
}
it("shows every Shift-selected member and ignores click jitter before snapping or moving", () => {
    const t = setup();
    t.click(120, 120);
    t.send("pointerdown", 260, 120, {shiftKey: true});
    t.send("pointermove", 262, 120, {shiftKey: true});
    t.send("pointerup", 262, 120, {shiftKey: true});
    expect(t.editor.selection).toEqual(["a", "b"]);
    expect([...t.overlay.querySelectorAll<HTMLElement>(".selection-member")].map(n => n.dataset.id)).toEqual(["a", "b"]);
    expect(t.editor.page.objects.a.x).toBe(100);
    expect(t.editor.page.objects.b.x).toBe(240);
    expect(t.editor.undoStep()).toBe(false);
    t.send("pointerdown", 260, 120, {shiftKey: true});
    t.send("pointermove", 300, 140, {shiftKey: true});
    t.send("pointerup", 300, 140, {shiftKey: true});
    expect(t.editor.selection).toEqual(["a"]);
    expect(t.editor.page.objects.a.x).toBe(100);
});
it.each([0.25, 1, 2])("uses a screen-space move threshold at %sx zoom and a panned origin", zoom => {
    const t = setup();
    t.editor.setViewport({...t.editor.viewport, zoom, vbox: {x: 50, y: 50, width: 800 / zoom, height: 600 / zoom}});
    t.editor.setSelection(["a"]);
    const x = (120 - 50) * zoom, y = (120 - 50) * zoom;
    t.send("pointerdown", x, y);
    t.send("pointermove", x + 2, y);
    t.send("pointerup", x + 2, y);
    expect(t.editor.page.objects.a.x).toBe(100);
    expect(t.editor.undoStep()).toBe(false);
    t.send("pointerdown", x, y);
    t.send("pointermove", x + 10, y);
    t.send("pointerup", x + 10, y);
    expect(t.editor.page.objects.a.x).toBeCloseTo(100 + 10 / zoom);
    expect(t.editor.undoStep()).toBe(true);
    expect(t.editor.page.objects.a.x).toBe(100);
});
it("marquees partially intersecting children from empty frame space without moving the frame", () => {
    const t = setup(true);
    t.send("pointerdown", 60, 60);
    t.send("pointermove", 260, 130);
    expect(t.editor.selection).toEqual(["a", "b"]);
    t.send("pointerup", 260, 130);
    expect(t.editor.page.objects.frame.x).toBe(20);
    expect(t.editor.undoStep()).toBe(false);
    expect(t.overlay.querySelector(".marquee")).toBeNull();
});
it("selects a frame on click and keeps a selected frame draggable", () => {
    const t = setup(true);
    t.click(60, 60);
    expect(t.editor.selection).toEqual(["frame"]);
    t.send("pointerdown", 60, 60);
    t.send("pointermove", 80, 80);
    t.send("pointerup", 80, 80);
    expect(t.editor.page.objects.frame.x).toBe(40);
    expect(t.editor.page.objects.a.x).toBe(120);
    expect(t.editor.undoStep()).toBe(true);
    expect(t.editor.page.objects.frame.x).toBe(20);
});
it("preserves existing selection for Shift and multi-select marquee", () => {
    const t = setup();
    t.editor.setSelection(["a"]);
    t.send("pointerdown", 220, 80, {shiftKey: true});
    t.send("pointermove", 270, 130, {shiftKey: true});
    t.send("pointerup", 270, 130, {shiftKey: true});
    expect(t.editor.selection).toEqual(["a", "b"]);
    t.editor.setSelection(["a"]);
    t.editor.multiSelect = true;
    t.send("pointerdown", 220, 80);
    t.send("pointermove", 270, 130);
    t.send("pointerup", 270, 130);
    expect(t.editor.selection).toEqual(["a", "b"]);
});
it("marquee selects group units and excludes locked or hidden ancestry", () => {
    const t = setup(true);
    t.editor.transact("Fixture", doc => {
        const page = doc.pagesById[t.editor.pageId];
        insertShape(page, createShape("group", {id: "group", parentId: "frame", x: 350, y: 100, width: 100, height: 80, childIds: []}));
        insertShape(page, createShape("rect", {id: "child", parentId: "group", x: 360, y: 110, width: 50, height: 30}));
        page.objects.a.locked = true;
        page.objects.b.hidden = true;
    });
    t.send("pointerdown", 60, 60);
    t.send("pointermove", 460, 200);
    t.send("pointerup", 460, 200);
    expect(t.editor.selection).toEqual(["group"]);
    t.editor.transact("Lock ancestor", doc => {doc.pagesById[t.editor.pageId].objects.frame.locked = true;});
    t.editor.setSelection(["child"]);
    expect(t.overlay.querySelector("[data-handle]")).toBeNull();
});
it.each(["Escape", "pointercancel"])("clears a marquee on %s and accepts the next gesture", cancel => {
    const t = setup();
    t.send("pointerdown", 70, 70);
    t.send("pointermove", 150, 130);
    expect(t.overlay.querySelector(".marquee")).not.toBeNull();
    if (cancel === "Escape")
        t.stage.dispatchEvent(new KeyboardEvent("keydown", {key: "Escape", bubbles: true}));
    else
        t.send("pointercancel", 150, 130);
    expect(t.overlay.querySelector(".marquee")).toBeNull();
    expect(t.canvas.active).toBe(false);
    t.click(120, 120);
    expect(t.editor.selection).toEqual(["a"]);
});
it("draws straight pen segments and closes through a noninteractive first anchor in one undo step", () => {
    const t = setup();
    t.editor.setTool("pen");
    t.click(400, 100);
    expect(t.overlay.querySelector("[data-handle]")).toBeNull();
    expect((t.overlay.querySelector(".path-node") as HTMLElement).style.pointerEvents).toBe("none");
    t.send("pointermove", 500, 100);
    expect(t.overlay.querySelector("[data-pen-preview]")).not.toBeNull();
    t.click(500, 100);
    t.click(500, 200);
    t.click(400, 100);
    const path = Object.values(t.editor.page.objects).find(s => s.type === "path")!;
    expect(path.content.map((n: any) => n.command)).toEqual(["move", "line", "line", "close"]);
    expect(t.canvas.active).toBe(false);
    expect(t.editor.undoStep()).toBe(true);
    expect(t.editor.page.objects[path.id]).toBeUndefined();
    expect(t.editor.undoStep()).toBe(false);
});
it("keeps dragged pen tangents and finishes a curve with Enter", () => {
    const t = setup();
    t.editor.setTool("pen");
    t.send("pointerdown", 400, 100);
    t.send("pointermove", 420, 120);
    t.send("pointerup", 420, 120);
    t.send("pointerdown", 500, 100);
    t.send("pointermove", 520, 120);
    t.send("pointerup", 520, 120);
    t.stage.dispatchEvent(new KeyboardEvent("keydown", {key: "Enter", bubbles: true}));
    const path = Object.values(t.editor.page.objects).find(s => s.type === "path")!;
    expect(path.content[1]).toMatchObject({command: "curve", x1: 420, y1: 120, x2: 480, y2: 80, x: 500, y: 100});
    expect(t.editor.tool).toBe("move");
    expect(t.canvas.active).toBe(false);
    expect(t.editor.undoStep()).toBe(true);
});
it.each(["move", "rect"] as const)("finishes pen when switching directly to %s and leaves the editor ready", tool => {
    const t = setup();
    t.editor.setTool("pen");
    t.click(400, 100);
    t.click(500, 100);
    t.editor.setTool(tool);
    expect(t.editor.tool).toBe(tool);
    expect(t.canvas.active).toBe(false);
    expect(Object.values(t.editor.page.objects).filter(s => s.type === "path")).toHaveLength(1);
    expect(t.editor.begin("Next operation")).toBe(true);
    t.editor.cancelSession();
});
it.each(["Escape", "pointercancel", "tool"])("cancels a one-point pen on %s and starts a fresh pen", cancel => {
    const t = setup();
    t.editor.setTool("pen");
    t.click(400, 100);
    if (cancel === "Escape")
        t.stage.dispatchEvent(new KeyboardEvent("keydown", {key: "Escape", bubbles: true}));
    else if (cancel === "pointercancel")
        t.send("pointercancel", 400, 100);
    else
        t.editor.setTool("move");
    expect(Object.values(t.editor.page.objects).filter(s => s.type === "path")).toHaveLength(0);
    expect(t.canvas.active).toBe(false);
    t.editor.setTool("pen");
    t.click(400, 100);
    t.click(500, 100);
    t.canvas.finishPen();
    expect(Object.values(t.editor.page.objects).filter(s => s.type === "path")).toHaveLength(1);
});
it("clears pen references when changing pages", () => {
    const t = setup();
    let next = "";
    t.editor.transact("Add fixture page", doc => {
        const page = createPage("Second");
        next = page.id;
        doc.pages.push(page.id);
        doc.pagesById[page.id] = page;
    });
    t.editor.setTool("pen");
    t.click(400, 100);
    t.click(500, 100);
    t.editor.setPage(next);
    expect(t.canvas.active).toBe(false);
    t.click(100, 100);
    t.click(200, 100);
    t.canvas.finishPen();
    expect(Object.values(t.editor.page.objects).filter(s => s.type === "path")).toHaveLength(1);
});
it("cancels an in-flight move or draw when switching tools and preserves the requested tool", () => {
    const t = setup();
    t.editor.setSelection(["a"]);
    t.send("pointerdown", 120, 120);
    t.send("pointermove", 150, 120);
    expect(t.editor.page.objects.a.x).toBe(130);
    t.editor.setTool("rect");
    expect(t.editor.page.objects.a.x).toBe(100);
    expect(t.editor.tool).toBe("rect");
    expect(t.canvas.active).toBe(false);
    t.send("pointerdown", 400, 100);
    t.send("pointermove", 450, 150);
    t.editor.setTool("move");
    expect(Object.values(t.editor.page.objects).filter(s => s.type === "rect")).toHaveLength(2);
    expect(t.canvas.active).toBe(false);
    expect(t.editor.begin("Next operation")).toBe(true);
    t.editor.cancelSession();
});
it("rejects node deletion and nudging after a path ancestor becomes locked", () => {
    const t = setup(true);
    t.editor.setTool("pen");
    t.click(350, 100);
    t.click(450, 100);
    t.canvas.finishPen();
    const path = Object.values(t.editor.page.objects).find(s => s.type === "path")!;
    t.overlay.querySelector<HTMLElement>(".path-node")!.dispatchEvent(new MouseEvent("pointerdown", {bubbles: true, clientX: 350, clientY: 100}));
    t.send("pointerup", 350, 100);
    t.editor.transact("Lock parent", doc => {doc.pagesById[t.editor.pageId].objects.frame.locked = true;});
    const content = structuredClone(t.editor.page.objects[path.id].content);
    expect(t.canvas.deleteNodes()).toBe(false);
    expect(t.canvas.key(new KeyboardEvent("keydown", {key: "ArrowRight"}))).toBe(false);
    expect(t.editor.page.objects[path.id].content).toEqual(content);
});

it.each([0, 1])("updates a pen tangent after dragging out and returning %spx from its anchor", offset => {
    const t = setup();
    t.editor.setTool("pen");
    t.send("pointerdown", 100, 100);
    t.send("pointermove", 130, 130);
    t.send("pointermove", 100 + offset, 100);
    t.send("pointerup", 100 + offset, 100);
    t.click(200, 100);
    t.canvas.finishPen();
    const path = Object.values(t.editor.page.objects).find(s => s.type === "path")!;
    expect(path.content[1]).toMatchObject({command: "curve", x1: 100 + offset, y1: 100, x2: 200, y2: 100, x: 200, y: 100});
});
it("finishes a pen double-click with one final endpoint and one undo step", () => {
    const t = setup();
    t.editor.setTool("pen");
    t.click(400, 100);
    t.click(500, 100);
    t.click(500, 100);
    t.stage.dispatchEvent(new MouseEvent("dblclick", {bubbles: true, clientX: 500, clientY: 100, detail: 2}));
    const path = Object.values(t.editor.page.objects).find(s => s.type === "path")!;
    expect(path.content).toEqual([{command: "move", x: 400, y: 100}, {command: "line", x: 500, y: 100}]);
    expect(t.canvas.active).toBe(false);
    expect(t.editor.undoStep()).toBe(true);
    expect(t.editor.page.objects[path.id]).toBeUndefined();
    expect(t.editor.undoStep()).toBe(false);
});
it("cancels a pen double-click at its only anchor instead of saving a zero-length segment", () => {
    const t = setup();
    t.editor.setTool("pen");
    t.click(400, 100);
    t.click(400, 100);
    t.stage.dispatchEvent(new MouseEvent("dblclick", {bubbles: true, clientX: 400, clientY: 100, detail: 2}));
    expect(Object.values(t.editor.page.objects).filter(s => s.type === "path")).toHaveLength(0);
    expect(t.canvas.active).toBe(false);
    expect(t.editor.undoStep()).toBe(false);
});
