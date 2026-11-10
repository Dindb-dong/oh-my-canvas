import {referencedAssets} from '../images/assets';
import {DESIGN_FILE_LIMIT} from '../../core/capacity.mjs';
import type { Data, EditorServices, Point, Shape } from "../contracts";
import { createShape, topLevelIds, descendants } from "../document";
import { moveShape, shapeBounds, unionBounds } from "../geometry";
import { clone, textValue, toast } from "../ui/dom";
const MIME = "application/x-oh-my-canvas-shapes";
export function createClipboard(stage: HTMLElement, services: EditorServices, options: Data = {}) {
    const editor = services.editor, abort = new AbortController();
    let memory: Data | null = null;
    const center = () => ({
        x: editor.viewport.vbox.x + stage.clientWidth / editor.viewport.zoom / 2,
        y: editor.viewport.vbox.y + stage.clientHeight / editor.viewport.zoom / 2
    });
    const dataUrl = (file: Blob) => new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
    });
    const typing = (target: EventTarget | null) => target instanceof HTMLElement && !!target.closest("input,textarea,select,[contenteditable=true]");
    function serialize() {
        const roots = topLevelIds(editor.page, editor.selection);
        return {
            kind: "oh-my-canvas/shapes",
            version: 1,
            assets: referencedAssets(roots.flatMap(id=>descendants(editor.page,id,true)),editor.doc.assets),
            capacity:editor.doc.capacity,
            roots,
            shapes: roots.flatMap(id => descendants(editor.page, id, true)).map(clone)
        };
    }
    function normalize(data: Data) {
        const raw = data.ohMyCanvas ?? data;
        if (!raw || (!raw.objects && !raw.shapes))
            throw Error("Clipboard has no shape records");
        const shapes: Array<Shape> = Array.isArray(raw.shapes) ? raw.shapes : Object.values(raw.objects ?? raw.shapes);
        if (!shapes.length || shapes.length > 10000)
            throw Error("Invalid clipboard shape count");
        const roots = raw.roots ?? shapes.filter(shape => !shapes.some(parent => parent.id === shape.parentId)).map(shape => shape.id);
        return {
            ...raw,
            kind: "oh-my-canvas/shapes",
            roots,
            shapes
        };
    }
    function insert(data: Data, point?: Point, replace = false, mode?: string) {
        const payload = normalize(data);
        if (typeof services.commands.pastePrepared !== "function")
            throw Error("Prepared clipboard insertion is unavailable");
        return services.commands.pastePrepared(payload, point ? {
            x: point.x,
            y: point.y,
            parentId: "root"
        } : {}, mode ?? (replace ? "paste-replace" : "paste")) as string[];
    }
    function imported(result: Data): {
        shapes: Shape[];
        roots: string[];
    } {
        const shapes: Array<Shape> = Array.isArray(result.shapes) ? result.shapes : Object.values(result.objects ?? {});
        const ids = new Set(shapes.map(shape => shape.id));
        return {
            shapes,
            roots: result.rootIds ?? shapes.filter(shape => !ids.has(shape.parentId)).map(shape => shape.id)
        };
    }
    async function importFiles(files: File[], point: Point) {
        const pageId = editor.pageId, shapes: Shape[] = [], roots: string[] = [], assets: Data[] = [], fontFaces: Data[] = [];
        let offset = 0,large=false;
        const warnings: string[] = [];
        for (const file of files) {
            const designFormat = /\.(fig|sketch)$/i.exec(file.name)?.[1].toLowerCase();
            if (designFormat && file.size > DESIGN_FILE_LIMIT) throw Error('Design file exceeds 256 MiB');
            const src = designFormat ? '' : await dataUrl(file);
            if (file.type.includes("font") || /\.(woff2?|ttf|otf)$/i.test(file.name)) {
                const family = file.name.replace(/\.[^.]+$/, "");
                fontFaces.push({
                    family,
                    url: src
                });
                assets.push({
                    name: file.name,
                    kind: "font",
                    src,
                    family,
                    mimeType: file.type
                });
                continue;
            }
            let group: {
                shapes: Shape[];
                roots: string[];
            };
            if (designFormat) {
                if (!services.formats?.importDesignFile) throw Error('Design file import requires the desktop app');
                const result = await services.formats.importDesignFile(new Uint8Array(await file.arrayBuffer()), designFormat);
                const document = result.document;large ||= document.capacity==='large';
                assets.push(...Object.values(document.assets??{}) as Data[]);
                group = {shapes: [], roots: []};
                for (const pageId of document.pages) {
                    const page = document.pagesById[pageId];
                    group.shapes.push(...Object.values(page.objects).filter((shape: any) => shape.id !== 'root') as Shape[]);
                    group.roots.push(...page.objects.root.childIds);
                }
                warnings.push(...result.warnings);
            }
            else if (file.type === "image/svg+xml" || /\.svg$/i.test(file.name)) {
                const svg = await file.text();
                await services.fonts.ensure?.(svg);
                if (!services.formats?.importSvg)
                    throw Error("SVG import is unavailable");
                const result = await services.formats.importSvg(svg, {
                    x: 0,
                    y: 0,
                    id: () => crypto.randomUUID(),
                    parentId: "root"
                });
                group = imported(result);
                assets.push({
                    name: file.name,
                    kind: "svg",
                    src,
                    mimeType: "image/svg+xml",
                    width: result.width,
                    height: result.height
                });
            }
            else if (file.type.startsWith("image/")) {
                const image = new Image();
                image.src = src;
                await image.decode();
                const shape = createShape("image", {
                    name: file.name,
                    x: 0,
                    y: 0,
                    width: image.naturalWidth,
                    height: image.naturalHeight,
                    parentId: "root",
                    enclosingFrameId: "root",
                    objectFit: "contain",
                    image: {
                        src,
                        width: image.naturalWidth,
                        height: image.naturalHeight,
                        mimeType: file.type
                    },
                    fills: []
                });
                group = {
                    shapes: [shape],
                    roots: [shape.id]
                };
                assets.push({
                    name: file.name,
                    kind: "image",
                    src,
                    width: image.naturalWidth,
                    height: image.naturalHeight,
                    mimeType: file.type
                });
            }
            else if (/\.json$/i.test(file.name)) {
                if (!services.formats?.importCanvasJson)
                    throw Error("Canvas JSON import is unavailable");
                const document = services.formats.importCanvasJson(JSON.parse(await file.text()));
                const page = document.pagesById[document.pages[0]];
                group = {
                    shapes: Object.values(page.objects).filter((shape: any) => shape.id !== "root") as Shape[],
                    roots: page.objects.root.childIds
                };
            }
            else
                throw Error("Unsupported file: " + file.name);
            if (!group.shapes.length)
                throw Error("The imported file has no layers");
            const box = unionBounds(group.shapes.filter(shape => group.roots.includes(shape.id)).map(shapeBounds));
            for (const shape of group.shapes)
                moveShape(shape, offset - box.x, -box.y);
            shapes.push(...group.shapes);
            roots.push(...group.roots);
            offset += box.width + 24;
        }
        if (pageId !== editor.pageId)
            throw Error("The page changed while files were loading. Place the files again.");
        const releaseFonts = fontFaces.length ? await services.fonts.prepareAssets?.(assets) : undefined;
        try {
            if (pageId !== editor.pageId)
                throw Error("The page changed while fonts were loading. Place the files again.");
            if (shapes.length && typeof services.commands.pastePrepared !== "function")
                throw Error("Prepared file insertion is unavailable");
            editor.transact("Place files", doc => {
                if(large)doc.capacity="large";
                for (const asset of assets)
                    services.assets?.addFile?.(asset);
                if (shapes.length)
                    services.commands.pastePrepared({
                        kind: "oh-my-canvas/shapes",
                        roots,
                        shapes
                    }, {
                        parentId: "root",
                        x: point.x,
                        y: point.y
                    });
            });
            if (warnings.length) toast('Imported with limitations: ' + [...new Set(warnings)].join(' '));
            if (fontFaces.length)
                toast("Fonts added");
        }
        finally {
            releaseFonts?.();
        }
    }
    async function copy(cut = false, event?: ClipboardEvent) {
        const data = serialize();
        if (!data.roots.length)
            return false;
        memory = data;
        const plain = data.roots.map(id => {
            const shape = data.shapes.find(shape => shape.id === id)!;
            return shape.type === "text" ? textValue(shape.content) : shape.name ?? shape.type;
        }).join("\n");
        if (event?.clipboardData) {
            event.preventDefault();
            event.clipboardData.setData(MIME, JSON.stringify(data));
            event.clipboardData.setData("text/plain", JSON.stringify(data));
        }
        else {
            try {
                await navigator.clipboard.writeText(JSON.stringify(data));
            }
            catch {
                toast("Clipboard access was denied; copied layers remain available in this editor.");
            }
        }
        if (cut)
            await services.commands.run("edit.delete", {
                ids: data.roots
            });
        return true;
    }
    async function paste(event?: ClipboardEvent, replace = false, at?: Point) {
        const data = event?.clipboardData;
        if (data?.files.length) {
            event!.preventDefault();
            await services.beforeImport?.();
            await importFiles(Array.from(data.files), at ?? center());
            return true;
        }
        let source = data?.getData(MIME), plain = data?.getData("text/plain") ?? "";
        if (!event) {
            try {
                plain = await navigator.clipboard.readText();
            }
            catch {
                if (memory) {
                    await insert(memory, at, replace);
                    return true;
                }
                return false;
            }
        }
        if (!source && plain.trim().startsWith("{")) {
            try {
                const candidate = JSON.parse(plain), payload = candidate.ohMyCanvas ?? candidate;
                if (payload.shapes || payload.objects)
                    source = JSON.stringify(payload);
            }
            catch {
            }
        }
        if (source) {
            event?.preventDefault();
            await insert(JSON.parse(source), at, replace);
            return true;
        }
        if (plain.trim().startsWith("<svg")) {
            event?.preventDefault();
            await services.beforeImport?.();
            await services.fonts.ensure?.(plain);
            if (!services.formats?.importSvg)
                throw Error("SVG import is unavailable");
            const result = imported(await services.formats.importSvg(plain, {
                id: () => crypto.randomUUID(),
                parentId: "root"
            }));
            await insert({
                roots: result.roots,
                shapes: result.shapes
            }, replace ? undefined : at ?? center(), replace);
            return true;
        }
        if (plain) {
            event?.preventDefault();
            await services.beforeImport?.();
            await services.fonts.ensure?.(plain);
            const point = at ?? center(), shape = createShape("text", {
                name: "Text",
                parentId: "root",
                enclosingFrameId: "root",
                ...point,
                width: Math.min(500, Math.max(40, plain.length * 9)),
                height: 30,
                autoResize: "widthAndHeight",
                content: {
                    type: "richText",
                    children: plain.split("\n").map(text => ({
                        children: [{
                                text,
                                fontFamily: options.defaultFamily ?? "IBM Plex Sans",
                                fontSize: 16,
                                fontWeight: 400,
                                fills: [{
                                        color: "#252b37"
                                    }]
                            }]
                    }))
                }
            });
            await insert({
                roots: [shape.id],
                shapes: [shape]
            }, replace ? undefined : point, replace);
            return true;
        }
        return false;
    }
    async function pasteText(value: string, args: Data = {}) {
        await services.beforeImport?.();
        await services.fonts.ensure?.(value);
        const point = {
            x: args.x ?? center().x,
            y: args.y ?? center().y
        }, shape = createShape("text", {
            name: "Text",
            parentId: "root",
            enclosingFrameId: "root",
            ...point,
            width: Math.min(500, Math.max(40, value.length * 9)),
            height: 30,
            autoResize: "widthAndHeight",
            content: {
                type: "richText",
                children: value.split("\n").map(text => ({
                    children: [{
                            text,
                            fontFamily: options.defaultFamily ?? "IBM Plex Sans",
                            fontSize: 16,
                            fontWeight: 400,
                            fills: [{
                                    color: "#252b37"
                                }]
                        }]
                }))
            }
        });
        return insert({
            roots: [shape.id],
            shapes: [shape]
        }, args.mode && args.mode !== "paste" ? undefined : point, false, args.mode).length > 0;
    }
    async function importClipboard(payload: Data, args: Data = {}) {
        await services.beforeImport?.();
        if (payload.shapes || payload.objects)
            return insert(payload, args.x !== undefined ? {
                x: args.x,
                y: args.y
            } : undefined, args.mode === "paste-replace", args.mode).length > 0;
        const source = payload.svg ?? payload.html ?? payload.text;
        if (typeof source === "string") {
            await services.fonts.ensure?.(source);
            const svg = source.trim().startsWith("<svg"), html = payload.html !== undefined;
            if (svg || html) {
                const parse = svg ? services.formats?.importSvg : services.formats?.importHtml;
                if (!parse)
                    throw Error("Clipboard markup import is unavailable");
                const result = imported(await parse(source, {
                    id: () => crypto.randomUUID(),
                    parentId: "root"
                }));
                return insert(result, args.x !== undefined ? {
                    x: args.x,
                    y: args.y
                } : args.mode && args.mode !== "paste" ? undefined : center(), args.mode === "paste-replace", args.mode).length > 0;
            }
            return pasteText(source, args);
        }
        const src = payload.src ?? payload.image?.src;
        if (typeof src === "string") {
            const image = new Image();
            image.src = src;
            await image.decode();
            const point = args.x !== undefined ? {
                x: args.x,
                y: args.y
            } : center();
            const shape = createShape("image", {
                name: payload.name ?? "Image",
                ...point,
                width: payload.width ?? image.naturalWidth,
                height: payload.height ?? image.naturalHeight,
                parentId: "root",
                enclosingFrameId: "root",
                objectFit: "contain",
                image: {
                    src,
                    width: image.naturalWidth,
                    height: image.naturalHeight,
                    mimeType: payload.mimeType
                }
            });
            return insert({
                roots: [shape.id],
                shapes: [shape]
            }, args.mode && args.mode !== "paste" ? undefined : point, args.mode === "paste-replace", args.mode).length > 0;
        }
        return false;
    }
    document.addEventListener("copy", event => {
        if (!typing(event.target))
            copy(false, event).catch(error => toast(String(error), "error"));
    }, {
        signal: abort.signal
    });
    document.addEventListener("cut", event => {
        if (!typing(event.target))
            copy(true, event).catch(error => toast(String(error), "error"));
    }, {
        signal: abort.signal
    });
    document.addEventListener("paste", event => {
        if (!typing(event.target))
            paste(event).catch(error => toast(String(error), "error"));
    }, {
        signal: abort.signal
    });
    return {
        copy,
        paste,
        pasteText,
        importClipboard,
        importFiles,
        insert,
        center,
        copyProperties: () => services.commands.run("edit.copy-properties"),
        pasteProperties: () => services.commands.run("edit.paste-properties"),
        async copySvg() {
            await navigator.clipboard.writeText(await services.export.svg(editor.selection));
        },
        async copyPng() {
            const id = editor.selection[0];
            if (!id)
                return;
            const blob = await services.export.raster(id, {
                type: "image/png"
            });
            if (!blob)
                throw Error("PNG export failed");
            await navigator.clipboard.write([new ClipboardItem({
                    "image/png": blob
                })]);
        },
        destroy() {
            abort.abort();
            memory = null;
        }
    };
}
