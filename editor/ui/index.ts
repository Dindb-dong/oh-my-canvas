import type { Data, EditorServices, MountOptions, Point, Tool, WorkspaceHandle } from "../contracts";
import { createShape, remapReferences, isEditable, ancestors, topLevelIds, reparentShapes } from "../document";
import { el, button, iconButton, labeledIconButton, input, select, check, section, row, clone, toast, askName, modal, jsonEditor } from "./dom";
import { workspaceStyle } from "./style";
import { createIcon } from "./icons";
import { chooseFiles, readImageFile } from "./picker";
import { createTextSession } from "../interaction/text";
import { createCanvasInteraction } from "../interaction/canvas";
import { createClipboard } from "../interaction/clipboard";
import { createInspector } from "./inspector";
export interface WorkspaceRoot {
    stage: HTMLElement;
    shell: HTMLElement;
    left: HTMLElement;
    right: HTMLElement;
    tools: HTMLElement;
    overlays: HTMLElement;
    header: HTMLElement;
}
const roots = new WeakMap<HTMLElement, WorkspaceRoot>();
export function createWorkspaceRoot(root: HTMLElement, options: Partial<MountOptions> = {}): WorkspaceRoot {
    const old = roots.get(root);
    if (old && root.contains(old.stage))
        return old;
    root.classList.add("lv-editor");
    const style = el("style");
    style.textContent = workspaceStyle;
    const header = el("header", "workspace-header");
    const file = el("div", "file-name");
    file.append(el("b", "", options.title ?? "Untitled"), el("small", "", options.subtitle ?? "Design workspace"));
    header.append(file);
    const left = el("aside");
    left.id = "left";
    left.setAttribute("aria-label", "Layers and assets");
    const stage = el("main");
    stage.id = "stage";
    stage.tabIndex = 0;
    stage.setAttribute("aria-label", "Design canvas");
    const overlays = el("div");
    overlays.id = "overlay";
    stage.append(overlays);
    const right = el("aside");
    right.id = "right";
    right.setAttribute("aria-label", "Design inspector");
    const tools = el("nav");
    tools.id = "tools";
    tools.setAttribute("aria-label", "Drawing tools");
    root.replaceChildren(style, header, left, stage, right, tools);
    const result = {
        stage,
        shell: root,
        left,
        right,
        tools,
        overlays,
        header
    };
    roots.set(root, result);
    return result;
}
const toolEntries: [
    Tool,
    string,
    string
][] = [
    ["move", "pointer", "V"],
    ["frame", "frame", "F"],
    ["rect", "square", "R"],
    ["ellipse", "circle", "O"],
    ["polygon", "hexagon", ""],
    ["star", "star", ""],
    ["line", "line", "L"],
    ["arrow", "arrow-up-right", "\u21E7L"],
    ["pen", "ballpen", "P"],
    ["pencil", "pencil", "\u21E7P"],
    ["text", "letter-t", "T"]
];
const shortcutMap: Record<string, string> = {
    "mod+z": "edit.undo",
    "mod+shift+z": "edit.redo",
    "mod+d": "edit.duplicate",
    "mod+r": "layer.rename",
    "mod+g": "struct.group",
    "mod+shift+g": "struct.ungroup",
    "mod+alt+g": "struct.frame",
    "mod+alt+m": "struct.mask",
    "mod+ctrl+m": "struct.mask",
    "alt+shift+u": "bool.union",
    "alt+shift+s": "bool.subtract",
    "alt+shift+i": "bool.intersect",
    "alt+shift+e": "bool.exclude",
    "alt+shift+x": "bool.exclude",
    "mod+e": "path.flatten",
    "mod+alt+k": "component.create",
    "mod+alt+b": "component.detach",
    "shift+a": "layout.add",
    "alt+shift+a": "layout.remove",
    "mod+]": "order.forward",
    "mod+[": "order.backward",
    "mod+alt+]": "order.front",
    "mod+alt+[": "order.back",
    "]": "order.front",
    "[": "order.back",
    "alt+a": "align.left",
    "alt+d": "align.right",
    "alt+w": "align.top",
    "alt+s": "align.bottom",
    "alt+h": "align.h-center",
    "alt+v": "align.v-center",
    "ctrl+alt+h": "distribute.h",
    "ctrl+alt+v": "distribute.v",
    "ctrl+alt+t": "arrange.tidy-up",
    "shift+h": "transform.flip-h",
    "shift+v": "transform.flip-v",
    "mod+shift+l": "layer.lock",
    "mod+shift+h": "layer.hide",
    "mod+shift+o": "view.outlines",
    "mod+y": "view.outlines",
    "mod+\\": "view.toggle-ui",
    ",": "view.pixel-grid",
    "mod+shift+'": "view.pixel-grid",
    "shift+r": "view.rulers",
    "ctrl+g": "view.layout-grids",
    "mod+shift+4": "view.layout-grids",
    "ctrl+shift+4": "view.layout-grids",
    "mod+a": "select.all",
    "mod+shift+a": "select.inverse",
    "mod+alt+a": "select.matching",
    "shift+enter": "select.parent",
    "\\": "select.parent",
    "tab": "select.next",
    "shift+tab": "select.previous",
    "escape": "select.none",
    "delete": "edit.delete",
    "backspace": "edit.delete",
    "arrowleft": "nudge.left",
    "arrowright": "nudge.right",
    "arrowup": "nudge.up",
    "arrowdown": "nudge.down",
    "shift+arrowleft": "nudge.left-10",
    "shift+arrowright": "nudge.right-10",
    "shift+arrowup": "nudge.up-10",
    "shift+arrowdown": "nudge.down-10",
    "=": "view.zoom-in",
    "+": "view.zoom-in",
    "mod+=": "view.zoom-in",
    "mod++": "view.zoom-in",
    "shift++": "view.zoom-in",
    "mod+shift++": "view.zoom-in",
    "j": "path.join",
    "mod+j": "path.merge",
    "-": "view.zoom-out",
    "mod+-": "view.zoom-out",
    "shift+0": "view.zoom-100",
    "shift+1": "view.zoom-fit",
    "shift+2": "view.zoom-selection",
    "n": "view.next-frame",
    "shift+n": "view.previous-frame",
    "pagedown": "view.next-page",
    "pageup": "view.previous-page",
    "mod+shift+k": "file.place-image",
    "v": "tool.move",
    "f": "tool.frame",
    "r": "tool.rect",
    "o": "tool.ellipse",
    "e": "tool.ellipse",
    "p": "tool.pen",
    "l": "tool.line",
    "shift+l": "tool.arrow",
    "shift+p": "tool.pencil",
    "t": "tool.text"
};
export function mountWorkspace(root: HTMLElement, services: EditorServices, options: MountOptions): WorkspaceHandle {
    const dom = createWorkspaceRoot(root, options), { stage, left, right, tools, overlays, header } = dom;
    const editor = services.editor;
    editor.showGrids ??= true;
    editor.showRulers ??= false;
    editor.showOutlines ??= false;
    editor.snapping ??= true;
    editor.pixelSnap ??= false;
    const abort = new AbortController();
    const signal = abort.signal;
    const thumbnailCache = new WeakMap<object, Map<string, Promise<string>>>();
    let destroyed = false, leftTab = "layers", assetQuery = "", layerQuery = "", collapsedNodes = new Set<string>(), menu: HTMLElement | null = null, findBar: HTMLElement | null = null, findIndex = 0, findMatches: string[] = [], inspector: ReturnType<typeof createInspector> | null = null;
    let dragged: Data | null = null;
    let layerAnchor: string | null = null, layerRangeBase: string[] = [];
    let layerPresentation: {pageId: string; pages: string[]; names: unknown[]; objects: Data} | null = null;
    const layerKeys = ["name", "type", "hidden", "locked", "parentId", "isMain", "isInstanceRoot"];
    function sameLayerPresentation() {
        if (leftTab !== "layers" || !layerPresentation || layerPresentation.pageId !== editor.pageId)
            return false;
        const previous = layerPresentation, pages = editor.doc.pages, objects = editor.page.objects;
        if (pages.length !== previous.pages.length || pages.some((id, index) => id !== previous.pages[index] || editor.doc.pagesById[id].name !== previous.names[index]))
            return false;
        if (Object.keys(objects).length !== Object.keys(previous.objects).length)
            return false;
        for (const [id, shape] of Object.entries(objects)) {
            const old = previous.objects[id];
            if (old === shape)
                continue;
            if (!old || layerKeys.some(key => !Object.is(old[key], shape[key])))
                return false;
            const oldChildren = old.childIds, children = shape.childIds;
            if (oldChildren !== children && (!oldChildren || !children || oldChildren.length !== children.length || children.some((child: string, index: number) => child !== oldChildren[index])))
                return false;
        }
        // Release the older geometry snapshot even when its presentation did not change.
        previous.objects = objects;
        return true;
    }
    function clearLayerDrop() {
        left.querySelectorAll("[data-drop]").forEach(node => node.removeAttribute("data-drop"));
    }
    function endDrag() {
        clearLayerDrop();
        dragged = null;
    }
    window.addEventListener("dragend", endDrag, { signal });
    window.addEventListener("drop", endDrag, { signal });
    window.addEventListener("keydown", event => {
        if (event.key === "Escape") endDrag();
    }, { signal });
    const clipboard = createClipboard(stage, services, options);
    const text = createTextSession(stage, services, () => inspector?.refresh());
    const canvas = createCanvasInteraction(stage, overlays, services, text, {
        context: showContext,
        changed: () => inspector?.refresh(),
        importFiles: async (files, point) => {
            await text.exit(true);
            await clipboard.importFiles(files, point);
        }
    });
    services.beforeImport = () => text.exit(true);
    inspector = createInspector(right, services, text, canvas, options);
    const run = async (id: string, args: Data = {}) => {
        try {
            if (text.active && !["edit.undo", "edit.redo"].includes(id) && !id.startsWith("view."))
                await text.exit(true);
            if (id === "edit.copy")
                return clipboard.copy();
            if (id === "edit.cut")
                return clipboard.copy(true);
            if (id === "edit.paste")
                return clipboard.paste();
            if (id === "edit.paste-in-place")
                return services.commands.run(id, args);
            if (id === "edit.paste-replace")
                return clipboard.paste(undefined, true);
            if (id === "edit.copy-properties")
                return clipboard.copyProperties();
            if (id === "edit.paste-properties")
                return clipboard.pasteProperties();
            if (id === "export.copy-svg")
                return clipboard.copySvg();
            if (id === "export.copy-png")
                return clipboard.copyPng();
            if (id === "view.quick-actions")
                return quickActions();
            if (id === "layer.rename") {
                const shape = editor.page.objects[editor.selection[0]];
                if (shape)
                    askName("Rename layer", shape.name ?? shape.type, name => services.commands.run(id, {
                        ...args,
                        name
                    }));
                return;
            }
            if (id === "file.place-image")
                return pickFiles();
            if (id === "edit.enter") {
                const shape = editor.page.objects[editor.selection[0]];
                if (shape?.type === "text")
                    text.start(shape.id);
                else if (shape?.type === "path")
                    canvas.editPath(shape.id);
                else
                    await services.commands.run("select.children");
                return;
            }
            if (id.startsWith("tool.")) {
                await text.exit(true);
                if (canvas.active)
                    canvas.finishPen();
            }
            if (id === "edit.undo" && text.active)
                return text.undo();
            if (id === "edit.redo" && text.active)
                return text.redo();
            const result = await services.commands.run(id, args);
            if (id === "view.toggle-ui")
                root.classList.toggle("ui-hidden", !!editor.uiHidden);
            if (id.startsWith("view."))
                canvas.render();
            return result;
        }
        catch (e) {
            toast(String(e), "error");
            return false;
        }
    };
    function closeMenu() {
        menu?.remove();
        menu = null;
    }
    function commandMenu(event: {
        clientX: number;
        clientY: number;
    }, ids: (string | "---")[]) {
        closeMenu();
        menu = el("div", "context-menu");
        menu.setAttribute("role", "menu");
        for (const id of ids) {
            if (id === "---") {
                menu.append(el("hr"));
                continue;
            }
            const entry = services.commands.get(id);
            if (!entry)
                continue;
            const item = button("", () => {
                closeMenu();
                run(id);
            }, "", entry.label ?? id);
            item.append(el("span", "menu-label", entry.label ?? id));
            const toolIcon = toolEntries.find(([tool]) => id === "tool." + tool)?.[1];
            if (toolIcon)
                item.prepend(createIcon(toolIcon));
            item.setAttribute("role", "menuitem");
            item.dataset.key = id;
            item.disabled = !services.commands.enabled(id);
            const shortcut = Object.entries(shortcutMap).find(([, value]) => value === id)?.[0];
            if (shortcut)
                item.append(el("kbd", "", shortcut.replace("mod", "\u2318").replace("shift", "\u21E7").replace("alt", "\u2325")));
            menu.append(item);
        }
        menu.addEventListener("keydown", event => {
            const buttons = Array.from(menu!.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));
            const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
            if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
                event.preventDefault();
                event.stopPropagation();
                const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
                buttons[next]?.focus();
            }
            if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                closeMenu();
                stage.focus();
            }
        });
        document.body.append(menu);
        const box = menu.getBoundingClientRect();
        menu.style.left = `${Math.max(4, Math.min(event.clientX, innerWidth - box.width - 5))}px`;
        menu.style.top = `${Math.max(4, Math.min(event.clientY, innerHeight - box.height - 5))}px`;
        menu.querySelector("button")?.focus();
    }
    function showContext(event: MouseEvent) {
        commandMenu(event, [
            "edit.cut",
            "edit.copy",
            "edit.paste",
            "edit.duplicate",
            "---",
            "layer.rename",
            "struct.group",
            "struct.ungroup",
            "struct.frame",
            "struct.mask",
            "---",
            "component.create",
            "component.combine-variants",
            "component.reset",
            "component.detach",
            "---",
            "bool.union",
            "bool.subtract",
            "bool.intersect",
            "bool.exclude",
            "path.flatten",
            "---",
            "order.front",
            "order.back",
            "layer.lock",
            "layer.hide",
            "---",
            "export.copy-png",
            "export.copy-svg",
            "edit.delete"
        ]);
        const rect = stage.getBoundingClientRect(), point = canvas.world({
            x: event.clientX - rect.left,
            y: event.clientY - rect.top
        });
        const pasteHere = button("Paste here", async () => {
            closeMenu();
            await text.exit(true);
            await clipboard.paste(undefined, false, point);
        });
        pasteHere.setAttribute("role", "menuitem");
        pasteHere.dataset.key = "edit.paste-here";
        menu?.prepend(pasteHere);
    }
    const collapse = iconButton("layout-sidebar", () => {
        root.classList.toggle("collapsed");
        measure();
    }, "", "Collapse sidebar");
    collapse.id = "toggle-layers";
    header.prepend(collapse);
    header.append(iconButton("arrow-back-up", () => run("edit.undo"), "", "Undo"), iconButton("arrow-forward-up", () => run("edit.redo"), "", "Redo"), iconButton("command", () => quickActions(), "desktop-only", "Quick actions"), iconButton("search", () => openFind(), "desktop-only", "Find layers"));
    const componentsButton = iconButton("components", () => {
        leftTab = "assets";
        renderLeft();
        root.classList.add("mobile-left");
    }, "", "Components");
    componentsButton.id = "components";
    header.append(componentsButton);
    const zoomControl = el("div", "zoom-control");
    const zoomSelect = el("select");
    zoomSelect.setAttribute("aria-label", "Zoom");
    for (const [value, label] of [
        ["0.25", "25%"],
        ["0.5", "50%"],
        ["1", "100%"],
        ["2", "200%"],
        ["fit", "Fit canvas"],
        ["selection", "Selection"]
    ]) {
        const option = el("option", "", label);
        option.value = value;
        zoomSelect.append(option);
    }
    zoomSelect.value = String(editor.viewport.zoom);
    zoomSelect.onchange = () => {
        if (zoomSelect.value === "fit")
            canvas.fit([]);
        else if (zoomSelect.value === "selection")
            canvas.fit();
        else {
            const factor = Number(zoomSelect.value) / editor.viewport.zoom;
            canvas.zoom(factor, {
                x: stage.clientWidth / 2,
                y: stage.clientHeight / 2
            });
        }
    };
    zoomControl.append(iconButton("zoom-out", () => run("view.zoom-out"), "", "Zoom out"), zoomSelect, iconButton("zoom-in", () => run("view.zoom-in"), "", "Zoom in"));
    header.append(zoomControl);
    for (const [groupIndex, entries] of [[0, toolEntries.slice(0, 1)], [1, toolEntries.slice(1, 2)], [2, toolEntries.slice(2, 8)], [3, toolEntries.slice(8, 10)], [4, toolEntries.slice(10)]] as [
        number,
        typeof toolEntries
    ][]) {
        const group = el("div", "tool-group");
        group.dataset.group = String(groupIndex);
        for (const [tool, icon, key] of entries) {
            const b = iconButton(icon, () => run("tool." + tool), "", `${tool[0].toUpperCase() + tool.slice(1)}${key ? " (" + key + ")" : ""}`);
            b.dataset.tool = tool;
            if (key)
                b.append(el("small", "", key));
            group.append(b);
        }
        if (groupIndex === 2 || groupIndex === 3) {
            group.append(iconButton("chevron-down", eventlessToolMenu(groupIndex), "", "More drawing tools"));
        }
        tools.append(group);
    }
    function eventlessToolMenu(group: number) {
        return () => {
            const b = tools.querySelector(`[data-group="${group}"]`)!.getBoundingClientRect();
            commandMenu({
                clientX: b.x,
                clientY: b.y - 250
            }, (group === 2 ? [
                "rect",
                "ellipse",
                "polygon",
                "star",
                "line",
                "arrow"
            ] : ["pen", "pencil"]).map(t => "tool." + t));
        };
    }
    const mobile = el("div", "mobile-controls");
    mobile.append(iconButton("arrow-back-up", () => run("edit.undo"), "", "Undo"), labeledIconButton("arrows-maximize", "Fit", () => canvas.fit([])), iconButton("copy", () => run("edit.duplicate"), "", "Duplicate"), iconButton("trash", () => run("edit.delete"), "", "Delete"), labeledIconButton("stack", "Order", () => {
        const box = mobile.getBoundingClientRect();
        commandMenu({
            clientX: box.x + box.width / 2,
            clientY: box.y - 180
        }, ["order.front", "order.forward", "order.backward", "order.back"]);
    }), labeledIconButton("select-all", "Multi", () => {
        editor.multiSelect = !editor.multiSelect;
        mobile.querySelector("[aria-label=\"Multi\"]")?.setAttribute("aria-pressed", String(editor.multiSelect));
    }), labeledIconButton("check", "Done", async () => {
        await text.exit(true);
        root.classList.remove("mobile-left", "mobile-right");
    }), labeledIconButton("layout-sidebar", "Layers", () => {
        root.classList.toggle("mobile-left");
        root.classList.remove("mobile-right");
    }), labeledIconButton("adjustments-horizontal", "Design", () => {
        root.classList.toggle("mobile-right");
        root.classList.remove("mobile-left");
    }));
    root.append(mobile);
    async function pageAction(action: string, id: string) {
        await text.exit();
        if (action === "up" || action === "down") {
            const index = editor.doc.pages.indexOf(id), next = index + (action === "up" ? -1 : 1);
            if (index < 0 || next < 0 || next >= editor.doc.pages.length) return;
            editor.transact("Reorder pages", doc => {
                [doc.pages[index], doc.pages[next]] = [doc.pages[next], doc.pages[index]];
            });
            return;
        }
        if (action === "rename") {
            askName("Rename page", editor.doc.pagesById[id].name ?? "Page", name => editor.transact("Rename page", doc => {
                doc.pagesById[id].name = name;
            }));
            return;
        }
        if (action === "add") {
            let newId = "";
            editor.transact("Add page", doc => {
                newId = crypto.randomUUID();
                doc.pages.push(newId);
                doc.pagesById[newId] = {
                    id: newId,
                    name: `Page ${doc.pages.length}`,
                    objects: {
                        root: createShape("frame", {
                            id: "root",
                            parentId: "root",
                            enclosingFrameId: "root",
                            width: 1000,
                            height: 1000,
                            childIds: [],
                            fills: []
                        })
                    }
                };
            });
            editor.setPage(newId);
            return;
        }
        if (action === "clone") {
            let newId = "";
            editor.transact("Duplicate page", doc => {
                newId = crypto.randomUUID();
                const page = clone(doc.pagesById[id]);
                page.id = newId;
                page.name = (page.name ?? "Page") + " copy";
                const mapping = new Map(Object.keys(page.objects).map(shapeId => [shapeId, shapeId === "root" ? "root" : crypto.randomUUID()]));
                const componentMapping = new Map<string, string>();
                for (const component of Object.values(doc.components ?? {}))
                    if (component.mainPageId === id)
                        componentMapping.set(component.id, crypto.randomUUID());
                const objects: typeof page.objects = {};
                for (const shape of Object.values(page.objects)) {
                    const previous = shape.id;
                    shape.id = mapping.get(previous)!;
                    shape.parentId = mapping.get(shape.parentId) ?? shape.parentId;
                    shape.enclosingFrameId = mapping.get(shape.enclosingFrameId) ?? shape.enclosingFrameId;
                    if (shape.childIds)
                        shape.childIds = shape.childIds.map(child => mapping.get(child)!);
                    if (shape.sourceId)
                        shape.sourceId = mapping.get(shape.sourceId) ?? shape.sourceId;
                    if (shape.componentId)
                        shape.componentId = componentMapping.get(shape.componentId) ?? shape.componentId;
                    if (shape.variantSetId)
                        shape.variantSetId = mapping.get(shape.variantSetId) ?? shape.variantSetId;
                    objects[shape.id] = remapReferences(shape, new Map([...mapping, ...componentMapping]));
                }
                page.objects = objects;
                doc.pages.splice(doc.pages.indexOf(id) + 1, 0, newId);
                doc.pagesById[newId] = page;
                for (const component of Object.values(doc.components ?? {}))
                    if (component.mainPageId === id) {
                        const copied = clone(component);
                        copied.id = componentMapping.get(component.id)!;
                        copied.mainPageId = newId;
                        copied.mainId = mapping.get(component.mainId)!;
                        if (copied.variantSetId)
                            copied.variantSetId = mapping.get(copied.variantSetId) ?? copied.variantSetId;
                        doc.components![copied.id] = copied;
                    }
            });
            editor.setPage(newId);
            return;
        }
        if (action === "delete") {
            if (editor.doc.pages.length === 1) {
                toast("Keep at least one page.");
                return;
            }
            const next = editor.doc.pages.find(p => p !== id)!;
            editor.transact("Delete page", doc => {
                doc.pages = doc.pages.filter(p => p !== id);
                delete doc.pagesById[id];
                for (const c of Object.values(doc.components ?? {}))
                    if (c.mainPageId === id)
                        c.deleted = true;
            });
            if (editor.pageId === id)
                editor.setPage(next);
        }
    }
    function showPageActions(id: string) {
        modal("Page actions", (body, close) => {
            for (const [action, label] of [["rename", "Rename"], ["clone", "Clone"], ["delete", "Delete"], ["up", "Move up"], ["down", "Move down"]]) {
                const control = button(label, () => {
                    close();
                    return pageAction(action, id);
                });
                const index = editor.doc.pages.indexOf(id);
                control.disabled = action === "up" && index === 0 || action === "down" && index === editor.doc.pages.length - 1;
                body.append(control);
            }
        });
    }
    let selectingLayerRows = false;
    function selectLayerRows(ids: string[]) {
        selectingLayerRows = true;
        try { editor.setSelection(ids); }
        finally { selectingLayerRows = false; }
    }
    function updateLayerSelection() {
        const selected = new Set(editor.selection);
        for (const row of left.querySelectorAll<HTMLElement>(".layers .row[data-id]")) {
            const active = selected.has(row.dataset.id!);
            row.classList.toggle("selected", active);
            row.setAttribute("aria-selected", String(active));
        }
    }
    function revealLayerSelection() {
        const id = editor.selection.at(-1), shape = id && editor.page.objects[id];
        if (leftTab !== "layers") {
            renderLeft();
            return;
        }
        if (!shape) {
            if (!sameLayerPresentation()) renderLeft();
            else updateLayerSelection();
            return;
        }
        const target = shape.type === "frame" ? shape : ancestors(editor.page, shape.id).find(parent => parent.id !== "root" && parent.type === "frame") ?? shape;
        let expanded = false;
        for (const parent of ancestors(editor.page, target.id))
            expanded = collapsedNodes.delete(parent.id) || expanded;
        if (expanded || !sameLayerPresentation()) renderLeft(true);
        else updateLayerSelection();
        let row = left.querySelector<HTMLElement>(`.layers .row[data-id="${CSS.escape(target.id)}"]`);
        if (row?.hidden) {
            layerQuery = "";
            renderLeft(true);
            row = left.querySelector<HTMLElement>(`.layers .row[data-id="${CSS.escape(target.id)}"]`);
        }
        const tree = left.querySelector<HTMLElement>(".layers");
        if (!row || !tree) return;
        const bounds = row.getBoundingClientRect(), viewport = tree.getBoundingClientRect();
        if (bounds.top < viewport.top || bounds.bottom > viewport.bottom)
            tree.scrollTop += bounds.top - viewport.top;
    }
    function renderLeft(force = false) {
        if (destroyed)
            return;
        if (!force && left.contains(document.activeElement) && document.activeElement?.matches("input,[contenteditable=true]"))
            return;
        if (layerAnchor && !editor.page.objects[layerAnchor]) {
            layerAnchor = null;
            layerRangeBase = [];
        }
        const scrollTop = left.querySelector(".layers")?.scrollTop ?? 0;
        left.replaceChildren();
        const tabs = el("div", "ltabs");
        for (const [tab, label] of [["layers", "Layers"], ["assets", "Assets"]]) {
            const b = button(label, () => {
                leftTab = tab;
                renderLeft();
            }, leftTab === tab ? "active" : "");
            b.setAttribute("aria-pressed", String(leftTab === tab));
            tabs.append(b);
        }
        left.append(tabs);
        if (leftTab === "assets") {
            layerPresentation = null;
            renderAssets();
            return;
        }
        const pages = el("div", "pages");
        const ph = el("div", "panel-heading", "Pages");
        ph.append(iconButton("plus", () => pageAction("add", editor.pageId), "", "Add page"));
        pages.append(ph);
        if (editor.doc.pages.length > 2) {
            const picker = select("Current page", editor.pageId, editor.doc.pages.map(id => ({ value: id, label: editor.doc.pagesById[id].name ?? "Page" })), async id => {
                await text.exit();
                editor.setPage(id);
            });
            const compact = el("div", "page-selector");
            compact.append(picker, iconButton("dots", () => showPageActions(editor.pageId), "", "Page actions"));
            pages.append(compact);
        }
        else for (const id of editor.doc.pages) {
            const page = editor.doc.pagesById[id];
            const n = el("div", `page-row ${id === editor.pageId ? "active" : ""}`);
            n.dataset.id = id;
            n.draggable = isEditable(editor.page, id);
            n.append(createIcon("file", 16));
            const name = el("span", "name", page.name ?? "Page");
            n.append(name);
            n.onclick = async () => {
                await text.exit();
                editor.setPage(id);
            };
            n.ondblclick = () => pageAction("rename", id);
            n.append(iconButton("dots", () => showPageActions(id), "", "Page actions"));
            n.ondragstart = event => {
                dragged = {
                    kind: "page",
                    id
                };
                event.dataTransfer?.setData("text/plain", id);
            };
            n.ondragover = event => event.preventDefault();
            n.ondrop = event => {
                event.preventDefault();
                event.stopPropagation();
                if (dragged?.kind === "page" && dragged.id !== id) {
                    const from = dragged.id;
                    editor.transact("Reorder pages", doc => {
                        doc.pages = doc.pages.filter(p => p !== from);
                        doc.pages.splice(doc.pages.indexOf(id), 0, from);
                    });
                }
                dragged = null;
            };
            pages.append(n);
        }
        left.append(pages);
        const filter = el("input", "assets-search");
        filter.type = "search";
        filter.placeholder = "Filter layer name or type";
        filter.setAttribute("aria-label", "Filter layers");
        filter.value = layerQuery;
        const filterWrap = el("div", "layer-filter");
        filterWrap.append(filter);
        left.append(filterWrap);
        const tree = el("div", "layers");
        tree.setAttribute("role", "tree");
        tree.setAttribute("aria-label", "Layers");
        tree.setAttribute("aria-multiselectable", "true");
        const heading = el("div", "panel-heading", "Layers");
        tree.append(heading);
        const matchesLayer = (id: string): boolean => {
            const shape = editor.page.objects[id];
            return !!shape && (`${shape.name ?? ""} ${shape.type}`.toLowerCase().includes(layerQuery.toLowerCase()) || (shape.childIds ?? []).some(matchesLayer));
        };
        const visit = (id: string, depth: number) => {
            const shape = editor.page.objects[id];
            if (!shape)
                return;
            const n = el("div", `row ${editor.selection.includes(id) ? "selected" : ""}`);
            n.dataset.id = id;
            n.hidden = !!layerQuery && !matchesLayer(id);
            n.setAttribute("role", "treeitem");
            n.setAttribute("aria-selected", String(editor.selection.includes(id)));
            n.setAttribute("aria-level", String(depth + 1));
            n.dataset.locked = String(!!shape.locked);
            n.style.paddingLeft = `${8 + depth * 14}px`;
            n.draggable = isEditable(editor.page, id);
            const disclosure = iconButton(collapsedNodes.has(id) ? "chevron-right" : "chevron-down", () => {
                if (collapsedNodes.has(id))
                    collapsedNodes.delete(id);
                else
                    collapsedNodes.add(id);
                renderLeft();
            }, "", "Expand layer");
            if (!shape.childIds?.length) {
                disclosure.classList.add("disclosure-placeholder");
                disclosure.setAttribute("aria-hidden", "true");
                disclosure.tabIndex = -1;
            }
            if (shape.childIds)
                n.setAttribute("aria-expanded", String(!collapsedNodes.has(id)));
            const typeIcon = el("span", "type-icon");
            typeIcon.append(createIcon(shape.isMain ? "components" : shape.isInstanceRoot ? "diamond" : ({
                text: "letter-t",
                frame: "frame",
                group: "box",
                path: "vector-bezier",
                image: "photo",
                boolean: "components"
            } as Record<string, string>)[shape.type] ?? "square", 15));
            n.append(disclosure, typeIcon);
            const name = el("span", "name", shape.name ?? shape.type);
            n.append(name);
            n.append(iconButton(shape.hidden ? "eye-off" : "eye", () => editor.transact("Toggle layer visibility", doc => {
                const page = doc.pagesById[editor.pageId];
                if (ancestors(page, id).some(parent => parent.locked || parent.hidden))
                    return;
                const s = page.objects[id];
                s.hidden = !s.hidden;
            }), "", "Toggle visibility"), iconButton(shape.locked ? "lock" : "lock-open", () => editor.transact("Toggle layer lock", doc => {
                const page = doc.pagesById[editor.pageId];
                if (ancestors(page, id).some(parent => parent.locked || parent.hidden))
                    return;
                const s = page.objects[id];
                s.locked = !s.locked;
            }), "", "Toggle lock"));
            n.onclick = async (event) => {
                if ((event.target as HTMLElement).closest("button,[contenteditable=true]"))
                    return;
                const pageId = editor.pageId;
                await text.exit();
                if (editor.pageId !== pageId || !editor.page.objects[id]) return;
                const visible = Array.from(tree.querySelectorAll<HTMLElement>(".row[data-id]")).filter(row => !row.hidden).map(row => row.dataset.id!);
                const anchor = layerAnchor ? visible.indexOf(layerAnchor) : -1, target = visible.indexOf(id);
                if (event.shiftKey && anchor !== -1) {
                    const range = visible.slice(Math.min(anchor, target), Math.max(anchor, target) + 1);
                    selectLayerRows([...new Set([...layerRangeBase.filter(key => visible.includes(key)), ...range])]);
                }
                else {
                    const selection = event.metaKey || event.ctrlKey ? editor.selection.includes(id) ? editor.selection.filter(key => key !== id) : [...editor.selection, id] : event.shiftKey ? [...editor.selection, id] : [id];
                    layerAnchor = id;
                    layerRangeBase = [...selection];
                    selectLayerRows(selection);
                }
            };
            name.ondblclick = async (event) => {
                event.stopPropagation();
                await text.exit(true);
                const original = shape.name ?? shape.type;
                name.contentEditable = "true";
                name.focus();
                const range = document.createRange();
                range.selectNodeContents(name);
                window.getSelection()?.removeAllRanges();
                window.getSelection()?.addRange(range);
                let canceled = false;
                name.onkeydown = event => {
                    if (event.key === "Enter") {
                        event.preventDefault();
                        name.blur();
                    }
                    if (event.key === "Escape") {
                        event.preventDefault();
                        event.stopPropagation();
                        canceled = true;
                        name.textContent = original;
                        name.blur();
                    }
                };
                name.onblur = () => {
                    name.contentEditable = "false";
                    if (!canceled) {
                        const value = name.textContent?.trim();
                        if (value)
                            services.commands.run("layer.rename", {
                                id,
                                name: value
                            });
                    }
                    renderLeft();
                };
            };
            n.oncontextmenu = event => {
                event.preventDefault();
                event.stopPropagation();
                if (!editor.selection.includes(id)) selectLayerRows([id]);
                showContext(event);
            };
            const dropAt = (event: DragEvent) => {
                if (dragged?.kind !== "layer" || dragged.pageId !== editor.pageId) return null;
                const page = editor.page, target = page.objects[id], box = n.getBoundingClientRect();
                if (!target || !isEditable(page, id)) return null;
                const inside = !!target.childIds && event.clientX > box.left + 45 && event.clientY > box.top + 7 && event.clientY < box.bottom - 7;
                const position = inside ? "inside" : event.clientY < box.top + box.height / 2 ? "before" : "after";
                const parentId = inside ? id : target.parentId;
                if (parentId !== "root" && !isEditable(page, parentId)) return null;
                const ids = topLevelIds(page, dragged.ids).filter(key => isEditable(page, key));
                if (!ids.length || ids.includes(id) || ids.some(key => parentId === key || ancestors(page, parentId).some(parent => parent.id === key))) return null;
                const remaining = page.objects[parentId].childIds!.filter(key => !ids.includes(key));
                const index = inside ? remaining.length : remaining.indexOf(id) + (position === "before" ? 1 : 0);
                return { ids, parentId, position, index };
            };
            n.ondragstart = event => {
                if ((event.target as HTMLElement).closest("button,[contenteditable=true]") || !isEditable(editor.page, id)) {
                    event.preventDefault();
                    return;
                }
                dragged = {
                    kind: "layer",
                    pageId: editor.pageId,
                    ids: topLevelIds(editor.page, editor.selection.includes(id) ? editor.selection : [id])
                };
                event.dataTransfer?.setData("text/plain", id);
                if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
            };
            n.ondragover = event => {
                if (dragged?.kind !== "layer") return;
                event.stopPropagation();
                clearLayerDrop();
                const destination = dropAt(event);
                if (event.dataTransfer) event.dataTransfer.dropEffect = destination ? "move" : "none";
                if (!destination) return;
                event.preventDefault();
                n.dataset.drop = destination.position;
            };
            n.ondragleave = event => {
                if (!n.contains(event.relatedTarget as Node | null)) n.removeAttribute("data-drop");
            };
            n.ondrop = event => {
                if (dragged?.kind !== "layer") return;
                event.preventDefault();
                event.stopPropagation();
                const destination = dropAt(event);
                endDrag();
                if (!destination) return;
                editor.transact("Move layers", doc => {
                    reparentShapes(doc.pagesById[editor.pageId], destination.ids, destination.parentId, destination.index);
                });
                selectLayerRows(destination.ids);
            };
            tree.append(n);
            if (layerQuery || !collapsedNodes.has(id))
                for (const child of [...shape.childIds ?? []].reverse())
                    visit(child, depth + 1);
        };
        for (const id of [...editor.page.objects.root?.childIds ?? []].reverse())
            visit(id, 0);
        if (!editor.page.objects.root?.childIds?.length)
            tree.append(el("div", "empty-state", "Draw a shape or place an image to begin."));
        left.append(tree);
        tree.scrollTop = scrollTop;
        layerPresentation = {pageId: editor.pageId, pages: [...editor.doc.pages],
            names: editor.doc.pages.map(id => editor.doc.pagesById[id].name), objects: editor.page.objects};
        filter.oninput = () => {
            layerQuery = filter.value;
            const cursor = filter.selectionStart;
            renderLeft(true);
            const input = left.querySelector<HTMLInputElement>("[aria-label=\"Filter layers\"]");
            input?.focus({
                preventScroll: true
            });
            if (cursor !== null)
                input?.setSelectionRange(cursor, cursor);
        };
    }
    function renderAssets() {
        const assets = el("div", "assets");
        const search = el("input", "assets-search");
        search.type = "search";
        search.placeholder = "Search components and styles";
        search.setAttribute("aria-label", "Search assets");
        search.value = assetQuery;
        const content = el("div");
        search.oninput = () => {
            assetQuery = search.value;
            renderAssetContent(content);
        };
        assets.append(search, content);
        left.append(assets);
        renderAssetContent(content);
    }
    function renderAssetContent(content: HTMLElement) {
        content.replaceChildren();
        let offset = 0, components: Data[] = [];
        do {
            const page = services.components.list(assetQuery, offset);
            components.push(...page.components ?? page.items ?? []);
            offset = page.nextOffset ?? -1;
        } while (offset >= 0);
        const groups = new Map<string, Data[]>(), seen = new Set<string>();
        for (const component of components) {
            if (component.deleted)
                continue;
            const key = component.variantSetId ?? component.id;
            if (seen.has(key))
                continue;
            seen.add(key);
            const pageName = editor.doc.pagesById[component.mainPageId]?.name ?? "Library", path = (component.path ?? component.name?.split("/").slice(0, -1).join("/") ?? "").trim();
            const group = [pageName, path].filter(Boolean).join(" / ");
            const list = groups.get(group) ?? [];
            list.push(component);
            groups.set(group, list);
        }
        for (const [group, items] of groups) {
            content.append(el("div", "asset-heading", group));
            const grid = el("div", "asset-grid");
            for (const component of items) {
                const sourcePage = editor.doc.pagesById[component.mainPageId];
                const family = component.variantSetId ? sourcePage?.objects[component.variantSetId]?.name : undefined;
                const label = family || (component.path ? component.name : component.name?.split("/").at(-1)) || "Component";
                const tile = button("", async () => {
                    await text.exit();
                    const p = clipboard.center();
                    const result = services.components.run("instance", {
                        source: component.id,
                        componentId: component.id,
                        pageId: editor.pageId,
                        parent: "root",
                        x: p.x,
                        y: p.y
                    });
                    if (result.selection)
                        editor.setSelection(result.selection);
                }, "atile", `Insert ${component.name}`);
                tile.dataset.id = component.id;
                const preview = el("span", "atile-preview");
                preview.setAttribute("aria-hidden", "true");
                if (sourcePage) {
                    let thumbnails = thumbnailCache.get(sourcePage);
                    if (!thumbnails) {
                        thumbnails = new Map();
                        thumbnailCache.set(sourcePage, thumbnails);
                    }
                    let thumbnail = thumbnails.get(component.mainId);
                    if (!thumbnail) {
                        thumbnail = Promise.resolve().then(() => services.view.thumbnailSvg!(component.mainPageId, component.mainId));
                        thumbnails.set(component.mainId, thumbnail);
                    }
                    void thumbnail.then(svg => {
                        if (destroyed || !preview.isConnected)
                            return;
                        preview.innerHTML = svg;
                        const scene = preview.querySelector("svg");
                        if (scene) {
                            scene.setAttribute("width", "100%");
                            scene.setAttribute("height", "100%");
                            scene.setAttribute("preserveAspectRatio", "xMidYMid meet");
                            scene.style.pointerEvents = "none";
                        }
                    }).catch(error => {
                        if (!destroyed && preview.isConnected) {
                            preview.textContent = "Preview unavailable";
                            preview.title = String(error);
                        }
                    });
                }
                tile.append(preview, el("span", "atile-label", label));
                if (component.variantSetId)
                    tile.append(el("small", "muted", components.filter(c => c.variantSetId === component.variantSetId).length + " variants"));
                grid.append(tile);
            }
            content.append(grid);
        }
        if (!groups.size)
            content.append(el("div", "empty-state", "No components match. Create a component from selected layers."));
        const styles = services.styles.list?.(assetQuery) ?? Object.values(editor.doc.styles ?? {});
        const files = Object.values(editor.doc.assets ?? {}).map(asset => asset as Data).filter((asset: any) => asset.kind !== "font" && String(asset.name).toLowerCase().includes(assetQuery.toLowerCase()));
        if (files.length) {
            content.append(el("div", "asset-heading", "Images"));
            const grid = el("div", "asset-grid");
            for (const asset of files) {
                const tile = button("", async () => {
                    await text.exit(true);
                    const p = clipboard.center(), result = services.assets.place(asset.id, {
                        pageId: editor.pageId,
                        x: p.x,
                        y: p.y
                    });
                    editor.setSelection(result.selection ?? []);
                }, "atile", asset.name);
                const preview = el("img");
                preview.src = asset.src;
                preview.alt = "";
                preview.style.cssText = "width:100%;height:60px;object-fit:contain";
                tile.append(preview, el("span", "", asset.name));
                grid.append(tile);
            }
            content.append(grid);
        }
        content.append(el("div", "asset-heading", "Local styles"));
        for (const style of styles) {
            const r = el("div", "row");
            r.append(button(style.name, async () => {
                await text.exit(true);
                if (editor.selection.length)
                    services.styles.apply(style.id, editor.selection.filter(id => isEditable(editor.page, id)), style.type === "paint" ? "fill" : style.type === "effect" ? "effect" : "text");
                else
                    editStyle(style);
            }), iconButton("dots", () => editStyle(style), "", "Edit style"));
            content.append(r);
        }
        content.append(labeledIconButton("plus", "Style", () => modal("Create local style", (body, close) => {
            let name = "Style", type = "paint";
            body.append(input("Name", name, v => name = v), select("Type", type, ["paint", "text", "effect"], v => type = v), button("Create", () => {
                const value = type === "paint" ? [{
                        color: "#7d9fdf"
                    }] : type === "text" ? {
                    fontFamily: options.defaultFamily ?? "IBM Plex Sans",
                    fontSize: 16,
                    fontWeight: 400,
                    lineHeight: 24
                } : {
                    shadows: []
                };
                services.styles.create(type, name, value);
                close();
                renderLeft();
            }));
        }), "", "+ Style"));
        content.append(el("div", "asset-heading", "Libraries"));
        const libraries = services.libraries?.list?.() ?? Object.values(editor.doc.libraries ?? {});
        for (const library of libraries) {
            const r = el("div", "row");
            r.append(check(library.name ?? library.id, library.enabled !== false, v => services.libraries?.enable(library.id, v)), iconButton("dots", () => libraryDialog(library), "", "Library settings"));
            content.append(r);
        }
        content.append(button("Import library", async () => {
            const pageId = editor.pageId;
            const current = () => !destroyed && editor.pageId === pageId;
            try {
                await text.exit(true);
                if (!current()) return;
                const [file] = await chooseFiles(options, { kind: "library" }, signal);
                if (!file || !current()) return;
                const snapshot = JSON.parse(await file.text());
                if (!current()) return;
                if (!services.libraries?.add)
                    throw Error("Library service unavailable");
                services.libraries.add(snapshot);
                renderLeft();
            }
            catch (error) {
                if (current()) throw error;
            }
        }), button("Place image / font", pickFiles));
    }
    async function editStyle(style: Data) {
        await text.exit(true);
        modal("Edit " + style.name, (body, close) => {
            body.append(input("Name", style.name, v => services.styles.rename(style.id, v)), input("Description", style.description ?? "", v => services.styles.update(style.id, {
                description: v
            })), button("Edit value", () => jsonEditor("Style value", style.type === "paint" ? style.paints : style.type === "text" ? style.text : style.effects, v => {
                services.styles.update(style.id, {
                    [style.type === "paint" ? "paints" : style.type === "text" ? "text" : "effects"]: v
                });
                renderLeft();
            })), iconButton("copy", () => {
                services.styles.create(style.type, style.name + " copy", clone(style.type === "paint" ? style.paints : style.type === "text" ? style.text : style.effects));
                close();
                renderLeft();
            }, "", "Duplicate"), button("Delete", () => {
                services.styles.remove(style.id);
                close();
                renderLeft();
            }));
        });
    }
    async function libraryDialog(library: Data) {
        await text.exit(true);
        modal(library.name ?? "Library", (body, close) => {
            body.append(el("p", "muted", "This document stores a local library snapshot."), button("Edit snapshot", () => jsonEditor("Library snapshot", library, v => {
                services.libraries.update(library.id, v);
                renderLeft();
            })), button("Export snapshot", () => {
                const blob = new Blob([JSON.stringify(library, null, 2)], {
                    type: "application/json"
                });
                const save = options.exportFile ?? services.export.saveFile;
                if (save)
                    return save(blob, (library.name ?? "library") + ".json");
                const url = URL.createObjectURL(blob), a = el("a");
                a.href = url;
                a.download = (library.name ?? "library") + ".json";
                a.click();
                setTimeout(() => URL.revokeObjectURL(url), 2000);
            }), button("Remove library link", () => {
                services.libraries.remove(library.id);
                close();
                renderLeft();
            }));
        });
    }
    function quickActions() {
        modal("Quick actions", (body, close) => {
            const search = el("input", "assets-search");
            search.placeholder = "Type a command";
            search.setAttribute("aria-label", "Search commands");
            const results = el("div", "command-results");
            let index = 0;
            const render = () => {
                results.replaceChildren();
                index = 0;
                for (const command of services.commands.list().filter(c => `${c.label} ${c.id}`.toLowerCase().includes(search.value.toLowerCase()))) {
                    const b = button(command.label ?? command.id, () => {
                        close();
                        run(command.id);
                    });
                    b.dataset.key = command.id;
                    b.disabled = !services.commands.enabled(command.id);
                    const shortcut = Object.entries(shortcutMap).find(([, id]) => id === command.id)?.[0];
                    if (shortcut)
                        b.append(el("kbd", "", shortcut));
                    results.append(b);
                }
            };
            search.oninput = render;
            search.onkeydown = event => {
                const buttons = Array.from(results.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                    event.preventDefault();
                    index = (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
                    buttons[index]?.focus();
                }
                if (event.key === "Enter") {
                    event.preventDefault();
                    buttons[index]?.click();
                }
            };
            body.append(search, results);
            render();
            search.focus();
        });
    }
    function openFind() {
        if (findBar) {
            findBar.querySelector("input")?.focus();
            return;
        }
        findBar = el("div", "find-bar");
        findBar.setAttribute("role", "search");
        const query = el("input");
        query.type = "search";
        query.placeholder = "Find layers or text";
        query.setAttribute("aria-label", "Find layers");
        const replacement = el("input");
        replacement.placeholder = "Replace with";
        replacement.setAttribute("aria-label", "Replacement");
        const count = el("span", "muted");
        let caseSensitive = false, wholeWord = false;
        const expression = () => {
            const slash = String.fromCharCode(92), special = slash + "^$.*+?()[]{}|", word = "[" + slash + "p{L}" + slash + "p{N}_]";
            const escaped = Array.from(query.value).map(char => special.includes(char) ? slash + char : char).join("");
            return new RegExp(wholeWord ? "(?<!" + word + ")" + escaped + "(?!" + word + ")" : escaped, caseSensitive ? "gu" : "giu");
        };
        const next = (direction: number) => {
            if (!findMatches.length)
                return;
            findIndex = (findIndex + direction + findMatches.length) % findMatches.length;
            editor.setSelection([findMatches[findIndex]]);
            canvas.fit([findMatches[findIndex]]);
            count.textContent = `${findIndex + 1}/${findMatches.length}`;
        };
        const search = () => {
            const regex = expression();
            findMatches = query.value ? Object.values(editor.page.objects).filter(shape => {
                if (shape.id === "root")
                    return false;
                regex.lastIndex = 0;
                const value = shape.type === "text" ? (shape.content.children ?? []).map((paragraph: Data) => paragraph.children.map((run: Data) => run.text).join("")).join("\n") : shape.name ?? "";
                return regex.test(value);
            }).map(shape => shape.id) : [];
            findIndex = -1;
            count.textContent = `0/${findMatches.length}`;
            next(1);
        };
        const replaceText = (content: Data, all: boolean) => {
            let changed = false;
            const regex = expression();
            for (const paragraph of content.children ?? []) {
                const value = paragraph.children.map((run: Data) => run.text).join("");
                regex.lastIndex = 0;
                const matches = Array.from(value.matchAll(regex)) as RegExpMatchArray[];
                if (!matches.length)
                    continue;
                const chosen = all ? matches : matches.slice(0, 1);
                for (const match of chosen.reverse()) {
                    const start = match.index!, end = start + match[0].length, children: Data[] = [];
                    let position = 0, inserted = false;
                    for (const run of paragraph.children) {
                        const runEnd = position + run.text.length, a = Math.max(0, start - position), b = Math.min(run.text.length, end - position);
                        if (a < b) {
                            if (a)
                                children.push({
                                    ...run,
                                    text: run.text.slice(0, a)
                                });
                            if (!inserted) {
                                children.push({
                                    ...run,
                                    text: replacement.value
                                });
                                inserted = true;
                            }
                            if (b < run.text.length)
                                children.push({
                                    ...run,
                                    text: run.text.slice(b)
                                });
                        }
                        else
                            children.push(run);
                        position = runEnd;
                    }
                    paragraph.children = children;
                    changed = true;
                }
                if (changed && !all)
                    break;
            }
            return changed;
        };
        const replace = async (all: boolean) => {
            if (!query.value || !findMatches.length)
                return;
            await text.exit(true);
            const ids = all ? [...findMatches] : [findMatches[Math.max(0, findIndex)]];
            await services.fonts.ensure?.(replacement.value);
            editor.transact(all ? "Replace all matches" : "Replace match", doc => {
                for (const id of ids) {
                    const page = doc.pagesById[editor.pageId];
                    const shape = page.objects[id];
                    if (!shape || !isEditable(page, id))
                        continue;
                    if (shape.type === "text")
                        replaceText(shape.content, all);
                    else {
                        const regex = expression();
                        shape.name = String(shape.name ?? "").replace(all ? regex : new RegExp(regex.source, caseSensitive ? "u" : "iu"), replacement.value);
                    }
                }
            });
            search();
        };
        query.oninput = search;
        query.onkeydown = event => {
            if (event.key === "Enter") {
                event.preventDefault();
                next(event.shiftKey ? -1 : 1);
            }
            if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                findBar?.remove();
                findBar = null;
                stage.focus();
            }
        };
        const options = row(check("Case", caseSensitive, v => {
            caseSensitive = v;
            search();
        }), check("Whole word", wholeWord, v => {
            wholeWord = v;
            search();
        }));
        const searchRow = row(query, count, iconButton("arrow-up", () => next(-1), "", "Previous match"), iconButton("arrow-down", () => next(1), "", "Next match"), iconButton("x", () => {
            findBar?.remove();
            findBar = null;
            stage.focus();
        }, "", "Close find"));
        const replaceRow = row(replacement, button("Replace", () => replace(false)), button("All", () => replace(true), "", "Replace all matches"));
        findBar.append(searchRow, options, replaceRow);
        stage.append(findBar);
        query.focus();
    }
    function rename(id: string): Promise<string | null> {
        const shape = editor.page.objects[id];
        if (!shape)
            return Promise.resolve(null);
        return new Promise(resolve => {
            let resolved = false;
            const dialog = modal("Rename layer", (body, close) => {
                const field = input("Name", shape.name ?? shape.type, () => {
                });
                body.append(field, button("Save", () => {
                    const value = field.querySelector("input")!.value.trim();
                    if (!value)
                        return;
                    resolved = true;
                    resolve(value);
                    close();
                }, "primary"));
                field.querySelector("input")?.select();
            });
            dialog.addEventListener("close", () => {
                if (!resolved)
                    resolve(null);
            }, {
                once: true
            });
        });
    }
    async function placeImage(): Promise<Data | null> {
        const pageId = editor.pageId;
        const current = () => !destroyed && editor.pageId === pageId;
        try {
            const [file] = await chooseFiles(options, { kind: "image" }, signal);
            if (!file || !current()) return null;
            const image = await readImageFile(file);
            return current() ? image : null;
        }
        catch (error) {
            if (current()) toast(String(error), "error");
            return null;
        }
    }
    async function pickFiles() {
        const pageId = editor.pageId;
        const current = () => !destroyed && editor.pageId === pageId;
        try {
            await text.exit(true);
            if (!current()) return;
            const files = await chooseFiles(options, { kind: "assets", multiple: true }, signal);
            if (!files.length || !current()) return;
            await clipboard.importFiles(files, clipboard.center());
        }
        catch (error) {
            if (current()) throw error;
        }
    }
    function key(event: KeyboardEvent) {
        if (destroyed || event.defaultPrevented || event.isComposing)
            return;
        if (event.key === "Escape" && menu) {
            closeMenu();
            event.preventDefault();
            return;
        }
        const target = event.target as HTMLElement;
        if (target.closest("dialog"))
            return;
        const typing = target.closest("input,textarea,select,[contenteditable=true]");
        if (typing) {
            if (text.active && target.closest(".text-edit-host"))
                text.key(event);
            return;
        }
        if (canvas.key(event))
            return;
        const mac = /Mac|iPhone|iPad/.test(navigator.platform), mod = event.metaKey || (!mac && event.ctrlKey);
        let name = event.key.toLowerCase();
        if (event.code.startsWith("Digit") && event.shiftKey)
            name = event.code.slice(5);
        let parts: string[] = [];
        if (mod)
            parts.push("mod");
        if (event.ctrlKey && mac)
            parts.push("ctrl");
        if (event.ctrlKey && event.altKey && !event.metaKey && shortcutMap["ctrl+alt+" + (event.shiftKey ? "shift+" : "") + name])
            parts = ["ctrl"];
        if (event.altKey)
            parts.push("alt");
        if (event.shiftKey)
            parts.push("shift");
        parts.push(name);
        const combination = parts.join("+");
        if ((mod && event.key === "/") || combination === "mod+shift+p") {
            event.preventDefault();
            quickActions();
            return;
        }
        if (mod && name === "f") {
            event.preventDefault();
            openFind();
            return;
        }
        if (mod && event.altKey && name === "c") {
            event.preventDefault();
            clipboard.copyProperties();
            return;
        }
        if (mod && event.altKey && name === "v") {
            event.preventDefault();
            clipboard.pasteProperties();
            return;
        }
        if (mod && event.shiftKey && name === "c") {
            event.preventDefault();
            clipboard.copyPng().catch(e => toast(String(e), "error"));
            return;
        }
        if (mod && event.shiftKey && name === "v") {
            event.preventDefault();
            services.commands.run("edit.paste-in-place");
            return;
        }
        if (mod && event.shiftKey && name === "r") {
            event.preventDefault();
            clipboard.paste(undefined, true);
            return;
        }
        if (name === "enter" && !event.shiftKey && !mod && !event.altKey) {
            event.preventDefault();
            run("edit.enter");
            return;
        }
        if (/^[0-9]$/.test(name) && !mod && !event.altKey && !event.shiftKey) {
            event.preventDefault();
            run("layer.opacity-" + name);
            return;
        }
        const command = shortcutMap[combination];
        if (command) {
            event.preventDefault();
            if (command === "select.none") {
                root.classList.remove("mobile-left", "mobile-right");
            }
            run(command);
        }
    }
    document.addEventListener("keydown", key, {
        signal
    });
    document.addEventListener("pointerdown", event => {
        if (menu && !menu.contains(event.target as Node))
            closeMenu();
    }, {
        signal
    });
    document.addEventListener("focusin", event => {
        if (!root.contains(event.target as Node))
            return;
        if (text.active && (event.target as HTMLElement).closest(".ltabs,.pages,#tools"))
            text.exit();
    }, {
        signal
    });
    let lastShape: Tool = "rect", lastPen: Tool = "pen";
    function refreshToolbar() {
        if ([
            "rect",
            "ellipse",
            "polygon",
            "star",
            "line",
            "arrow"
        ].includes(editor.tool))
            lastShape = editor.tool;
        if (["pen", "pencil"].includes(editor.tool))
            lastPen = editor.tool;
        for (const b of Array.from(tools.querySelectorAll<HTMLButtonElement>("[data-tool]"))) {
            const active = b.dataset.tool === editor.tool;
            b.classList.toggle("remembered", b.dataset.tool === lastShape || b.dataset.tool === lastPen);
            b.classList.toggle("active", active);
            b.setAttribute("aria-pressed", String(active));
        }
        const zoom = editor.viewport.zoom;
        let custom = zoomSelect.querySelector<HTMLOptionElement>("[data-current]");
        if (!Array.from(zoomSelect.options).some(o => o.value === String(zoom))) {
            if (!custom) {
                custom = el("option");
                custom.dataset.current = "true";
                zoomSelect.prepend(custom);
            }
            custom.value = String(zoom);
            custom.textContent = Math.round(zoom * 100) + "%";
        }
        zoomSelect.value = String(zoom);
        root.classList.toggle("ui-hidden", !!editor.uiHidden);
    }
    let selectionBeforeCanvasClick = editor.selection;
    stage.addEventListener("pointerdown", () => { selectionBeforeCanvasClick = editor.selection; }, { capture: true, signal });
    stage.addEventListener("click", () => {
        if (editor.selection === selectionBeforeCanvasClick && editor.selection.length) revealLayerSelection();
    }, { signal });
    const unsubscribe = editor.on(event => {
        if (event.page) {
            layerAnchor = null;
            layerRangeBase = [];
            endDrag();
            text.exit();
            findBar?.remove();
            findBar = null;
            collapsedNodes.clear();
        }
        if (event.selection && !event.page) {
            if (!selectingLayerRows) revealLayerSelection();
            else if (!sameLayerPresentation()) renderLeft();
            else updateLayerSelection();
        }
        else if (event.page || !event.viewport && !event.hover && (!event.deltas || event.projection)) {
            if (event.page || !sameLayerPresentation())
                renderLeft();
        }
        refreshToolbar();
    });
    function measure() {
        if (destroyed)
            return;
        const width = stage.clientWidth || 1, height = stage.clientHeight || 1, v = editor.viewport;
        if (width === v.vport.width && height === v.vport.height)
            return;
        editor.setViewport({
            ...v,
            vport: {
                width,
                height
            },
            vbox: {
                ...v.vbox,
                width: width / v.zoom,
                height: height / v.zoom
            }
        });
    }
    const resize = new ResizeObserver(measure);
    resize.observe(stage);
    measure();
    renderLeft();
    refreshToolbar();
    Object.assign(services, {
        edit: (id: string) => text.start(id),
        editPath: (id: string) => canvas.editPath(id),
        quickActions,
        openQuickActions: quickActions,
        rename,
        pasteText: clipboard.pasteText,
        importClipboard: clipboard.importClipboard,
        placeImage
    });
    const handle: WorkspaceHandle = {
        session: text,
        vp: {
            set: editor.setViewport.bind(editor),
            fit: canvas.fit,
            zoom: canvas.zoom,
            pan: canvas.pan
        },
        vector: {
            edit: canvas.editPath,
            close: () => services.commands.run("path.close"),
            open: () => services.commands.run("path.open"),
            join: () => services.commands.run("path.join"),
            merge: () => services.commands.run("path.merge")
        },
        openFind,
        placeImage,
        openQuickActions: quickActions,
        quickActions,
        rename,
        pasteText: clipboard.pasteText,
        importClipboard: clipboard.importClipboard,
        openFontPicker: () => inspector?.fontPicker(),
        paste: clipboard.paste,
        copy: clipboard.copy,
        cut: () => clipboard.copy(true),
        flush: async () => {
            if (text.active)
                await text.exit(true);
            if (canvas.active)
                canvas.finishPen();
            inspector?.finishScrub();
            await services.view.settled();
            canvas.flush();
        },
        editingText: () => text.id,
        highlightAgent: canvas.highlightAgent,
        edit: (id, select = true, create = false) => text.start(id, select, create),
        editPath: canvas.editPath,
        stage,
        ix: canvas,
        find: {
            open: openFind,
            close() {
                findBar?.remove();
                findBar = null;
            }
        },
        picker: {
            open: inspector.fontPicker
        },
        assets: {
            open() {
                leftTab = "assets";
                renderLeft();
            }
        },
        refresh() {
            renderLeft();
            inspector?.refresh();
            canvas.render();
        },
        async destroy() {
            if (destroyed)
                return;
            destroyed = true;
            await text.destroy();
            canvas.destroy();
            clipboard.destroy();
            inspector?.destroy();
            unsubscribe();
            abort.abort();
            resize.disconnect();
            closeMenu();
            root.replaceChildren();
            root.classList.remove("lv-editor", "collapsed", "ui-hidden", "mobile-left", "mobile-right");
            roots.delete(root);
        }
    };
    return handle;
}
