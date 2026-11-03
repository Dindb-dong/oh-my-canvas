// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Editor, createDocument, createShape, insertShape } from "../document";
import { createTextSession } from "../interaction/text";
import type { EditorServices, Data } from "../contracts";
function textContent() {
    return {
        type: "richText",
        children: [{
                children: [{
                        text: "Alpha",
                        fontSize: 24,
                        fontWeight: 400,
                        fontFamily: "sans-serif"
                    }, {
                        text: "Beta",
                        fontSize: 24,
                        fontWeight: 700,
                        fontFamily: "sans-serif"
                    }]
            }]
    };
}
function setup(ensure: () => Promise<unknown> = () => Promise.resolve()) {
    const doc = createDocument(), page = doc.pagesById[doc.pages[0]];
    insertShape(page, createShape("text", {
        id: "text",
        x: 20,
        y: 30,
        width: 300,
        height: 40,
        content: textContent()
    }));
    insertShape(page, createShape("rect", {
        id: "rect",
        x: 400,
        y: 30,
        width: 50,
        height: 40,
        fills: [{
                color: "#000000"
            }]
    }));
    const editor = new Editor(doc), stage = document.createElement("div");
    document.body.append(stage);
    const view = {
        element: () => null
    };
    const services = {
        editor,
        view,
        fonts: {
            ensure
        }
    } as unknown as EditorServices;
    const session = createTextSession(stage, services, () => {
    });
    return {
        editor,
        session,
        stage,
        initial: structuredClone(editor.doc),
        surface: () => stage.querySelector<HTMLElement>(".text-edit-surface")!,
        plain: () => editor.page.objects.text.content.children.flatMap((p: Data) => p.children).map((r: Data) => r.text).join("")
    };
}
const cleanups: Array<() => unknown> = [];
beforeEach(() => {
    document.body.replaceChildren();
    HTMLElement.prototype.scrollIntoView = vi.fn();
});
afterEach(async () => {
    for (const cleanup of cleanups.splice(0))
        await cleanup();
    document.body.replaceChildren();
});
function track<T extends ReturnType<typeof setup>>(value: T) {
    cleanups.push(async () => {
        await value.session.destroy();
        value.editor.destroy();
    });
    return value;
}
function editFirst(surface: HTMLElement, value: string) {
    const span = surface.querySelector<HTMLElement>("[data-run]")!;
    span.textContent = value;
    const selection = window.getSelection()!, range = document.createRange();
    range.selectNodeContents(span);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
    surface.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        inputType: "insertText",
        data: value
    }));
}
describe("independent native text session", () => {
    it("styles only the selected range while preserving neighboring runs and characters", async () => {
        const t = track(setup());
        await t.session.start("text", false);
        const span = t.surface().querySelector("[data-run]")!, range = document.createRange();
        range.setStart(span.firstChild!, 1);
        range.setEnd(span.firstChild!, 4);
        window.getSelection()!.removeAllRanges();
        window.getSelection()!.addRange(range);
        t.session.applyStyle({
            fontStyle: "italic"
        });
        const runs = t.editor.page.objects.text.content.children[0].children;
        expect(runs.map((r: Data) => r.text).join("")).toBe("AlphaBeta");
        expect(runs.filter((r: Data) => r.fontStyle === "italic").map((r: Data) => r.text).join("")).toBe("lph");
        expect(runs.find((r: Data) => r.text === "Beta").fontWeight).toBe(700);
    });
    it("keeps native focus and local text across same-page remote projection, then cancels only local text", async () => {
        const t = track(setup());
        await t.session.start("text", false);
        const surface = t.surface();
        surface.tabIndex = 0;
        surface.focus();
        editFirst(surface, "Alpha\uD55C\uAE00");
        const remote = structuredClone(t.initial);
        remote.pagesById[t.editor.pageId].objects.rect.fills = [{
                color: "#abcdef"
            }];
        t.editor.receiveDocument(remote);
        expect(t.surface()).toBe(surface);
        expect(document.activeElement).toBe(surface);
        expect(t.plain()).toBe("Alpha\uD55C\uAE00Beta");
        await t.session.exit(false);
        expect(t.plain()).toBe("AlphaBeta");
        expect(t.editor.page.objects.rect.fills[0].color).toBe("#abcdef");
    });
    it("uses text-local undo/redo despite a host history override and groups composition", async () => {
        const t = track(setup());
        t.editor.undoStep = vi.fn(() => {
            throw Error("Host Undo must not receive text-local history");
        });
        await t.session.start("text", false);
        const surface = t.surface();
        surface.dispatchEvent(new CompositionEvent("compositionstart", {
            bubbles: true,
            data: ""
        }));
        editFirst(surface, "Alpha\u314E");
        editFirst(surface, "Alpha\uD55C");
        surface.dispatchEvent(new CompositionEvent("compositionend", {
            bubbles: true,
            data: "\uD55C"
        }));
        expect(t.plain()).toBe("Alpha\uD55CBeta");
        expect(t.session.undo()).toBe(true);
        expect(t.plain()).toBe("AlphaBeta");
        expect(t.session.redo()).toBe(true);
        expect(t.plain()).toBe("Alpha\uD55CBeta");
        expect(t.editor.undoStep).not.toHaveBeenCalled();
    });
    it("cancels an adopted new-text gesture without any layer or undo ghost", async () => {
        const t = track(setup());
        t.editor.begin("Draw text");
        t.editor.preview(doc => insertShape(doc.pagesById[t.editor.pageId], createShape("text", {
            id: "new-text",
            content: {
                type: "richText",
                children: [{
                        children: [{
                                text: ""
                            }]
                    }]
            }
        })));
        await t.session.start("new-text", false, true);
        await t.session.exit(false);
        expect(t.editor.page.objects["new-text"]).toBeUndefined();
        expect(t.editor.undoStep()).toBe(false);
    });
    it("waits for the font promise before a single durable commit", async () => {
        let resolve!: () => void;
        const ready = new Promise<void>(r => resolve = r);
        const t = track(setup(() => ready));
        let commits = 0;
        t.editor.on(event => {
            if (event.changes)
                commits++;
        });
        await t.session.start("text", false);
        editFirst(t.surface(), "Alpha\u5B57");
        const exiting = t.session.exit(true);
        await Promise.resolve();
        expect(t.session.active).toBe(true);
        expect(commits).toBe(0);
        resolve();
        await exiting;
        expect(t.session.active).toBe(false);
        expect(commits).toBe(1);
        expect(t.plain()).toBe("Alpha\u5B57Beta");
    });
    it("excludes native list markers from saved text and caret offsets", async () => {
        const t = track(setup());
        t.editor.transact("Make list", doc => {
            doc.pagesById[t.editor.pageId].objects.text.content.children[0].listType = "ordered";
        });
        await t.session.start("text", false);
        expect(t.surface().querySelector("[data-marker]")?.textContent).toBe("1.");
        editFirst(t.surface(), "Alpha!");
        expect(t.plain()).toBe("Alpha!Beta");
        expect(t.session.range().start).toBe(6);
        await t.session.exit(true);
        expect(t.plain()).not.toContain("1.");
    });
    it("compatibility textarea mirrors native edits and previews plain replacement with first-run style, then cancels without history", async () => {
        const t = track(setup());
        const initialContent = structuredClone(t.editor.page.objects.text.content);
        let commits = 0;
        t.editor.on(event => {
            if (event.changes)
                commits++;
        });
        await t.session.start("text", false);
        const mirror = t.stage.querySelector<HTMLTextAreaElement>('textarea[aria-label="Text editor"]')!;
        expect(mirror.value).toBe("AlphaBeta");
        editFirst(t.surface(), "Native");
        expect(mirror.value).toBe("NativeBeta");
        mirror.value = "First line\nSecond line";
        mirror.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
        const paragraphs = t.editor.page.objects.text.content.children;
        expect(paragraphs.map((paragraph: Data) => paragraph.children[0].text)).toEqual(["First line", "Second line"]);
        for (const paragraph of paragraphs) {
            expect(paragraph.children[0].fontSize).toBe(24);
            expect(paragraph.children[0].fontFamily).toBe("sans-serif");
            expect(paragraph.children[0].fontWeight).toBe(400);
        }
        expect(t.surface().querySelectorAll("[data-paragraph]").length).toBe(2);
        expect(commits).toBe(0);
        await t.session.exit(false);
        expect(t.editor.page.objects.text.content).toEqual(initialContent);
        expect(commits).toBe(0);
        expect(t.stage.querySelector('textarea[aria-label="Text editor"]')).toBeNull();
        expect(t.editor.undoStep()).toBe(false);
    });
    it("public indent adapter updates each selected paragraph independently and uses local history", async () => {
        const t = track(setup());
        t.editor.transact("Two paragraphs", doc => {
            doc.pagesById[t.editor.pageId].objects.text.content = {
                type: "richText",
                children: [{
                        listType: "bullet",
                        listLevel: 1,
                        children: [{
                                text: "One"
                            }]
                    }, {
                        listType: "bullet",
                        listLevel: 2,
                        children: [{
                                text: "Two"
                            }]
                    }]
            };
        });
        await t.session.start("text", true);
        t.session.indent(1);
        expect(t.editor.page.objects.text.content.children.map((p: Data) => p.listLevel)).toEqual([2, 3]);
        expect(t.session.undo()).toBe(true);
        expect(t.editor.page.objects.text.content.children.map((p: Data) => p.listLevel)).toEqual([1, 2]);
        for (const method of ["delete", "copy", "cut", "paste"])
            expect(typeof (t.session as any)[method]).toBe("function");
    });
});
