// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { Editor, createDocument, createShape, insertShape } from "../document";
import { createCanvasInteraction } from "../interaction/canvas";
import type { EditorServices } from "../contracts";
const cleanups: Array<() => void> = [];
afterEach(() => {
    cleanups.splice(0).forEach(fn => fn());
    document.body.replaceChildren();
});
function pointer(type: string, x: number, y: number, options: MouseEventInit = {}) {
    const event = new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        button: 0,
        buttons: type === "pointerup" ? 0 : 1,
        clientX: x,
        clientY: y,
        ...options
    });
    Object.defineProperty(event, "pointerId", {
        value: 1
    });
    return event;
}
function setup(rotation = 0) {
    const doc = createDocument(), page = doc.pagesById[doc.pages[0]];
    insertShape(page, createShape("rect", {
        id: "rect",
        x: 100,
        y: 100,
        width: 100,
        height: 80,
        rotation
    }));
    const editor = new Editor(doc);
    editor.snapping = false;
    editor.setSelection(["rect"]);
    const stage = document.createElement("div"), overlay = document.createElement("div");
    stage.append(overlay);
    document.body.append(stage);
    stage.getBoundingClientRect = () => ({
        x: 0,
        y: 0,
        left: 0,
        top: 0,
        right: 800,
        bottom: 600,
        width: 800,
        height: 600,
        toJSON: () => ({})
    });
    stage.setPointerCapture = () => {
    };
    Object.defineProperty(stage, "clientWidth", {
        value: 800
    });
    Object.defineProperty(stage, "clientHeight", {
        value: 600
    });
    const services = {
        editor,
        view: {
            element: () => null
        }
    } as unknown as EditorServices;
    const text = {
        active: false,
        exit: async () => {
        }
    } as any;
    const canvas = createCanvasInteraction(stage, overlay, services, text, {
        context: () => {
        },
        changed: () => {
        },
        importFiles: async () => {
        }
    });
    cleanups.push(() => {
        canvas.destroy();
        editor.destroy();
    });
    return {
        editor,
        stage,
        overlay
    };
}
it("keeps the logical size when a resize handle is grabbed one pixel away from its exact corner", async () => {
    const t = setup();
    t.overlay.querySelector<HTMLElement>("[data-handle=\"se\"]")!.dispatchEvent(pointer("pointerdown", 199, 179));
    await Promise.resolve();
    t.stage.dispatchEvent(pointer("pointermove", 249, 209));
    window.dispatchEvent(pointer("pointerup", 249, 209));
    expect(t.editor.page.objects.rect.width).toBe(150);
    expect(t.editor.page.objects.rect.height).toBe(110);
    expect(t.editor.page.objects.rect.x).toBe(100);
    expect(t.editor.page.objects.rect.y).toBe(100);
});
it("resizes a rotated local east edge without moving its opposite west anchor", async () => {
    const t = setup(90);
    const before = t.editor.page.objects.rect;
    t.overlay.querySelector<HTMLElement>("[data-handle=\"e\"]")!.dispatchEvent(pointer("pointerdown", 150, 189));
    await Promise.resolve();
    t.stage.dispatchEvent(pointer("pointermove", 150, 219));
    window.dispatchEvent(pointer("pointerup", 150, 219));
    const after = t.editor.page.objects.rect;
    expect(after.width).toBeCloseTo(130, 6);
    expect(after.height).toBe(80);
    const westBefore = {
        x: before.x + before.width / 2,
        y: before.y + before.height / 2 - before.width / 2
    };
    const westAfter = {
        x: after.x + after.width / 2,
        y: after.y + after.height / 2 - after.width / 2
    };
    expect(westAfter.x).toBeCloseTo(westBefore.x, 6);
    expect(westAfter.y).toBeCloseTo(westBefore.y, 6);
});
it("Alt-resize keeps the original center and doubles only the dragged edge delta", async () => {
    const t = setup();
    t.overlay.querySelector<HTMLElement>("[data-handle=\"e\"]")!.dispatchEvent(pointer("pointerdown", 200, 140));
    await Promise.resolve();
    t.stage.dispatchEvent(pointer("pointermove", 220, 140, {
        altKey: true
    }));
    window.dispatchEvent(pointer("pointerup", 220, 140, {
        altKey: true
    }));
    const after = t.editor.page.objects.rect;
    expect(after.width).toBe(140);
    expect(after.x).toBe(80);
    expect(after.height).toBe(80);
    expect(after.x + after.width / 2).toBe(150);
});
