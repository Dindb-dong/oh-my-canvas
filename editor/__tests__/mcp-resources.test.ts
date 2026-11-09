import { describe, it, expect, vi } from 'vitest';
import type { CanvasDocument, Data } from '../contracts';
import { Editor, createDocument, createPage, createShape, insertShape } from '../document';
import { reconcileComponents } from '../components';
import { reconcileStyles } from '../styles';
import { reconcileLibraries } from '../assets';
import { applyResourceOperation, readResourceOperation, prepareResourceOperation, isResourceRead } from '../mcp/resources';

const pixel = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=';
function setup() {
    const doc = createDocument({ pageId: 'a' });
    insertShape(doc.pagesById.a, createShape('frame', { id: 'board', width: 200, height: 120, childIds: [] }));
    insertShape(doc.pagesById.a, createShape('rect', { id: 'shape', width: 20, height: 30 }), 'board');
    const editor = new Editor(doc, { reconcile(before, draft) {
        reconcileLibraries(before, draft);
        reconcileComponents(before, draft);
        reconcileStyles(before, draft);
    } });
    const events: Data[] = [];
    editor.on(event => { if (event.changes) events.push(event); });
    const apply = (name: string, args: Data) => editor.transact({ id: crypto.randomUUID(), author: 'agent-a', label: 'agent:agent-a' }, draft => applyResourceOperation(name, args, draft, editor.pageId, {}));
    const read = (name: string, args: Data) => readResourceOperation(name, args, editor.doc, editor.pageId, {});
    return { editor, apply, read, events };
}
function kit(version = 1): Data {
    const main = createShape('frame', { id: 'button-main', name: 'Button', x: 10, y: 10, width: 100, height: 40, childIds: [] });
    return { id: 'kit', name: 'Local kit', version, enabled: true, components: { button: { id: 'button', name: 'Button', mainId: main.id, properties: [] } }, objects: { [main.id]: main }, styles: {}, variantSets: {} };
}

describe('MCP resource operations', () => {
    it('reuses shared style updates and one attributed transaction, preserving overrides and detaching values', () => {
        const { editor, apply, read, events } = setup();
        const { style } = apply('styles', { action: 'create', type: 'paint', name: 'Color/Brand', value: [{ color: '#ff0000' }], description: 'Primary' });
        apply('styles', { action: 'apply', id: style.id, ids: ['shape'] });
        expect(editor.page.objects.shape.fills).toEqual([{ color: '#ff0000' }]);
        expect(read('styles', { action: 'users', id: style.id }).users).toEqual([{ pageId: 'a', id: 'shape' }]);
        const before = events.length;
        apply('styles', { action: 'update', id: style.id, patch: { name: 'Color/Action', value: [{ color: '#00ff00' }] } });
        expect(events.length - before).toBe(1);
        expect(events.at(-1)?.operation.author).toBe('agent-a');
        expect(events.at(-1)?.operation.label).toBe('agent:agent-a');
        expect(editor.page.objects.shape.fills).toEqual([{ color: '#00ff00' }]);
        const duplicate = apply('styles', { action: 'duplicate', id: style.id }).style;
        expect(duplicate.id).not.toBe(style.id);
        expect(duplicate.description).toBe('Primary');
        apply('styles', { action: 'detach', ids: ['shape'], kind: 'fill' });
        apply('styles', { action: 'delete', id: style.id });
        expect(editor.page.objects.shape.fillStyleId).toBeUndefined();
        expect(editor.page.objects.shape.fills).toEqual([{ color: '#00ff00' }]);
        expect(read('styles', { action: 'list', query: 'action' }).styles.map((s: Data) => s.id)).toEqual([duplicate.id]);
        editor.destroy();
    });

    it('targets the active page when imported pages contain identical raw IDs', () => {
        const { editor, apply } = setup();
        editor.transact('Second page', doc => {
            doc.pages.push('b');
            doc.pagesById.b = createPage('B', 'b');
            insertShape(doc.pagesById.b, createShape('rect', { id: 'shape', width: 10, height: 10 }));
        });
        editor.setPage('b');
        const { style } = apply('styles', { action: 'create', type: 'paint', name: 'Blue', value: [{ color: '#0000ff' }] });
        apply('styles', { action: 'apply', id: style.id, ids: ['shape'] });
        expect(editor.doc.pagesById.a.objects.shape.fillStyleId).toBeUndefined();
        expect(editor.doc.pagesById.b.objects.shape.fillStyleId).toBe(style.id);
        apply('styles', { action: 'detach', ids: ['shape'] });
        expect(editor.doc.pagesById.b.objects.shape.fillStyleId).toBeUndefined();
        editor.destroy();
    });

    it('rejects protected and nonexistent targets without a partial apply or hostile style payload', () => {
        const { editor, apply } = setup();
        const { style } = apply('styles', { action: 'create', type: 'paint', name: 'Red', value: [{ color: '#ff0000' }] });
        for (const ids of [['shape', 'missing'], ['shape', 'shape'], ['root']]) {
            const before = editor.doc;
            expect(() => apply('styles', { action: 'apply', id: style.id, ids })).toThrow();
            expect(editor.doc).toBe(before);
        }
        editor.transact('Lock parent', doc => { doc.pagesById.a.objects.board.locked = true; });
        const before = editor.doc;
        expect(() => apply('styles', { action: 'apply', id: style.id, ids: ['shape'] })).toThrow(/editable/);
        expect(() => apply('styles', { action: 'update', id: style.id, patch: { type: 'text' } })).toThrow(/patches/);
        expect(() => apply('styles', { action: 'create', type: 'text', name: 'Bad', value: { fontSize: Infinity } })).toThrow(/finite JSON/);
        expect(() => apply('styles', { action: 'create', type: 'text', name: 'Bad', value: { fontSize: 'large' } })).toThrow(/Invalid style/);
        expect(() => apply('styles', { action: 'create', type: 'paint', name: 'Bad', value: [null] })).toThrow(/paint records/);
        expect(() => apply('styles', { action: 'create', type: 'paint', name: 'Bad', value: [{ gradient: { stops: [null] } }] })).toThrow(/object/);
        expect(() => apply('styles', { action: 'create', type: 'paint', name: 'Remote', value: [{ image: { src: 'file:///private/image.png' } }] })).toThrow(/embedded/);
        expect(editor.doc).toBe(before);
        editor.destroy();
    });

    it('links, updates, inserts, exports and removes libraries while retaining local instances', () => {
        const { editor, apply, read, events } = setup();
        apply('libraries', { action: 'add', snapshot: kit() });
        expect(editor.doc.pagesById['library-page:kit'].objects['library:kit:button-main'].isMain).toBe(true);
        const placed = apply('libraries', { action: 'insert', id: 'kit', componentId: 'button', parentId: 'board', x: 40, y: 50 });
        const id = placed.selection[0];
        expect(editor.page.objects[id]).toMatchObject({ x: 40, y: 50, parentId: 'board', componentId: 'library:kit:button' });
        const revised = kit(2);
        revised.objects['button-main'].width = 150;
        const before = events.length;
        apply('libraries', { action: 'update', id: 'kit', snapshot: revised });
        expect(events.length - before).toBe(1);
        expect(editor.page.objects[id].width).toBe(150);
        const exported = read('libraries', { action: 'export', id: 'kit' }).snapshot;
        expect(exported.version).toBe(2);
        exported.name = 'Untrusted changed copy';
        expect(editor.doc.libraries?.kit.name).toBe('Local kit');
        apply('libraries', { action: 'enable', id: 'kit', enabled: false });
        expect(() => apply('libraries', { action: 'insert', id: 'kit', componentId: 'button' })).toThrow(/disabled/);
        expect(editor.page.objects[id]).toBeDefined();
        apply('libraries', { action: 'remove', id: 'kit' });
        expect(editor.doc.libraries?.kit).toBeUndefined();
        expect(editor.page.objects[id]).toBeDefined();
        expect(editor.doc.pagesById['library-page:kit'].isLibrary).toBeUndefined();
        editor.destroy();
    });

    it('rolls back broken library graphs, source identity conflicts and remote asset sources', () => {
        const { editor, apply } = setup();
        const broken = kit();
        broken.objects['button-main'].childIds = ['missing'];
        const before = editor.doc;
        expect(() => apply('libraries', { action: 'add', snapshot: broken })).toThrow(/Missing|missing/);
        expect(editor.doc).toBe(before);
        const remote = kit();
        remote.objects['button-main'].fills = [{ image: { src: 'https://example.com/tracker.png' } }];
        expect(() => apply('libraries', { action: 'add', snapshot: remote })).toThrow(/embedded/);
        expect(editor.doc).toBe(before);
        apply('libraries', { action: 'add', snapshot: kit() });
        const linked = editor.doc;
        expect(() => apply('libraries', { action: 'add', snapshot: kit() })).toThrow(/already exists/);
        expect(editor.doc).toBe(linked);
        editor.destroy();
    });

    it('creates embedded assets, protects destinations and preserves placed data after removing catalog entries', () => {
        const { editor, apply, read } = setup();
        const { asset } = apply('document_assets', { action: 'add', kind: 'image', name: 'Pixel', dataUrl: pixel, width: 1, height: 1 });
        expect(asset).toMatchObject({ kind: 'image', name: 'Pixel', width: 1, embedded: true });
        expect(asset.src).toBeUndefined();
        const { selection } = apply('document_assets', { action: 'place', id: asset.id, parentId: 'board', x: 10, y: 20 });
        expect(editor.page.objects[selection[0]]).toMatchObject({ parentId: 'board', image: { src: pixel }, x: 10, y: 20 });
        const before = editor.doc;
        expect(() => apply('document_assets', { action: 'place', id: asset.id, parentId: 'shape' })).toThrow(/container/);
        expect(() => apply('document_assets', { action: 'add', id: asset.id, kind: 'image', name: 'Overwrite', dataUrl: pixel })).toThrow(/already exists/);
        expect(() => apply('document_assets', { action: 'add', id: '__proto__', kind: 'image', name: 'Unsafe', dataUrl: pixel })).toThrow(/Invalid/);
        expect(editor.doc).toBe(before);
        apply('document_assets', { action: 'remove', id: asset.id });
        expect(read('document_assets', { action: 'list' }).assets).toEqual([]);
        expect(editor.page.objects[selection[0]].image.src).toBe(pixel);
        editor.destroy();
    });

    it('stages fonts before mutation, keeps stable IDs and does not persist a rejected font', async () => {
        const { editor, apply } = setup();
        const release = vi.fn(), prepareAssets = vi.fn(async (_assets: Data) => release);
        const args = { action: 'add', kind: 'font', name: 'Custom Sans.woff2', family: 'Custom Sans', dataUrl: 'data:font/woff2;base64,AAAA', weight: '100 900' };
        const before = editor.doc;
        const prepared = await prepareResourceOperation('document_assets', args, editor.doc, editor.pageId, { fonts: { prepareAssets } });
        expect(editor.doc).toBe(before);
        expect(prepareAssets).toHaveBeenCalledTimes(1);
        expect(prepareAssets.mock.calls[0][0][prepared.args.id]).toMatchObject({ family: 'Custom Sans', src: args.dataUrl });
        const result = apply('document_assets', prepared.args);
        expect(result.asset.id).toBe(prepared.args.id);
        prepared.release?.();
        expect(release).toHaveBeenCalledOnce();
        const saved = editor.doc;
        await expect(prepareResourceOperation('document_assets', args, saved, editor.pageId, { fonts: { prepareAssets: async () => { throw Error('Corrupt font'); } } })).rejects.toThrow(/Corrupt/);
        expect(editor.doc).toBe(saved);
        editor.destroy();
    });

    it('rejects malformed asset encoding, MIME mismatches and dangerous JSON keys', () => {
        const { editor, apply } = setup();
        const before = editor.doc;
        for (const dataUrl of ['https://example.com/a.png', 'data:image/png;base64,@@@=', 'data:image/png;base64,', 'data:text/html;base64,AAAA'])
            expect(() => apply('document_assets', { action: 'add', kind: 'image', name: 'Bad', dataUrl })).toThrow();
        expect(() => apply('styles', { action: 'create', type: 'text', name: 'Prototype', value: JSON.parse('{"__proto__":{"polluted":true}}') })).toThrow(/Unsafe/);
        expect(editor.doc).toBe(before);
        expect(({} as Data).polluted).toBeUndefined();
        editor.destroy();
    });

    it('releases staged fonts when a cancelled preparation completes late', async () => {
        const { editor } = setup();
        const controller = new AbortController(), release = vi.fn();
        let finish!: (value: () => void) => void;
        const loaded = new Promise<() => void>(resolve => { finish = resolve; });
        const task = prepareResourceOperation('document_assets', { action: 'add', kind: 'font', name: 'Late', family: 'Late', dataUrl: 'data:font/woff2;base64,AAAA' }, editor.doc, editor.pageId, { fonts: { prepareAssets: () => loaded } }, controller.signal);
        controller.abort(Error('Cancelled'));
        finish(release);
        await expect(task).rejects.toThrow(/Cancelled/);
        expect(release).toHaveBeenCalledOnce();
        expect(editor.doc.assets).toBeUndefined();
        editor.destroy();
    });

    it('stages copied font definitions while reusing identical faces and preserving colliding assets', async () => {
        const { editor, apply } = setup();
        const existing = apply('document_assets', { action: 'add', id: 'existing', kind: 'font', name: 'Existing', family: 'Existing', dataUrl: 'data:font/woff2;base64,AAAA' }).asset;
        const release = vi.fn(), prepareAssets = vi.fn(async (_assets: Data) => release);
        const font = { id: existing.id, kind: 'font', name: 'Copied', family: 'Copied', src: 'data:font/woff2;base64,AQID' };
        const args = { action: 'paste', payload: { kind: 'oh-my-canvas/shapes', roots: [], shapes: [], assetDefinitions: { [font.id]: font } } };
        const prepared = await prepareResourceOperation('clipboard', args, editor.doc, editor.pageId, { fonts: { prepareAssets } });
        const assets = prepared.args.preparedAssets;
        expect(Object.keys(assets)).toHaveLength(1);
        expect(Object.keys(assets)[0]).not.toBe(existing.id);
        expect(Object.values<Data>(assets)[0]).toMatchObject({ family: 'Copied', src: font.src });
        expect(editor.doc.assets.existing.family).toBe('Existing');
        prepared.release?.();
        const sameFace = await prepareResourceOperation('clipboard', { ...args, payload: { ...args.payload, assetDefinitions: { existing: editor.doc.assets.existing } } }, editor.doc, editor.pageId, { fonts: { prepareAssets } });
        expect(sameFace.args.preparedAssets).toBeUndefined();
        expect(prepareAssets).toHaveBeenCalledOnce();
        await expect(prepareResourceOperation('clipboard', { ...args, payload: { ...args.payload, assetDefinitions: { bad: { ...font, src: 'file:///private/font.woff2' } } } }, editor.doc, editor.pageId, { fonts: { prepareAssets } })).rejects.toThrow(/base64 data URL/);
        editor.destroy();
    });

    it('classifies only explicit read actions without modifying state', () => {
        expect(isResourceRead('styles', { action: 'get' })).toBe(true);
        expect(isResourceRead('libraries', { action: 'export' })).toBe(true);
        expect(isResourceRead('document_assets', { action: 'list' })).toBe(true);
        expect(isResourceRead('document_assets', { action: 'add' })).toBe(false);
        expect(isResourceRead('unknown', { action: 'list' })).toBe(false);
        const { editor, read } = setup();
        const before = editor.doc;
        expect(read('libraries', { action: 'list' }).libraries).toEqual([]);
        expect(read('styles', { action: 'list' }).styles).toEqual([]);
        expect(editor.doc).toBe(before);
        editor.destroy();
    });
});
