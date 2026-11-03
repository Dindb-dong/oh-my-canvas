import type { Data, EditorServices } from "../contracts";
import { el, clone, textValue, toast } from "../ui/dom";
type Cursor = {
    start: number;
    end: number;
};
type Snapshot = Cursor & {
    content: Data;
};
const richMime = "application/x-oh-my-canvas-rich-text";
export function createTextSession(stage: HTMLElement, services: EditorServices, onChange: () => void) {
    const editor = services.editor;
    let id: string | null = null;
    let host: HTMLElement | null = null;
    let surface: HTMLElement | null = null;
    let mirror: HTMLTextAreaElement | null = null;
    let created = false, composing = false, destroyed = false;
    let history: Snapshot[] = [], cursor = 0;
    let savedRange: Cursor = {
        start: 0,
        end: 0
    };
    let closing: Promise<void> | null = null;
    let fontWork: Promise<unknown> = Promise.resolve();
    const current = () => id ? editor.page.objects[id] : null;
    const clean = (value: string) => (value ?? "").replace(/\u200b/g, "");
    const visibleText = (node: Node) => {
        const copy = node.cloneNode(true);
        if (copy instanceof HTMLElement || copy instanceof DocumentFragment)
            copy.querySelectorAll("[data-marker]").forEach(marker => marker.remove());
        return clean(copy.textContent ?? "");
    };
    function paragraphs() {
        return Array.from(surface?.childNodes ?? []);
    }
    function domOffset(node: Node, offset: number) {
        let position = 0;
        for (const paragraph of paragraphs()) {
            if (paragraph === node || paragraph.contains(node)) {
                const range = document.createRange();
                range.selectNodeContents(paragraph);
                try {
                    range.setEnd(node, offset);
                }
                catch {
                    return position;
                }
                return position + visibleText(range.cloneContents()).length;
            }
            position += visibleText(paragraph).length + 1;
        }
        return position;
    }
    function offsets(): Cursor {
        const selection = window.getSelection();
        if (!surface || !selection?.rangeCount || !surface.contains(selection.anchorNode))
            return savedRange;
        const range = selection.getRangeAt(0);
        savedRange = {
            start: domOffset(range.startContainer, range.startOffset),
            end: domOffset(range.endContainer, range.endOffset)
        };
        return savedRange;
    }
    function locateOffset(offset: number): {
        node: Node;
        offset: number;
    } | null {
        if (!surface)
            return null;
        let base = 0;
        const blocks = paragraphs();
        for (let index = 0; index < blocks.length; index++) {
            const paragraph = blocks[index], length = visibleText(paragraph).length;
            if (offset <= base + length || index === blocks.length - 1) {
                const walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT, {
                    acceptNode: node => (node.parentElement?.closest("[data-marker]") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT)
                });
                let node: Node | null, within = Math.max(0, Math.min(length, offset - base)), last: Node | null = null;
                while (node = walker.nextNode()) {
                    last = node;
                    const raw = node.textContent ?? "", visible = clean(raw).length;
                    if (within <= visible) {
                        let rawOffset = 0, count = 0;
                        while (rawOffset < raw.length && count < within) {
                            if (raw[rawOffset] !== "\u200B")
                                count++;
                            rawOffset++;
                        }
                        return {
                            node,
                            offset: rawOffset
                        };
                    }
                    within -= visible;
                }
                return last ? {
                    node: last,
                    offset: last.textContent?.length ?? 0
                } : {
                    node: paragraph,
                    offset: 0
                };
            }
            base += length + 1;
        }
        return {
            node: surface,
            offset: 0
        };
    }
    function restore(start: number, end = start) {
        if (!surface)
            return;
        const first = locateOffset(start), last = locateOffset(end);
        if (!first || !last)
            return;
        const range = document.createRange();
        range.setStart(first.node, first.offset);
        range.setEnd(last.node, last.offset);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
        savedRange = {
            start,
            end
        };
    }
    function styleSpan(span: HTMLElement, run: Data) {
        span.dataset.run = JSON.stringify(run);
        Object.assign(span.style, {
            fontFamily: run.fontFamily ?? "",
            fontSize: run.fontSize ? `${run.fontSize}px` : "",
            fontWeight: String(run.fontWeight ?? 400),
            fontStyle: run.fontStyle ?? "normal",
            textDecorationLine: run.textDecoration ?? "none",
            textDecorationStyle: run.textDecorationStyle ?? "solid",
            textDecorationThickness: run.textDecorationThickness ? `${run.textDecorationThickness}px` : "",
            textTransform: run.textTransform === "smallCaps" ? "none" : run.textTransform ?? "none",
            fontVariantCaps: run.textTransform === "smallCaps" ? "small-caps" : "normal",
            letterSpacing: `${run.letterSpacing ?? 0}px`,
            color: run.fills?.[0]?.color ?? "#202532",
            background: run.highlight?.color ?? ""
        });
    }
    function buildParagraph(paragraph: Data, index = 0) {
        const block = el("div");
        block.dataset.paragraph = JSON.stringify({
            ...paragraph,
            children: undefined
        });
        Object.assign(block.style, {
            textAlign: paragraph.textAlign ?? "left",
            lineHeight: paragraph.lineHeight ? (typeof paragraph.lineHeight === "number" && paragraph.lineHeight > 4 ? `${paragraph.lineHeight}px` : String(paragraph.lineHeight)) : "1.2",
            marginBottom: `${paragraph.paragraphSpacing ?? 0}px`,
            position: "relative",
            textIndent: `${paragraph.paragraphIndent ?? 0}px`,
            paddingLeft: `${(paragraph.listLevel ?? 0) * 24 + (paragraph.listType && paragraph.listType !== "none" ? 24 : 0)}px`
        });
        if (paragraph.listType && paragraph.listType !== "none") {
            const marker = el("span");
            marker.dataset.marker = "true";
            marker.contentEditable = "false";
            marker.textContent = paragraph.listType === "ordered" ? `${index + 1}.` : "\u2022";
            marker.style.cssText = `position:absolute;left:${(paragraph.listLevel ?? 0) * 24}px`;
            block.append(marker);
        }
        for (const run of paragraph.children ?? []) {
            const span = el("span");
            styleSpan(span, run);
            span.textContent = run.text || "\u200B";
            block.append(span);
        }
        if (!block.childNodes.length)
            block.append(el("br"));
        return block;
    }
    function render(content: Data) {
        if (!surface)
            return;
        surface.replaceChildren(...(content.children ?? []).map(buildParagraph));
        if (!surface.childNodes.length)
            surface.append(buildParagraph({
                children: [{
                        text: ""
                    }]
            }));
    }
    function read(): Data {
        const previous = current()?.content ?? {
            type: "richText",
            children: []
        };
        const fallback = previous.children?.[0]?.children?.[0] ?? {
            fontFamily: "IBM Plex Sans",
            fontSize: 16
        };
        const blocks: Data[] = [];
        const readRuns = (node: Node, inherited: Data): Data[] => {
            if (node.nodeType === Node.TEXT_NODE)
                return [{
                        ...inherited,
                        text: clean(node.textContent ?? "")
                    }];
            const element = node as HTMLElement;
            if (element.dataset?.marker)
                return [];
            if (element.tagName === "BR")
                return [{
                        ...inherited,
                        text: "\n"
                    }];
            let style = inherited;
            if (element.dataset?.run) {
                try {
                    style = JSON.parse(element.dataset.run);
                }
                catch {
                }
            }
            if (["B", "STRONG"].includes(element.tagName))
                style = {
                    ...style,
                    fontWeight: 700
                };
            if (["I", "EM"].includes(element.tagName))
                style = {
                    ...style,
                    fontStyle: "italic"
                };
            if (element.tagName === "U")
                style = {
                    ...style,
                    textDecoration: "underline"
                };
            return Array.from(node.childNodes).flatMap(child => readRuns(child, style));
        };
        let loose: Data[] = [];
        for (const node of paragraphs()) {
            if (node instanceof HTMLElement && ["DIV", "P", "LI"].includes(node.tagName)) {
                if (loose.length) {
                    blocks.push({
                        children: loose
                    });
                    loose = [];
                }
                let props: Data = {};
                try {
                    props = JSON.parse(node.dataset.paragraph ?? "{}");
                }
                catch {
                }
                const runs = readRuns(node, fallback);
                if (node.childNodes.length === 1 && (node.firstChild as HTMLElement)?.tagName === "BR")
                    runs[0].text = "";
                const split: Data[][] = [[]];
                for (const run of runs)
                    String(run.text).split("\n").forEach((value, index) => {
                        if (index)
                            split.push([]);
                        split.at(-1)!.push({
                            ...run,
                            text: value
                        });
                    });
                for (const children of split)
                    blocks.push({
                        ...props,
                        children
                    });
            }
            else
                loose.push(...readRuns(node, fallback));
        }
        if (loose.length || !blocks.length)
            blocks.push({
                children: loose.length ? loose : [{
                        ...fallback,
                        text: ""
                    }]
            });
        return {
            ...previous,
            type: "richText",
            children: blocks
        };
    }
    function preview(content = read(), record = true) {
        if (!id)
            return;
        const target = id;
        editor.preview(doc => {
            const shape = doc.pagesById[editor.pageId]?.objects[target];
            if (shape)
                shape.content = clone(content);
        });
        if (mirror)
            mirror.value = textValue(content);
        fontWork = Promise.resolve(services.fonts.ensure?.(textValue(content))).catch(error => toast(String(error), "error"));
        if (record && !composing) {
            const range = offsets();
            if (JSON.stringify(history[cursor]?.content) !== JSON.stringify(content)) {
                history.splice(cursor + 1);
                history.push({
                    content: clone(content),
                    ...range
                });
                if (history.length > 100)
                    history.shift();
                cursor = history.length - 1;
            }
            else if (history[cursor])
                Object.assign(history[cursor], range);
        }
        onChange();
    }
    function syncPosition() {
        const shape = current();
        if (!host || !surface || !shape)
            return;
        const view = editor.viewport;
        Object.assign(host.style, {
            left: `${(shape.x - view.vbox.x) * view.zoom}px`,
            top: `${(shape.y - view.vbox.y) * view.zoom}px`,
            width: `${Math.max(1, shape.width)}px`,
            transform: `scale(${view.zoom}) matrix(${shape.transform.a},${shape.transform.b},${shape.transform.c},${shape.transform.d},0,0)`,
            transformOrigin: `${shape.width / 2}px ${shape.height / 2}px`
        });
        surface.style.width = shape.autoResize === "widthAndHeight" ? "max-content" : `${shape.width}px`;
        surface.style.minWidth = `${shape.autoResize === "widthAndHeight" ? 1 : shape.width}px`;
        surface.style.minHeight = `${shape.height}px`;
        surface.style.fontFamily = shape.content?.children?.[0]?.children?.[0]?.fontFamily ?? "IBM Plex Sans";
        surface.style.fontSize = `${shape.content?.children?.[0]?.children?.[0]?.fontSize ?? 16}px`;
        const rendered = services.view.element(shape.id);
        if (rendered)
            rendered.style.visibility = "hidden";
    }
    async function start(target: string, select = true, isNew = false) {
        if (destroyed)
            return;
        if (id === target) {
            surface?.focus();
            if (select)
                restore(0, textValue(current()?.content).length);
            return;
        }
        await exit(true);
        const shape = editor.page.objects[target];
        if (!shape || shape.type !== "text" || shape.locked)
            return;
        if (!(isNew && editor.undo.blocked) && !editor.begin("Edit text"))
            return;
        id = target;
        created = isNew;
        editor.setSelection([id]);
        host = el("div", "text-edit-host");
        surface = el("div", "text-edit-surface");
        surface.contentEditable = "true";
        surface.spellcheck = false;
        surface.setAttribute("role", "textbox");
        surface.setAttribute("aria-label", "Rich text editor");
        surface.setAttribute("aria-multiline", "true");
        mirror = el("textarea");
        mirror.setAttribute("aria-label", "Text editor");
        mirror.tabIndex = -1;
        mirror.value = textValue(shape.content);
        mirror.addEventListener("input", () => {
            const first = clone(current()?.content?.children?.[0]?.children?.[0] ?? {});
            const content = {
                ...current()?.content,
                type: "richText",
                children: mirror!.value.split("\n").map(text => ({
                    children: [{
                            ...first,
                            text
                        }]
                }))
            };
            render(content);
            preview(content);
        });
        host.append(surface, mirror);
        stage.append(host);
        render(shape.content);
        syncPosition();
        history = [{
                content: clone(shape.content),
                start: 0,
                end: 0
            }];
        cursor = 0;
        surface.addEventListener("input", () => preview());
        surface.addEventListener("compositionstart", () => {
            composing = true;
        });
        surface.addEventListener("compositionend", () => {
            composing = false;
            preview();
        });
        surface.addEventListener("keydown", event => {
            if (key(event))
                event.stopPropagation();
        });
        surface.addEventListener("keyup", () => {
            offsets();
            onChange();
        });
        surface.addEventListener("mouseup", () => {
            offsets();
            onChange();
        });
        surface.addEventListener("copy", copyRich);
        surface.addEventListener("cut", event => {
            copyRich(event);
            document.execCommand("delete");
            preview();
        });
        surface.addEventListener("paste", pasteRich);
        surface.focus();
        if (stage.clientWidth < 700)
            surface.scrollIntoView({
                block: "nearest",
                inline: "nearest"
            });
        restore(select ? 0 : textValue(shape.content).length, textValue(shape.content).length);
        onChange();
    }
    function exit(commit = true): Promise<void> {
        if (closing)
            return closing;
        if (!id)
            return Promise.resolve();
        const target = id, content = read(), empty = !textValue(content).trim(), wasCreated = created;
        const finish = () => {
            if (!id || id !== target)
                return;
            const rendered = services.view.element(target);
            if (rendered)
                rendered.style.visibility = "";
            id = null;
            host?.remove();
            host = null;
            surface = null;
            mirror = null;
            history = [];
            if (commit && (!empty || !wasCreated)) {
                editor.preview(doc => {
                    const shape = doc.pagesById[editor.pageId]?.objects[target];
                    if (shape)
                        shape.content = content;
                });
                editor.commitSession();
            }
            else {
                editor.cancelSession();
                if (wasCreated)
                    editor.setSelection([]);
            }
            onChange();
        };
        if (!commit) {
            finish();
            return Promise.resolve();
        }
        const ensure = services.fonts.ensure?.(textValue(content)) ?? Promise.resolve();
        closing = Promise.all([fontWork, ensure]).then(finish).finally(() => {
            closing = null;
        });
        return closing;
    }
    function selectedRuns(content = read(), range = offsets()) {
        let position = 0;
        const runs: Data[] = [];
        for (const paragraph of content.children) {
            for (const run of paragraph.children) {
                const end = position + run.text.length;
                if (range.end > position && range.start < end || range.start === range.end && range.start >= position && range.start <= end)
                    runs.push(run);
                position = end;
            }
            position++;
        }
        return runs;
    }
    function selectionStyle() {
        const runs = selectedRuns();
        const keys = new Set(runs.flatMap(run => Object.keys(run)));
        const result: Data = {};
        for (const key of keys) {
            if (key !== "text")
                result[key] = runs.every(run => JSON.stringify(run[key]) === JSON.stringify(runs[0]?.[key])) ? runs[0]?.[key] : "";
        }
        return result;
    }
    function selectionParagraphStyle() {
        const range = offsets(), content = read();
        let position = 0;
        const selected: Data[] = [];
        for (const paragraph of content.children) {
            const end = position + paragraph.children.reduce((sum: number, run: Data) => sum + run.text.length, 0);
            if (range.end >= position && range.start <= end)
                selected.push(paragraph);
            position = end + 1;
        }
        const result: Data = {};
        const keys = new Set(selected.flatMap(paragraph => Object.keys(paragraph)));
        for (const key of keys) {
            if (key !== "children")
                result[key] = selected.every(paragraph => JSON.stringify(paragraph[key]) === JSON.stringify(selected[0]?.[key])) ? selected[0]?.[key] : "";
        }
        return result;
    }
    function applyStyle(patch: Data) {
        if (!id || !surface)
            return;
        const range = offsets();
        if (range.start === range.end) {
            surface.focus();
            restore(range.start);
            const selection = window.getSelection();
            if (!selection?.rangeCount)
                return;
            const span = el("span");
            styleSpan(span, {
                ...selectedRuns()[0],
                ...patch,
                text: ""
            });
            span.textContent = "\u200B";
            const nativeRange = selection.getRangeAt(0);
            nativeRange.insertNode(span);
            nativeRange.setStart(span.firstChild!, 1);
            nativeRange.collapse(true);
            selection.removeAllRanges();
            selection.addRange(nativeRange);
            savedRange = range;
            return;
        }
        const content = read();
        let position = 0;
        for (const paragraph of content.children) {
            const next: Data[] = [];
            for (const run of paragraph.children) {
                const end = position + run.text.length, a = Math.max(0, range.start - position), b = Math.min(run.text.length, range.end - position);
                if (a < b) {
                    if (a > 0)
                        next.push({
                            ...run,
                            text: run.text.slice(0, a)
                        });
                    next.push({
                        ...run,
                        ...patch,
                        text: run.text.slice(a, b)
                    });
                    if (b < run.text.length)
                        next.push({
                            ...run,
                            text: run.text.slice(b)
                        });
                }
                else
                    next.push(run);
                position = end;
            }
            paragraph.children = next;
            position++;
        }
        render(content);
        preview(content);
        surface.focus();
        restore(range.start, range.end);
    }
    function applyParagraph(patch: Data) {
        if (!id)
            return;
        const range = offsets(), content = read();
        let position = 0;
        for (const paragraph of content.children) {
            const end = position + paragraph.children.reduce((sum: number, run: Data) => sum + run.text.length, 0);
            if (range.end >= position && range.start <= end)
                Object.assign(paragraph, patch);
            position = end + 1;
        }
        render(content);
        preview(content);
        surface?.focus();
        restore(range.start, range.end);
    }
    function copyRich(event: ClipboardEvent) {
        if (!event.clipboardData || !surface)
            return;
        const range = offsets(), content = read();
        let position = 0;
        const selected: Data[] = [];
        for (const paragraph of content.children) {
            const children: Data[] = [];
            for (const run of paragraph.children) {
                const a = Math.max(0, range.start - position), b = Math.min(run.text.length, range.end - position);
                if (a < b)
                    children.push({
                        ...run,
                        text: run.text.slice(a, b)
                    });
                position += run.text.length;
            }
            if (children.length)
                selected.push({
                    ...paragraph,
                    children
                });
            position++;
        }
        const value = {
            type: "richText",
            children: selected
        };
        event.preventDefault();
        event.clipboardData.setData(richMime, JSON.stringify(value));
        event.clipboardData.setData("text/plain", textValue(value));
    }
    function pasteRich(event: ClipboardEvent) {
        event.preventDefault();
        const rich = event.clipboardData?.getData(richMime);
        if (rich) {
            try {
                const content = JSON.parse(rich);
                if (!Array.isArray(content.children))
                    throw Error("Invalid rich clipboard");
                const container = el("div");
                for (const paragraph of content.children) {
                    if (!Array.isArray(paragraph.children))
                        throw Error("Invalid text runs");
                    container.append(buildParagraph(paragraph));
                }
                document.execCommand("insertHTML", false, container.innerHTML);
                preview();
                return;
            }
            catch {
            }
        }
        document.execCommand("insertText", false, event.clipboardData?.getData("text/plain") ?? "");
        preview();
    }
    function historyStep(delta: number) {
        const next = cursor + delta;
        if (next < 0 || next >= history.length)
            return false;
        cursor = next;
        const entry = history[cursor];
        render(entry.content);
        preview(entry.content, false);
        restore(entry.start, entry.end);
        return true;
    }
    function key(event: KeyboardEvent) {
        if (!id || event.isComposing || composing)
            return false;
        const mod = event.metaKey || event.ctrlKey, name = event.key.toLowerCase();
        if (mod && name === "z") {
            event.preventDefault();
            historyStep(event.shiftKey ? 1 : -1);
            return true;
        }
        if (event.key === "Escape") {
            event.preventDefault();
            exit(false).catch(error => toast(String(error), "error"));
            return true;
        }
        if (mod && event.key === "Enter") {
            event.preventDefault();
            exit(true).catch(error => toast(String(error), "error"));
            return true;
        }
        if (mod && ["b", "i", "u"].includes(name)) {
            event.preventDefault();
            const style = selectionStyle();
            applyStyle(name === "b" ? {
                fontWeight: style.fontWeight === 700 ? 400 : 700
            } : name === "i" ? {
                fontStyle: style.fontStyle === "italic" ? "normal" : "italic"
            } : {
                textDecoration: style.textDecoration === "underline" ? "none" : "underline"
            });
            return true;
        }
        return false;
    }
    function indent(delta = 1) {
        if (!id)
            return false;
        const range = offsets(), content = read();
        let position = 0;
        for (const paragraph of content.children) {
            const end = position + paragraph.children.reduce((sum: number, run: Data) => sum + run.text.length, 0);
            if (range.end >= position && range.start <= end)
                paragraph.listLevel = Math.max(0, (paragraph.listLevel ?? 0) + delta);
            position = end + 1;
        }
        render(content);
        preview(content);
        surface?.focus();
        restore(range.start, range.end);
        return true;
    }
    function deleteText(direction: "backward" | "forward" = "backward") {
        if (!id || !surface)
            return false;
        const range = offsets();
        surface.focus();
        restore(range.start, range.end);
        const done = document.execCommand(direction === "forward" ? "forwardDelete" : "delete");
        preview();
        return done;
    }
    async function copyText() {
        if (!id || !surface)
            return false;
        const range = offsets();
        surface.focus();
        restore(range.start, range.end);
        if (document.execCommand("copy"))
            return true;
        try {
            await navigator.clipboard.writeText(textValue(read()).slice(range.start, range.end));
            return true;
        }
        catch {
            return false;
        }
    }
    async function cutText() {
        if (!id || !surface)
            return false;
        const target = id, range = offsets();
        surface.focus();
        restore(range.start, range.end);
        if (document.execCommand("cut"))
            return true;
        if (!await copyText() || id !== target)
            return false;
        restore(range.start, range.end);
        return deleteText();
    }
    async function pasteText(value?: string) {
        if (!id || !surface)
            return false;
        const target = id, range = offsets();
        surface.focus();
        restore(range.start, range.end);
        if (value === undefined) {
            if (document.execCommand("paste"))
                return true;
            try {
                value = await navigator.clipboard.readText();
            }
            catch {
                return false;
            }
        }
        if (id !== target)
            return false;
        surface.focus();
        restore(range.start, range.end);
        const done = document.execCommand("insertText", false, value);
        preview();
        return done;
    }
    const observer = new MutationObserver(() => {
        if (id)
            syncPosition();
    });
    observer.observe(stage, {
        childList: true,
        subtree: true
    });
    const unsubscribe = editor.on(event => {
        if (!id)
            return;
        if (!editor.page.objects[id] || event.page) {
            exit(false).catch(error => toast(String(error), "error"));
            return;
        }
        syncPosition();
    });
    return {
        get active() {
            return !!id;
        },
        get closing() {
            return !!closing;
        },
        get id() {
            return id;
        },
        start,
        exit,
        key,
        applyStyle,
        applyParagraph,
        indent,
        delete: deleteText,
        copy: copyText,
        cut: cutText,
        paste: pasteText,
        range: offsets,
        selectionStyle,
        selectionParagraphStyle,
        undo: () => historyStep(-1),
        redo: () => historyStep(1),
        insert(value: string) {
            surface?.focus();
            document.execCommand("insertText", false, value);
            preview();
        },
        insertParagraph() {
            surface?.focus();
            document.execCommand("insertParagraph");
            preview();
        },
        toggle: applyStyle,
        compositionStart() {
            composing = true;
        },
        compositionUpdate() {
            preview();
        },
        compositionEnd() {
            composing = false;
            preview();
        },
        syncPosition,
        async destroy() {
            if (destroyed)
                return;
            await exit(true);
            destroyed = true;
            unsubscribe();
            observer.disconnect();
        }
    };
}
