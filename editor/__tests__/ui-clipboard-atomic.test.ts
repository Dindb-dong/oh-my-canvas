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
