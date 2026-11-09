import { afterEach, describe, expect, it } from 'vitest';
import type { Data, RenderView } from '../contracts';
import { Editor, createDocument, createShape, createPage, insertShape, validateDocument } from '../document';
import { reconcileComponents, createComponentService } from '../components';
import { reconcileStyles } from '../styles';
import { installLvMcp } from '../mcp';
import { richText, textValue } from '../formats/model';
import { SceneWriter } from '../render/scene';

const disposers: Array<() => void> = [];
afterEach(() => { while (disposers.length) disposers.pop()!(); });
function setup(options: Data = {}) {
    const doc = createDocument(), page = doc.pagesById[doc.pages[0]];
    insertShape(page, createShape('rect', { id: 'a', x: 0, y: 0, width: 100, height: 80 }));
    insertShape(page, createShape('rect', { id: 'b', x: 200, y: 0, width: 80, height: 80 }));
    insertShape(page, createShape('text', { id: 'text', content: richText('Hello world\nSecond line') }));
    const editor = new Editor(doc, { reconcile(before, draft) { reconcileComponents(before, draft); reconcileStyles(before, draft); } });
    const view = { settled: async () => {}, measure: () => new Map(), computedStyle: () => ({}), render() {}, element: () => null, destroy() {}, screenshot: async () => ({ data: 'eA==', mimeType: 'image/png' }) } as RenderView;
    const api = installLvMcp(editor, view, { ...options, services: { components: createComponentService(editor), ...options.services }, global: false });
    const call = (name: string, args: Data = {}, agent = 'a') => api.handleToolCall(agent, name, args);
    const ok = async (name: string, args: Data = {}, agent = 'a') => { const result = await call(name, args, agent); expect(result.isError, JSON.stringify(result)).not.toBe(true); return result.structuredContent!; };
    disposers.push(() => { api.dispose(); editor.destroy(); });
    return { editor, api, call, ok };
}
describe('typed editor MCP parity', () => {
    it('rejects malformed specialized frame paints and layout before committing a renderable scene', async () => {
        const { editor, call, ok } = setup(), original = structuredClone(editor.doc);
        const before = new SceneWriter(editor.page.objects).svg(['a'], { x: 0, y: 0, width: 100, height: 80 });
        for (const args of [
            { action: 'frame', ids: ['a'], fills: [{ gradient: { type: 'linear', stops: 'malformed' } }] },
            { action: 'layout', ids: ['a'], layout: { type: 'grid', columns: [null] } },
        ]) {
            expect((await call('edit_shapes', args)).isError).toBe(true);
            expect(editor.doc).toEqual(original);
            expect(new SceneWriter(editor.page.objects).svg(['a'], { x: 0, y: 0, width: 100, height: 80 })).toBe(before);
        }
        const frame = await ok('edit_shapes', { action: 'frame', ids: ['a'], fills: [{ gradient: { type: 'linear', stops: [{ offset: 0, color: '#123456' }, { offset: 1, color: '#abcdef' }] } }] });
        expect(new SceneWriter(editor.page.objects).svg(frame.rawIds, { x: 0, y: 0, width: 100, height: 80 })).toContain('#123456');
    });
    it('creates, copies, names, orders and deletes pages, guards the final page and stale aliases', async () => {
        const { editor, ok, call } = setup();
        const first = editor.pageId, before = await ok('get_tree', { id: 'a' }), alias = before.tree.id;
        const created = await ok('page', { action: 'create', name: 'Second' });
        expect(editor.pageId).toBe(created.pageId);
        expect((await call('update', { id: alias, attrs: { name: 'Wrong page' } })).isError).toBe(true);
        const shape = await ok('create_shape', { type: 'star', x: 5, y: 10, width: 80, height: 70, properties: { name: 'Star', primitive: { count: 6, ratio: .4 } } });
        const copied = await ok('page', { action: 'duplicate', pageId: created.pageId });
        expect(copied.pageId).not.toBe(created.pageId);
        expect(Object.values(editor.page.objects).find(s => s.name === 'Star')?.id).not.toBe(shape.rawIds[0]);
        await ok('page', { action: 'rename', pageId: copied.pageId, name: 'Copy' });
        await ok('page', { action: 'reorder', pageId: copied.pageId, index: 0 });
        expect(editor.doc.pages[0]).toBe(copied.pageId);
        await ok('page', { action: 'delete', pageId: first });
        await ok('page', { action: 'delete', pageId: created.pageId });
        expect((await call('page', { action: 'delete', pageId: copied.pageId })).isError).toBe(true);
        expect(editor.doc.pages).toEqual([copied.pageId]); validateDocument(editor.doc);
    });
    it('uses explicit ids for geometry, grouping, masks and native property deletion with one agent operation', async () => {
        const { editor, ok, call } = setup(); editor.setSelection(['text']);
        await ok('edit_shapes', { action: 'translate', ids: ['a', 'b'], dx: 12, dy: 8 });
        expect(editor.page.objects.a.x).toBe(12); expect(editor.page.objects.text.x).toBe(0);
        const group = await ok('edit_shapes', { action: 'group', ids: ['a', 'b'] });
        expect(editor.page.objects[group.rawIds[0]].childIds).toEqual(['a', 'b']);
        expect(editor.lastOperation?.author).toBe('a');
        await ok('edit_shapes', { action: 'patch', ids: group.ids, properties: { clip: { x: 0, y: 0, width: 20, height: 20 } } });
        await ok('edit_shapes', { action: 'patch', ids: group.ids, properties: { clip: null } });
        expect(editor.page.objects[group.rawIds[0]].clip).toBeUndefined();
        await ok('edit_shapes', { action: 'ungroup', ids: group.ids });
        const mask = await ok('edit_shapes', { action: 'mask', ids: ['a', 'b'], mode: 'vector' });
        expect(editor.page.objects[mask.rawIds[0]].maskType).toBe('vector');
        const before = editor.doc;
        expect((await call('batch', { ops: [{ tool: 'edit_shapes', args: { action: 'translate', ids: ['a'], dx: 5, dy: 0 } }, { tool: 'edit_shapes', args: { action: 'patch', ids: ['missing'], properties: { name: 'Rejected' } } }] })).isError).toBe(true);
        expect(editor.doc).toBe(before);
    });
    it('cannot mutate protected layers through either typed tools or legacy writes', async () => {
        const { editor, ok, call } = setup();
        await ok('edit_shapes', { action: 'patch', ids: ['a'], properties: { locked: true } });
        for (const [name, args] of [['update', { id: 'a', attrs: { name: 'Forbidden' } }], ['delete', { ids: ['a'] }], ['duplicate', { id: 'a' }], ['edit_shapes', { action: 'patch', ids: ['a'], properties: { locked: false, name: 'Forbidden' } }]] as [string, Data][]) expect((await call(name, args)).isError).toBe(true);
        await ok('edit_shapes', { action: 'patch', ids: ['a'], properties: { locked: false } });
        expect(editor.page.objects.a.locked).toBe(false);
        const group = await ok('edit_shapes', { action: 'group', ids: ['a', 'b'] });
        await ok('edit_shapes', { action: 'patch', ids: group.ids, properties: { hidden: true } });
        expect((await call('edit_shapes', { action: 'patch', ids: ['a'], properties: { hidden: false } })).isError).toBe(true);
        await ok('edit_shapes', { action: 'patch', ids: group.ids, properties: { hidden: false } });
    });
    it('preserves rich text runs and unaffected paragraphs across range style and replacement', async () => {
        const { editor, ok, call } = setup();
        await ok('edit_text', { id: 'text', action: 'range_style', range: { start: 6, end: 11 }, style: { fontWeight: 700, fills: [{ color: '#123456' }] } });
        expect(editor.page.objects.text.content.children[0].children.map((r: Data) => [r.text, r.fontWeight])).toEqual([['Hello ', undefined], ['world', 700]]);
        await ok('edit_text', { id: 'text', action: 'replace', range: { start: 6, end: 11 }, text: 'Canvas' });
        expect(textValue(editor.page.objects.text)).toBe('Hello Canvas\nSecond line');
        await ok('edit_text', { id: 'text', action: 'paragraph_style', range: { start: 13, end: 23 }, style: { listType: 'ordered', paragraphIndent: 12 } });
        expect(editor.page.objects.text.content.children[1].listType).toBe('ordered');
        const before = editor.doc;
        expect((await call('edit_text', { id: 'text', action: 'range_style', range: { start: 0, end: 999 }, style: { fontWeight: 400 } })).isError).toBe(true); expect(editor.doc).toBe(before);
        await ok('edit_text', { id: 'text', action: 'find_replace', find: 'line', replace: 'row' });
        expect(textValue(editor.page.objects.text)).toBe('Hello Canvas\nSecond row');
    });
    it('preserves untouched paragraph formatting while replacing text and spanning line breaks', async () => {
        const { editor, ok } = setup();
        editor.transact('Fixture paragraphs', doc => { doc.pagesById[editor.pageId].objects.text.content = { type: 'richText', children: [
            { textAlign: 'left', children: [{ text: 'First', fontWeight: 400 }] },
            { textAlign: 'center', listType: 'ordered', children: [{ text: 'Second', fontWeight: 700 }] },
            { textAlign: 'right', listType: 'bullet', children: [{ text: 'Third', fontStyle: 'italic' }] }
        ] }; });
        await ok('edit_text', { id: 'text', action: 'replace', range: { start: 0, end: 1 }, text: 'X' });
        expect(editor.page.objects.text.content.children[1]).toMatchObject({ textAlign: 'center', listType: 'ordered', children: [{ text: 'Second', fontWeight: 700 }] });
        expect(editor.page.objects.text.content.children[2]).toMatchObject({ textAlign: 'right', listType: 'bullet' });
        await ok('edit_text', { id: 'text', action: 'replace', range: { start: 3, end: 8 }, text: 'Z' });
        expect(textValue(editor.page.objects.text)).toBe('XirZcond\nThird');
        expect(editor.page.objects.text.content.children[1]).toMatchObject({ textAlign: 'right', listType: 'bullet', children: [{ text: 'Third', fontStyle: 'italic' }] });
        await ok('edit_text', { id: 'text', action: 'range_style', range: { start: 0, end: 2 }, style: { highlight: { color: '#fff2a8' } } });
        await ok('edit_text', { id: 'text', action: 'range_style', range: { start: 0, end: 2 }, style: { highlight: null } });
        expect(editor.page.objects.text.content.children[0].children[0].highlight).toBeUndefined();
        await ok('edit_shapes', { action: 'patch', ids: ['text'], properties: { autoResize: 'widthAndHeight', truncate: true, maxLines: 2, leadingTrim: 'capHeight' } });
    });
    it('keeps clipboards private and accepts explicit payloads without reading the system clipboard', async () => {
        const { editor, ok, call } = setup();
        const copied = await ok('clipboard', { action: 'copy', ids: ['a'] }, 'a');
        expect((await call('clipboard', { action: 'paste' }, 'b')).isError).toBe(true);
        const pasted = await ok('clipboard', { action: 'paste', payload: copied.payload, x: 500, y: 400 }, 'b');
        expect(editor.page.objects[pasted.rawIds[0]].x).toBe(500);
        expect(editor.page.objects[pasted.rawIds[0]].y).toBe(400);
        const bad = structuredClone(copied.payload); bad.shapes[0].id = 'root'; bad.roots = ['root'];
        const before = editor.doc;
        expect((await call('clipboard', { action: 'paste', payload: bad })).isError).toBe(true); expect(editor.doc).toBe(before);
        const properties = await ok('clipboard', { action: 'copy_properties', ids: ['a'] });
        await ok('clipboard', { action: 'paste_properties', ids: ['b'], payload: properties.payload });
        expect(editor.page.objects.b.fills).toEqual(editor.page.objects.a.fills);
    });
    it('copies component pages with independent main and variant identities', async () => {
        const { editor, ok } = setup();
        await ok('component', { action: 'create', id: 'a', name: 'Button' });
        const sourcePage = editor.pageId, original = Object.values(editor.doc.components!)[0];
        const duplicated = await ok('page', { action: 'duplicate', pageId: sourcePage });
        const copied = Object.values(editor.doc.components!).find(component => component.mainPageId === duplicated.pageId)!;
        expect(copied.id).not.toBe(original.id); expect(copied.mainId).not.toBe(original.mainId);
        expect(editor.page.objects[copied.mainId].componentId).toBe(copied.id);
        expect(editor.doc.pagesById[sourcePage].objects[original.mainId].componentId).toBe(original.id);
    });
    it('transfers components as detached editable artwork when the destination lacks their source', async () => {
        const source = setup(), destination = setup();
        await source.ok('component', { action: 'create', id: 'a', name: 'Button' });
        const copied = await source.ok('clipboard', { action: 'copy', ids: ['a'] });
        const pasted = await destination.ok('clipboard', { action: 'paste', payload: copied.payload, x: 600, y: 300 });
        const shape = destination.editor.page.objects[pasted.rawIds[0]];
        expect(shape.componentId).toBeUndefined(); expect(shape.isMain).toBeUndefined();
        expect(shape.fills).toEqual(source.editor.page.objects.a.fills);
        expect(shape.x).toBe(600); validateDocument(destination.editor.doc);
    });
    it('exports only explicitly requested layers as editable JSON', async () => {
        const { ok } = setup();
        const exported = await ok('export_selection', { format: 'json', ids: ['a'] });
        expect(exported.mimeType).toBe('application/json'); expect(exported.encoding).toBe('utf8');
        expect(exported.data).toContain('"id":"a"'); expect(exported.data).not.toContain('"id":"b"'); expect(exported.data).not.toContain('Hello world');
    });
    it('rejects invalid clipboard properties and preserves proportions using native inspector semantics', async () => {
        const { editor, ok, call } = setup(); const before = editor.doc;
        expect((await call('clipboard', { action: 'paste_properties', ids: ['a'], payload: { kind: 'oh-my-canvas/properties', properties: { fills: 'not-an-array' } } })).isError).toBe(true); expect(editor.doc).toBe(before);
        expect((await call('clipboard', { action: 'paste_properties', ids: ['text'], payload: { kind: 'oh-my-canvas/properties', properties: { textFormatting: [{ children: [{ fontSize: 'huge' }] }] } } })).isError).toBe(true); expect(editor.doc).toBe(before);
        await ok('edit_shapes', { action: 'patch', ids: ['a'], properties: { constrainProportions: true, width: 100, height: 50 } });
        await ok('edit_shapes', { action: 'patch', ids: ['a'], properties: { width: 200 } });
        expect(editor.page.objects.a).toMatchObject({ width: 200, height: 100 });
        await ok('edit_shapes', { action: 'patch', ids: ['a'], properties: { width: 40, height: 60 } });
        expect(editor.page.objects.a).toMatchObject({ width: 40, height: 60 });
    });
    it('excludes unrelated pages, shared definitions and embedded image/font assets from selection exports and clipboard payloads', async () => {
        const { editor, ok } = setup();
        editor.transact('Private fixtures', doc => {
            const hidden = createPage('Secret page'); doc.pages.push(hidden.id); doc.pagesById[hidden.id] = hidden;
            doc.assets = { used: { id: 'used', kind: 'font', name: 'Selected font', family: 'Used Font', src: 'data:font/woff2;base64,eA==' }, secretFont: { id: 'secretFont', kind: 'font', name: 'SECRET_FONT', family: 'Secret Font', src: 'data:font/woff2;base64,c2VjcmV0' }, secretImage: { id: 'secretImage', kind: 'image', name: 'SECRET_IMAGE', src: 'data:image/png;base64,c2VjcmV0' } };
            doc.styles = { secret: { id: 'secret', type: 'paint', name: 'SECRET_STYLE', paints: [{ color: '#123' }] } };
            doc.pagesById[editor.pageId].objects.text.content.children[0].children[0].fontFamily = 'Used Font';
            insertShape(hidden, createShape('image', { name: 'SECRET_LAYER', image: { src: doc.assets.secretImage.src } }));
        });
        const exported = await ok('export_selection', { format: 'json', ids: ['text'] });
        const parsed = JSON.parse(exported.data); expect(Object.keys(parsed.assets)).toEqual(['used']); expect(parsed.styles).toEqual({}); expect(parsed.pages).toEqual([editor.pageId]); expect(exported.data).not.toContain('SECRET_');
        const copied = await ok('clipboard', { action: 'copy', ids: ['text'] });
        expect(Object.keys(copied.payload.assetDefinitions)).toEqual(['used']); expect(JSON.stringify(copied.payload)).not.toContain('SECRET_');
    });
    it('applies revision checks to nested text edits before the atomic batch starts', async () => {
        const { editor, ok, call } = setup(); const stale = (await ok('get_context')).revision;
        await ok('edit_shapes', { action: 'translate', ids: ['a'], dx: 4, dy: 0 }); const before = editor.doc;
        const textArgs = { id: 'text', action: 'replace', text: 'Rejected', revision: stale };
        expect((await call('edit_text', textArgs)).structuredContent?.error.code).toBe('stale_revision');
        expect((await call('batch', { ops: [{ tool: 'edit_shapes', args: { action: 'translate', ids: ['b'], dx: 10, dy: 0 } }, { tool: 'edit_text', args: textArgs }] })).structuredContent?.error.code).toBe('stale_revision'); expect(editor.doc).toBe(before);
    });
    it('queues private file exports with MCP writes and rejects changes while rendering', async () => {
        let start!: () => void, finish!: (value: string) => void;
        const started = new Promise<void>(resolve => { start = resolve; }), rendered = new Promise<string>(resolve => { finish = resolve; });
        const { editor, api, ok } = setup({ services: { export: { svg: async () => { start(); return rendered; } } } });
        const page = editor.pageId, exporting = api.exportData('a', { format: 'svg', ids: ['a'] }); await started;
        const creating = ok('page', { action: 'create', name: 'Queued after export' }); await Promise.resolve(); expect(editor.pageId).toBe(page);
        finish('<svg/>'); expect(new TextDecoder().decode((await exporting).bytes)).toBe('<svg/>'); await creating;
        let finishStale!: (value: string) => void, startStale!: () => void;
        const waitStale = new Promise<string>(resolve => { finishStale = resolve; }), startedStale = new Promise<void>(resolve => { startStale = resolve; });
        const second = setup({ services: { export: { svg: async () => { startStale(); return waitStale; } } } });
        const stale = second.api.exportData('a', { format: 'svg', ids: ['a'] }); await startedStale;
        second.editor.transact('Concurrent user edit', doc => { doc.pagesById[second.editor.pageId].name = 'Changed during export'; }); finishStale('<svg/>'); await expect(stale).rejects.toThrow(/changed during export/);
    });
    it('releases late cancelled font preparation through the dispatcher without committing the asset', async () => {
        let finish!: (release: () => void) => void, releaseCount = 0;
        const staged = new Promise<() => void>(resolve => { finish = resolve; });
        const { editor, api } = setup({ services: { fonts: { prepareAssets: () => staged } } });
        const controller = new AbortController();
        const call = api.handleToolCall('a', 'document_assets', { action: 'add', kind: 'font', name: 'Late', family: 'Late', dataUrl: 'data:font/woff2;base64,eA==' }, { signal: controller.signal });
        await Promise.resolve(); controller.abort(); expect((await call).isError).toBe(true); finish(() => { releaseCount++; });
        await new Promise(resolve => setTimeout(resolve, 0)); expect(releaseCount).toBe(1); expect(editor.doc.assets).toBeUndefined();
    });
    it('allows only agent owned redo and keeps user text sessions protected', async () => {
        const { editor, ok, call } = setup();
        await ok('create_shape', { type: 'ellipse' }); await ok('undo');
        expect((await call('redo', {}, 'b')).isError).toBe(true); await ok('redo');
        editor.begin('User typing');
        expect((await call('create_shape', { type: 'rect' })).isError).toBe(true);
        expect((await call('page', { action: 'list' })).isError).not.toBe(true);
        editor.cancelSession();
        await ok('undo'); editor.transact('User edit', doc => { doc.pagesById[editor.pageId].name = 'Changed'; });
        expect((await call('redo')).isError).toBe(true);
    });
});
