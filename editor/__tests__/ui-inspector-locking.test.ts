// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Editor, createDocument, createShape, insertShape } from "../document";
import { createInspector } from "../ui/inspector";
import { mountWorkspace } from "../ui";
import type { EditorServices } from "../contracts";
const cleanups: Array<() => void | Promise<void>> = [];
beforeEach(() => vi.stubGlobal("CSS", {
    escape: (value: string) => value
}));
afterEach(async () => {
    for (const cleanup of cleanups.splice(0))
        await cleanup();
    document.body.replaceChildren();
    vi.unstubAllGlobals();
});
function setup(parentLocked: boolean, childLocked = false) {
    const doc = createDocument(), page = doc.pagesById[doc.pages[0]];
    insertShape(page, createShape("frame", {
        id: "parent",
        locked: parentLocked,
        childIds: []
    }));
    insertShape(page, createShape("rect", {
        id: "child",
        parentId: "parent",
        x: 10,
        width: 40,
        height: 30,
        locked: childLocked,
        fills: [{
                color: "#123456"
            }]
    }));
    const editor = new Editor(doc);
    editor.setSelection(["child"]);
    const root = document.createElement("div");
    document.body.append(root);
    const inspector = createInspector(root, {
        editor,
        commands: {}
    } as unknown as EditorServices, {
        active: false
    } as any, {} as any, {});
    cleanups.push(() => {
        inspector.destroy();
        editor.destroy();
    });
    return {
        editor,
        root
    };
}
function change(root: HTMLElement, label: string, value: string) {
    const field = root.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
    field.value = value;
    field.dispatchEvent(new Event("change", {
        bubbles: true
    }));
}
it("selected descendants of locked ancestors reject inspector geometry, paint and own-lock changes", () => {
    const t = setup(true);
    change(t.root, "X", "99");
    change(t.root, "Color value", "#ff0000");
    const lock = Array.from(t.root.querySelectorAll("label")).find(label => label.textContent === "Locked")!.querySelector("input")!;
    lock.checked = true;
    lock.dispatchEvent(new Event("change", {
        bubbles: true
    }));
    expect(t.editor.page.objects.child.x).toBe(10);
    expect(t.editor.page.objects.child.fills[0].color).toBe("#123456");
    expect(t.editor.page.objects.child.locked).toBe(false);
    expect(t.editor.undoStep()).toBe(false);
});
it("an own locked layer can be unlocked when its ancestors are editable", () => {
    const t = setup(false, true);
    const lock = Array.from(t.root.querySelectorAll("label")).find(label => label.textContent === "Locked")!.querySelector("input")!;
    lock.checked = false;
    lock.dispatchEvent(new Event("change", {
        bubbles: true
    }));
    expect(t.editor.page.objects.child.locked).toBe(false);
    change(t.root, "X", "99");
    expect(t.editor.page.objects.child.x).toBe(99);
});
it("defers a dirty-field change emitted during projection rendering until the host projection guard unwinds", async () => {
    const t = setup(false);
    const field = t.root.querySelector<HTMLInputElement>("input[aria-label=\"X\"]")!;
    field.focus();
    field.value = "99";
    let applyingProjection = true;
    const durableGuards: boolean[] = [];
    t.editor.on(event => {
        if (event.changes)
            durableGuards.push(applyingProjection);
    });
    const originalReplace = t.root.replaceChildren.bind(t.root);
    const spy = vi.spyOn(t.root, "replaceChildren").mockImplementationOnce((...nodes) => {
        field.dispatchEvent(new Event("change", {
            bubbles: true
        }));
        originalReplace(...nodes);
    });
    const remote = structuredClone(t.editor.doc);
    remote.pagesById[t.editor.pageId].objects.parent.name = "Remote parent";
    t.editor.receiveDocument(remote);
    applyingProjection = false;
    expect(durableGuards).toEqual([]);
    await Promise.resolve();
    expect(durableGuards).toEqual([false]);
    expect(t.editor.page.objects.child.x).toBe(99);
    spy.mockRestore();
});
function findFixture() {
    vi.stubGlobal("ResizeObserver", class {
        observe() {
        }
        disconnect() {
        }
    });
    const doc = createDocument(), page = doc.pagesById[doc.pages[0]];
    insertShape(page, createShape("frame", {
        id: "locked-parent",
        locked: true,
        childIds: []
    }));
    insertShape(page, createShape("frame", {
        id: "open-parent",
        childIds: []
    }));
    const content = (text: string) => ({
        type: "richText",
        children: [{
                children: [{
                        text,
                        fontSize: 16,
                        fontWeight: 700
                    }]
            }]
    });
    for (const [id, parentId, locked] of [
        ["own-text", "root", true],
        ["ancestor-text", "locked-parent", false],
        ["free-text", "open-parent", false]
    ] as const)
        insertShape(page, createShape("text", {
            id,
            parentId,
            locked,
            content: content("Needle body")
        }));
    for (const [id, parentId, locked] of [
        ["own-name", "root", true],
        ["ancestor-name", "locked-parent", false],
        ["free-name", "open-parent", false]
    ] as const)
        insertShape(page, createShape("rect", {
            id,
            parentId,
            locked,
            name: "Needle name"
        }));
    const editor = new Editor(doc), root = document.createElement("div");
    document.body.append(root);
    const services = {
        editor,
        view: {
            element: () => null,
            settled: async () => {
            }
        },
        fonts: {
            ensure: async () => {
            },
            catalog: () => [],
            add: () => {
            }
        },
        commands: {
            list: () => [],
            get: () => undefined,
            enabled: () => false,
            run: () => false
        }
    } as unknown as EditorServices;
    const workspace = mountWorkspace(root, services, {
        document: doc
    });
    cleanups.push(async () => {
        await workspace.destroy();
        editor.destroy();
    });
    workspace.openFind();
    const bar = root.querySelector<HTMLElement>(".find-bar[role=\"search\"]")!;
    return {
        editor,
        root,
        bar,
        text: (id: string) => editor.page.objects[id].content.children.flatMap((paragraph: any) => paragraph.children).map((run: any) => run.text).join("")
    };
}
function findQuery(bar: HTMLElement, value: string) {
    const query = bar.querySelector<HTMLInputElement>("input[aria-label=\"Find layers\"]")!;
    query.value = value;
    query.dispatchEvent(new Event("input", {
        bubbles: true
    }));
}
it("refreshes the layer tree for projected insertions, renames and removals without a selection change", () => {
    const t = findFixture();
    const names = () => [...t.root.querySelectorAll(".name")].map(node => node.textContent);
    const remote = structuredClone(t.editor.doc), page = remote.pagesById[t.editor.pageId];
    page.objects["free-name"].name = "Remote renamed layer";
    insertShape(page, createShape("rect", {id: "remote-added", name: "Remote inserted layer"}));
    t.editor.receiveDocument(remote);
    expect(names()).toContain("Remote renamed layer");
    expect(names()).toContain("Remote inserted layer");
    const undone = structuredClone(remote), undonePage = undone.pagesById[t.editor.pageId];
    undonePage.objects.root.childIds = undonePage.objects.root.childIds!.filter(id => id !== "remote-added");
    delete undonePage.objects["remote-added"];
    t.editor.receiveDocument(undone);
    expect(names()).not.toContain("Remote inserted layer");
    expect(names()).toContain("Remote renamed layer");
});
function replacement(bar: HTMLElement, value: string) {
    bar.querySelector<HTMLInputElement>("input[aria-label=\"Replacement\"]")!.value = value;
}
function findAction(bar: HTMLElement, name: string) {
    bar.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`)!.click();
}
it("Find Replace leaves individually locked and ancestor-locked text/name matches unchanged without history", async () => {
    const t = findFixture();
    replacement(t.bar, "Changed");
    let changes = 0;
    const off = t.editor.on(event => {
        if (event.changes)
            changes++;
    });
    for (const id of ["own-text", "ancestor-text", "own-name", "ancestor-name"]) {
        findQuery(t.bar, "Needle");
        for (let index = 0; index < 6 && t.editor.selection[0] !== id; index++)
            findAction(t.bar, "Next match");
        expect(t.editor.selection).toEqual([id]);
        findAction(t.bar, "Replace");
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        expect(t.editor.page.objects[id].type === "text" ? t.text(id) : t.editor.page.objects[id].name).toBe(id.endsWith("text") ? "Needle body" : "Needle name");
    }
    expect(changes).toBe(0);
    expect(t.editor.undoStep()).toBe(false);
    off();
});
it("Find Replace All changes only editable text and names among mixed own/ancestor locked results", async () => {
    const t = findFixture();
    findQuery(t.bar, "Needle");
    replacement(t.bar, "Changed");
    let changes = 0;
    const off = t.editor.on(event => {
        if (event.changes)
            changes++;
    });
    findAction(t.bar, "Replace all matches");
    await vi.waitFor(() => expect(t.text("free-text")).toBe("Changed body"));
    expect(t.editor.page.objects["free-name"].name).toBe("Changed name");
    expect(t.text("own-text")).toBe("Needle body");
    expect(t.text("ancestor-text")).toBe("Needle body");
    expect(t.editor.page.objects["own-name"].name).toBe("Needle name");
    expect(t.editor.page.objects["ancestor-name"].name).toBe("Needle name");
    expect(t.editor.page.objects["free-text"].content.children[0].children[0].fontWeight).toBe(700);
    expect(changes).toBe(1);
    off();
    expect(t.editor.undoStep()).toBe(true);
    expect(t.text("free-text")).toBe("Needle body");
    expect(t.editor.page.objects["free-name"].name).toBe("Needle name");
});
