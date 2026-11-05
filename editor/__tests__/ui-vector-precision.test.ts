// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Editor, createDocument, createShape, insertShape } from '../document';
import { createCommands } from '../commands';
import { createCanvasInteraction } from '../interaction/canvas';
import { createInspector } from '../ui/inspector';
import type { Data, EditorServices } from '../contracts';
const cleanups: (() => void)[] = [];
beforeEach(() => vi.stubGlobal('CSS', { escape: (value: string) => value }));
afterEach(() => { cleanups.splice(0).forEach(fn => fn()); document.body.replaceChildren(); vi.unstubAllGlobals(); });
function setup(type = 'path', props: Data = {}, images?: Data) {
    const doc = createDocument(), page = doc.pagesById[doc.pages[0]];
    insertShape(page, createShape(type, { id: 'shape', x: 100, y: 100, width: 100, height: 100, content: [{command: 'move', x: 100, y: 100}, {command: 'curve', x: 200, y: 100, x1: 130, y1: 80, x2: 170, y2: 80}, {command: 'line', x: 200, y: 200}], ...props }));
    const editor = new Editor(doc), root = document.createElement('div'), stage = document.createElement('div'), overlay = document.createElement('div');
    root.id = 'right'; stage.append(overlay); document.body.append(root, stage);
    stage.setPointerCapture = () => {};
    const services = { editor, commands: createCommands(editor), images, view: { element: () => null }, components: {}, styles: {} } as unknown as EditorServices;
    const text = { active: false, exit: async () => {} } as any;
    let inspector: ReturnType<typeof createInspector> | undefined;
    const canvas = createCanvasInteraction(stage, overlay, services, text, {context: () => {}, changed: () => inspector?.refresh(), importFiles: async () => {}});
    editor.setSelection(['shape']);
    inspector = createInspector(root, services, text, canvas, {});
    cleanups.push(() => {inspector!.destroy(); canvas.destroy(); editor.destroy();});
    const change = (label: string, value: string) => {
        const field = root.querySelector<HTMLInputElement | HTMLSelectElement>(`[aria-label="${label}"]`)!;
        expect(field, label).not.toBeNull(); field.value = value; field.dispatchEvent(new Event('change', {bubbles: true}));
    };
    return {editor, root, stage, overlay, canvas, change, services};
}
it('edits one selected node in world coordinates, moving adjacent handles and preserving undo', () => {
    const t = setup(); t.canvas.editPath('shape'); t.change('Selected node', '1');
    expect(t.root.querySelector<HTMLInputElement>('[aria-label="Node X"]')!.value).toBe('200');
    t.change('Node X', '215.5');
    const nodes = t.editor.page.objects.shape.content;
    expect(nodes[1].x).toBe(215.5); expect(nodes[1].x2).toBe(185.5); expect(nodes[0].x).toBe(100);
    expect(t.editor.undoStep()).toBe(true); expect(t.editor.page.objects.shape.content[1].x).toBe(200);
    expect(t.editor.undoStep()).toBe(false);
});
it('changes individual node type and handle coordinates without touching another contour', () => {
    const t = setup('path', {content: [{command:'move',x:100,y:100},{command:'curve',x:200,y:100,x1:130,y1:80,x2:170,y2:80},{command:'line',x:200,y:200},{command:'close'},{command:'move',x:120,y:120},{command:'line',x:140,y:120},{command:'close'}]});
    t.canvas.editPath('shape'); t.change('Selected node', '1'); t.change('Node type', 'symmetric'); t.change('Incoming X', '180');
    const nodes = t.editor.page.objects.shape.content;
    expect(nodes[1].handleMode).toBe('symmetric'); expect(nodes[1].x2).toBe(180); expect(nodes[2].x1).toBeCloseTo(220);
    expect(nodes.slice(4)).toEqual([{command:'move',x:120,y:120},{command:'line',x:140,y:120},{command:'close'}]);
    t.change('Selected node','4'); expect(t.root.querySelector('[aria-label="Incoming X"]')).toBeNull();
    t.change('Selected node','2'); expect(t.root.querySelector('[aria-label="Outgoing X"]')).toBeNull();
});
it('selects the anchor owning an outgoing handle and refreshes the inspector', () => {
    const t = setup(); t.canvas.editPath('shape');
    const event = new MouseEvent('pointerdown',{bubbles:true,clientX:130,clientY:80,button:0}); Object.defineProperty(event,'pointerId',{value:1});
    t.overlay.querySelector<HTMLElement>('.path-control')!.dispatchEvent(event);
    expect(t.canvas.selectedPathNodes).toEqual([0]);
    expect(t.root.querySelector<HTMLInputElement>('[aria-label="Node X"]')!.value).toBe('100');
});
it('rejects precision edits on a locked shape', () => {
    const t = setup(); t.canvas.editPath('shape'); t.change('Selected node','1');
    t.editor.transact('Lock',doc => {doc.pagesById[t.editor.pageId].objects.shape.locked = true;});
    t.change('Node X','999'); expect(t.editor.page.objects.shape.content[1].x).toBe(200);
});
it('disables duplicate image processing and exposes restore without editing geometry', async () => {
    let finish!: () => void;
    const removeBackground = vi.fn(() => new Promise<void>(resolve => {finish = resolve;})), restore = vi.fn();
    const t = setup('image', {image:{src:'data:image/png;base64,AA=='},originalImage:{src:'original'}}, {available:true,removeBackground,restore});
    t.root.querySelector<HTMLButtonElement>('[aria-label="Remove background"]')!.click();
    expect(removeBackground).toHaveBeenCalledWith('shape');
    const pending = t.root.querySelector<HTMLButtonElement>('[aria-label="Removing…"]')!;
    expect(pending.disabled).toBe(true); expect(pending.getAttribute('aria-busy')).toBe('true');
    expect(t.root.querySelector<HTMLButtonElement>('[aria-label="Restore original"]')!.disabled).toBe(true);
    finish(); await Promise.resolve(); await Promise.resolve();
    t.root.querySelector<HTMLButtonElement>('[aria-label="Restore original"]')!.click(); expect(restore).toHaveBeenCalledWith('shape');
    expect(t.editor.page.objects.shape.x).toBe(100);
});
it('shows unavailable local background processing as a disabled action', () => {
    const t = setup('image',{image:{src:'data:image/png;base64,AA=='}});
    expect(t.root.querySelector<HTMLButtonElement>('[aria-label="Remove background"]')!.disabled).toBe(true);
});
it('retains an actionable image error and permits retry after processing fails', async () => {
    const removeBackground = vi.fn(async () => {throw new Error('Could not load the local background model. Try again.');});
    const t = setup('image',{image:{src:'data:image/png;base64,AA=='}}, {available:true,removeBackground,restore:vi.fn()});
    t.root.querySelector<HTMLButtonElement>('[aria-label="Remove background"]')!.click();
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(t.root.querySelector('[role="alert"]')!.textContent).toContain('Try again');
    expect(t.root.querySelector<HTMLButtonElement>('[aria-label="Remove background"]')!.disabled).toBe(false);
});
it('edits handle angle and length in world coordinates and mirrors a symmetric node', () => {
    const t = setup(); t.canvas.editPath('shape'); t.change('Selected node','1'); t.change('Node type','symmetric');
    t.change('Incoming angle (°)','90'); t.change('Incoming length','25');
    let nodes = t.editor.page.objects.shape.content;
    expect(nodes[1].x2).toBeCloseTo(200); expect(nodes[1].y2).toBeCloseTo(125);
    expect(nodes[2].x1).toBeCloseTo(200); expect(nodes[2].y1).toBeCloseTo(75);
    t.change('Outgoing angle (°)','180'); t.change('Outgoing length','40');
    nodes = t.editor.page.objects.shape.content;
    expect(nodes[2].x1).toBeCloseTo(160); expect(nodes[2].y1).toBeCloseTo(100);
    expect(nodes[1].x2).toBeCloseTo(240); expect(nodes[1].y2).toBeCloseTo(100);
    expect(t.editor.undoStep()).toBe(true);
    expect(Math.hypot(t.editor.page.objects.shape.content[2].x1 - 200, t.editor.page.objects.shape.content[2].y1 - 100)).toBeCloseTo(25);
});
it('rejects negative handle length and can extend a collapsed handle', () => {
    const t = setup(); t.canvas.editPath('shape'); t.change('Selected node','0');
    const before = structuredClone(t.editor.page.objects.shape.content);
    t.change('Outgoing length','-1'); expect(t.editor.page.objects.shape.content).toEqual(before);
    expect(document.querySelector('[role="alert"]')!.textContent).toContain('nonnegative');
    t.change('Outgoing length','0'); t.change('Outgoing length','12');
    expect(t.editor.page.objects.shape.content[1].x1).toBeCloseTo(112);
    expect(t.editor.page.objects.shape.content[1].y1).toBeCloseTo(100);
});
