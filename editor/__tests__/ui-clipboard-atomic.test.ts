// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { Editor, createDocument, createShape } from "../document";
import { createCommands } from "../commands";
import { createAssetService } from "../assets";
import { createClipboard } from "../interaction/clipboard";
import type { EditorServices, Data } from "../contracts";
const cleanups: Array<() => void> = [];
afterEach(() => {
    cleanups.splice(0).forEach(cleanup => cleanup());
    document.body.replaceChildren();
});
function setup() {
    const editor = new Editor(createDocument()), stage = document.createElement("div");
    document.body.append(stage);
    const services = {
        editor,
        fonts: {
            ensure: async () => {
            },
            add: () => {
            }
        },
        export: {},
        components: {},
        view: {},
        styles: {}
    } as unknown as EditorServices;
    services.assets = createAssetService(editor);
    let parseCounter = 0;
    services.formats = {
        importSvg: (text: string) => {
            const shape = createShape("rect", {
                id: "prepared-" + parseCounter++,
                x: 0,
                y: 0,
                width: 40,
                height: 30,
                parentId: "root"
            });
            if (text.includes("invalid"))
                shape.type = "unsupported" as any;
            return {
                width: 40,
                height: 30,
                rootIds: [shape.id],
                shapes: [shape]
            };
        }
    };
    services.commands = createCommands(editor, services);
    const clipboard = createClipboard(stage, services);
    cleanups.push(() => {
        clipboard.destroy();
        services.commands.destroy();
        editor.destroy();
    });
    return {
        editor,
        services,
        clipboard
    };
}
describe("prepared native file placement atomicity", () => {
    it("places multiple prepared SVGs side by side in one durable edit including asset metadata", async () => {
        const t = setup();
        let commits = 0;
        t.editor.on(event => {
            if (event.changes)
                commits++;
        });
        await t.clipboard.importFiles([new File(["<svg>one</svg>"], "one.svg", {
                type: "image/svg+xml"
            }), new File(["<svg>two</svg>"], "two.svg", {
                type: "image/svg+xml"
            })], {
            x: 100,
            y: 200
        });
        const objects = t.editor.page.objects, shapes = objects.root.childIds!.map(id => objects[id]).sort((a, b) => a.x - b.x);
        expect(commits).toBe(1);
        expect(shapes).toHaveLength(2);
        expect(shapes[0].x).toBe(100);
        expect(shapes[1].x).toBe(164);
        expect(shapes.map(s => s.y)).toEqual([200, 200]);
        expect(Object.keys(t.editor.doc.assets)).toHaveLength(2);
    });
    it("rolls back asset records and every shape when a later prepared shape is invalid", async () => {
        const t = setup(), before = structuredClone(t.editor.doc);
        let commits = 0;
        t.editor.on(event => {
            if (event.changes)
                commits++;
        });
        await expect(t.clipboard.importFiles([new File(["<svg>one</svg>"], "one.svg", {
                type: "image/svg+xml"
            }), new File(["<svg>invalid</svg>"], "invalid.svg", {
                type: "image/svg+xml"
            })], {
            x: 100,
            y: 200
        })).rejects.toThrow();
        expect(t.editor.doc).toEqual(before);
        expect(t.editor.selection).toEqual([]);
        expect(commits).toBe(0);
    });
});


describe("design file placement", () => {
    it("places every imported page in one undoable edit", async () => {
        const t = setup(), before = structuredClone(t.editor.doc);
        const one = createShape("rect", {id:"design-one", name:"First page", parentId:"root", width:20, height:10});
        const two = createShape("rect", {id:"design-two", name:"Second page", parentId:"root", x:50, width:20, height:10});
        t.services.formats.importDesignFile = async () => ({document:{pages:["one","two"],pagesById:{one:{objects:{root:{id:"root",childIds:[one.id]},[one.id]:one}},two:{objects:{root:{id:"root",childIds:[two.id]},[two.id]:two}}}},warnings:[]});
        const file = new File(["binary"], "pages.FIG");Object.defineProperty(file,"arrayBuffer",{value:async()=>new Uint8Array([1,2,3]).buffer});
        await t.clipboard.importFiles([file],{x:100,y:200});
        expect(Object.values(t.editor.page.objects).filter(s=>s.id!=="root").map(s=>s.name)).toEqual(["First page","Second page"]);
        expect(t.editor.undoStep()).toBe(true);expect(t.editor.doc).toEqual(before);
    });
    it("leaves the document unchanged when decoding fails", async () => {
        const t = setup(), before = structuredClone(t.editor.doc);
        t.services.formats.importDesignFile = async () => {throw Error("Invalid design archive");};
        const file = new File(["binary"], "invalid.sketch");Object.defineProperty(file,"arrayBuffer",{value:async()=>new Uint8Array([1]).buffer});
        await expect(t.clipboard.importFiles([file],{x:0,y:0})).rejects.toThrow("Invalid design archive");
        expect(t.editor.doc).toEqual(before);
    });
});
