import {documentPage,libraryPage} from './desktop-test-pages.mjs';
import { _electron as electron } from "playwright";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const qa = path.join(root, "docs/qa/independent-ui");
await fs.mkdir(qa, {
    recursive: true
});
const profile = await fs.mkdtemp(path.join(os.tmpdir(), "omc-independent-ui-"));
const rows = [], errors = [];
let app, page, fixtureNumber = 0, stopRequested = false;
process.on("SIGTERM", () => {
    stopRequested = true;
    void app?.close().catch(() => {
    });
});
const mod = process.platform === "darwin" ? "Meta" : "Control";
const identity = {
    a: 1,
    b: 0,
    c: 0,
    d: 1,
    e: 0,
    f: 0
};
function shape(id, type, x, y, width, height, props = {}) {
    return {
        id,
        type,
        name: id,
        parentId: "board",
        enclosingFrameId: "board",
        x,
        y,
        width,
        height,
        box: {
            x,
            y,
            width,
            height
        },
        corners: [{
                x,
                y
            }, {
                x: x + width,
                y
            }, {
                x: x + width,
                y: y + height
            }, {
                x,
                y: y + height
            }],
        rotation: 0,
        transform: {
            ...identity
        },
        inverseTransform: {
            ...identity
        },
        fills: [{
                color: "#7c9fe5"
            }],
        strokes: [],
        ...props
    };
}
function fixture(items = []) {
    const objects = {
        root: shape("root", "frame", 0, 0, 1000, 800, {
            parentId: "root",
            enclosingFrameId: "root",
            childIds: ["board"],
            fills: []
        }),
        board: shape("board", "frame", 0, 0, 1000, 800, {
            parentId: "root",
            enclosingFrameId: "root",
            childIds: items.map(s => s.id),
            fills: [{
                    color: "#fff"
                }]
        })
    };
    for (const s of items)
        objects[s.id] = s;
    return {
        pages: ["page"],
        pagesById: {
            page: {
                id: "page",
                name: "QA Page",
                objects
            }
        },
        components: {},
        styles: {},
        libraries: {}
    };
}
const rich = (a = "Alpha", b = "Beta") => ({
    type: "richText",
    children: [{
            children: [{
                    text: a,
                    fontFamily: "IBM Plex Sans",
                    fontSize: 24,
                    fontWeight: 400,
                    fills: [{
                            color: "#18233b"
                        }]
                }, {
                    text: b,
                    fontFamily: "IBM Plex Sans",
                    fontSize: 24,
                    fontWeight: 700,
                    fills: [{
                            color: "#8355a5"
                        }]
                }]
        }]
});
async function snapshot() {
    await page.evaluate(() => window.omc.invoke("flush"));
    return page.evaluate(() => window.omc.invoke("snapshot"));
}
async function until(fn, message, timeout = 12000) {
    const end = Date.now() + timeout;
    let last;
    while (Date.now() < end) {
        try {
            const v = await fn();
            if (v)
                return v;
        }
        catch (e) {
            last = e;
        }
        await new Promise(r => setTimeout(r, 80));
    }
    throw Error(message + (last ? ": " + last.message : ""));
}
async function objects() {
    const s = await snapshot();
    return s.document.pagesById[s.document.pages[0]].objects;
}
async function fresh(items = []) {
    await page.keyboard.press("Escape");
    page=await libraryPage(app,{closeTabs:true});
    const file = path.join(profile, `fixture-${fixtureNumber++}.json`);
    await fs.writeFile(file, JSON.stringify(fixture(items)));
    await app.evaluate(({ dialog }, file) => {
        dialog.showOpenDialog = async () => ({
            canceled: false,
            filePaths: [file]
        });
    }, file);
    await page.locator("#import").click();
    page=await documentPage(app);
    await until(async () => {
        const o = await objects();
        return o.board && Object.keys(o).length === items.length + 2;
    }, "fixture did not open");
    await page.locator("#editor #stage").waitFor();
    await page.waitForFunction(() => !!window.lvMcp && !document.querySelector("#editor")?.inert);
    await page.locator("#editor .ltabs button").filter({
        hasText: "Layers"
    }).click();
    await page.locator("#editor #stage").click({
        position: {
            x: 15,
            y: 15
        }
    });
    await page.keyboard.press("Escape");
}
async function stagePoint(x, y) {
    const b = await page.locator("#editor #stage").boundingBox();
    return {
        x: b.x + x,
        y: b.y + y
    };
}
async function drag(a, b) {
    const p = await stagePoint(...a), q = await stagePoint(...b);
    await page.mouse.move(p.x, p.y);
    await page.mouse.down();
    await page.mouse.move(q.x, q.y, {
        steps: 8
    });
    await page.mouse.up();
}
async function choose(tool) {
    const b = page.locator(`#editor [data-tool="${tool}"]`);
    if (await b.isVisible())
        await b.click();
    else {
        const group = ["pen", "pencil"].includes(tool) ? "3" : "2";
        await page.locator(`#editor [data-group="${group}"] button[aria-label="More drawing tools"]`).click();
        await page.locator(`.context-menu [data-key="tool.${tool}"]`).click();
    }
}
async function selected(id) {
    await page.locator(`#editor .row[data-id="${id}"] .name`).click();
}
async function field(label, value) {
    const input = page.locator(`#right input[aria-label="${label}"]`).first();
    await input.fill(String(value));
    await input.press("Tab");
}
async function test(id, name, fn) {
    if (stopRequested || (process.env.ONLY_UI_IDS && !process.env.ONLY_UI_IDS.split(",").includes(id)))
        return;
    const started = Date.now();
    try {
        await fn();
        rows.push({
            id,
            name,
            status: "passed",
            trace: id === "UI-inspector-layout" ? await page.locator("body").getAttribute("data-ui-trace") : undefined,
            ms: Date.now() - started
        });
        console.log("PASS", id, name);
    }
    catch (error) {
        const shot = path.join(qa, `${id}-failure.png`);
        await page?.screenshot({
            path: shot
        }).catch(() => {
        });
        await fs.writeFile(path.join(qa, `${id}-failure-document.json`), JSON.stringify(await snapshot().catch(() => null), null, 2));
        rows.push({
            id,
            name,
            status: "failed",
            error: error.stack,
            toast: await page?.locator("#toast,.omc-toast").allTextContents().catch(() => []),
            trace: await page?.locator("body").getAttribute("data-ui-trace").catch(() => null),
            ms: Date.now() - started,
            screenshot: shot
        });
        console.log("FAIL", id, name, error.message);
    }
}
try {
    app = await electron.launch({
        args: [root, `--profile=${profile}`],
        env: {
            ...process.env,
            OMC_TEST_BACKGROUND: '1',
            ELECTRON_DISABLE_SECURITY_WARNINGS: "true"
        },
        timeout: 30000
    });
    page = await app.firstWindow();
    page.setDefaultTimeout(10000);
    page.on("pageerror", error => errors.push(error.message));
    await page.locator("#new").waitFor();
    for (const tool of ["frame", "rect", "ellipse", "polygon", "star", "line", "arrow", "pencil", "pen", "text"])
        await test("UI-tool-" + tool, `${tool} native gesture`, async () => {
            await fresh();
            const before = Object.keys(await objects()).length;
            await choose(tool);
            if (tool === "pen") {
                let p = await stagePoint(100, 100);
                await page.mouse.click(p.x, p.y);
                p = await stagePoint(200, 160);
                await page.mouse.click(p.x, p.y);
                await page.keyboard.press("Enter");
            }
            else {
                await drag([100, 100], [210, 170]);
                if (tool === "text") {
                    await page.locator(".text-edit-surface").waitFor();
                    await page.keyboard.insertText("Tool text \uD55C\uAE00");
                    await page.keyboard.press(mod + "+Enter");
                }
            }
            await until(async () => Object.keys(await objects()).length === before + 1, "tool did not persist one layer");
            const added = Object.values(await objects()).find(s => !["root", "board"].includes(s.id));
            assert.ok(added.width > 0 && added.height > 0);
            assert.equal(added.type, ["polygon", "star", "line", "arrow", "pencil", "pen"].includes(tool) ? "path" : tool);
            if (tool === "star" || tool === "polygon")
                assert.equal(added.primitive.kind, tool);
        });
    await test("UI-tool-move", "move gesture and one durable step", async () => {
        await fresh([shape("rect", "rect", 100, 100, 100, 80)]);
        const before = await snapshot();
        await choose("move");
        await drag([140, 130], [190, 160]);
        await until(async () => {
            const s = (await objects()).rect;
            return Math.abs(s.x - 150) < 1 && Math.abs(s.y - 130) < 1;
        }, "move coordinates differ");
        assert.equal((await snapshot()).ack - before.ack, 1);
    });
    await test("UI-imported-html-drag", "public HTML absolute positioning survives native drag and durable Undo/Redo", async () => {
        await fresh();
        const response = await page.evaluate(() => window.lvMcp.handleToolCall("native-html-fixture", "write_html", {
            html: '<div data-ref="native-absolute" style="position:absolute;left:300px;top:300px;width:100px;height:80px;background:#698ed8"></div>',
            target: "board",
            position: "last"
        }));
        const result = response.structuredContent ?? JSON.parse(response.content[0].text);
        assert.equal(result.ok, true, JSON.stringify(result));
        const id = result.rawIds[0];
        await until(async () => {
            const imported = (await objects())[id];
            return imported?.x === 300 && imported?.y === 300;
        }, "absolute HTML import did not persist at 300,300");
        const initial = (await objects())[id];
        assert.equal(initial.parentId, "board");
        assert.equal(initial.absolute, true);
        assert.equal(initial.inlineStyles.left, "300px");
        assert.equal(initial.inlineStyles.top, "300px");
        await choose("move");
        await page.locator(`#editor .layers .row[data-id="${id}"] .name`).click();
        await drag([340, 330], [380, 350]);
        await until(async () => {
            const imported = (await objects())[id];
            return imported?.x === 340 && imported?.y === 320;
        }, "native drag of imported absolute HTML reset to CSS coordinates");
        const moved = (await objects())[id];
        assert.equal(moved.inlineStyles.left, "340px");
        assert.equal(moved.inlineStyles.top, "320px");
        assert.equal(moved.width, 100);
        assert.equal(moved.height, 80);
        await page.keyboard.press(mod + "+z");
        await until(async () => {
            const imported = (await objects())[id];
            return imported?.x === 300 && imported?.y === 300;
        }, "Undo did not restore imported HTML geometry");
        assert.equal((await objects())[id].inlineStyles.left, "300px");
        assert.equal((await objects())[id].inlineStyles.top, "300px");
        await page.keyboard.press(mod + "+Shift+z");
        await until(async () => {
            const imported = (await objects())[id];
            return imported?.x === 340 && imported?.y === 320;
        }, "Redo did not restore native drag of imported HTML");
        assert.equal((await objects())[id].inlineStyles.left, "340px");
        assert.equal((await objects())[id].inlineStyles.top, "320px");
        assert.ok(await page.locator('#stage svg [data-shape-id="' + id + '"]').count());
    });
    await test("UI-cancel-draw", "Escape cancels live drawing without a ghost", async () => {
        await fresh();
        await choose("rect");
        const p = await stagePoint(100, 100), q = await stagePoint(180, 160);
        await page.mouse.move(p.x, p.y);
        await page.mouse.down();
        await page.mouse.move(q.x, q.y);
        await page.keyboard.press("Escape");
        await page.mouse.up();
        await until(async () => Object.keys(await objects()).length === 2, "canceled shape persisted");
    });
    await test("UI-cancel-tools", "every creation tool and move cancel without a durable ghost", async () => {
        for (const tool of ["frame", "rect", "ellipse", "polygon", "star", "line", "arrow", "pencil", "pen", "text"]) {
            await fresh();
            const before = (await snapshot()).ack;
            await choose(tool);
            const p = await stagePoint(100, 100), q = await stagePoint(180, 150);
            await page.mouse.move(p.x, p.y);
            await page.mouse.down();
            await page.mouse.move(q.x, q.y, {
                steps: 3
            });
            await page.keyboard.press("Escape");
            await page.mouse.up();
            await until(async () => Object.keys(await objects()).length === 2, tool + " cancellation left a ghost");
            assert.equal((await snapshot()).ack, before, tool + " cancellation created history");
        }
        await fresh([shape("rect", "rect", 100, 100, 100, 80)]);
        const p = await stagePoint(130, 130), q = await stagePoint(200, 180);
        await choose("move");
        await page.mouse.move(p.x, p.y);
        await page.mouse.down();
        await page.mouse.move(q.x, q.y, {
            steps: 3
        });
        await page.keyboard.press("Escape");
        await page.mouse.up();
        assert.equal((await objects()).rect.x, 100);
        assert.equal((await objects()).rect.y, 100);
    });
    await test("UI-resize", "native handle resize", async () => {
        await fresh([shape("rect", "rect", 100, 100, 100, 80)]);
        await selected("rect");
        const h = page.locator("[data-handle=\"se\"]");
        const p = await h.boundingBox();
        await page.mouse.move(p.x + p.width / 2, p.y + p.height / 2);
        await page.mouse.down();
        await page.mouse.move(p.x + p.width / 2 + 50, p.y + p.height / 2 + 30, {
            steps: 8
        });
        await page.mouse.up();
        await until(async () => {
            const s = (await objects()).rect;
            return Math.abs(s.width - 150) < 1 && Math.abs(s.height - 110) < 1;
        }, "handle resize dimensions differ");
    });
    await test("UI-rotate", "native rotation handle changes oriented geometry", async () => {
        await fresh([shape("rect", "rect", 100, 100, 100, 80)]);
        await selected("rect");
        const h = await page.locator(".rotate-handle").boundingBox(), c = await stagePoint(150, 140);
        await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
        await page.mouse.down();
        await page.mouse.move(c.x + 80, c.y, {
            steps: 8
        });
        await page.mouse.up();
        await until(async () => Math.abs((await objects()).rect.rotation) > 45, "rotation did not persist");
    });
    await test("UI-path-nudge", "node edit and Arrow/Shift-Arrow move nodes rather than layer", async () => {
        await fresh([shape("path", "path", 100, 100, 150, 100, {
                fills: [],
                strokes: [{
                        color: "#000",
                        width: 3
                    }],
                content: [{
                        command: "move",
                        x: 100,
                        y: 100
                    }, {
                        command: "curve",
                        x1: 140,
                        y1: 100,
                        x2: 200,
                        y2: 150,
                        x: 250,
                        y: 200
                    }]
            })]);
        await selected("path");
        await page.keyboard.press("Enter");
        const node = page.locator(".path-node:not(.path-control)").first();
        await node.click();
        await page.keyboard.press("Shift+ArrowRight");
        await until(async () => (await objects()).path.content[0].x === 110, "node not nudged");
        assert.equal((await objects()).path.content[1].x, 250);
    });
    await test("UI-path-endpoint-drop", "compatible open endpoint drag joins two editable paths", async () => {
        await fresh([shape("first", "path", 100, 100, 80, 1, {
                fills: [],
                strokes: [{
                        color: "#000",
                        width: 3
                    }],
                content: [{
                        command: "move",
                        x: 100,
                        y: 100
                    }, {
                        command: "line",
                        x: 180,
                        y: 100
                    }]
            }), shape("second", "path", 250, 100, 100, 1, {
                fills: [],
                strokes: [{
                        color: "#000",
                        width: 3
                    }],
                content: [{
                        command: "move",
                        x: 250,
                        y: 100
                    }, {
                        command: "line",
                        x: 350,
                        y: 100
                    }]
            })]);
        await selected("first");
        await page.keyboard.press("Enter");
        const node = await page.locator(".path-node:not(.path-control)").last().boundingBox(), target = await stagePoint(250, 100);
        await page.mouse.move(node.x + node.width / 2, node.y + node.height / 2);
        await page.mouse.down();
        await page.mouse.move(target.x, target.y, {
            steps: 12
        });
        await page.mouse.up();
        await until(async () => !(await objects()).second, "compatible endpoint did not join");
        const path = (await objects()).first;
        assert.equal(path.content.at(-1).x, 350);
        assert.equal(path.content[0].x, 100);
    });
    await test("UI-path-merge", "Mod-J merges selected first/last open nodes without deleting the path", async () => {
        await fresh([shape("path", "path", 100, 100, 100, 80, {
                fills: [],
                strokes: [{
                        color: "#000",
                        width: 3
                    }],
                content: [{
                        command: "move",
                        x: 100,
                        y: 100
                    }, {
                        command: "line",
                        x: 150,
                        y: 180
                    }, {
                        command: "line",
                        x: 200,
                        y: 100
                    }]
            })]);
        await selected("path");
        await page.keyboard.press("Enter");
        await page.locator(".path-node:not(.path-control)").first().click();
        await page.locator(".path-node:not(.path-control)").last().click({
            modifiers: ["Shift"]
        });
        await page.keyboard.press(mod + "+j");
        await until(async () => (await objects()).path.content.some(node => node.command === "close"), "path endpoints did not close");
        assert.equal((await objects()).path.content[0].x, 150);
    });
    await test("UI-text-rich", "native rich typing preserves two styled runs", async () => {
        await fresh([shape("text", "text", 100, 100, 300, 60, {
                content: rich()
            })]);
        await selected("text");
        await page.keyboard.press("Enter");
        const surface = page.locator(".text-edit-surface");
        await surface.waitFor();
        await page.keyboard.press("ArrowRight");
        await page.keyboard.insertText(" \uD55C\uAE00");
        await page.keyboard.press(mod + "+Enter");
        await until(async () => JSON.stringify((await objects()).text.content).includes("\uD55C\uAE00"), "text commit missing");
        const runs = (await objects()).text.content.children.flatMap(p => p.children);
        assert.ok(runs.some(r => r.fontWeight === 400));
        assert.ok(runs.some(r => r.fontWeight === 700));
    });
    await test("UI-text-range-history", "native range bold, local undo/redo and cancel", async () => {
        await fresh([shape("text", "text", 100, 100, 300, 60, {
                content: rich("First", " second")
            })]);
        await selected("text");
        await page.keyboard.press("Enter");
        await page.keyboard.press(mod + "+a");
        await page.keyboard.press(mod + "+b");
        assert.ok(await page.locator(".text-edit-surface [data-run]").evaluateAll(nodes => nodes.every(n => JSON.parse(n.dataset.run).fontWeight === 700)));
        await page.keyboard.press(mod + "+z");
        assert.ok(await page.locator(".text-edit-surface [data-run]").evaluateAll(nodes => nodes.some(n => JSON.parse(n.dataset.run).fontWeight === 400)));
        await page.keyboard.press(mod + "+Shift+z");
        await page.keyboard.press("Escape");
        assert.deepEqual((await objects()).text.content, rich("First", " second"));
    });
    await test("UI-ime-native", "Chromium IME composition commits one Hangul character with local undo/redo", async () => {
        await fresh([shape("text", "text", 100, 100, 300, 60, {
                content: rich()
            })]);
        await selected("text");
        await page.keyboard.press("Enter");
        await page.keyboard.press("ArrowRight");
        const client = await page.context().newCDPSession(page);
        await client.send("Input.imeSetComposition", {
            text: "\u314E",
            selectionStart: 1,
            selectionEnd: 1
        });
        await client.send("Input.imeSetComposition", {
            text: "\uD55C",
            selectionStart: 1,
            selectionEnd: 1
        });
        await client.send("Input.insertText", {
            text: "\uD55C"
        });
        await until(async () => (await page.locator(".text-edit-surface").innerText()).includes("\uD55C"), "native IME commit missing");
        await page.keyboard.press(mod + "+z");
        assert.ok(!(await page.locator(".text-edit-surface").innerText()).includes("\uD55C"));
        await page.keyboard.press(mod + "+Shift+z");
        assert.ok((await page.locator(".text-edit-surface").innerText()).includes("\uD55C"));
        await page.keyboard.press(mod + "+Enter");
        await until(async () => JSON.stringify((await objects()).text.content).includes("\uD55C"), "IME persistence missing");
        const value = (await objects()).text.content.children.flatMap(p => p.children).map(r => r.text).join("");
        assert.equal(value, "AlphaBeta\uD55C");
        await client.detach();
    });
    await test("UI-text-empty", "empty new text cancellation has no durable ghost or undo resurrection", async () => {
        await fresh();
        const before = (await snapshot()).ack;
        await choose("text");
        const p = await stagePoint(100, 100);
        await page.mouse.click(p.x, p.y);
        await page.locator(".text-edit-surface").waitFor();
        await page.keyboard.press("Escape");
        await until(async () => Object.keys(await objects()).length === 2, "empty text persisted");
        assert.equal((await snapshot()).ack, before);
    });
    await test("UI-clipboard", "native OS clipboard shape paste creates fresh subtree IDs", async () => {
        await fresh([shape("rect", "rect", 100, 100, 100, 80)]);
        await selected("rect");
        await page.keyboard.press(mod + "+c");
        await page.keyboard.press(mod + "+v");
        await until(async () => Object.keys(await objects()).length === 4, "paste missing");
        const shapes = Object.values(await objects()).filter(s => s.type === "rect");
        assert.equal(shapes.length, 2);
        assert.notEqual(shapes[0].id, shapes[1].id);
    });
    await test("UI-paste-here", "context Paste here honors the exact world pointer position", async () => {
        await fresh([shape("rect", "rect", 100, 100, 100, 80)]);
        await selected("rect");
        await page.keyboard.press(mod + "+c");
        const before = await snapshot(), point = await stagePoint(400, 300);
        await page.mouse.click(point.x, point.y, {
            button: "right"
        });
        await page.locator(".context-menu [data-key=\"edit.paste-here\"]").click();
        await until(async () => Object.values(await objects()).filter(shape => shape.type === "rect").length === 2, "Paste here did not create a copied shape");
        const copied = Object.values(await objects()).find(shape => shape.type === "rect" && shape.id !== "rect");
        assert.equal(copied.x, 400);
        assert.equal(copied.y, 300);
        assert.equal((await snapshot()).ack - before.ack, 1);
    });
    await test("UI-files-atomic", "multi-image/SVG picker places side by side in one operation", async () => {
        await fresh();
        const png = path.join(profile, "one.png"), svg = path.join(profile, "two.svg");
        await fs.writeFile(png, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j0ioAAAAASUVORK5CYII=", "base64"));
        await fs.writeFile(svg, "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"40\" height=\"30\"><rect width=\"40\" height=\"30\" fill=\"#ad85d8\"/></svg>");
        const before = await snapshot();
        await app.evaluate(({dialog},files)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:files});},[png,svg]);
        await page.keyboard.press(mod + "+Shift+k");

        await until(async () => Object.keys(await objects()).length >= 4, "multi-file import missing");
        const after = await snapshot();
        assert.equal(after.ack - before.ack, 1);
        const roots = after.document.pagesById.page.objects.root.childIds.filter(id => id !== "board").map(id => after.document.pagesById.page.objects[id]).sort((a, b) => a.x - b.x);
        assert.equal(roots.length, 2);
        assert.ok(Math.abs(roots[0].y - roots[1].y) < 0.01);
        assert.ok(roots[1].x >= roots[0].x + roots[0].width + 23.9);
    });
    await test("UI-find", "case/whole word, cyclic reveal and replace all", async () => {
        await fresh([shape("text", "text", 100, 100, 450, 70, {
                content: rich("Cat cat", " scatter Cat")
            })]);
        await page.keyboard.press(mod + "+f");
        await page.locator(".find-bar input[aria-label=\"Find layers\"]").fill("Cat");
        await page.locator(".find-bar").getByLabel("Case", {
            exact: true
        }).check();
        await page.locator(".find-bar").getByLabel("Whole word", {
            exact: true
        }).check();
        await page.locator(".find-bar").getByLabel("Replacement", {
            exact: true
        }).fill("Dog");
        await page.getByRole("button", {
            name: "Replace all matches",
            exact: true
        }).click();
        await until(async () => JSON.stringify((await objects()).text.content).includes("Dog"), "find replacement missing");
        const value = (await objects()).text.content.children.flatMap(p => p.children).map(r => r.text).join("");
        assert.equal(value, "Dog cat scatter Dog");
    });
    await test("UI-components", "create main, Assets linked instance and Add variant inspector", async () => {
        await fresh([shape("rect", "rect", 100, 100, 100, 80)]);
        await selected("rect");
        await page.keyboard.press(mod + "+Alt+k");
        await until(async () => Object.keys((await snapshot()).document.components ?? {}).length === 1, "main component missing");
        await page.locator("#components").first().click();
        await page.locator(".atile").first().click();
        await until(async () => Object.values(await objects()).some(s => s.isInstanceRoot && !s.isMain), "linked asset instance missing");
        await page.locator("#editor .ltabs button").filter({
            hasText: "Layers"
        }).click();
        await selected("rect");
        assert.ok(await page.getByRole("button", {
            name: "Add variant",
            exact: true
        }).isVisible());
        await page.getByRole("button", {
            name: "Add variant",
            exact: true
        }).click();
        await until(async () => Object.keys((await snapshot()).document.components).length === 2, "variant missing");
    });
    await test("UI-guides", "rulers and guide creation through inspector", async () => {
        await fresh();
        await page.keyboard.press("Shift+r");
        assert.equal(await page.locator(".ruler").count(), 2);
        await page.getByRole("button", {
            name: "Add guides",
            exact: true
        }).click();
        await until(async () => ((await snapshot()).document.pagesById.page.guides ?? []).length === 1, "guide missing");
        assert.equal(await page.locator(".guide-line").count(), 1);
    });
    await test("UI-mobile", "narrow bottom sheets and real duplicate action", async () => {
        await fresh([shape("rect", "rect", 100, 100, 100, 80)]);
        await app.evaluate(({ BrowserWindow }) => {
            const w = BrowserWindow.getAllWindows()[0];
            w.setMinimumSize(360, 640);
            w.setSize(390, 850);
        });
        await page.locator(".mobile-controls").getByRole("button", {
            name: "Layers",
            exact: true
        }).click();
        assert.ok(await page.locator("#left").isVisible());
        await selected("rect");
        await page.locator(".mobile-controls").getByRole("button", {
            name: "Done",
            exact: true
        }).click();
        await page.locator(".mobile-controls").getByRole("button", {
            name: "Duplicate",
            exact: true
        }).click();
        await until(async () => Object.values(await objects()).filter(s => s.type === "rect").length === 2, "mobile duplicate missing");
        await page.locator(".mobile-controls").getByRole("button", {
            name: "Design",
            exact: true
        }).click();
        assert.ok(await page.locator("#right").isVisible());
        await page.screenshot({
            path: path.join(qa, "mobile.png")
        });
        await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1500, 980));
    });
    await test("UI-touch-native", "Chromium touch pointer pan and pinch update the real viewport", async () => {
        await fresh();
        const zoom = page.locator("#editor select[aria-label=\"Zoom\"]");
        await zoom.selectOption({
            label: "50%"
        });
        const client = await page.context().newCDPSession(page);
        await client.send("Emulation.setTouchEmulationEnabled", {
            enabled: true,
            maxTouchPoints: 2
        });
        try {
            const p = await stagePoint(50, 50), before = await page.locator("#view svg").getAttribute("viewBox");
            await client.send("Input.dispatchTouchEvent", {
                type: "touchStart",
                touchPoints: [{
                        x: p.x,
                        y: p.y,
                        id: 1
                    }]
            });
            await client.send("Input.dispatchTouchEvent", {
                type: "touchMove",
                touchPoints: [{
                        x: p.x + 30,
                        y: p.y + 20,
                        id: 1
                    }]
            });
            await client.send("Input.dispatchTouchEvent", {
                type: "touchEnd",
                touchPoints: []
            });
            assert.notEqual(await page.locator("#view svg").getAttribute("viewBox"), before);
            const c = await stagePoint(400, 250), old = Number(await zoom.inputValue());
            await client.send("Input.dispatchTouchEvent", {
                type: "touchStart",
                touchPoints: [{
                        x: c.x - 50,
                        y: c.y,
                        id: 1
                    }, {
                        x: c.x + 50,
                        y: c.y,
                        id: 2
                    }]
            });
            await client.send("Input.dispatchTouchEvent", {
                type: "touchMove",
                touchPoints: [{
                        x: c.x - 90,
                        y: c.y,
                        id: 1
                    }, {
                        x: c.x + 90,
                        y: c.y,
                        id: 2
                    }]
            });
            await client.send("Input.dispatchTouchEvent", {
                type: "touchEnd",
                touchPoints: []
            });
            assert.ok(Number(await zoom.inputValue()) > old * 1.3);
        }
        finally {
            await client.send("Emulation.setTouchEmulationEnabled", {
                enabled: false
            });
            await client.detach();
        }
    });
    await test("UI-pages-layers", "inline layer rename/flags plus page add/rename/clone/delete", async () => {
        await fresh([shape("rect", "rect", 100, 100, 100, 80)]);
        const layer = page.locator(".layers .row[data-id=\"rect\"]");
        await layer.locator(".name").dblclick();
        const inline = layer.locator(".name[contenteditable=\"true\"]");
        await inline.fill("Renamed layer");
        await inline.press("Enter");
        await until(async () => (await objects()).rect.name === "Renamed layer", "inline rename did not persist");
        await layer.getByRole("button", {
            name: "Toggle visibility",
            exact: true
        }).click();
        await until(async () => (await objects()).rect.hidden === true, "hide flag missing");
        await layer.getByRole("button", {
            name: "Toggle visibility",
            exact: true
        }).click();
        await layer.getByRole("button", {
            name: "Toggle lock",
            exact: true
        }).click();
        await until(async () => (await objects()).rect.locked === true, "lock flag missing");
        await layer.getByRole("button", {
            name: "Toggle lock",
            exact: true
        }).click();
        await page.getByRole("button", {
            name: "Add page",
            exact: true
        }).click();
        await until(async () => (await snapshot()).document.pages.length === 2, "page add failed");
        let s = await snapshot(), id = s.document.pages.find(id => id !== "page");
        await page.locator(".page-row[data-id=\"" + id + "\"] .name").dblclick();
        await page.locator(".omc-dialog input[aria-label=\"Name\"]").fill("Second page");
        await page.locator(".omc-dialog").getByRole("button", {
            name: "Save",
            exact: true
        }).click();
        await until(async () => (await snapshot()).document.pagesById[id].name === "Second page", "page rename failed");
        await page.locator(".page-row[data-id=\"" + id + "\"] button[aria-label=\"Page actions\"]").click();
        await page.locator(".omc-dialog").getByRole("button", {
            name: "Clone",
            exact: true
        }).click();
        await until(async () => (await snapshot()).document.pages.length === 3, "page clone failed");
        s = await snapshot();
        const cloneId = s.document.pages.find(key => key !== "page" && key !== id);
        await page.getByRole("combobox", { name: "Current page", exact: true }).selectOption(cloneId);
        await page.locator(".page-selector button[aria-label=\"Page actions\"]").click();
        await page.locator(".omc-dialog").getByRole("button", {
            name: "Delete",
            exact: true
        }).click();
        await until(async () => (await snapshot()).document.pages.length === 2, "page delete failed");
        await page.screenshot({
            path: path.join(qa, "desktop-pages.png")
        });
    });
    await test("UI-inspector-paint", "gradient stop limits, stroke details and effects update canonical paint and SVG", async () => {
        await fresh([shape("rect", "rect", 100, 100, 100, 80)]);
        await selected("rect");
        const panel = name => page.locator("#right section").filter({
            has: page.locator("h3").filter({
                hasText: new RegExp("^" + name + "\\s*(?:\\+)?\\s*$")
            })
        }).first();
        const fill = panel("Fill");
        await fill.getByLabel("Paint", {
            exact: true
        }).selectOption("angular");
        for (let i = 2; i < 16; i++)
            await fill.getByRole("button", {
                name: "+ Stop",
                exact: true
            }).click();
        assert.equal((await objects()).rect.fills[0].gradient.stops.length, 16);
        await fill.getByRole("button", {
            name: "+ Stop",
            exact: true
        }).click();
        assert.match(await page.locator(".omc-toast").innerText(), /16 stops/);
        await page.getByRole("button", {
            name: "Add stroke",
            exact: true
        }).click();
        const stroke = panel("Stroke");
        await stroke.getByLabel("Width", {
            exact: true
        }).fill("7");
        await stroke.getByLabel("Width", {
            exact: true
        }).press("Tab");
        await stroke.getByLabel("Align", {
            exact: true
        }).selectOption("outside");
        await stroke.getByLabel("Cap", {
            exact: true
        }).selectOption("round");
        await stroke.getByLabel("Join", {
            exact: true
        }).selectOption("bevel");
        await stroke.getByLabel("Dashes", {
            exact: true
        }).fill("4,2");
        await stroke.getByLabel("Dashes", {
            exact: true
        }).press("Tab");
        await page.getByRole("button", {
            name: "Add effects",
            exact: true
        }).click();
        const effects = panel("Effects");
        await effects.getByLabel("Shadow", {
            exact: true
        }).selectOption("inner");
        await effects.getByLabel("blur", {
            exact: true
        }).fill("9");
        await effects.getByLabel("blur", {
            exact: true
        }).press("Tab");
        const rect = (await objects()).rect;
        assert.equal(rect.strokes[0].width, 7);
        assert.equal(rect.strokes[0].align, "outside");
        assert.equal(rect.strokes[0].cap, "round");
        assert.equal(rect.strokes[0].join, "bevel");
        assert.deepEqual(rect.strokes[0].dashes, [4, 2]);
        assert.equal(rect.shadows[0].style, "inner");
        assert.equal(rect.shadows[0].blur, 9);
        assert.ok(await page.locator("#stage svg [data-shape-id=\"rect\"]").count());
    });
    await test("UI-inspector-layout", "flex and grid inspector controls reconcile actual child positions", async () => {
        await fresh([shape("first", "rect", 100, 100, 100, 80), shape("second", "rect", 300, 100, 80, 60)]);
        await selected("board");
        const layout = page.locator("#right section").filter({
            has: page.locator("h3").filter({
                hasText: /^Layout$/
            })
        }).first();
        await layout.getByLabel("Layout", {
            exact: true
        }).selectOption("flex");
        await page.evaluate(() => {
            document.body.dataset.uiTrace = "[]";
            for (const name of ["input", "change", "blur", "focusin", "keydown"]) {
                document.addEventListener(name, event => {
                    const field = event.target;
                    if (!(field instanceof HTMLInputElement || field instanceof HTMLSelectElement)) return;
                    const rows = JSON.parse(document.body.dataset.uiTrace || "[]");
                    rows.push({ event: event.type, label: field.getAttribute("aria-label"), value: field.value, key: event.key, connected: field.isConnected });
                    document.body.dataset.uiTrace = JSON.stringify(rows.slice(-50));
                    if (name === "change") queueMicrotask(async () => {
                        const response = await window.lvMcp.handleToolCall("ui-trace", "get_context", {});
                        const context = response.structuredContent ?? JSON.parse(response.content[0].text);
                        const next = JSON.parse(document.body.dataset.uiTrace || "[]");
                        next.push({ event: "after-change-context", label: field.getAttribute("aria-label"), context });
                        document.body.dataset.uiTrace = JSON.stringify(next.slice(-50));
                    });
                }, true);
            }
        });
        await layout.getByLabel("Column gap", {
            exact: true
        }).fill("24");
        await layout.getByLabel("Column gap", {
            exact: true
        }).press("Tab");
        await until(async () => Math.abs((await objects()).second.x - (await objects()).first.x - 124) < 0.01, "flex column gap failed");
        await layout.getByLabel("Direction", {
            exact: true
        }).selectOption("column");
        await until(async () => Math.abs((await objects()).second.y - (await objects()).first.y - 96) < 0.01, "flex direction failed");
        await layout.getByLabel("Layout", {
            exact: true
        }).selectOption("grid");
        await layout.getByLabel("columns", {
            exact: true
        }).fill("120 180");
        await layout.getByLabel("columns", {
            exact: true
        }).press("Tab");
        await layout.getByLabel("Pad left", {
            exact: true
        }).fill("12");
        await layout.getByLabel("Pad left", {
            exact: true
        }).press("Tab");
        await until(async () => Math.abs((await objects()).first.x - 12) < 0.01 && Math.abs((await objects()).second.x - 148) < 0.01, "grid tracks/padding failed");
        assert.deepEqual((await objects()).board.layout.columns.map(t => t.size), [120, 180]);
    });
    await test("UI-styles-crud", "local reusable paint style create/apply/edit sync/duplicate/delete", async () => {
        await fresh([shape("rect", "rect", 100, 100, 100, 80)]);
        await selected("rect");
        await page.locator("#components").first().click();
        await page.getByRole("button", {
            name: "+ Style",
            exact: true
        }).click();
        let dialog = page.locator("dialog[open]").last();
        await dialog.getByLabel("Name", {
            exact: true
        }).fill("Native paint");
        await dialog.getByLabel("Name", {
            exact: true
        }).press("Tab");
        await dialog.getByRole("button", {
            name: "Create",
            exact: true
        }).click();
        await page.getByRole("button", {
            name: "Native paint",
            exact: true
        }).click();
        let styles = (await snapshot()).document.styles;
        const styleId = Object.keys(styles).find(id => styles[id].name === "Native paint");
        assert.ok(styleId);
        assert.equal((await objects()).rect.fillStyleId, styleId);
        await page.getByRole("button", {
            name: "Edit style",
            exact: true
        }).first().click();
        dialog = page.locator("dialog[open]").last();
        await dialog.getByLabel("Name", {
            exact: true
        }).fill("Renamed paint");
        await dialog.getByLabel("Name", {
            exact: true
        }).press("Tab");
        await dialog.getByRole("button", {
            name: "Edit value",
            exact: true
        }).click();
        const value = page.locator("dialog[open]").last();
        await value.getByLabel("Style value", {
            exact: true
        }).fill("[{\"color\":\"#e74172\"}]");
        await value.getByRole("button", {
            name: "Apply",
            exact: true
        }).click();
        await until(async () => (await objects()).rect.fills[0].color === "#e74172", "linked paint style failed to synchronize");
        await dialog.getByRole("button", {
            name: "Duplicate",
            exact: true
        }).click();
        styles = (await snapshot()).document.styles;
        assert.equal(Object.keys(styles).length, 2);
        await page.getByRole("button", {
            name: "Edit style",
            exact: true
        }).first().click();
        await page.locator("dialog[open]").last().getByRole("button", {
            name: "Delete",
            exact: true
        }).click();
        assert.equal(Object.keys((await snapshot()).document.styles).length, 1);
    });
    await test("UI-component-properties", "component text/boolean/swap property dialogs create/edit/remove", async () => {
        await fresh([shape("rect", "rect", 100, 100, 100, 80)]);
        await selected("rect");
        await page.keyboard.press(mod + "+Alt+k");
        await until(async () => Object.keys((await snapshot()).document.components ?? {}).length === 1, "main missing");
        for (const type of ["text", "boolean", "swap"]) {
            await page.getByRole("button", {
                name: "Add property",
                exact: true
            }).click();
            const dialog = page.locator("dialog[open]").last();
            await dialog.getByLabel("Name", {
                exact: true
            }).fill("Native " + type);
            await dialog.getByLabel("Name", {
                exact: true
            }).press("Tab");
            await dialog.getByLabel("Type", {
                exact: true
            }).selectOption(type);
            await dialog.getByRole("button", {
                name: "Create",
                exact: true
            }).click();
        }
        const component = () => snapshot().then(s => Object.values(s.document.components)[0]);
        assert.deepEqual((await component()).properties.map(p => p.type).sort(), ["boolean", "swap", "text"]);
        await page.getByRole("button", {
            name: "Native text",
            exact: true
        }).click();
        let dialog = page.locator("dialog[open]").last();
        await dialog.getByLabel("Name", {
            exact: true
        }).fill("Edited text");
        await dialog.getByLabel("Name", {
            exact: true
        }).press("Tab");
        await dialog.getByLabel("Default", {
            exact: true
        }).fill("Caption");
        await dialog.getByLabel("Default", {
            exact: true
        }).press("Tab");
        await dialog.getByRole("button", {
            name: "Save",
            exact: true
        }).click();
        await until(async () => (await component()).properties.some(p => p.name === "Edited text" && p.default === "Caption"), "property edit failed");
        await page.getByRole("button", {
            name: "Native swap",
            exact: true
        }).click();
        dialog = page.locator("dialog[open]").last();
        await dialog.getByRole("button", {
            name: "Remove",
            exact: true
        }).click();
        await until(async () => (await component()).properties.length === 2, "property removal failed");
    });
    await test("UI-exports", "all layer file formats, native cancel and write error routes", async () => {
        await fresh([shape("rect", "rect", 100, 100, 80, 60)]);
        await selected("rect");
        for (const format of ["png", "jpg", "webp", "svg", "pdf"]) {
            await page.getByRole("button", {
                name: "Add export",
                exact: true
            }).click();
            const row = page.locator(".export-row").last();
            await row.getByLabel("Format", {
                exact: true
            }).selectOption(format);
            const file = path.join(profile, "export." + format);
            await app.evaluate(({ dialog }, file) => {
                dialog.showSaveDialog = async () => ({
                    canceled: false,
                    filePath: file
                });
            }, file);
            await row.getByRole("button", {
                name: "Export",
                exact: true
            }).click();
            await until(async () => {
                try {
                    return (await fs.stat(file)).size > 10;
                }
                catch {
                    return false;
                }
            }, format + " file missing");
            const bytes = await fs.readFile(file);
            if (format === "png")
                assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
            if (format === "jpg")
                assert.equal(bytes.subarray(0, 3).toString("hex"), "ffd8ff");
            if (format === "webp") {
                assert.equal(bytes.subarray(0, 4).toString(), "RIFF");
                assert.equal(bytes.subarray(8, 12).toString(), "WEBP");
            }
            if (format === "pdf")
                assert.ok(bytes.subarray(0, 5).toString().startsWith("%PDF-"));
            if (format === "svg") {
                assert.ok(bytes.toString().includes("<svg"));
                assert.ok(!bytes.toString().includes("transform-handle"));
            }
            if (["png", "jpg", "webp"].includes(format)) {
                const mime = format === "jpg" ? "image/jpeg" : "image/" + format;
                const dimensions = await page.evaluate(async ({ src }) => {
                    const image = new Image();
                    image.src = src;
                    await image.decode();
                    return {
                        width: image.naturalWidth,
                        height: image.naturalHeight
                    };
                }, {
                    src: "data:" + mime + ";base64," + bytes.toString("base64")
                });
                assert.deepEqual(dimensions, {
                    width: 80,
                    height: 60
                });
            }
            await fs.copyFile(file, path.join(qa, "native-export." + format));
        }
        const row = page.locator(".export-row").first();
        await app.evaluate(({ dialog }) => {
            dialog.showSaveDialog = async () => ({
                canceled: true
            });
        });
        await row.getByRole("button", {
            name: "Export",
            exact: true
        }).click();
        const blocker = path.join(profile, "not-a-directory");
        await fs.writeFile(blocker, "synthetic blocker");
        await app.evaluate(({ dialog }, file) => {
            dialog.showSaveDialog = async () => ({
                canceled: false,
                filePath: file
            });
        }, path.join(blocker, "impossible.png"));
        await row.getByRole("button", {
            name: "Export",
            exact: true
        }).click();
        await page.locator(".omc-toast[role=\"alert\"]").waitFor();
        await page.screenshot({
            path: path.join(qa, "desktop-export-error.png")
        });
    });
}
finally {
    if (app)
        await app.close().catch(() => {
        });
    const report = {
        createdAt: new Date().toISOString(),
        profile,
        rows,
        passed: rows.filter(r => r.status === "passed").length,
        failed: rows.filter(r => r.status === "failed").length,
        pageErrors: errors,
        interrupted: stopRequested,
        gaps: ["Real OS IME candidate composition and clipboard permissions remain platform-specific.", "Native save dialogs use a test-side deterministic Electron dialog adapter; actual IPC, encoding and file writes execute.", "Same-page remote text rebase is covered by the separate UI harness; exhaustive mixed subpath topology, paint/layout/style/property dialogs and physical device behavior still need additional UI evidence."]
    };
    await fs.writeFile(path.join(qa, (process.env.UI_REPORT_SUFFIX ? "report-" + process.env.UI_REPORT_SUFFIX : "report") + ".json"), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({
        passed: report.passed,
        failed: report.failed,
        pageErrors: errors,
        profile
    }));
    await fs.rm(profile, {
        recursive: true,
        force: true
    });
    if (report.failed || errors.length)
        process.exitCode = 1;
}
