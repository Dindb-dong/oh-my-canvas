// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Editor, createDocument, createShape, insertShape, addPage } from "../document";
import { createCommands } from "../commands";
import { mountWorkspace } from "../ui";
import { chooseFiles } from "../ui/picker";
import type { EditorServices, MountOptions } from "../contracts";
const cleanup: Array<() => void | Promise<void>> = [];
beforeEach(() => {
    vi.stubGlobal("CSS", { escape: (value: string) => value });
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
    vi.stubGlobal("Image", class { src = ""; naturalWidth = 80; naturalHeight = 40; async decode() {} });
});
afterEach(async () => {
    for (const dispose of cleanup.splice(0)) await dispose();
    document.body.replaceChildren();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});
function file(name: string, type: string, text = "content") {
    const value = new File([text], name, { type });
    Object.defineProperty(value, "text", { value: async () => text });
    return value;
}
function workspace(pickFiles: NonNullable<MountOptions["pickFiles"]>) {
    const doc = createDocument(), page = doc.pagesById[doc.pages[0]];
    insertShape(page, createShape("rect", { id: "rect", width: 80, height: 60, fills: [{ color: "#123456" }] }));
    const second = addPage(doc, "Second");
    const editor = new Editor(doc), root = document.createElement("div");
    document.body.append(root);
    const addLibrary = vi.fn(), addAsset = vi.fn();
    const services = { editor, view: { element: () => null, settled: async () => {} },
        fonts: { ensure: async () => {}, catalog: () => [], add: () => {} },
        components: { list: () => ({ components: [], total: 0 }) }, styles: { list: () => [] },
        libraries: { list: () => [], add: addLibrary }, assets: { addFile: addAsset }
    } as unknown as EditorServices;
    services.commands = createCommands(editor, services);
    const handle = mountWorkspace(root, services, { document: doc, pickFiles });
    cleanup.push(async () => { await handle.destroy(); services.commands.destroy?.(); editor.destroy(); });
    return { editor, root, handle, addLibrary, addAsset, secondPageId: second.id };
}
function click(root: HTMLElement, label: string) {
    root.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!.click();
}
it("the injected host owns file selection with no browser file input, including cancel and error", async () => {
    const image = file("image.svg", "image/svg+xml"), host = vi.fn().mockResolvedValueOnce([image]).mockResolvedValueOnce([]).mockRejectedValueOnce(Error("Host picker failed"));
    expect(await chooseFiles({ pickFiles: host }, { kind: "image" })).toEqual([image]);
    expect(await chooseFiles({ pickFiles: host }, { kind: "assets", multiple: true })).toEqual([]);
    await expect(chooseFiles({ pickFiles: host }, { kind: "library" })).rejects.toThrow("Host picker failed");
    expect(host.mock.calls.map(call => call[0])).toEqual([{ kind: "image" }, { kind: "assets", multiple: true }, { kind: "library" }]);
    expect(document.querySelector('input[type="file"]')).toBeNull();
});
it("browser fallback attaches its input before click and cleans up on both change and cancel", async () => {
    vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(function () { expect(this.isConnected).toBe(true); });
    const pending = chooseFiles({}, { kind: "assets", multiple: true });
    let input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    expect(input.accept).toContain(".svg");
    expect(input.multiple).toBe(true);
    const files = [file("a.svg", "image/svg+xml"), file("b.png", "image/png")];
    Object.defineProperty(input, "files", { value: files });
    input.dispatchEvent(new Event("change"));
    expect(await pending).toEqual(files);
    expect(input.isConnected).toBe(false);
    const canceled = chooseFiles({}, { kind: "library" });
    input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    input.dispatchEvent(new Event("cancel"));
    expect(await canceled).toEqual([]);
    expect(document.querySelector('input[type="file"]')).toBeNull();
});
it("aborting a host selection resolves cancellation and ignores its later error", async () => {
    let reject!: (error: Error) => void;
    const abort = new AbortController();
    const pending = chooseFiles({ pickFiles: () => new Promise((_, fail) => reject = fail) }, { kind: "image" }, abort.signal);
    await Promise.resolve();
    abort.abort();
    expect(await pending).toEqual([]);
    reject(Error("late host error"));
    await Promise.resolve();
    expect(document.querySelector('input[type="file"]')).toBeNull();
});
it("all four UI picker routes use the host and retain image paint, image metadata, font assets and library import", async () => {
    const host = vi.fn(async ({ kind }: { kind: string }) => kind === "library" ? [file("library.json", "application/json", '{"name":"Native library"}')] : kind === "assets" ? [file("Picker.woff2", "font/woff2")] : [file("image.png", "image/png")]);
    const t = workspace(host);
    t.editor.setSelection(["rect"]);
    const paint = t.root.querySelector<HTMLSelectElement>('select[aria-label="Paint"]')!;
    paint.value = "image";
    paint.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(t.editor.page.objects.rect.fills[0].image?.width).toBe(80));
    expect(await t.handle.placeImage()).toMatchObject({ width: 80, height: 40, mimeType: "image/png" });
    t.handle.assets.open();
    const beforeFont = structuredClone(t.editor.doc);
    click(t.root, "Place image / font");
    await vi.waitFor(() => expect(Object.values(t.editor.doc.assets ?? {})).toEqual([
        expect.objectContaining({ kind: "font", family: "Picker", name: "Picker.woff2", src: expect.stringMatching(/^data:font\/woff2;base64,/) })
    ]));
    const fontAssets = structuredClone(t.editor.doc.assets);
    expect(t.editor.undoStep()).toBe(true); expect(t.editor.doc).toEqual(beforeFont);
    expect(t.editor.redoStep()).toBe(true); expect(t.editor.doc.assets).toEqual(fontAssets);
    click(t.root, "Import library");
    await vi.waitFor(() => expect(t.addLibrary).toHaveBeenCalledWith({ name: "Native library" }));
    expect(host.mock.calls.map(call => call[0])).toEqual([{ kind: "image" }, { kind: "image" }, { kind: "assets", multiple: true }, { kind: "library" }]);
    expect(document.querySelector('input[type="file"]')).toBeNull();
});
it("UI picker cancellation is a no-op and host errors reach the accessible error route", async () => {
    const host = vi.fn().mockResolvedValueOnce([]).mockRejectedValueOnce(Error("Permission denied"));
    const t = workspace(host);
    expect(await t.handle.placeImage()).toBeNull();
    expect(t.editor.undoStep()).toBe(false);
    t.handle.assets.open();
    click(t.root, "Import library");
    await vi.waitFor(() => expect(document.querySelector('[role="alert"]')?.textContent).toContain("Permission denied"));
    expect(t.addLibrary).not.toHaveBeenCalled();
    expect(document.querySelector('input[type="file"]')).toBeNull();
});
it("destroyed workspace and changed page ignore pending host results", async () => {
    let resolve!: (files: File[]) => void;
    const t = workspace(() => new Promise(done => resolve = done));
    const before = structuredClone(t.editor.doc);
    const pending = t.handle.placeImage();
    await Promise.resolve();
    t.editor.setPage(t.secondPageId);
    resolve([file("image.png", "image/png")]);
    expect(await pending).toBeNull();
    const later = t.handle.placeImage();
    await Promise.resolve();
    await t.handle.destroy();
    expect(await later).toBeNull();
    resolve([file("image.png", "image/png")]);
    await Promise.resolve();
    expect(t.addAsset).not.toHaveBeenCalled();
    expect(t.addLibrary).not.toHaveBeenCalled();
    expect(t.editor.doc).toEqual(before);
});

it("an already aborted picker never opens a host dialog in the queued microtask", async () => {
    const host = vi.fn(async () => []);
    const abort = new AbortController();
    const result = chooseFiles({ pickFiles: host }, { kind: "image" }, abort.signal);
    abort.abort();
    expect(await result).toEqual([]);
    await Promise.resolve();
    expect(host).not.toHaveBeenCalled();
});
it("library and asset routes ignore files returned for a page that is no longer active", async () => {
    const read = vi.spyOn(FileReader.prototype, "readAsDataURL");
    for (const kind of ["library", "assets"] as const) {
        let resolve!: (files: File[]) => void;
        const host = vi.fn(() => new Promise<File[]>(done => resolve = done));
        const t = workspace(host);
        const before = structuredClone(t.editor.doc);
        t.handle.assets.open();
        click(t.root, kind === "library" ? "Import library" : "Place image / font");
        await vi.waitFor(() => expect(host).toHaveBeenCalledOnce());
        t.editor.setPage(t.secondPageId);
        resolve([kind === "library" ? file("library.json", "application/json", '{}') : file("font.woff2", "font/woff2")]);
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        expect(t.addLibrary).not.toHaveBeenCalled();
        expect(t.addAsset).not.toHaveBeenCalled();
        expect(t.editor.doc).toEqual(before);
    }
    expect(read).not.toHaveBeenCalled();
});
