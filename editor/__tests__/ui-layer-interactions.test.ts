// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Editor, createDocument, createPage, createShape, insertShape, removeShapes } from "../document";
import { createCommands } from "../commands";
import { mountWorkspace } from "../ui";
import type { EditorServices } from "../contracts";

const cleanup: Array<() => Promise<void>> = [];
beforeEach(() => {
    vi.stubGlobal("CSS", { escape: (value: string) => value });
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
});
afterEach(async () => {
    for (const dispose of cleanup.splice(0)) await dispose();
    document.body.replaceChildren();
    vi.unstubAllGlobals();
});
function setup() {
    const doc = createDocument(), page = doc.pagesById[doc.pages[0]];
    for (let i = 1; i <= 10; i++) insertShape(page, createShape("rect", { id: `r${i}`, name: `Rectangle ${i}`, x: i * 30, width: 20, height: 20 }));
    insertShape(page, createShape("frame", { id: "frame", name: "Frame", childIds: [], x: 400, width: 300, height: 300 }));
    insertShape(page, createShape("rect", { id: "child", name: "Child", parentId: "frame", x: 420, width: 20, height: 20 }));
    const editor = new Editor(doc), root = document.createElement("div");
    document.body.append(root);
    const services = { editor, view: { element: () => null, settled: async () => {} }, fonts: { ensure: async () => {}, catalog: () => [], add: () => {} } } as unknown as EditorServices;
    services.commands = createCommands(editor, services);
    const workspace = mountWorkspace(root, services, { document: doc });
    cleanup.push(async () => { await workspace.destroy(); services.commands.destroy?.(); editor.destroy(); });
    const row = (id: string) => root.querySelector<HTMLElement>(`.layers .row[data-id="${id}"]`)!;
    const visible = () => [...root.querySelectorAll<HTMLElement>(".layers .row")].filter(row => !row.hidden).map(row => row.dataset.id!);
    const click = async (id: string, options: MouseEventInit = {}) => { row(id).dispatchEvent(new MouseEvent("click", { bubbles: true, ...options })); await Promise.resolve(); };
    return { editor, root, workspace, row, visible, click };
}
function drag(row: HTMLElement, type: string, y = 1, x = 10) {
    row.getBoundingClientRect = () => ({ left: 0, right: 240, top: 0, bottom: 32, x: 0, y: 0, width: 240, height: 32, toJSON() {} });
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y });
    Object.defineProperty(event, "dataTransfer", { value: { setData() {}, effectAllowed: "", dropEffect: "" } });
    row.dispatchEvent(event);
    return event;
}
it("selects a visible anchored range in both directions and shrinks repeated Shift ranges", async () => {
    const t = setup();
    expect(t.root.querySelector(".layers")!.getAttribute("aria-multiselectable")).toBe("true");
    await t.click("r10"); await t.click("r1", { shiftKey: true });
    expect(t.editor.selection).toEqual(Array.from({ length: 10 }, (_, i) => `r${10 - i}`));
    expect(t.root.querySelectorAll('.layers .row[aria-selected="true"]').length).toBe(10);
    await t.click("r8", { shiftKey: true });
    expect(t.editor.selection).toEqual(["r10", "r9", "r8"]);
    await t.click("r1"); await t.click("r10", { shiftKey: true });
    expect(new Set(t.editor.selection)).toEqual(new Set(Array.from({ length: 10 }, (_, i) => `r${i + 1}`)));
});
it("toggles nonadjacent rows and preserves their selection on context menu and dragging", async () => {
    const t = setup();
    await t.click("r10"); await t.click("r8", { metaKey: true }); await t.click("r6", { ctrlKey: true });
    expect(t.editor.selection).toEqual(["r10", "r8", "r6"]);
    t.row("r8").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    expect(t.editor.selection).toEqual(["r10", "r8", "r6"]);
    drag(t.row("r8"), "dragstart");
    expect(t.editor.selection).toEqual(["r10", "r8", "r6"]);
    window.dispatchEvent(new Event("dragend"));
    await t.click("r8", { ctrlKey: true });
    expect(t.editor.selection).toEqual(["r10", "r6"]);
});
it("excludes collapsed and filtered rows from Shift ranges and resets missing anchors", async () => {
    const t = setup();
    t.row("frame").querySelector<HTMLButtonElement>('[aria-label="Expand layer"]')!.click();
    expect(t.visible()).not.toContain("child");
    await t.click("frame"); await t.click("r8", { shiftKey: true });
    expect(t.editor.selection).toEqual(["frame", "r10", "r9", "r8"]);
    const filter = t.root.querySelector<HTMLInputElement>('[aria-label="Filter layers"]')!;
    filter.value = "Rectangle 1"; filter.dispatchEvent(new Event("input", { bubbles: true }));
    (document.activeElement as HTMLElement)?.blur();
    expect(t.visible()).toEqual(["r10", "r1"]);
    expect(getComputedStyle(t.row("r9")).display).toBe("none");
    await t.click("r10"); await t.click("r1", { shiftKey: true });
    expect(t.editor.selection).toEqual(["r10", "r1"]);
    t.editor.transact("Remove anchor", doc => removeShapes(doc.pagesById[t.editor.pageId], ["r10"]));
    await t.click("r1", { shiftKey: true });
    expect(t.editor.selection).toEqual(["r1"]);
});
it("resets the range anchor when switching pages", async () => {
    const t = setup();
    await t.click("r10");
    t.editor.transact("Add page", doc => { const page = createPage("Second", "second"); doc.pages.push(page.id); doc.pagesById[page.id] = page; insertShape(page, createShape("rect", { id: "new" })); });
    t.editor.setPage("second"); await t.click("new", { shiftKey: true });
    expect(t.editor.selection).toEqual(["new"]);
});
it("uses the displayed before/after line for ordered multi-layer moves and one-step undo/redo", async () => {
    const t = setup(), original = [...t.editor.page.objects.root.childIds!];
    t.editor.setSelection(["r8", "r10", "r6"]);
    drag(t.row("r8"), "dragstart");
    expect(drag(t.row("r2"), "dragover", 1).defaultPrevented).toBe(true);
    expect(t.row("r2").dataset.drop).toBe("before");
    drag(t.row("r2"), "drop", 1);
    const moved = [...t.editor.page.objects.root.childIds!];
    expect(moved).toEqual(["r1", "r2", "r6", "r8", "r10", "r3", "r4", "r5", "r7", "r9", "frame"]);
    expect(t.visible().filter(id => ["r10", "r8", "r6", "r2"].includes(id))).toEqual(["r10", "r8", "r6", "r2"]);
    expect(t.root.querySelector("[data-drop]")).toBeNull();
    expect(t.editor.undoStep()).toBe(true); expect(t.editor.page.objects.root.childIds).toEqual(original);
    expect(t.editor.redoStep()).toBe(true); expect(t.editor.page.objects.root.childIds).toEqual(moved);
    drag(t.row("r8"), "dragstart"); drag(t.row("r9"), "dragover", 31);
    expect(t.row("r9").dataset.drop).toBe("after"); drag(t.row("r9"), "drop", 31);
    expect(t.editor.page.objects.root.childIds!.slice(-5)).toEqual(["r6", "r8", "r10", "r9", "frame"]);
});
it("shows inside destinations and moves selected parents with their descendants intact", () => {
    const t = setup();
    t.editor.setSelection(["r4", "r2"]); drag(t.row("r4"), "dragstart");
    drag(t.row("frame"), "dragover", 16, 100);
    expect(t.row("frame").dataset.drop).toBe("inside"); drag(t.row("frame"), "drop", 16, 100);
    expect(t.editor.page.objects.frame.childIds).toEqual(["child", "r2", "r4"]);
    expect(t.editor.page.objects.r2.x).toBe(60);
    t.editor.setSelection(["child", "frame"]); drag(t.row("frame"), "dragstart"); drag(t.row("r1"), "drop", 31);
    expect(t.editor.page.objects.child.parentId).toBe("frame");
    expect(t.editor.page.objects.frame.childIds).toEqual(["child", "r2", "r4"]);
});
it("rejects self/descendant and locked destinations and clears previews after drag cancellation", () => {
    const t = setup(), original = JSON.stringify(t.editor.doc);
    t.editor.setSelection(["frame"]); drag(t.row("frame"), "dragstart");
    expect(drag(t.row("child"), "dragover").defaultPrevented).toBe(false);
    drag(t.row("child"), "drop"); expect(JSON.stringify(t.editor.doc)).toBe(original);
    t.editor.transact("Lock frame", doc => { doc.pagesById[t.editor.pageId].objects.frame.locked = true; });
    t.editor.setSelection(["r1"]); drag(t.row("r1"), "dragstart");
    expect(drag(t.row("frame"), "dragover", 16, 100).defaultPrevented).toBe(false);
    drag(t.row("r2"), "dragover"); expect(t.root.querySelector("[data-drop]")).not.toBeNull();
    window.dispatchEvent(new Event("dragend")); expect(t.root.querySelector("[data-drop]")).toBeNull();
    drag(t.row("r1"), "dragstart"); drag(t.row("r2"), "dragover");
    t.root.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); expect(t.root.querySelector("[data-drop]")).toBeNull();
});
