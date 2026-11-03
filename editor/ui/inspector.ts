import type { Data, EditorServices, Shape } from "../contracts";
import { moveTree, resizeTree, topLevelIds, isEditable, ancestors } from "../document";
import { rotateShapes, setPathHandle } from "../commands";
import { el, button, input, select, check, section, row, clone, jsonEditor, askName, modal, toast, download } from "./dom";
import type { createTextSession } from "../interaction/text";
import type { createCanvasInteraction } from "../interaction/canvas";
const blends = [
    "normal",
    "multiply",
    "screen",
    "overlay",
    "darken",
    "lighten",
    "color-dodge",
    "color-burn",
    "hard-light",
    "soft-light",
    "difference",
    "exclusion",
    "hue",
    "saturation",
    "color",
    "luminosity"
];
export function createInspector(root: HTMLElement, services: EditorServices, text: ReturnType<typeof createTextSession>, canvas: ReturnType<typeof createCanvasInteraction>, options: Data) {
    const editor = services.editor;
    let destroyed = false, rendering = false, numericSession = false;
    const selected = () => editor.selection.map(id => editor.page.objects[id]).filter((s): s is Shape => !!s);
    const applyChange = (label: string, apply: (doc: Data) => void) => {
        const pageId = editor.pageId;
        const commit = () => {
            if (destroyed || editor.pageId !== pageId)
                return;
            if (text.active || numericSession)
                editor.preview(apply);
            else
                editor.transact(label, apply);
        };
        if (rendering)
            queueMicrotask(commit);
        else
            commit();
    };
    const update = (label: string, mutate: (s: Shape) => void) => {
        const ids = [...editor.selection];
        const apply = (doc: Data) => {
            for (const id of ids) {
                const shape = doc.pagesById[editor.pageId].objects[id];
                if (shape && isEditable(doc.pagesById[editor.pageId], id))
                    mutate(shape);
            }
        };
        applyChange(label, apply);
    };
    const patch = (key: string, value: any) => {
        const ids = [...editor.selection];
        const apply = (doc: Data) => {
            const page = doc.pagesById[editor.pageId];
            for (const id of topLevelIds(page, ids)) {
                const shape = page.objects[id];
                const stateToggle = key === "locked" || key === "hidden";
                const allowed = stateToggle ? !ancestors(page, id).some(parent => parent.locked || parent.hidden) : isEditable(page, id);
                if (!shape || !allowed)
                    continue;
                if (key === "rotation") {
                    rotateShapes(page, [id], value - shape.rotation);
                    continue;
                }
                if (key === "x" || key === "y") {
                    moveTree(page, id, key === "x" ? value - shape.x : 0, key === "y" ? value - shape.y : 0);
                    continue;
                }
                if (key === "width" || key === "height") {
                    const rect = {
                        x: shape.x,
                        y: shape.y,
                        width: shape.width,
                        height: shape.height,
                        [key]: Math.max(0.01, value)
                    };
                    if (shape.constrainProportions) {
                        if (key === "width")
                            rect.height = shape.height * value / shape.width;
                        else
                            rect.width = shape.width * value / shape.height;
                    }
                    resizeTree(page, id, rect);
                    continue;
                }
                if (value === undefined)
                    delete shape[key];
                else
                    shape[key] = clone(value);
            }
        };
        applyChange("Set " + key, apply);
    };
    const value = (key: string, fallback: any = "") => {
        const shapes = selected();
        const values = shapes.map(s => s[key]);
        return values.every(v => JSON.stringify(v) === JSON.stringify(values[0])) ? values[0] ?? fallback : "";
    };
    const num = (label: string, key: string, fallback = 0) => input(label, value(key, fallback), v => patch(key, v), "number");
    const optionalNum = (label: string, key: string) => {
        const wrap = input(label, value(key, ""), () => {
        }, "number"), field = wrap.querySelector("input")!;
        field.onchange = () => {
            try {
                patch(key, field.value === "" ? undefined : Number(field.value));
            }
            catch (error) {
                toast(String(error), "error");
            }
        };
        return wrap;
    };
    const choice = (label: string, key: string, values: string[], fallback = "") => select(label, value(key, fallback), values, v => patch(key, v));
    const toggle = (label: string, key: string) => check(label, value(key), v => patch(key, v));
    const action = (id: string, label: string) => button(label, () => services.commands.run(id), undefined, label);
    async function textStyle(patch: Data) {
        const ids = [...editor.selection];
        if (patch.fontFamily) {
            await services.fonts.ensure?.(ids.map(id => JSON.stringify(editor.page.objects[id]?.content ?? "")).join(""), patch.fontFamily);
            if (JSON.stringify(ids) !== JSON.stringify(editor.selection))
                return;
        }
        if (text.active) {
            text.applyStyle(patch);
            return;
        }
        update("Format text", shape => {
            if (shape.type === "text")
                for (const p of shape.content.children)
                    for (const run of p.children)
                        Object.assign(run, clone(patch));
        });
    }
    function paragraphStyle(patch: Data) {
        if (text.active) {
            text.applyParagraph(patch);
            return;
        }
        update("Format paragraph", shape => {
            if (shape.type === "text")
                for (const p of shape.content.children)
                    Object.assign(p, clone(patch));
        });
    }
    function heading(title: string, add?: () => void) {
        const s = section(title);
        if (add)
            s.querySelector("h3")!.append(button("+", add, "", "Add " + title.toLowerCase()));
        return s;
    }
    function paintPanel(field: "fills" | "strokes") {
        const s = heading(field === "fills" ? "Fill" : "Stroke", () => update("Add " + field, shape => (shape[field] ??= []).push({
            color: "#758fdb",
            opacity: 1,
            ...(field === "strokes" ? {
                width: 1,
                align: "center"
            } : {})
        })));
        const paints = selected()[0]?.[field] ?? [];
        paints.forEach((paint: Data, index: number) => {
            const item = el("div", "paint-row");
            const set = (patch: Data) => update("Edit " + field, shape => {
                if (shape[field]?.[index])
                    Object.assign(shape[field][index], clone(patch));
            });
            const remove = () => update("Remove " + field, shape => shape[field]?.splice(index, 1));
            const mode = paint.gradient ? paint.gradient.type : paint.image ? "image" : "solid";
            const top = el("header");
            top.append(select("Paint", mode, [
                "solid",
                "linear",
                "radial",
                "angular",
                "diamond",
                "image"
            ], mode => {
                if (mode === "solid")
                    set({
                        color: "#758fdb",
                        gradient: undefined,
                        image: undefined
                    });
                else if (mode === "image") {
                    imagePaint(field, index);
                }
                else {
                    set({
                        color: undefined,
                        image: undefined,
                        gradient: {
                            type: mode,
                            x1: 0,
                            y1: 0,
                            x2: 1,
                            y2: 1,
                            aspect: 1,
                            stops: [{
                                    color: "#96b9fc",
                                    offset: 0
                                }, {
                                    color: "#b3a6e6",
                                    offset: 1
                                }]
                        }
                    });
                    canvas.editGradient(selected()[0].id, field, index);
                }
            }), button(paint.hidden ? "\u25CB" : "\u25C9", () => set({
                hidden: !paint.hidden
            }), "", "Toggle paint visibility"), button("\u2212", remove, "", "Remove paint"));
            item.append(top);
            item.append(row(button("\u2191", () => update("Reorder paint", shape => {
                if (index > 0) {
                    const paints = shape[field];
                    [paints[index - 1], paints[index]] = [paints[index], paints[index - 1]];
                }
            }), "", "Move paint up"), button("\u2193", () => update("Reorder paint", shape => {
                const paints = shape[field];
                if (index < paints.length - 1)
                    [paints[index], paints[index + 1]] = [paints[index + 1], paints[index]];
            }), "", "Move paint down")));
            if (mode === "solid" && "EyeDropper" in window)
                item.append(button("Eyedropper", async () => {
                    try {
                        const result = await new (window as any).EyeDropper().open();
                        set({
                            color: result.sRGBHex
                        });
                    }
                    catch (error) {
                        if ((error as DOMException).name !== "AbortError")
                            throw error;
                    }
                }));
            if (mode === "solid")
                item.append(row(input("Color", paint.color ?? "#000000", v => set({
                    color: v
                }), "color"), input("Color value", paint.color ?? "#000000", v => set({
                    color: v
                }))), row(input("Opacity", paint.opacity ?? 1, v => set({
                    opacity: Math.max(0, Math.min(1, v))
                }), "number")));
            if (paint.gradient) {
                const gradient = paint.gradient;
                const setGradient = (patch: Data) => set({
                    gradient: {
                        ...gradient,
                        ...patch
                    }
                });
                item.append(row(input("Aspect", gradient.aspect ?? 1, v => setGradient({
                    aspect: v
                }), "number"), button("Handles", () => canvas.editGradient(selected()[0].id, field, index))));
                gradient.stops?.forEach((stop: Data, i: number) => item.append(row(input("Stop", stop.offset, v => {
                    const stops = clone(gradient.stops);
                    stops[i].offset = v;
                    setGradient({
                        stops
                    });
                }, "number"), input("Color", stop.color, v => {
                    const stops = clone(gradient.stops);
                    stops[i].color = v;
                    setGradient({
                        stops
                    });
                }, "color"), input("Alpha", stop.opacity ?? 1, v => {
                    const stops = clone(gradient.stops);
                    stops[i].opacity = v;
                    setGradient({
                        stops
                    });
                }, "number"), button("\u2212", () => {
                    const stops = clone(gradient.stops);
                    if (stops.length > 2) {
                        stops.splice(i, 1);
                        setGradient({
                            stops
                        });
                    }
                }, "", "Remove stop"))));
                item.append(row(button("Flip", () => setGradient({
                    x1: gradient.x2,
                    y1: gradient.y2,
                    x2: gradient.x1,
                    y2: gradient.y1
                })), button("Rotate 90\u00B0", () => setGradient({
                    x1: 1 - gradient.y1,
                    y1: gradient.x1,
                    x2: 1 - gradient.y2,
                    y2: gradient.x2
                }))));
                item.append(button("+ Stop", () => {
                    if (gradient.stops.length >= 16)
                        throw Error("A gradient supports up to 16 stops");
                    return setGradient({
                        stops: [...gradient.stops, {
                                color: "#ffffff",
                                offset: 0.5
                            }].sort((a, b) => a.offset - b.offset)
                    });
                }));
                for (const pair of [["x1", "y1"], ["x2", "y2"]])
                    item.append(row(...pair.map(key => input(key, gradient[key], v => setGradient({
                        [key]: v
                    }), "number"))));
            }
            if (paint.image) {
                item.append(select("Scale", paint.image.scaleMode ?? "fill", ["fill", "fit", "crop", "tile"], v => set({
                    image: {
                        ...paint.image,
                        scaleMode: v
                    }
                })), input("Tile scale", paint.image.tileScale ?? 1, v => set({
                    image: {
                        ...paint.image,
                        tileScale: v
                    }
                }), "number"), button("Replace image", () => imagePaint(field, index)), button("Crop & adjustments", () => jsonEditor("Image paint", {
                    crop: paint.image.crop ?? {
                        x: 0,
                        y: 0,
                        width: 1,
                        height: 1
                    },
                    adjust: paint.image.adjust ?? {}
                }, v => set({
                    image: {
                        ...paint.image,
                        ...v
                    }
                }))));
            }
            if (field === "strokes") {
                item.append(row(input("Width", paint.width ?? 1, v => set({
                    width: v
                }), "number"), select("Align", paint.align ?? "center", ["inside", "center", "outside"], v => set({
                    align: v
                }))), row(select("Cap", paint.cap ?? "butt", ["butt", "round", "square"], v => set({
                    cap: v
                })), select("Join", paint.join ?? "miter", ["miter", "round", "bevel"], v => set({
                    join: v
                }))), row(select("Start", paint.startCap ?? "none", [
                    "none",
                    "arrow",
                    "triangle",
                    "circle",
                    "diamond",
                    "square"
                ], v => set({
                    startCap: v
                })), select("End", paint.endCap ?? "none", [
                    "none",
                    "arrow",
                    "triangle",
                    "circle",
                    "diamond",
                    "square"
                ], v => set({
                    endCap: v
                }))), row(select("Style", paint.style ?? "solid", ["solid", "dashed", "dotted"], v => set({
                    style: v
                })), input("Dashes", (paint.dashes ?? []).join(","), v => {
                    const dashes = v.split(",").filter(Boolean).map(Number);
                    if (dashes.some((n: number) => !Number.isFinite(n) || n < 0))
                        throw Error("Dashes must be positive numbers");
                    set({
                        dashes
                    });
                })));
            }
            s.append(item);
        });
        s.append(button("Apply style", () => stylePicker(field)), button("Create style", () => saveStyle("paint", field)));
        return s;
    }
    function imagePaint(field: string, index: number) {
        const picker = el("input");
        picker.type = "file";
        picker.accept = "image/*";
        picker.onchange = async () => {
            const file = picker.files?.[0];
            if (!file)
                return;
            const url = await new Promise<string>((resolve, reject) => {
                const r = new FileReader();
                r.onload = () => resolve(String(r.result));
                r.onerror = () => reject(r.error);
                r.readAsDataURL(file);
            });
            const image = new Image();
            image.src = url;
            await image.decode();
            update("Set image paint", shape => {
                shape[field][index] = {
                    ...shape[field][index],
                    color: undefined,
                    gradient: undefined,
                    image: {
                        id: url,
                        src: url,
                        width: image.naturalWidth,
                        height: image.naturalHeight,
                        mimeType: file.type,
                        scaleMode: "fill"
                    }
                };
            });
        };
        picker.click();
    }
    function stylePicker(kind: string) {
        modal("Apply style", (body, close) => {
            const styles = services.styles.list?.() ?? Object.values(editor.doc.styles ?? {});
            for (const style of styles) {
                if ((kind === "text" && style.type !== "text") || (kind === "effects" && style.type !== "effect") || (["fills", "strokes"].includes(kind) && style.type !== "paint"))
                    continue;
                body.append(button(style.name, async () => {
                    if (style.type === "text")
                        await services.fonts.ensure?.(JSON.stringify(selected().map(s => s.content)), style.text?.fontFamily);
                    if (text.active && kind === "fills") {
                        text.applyStyle({
                            fills: clone(style.paints),
                            fillStyleId: style.id
                        });
                    }
                    else if (text.active && kind === "text") {
                        const fields = Object.fromEntries([
                            "fontFamily",
                            "fontSize",
                            "fontWeight",
                            "fontStyle",
                            "letterSpacing",
                            "textDecoration",
                            "textDecorationStyle",
                            "textDecorationThickness",
                            "textTransform"
                        ].filter(key => style.text?.[key] !== undefined).map(key => [key, style.text[key]]));
                        text.applyStyle({
                            ...fields,
                            textStyleId: style.id
                        });
                        if (style.text?.lineHeight)
                            text.applyParagraph({
                                lineHeight: style.text.lineHeight
                            });
                    }
                    else {
                        const apply = () => services.styles.apply(style.id, editor.selection.filter(id => isEditable(editor.page, id)), ({
                            fills: "fill",
                            strokes: "stroke",
                            effects: "effect"
                        } as Record<string, string>)[kind] ?? kind);
                        if (text.active)
                            editor.preview(apply);
                        else
                            apply();
                    }
                    close();
                }));
            }
            body.append(button("Detach style", () => {
                const detach = () => services.styles.detach(editor.selection.filter(id => isEditable(editor.page, id)), ({
                    fills: "fill",
                    strokes: "stroke",
                    effects: "effect"
                } as Record<string, string>)[kind] ?? kind);
                if (text.active)
                    editor.preview(detach);
                else
                    detach();
                close();
            }));
        });
    }
    async function saveStyle(type: string, field?: string) {
        await text.exit(true);
        askName("Create " + type + " style", "Style", name => {
            const s = selected()[0];
            let data: any = field ? s[field] : type === "text" ? s.content?.children?.[0]?.children?.[0] : {
                shadows: s.shadows,
                blur: s.blur,
                backgroundBlur: s.backgroundBlur
            };
            if (type === "text")
                data = {
                    ...data,
                    lineHeight: s.content?.children?.[0]?.lineHeight ?? 24
                };
            services.styles.create(type, name, clone(data));
        });
    }
    function typography() {
        const s = heading("Typography");
        const shapes = selected().filter(s => s.type === "text");
        const first = shapes[0]?.content?.children?.[0]?.children?.[0] ?? {};
        const paragraphValue = (key: string, defaultValue: any = "") => {
            if (text.active)
                return text.selectionParagraphStyle()[key] ?? defaultValue;
            const values = shapes.flatMap(shape => shape.content.children.map((paragraph: Data) => paragraph[key]));
            return values.every(value => JSON.stringify(value) === JSON.stringify(values[0])) ? values[0] ?? defaultValue : "";
        };
        const get = (key: string, defaultValue: any = "") => {
            if (text.active)
                return text.selectionStyle()[key] ?? defaultValue;
            const values = shapes.flatMap(s => s.content.children.flatMap((p: Data) => p.children.map((r: Data) => r[key])));
            return values.every((v: any) => v === values[0]) ? values[0] ?? defaultValue : "";
        };
        s.append(button(get("fontFamily", "Choose font") || "Mixed fonts", fontPicker, "font-button", "Choose font family"), row(input("Size", get("fontSize", 16), v => textStyle({
            fontSize: v
        }), "number"), input("Weight", get("fontWeight", 400), v => textStyle({
            fontWeight: v
        }), "number")), row(select("Style", get("fontStyle", "normal"), ["normal", "italic"], v => textStyle({
            fontStyle: v
        })), select("Case", get("textTransform", "none"), ["none", "uppercase", "lowercase", "capitalize", "smallCaps"], v => textStyle({
            textTransform: v
        }))), row(input("Letter", get("letterSpacing", 0), v => textStyle({
            letterSpacing: v
        }), "number"), input("Line", paragraphValue("lineHeight", 24), v => paragraphStyle({
            lineHeight: v
        }), "number")), row(select("Align", paragraphValue("textAlign", "left"), ["left", "center", "right", "justify"], v => paragraphStyle({
            textAlign: v
        })), select("Vertical", shapes[0].content.verticalAlign ?? "top", ["top", "center", "bottom"], v => update("Text vertical alignment", s => {
            if (s.type === "text")
                s.content.verticalAlign = v;
        }))), row(select("Decoration", get("textDecoration", "none"), ["none", "underline", "line-through"], v => textStyle({
            textDecoration: v
        })), select("Line style", get("textDecorationStyle", "solid"), ["solid", "dotted", "wavy", "double", "dashed"], v => textStyle({
            textDecorationStyle: v
        }))), row(input("Thickness", get("textDecorationThickness", 1), v => textStyle({
            textDecorationThickness: v
        }), "number"), input("Text color", first.fills?.[0]?.color ?? "#252b37", v => textStyle({
            fills: [{
                    color: v
                }]
        }), "color")), row(input("Paragraph", paragraphValue("paragraphSpacing", 0), v => paragraphStyle({
            paragraphSpacing: v
        }), "number"), input("Indent", paragraphValue("paragraphIndent", 0), v => paragraphStyle({
            paragraphIndent: v
        }), "number")), row(select("List", paragraphValue("listType", "none"), ["none", "bullet", "ordered"], v => paragraphStyle({
            listType: v === "none" ? undefined : v
        })), input("Level", paragraphValue("listLevel", 0), v => paragraphStyle({
            listLevel: v
        }), "number")), row(choice("Resize", "autoResize", ["none", "widthAndHeight", "height"], "none")), row(toggle("Truncate", "truncate"), num("Max lines", "maxLines", 1)), row(choice("Leading trim", "leadingTrim", ["none", "capHeight"], "none")), button("Highlight", () => modal("Text highlight", (body, close) => body.append(input("Color", first.highlight?.color ?? "#fff2a8", v => textStyle({
            highlight: {
                color: v
            }
        }), "color"), button("Remove", () => {
            textStyle({
                highlight: undefined
            });
            close();
        })))), button("Text background", () => jsonEditor("Text background", shapes[0].textBackground ?? {
            fills: [{
                    color: "#ffffff"
                }],
            padding: 4,
            radius: 0
        }, v => patch("textBackground", v))), button("Apply text style", () => stylePicker("text")), button("Create text style", () => saveStyle("text")));
        return s;
    }
    const recentFonts: string[] = [];
    function fontPicker() {
        modal("Choose font", (body, close) => {
            const search = el("input", "assets-search");
            search.placeholder = "Search fonts";
            search.setAttribute("aria-label", "Search fonts");
            const sample = el("input", "assets-search");
            sample.value = "Aa \uD55C\uAE00 123";
            sample.setAttribute("aria-label", "Font preview text");
            const results = el("div", "font-results");
            const choose = async (family: string, face?: Data) => {
                await textStyle({
                    fontFamily: family,
                    ...(face ? {
                        fontWeight: face.weight,
                        fontStyle: face.style
                    } : {})
                });
                recentFonts.splice(0, recentFonts.length, ...[family, ...recentFonts.filter(name => name !== family)].slice(0, 8));
                close();
            };
            const render = () => {
                results.replaceChildren();
                const catalog = services.fonts.catalog().filter(font => `${font.family} ${font.label ?? ""}`.toLowerCase().includes(search.value.toLowerCase()));
                catalog.sort((a, b) => {
                    const ai = recentFonts.indexOf(a.family), bi = recentFonts.indexOf(b.family);
                    return (ai < 0 ? 1000 : ai) - (bi < 0 ? 1000 : bi);
                });
                for (const font of catalog) {
                    const item = el("div");
                    const b = button(`${font.label ?? font.family} — ${sample.value}`, () => choose(font.family));
                    b.style.fontFamily = font.family;
                    b.style.width = "100%";
                    item.append(b);
                    if (font.faces?.length)
                        item.append(select("Face", "", [{
                                value: "",
                                label: "Choose weight / style"
                            }, ...font.faces.map((face: Data, index: number) => ({
                                value: String(index),
                                label: `${face.weight} ${face.style}`
                            }))], value => value !== "" ? choose(font.family, font.faces[Number(value)]) : undefined));
                    if (recentFonts.includes(font.family))
                        item.append(el("small", "muted", "Recent"));
                    results.append(item);
                }
            };
            search.oninput = render;
            sample.oninput = render;
            body.append(search, sample, results);
            render();
            search.focus();
        });
    }
    function layoutPanel() {
        const s = heading("Layout");
        const shape = selected()[0], layout = shape.layout;
        const set = (patch: Data) => update("Edit layout", s => {
            s.layout = {
                ...s.layout,
                ...clone(patch)
            };
        });
        const padding = layout?.padding ?? {
            top: 0,
            right: 0,
            bottom: 0,
            left: 0
        }, gap = layout?.gap ?? {
            row: 0,
            column: 0
        };
        s.append(select("Layout", layout?.type ?? "none", ["none", "flex", "grid"], type => patch("layout", type === "none" ? undefined : type === "flex" ? {
            type,
            direction: "row",
            wrap: false,
            justifyContent: "start",
            alignItems: "start",
            gap: {
                row: 16,
                column: 16
            },
            padding: {
                top: 0,
                right: 0,
                bottom: 0,
                left: 0
            }
        } : {
            type,
            rows: [{
                    type: "auto"
                }],
            columns: [{
                    type: "auto"
                }, {
                    type: "auto"
                }],
            gap: {
                row: 16,
                column: 16
            },
            padding: {
                top: 0,
                right: 0,
                bottom: 0,
                left: 0
            }
        })));
        if (layout) {
            if (layout.type === "flex")
                s.append(row(select("Direction", layout.direction, ["row", "row-reverse", "column", "column-reverse"], v => set({
                    direction: v
                })), check("Wrap", layout.wrap, v => set({
                    wrap: v
                }))), row(select("Distribute", layout.justifyContent, [
                    "start",
                    "center",
                    "end",
                    "space-between",
                    "space-around",
                    "space-evenly"
                ], v => set({
                    justifyContent: v
                }))), row(select("Align", layout.alignItems, ["start", "center", "end", "stretch", "baseline"], v => set({
                    alignItems: v
                })), select("Lines", layout.alignContent ?? "start", [
                    "start",
                    "center",
                    "end",
                    "space-between",
                    "space-around",
                    "space-evenly",
                    "stretch"
                ], v => set({
                    alignContent: v
                }))));
            if (layout.type === "grid") {
                for (const axis of ["columns", "rows"]) {
                    s.append(input(axis, layout[axis].map((t: Data) => t.type === "auto" ? "auto" : t.size).join(" "), v => {
                        const tracks = v.trim().split(/\s+/).map((n: string) => n === "auto" ? {
                            type: "auto"
                        } : {
                            type: "fixed",
                            size: Number(n)
                        });
                        if (tracks.some((t: Data) => t.type === "fixed" && (!Number.isFinite(t.size) || t.size < 0)))
                            throw Error("Use auto or positive track sizes");
                        set({
                            [axis]: tracks
                        });
                    }));
                }
            }
            s.append(row(input("Row gap", gap.row, v => set({
                gap: {
                    ...gap,
                    row: v
                }
            }), "number"), input("Column gap", gap.column, v => set({
                gap: {
                    ...gap,
                    column: v
                }
            }), "number")));
            for (const keys of [["top", "right"], ["bottom", "left"]])
                s.append(row(...keys.map(key => input("Pad " + key, padding[key], v => set({
                    padding: {
                        ...padding,
                        [key]: v
                    }
                }), "number"))));
        }
        s.append(row(choice("Width", "hSizing", ["fixed", "hug", "fill"], "fixed"), choice("Height", "vSizing", ["fixed", "hug", "fill"], "fixed")), row(optionalNum("Min W", "minWidth"), optionalNum("Max W", "maxWidth")), row(optionalNum("Min H", "minHeight"), optionalNum("Max H", "maxHeight")), toggle("Absolute position", "absolute"));
        return s;
    }
    function effectsPanel() {
        const s = heading("Effects", () => update("Add shadow", shape => (shape.shadows ??= []).push({
            style: "drop",
            offsetX: 0,
            offsetY: 4,
            blur: 12,
            spread: 0,
            color: "#18233b",
            opacity: 0.2
        })));
        const shadows = selected()[0].shadows ?? [];
        shadows.forEach((shadow: Data, i: number) => {
            const item = el("div", "effect-row");
            const set = (patch: Data) => update("Edit shadow", shape => Object.assign(shape.shadows[i], patch));
            item.append(row(select("Shadow", shadow.style, ["drop", "inner"], v => set({
                style: v
            })), button(shadow.hidden ? "\u25CB" : "\u25C9", () => set({
                hidden: !shadow.hidden
            })), button("\u2212", () => update("Remove shadow", shape => shape.shadows.splice(i, 1)))));
            for (const keys of [["offsetX", "offsetY"], ["blur", "spread"]])
                item.append(row(...keys.map(key => input(key, shadow[key], v => set({
                    [key]: v
                }), "number"))));
            item.append(row(input("Color", shadow.color, v => set({
                color: v
            }), "color"), input("Opacity", shadow.opacity ?? 1, v => set({
                opacity: v
            }), "number")));
            item.append(row(button("\u2191", () => update("Reorder shadow", s => {
                if (i > 0)
                    [s.shadows[i - 1], s.shadows[i]] = [s.shadows[i], s.shadows[i - 1]];
            }), "", "Move shadow up"), button("\u2193", () => update("Reorder shadow", s => {
                if (i < s.shadows.length - 1)
                    [s.shadows[i], s.shadows[i + 1]] = [s.shadows[i + 1], s.shadows[i]];
            }), "", "Move shadow down")));
            s.append(item);
        });
        s.append(row(num("Blur", "blur"), num("Background", "backgroundBlur")), row(toggle("Hide blur", "blurHidden"), toggle("Hide backdrop blur", "backgroundBlurHidden")), button("Apply effect style", () => stylePicker("effects")), button("Create effect style", () => saveStyle("effect")));
        return s;
    }
    function componentPanel() {
        const shape = selected()[0];
        const s = heading("Component");
        const component = editor.doc.components?.[shape.componentId ?? ""];
        const run = async (action: string, args: Data = {}) => {
            try {
                await text.exit(true);
                const result = services.components.run(action, {
                    ids: editor.selection,
                    id: shape.id,
                    ...args
                });
                if (result?.pageId && result.pageId !== editor.pageId)
                    editor.setPage(result.pageId);
                if (result?.selection)
                    editor.setSelection(result.selection);
                return true;
            }
            catch (error) {
                toast(String(error), "error");
                return false;
            }
        };
        if (!component) {
            s.append(button("Create component", () => askName("Create component", shape.name ?? "Component", name => run("create", {
                name
            }))), button("Combine as variants", () => run("combine")));
            return s;
        }
        s.append(el("p", "muted", component.path ? `${component.path} / ${component.name}` : component.name));
        if (shape.isInstanceRoot && !shape.isMain) {
            s.append(row(button("Reset", () => run("reset"), "", "Reset all changes"), button("Detach", () => run("detach"))));
            const variants = Object.values(editor.doc.components ?? {}).filter((c: any) => c.variantSetId === component.variantSetId && component.variantSetId);
            if (variants.length)
                s.append(select("Variant", component.id, variants.map((c: any) => ({
                    value: c.id,
                    label: (c.variantProperties ?? []).map((p: Data) => `${p.name}=${p.value}`).join(", ") || c.name
                })), v => run("variant", {
                    value: v,
                    variantId: v,
                    source: v
                })));
            for (const property of component.properties ?? []) {
                const value = shape.componentProperties?.[property.id] ?? shape.propertyValues?.[property.id] ?? property.default;
                if (property.type === "boolean")
                    s.append(check(property.name, value === true || value === "true", v => run("set_property", {
                        property: property.id,
                        propertyId: property.id,
                        value: String(v)
                    })));
                else
                    s.append(input(property.name, value, v => run("set_property", {
                        property: property.id,
                        propertyId: property.id,
                        value: v
                    })));
            }
        }
        else {
            s.append(button("Add variant", () => run("add_variant"), "", "Add variant"), button("Edit axes", () => jsonEditor("Variant axes", component.variantProperties ?? [], v => editor.transact("Edit variant axes", doc => {
                doc.components![component.id].variantProperties = v;
            }))), button("Add property", () => modal("Component property", (body, close) => {
                let name = "Property", type = "text", defaultValue = "";
                const defaultField = input("Default", defaultValue, v => defaultValue = v);
                body.append(input("Name", name, v => name = v), select("Type", type, ["text", "boolean", "swap"], v => {
                    type = v;
                    defaultValue = type === "boolean" ? "true" : "";
                    defaultField.querySelector("input")!.value = defaultValue;
                }), defaultField, button("Create", async () => {
                    if (await run("property", {
                        name,
                        propertyType: type,
                        value: defaultValue
                    }))
                        close();
                }, "primary"));
            })));
            for (const property of component.properties ?? []) {
                s.append(row(button(property.name, () => modal("Edit property", (body, close) => {
                    let name = property.name, defaultValue = String(property.default);
                    body.append(input("Name", name, v => name = v), input("Default", defaultValue, v => defaultValue = v), button("Save", () => {
                        run("edit_property", {
                            property: property.id,
                            propertyId: property.id,
                            name,
                            value: defaultValue
                        });
                        close();
                    }), button("Remove", () => {
                        run("remove_property", {
                            property: property.id,
                            propertyId: property.id
                        });
                        close();
                    }));
                })), button("Bind", () => modal("Bind property", (body, close) => {
                    const descendants = Object.values(editor.page.objects).filter(s => s.id !== shape.id);
                    for (const layer of descendants)
                        body.append(button(layer.name ?? layer.type, () => {
                            run("bind", {
                                property: property.id,
                                propertyId: property.id,
                                propertyType: property.type,
                                layer: layer.id
                            });
                            close();
                        }));
                }))));
            }
        }
        return s;
    }
    function imagePanel() {
        const s = heading("Image");
        const shape = selected()[0];
        s.append(choice("Fit", "objectFit", ["fill", "contain", "cover"], "cover"), button("Crop", () => jsonEditor("Image crop", shape.crop ?? {
            x: 0,
            y: 0,
            width: 1,
            height: 1
        }, v => patch("crop", v))));
        for (const key of [
            "exposure",
            "contrast",
            "saturation",
            "temperature",
            "tint",
            "highlights",
            "shadows"
        ])
            s.append(input(key, shape.adjust?.[key] ?? 0, v => update("Adjust image", s => {
                s.adjust = {
                    ...s.adjust,
                    [key]: Math.max(-1, Math.min(1, v))
                };
            }), "number"));
        return s;
    }
    async function exportLayer(id: string, setting: Data) {
        const shape = editor.page.objects[id];
        if (!shape)
            throw Error("Layer no longer exists");
        const type = setting.format;
        let blob: Blob | null = null;
        if (type === "svg")
            blob = new Blob([await services.export.svg([id])], {
                type: "image/svg+xml"
            });
        else if (type === "pdf")
            blob = await services.export.pdf(id);
        else {
            const constraint = setting.constraint ?? {
                type: "scale",
                value: 1
            };
            const scale = Math.max(0.01, Math.min(4, constraint.type === "width" ? constraint.value / shape.width : constraint.type === "height" ? constraint.value / shape.height : constraint.value));
            blob = await services.export.raster(id, {
                scale,
                type: type === "jpg" ? "image/jpeg" : `image/${type}`,
                background: setting.background,
                omitFill: shape.omitFillOnExport
            });
        }
        if (!blob)
            throw Error("Export produced no output");
        const name = (shape.name ?? shape.type).replace(/[\\/:*?"<>|]/g, "_") + (setting.suffix ?? "") + "." + type;
        const save = options.exportFile ?? services.export.saveFile;
        if (save) {
            const result = await save(blob, name);
            if (result === false || result?.canceled)
                return;
        }
        else
            download(blob, name);
    }
    function exportPanel() {
        const s = heading("Export", () => update("Add export setting", s => (s.exportSettings ??= []).push({
            format: "png",
            constraint: {
                type: "scale",
                value: 1
            },
            suffix: ""
        })));
        const settings = selected()[0].exportSettings ?? [];
        settings.forEach((setting: Data, index: number) => {
            const item = el("div", "export-row");
            const set = (patch: Data) => update("Edit export setting", s => Object.assign(s.exportSettings[index], patch));
            item.append(row(select("Format", setting.format, ["png", "jpg", "webp", "svg", "pdf"], v => set({
                format: v
            })), button("\u2212", () => update("Remove export setting", s => s.exportSettings.splice(index, 1)))));
            item.append(select("Preset", "", [
                "",
                "0.5x",
                "0.75x",
                "1x",
                "1.5x",
                "2x",
                "3x",
                "4x",
                "512w",
                "512h"
            ], v => {
                if (!v)
                    return;
                set({
                    constraint: {
                        type: v.endsWith("w") ? "width" : v.endsWith("h") ? "height" : "scale",
                        value: parseFloat(v)
                    }
                });
            }));
            item.append(row(select("Size", setting.constraint?.type ?? "scale", ["scale", "width", "height"], v => set({
                constraint: {
                    ...setting.constraint,
                    type: v
                }
            })), input("Value", setting.constraint?.value ?? 1, v => {
                if (v <= 0)
                    throw Error("Export size must be positive");
                set({
                    constraint: {
                        ...setting.constraint,
                        value: v
                    }
                });
            }, "number")), input("Suffix", setting.suffix ?? "", v => set({
                suffix: v
            })), button("Export", async () => {
                for (const shape of selected())
                    await exportLayer(shape.id, setting);
            }));
            s.append(item);
        });
        if (!settings.length)
            s.append(el("p", "muted", "Add an export setting to save selected layers."));
        else
            s.append(button("Export all", async () => {
                for (const shape of selected())
                    for (const setting of shape.exportSettings ?? [])
                        await exportLayer(shape.id, setting);
            }));
        return s;
    }
    function guidePanel(shape?: Shape) {
        const guides = shape?.guides ?? editor.page.guides ?? [];
        const mutate = (label: string, fn: (guides: Data[]) => void) => {
            const apply = (doc: Data) => {
                const page = doc.pagesById[editor.pageId];
                if (shape && !isEditable(page, shape.id))
                    return;
                const owner = shape ? page.objects[shape.id] : page;
                fn(owner.guides ??= []);
            };
            if (text.active)
                editor.preview(apply);
            else
                editor.transact(label, apply);
        };
        const panel = heading(shape ? "Frame guides" : "Guides", () => mutate("Add guide", guides => guides.push({
            axis: "x",
            position: 0
        })));
        guides.forEach((guide: Data, index: number) => panel.append(row(select("Axis", guide.axis, ["x", "y"], v => mutate("Edit guide", g => g[index].axis = v)), input("Position", guide.position, v => mutate("Edit guide", g => g[index].position = v), "number"), button("\u2212", () => mutate("Delete guide", g => g.splice(index, 1))))));
        return panel;
    }
    function gridPanel(shape: Shape) {
        const panel = heading("Layout grids", () => update("Add layout grid", s => (s.layoutGrids ??= []).push({
            pattern: "grid",
            size: 8,
            color: "#6388de",
            opacity: 0.1
        })));
        for (const [index, grid] of (shape.layoutGrids ?? []).entries()) {
            const item = el("div", "paint-row"), set = (patch: Data) => update("Edit layout grid", s => Object.assign(s.layoutGrids[index], patch));
            item.append(row(select("Pattern", grid.pattern, ["grid", "columns", "rows"], v => set({
                pattern: v
            })), button(grid.hidden ? "\u25CB" : "\u25C9", () => set({
                hidden: !grid.hidden
            }), "", "Toggle grid visibility"), button("\u2212", () => update("Remove layout grid", s => s.layoutGrids.splice(index, 1)))));
            item.append(row(input("Size", grid.size ?? 8, v => set({
                size: Math.max(1, v)
            }), "number"), input("Opacity", grid.opacity ?? 0.1, v => set({
                opacity: Math.max(0, Math.min(1, v))
            }), "number")), input("Color", grid.color ?? "#6388de", v => set({
                color: v
            }), "color"));
            if (grid.pattern !== "grid")
                item.append(row(input("Count", grid.count ?? 5, v => set({
                    count: Math.max(1, Math.round(v))
                }), "number"), input("Gutter", grid.gutter ?? 16, v => set({
                    gutter: v
                }), "number")), row(select("Align", grid.align ?? "stretch", ["stretch", "start", "center", "end"], v => set({
                    align: v
                })), input("Offset", grid.offset ?? 0, v => set({
                    offset: v
                }), "number")));
            panel.append(item);
        }
        return panel;
    }
    function refresh() {
        if (destroyed || rendering)
            return;
        const active = document.activeElement instanceof HTMLInputElement || document.activeElement instanceof HTMLSelectElement || document.activeElement instanceof HTMLTextAreaElement ? document.activeElement : null;
        const restoreFocus = active && root.contains(active) ? {
            label: active.getAttribute("aria-label"),
            value: active.value,
            start: active instanceof HTMLInputElement ? active.selectionStart : null,
            end: active instanceof HTMLInputElement ? active.selectionEnd : null
        } : null;
        const focusField = () => {
            if (!restoreFocus?.label)
                return;
            const field = root.querySelector<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(`[aria-label="${CSS.escape(restoreFocus.label)}"]`);
            if (!field)
                return;
            field.value = restoreFocus.value;
            field.focus({
                preventScroll: true
            });
            if (field instanceof HTMLInputElement && restoreFocus.start !== null) {
                try {
                    field.setSelectionRange(restoreFocus.start, restoreFocus.end);
                }
                catch {
                }
            }
        };
        rendering = true;
        root.replaceChildren();
        const design = el("div", "design");
        root.append(design);
        const shapes = selected();
        if (!shapes.length) {
            const s = section("Page");
            s.append(input("Name", editor.page.name ?? "Page", v => editor.transact("Rename page", doc => {
                doc.pagesById[editor.pageId].name = v;
            })), check("Rulers", editor.showRulers, v => {
                editor.showRulers = v;
                canvas.render();
                refresh();
            }), check("Pixel snapping", editor.pixelSnap, v => {
                editor.pixelSnap = v;
            }), check("Smart guides", editor.snapping !== false, v => {
                editor.snapping = v;
            }), button("Edit guides", () => jsonEditor("Page guides", editor.page.guides ?? [], v => editor.transact("Edit guides", doc => {
                doc.pagesById[editor.pageId].guides = v;
            }))), button("Fit canvas", () => canvas.fit([])));
            design.append(s, guidePanel(), el("div", "empty-state", "Select a layer to edit its design properties."));
            focusField();
            rendering = false;
            return;
        }
        const shape = shapes[0];
        const top = section(shapes.length === 1 ? shape.type[0].toUpperCase() + shape.type.slice(1) : `${shapes.length} layers`);
        top.append(input("Name", value("name"), v => patch("name", v)), row(num("X", "x"), num("Y", "y")), row(num("W", "width"), num("H", "height")), row(num("Rotate", "rotation"), toggle("Proportions", "constrainProportions")), row(toggle("Hidden", "hidden"), toggle("Locked", "locked")));
        const align = el("div", "inspector-actions");
        for (const [id, label] of [
            ["left", "\u21E4"],
            ["h-center", "\u2194"],
            ["right", "\u21E5"],
            ["top", "\u21A5"],
            ["v-center", "\u2195"],
            ["bottom", "\u21A7"]
        ])
            align.append(action("align." + id, label));
        top.append(align, row(action("distribute.h", "Distribute \u2194"), action("distribute.v", "Distribute \u2195")), row(action("transform.flip-h", "Flip \u2194"), action("transform.flip-v", "Flip \u2195")));
        design.append(top);
        const appearance = section("Appearance");
        appearance.append(row(num("Opacity", "opacity", 1), choice("Blend", "blendMode", blends, "normal")));
        for (const keys of [["radiusTopLeft", "radiusTopRight"], ["radiusBottomLeft", "radiusBottomRight"]])
            appearance.append(row(...keys.map(key => num(key.replace("radius", "R "), key))));
        appearance.append(num("Smoothing", "cornerSmoothing"));
        appearance.append(button("Clip rectangle", () => jsonEditor("Clip rectangle", shape.clip ?? {
            x: 0,
            y: 0,
            width: shape.width,
            height: shape.height,
            radius: 0
        }, value => patch("clip", value))));
        if (shape.clip)
            appearance.append(button("Remove clip rectangle", () => patch("clip", undefined)));
        design.append(appearance);
        if (shapes.some(s => s.type === "text"))
            design.append(typography());
        if (shape.type === "image" || shape.type === "svg")
            design.append(imagePanel());
        design.append(paintPanel("fills"), paintPanel("strokes"));
        const sides = section("Stroke sides");
        for (const keys of [["top", "right"], ["bottom", "left"]])
            sides.append(row(...keys.map(key => input(key, shape.strokeSides?.[key] ?? 1, v => update("Edit stroke sides", s => {
                s.strokeSides = {
                    ...s.strokeSides,
                    [key]: v
                };
            }), "number"))));
        design.append(sides, effectsPanel());
        if (shape.childIds || shape.parentId !== "root")
            design.append(layoutPanel());
        const constraints = section("Constraints");
        constraints.append(choice("Horizontal", "horizontalConstraint", ["left", "right", "leftAndRight", "center", "scale"], "left"), choice("Vertical", "verticalConstraint", ["top", "bottom", "topAndBottom", "center", "scale"], "top"));
        if (editor.page.objects[shape.parentId]?.layout?.type === "grid")
            constraints.append(button("Grid cell", () => jsonEditor("Grid cell", shape.gridCell ?? {
                row: 1,
                column: 1,
                rowSpan: 1,
                columnSpan: 1,
                hAlign: "start",
                vAlign: "start"
            }, v => patch("gridCell", v))));
        if (editor.page.objects[shape.parentId]?.layout?.type === "grid") {
            const cell = shape.gridCell ?? {}, set = (key: string, v: any) => patch("gridCell", {
                ...cell,
                [key]: v
            });
            constraints.append(row(input("Row", cell.row ?? 1, v => set("row", v), "number"), input("Column", cell.column ?? 1, v => set("column", v), "number")), row(input("Row span", cell.rowSpan ?? 1, v => set("rowSpan", v), "number"), input("Column span", cell.columnSpan ?? 1, v => set("columnSpan", v), "number")), row(select("H align", cell.hAlign ?? "start", ["start", "center", "end"], v => set("hAlign", v)), select("V align", cell.vAlign ?? "start", ["start", "center", "end"], v => set("vAlign", v))));
        }
        design.append(constraints);
        if (shape.type === "frame") {
            const frame = section("Frame");
            frame.append(toggle("Clip content", "clipContent"), toggle("Omit fill on export", "omitFillOnExport"), button("Layout grids", () => jsonEditor("Layout grids", shape.layoutGrids ?? [{
                    pattern: "grid",
                    size: 8,
                    color: "#6c8bdf",
                    opacity: 0.1
                }], v => patch("layoutGrids", v))), button("Frame guides", () => jsonEditor("Frame guides", shape.guides ?? [], v => patch("guides", v))));
            design.append(frame, gridPanel(shape), guidePanel(shape));
        }
        if (shape.type === "group") {
            const mask = section("Mask");
            mask.append(toggle("Use as mask", "isMaskGroup"), choice("Type", "maskType", ["alpha", "vector", "luminance"], "alpha"));
            design.append(mask);
        }
        if (shape.type === "boolean") {
            const boolean = section("Boolean");
            boolean.append(choice("Operation", "booleanOperation", ["union", "subtract", "intersect", "exclude"], "union"), button("Release operands", () => services.commands.run("struct.ungroup")));
            design.append(boolean);
        }
        if (shape.type === "path") {
            const vector = section("Vector");
            vector.append(button(canvas.pathId === shape.id ? "Editing nodes" : "Edit nodes", () => canvas.editPath(shape.id)), button("Edit segments", () => jsonEditor("Path segments", shape.content, v => patch("content", v))), choice("Fill rule", "fillRule", ["nonzero", "evenodd"], "nonzero"), row(action("path.close", "Close path"), action("path.open", "Open path")), row(action("path.join", "Join paths"), action("path.merge", "Merge points")), select("Mirror handles", shape.handleMode ?? "free", ["free", "aligned", "symmetric"], v => {
                update("Mirror path handles", target => {
                    if (target.type !== "path")
                        return;
                    target.handleMode = v;
                    for (let index = 0; index < target.content.length; index++) {
                        const node = target.content[index];
                        if (node.command === "curve")
                            setPathHandle(target, index, "in", {
                                x: node.x2,
                                y: node.y2
                            }, v);
                    }
                });
            }));
            if (shape.primitive) {
                vector.append(row(input("Points", shape.primitive.count, v => services.commands.run("path.primitive", {
                    id: shape.id,
                    primitive: {
                        ...shape.primitive,
                        count: Math.max(3, Math.round(v))
                    }
                }), "number"), shape.primitive.kind === "star" ? input("Ratio", shape.primitive.ratio ?? 0.5, v => services.commands.run("path.primitive", {
                    id: shape.id,
                    primitive: {
                        ...shape.primitive,
                        ratio: v
                    }
                }), "number") : null));
            }
            design.append(vector);
        }
        design.append(componentPanel(), exportPanel());
        focusField();
        rendering = false;
    }
    root.addEventListener("numeric-start", event => {
        if (text.active)
            return;
        if (editor.begin("Scrub property"))
            numericSession = true;
        else
            event.preventDefault();
    });
    root.addEventListener("numeric-end", event => {
        if (!numericSession)
            return;
        numericSession = false;
        if ((event as CustomEvent).detail?.cancel)
            editor.cancelSession();
        else
            editor.commitSession();
    });
    const unsubscribe = editor.on(event => {
        if (event.viewport || event.hover)
            return;
        if (text.active && !event.selection && !event.projection)
            return;
        refresh();
    });
    root.addEventListener("pointerdown", event => {
        if (text.active) {
            text.range();
            if (!(event.target as HTMLElement).matches("input,select,textarea"))
                event.preventDefault();
        }
    });
    refresh();
    return {
        refresh,
        finishScrub() {
            if (numericSession) {
                numericSession = false;
                editor.commitSession();
            }
        },
        fontPicker,
        exportLayer,
        destroy() {
            destroyed = true;
            root.dispatchEvent(new Event("numeric-dispose"));
            if (numericSession) {
                numericSession = false;
                editor.cancelSession();
            }
            unsubscribe();
            root.replaceChildren();
        }
    };
}
