// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Editor, createDocument, createShape, insertShape } from "../document";
import { createCommands } from "../commands";
import { mountWorkspace } from "../ui";
import type { EditorServices } from "../contracts";
const cleanup: Array<() => Promise<void>> = [];
beforeEach(() => {
    vi.stubGlobal("CSS", {
        escape: (value: string) => value
    });
    vi.stubGlobal("ResizeObserver", class {
        observe() {
        }
        disconnect() {
        }
    });
});
afterEach(async () => {
    for (const dispose of cleanup.splice(0))
        await dispose();
    document.body.replaceChildren();
    vi.unstubAllGlobals();
});
function workspace() {
    const doc = createDocument(), page = doc.pagesById[doc.pages[0]];
    insertShape(page, createShape("rect", {
        id: "rect",
        name: "Rectangle",
        width: 80,
        height: 60
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
        }
    } as unknown as EditorServices;
    services.commands = createCommands(editor, services);
    const handle = mountWorkspace(root, services, {
        document: doc
    });
    cleanup.push(async () => {
        await handle.destroy();
        services.commands.destroy?.();
        editor.destroy();
    });
    return {
        editor,
        root
    };
}
function named(root: HTMLElement, label: string) {
    return root.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
}
function assertIcon(button: HTMLElement, name?: string) {
    const icon = button.querySelector("svg");
    expect(icon).not.toBeNull();
    expect(icon!.getAttribute("viewBox")).toBe("0 0 24 24");
    expect(icon!.getAttribute("aria-hidden")).toBe("true");
    expect(icon!.getAttribute("focusable")).toBe("false");
    expect(icon!.getAttribute("stroke")).toBe("currentColor");
    if (name)
        expect(icon!.getAttribute("data-icon")).toBe(name);
}
it("all eleven tools and workspace navigation use decorative SVGs while preserving labels and tool actions", async () => {
    const t = workspace();
    const rect = t.root.querySelector<HTMLButtonElement>("[data-tool=\"rect\"]")!;
    rect.click();
    await Promise.resolve();
    expect(t.editor.tool).toBe("rect");
    expect(rect.getAttribute("aria-label")).toBe("Rect (R)");
    expect(rect.querySelector("small")!.textContent).toBe("R");
    const tools = t.root.querySelectorAll<HTMLButtonElement>("#tools [data-tool]");
    expect(tools.length).toBe(11);
    tools.forEach(tool => assertIcon(tool));
    assertIcon(t.root.querySelector<HTMLElement>('[data-tool="text"]')!, "letter-t");
    assertIcon(t.root.querySelector<HTMLElement>('[data-tool="pen"]')!, "ballpen");
    assertIcon(t.root.querySelector<HTMLElement>('[data-tool="pencil"]')!, "pencil");
    assertIcon(named(t.root, "Undo"), "arrow-back-up");
    assertIcon(named(t.root, "Redo"), "arrow-forward-up");
    assertIcon(named(t.root, "Find layers"), "search");
    assertIcon(named(t.root, "Quick actions"), "command");
});
it("layer visibility and lock SVG state changes retain real reversible document behavior", () => {
    const t = workspace();
    const row = () => t.root.querySelector<HTMLElement>(".layers .row[data-id=\"rect\"]")!;
    named(row(), "Toggle visibility").click();
    expect(t.editor.page.objects.rect.hidden).toBe(true);
    assertIcon(named(row(), "Toggle visibility"), "eye-off");
    named(row(), "Toggle visibility").click();
    expect(t.editor.page.objects.rect.hidden).toBe(false);
    assertIcon(named(row(), "Toggle visibility"), "eye");
    named(row(), "Toggle lock").click();
    expect(t.editor.page.objects.rect.locked).toBe(true);
    assertIcon(named(row(), "Toggle lock"), "lock");
    named(row(), "Toggle lock").click();
    expect(t.editor.page.objects.rect.locked).toBe(false);
    assertIcon(named(row(), "Toggle lock"), "lock-open");
});
it("outer chrome uses the same decorative Tabler SVG family without changing labels", async () => {
    const { icon } = await import("../../src/icons.js");
    for (const name of ["clock", "search", "star", "grid", "list", "file", "more", "plus", "panel", "components", "external", "minimize", "maximize"]) {
        const control = document.createElement("button");
        control.setAttribute("aria-label", "Accessible " + name);
        control.innerHTML = icon(name);
        assertIcon(control);
        expect(control.getAttribute("aria-label")).toBe("Accessible " + name);
        expect(control.textContent?.trim()).toBe("");
    }
});
it("SVG descendants preserve click dispatch, text labels, disabled controls and safe icon lookup", async () => {
    const { iconButton, labeledIconButton } = await import("../ui/dom");
    const { svgIcon } = await import("../ui/icons/tabler/runtime.js");
    const run = vi.fn(), control = iconButton("plus", run, "", "Add page");
    document.body.append(control);
    control.querySelector("path")!.dispatchEvent(new MouseEvent("click", {
        bubbles: true
    }));
    expect(run).toHaveBeenCalledTimes(1);
    control.disabled = true;
    control.click();
    expect(run).toHaveBeenCalledTimes(1);
    expect(control.title).toBe("Add page");
    expect(labeledIconButton("plus", "Style", () => {
    }, "", "+ Style").getAttribute("aria-label")).toBe("+ Style");
    expect(() => svgIcon("<script>alert(1)</script>")).toThrow("Unknown Tabler icon");
    expect(() => svgIcon("toString")).toThrow("Unknown Tabler icon");
});
it("every vendored SVG and full upstream license matches the pinned source manifest", async () => {
    const { readFile } = await import("node:fs/promises");
    const { createHash } = await import("node:crypto");
    const { resolve } = await import("node:path");
    const directory = resolve(process.cwd(), "editor/ui/icons/tabler");
    const manifest = JSON.parse(await readFile(resolve(directory, "manifest.json"), "utf8"));
    expect(manifest.version).toBe("3.50.0");
    expect(manifest.commit).toBe("6904efd245391ad396df17654738f52f6da8c40e");
    for (const entry of manifest.files) {
        const bytes = await readFile(resolve(directory, entry.file));
        expect(createHash("sha256").update(bytes).digest("hex")).toBe(entry.sha256);
        expect(bytes.length).toBe(entry.bytes);
        expect(entry.source).toMatch(new RegExp("^https://raw\\.githubusercontent\\.com/tabler/tabler-icons/" + manifest.commit + "/"));
        if (entry.file.endsWith(".svg")) {
            const svg = new DOMParser().parseFromString(bytes.toString(), "image/svg+xml");
            expect(svg.querySelector("parsererror,script,foreignObject")).toBeNull();
            expect(svg.documentElement.getAttribute("viewBox")).toBe("0 0 24 24");
        }
    }
    const license = await readFile(resolve(directory, "LICENSE"), "utf8");
    expect(license).toContain("MIT License");
    expect(license).toContain("Copyright (c) 2020-2026 Pawe\u0142 Kuna");
    expect(license).toContain("THE SOFTWARE IS PROVIDED \"AS IS\"");
    const runtime = await readFile(resolve(directory, manifest.generated.file));
    expect(createHash("sha256").update(runtime).digest("hex")).toBe(manifest.generated.sha256);
});
