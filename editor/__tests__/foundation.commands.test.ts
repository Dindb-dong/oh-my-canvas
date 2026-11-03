/** Fresh command behavior expectations and injected-service boundary checks. */
import { describe, it, expect, vi } from 'vitest';
import { Editor, createDocument, createShape, insertShape, reparentShapes } from '../document';
import { createCommands, rotateShapes } from '../commands';
import type { Data, EditorEvent } from '../contracts';
function fixture(services: Data = {}) {
    const doc = createDocument(), page = doc.pagesById[doc.pages[0]];
    for (const props of [{ id: 'a', x: 10, y: 10, width: 20, height: 10 }, { id: 'b', x: 70, y: 30, width: 10, height: 20 }, { id: 'c', x: 110, y: 60, width: 30, height: 10 }])
        insertShape(page, createShape('rect', props));
    const editor = new Editor(doc), memory = { text: '' };
    const clipboard = { writeText: vi.fn(async (text: string) => {
            memory.text = text;
        }), readText: vi.fn(async () => memory.text), writeImage: vi.fn(async () => {
        }) };
    const dependencies = { clipboard, ...services };
    const commands = createCommands(editor, dependencies);
    editor.setSelection(['a', 'b', 'c']);
    return { editor, commands, clipboard, memory, dependencies };
}
const durable = (events: EditorEvent[]) => events.filter(event => event.changes);
describe('complete command vocabulary and document edits', () => {
    it('exposes every required command group without dummy registry records', () => {
        const { commands } = fixture();
        const ids = ['edit.undo', 'edit.redo', 'edit.delete', 'edit.copy', 'edit.cut', 'edit.paste', 'edit.paste-in-place', 'edit.paste-replace', 'edit.copy-properties', 'edit.paste-properties', 'edit.duplicate', 'edit.enter', 'layer.rename', 'layer.lock', 'layer.hide', 'file.place-image', 'struct.group', 'struct.ungroup', 'struct.mask', 'struct.frame', 'bool.union', 'bool.subtract', 'bool.intersect', 'bool.exclude', 'path.flatten', 'component.create', 'component.combine-variants', 'component.instance', 'component.add-variant', 'component.reset', 'component.detach', 'layout.add', 'layout.remove', 'order.forward', 'order.backward', 'order.front', 'order.back', 'align.left', 'align.right', 'align.top', 'align.bottom', 'align.h-center', 'align.v-center', 'distribute.h', 'distribute.v', 'arrange.tidy-up', 'transform.flip-h', 'transform.flip-v', 'view.zoom-in', 'view.zoom-out', 'view.zoom-100', 'view.zoom-fit', 'view.zoom-selection', 'view.next-frame', 'view.previous-frame', 'view.next-page', 'view.previous-page', 'view.outlines', 'view.toggle-ui', 'view.pixel-grid', 'view.rulers', 'view.layout-grids', 'view.quick-actions', 'select.all', 'select.inverse', 'select.children', 'select.parent', 'select.next', 'select.previous', 'select.matching', 'select.none', 'export.copy-png', 'export.copy-svg'];
        for (const id of ids) {
            expect(commands.get(id), id).toBeDefined();
            expect(typeof commands.get(id)?.run, id).toBe('function');
        }
        expect(commands.run('missing')).toBe(false);
    });
    it.each(['move', 'frame', 'rect', 'ellipse', 'polygon', 'star', 'line', 'arrow', 'pencil', 'pen', 'text'])('selects tool %s without editing the document', tool => {
        const { editor, commands } = fixture(), doc = editor.doc;
        expect(commands.run(`tool.${tool}`)).toBe(true);
        expect(editor.tool).toBe(tool);
        expect(editor.doc).toBe(doc);
    });
    it.each(['frame', 'rect', 'ellipse', 'polygon', 'star', 'line', 'arrow', 'pencil', 'pen', 'text', 'image', 'svg'])('creates canonical %s shape with selected identity', async (type) => {
        const { editor, commands } = fixture();
        expect(await commands.run(`shape.create-${type}`, { shape: { x: 5, y: 7, width: 80, height: 30, text: 'sample' } })).toBe(true);
        const shape = editor.page.objects[editor.selection[0]];
        expect(shape.x).toBe(5);
        expect(shape.parentId).toBe('root');
        expect(shape.type).toBe(['polygon', 'star', 'line', 'arrow', 'pencil', 'pen'].includes(type) ? 'path' : type);
        if (shape.type === 'path')
            expect(shape.content.every((s: Data) => ['move', 'line', 'curve', 'close'].includes(s.command))).toBe(true);
    });
    it.each(['left', 'right', 'top', 'bottom', 'h-center', 'v-center'])('aligns %s to the common selection extent', async (alignment) => {
        const { editor, commands } = fixture();
        await commands.run(`align.${alignment}`);
        const shapes = ['a', 'b', 'c'].map(id => editor.page.objects[id]);
        const anchors = shapes.map(s => alignment === 'left' ? s.x : alignment === 'right' ? s.x + s.width : alignment === 'top' ? s.y : alignment === 'bottom' ? s.y + s.height : alignment === 'h-center' ? s.x + s.width / 2 : s.y + s.height / 2);
        expect(new Set(anchors).size).toBe(1);
        expect(anchors[0]).toBe(({ left: 10, right: 140, top: 10, bottom: 70, 'h-center': 75, 'v-center': 40 } as Data)[alignment]);
    });
    it.each([['h', 65], ['v', 30]] as const)('distributes %s using equal free gaps', async (axis, position) => {
        const { editor, commands } = fixture();
        editor.transact('Unsymmetric', doc => {
            doc.pagesById[editor.pageId].objects.b.y = 45;
        });
        await commands.run(`distribute.${axis}`);
        expect(editor.page.objects.b[axis === 'h' ? 'x' : 'y']).toBe(position);
    });
    it.each([['forward', 'a', ['b', 'a', 'c']], ['backward', 'c', ['a', 'c', 'b']], ['front', 'a', ['b', 'c', 'a']], ['back', 'c', ['c', 'a', 'b']]] as const)('reorders %s by painter order', async (mode, id, order) => {
        const { editor, commands } = fixture();
        editor.setSelection([id]);
        await commands.run(`order.${mode}`);
        expect(editor.page.objects.root.childIds).toEqual(order);
    });
    it('tidies selection into requested columns and spacing', async () => {
        const { editor, commands } = fixture();
        await commands.run('arrange.tidy-up', { columns: 2, gap: 5 });
        expect(['a', 'b', 'c'].map(id => ({ x: editor.page.objects[id].x, y: editor.page.objects[id].y }))).toEqual([{ x: 10, y: 10 }, { x: 45, y: 10 }, { x: 10, y: 35 }]);
    });
    it.each([['left', -1, 0], ['right', 1, 0], ['up', 0, -1], ['down', 0, 1]] as const)('nudges %s by one and ten', async (direction, dx, dy) => {
        const { editor, commands } = fixture();
        editor.setSelection(['a']);
        await commands.run(`nudge.${direction}`);
        await commands.run(`nudge.${direction}-10`);
        expect(editor.page.objects.a.x).toBe(10 + 11 * dx);
        expect(editor.page.objects.a.y).toBe(10 + 11 * dy);
    });
    it.each(Array.from({ length: 10 }, (_, i) => i))('sets opacity digit %s', async (digit) => {
        const { editor, commands } = fixture();
        editor.setSelection(['a']);
        await commands.run(`layer.opacity-${digit}`);
        expect(editor.page.objects.a.opacity).toBe(digit === 0 ? 1 : digit / 10);
    });
    it('groups, masks, unmasks and ungroups without changing world coordinates', async () => {
        const { editor, commands } = fixture();
        editor.setSelection(['b', 'a']);
        await commands.run('struct.mask', { mode: 'luminance' });
        const id = editor.selection[0], group = editor.page.objects[id];
        expect(group.childIds).toEqual(['a', 'b']);
        expect(group.maskType).toBe('luminance');
        expect(group.isMaskGroup).toBe(true);
        expect(editor.page.objects.a.x).toBe(10);
        await commands.run('struct.mask');
        expect(editor.page.objects[id].isMaskGroup).toBeUndefined();
        await commands.run('struct.ungroup');
        expect(editor.page.objects[id]).toBeUndefined();
        expect(editor.page.objects.root.childIds).toEqual(['a', 'b', 'c']);
    });
    it('frames selection and removes layout without moving children', async () => {
        const { editor, commands } = fixture();
        editor.setSelection(['a', 'b']);
        await commands.run('struct.frame');
        const id = editor.selection[0];
        expect(editor.page.objects[id].type).toBe('frame');
        await commands.run('layout.add', { direction: 'column', gap: 7, padding: 4 });
        expect(editor.page.objects[id].layout).toMatchObject({ type: 'flex', direction: 'column', gap: { row: 7, column: 7 }, padding: { top: 4, right: 4, bottom: 4, left: 4 } });
        await commands.run('layout.remove');
        expect(editor.page.objects[id].layout).toBeUndefined();
        expect(editor.page.objects.a.x).toBe(10);
    });
    it('rotates a subtree and flips selection with world-oriented path data', () => {
        const { editor, commands } = fixture();
        editor.transact('Vector', doc => {
            const page = doc.pagesById[editor.pageId];
            insertShape(page, createShape('group', { id: 'g', x: 0, y: 0, width: 100, height: 100, childIds: [] }));
            insertShape(page, createShape('line', { id: 'line', x: 0, y: 0, width: 100, height: 100 }), 'g');
            rotateShapes(page, ['g'], 90, { x: 50, y: 50 });
        });
        expect(editor.page.objects.line.rotation).toBe(90);
        expect(editor.page.objects.line.content[0].x).toBeCloseTo(100);
        editor.setSelection(['a', 'b']);
        commands.run('transform.flip-h');
        expect(editor.page.objects.a.x).toBe(60);
        expect(editor.page.objects.b.x).toBe(10);
        expect(editor.page.objects.a.flipX).toBe(true);
    });
    it('renames, locks/unlocks, hides/unhides and deletes actual records', async () => {
        const rename = vi.fn(async () => 'Renamed'), { editor, commands } = fixture({ rename });
        editor.setSelection(['a']);
        await commands.run('layer.rename');
        expect(editor.page.objects.a.name).toBe('Renamed');
        commands.run('layer.lock');
        expect(commands.enabled('edit.duplicate')).toBe(false);
        commands.run('layer.lock');
        commands.run('layer.hide');
        expect(editor.page.objects.a.hidden).toBe(true);
        commands.run('layer.hide');
        commands.run('edit.delete');
        expect(editor.page.objects.a).toBeUndefined();
        expect(editor.selection).toEqual([]);
    });
});
describe('selection, viewport, callbacks and plugin bridges', () => {
    it('selects all/inverse/none, siblings, parent, children and matching types', async () => {
        const { editor, commands } = fixture();
        commands.run('select.none');
        expect(editor.selection).toEqual([]);
        commands.run('select.next');
        expect(editor.selection).toEqual(['a']);
        commands.run('select.previous');
        expect(editor.selection).toEqual(['c']);
        commands.run('select.inverse');
        expect(editor.selection).toEqual(['a', 'b']);
        commands.run('select.all');
        expect(editor.selection).toEqual(['a', 'b', 'c']);
        editor.setSelection(['a', 'b']);
        commands.run('struct.group');
        const group = editor.selection[0];
        commands.run('select.children');
        expect(editor.selection).toEqual(['a', 'b']);
        commands.run('select.parent');
        expect(editor.selection).toEqual([group]);
        editor.setSelection(['c']);
        commands.run('select.matching');
        expect(editor.selection).toEqual(['a', 'b', 'c']);
    });
    it('remembers page view, navigates frames/pages and changes every view flag', async () => {
        const { editor, commands } = fixture();
        editor.transact('Frames', doc => {
            insertShape(doc.pagesById[editor.pageId], createShape('frame', { id: 'frame1', x: 400, y: 400, width: 100, height: 100 }));
            insertShape(doc.pagesById[editor.pageId], createShape('frame', { id: 'frame2', x: 700, y: 400, width: 100, height: 100 }));
        });
        editor.setSelection([]);
        commands.run('view.next-frame');
        expect(editor.selection).toEqual(['frame1']);
        commands.run('view.next-frame');
        expect(editor.selection).toEqual(['frame2']);
        commands.run('view.previous-frame');
        expect(editor.selection).toEqual(['frame1']);
        for (const [id, field] of [['outlines', 'showOutlines'], ['rulers', 'showRulers'], ['layout-grids', 'showGrids'], ['toggle-ui', 'uiHidden'], ['pixel-grid', 'pixelSnap']]) {
            commands.run(`view.${id}`);
            expect(editor[field]).toBe(true);
        }
        commands.run('view.zoom-100');
        commands.run('view.zoom-in');
        expect(editor.viewport.zoom).toBeCloseTo(1.2);
        commands.run('view.zoom-out');
        expect(editor.viewport.zoom).toBeCloseTo(1);
        const original = editor.pageId;
        await commands.run('page.add', { name: 'New' });
        await Promise.resolve();
        expect(editor.page.name).toBe('New');
        commands.run('view.previous-page');
        expect(editor.pageId).toBe(original);
        commands.run('view.next-page');
        expect(editor.page.name).toBe('New');
    });
    it('routes Enter text/path, quick actions and image preparation callbacks', async () => {
        const edit = vi.fn(), editPath = vi.fn(), openQuickActions = vi.fn(), { editor, commands } = fixture({ edit, editPath, openQuickActions });
        await commands.run('shape.create-text', { shape: { text: 'hello' } });
        const text = editor.selection[0];
        commands.run('edit.enter');
        expect(edit).toHaveBeenCalledWith(text);
        await commands.run('shape.create-pen');
        commands.run('edit.enter');
        expect(editPath).toHaveBeenCalledWith(editor.selection[0]);
        commands.run('view.quick-actions');
        expect(openQuickActions).toHaveBeenCalledOnce();
    });
    it('maps all component commands to action names and applies returned selection', async () => {
        const run = vi.fn((_action: string, _args: Data) => ({ selection: ['b'] })), { editor, commands } = fixture({ components: { run } });
        for (const [command, action] of [['create', 'create'], ['combine-variants', 'combine'], ['instance', 'instance'], ['add-variant', 'add_variant'], ['reset', 'reset'], ['detach', 'detach']]) {
            editor.setSelection(['a']);
            await commands.run(`component.${command}`);
            expect(run.mock.calls.at(-1)?.[0]).toBe(action);
            expect(editor.selection).toEqual(['b']);
        }
    });
    it('places multiple prepared images side by side in one operation', async () => {
        const { editor, commands } = fixture(), events: EditorEvent[] = [];
        editor.on(event => events.push(event));
        await commands.run('file.place-image', { images: [{ src: 'data:image/png;base64,A', width: 40, height: 30 }, { src: 'data:image/png;base64,B', width: 60, height: 20 }], x: 100, y: 200 });
        expect(editor.selection).toHaveLength(2);
        const [a, b] = editor.selection.map(id => editor.page.objects[id]);
        expect([a.x, a.y, b.x, b.y]).toEqual([100, 200, 160, 200]);
        expect(durable(events)).toHaveLength(1);
    });
    it('copies SVG and PNG through awaited export and clipboard adapters', async () => {
        const svg = vi.fn(async () => '<svg/>'), png = vi.fn(async () => new Uint8Array([1, 2, 3])), { editor, commands, clipboard, memory } = fixture({ export: { svg, png } });
        editor.setSelection(['a']);
        await commands.run('export.copy-svg');
        expect(memory.text).toBe('<svg/>');
        expect(svg).toHaveBeenCalledWith(['a']);
        await commands.run('export.copy-png');
        expect(png).toHaveBeenCalledWith('a', 1);
        expect(clipboard.writeImage).toHaveBeenCalledOnce();
    });
    it('blocks mutations but keeps read-only selection/copy while a session is active', async () => {
        const { editor, commands } = fixture();
        editor.begin('Busy');
        expect(commands.enabled('edit.delete')).toBe(false);
        expect(commands.run('edit.delete', { ids: ['a'] })).toBe(false);
        expect(await commands.run('edit.copy')).toBe(true);
        expect(commands.run('select.none')).toBe(true);
        editor.cancelSession();
    });
});
describe('clipboard preparation, properties and boolean/path commands', () => {
    it('pastes fresh IDs/internal references synchronously inside one outer operation', () => {
        const { editor, commands } = fixture(), events: EditorEvent[] = [];
        editor.on(event => events.push(event));
        let ids: string[] = [];
        editor.transact('Assets and shapes', doc => {
            doc.extra = { asset: 'prepared' };
            ids = commands.pastePrepared({ kind: 'leviosa-editor/shapes@1', roots: ['g'], objects: { g: createShape('group', { id: 'g', x: 0, y: 0, width: 20, height: 20, childIds: ['child'], maskId: 'child' }), child: createShape('rect', { id: 'child', parentId: 'g', x: 2, y: 3, width: 10, height: 10, componentSourceIds: { owner: 'child' } }) } }, { x: 100, y: 200 });
            expect(Array.isArray(ids)).toBe(true);
            expect(editor.doc.extra).toEqual({ asset: 'prepared' });
        });
        const group = editor.page.objects[ids[0]], child = editor.page.objects[group.childIds![0]];
        expect(group.maskId).toBe(child.id);
        expect(child.componentSourceIds.owner).toBe(child.id);
        expect(group.x).toBe(100);
        expect(child.x).toBe(102);
        expect(durable(events)).toHaveLength(1);
    });
    it('rolls back outer asset metadata and selection on invalid prepared records', () => {
        const { editor, commands } = fixture(), before = editor.doc, selection = [...editor.selection], events = vi.fn();
        editor.on(events);
        expect(() => editor.transact('Import', doc => {
            doc.assets = { file: 'bad' };
            commands.pastePrepared({ roots: ['p'], shapes: [createShape('path', { id: 'p', content: [{ command: 'curve', x: 0, y: 0, x1: 0, y1: 0, x2: NaN, y2: 0 }] })] });
        })).toThrow();
        expect(editor.doc).toBe(before);
        expect(editor.selection).toEqual(selection);
        expect(events).not.toHaveBeenCalled();
    });
    it('does not create an async window for supplied shape payload commands', () => {
        const { commands } = fixture();
        const result = commands.run('edit.paste', { payload: { roots: ['x'], shapes: [createShape('rect', { id: 'x' })] } });
        expect(result).toBe(true);
        expect(result).not.toBeInstanceOf(Promise);
    });
    it('rejects an OS clipboard read from within an outer candidate', () => {
        const { editor, commands } = fixture(), before = editor.doc;
        expect(() => editor.transact('Bad import', doc => {
            doc.extra = 'partial';
            commands.run('edit.paste');
        })).toThrow(/prepare clipboard/);
        expect(editor.doc).toBe(before);
    });
    it('preserves subtree painter order and duplicates with new identity', async () => {
        const { editor, commands } = fixture();
        editor.setSelection(['b', 'a']);
        await commands.run('edit.copy');
        await commands.run('edit.paste', { x: 200, y: 300 });
        const [a, b] = editor.selection.map(id => editor.page.objects[id]);
        expect(a.id).not.toBe('a');
        expect(b.id).not.toBe('b');
        expect([a.width, b.width]).toEqual([20, 10]);
        expect([a.x, a.y, b.x, b.y]).toEqual([200, 300, 260, 320]);
    });
    it('centers overselection and replaces selected layers without leaving orphans', () => {
        const { editor, commands } = fixture(), payload = { roots: ['x'], shapes: [createShape('rect', { id: 'x', x: 0, y: 0, width: 4, height: 2 })] };
        editor.setSelection(['a']);
        commands.pastePrepared(payload, {}, 'paste-in-place');
        let pasted = editor.page.objects[editor.selection[0]];
        expect([pasted.x, pasted.y]).toEqual([18, 14]);
        expect(editor.page.objects.a).toBeDefined();
        editor.setSelection(['b']);
        commands.pastePrepared(payload, {}, 'paste-replace');
        pasted = editor.page.objects[editor.selection[0]];
        expect([pasted.x, pasted.y]).toEqual([70, 30]);
        expect(editor.page.objects.b).toBeUndefined();
    });
    it('copies rich text formatting and appearance without replacing target characters', async () => {
        const { editor, commands } = fixture();
        editor.transact('Texts', doc => {
            const p = doc.pagesById[editor.pageId];
            insertShape(p, createShape('text', { id: 'source', shadows: [{ blur: 4, color: '#000' }], radiusTopLeft: 8, content: { type: 'richText', children: [{ textAlign: 'right', children: [{ text: 'Source', fontSize: 28, fontWeight: 700 }] }] } }));
            insertShape(p, createShape('text', { id: 'target', content: { type: 'richText', children: [{ children: [{ text: 'Keep me', fontSize: 12 }] }] } }));
        });
        editor.setSelection(['source']);
        await commands.run('edit.copy-properties');
        editor.setSelection(['target']);
        await commands.run('edit.paste-properties');
        const s = editor.page.objects.target;
        expect(s.content.children[0].children[0]).toMatchObject({ text: 'Keep me', fontSize: 28, fontWeight: 700 });
        expect(s.content.children[0].textAlign).toBe('right');
        expect(s.shadows[0].blur).toBe(4);
        expect(s.radiusTopLeft).toBe(8);
    });
    it('cuts only the originally copied IDs when clipboard write is delayed', async () => {
        let release: () => void = () => {
        };
        const pending = new Promise<void>(resolve => release = resolve), { editor, commands } = fixture({ clipboard: { writeText: () => pending, readText: async () => '' } });
        editor.setSelection(['a']);
        const cut = commands.run('edit.cut');
        editor.setSelection(['b']);
        release();
        await cut;
        expect(editor.page.objects.a).toBeUndefined();
        expect(editor.page.objects.b).toBeDefined();
    });
    it.each(['union', 'subtract', 'intersect', 'exclude', 'flatten'])('invokes %s backend once, commits canonical world content, and retains intended operands', async (operation) => {
        const combinePaths = vi.fn(async (_shapes: any[], _operation: string, _options: Data) => ({ segments: [{ command: 'move', x: 1, y: 2 }, { command: 'line', x: 11, y: 2 }, { command: 'line', x: 11, y: 12 }, { command: 'close' }], bounds: { x: 1, y: 2, width: 10, height: 10 }, fillRule: 'nonzero' })), { editor, commands } = fixture({ combinePaths }), events: EditorEvent[] = [];
        editor.setSelection(['a', 'b']);
        editor.on(event => events.push(event));
        await commands.run(operation === 'flatten' ? 'path.flatten' : `bool.${operation}`);
        const shape = editor.page.objects[editor.selection[0]];
        expect(combinePaths).toHaveBeenCalledOnce();
        expect(combinePaths.mock.calls[0]?.[1]).toBe(operation);
        expect(shape.rotation).toBe(0);
        expect(shape.transform).toEqual({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
        expect([shape.x, shape.y, shape.width, shape.height]).toEqual([1, 2, 10, 10]);
        expect(durable(events)).toHaveLength(1);
        if (operation === 'flatten') {
            expect(shape.type).toBe('path');
            expect(editor.page.objects.a).toBeUndefined();
        }
        else {
            expect(shape.type).toBe('boolean');
            expect(shape.booleanOperation).toBe(operation);
            expect(shape.childIds).toEqual(['a', 'b']);
        }
    });
    it('rejects a stale async boolean result without deleting current geometry', async () => {
        let release: (v: any) => void = () => {
        };
        const task = new Promise(resolve => release = resolve), { editor, commands } = fixture({ combinePaths: () => task });
        editor.setSelection(['a', 'b']);
        const operation = commands.run('bool.union');
        editor.transact('Concurrent', doc => doc.pagesById[editor.pageId].objects.c.x = 300);
        release({ segments: [], fillRule: 'nonzero' });
        await expect(operation).rejects.toThrow(/changed/);
        expect(editor.page.objects.a).toBeDefined();
        expect(editor.page.objects.b).toBeDefined();
        expect(editor.page.objects.c.x).toBe(300);
    });
    it('flattens grouped vector portions without deleting excluded text/image descendants', async () => {
        const { editor, commands } = fixture({ combinePaths: async () => ({ segments: [{ command: 'move', x: 0, y: 0 }, { command: 'line', x: 10, y: 10 }], fillRule: 'nonzero' }) });
        editor.transact('Mixed group', doc => {
            const p = doc.pagesById[editor.pageId];
            insertShape(p, createShape('group', { id: 'g', childIds: [] }));
            reparentShapes(p, ['a'], 'g');
            insertShape(p, createShape('text', { id: 'text', text: 'preserved' }), 'g');
            insertShape(p, createShape('image', { id: 'image', image: { src: 'data:image/png;base64,A' } }), 'g');
        });
        editor.setSelection(['g']);
        await commands.run('path.flatten');
        expect(editor.page.objects.text).toBeDefined();
        expect(editor.page.objects.image).toBeDefined();
        expect(editor.page.objects.g).toBeDefined();
        expect(editor.page.objects.a).toBeUndefined();
    });
    it('routes editable path node commands into one-step document transactions', async () => {
        const { editor, commands } = fixture();
        const p = createShape('path', { id: 'p', content: [{ command: 'move', x: 0, y: 0 }, { command: 'line', x: 100, y: 0 }] });
        editor.transact('Path', doc => insertShape(doc.pagesById[editor.pageId], p));
        editor.setSelection(['p']);
        commands.run('path.insert-node', { index: 1, t: .5 });
        expect(editor.page.objects.p.content[1].x).toBe(50);
        commands.run('path.move-nodes', { indices: [1], dx: 3, dy: 4 });
        expect(editor.page.objects.p.content[1]).toMatchObject({ x: 53, y: 4 });
        commands.run('path.delete-nodes', { indices: [1] });
        expect(editor.page.objects.p.content).toHaveLength(2);
        commands.run('path.close');
        expect(editor.page.objects.p.content.at(-1).command).toBe('close');
        commands.run('path.open');
        expect(editor.page.objects.p.content.at(-1).command).toBe('line');
    });
});
describe('command integration edge cases', () => {
    it('rolls back a failed backend without emitting changes', async () => {
        const { editor, commands } = fixture({ combinePaths: async () => {
                throw Error('Backend failed');
            } }), before = editor.doc, events = vi.fn();
        editor.on(events);
        await expect(commands.run('bool.union')).rejects.toThrow('Backend failed');
        expect(editor.doc).toBe(before);
        expect(events).not.toHaveBeenCalled();
    });
    it('invokes linked-main duplication helper within the existing candidate', () => {
        const call = vi.fn((doc: any, page: any, id: string) => {
            if (id !== 'a')
                return;
            expect(doc.pagesById[page.id]).toBe(page);
            const s = createShape('rect', { id: 'linked', isInstanceRoot: true, componentId: 'definition' });
            insertShape(page, s);
            return s;
        }), { editor, commands } = fixture({ duplicateComponentMain: call });
        editor.setSelection(['a']);
        commands.run('edit.duplicate');
        expect(editor.selection).toEqual(['linked']);
        expect(call).toHaveBeenCalledOnce();
    });
    it('passes mode and placement arguments to async text/import adapters', async () => {
        const pasteText = vi.fn(async () => true), importClipboard = vi.fn(async () => true), { commands, memory } = fixture({ pasteText, importClipboard });
        memory.text = 'Plain text';
        await commands.run('edit.paste-replace', { x: 4, y: 5 });
        expect(pasteText).toHaveBeenCalledWith('Plain text', { x: 4, y: 5, mode: 'paste-replace' });
        memory.text = JSON.stringify({ kind: 'html', html: '<p>Text</p>' });
        await commands.run('edit.paste-in-place', { x: 6, y: 7 });
        expect(importClipboard).toHaveBeenCalledWith({ kind: 'html', html: '<p>Text</p>' }, { x: 6, y: 7, mode: 'paste-in-place' });
    });
    it('does not claim success when optional callbacks are absent', () => {
        const { commands, editor } = fixture();
        expect(commands.run('view.quick-actions')).toBe(false);
        editor.transact('Text', doc => insertShape(doc.pagesById[editor.pageId], createShape('text', { id: 't', text: 'plain' })));
        editor.setSelection(['t']);
        expect(commands.run('edit.enter')).toBe(false);
    });
});
describe('atomic page navigation and empty-selection frame navigation', () => {
    it('publishes new page navigation in the same synchronous durable operation', () => {
        const { editor, commands } = fixture(), events: EditorEvent[] = [];
        editor.on(event => events.push(event));
        commands.run('page.add', { name: 'Immediate page' });
        expect(editor.page.name).toBe('Immediate page');
        expect(events).toHaveLength(1);
        expect(events[0].changes).toBeDefined();
        expect(events[0].page).toBe(true);
    });
    it('starts previous-frame navigation at the last frame when selection is empty', () => {
        const { editor, commands } = fixture();
        editor.transact('Frames', doc => {
            const p = doc.pagesById[editor.pageId];
            insertShape(p, createShape('frame', { id: 'first' }));
            insertShape(p, createShape('frame', { id: 'last' }));
        });
        editor.setSelection([]);
        commands.run('view.previous-frame');
        expect(editor.selection).toEqual(['last']);
    });
});
it('rolls back page navigation along with a later failure in the same outer edit', async () => {
    const { editor, commands } = fixture(), before = editor.doc, pageId = editor.pageId, events = vi.fn();
    editor.on(events);
    expect(() => editor.transact('Fail pages', () => {
        commands.run('page.add', { name: 'Never published' });
        throw Error('Later failure');
    })).toThrow('Later failure');
    await Promise.resolve();
    expect(editor.doc).toBe(before);
    expect(editor.pageId).toBe(pageId);
    expect(events).not.toHaveBeenCalled();
});

describe('command protection for mixed selections and explicit targets', () => {
    function protectedFixture(ancestorLocked: boolean, services: Data = {}) {
        const result = fixture(services), { editor } = result;
        editor.transact('Protected layers', doc => {
            const page = doc.pagesById[editor.pageId];
            insertShape(page, createShape('frame', { id: 'parent', locked: ancestorLocked }));
            if (ancestorLocked)
                reparentShapes(page, ['b'], 'parent');
            else
                page.objects.b.locked = true;
            for (const id of ['a', 'b'])
                page.objects[id].layout = { type: 'flex', direction: 'row', gap: { row: 8, column: 8 } };
        });
        editor.setSelection(['a', 'b']);
        return result;
    }
    it.each([false, true])('opacity and layout removal preserve protected layers (ancestor lock: %s)', ancestorLocked => {
        const { editor, commands } = protectedFixture(ancestorLocked), protectedShape = editor.page.objects.b;
        const events: EditorEvent[] = [];
        editor.on(event => events.push(event));
        expect(commands.enabled('layer.opacity-3')).toBe(true);
        commands.run('layer.opacity-3');
        expect(editor.page.objects.a.opacity).toBe(.3);
        expect(editor.page.objects.b).toBe(protectedShape);
        commands.run('layout.remove');
        expect(editor.page.objects.a.layout).toBeUndefined();
        expect(editor.page.objects.b).toBe(protectedShape);
        expect(editor.page.objects.b.layout.gap).toEqual({ row: 8, column: 8 });
        expect(durable(events)).toHaveLength(2);
    });
    it.each([false, true])('explicit rename cannot bypass a protected target (ancestor lock: %s)', async ancestorLocked => {
        const rename = vi.fn(async () => 'Forbidden'), { editor, commands } = protectedFixture(ancestorLocked, { rename });
        const before = editor.doc;
        await commands.run('layer.rename', { id: 'b', name: 'Forbidden' });
        await commands.run('layer.rename', { id: 'b' });
        expect(editor.doc).toBe(before);
        expect(rename).not.toHaveBeenCalled();
        await commands.run('layer.rename', { id: 'a', name: 'Allowed' });
        expect(editor.page.objects.a.name).toBe('Allowed');
    });
    const pathActions: [string, Data][] = [
        ['path.insert-node', { index: 1, t: .5 }],
        ['path.delete-nodes', { indices: [1] }],
        ['path.move-nodes', { indices: [1], dx: 10, dy: 5 }],
        ['path.handle', { index: 1, handle: 'incoming', point: { x: 4, y: 5 } }],
        ['path.close', {}], ['path.open', {}],
        ['path.mirror', { index: 1, mode: 'none' }],
        ['path.convert-node', { index: 1, kind: 'curve' }],
        ['path.primitive', { primitive: { kind: 'star', count: 7, ratio: .5 } }],
        ['path.join', {}], ['path.merge', {}]
    ];
    it.each(pathActions)('%s does not mutate an explicit own-locked or ancestor-locked path', (command, args) => {
        for (const ancestorLocked of [false, true]) {
            const { editor, commands } = protectedFixture(ancestorLocked);
            editor.transact('Path content', doc => {
                const page = doc.pagesById[editor.pageId];
                const old = page.objects.b;
                page.objects.b = createShape('path', { id: 'b', parentId: old.parentId, locked: old.locked, content: [
                    { command: 'move', x: 0, y: 0 },
                    { command: 'curve', x1: 10, y1: 20, x2: 20, y2: 20, x: 30, y: 0 },
                    { command: 'line', x: 40, y: 10 }
                ] });
            });
            const before = editor.doc, events: EditorEvent[] = [];
            editor.on(event => events.push(event));
            if (command === 'path.join' || command === 'path.merge')
                expect(() => commands.run(command, { id: 'b', ...args })).toThrow('Select a path');
            else
                commands.run(command, { id: 'b', ...args });
            expect(editor.doc, `${command}, ancestor lock ${ancestorLocked}`).toBe(before);
            expect(durable(events)).toHaveLength(0);
        }
    });
    it('toggles own locks and hidden flags while preserving ancestor-locked descendants', () => {
        const { editor, commands } = protectedFixture(true);
        commands.run('layer.lock');
        expect(editor.page.objects.a.locked).toBe(true);
        expect(editor.page.objects.b.locked).toBe(false);
        commands.run('layer.lock');
        expect(editor.page.objects.a.locked).toBe(false);
        commands.run('layer.hide');
        expect(editor.page.objects.a.hidden).toBe(true);
        expect(editor.page.objects.b.hidden).toBe(false);
        commands.run('layer.hide');
        expect(editor.page.objects.a.hidden).toBe(false);
        editor.setSelection(['b']);
        expect(commands.enabled('layer.lock')).toBe(false);
        expect(commands.enabled('layer.hide')).toBe(false);
        const before = editor.doc;
        commands.run('layer.lock', { id: 'b', value: true });
        commands.run('layer.hide', { id: 'b', value: true });
        expect(editor.doc).toBe(before);
    });
    it('does not mutate a selected child after its selected parent becomes locked', () => {
        const { editor, commands } = protectedFixture(true);
        commands.run('layer.lock', { id: 'parent', value: false });
        editor.setSelection(['parent', 'b']);
        commands.run('layer.lock');
        expect(editor.page.objects.parent.locked).toBe(true);
        expect(editor.page.objects.b.locked).toBe(false);
    });
    it('does not hide an own-locked node and still permits explicitly unlocking it', () => {
        const { editor, commands } = protectedFixture(false), before = editor.doc;
        commands.run('layer.hide', { id: 'b', value: true });
        expect(editor.doc).toBe(before);
        commands.run('layer.lock', { id: 'b' });
        expect(editor.page.objects.b.locked).toBe(false);
    });
});
