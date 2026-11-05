import { describe, it, expect, vi, afterEach } from 'vitest';
import type { Data, RenderView, EditorEvent } from '../contracts';
import { Editor, createDocument, createShape, insertShape, createPage, descendants, validateDocument } from '../document';
import { createComponentService, reconcileComponents, duplicateComponentMain } from '../components';
import { createStyleService, reconcileStyles } from '../styles';
import { applyLayout } from '../layout';
import { installLvMcp } from '../mcp';
import { TOOLS, validateToolArgs } from '../mcp/defs';
import { resolve } from 'node:path';
import { combinePaths } from '../render/vector';
import { textValue } from '../formats/model';
const cleanup: Array<() => void> = [];
afterEach(() => {
    while (cleanup.length)
        cleanup.pop()!();
    vi.useRealTimers();
});
function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>(r => resolve = r);
    return { promise, resolve };
}
function fixture(options: Data = {}) {
    const doc = createDocument(), p = doc.pagesById[doc.pages[0]];
    insertShape(p, createShape('frame', {
        id: 'board', x: 100, y: 200, width: 600, height: 400, childIds: [], fills: [], name: 'Board'
    }));
    insertShape(p, createShape('text', {
        id: 'title', x: 110, y: 210, width: 150, height: 30, name: 'Heading', dataRef: 'title', content: { type: 'richText', children: [{ children: [{
                            text: 'Hello', fontWeight: 700, fontFamily: 'Test Sans', fills: [{ color: '#123' }]
                        }] }] }
    }), 'board');
    insertShape(p, createShape('rect', {
        id: 'box', x: 300, y: 220, width: 40, height: 20, name: 'Square'
    }), 'board');
    const editor = new Editor(doc, { reconcile(before, draft) {
            reconcileComponents(before, draft);
            reconcileStyles(before, draft);
            applyLayout(draft, before);
        } });
    const events: EditorEvent[] = [];
    editor.on(e => {
        if (e.changes)
            events.push(e);
    });
    const view: RenderView = {
        settled: vi.fn(async () => {
        }), measure: vi.fn(ids => new Map(ids.filter(id => editor.page.objects[id]).map(id => {
            const s = editor.page.objects[id];
            return [id, {
                    x: s.x, y: s.y, w: s.width, h: s.height, scrollW: s.width, scrollH: s.height, clippedText: id === 'title', overflowParent: false, ...id === 'title' ? { fontFallback: 'Fallback' } : {}
                }];
        }))), computedStyle: vi.fn((id, keys) => Object.fromEntries((keys ?? ['color']).map(key => [key, key === 'color' ? 'rgb(1, 2, 3)' : '16px']))), screenshot: vi.fn(async () => ({
            data: 'cG5n', mimeType: 'image/png', slices: 3
        })), element: () => null, render: () => {
        }, destroy: () => {
        }
    };
    const components = createComponentService(editor), styles = createStyleService(editor), fonts = {
        catalog: () => [{ family: 'Test Sans', faces: [{ weight: 400, style: 'normal' }] }], ensure: vi.fn(async () => {
        }), ready: async () => {
        }, add: () => {
        }, destroy: () => {
        }
    };
    const afterWrite = vi.fn(async () => {
    }), onHighlight = vi.fn();
    const api = installLvMcp(editor, view, {
        services: {
            editor, view, components, styles, fonts, duplicateComponentMain
        }, afterWrite, onHighlight, ...options
    });
    cleanup.push(() => {
        api.dispose();
        editor.destroy();
    });
    const call = (name: string, args: Data = {}, agent = 'alpha', context: Data = {}) => api.handleToolCall(agent, name, args, context);
    const ok = async (name: string, args: Data = {}, agent = 'alpha') => {
        const result = await call(name, args, agent);
        expect(result.isError, JSON.stringify(result)).not.toBe(true);
        expect(result.content[0].type).toBe('text');
        expect(result.structuredContent?.ok).toBe(true);
        expect(result.structuredContent?.revision).toBeTypeOf('number');
        return result.structuredContent!;
    };
    return {
        editor, view, events, api, call, ok, components, fonts, afterWrite, onHighlight
    };
}
const valid: Record<string, Data> = {
    image: { id: 'x', action: 'restore', revision: 0 }, outline: { ids: ['a'], kind: 'stroke', revision: 0 }, write_svg: { svg: '<svg/>', target: 'x', position: 'last' }, get_path: { id: 'x' }, edit_path: { id: 'x', revision: 0, action: 'move_nodes', indices: [0], dx: 1, dy: 2 }, boolean: { ids: ['a', 'b'], operation: 'union', revision: 0 },
    get_context: {}, get_tree: {}, get_html: { id: 'x' }, get_styles: { ids: ['x'] }, find: { text: 'x' }, screenshot: {}, write_html: {
        html: '<div/>', target: 'x', position: 'replace'
    }, update: { id: 'x' }, move: {
        id: 'x', target: 'y', position: 'before'
    }, duplicate: { id: 'x' }, delete: { ids: ['x'] }, batch: { ops: [{ tool: 'update', args: { id: 'x', text: 'Y' } }] }, create_board: { width: 1 }, assets: {}, get_guide: {}, undo: {}, components: {}, component: { action: 'instance', source: 'component' }, fonts: {}
};
const names = [
    'get_context', 'get_tree', 'get_html', 'get_styles', 'find', 'screenshot', 'write_html', 'write_svg', 'get_path', 'edit_path', 'boolean', 'outline', 'image', 'update', 'move', 'duplicate', 'delete', 'batch', 'create_board', 'assets', 'get_guide', 'undo', 'components', 'component', 'fonts'
];
describe('MCP-01 frozen schemas', () => {
    it('exposes the vector and existing names with closed argument objects', () => {
        expect(TOOLS.map(t => t.name)).toEqual(names);
        expect(new Set(TOOLS.map(t => t.name)).size).toBe(25);
        for (const t of TOOLS)
            expect(t.inputSchema.additionalProperties).toBe(false);
    });
    it.each(names)('accepts independently specified valid args for %s', name => expect(validateToolArgs(name, valid[name])).toBeNull());
    it.each(names)('rejects unknown properties for %s', name => expect(validateToolArgs(name, { ...valid[name], unexpected: true })).toMatch(/unsupported/));
    it.each([
        ['get_tree', { depth: 0 }], ['get_tree', { depth: 1.5 }], ['get_styles', { ids: [] }], ['get_styles', { ids: Array(51).fill('x') }], ['get_styles', { ids: ['x'], keys: Array(41).fill('color') }], ['find', {}], ['screenshot', { slice: -1 }], ['delete', { ids: Array(201).fill('x') }], ['batch', { ops: [] }], ['batch', { ops: Array(101).fill({ tool: 'delete', args: { ids: ['x'] } }) }], ['batch', { ops: [{ tool: 'component', args: { action: 'create', id: 'x' } }] }], ['batch', { ops: [{ tool: 'update', args: { id: 'x', typo: 1 } }] }], ['create_board', { width: 0 }], ['create_board', { width: Infinity }], ['component', { action: 'create' }], ['component', { action: 'instance' }], ['component', { action: 'property', id: 'x' }], ['component', {
                action: 'set_property', id: 'x', property: 'p'
            }], ['component', {
                action: 'instance', source: 's', x: 1
            }], ['component', {
                action: 'property', id: 'x', propertyType: 'boolean', value: 'maybe'
            }]
    ] as Array<[
        string,
        Data
    ]>)('rejects semantic/limit case %s %#', (name, args) => expect(validateToolArgs(name, args)).not.toBeNull());
});
describe('MCP-01 all tools and measured envelopes', () => {
    it('executes every tool through real document/component/style domains', async () => {
        const f = fixture(), seen = new Set<string>();
        const run = async (name: string, args: Data = {}) => {
            seen.add(name);
            return f.ok(name, args);
        };
        const context = await run('get_context');
        expect(context.boards).toHaveLength(1);
        expect(context.boards[0]).toBeTypeOf('string');
        expect((await run('get_tree', { id: 'board', detail: 'detailed' })).tree.children).toHaveLength(2);
        expect((await run('get_html', { id: 'title' })).html).toContain('Hello');
        expect((await run('get_styles', { ids: ['title'], keys: ['color'] })).styles[0].style.color).toBe('rgb(1, 2, 3)');
        expect((await run('find', { text: 'HELLO' })).matches[0].rawId).toBe('title');
        seen.add('screenshot');
        const shot = await f.call('screenshot', {
            id: 'board', mode: 'slice', slice: 1
        });
        expect(shot.content[1]).toEqual({
            type: 'image', data: 'cG5n', mimeType: 'image/png'
        });
        expect(shot.structuredContent?.slices).toBe(3);
        const inserted = await run('write_html', {
            html: '<div data-ref="new" style="width:20px;height:10px;background:#abc"></div>', target: 'board', position: 'last'
        });
        expect(inserted.ids).toHaveLength(1);
        const updated = await run('update', {
            id: '@title', text: 'Changed', style: {
                'font-size': '22px', opacity: '.5', '--unsupported': 'x'
            }, attrs: { name: 'Renamed', unknown: 'ignored' }
        });
        expect(updated.warnings.join(' ')).toContain('Ignored CSS');
        expect(updated.warnings.join(' ')).toContain('Font fallback');
        expect(f.editor.page.objects.title.content.children[0].children[0]).toMatchObject({
            text: 'Changed', fontSize: 22, fontWeight: 700
        });
        await run('move', {
            id: 'box', target: '@new', position: 'before'
        });
        const dup = await run('duplicate', {
            id: 'box', target: 'board', position: 'first'
        });
        expect(f.editor.page.objects.board.childIds![0]).toBe(dup.rawIds[0]);
        await run('delete', { ids: dup.ids });
        await run('batch', { ops: [{ tool: 'update', args: { id: 'box', attrs: { name: 'Batch box' } } }, { tool: 'update', args: { id: 'box', style: { opacity: '.25' } } }] });
        const board = await run('create_board', { width: 300, name: 'Next' });
        expect(f.editor.page.objects[board.rawId].x).toBe(800);
        expect(f.editor.page.objects[board.rawId].vSizing ?? f.editor.page.objects[board.rawId].heightSizing).toBe('hug');
        expect((await run('assets')).assets).toEqual([]);
        expect((await run('assets')).configured).toBe(false);
        expect((await run('get_guide', { topic: 'components' })).guide).toMatch(/200/);
        expect((await run('fonts', { query: 'test' })).fonts).toHaveLength(1);
        const main = await run('component', {
            action: 'create', id: 'box', name: 'Tile'
        });
        expect(f.editor.doc.components?.[main.componentId].mainId).toBe('box');
        expect((await run('components')).components).toHaveLength(1);
        await run('undo');
        expect(f.editor.page.objects.box.isMain).not.toBe(true);
        expect(seen).toEqual(new Set(names.filter(name => !['write_svg', 'get_path', 'edit_path', 'boolean', 'outline', 'image'].includes(name))));
        expect(f.afterWrite).toHaveBeenCalled();
        expect(f.onHighlight).toHaveBeenCalled();
        validateDocument(f.editor.doc);
    });
    it('keeps aliases scoped to each agent and resolves raw IDs and @refs', async () => {
        const f = fixture();
        const a = await f.ok('get_tree', { id: 'box' }), b = await f.ok('get_tree', { id: 'title' }, 'beta');
        expect(a.tree.id).toBe(b.tree.id);
        await f.ok('update', { id: a.tree.id, attrs: { name: 'Alpha box' } });
        await f.ok('update', { id: b.tree.id, text: 'Beta text' }, 'beta');
        expect(f.editor.page.objects.box.name).toBe('Alpha box');
        expect(textValue(f.editor.page.objects.title)).toBe('Beta text');
    });
    it('enforces tree/find caps and component pagination without fake providers', async () => {
        const f = fixture();
        f.editor.transact('seed', doc => {
            const p = doc.pagesById[f.editor.pageId];
            for (let i = 0; i < 450; i++)
                insertShape(p, createShape('rect', { id: `cap${i}`, name: 'match' }));
            doc.components = Object.fromEntries(Array.from({ length: 205 }, (_, i) => {
                p.objects[`cap${i}`].isMain = true;
                p.objects[`cap${i}`].componentId = `c${i}`;
                return [`c${i}`, {
                        id: `c${i}`, name: `Item ${i}`, mainId: `cap${i}`, mainPageId: p.id, properties: [], variantProperties: []
                    }];
            }));
        });
        const tree = await f.ok('get_tree', { depth: 100 });
        expect(tree.count).toBe(400);
        expect(tree.truncated).toBe(true);
        expect((await f.ok('find', { name: 'match' })).matches).toHaveLength(50);
        const first = await f.ok('components'), second = await f.ok('components', { offset: 200 });
        expect(first.components).toHaveLength(200);
        expect(first.nextOffset).toBe(200);
        expect(second.components).toHaveLength(5);
        expect(second.nextOffset).toBeNull();
    });
    it('calls configured source providers, not the local component tile service', async () => {
        const source = vi.fn(async () => [{ id: 'stock-1' }]), f = fixture({ sources: [{ kind: 'stock', search: source }] });
        expect((await f.ok('assets', { kind: 'stock', query: 'tree' })).assets).toEqual([{ id: 'stock-1' }]);
        expect(source).toHaveBeenCalledWith('tree');
        expect((await f.ok('assets', { kind: 'brand' })).assets).toEqual([]);
    });
});
describe('MCP-02 atomicity, author and lifetime boundaries', () => {
    it('uses a single agent-labelled transaction and batch refs can target earlier writes', async () => {
        const f = fixture();
        const before = f.events.length;
        await f.ok('batch', { ops: [{ tool: 'write_html', args: {
                        html: '<div data-ref="batch-ref" style="width:30px;height:20px"></div>', target: 'board', position: 'last'
                    } }, { tool: 'update', args: { id: '@batch-ref', attrs: { name: 'Later operation' } } }] });
        expect(f.events).toHaveLength(before + 1);
        expect(f.events.at(-1)?.operation).toMatchObject({ label: 'agent:alpha', author: 'alpha' });
        expect(Object.values(f.editor.page.objects).find(s => s.dataRef === 'batch-ref')?.name).toBe('Later operation');
    });
    it('rolls back document, components, history and aliases after a late invalid batch/delete/component', async () => {
        const f = fixture();
        await f.ok('get_tree', { id: 'box' });
        const before = structuredClone(f.editor.doc), eventCount = f.events.length;
        const bad = await f.call('batch', { ops: [{ tool: 'write_html', args: {
                        html: '<div data-ref="rolled-back" style="width:30px;height:20px"></div>', target: 'board', position: 'last'
                    } }, { tool: 'delete', args: { ids: ['missing'] } }] });
        expect(bad.structuredContent?.error.code).toBe('not_found');
        expect(f.editor.doc).toEqual(before);
        expect(f.events).toHaveLength(eventCount);
        expect((await f.call('update', { id: '@rolled-back', attrs: { name: 'bad' } })).structuredContent?.error.code).toBe('not_found');
        expect((await f.call('delete', { ids: ['title', 'missing'] })).isError).toBe(true);
        expect(f.editor.doc).toEqual(before);
        expect((await f.call('update', { id: 'n2', attrs: { name: 'Leaked alias' } })).structuredContent?.error.code).toBe('not_found');
        const main = await f.ok('component', { action: 'create', id: 'board' }), snap = structuredClone(f.editor.doc), count = f.events.length;
        const failed = await f.call('component', {
            action: 'bind', id: 'board', layer: 'box', propertyType: 'text', name: 'Transient'
        });
        expect(failed.isError).toBe(true);
        expect(f.editor.doc).toEqual(snap);
        expect(f.events).toHaveLength(count);
        expect(f.editor.doc.components?.[main.componentId].properties).toEqual([]);
        const next = await f.ok('write_html', {
            html: '<div style="width:1px;height:1px"></div>', target: 'board', position: 'last'
        });
        expect(next.ids[0]).toBe('n4');
    });
    it('refuses self-descendant moves and malformed HTML replacement without deleting the target', async () => {
        const f = fixture();
        const before = structuredClone(f.editor.doc);
        expect((await f.call('move', {
            id: 'board', target: 'title', position: 'last'
        })).isError).toBe(true);
        expect((await f.call('write_html', {
            html: '<script/>', target: 'title', position: 'replace'
        })).structuredContent?.error.code).toBe('bad_html');
        expect(f.editor.doc).toEqual(before);
    });
    it('permits reads during user sessions while refusing writes and undo', async () => {
        const f = fixture();
        expect(f.editor.begin('User typing')).toBe(true);
        for (const [name, args] of Object.entries({
            get_context: {}, get_tree: {}, get_html: { id: 'title' }, get_styles: { ids: ['title'] }, find: { text: 'Hello' }, screenshot: { id: 'board' }, fonts: {}, assets: {}, components: {}, get_guide: {}
        }))
            await f.ok(name, args);
        for (const [name, args] of [
            ['update', { id: 'title', text: 'blocked' }], ['undo', {}], ['create_board', { width: 20 }]
        ] as Array<[
            string,
            Data
        ]>)
            expect((await f.call(name, args)).structuredContent?.error.code).toBe('busy');
        f.editor.cancelSession();
    });
    it('restricts Undo to the latest author and invalidates ownership on user/remote edits', async () => {
        const f = fixture();
        await f.ok('update', { id: 'title', text: 'A' });
        expect((await f.call('undo', {}, 'beta')).structuredContent?.error.code).toBe('nothing_to_undo');
        await f.ok('update', { id: 'title', text: 'B' }, 'beta');
        expect((await f.call('undo')).structuredContent?.error.code).toBe('nothing_to_undo');
        await f.ok('undo', {}, 'beta');
        f.editor.transact('User edit', doc => {
            doc.pagesById[f.editor.pageId].objects.box.name = 'User';
        });
        expect((await f.call('undo', {}, 'beta')).structuredContent?.error.code).toBe('nothing_to_undo');
        await f.ok('update', { id: 'title', text: 'C' });
        f.editor.receiveDocument(structuredClone(f.editor.doc));
        expect((await f.call('undo')).structuredContent?.error.code).toBe('nothing_to_undo');
    });
    it('deduplicates concurrent/reordered idempotent requests and rejects key collisions', async () => {
        const f = fixture();
        const a = f.call('update', { id: 'title', text: 'Once' }, 'alpha', { idempotencyKey: 'same' }), b = f.call('update', { text: 'Once', id: 'title' }, 'alpha', { idempotencyKey: 'same' });
        expect(await a).toEqual(await b);
        expect(f.events).toHaveLength(1);
        expect((await f.call('update', { id: 'title', text: 'Other' }, 'alpha', { idempotencyKey: 'same' })).structuredContent?.error.code).toBe('bad_args');
    });
    it('serializes queue, aborts ended/disposed preflights and bounds timeout responses', async () => {
        const gate = deferred(), f = fixture();
        f.fonts.ensure.mockImplementationOnce(() => gate.promise);
        const first = f.call('update', { id: 'title', text: 'One' }), second = f.call('update', { id: 'title', text: 'Two' });
        await Promise.resolve();
        await Promise.resolve();
        expect(textValue(f.editor.page.objects.title)).toBe('Hello');
        f.api.endSession('alpha');
        gate.resolve();
        expect((await first).isError).toBe(true);
        expect((await second).isError).toBe(true);
        expect(f.events).toHaveLength(0);
        const g = fixture({ timeoutMs: 15 });
        const hanging = deferred();
        g.fonts.ensure.mockImplementationOnce(() => hanging.promise);
        const result = await g.call('update', { id: 'title', text: 'Too late' });
        expect(result.structuredContent?.error.code).toBe('timeout');
        hanging.resolve();
        await Promise.resolve();
        await Promise.resolve();
        expect(textValue(g.editor.page.objects.title)).toBe('Hello');
        const h = fixture(), block = deferred();
        h.fonts.ensure.mockImplementationOnce(() => block.promise);
        const pending = h.call('update', { id: 'title', text: 'Disposed' });
        await Promise.resolve();
        await Promise.resolve();
        h.api.dispose();
        block.resolve();
        expect((await pending).isError).toBe(true);
        expect(h.events).toHaveLength(0);
    });
    it('cancels a stalled preflight without blocking another agent or applying late changes', async () => {
        const gate = deferred(), entered = deferred(), f = fixture(), controller = new AbortController();
        f.fonts.ensure.mockImplementationOnce(() => { entered.resolve(); return gate.promise; });
        const cancelled = f.call('update', { id: 'title', text: 'Never applied' }, 'alpha', { signal: controller.signal });
        await entered.promise;
        const other = f.call('update', { id: 'title', text: 'Beta applied' }, 'beta');
        controller.abort();
        expect((await cancelled).structuredContent?.error.code).toBe('cancelled');
        expect((await other).isError).not.toBe(true);
        gate.resolve();
        await Promise.resolve();
        expect(textValue(f.editor.page.objects.title)).toBe('Beta applied');
        expect(f.events).toHaveLength(1);
    });
    it('skips requests cancelled in the queue and releases an expired font wait', async () => {
        const gate = deferred(), entered = deferred(), f = fixture(), controller = new AbortController();
        f.fonts.ensure.mockImplementationOnce(() => { entered.resolve(); return gate.promise; });
        const first = f.call('update', { id: 'title', text: 'First' });
        await entered.promise;
        const queued = f.call('update', { id: 'title', text: 'Cancelled' }, 'beta', { signal: controller.signal });
        controller.abort();
        expect((await queued).structuredContent?.error.code).toBe('cancelled');
        gate.resolve();
        await first;
        await f.ok('get_context');
        expect(textValue(f.editor.page.objects.title)).toBe('First');
        expect(f.events).toHaveLength(1);
        const g = fixture({ timeoutMs: 15 });
        g.fonts.ensure.mockImplementationOnce(() => new Promise(() => {}));
        expect((await g.call('update', { id: 'title', text: 'Expired' })).structuredContent?.error.code).toBe('timeout');
        await g.ok('update', { id: 'title', text: 'After deadline' }, 'beta');
        expect(textValue(g.editor.page.objects.title)).toBe('After deadline');
    });
    it('ends stalled sessions immediately and keeps a new session independent of old work', async () => {
        const gate = deferred(), entered = deferred(), f = fixture();
        f.fonts.ensure.mockImplementationOnce(() => { entered.resolve(); return gate.promise; });
        const ended = f.call('update', { id: 'title', text: 'Old session' }, 'alpha', { idempotencyKey: 'write' });
        await entered.promise;
        f.api.endSession('alpha');
        expect((await ended).structuredContent?.error.code).toBe('failed');
        const fresh = await f.call('update', { id: 'title', text: 'New session' }, 'alpha', { idempotencyKey: 'write' });
        expect(fresh.isError).not.toBe(true);
        gate.resolve();
        await Promise.resolve();
        expect(textValue(f.editor.page.objects.title)).toBe('New session');
        expect(f.events).toHaveLength(1);
        expect(f.onHighlight).toHaveBeenCalledWith('alpha', []);
    });
    it('keeps committed changes and durability when cancellation arrives during settling', async () => {
        const saved = deferred(), entered = deferred(), controller = new AbortController();
        const f = fixture({ afterWrite: () => { entered.resolve(); return saved.promise; } });
        const task = f.call('update', { id: 'title', text: 'Committed' }, 'alpha', { signal: controller.signal });
        await entered.promise;
        controller.abort();
        expect((await task).structuredContent?.error.code).toBe('cancelled');
        saved.resolve();
        await Promise.resolve();
        expect(textValue(f.editor.page.objects.title)).toBe('Committed');
        expect(f.events).toHaveLength(1);
    });
    it('forwards cancellation to Undo held in the host queue before it can apply', async () => {
        const gate = deferred(), entered = deferred(), controller = new AbortController();
        let applied = 0, hostWork!: Promise<boolean>;
        const pending = new Set(['queued-undo']);
        const f = fixture({ undo: (_agent: string, signal?: AbortSignal, requestId?: string) => {
            entered.resolve();
            hostWork = gate.promise.then(() => {
                signal?.throwIfAborted();
                if (!requestId || !pending.has(requestId))
                    throw Error('Undo request ended before application');
                applied++;
                return f.editor.undoStep();
            });
            return hostWork;
        } });
        await f.ok('update', { id: 'title', text: 'Keep this edit' });
        const undo = f.call('undo', {}, 'alpha', { signal: controller.signal, requestId: 'queued-undo' });
        await entered.promise;
        pending.delete('queued-undo');
        controller.abort();
        expect((await undo).structuredContent?.error.code).toBe('cancelled');
        expect(applied).toBe(0);
        gate.resolve();
        await expect(hostWork).rejects.toBeDefined();
        await f.ok('get_context');
        expect(applied).toBe(0);
        expect(textValue(f.editor.page.objects.title)).toBe('Keep this edit');
        expect(f.events).toHaveLength(1);
    });
    it('does not invoke Undo for an already cancelled request', async () => {
        const undo = vi.fn(() => true), f = fixture({ undo }), controller = new AbortController();
        controller.abort();
        expect((await f.call('undo', {}, 'alpha', { signal: controller.signal })).structuredContent?.error.code).toBe('cancelled');
        await f.ok('get_context');
        expect(undo).not.toHaveBeenCalled();
    });
    it('does not roll back Undo already applied before cancellation', async () => {
        const acknowledged = deferred(), applied = deferred(), controller = new AbortController();
        const f = fixture({ undo: (_agent: string, signal?: AbortSignal) => {
            signal?.throwIfAborted();
            const result = f.editor.undoStep();
            applied.resolve();
            return acknowledged.promise.then(() => result);
        } });
        await f.ok('update', { id: 'title', text: 'Undo this edit' });
        const undo = f.call('undo', {}, 'alpha', { signal: controller.signal });
        await applied.promise;
        controller.abort();
        expect((await undo).structuredContent?.error.code).toBe('cancelled');
        acknowledged.resolve();
        await f.ok('get_context');
        expect(textValue(f.editor.page.objects.title)).toBe('Hello');
        expect(f.events).toHaveLength(2);
    });
    it('rechecks busy after font preparation and awaits host durability before success', async () => {
        const gate = deferred(), saved = deferred(), f = fixture({ afterWrite: () => saved.promise });
        f.fonts.ensure.mockImplementationOnce(() => gate.promise);
        const task = f.call('update', { id: 'title', text: 'Ready' });
        await Promise.resolve();
        await Promise.resolve();
        f.editor.begin('User');
        gate.resolve();
        expect((await task).structuredContent?.error.code).toBe('busy');
        f.editor.cancelSession();
        let done = false;
        const write = f.call('update', { id: 'title', text: 'Durable' }).then(r => {
            done = true;
            return r;
        });
        await new Promise(r => setTimeout(r, 0));
        expect(textValue(f.editor.page.objects.title)).toBe('Durable');
        expect(done).toBe(false);
        saved.resolve();
        expect((await write).isError).not.toBe(true);
    });
    it('returns unknown_tool and bad_args envelopes rather than fake success', async () => {
        const f = fixture();
        expect((await f.call('made_up')).structuredContent?.error.code).toBe('unknown_tool');
        expect((await f.call('update', { id: 'title', surprise: true })).structuredContent?.error.code).toBe('bad_args');
        expect(f.events).toHaveLength(0);
    });
});
describe('CMP-01/02 MCP domain action parity', () => {
    it('performs all 12 component actions with typed properties and editable instance results', async () => {
        const f = fixture(), seen = new Set<string>();
        const run = async (action: string, args: Data) => {
            seen.add(action);
            return f.ok('component', { action, ...args });
        };
        const main = await run('create', { id: 'board', name: 'Card' }), componentId = main.componentId;
        const property = await run('property', {
            id: 'board', name: 'Label', propertyType: 'text', value: 'Initial'
        }), pid = property.property.id;
        await run('bind', {
            id: 'board', layer: 'title', property: pid, propertyType: 'text'
        });
        await run('edit_property', {
            id: 'board', property: pid, name: 'Headline', value: 'Default'
        });
        expect(textValue(f.editor.page.objects.title)).toBe('Default');
        const inserted = await run('instance', {
            source: componentId, parent: 'root', x: 900, y: 100
        }), instance = inserted.rawSelection[0];
        expect(f.editor.page.objects[instance].isInstanceRoot).toBe(true);
        expect(f.editor.page.objects[instance].isMain).not.toBe(true);
        await run('set_property', {
            id: instance, property: pid, value: 'Instance'
        });
        expect(descendants(f.editor.page, instance).find(s => s.type === 'text')?.content.children[0].children[0].text).toBe('Instance');
        await run('reset', { id: instance });
        expect(textValue(descendants(f.editor.page, instance).find(s => s.type === 'text')!)).toBe('Default');
        await run('detach', { id: instance });
        expect(f.editor.page.objects[instance].componentId).toBeUndefined();
        await run('remove_property', { id: 'board', property: pid });
        expect(f.editor.doc.components?.[componentId].properties).toEqual([]);
        const next = await run('add_variant', {
            id: 'board', name: 'Alternate', value: 'Other'
        }), variantId = next.componentId;
        const second = await run('instance', {
            source: componentId, x: 1200, y: 0
        });
        await run('variant', { id: second.rawSelection[0], value: variantId });
        expect(f.editor.page.objects[second.rawSelection[0]].componentId).toBe(variantId);
        const g = fixture();
        g.editor.transact('Second main', doc => insertShape(doc.pagesById[g.editor.pageId], createShape('rect', {
            id: 'second', x: 50, y: 50
        }), 'board'));
        await g.ok('component', {
            action: 'create', id: 'box', name: 'One'
        });
        await g.ok('component', {
            action: 'create', id: 'second', name: 'Two'
        });
        const combined = await g.ok('component', {
            action: 'combine', ids: ['box', 'second'], name: 'Set'
        });
        seen.add('combine');
        expect(g.editor.page.objects[combined.rawSelection[0]].isVariantSet).toBe(true);
        expect(seen).toEqual(new Set([
            'create', 'property', 'bind', 'edit_property', 'instance', 'set_property', 'reset', 'detach', 'remove_property', 'add_variant', 'variant', 'combine'
        ]));
        validateDocument(f.editor.doc);
        validateDocument(g.editor.doc);
    });
    it('rolls back speculative add-variant frames and component records on duplicate variant validation', async () => {
        const f = fixture();
        await f.ok('component', {
            action: 'create', id: 'board', name: 'Main'
        });
        const before = structuredClone(f.editor.doc), count = f.events.length;
        const failure = await f.call('component', {
            action: 'add_variant', id: 'board', value: 'Default'
        });
        expect(failure.isError).toBe(true);
        expect(f.editor.doc).toEqual(before);
        expect(f.events).toHaveLength(count);
    });
    it('honors cross-page variant creation and returns aliases with raw selection for shared measurement', async () => {
        const f = fixture();
        const main = await f.ok('component', {
            action: 'create', id: 'board', name: 'Card'
        }), sourcePage = f.editor.pageId;
        let other = '';
        f.editor.transact('Page', doc => {
            const p = createPage('Instances');
            doc.pages.push(p.id);
            doc.pagesById[p.id] = p;
            other = p.id;
        });
        f.editor.setPage(other);
        const instance = await f.ok('component', {
            action: 'instance', source: main.componentId, x: 0, y: 0
        });
        const variant = await f.ok('component', {
            action: 'add_variant', id: instance.rawSelection[0], value: 'Alternate'
        });
        expect(f.editor.pageId).toBe(sourcePage);
        expect(variant.pageId).toBe(sourcePage);
        expect(variant.selection[0]).not.toBe(variant.rawSelection[0]);
        expect(variant.diagnostics.some((d: Data) => d.id === variant.rawSelection[0])).toBe(true);
    });
    it('duplicates a main as a linked instance rather than producing duplicate mains', async () => {
        const f = fixture();
        const c = await f.ok('component', {
            action: 'create', id: 'box', name: 'Main'
        }), d = await f.ok('duplicate', { id: 'box' }), copy = f.editor.page.objects[d.rawIds[0]];
        expect(copy.isInstanceRoot).toBe(true);
        expect(copy.isMain).not.toBe(true);
        expect(copy.componentId).toBe(c.componentId);
    });
});
describe('MCP boundary adversarial requests', () => {
    it.each([
        'url(javascript:alert(1))', 'url(file:///private/secret)', 'expression(alert(1))'
    ])('rejects unsafe CSS update value %s atomically', async (value) => {
        const f = fixture(), before = structuredClone(f.editor.doc);
        const r = await f.call('update', { id: 'box', style: { opacity: '.5', 'background-image': value } });
        expect(r.isError).toBe(true);
        expect(f.editor.doc).toEqual(before);
        expect(f.events).toHaveLength(0);
    });
    it('snapshots queued request arguments before the caller can mutate them', async () => {
        const f = fixture(), gate = deferred();
        f.fonts.ensure.mockImplementationOnce(() => gate.promise);
        const first = f.call('update', { id: 'title', text: 'First' }), args = { id: 'title', text: 'Original' }, second = f.call('update', args);
        args.text = 'Mutated';
        gate.resolve();
        await first;
        await second;
        expect(textValue(f.editor.page.objects.title)).toBe('Original');
    });
    it('does not let the tool-list caller mutate the installed definitions', () => {
        const f = fixture();
        const tools = f.api.tools();
        tools[0].inputSchema.additionalProperties = true;
        expect(f.api.tools()[0].inputSchema.additionalProperties).toBe(false);
    });
});
describe('HIST-01 host-authoritative Undo', () => {
    it('lets durable host history determine ownership after a normalized local projection', async () => {
        const undo = vi.fn(async (agent: string) => agent === 'alpha'), f = fixture({ undo });
        await f.ok('update', { id: 'title', text: 'Saved' });
        f.editor.receiveDocument(structuredClone(f.editor.doc));
        expect((await f.call('undo')).isError).not.toBe(true);
        expect(undo).toHaveBeenCalledExactlyOnceWith('alpha', expect.any(AbortSignal), undefined);
    });
    it('still refuses when authoritative host reports another latest author', async () => {
        const undo = vi.fn(async () => false), f = fixture({ undo });
        await f.ok('update', { id: 'title', text: 'Saved' });
        f.editor.receiveDocument(structuredClone(f.editor.doc));
        expect((await f.call('undo')).structuredContent?.error.code).toBe('nothing_to_undo');
        expect(undo).toHaveBeenCalledExactlyOnceWith('alpha', expect.any(AbortSignal), undefined);
    });
});
describe('MCP installation resource boundary', () => {
    it('installs and removes only its own optional global API target', () => {
        const target: Data = {}, f = fixture({ target });
        expect(target.lvMcp).toBe(f.api);
        f.api.dispose();
        expect(target.lvMcp).toBeUndefined();
        const external = { owned: 'elsewhere' }, g = fixture({ target });
        target.lvMcp = external;
        g.api.dispose();
        expect(target.lvMcp).toBe(external);
    });
});
describe('MCP typed component property transport', () => {
    it('binds boolean strings through the real domain and rolls back invalid values', async () => {
        const f = fixture();
        const main = await f.ok('component', {
            action: 'create', id: 'board', name: 'Visibility'
        }), bound = await f.ok('component', {
            action: 'bind', id: 'board', layer: 'box', name: 'Show box', propertyType: 'boolean', value: 'false'
        }), property = bound.property.id;
        expect(f.editor.page.objects.box.hidden).toBe(true);
        const inserted = await f.ok('component', {
            action: 'instance', source: main.componentId, x: 900, y: 0
        }), id = inserted.rawSelection[0];
        await f.ok('component', {
            action: 'set_property', id, property, value: 'true'
        });
        expect(descendants(f.editor.page, id).find(s => s.type === 'rect')?.hidden).toBe(false);
        const before = structuredClone(f.editor.doc), events = f.events.length;
        expect((await f.call('component', {
            action: 'set_property', id, property, value: 'yes'
        })).isError).toBe(true);
        expect(f.editor.doc).toEqual(before);
        expect(f.events).toHaveLength(events);
    });
    it('passes swap component IDs unaliased and updates only the nested instance', async () => {
        const f = fixture();
        await f.ok('move', {
            id: 'box', target: 'board', position: 'before'
        });
        const one = await f.ok('component', {
            action: 'create', id: 'box', name: 'Source One'
        }), nested = await f.ok('component', {
            action: 'instance', source: one.componentId, parent: 'board', x: 200, y: 250
        });
        f.editor.transact('Other source', doc => insertShape(doc.pagesById[f.editor.pageId], createShape('ellipse', {
            id: 'alternate', x: 0, y: 0, width: 10, height: 10
        })));
        const two = await f.ok('component', {
            action: 'create', id: 'alternate', name: 'Source Two'
        }), outer = await f.ok('component', {
            action: 'create', id: 'board', name: 'Outer'
        }), bound = await f.ok('component', {
            action: 'bind', id: 'board', layer: nested.rawSelection[0], propertyType: 'swap', name: 'Icon', value: two.componentId
        });
        expect(f.editor.page.objects[nested.rawSelection[0]].componentId).toBe(two.componentId);
        const instance = await f.ok('component', {
            action: 'instance', source: outer.componentId, x: 1000, y: 0
        }), root = instance.rawSelection[0];
        await f.ok('component', {
            action: 'set_property', id: root, property: bound.property.id, value: one.componentId
        });
        expect(descendants(f.editor.page, root).find(s => s.isInstanceRoot)?.componentId).toBe(one.componentId);
        expect(f.editor.page.objects[nested.rawSelection[0]].componentId).toBe(two.componentId);
    });
});

 describe('vector MCP editing', () => {
    it('imports native editable paths, edits world nodes, rejects stale revisions and undoes once', async () => {
        const { ok, call, editor, events } = fixture();
        const inserted = await ok('write_svg', { svg: '<svg width="24" height="24"><path d="M0 0 C2 0 4 6 8 8 Z" fill="black"/></svg>', target: 'board', position: 'last' });
        const paths = Object.values(editor.page.objects).filter(s => s.type === 'path');
        expect(paths).toHaveLength(1);
        const id = paths[0].id, before = structuredClone(paths[0].content);
        const path = await ok('get_path', { id });
        expect(path.coordinateSpace).toBe('world');
        expect(path.segments[0]).toMatchObject({ command: 'move', x: 100, y: 200, index: 0 });
        const edit = { id, revision: path.revision, action: 'move_nodes', indices: [0], dx: 2, dy: 3 };
        await ok('edit_path', edit);
        expect(editor.page.objects[id].content[0]).toMatchObject({ x: 102, y: 203 });
        expect((await call('edit_path', edit)).structuredContent?.error.code).toBe('stale_revision');
        await ok('undo');
        expect(editor.page.objects[id].content).toEqual(before);
        expect(events.filter(e => e.operation?.author === 'alpha')).toHaveLength(3);
        expect(inserted.warnings).toEqual([]);
    });
    it('rejects invalid node operations and vector writes inside batch without edits', async () => {
        const { call, ok, editor } = fixture();
        await ok('write_svg', { svg: '<svg><path d="M0 0 L2 2"/></svg>', target: 'board', position: 'last' });
        const shape = Object.values(editor.page.objects).find(s => s.type === 'path')!;
        const context = await ok('get_path', { id: shape.id });
        const snapshot = editor.doc;
        for (const args of [
            { action: 'move_nodes', indices: [999], dx: 1, dy: 1 },
            { action: 'set_handle', index: 0, handle: 'out', point: { x: Infinity, y: 0 } },
            { action: 'insert_node', index: 1, t: 0 },
        ]) expect((await call('edit_path', { id: shape.id, revision: context.revision, ...args })).isError).toBe(true);
        expect((await call('batch', { ops: [{ tool: 'write_svg', args: { svg: '<svg/>', target: 'board', position: 'last' } }] })).isError).toBe(true);
        expect(editor.doc).toBe(snapshot);
    });
    it('combines operands in caller order, retains originals, and owns undo', async () => {
        const combinePaths = vi.fn(async (_shapes: Data[], _operation: string, _options: Data) => ({ segments: [{ command: 'move', x: 0, y: 0 }, { command: 'line', x: 10, y: 10 }], bounds: { x: 0, y: 0, width: 10, height: 10 }, fillRule: 'evenodd' }));
        const { editor, ok } = fixture({ services: { combinePaths } });
        editor.transact('Add operand', doc => insertShape(doc.pagesById[editor.pageId], createShape('ellipse', { id: 'circle', x: 0, y: 0, width: 20, height: 20 }), 'board'));
        const context = await ok('get_context');
        const result = await ok('boolean', { ids: ['circle', 'box'], operation: 'subtract', revision: context.revision });
        expect(combinePaths.mock.calls[0][0].map((s: Data) => s.id)).toEqual(['circle', 'box']);
        expect(editor.page.objects[result.rawId].childIds).toEqual(['circle', 'box']);
        expect(editor.page.objects.circle.parentId).toBe(result.rawId);
        await ok('undo');
        expect(editor.page.objects.circle.parentId).toBe('board');
        expect(editor.page.objects.box.parentId).toBe('board');
        expect(editor.page.objects[result.rawId]).toBeUndefined();
    });
    it('flattens a Boolean into editable nodes while preserving and undoing its source', async () => {
        const combinePaths = vi.fn(async (_shapes: Data[], _operation: string, _options: Data) => ({ segments: [{ command: 'move', x: 0, y: 0 }, { command: 'line', x: 10, y: 10 }, { command: 'close' }], bounds: { x: 0, y: 0, width: 10, height: 10 }, fillRule: 'evenodd' }));
        const { editor, ok, call } = fixture({ services: { combinePaths } });
        editor.transact('Add operand', doc => insertShape(doc.pagesById[editor.pageId], createShape('ellipse', { id: 'circle', x: 0, y: 0, width: 20, height: 20 }), 'board'));
        const context = await ok('get_context');
        const combined = await ok('boolean', { ids: ['box', 'circle'], operation: 'subtract', revision: context.revision });
        const flat = await ok('boolean', { ids: [combined.id], operation: 'flatten', revision: combined.revision });
        expect(combinePaths.mock.calls[1][1]).toBe('flatten');
        expect(editor.page.objects[flat.rawId]).toMatchObject({ type: 'path', parentId: 'board', flattenSourceIds: [combined.rawId] });
        expect(editor.page.objects[flat.rawId].childIds).toBeUndefined();
        expect(editor.page.objects[combined.rawId].hidden).toBe(true);
        expect(editor.page.objects[combined.rawId].childIds).toEqual(['box', 'circle']);
        const path = await ok('get_path', { id: flat.id });
        expect(path.editable).toBe(true);
        await ok('edit_path', { id: flat.id, revision: path.revision, action: 'move_nodes', indices: [1], dx: 2, dy: 1 });
        expect(editor.page.objects[flat.rawId].content[1]).toMatchObject({ x: 12, y: 11 });
        expect(editor.undoStep()).toBe(true);
        expect(editor.page.objects[flat.rawId].content[1]).toMatchObject({ x: 10, y: 10 });
        await ok('undo');
        expect(editor.page.objects[flat.rawId]).toBeUndefined();
        expect(editor.page.objects[combined.rawId].hidden).toBeFalsy();
        expect((await call('boolean', { ids: [combined.id], operation: 'union', revision: (await ok('get_context')).revision })).structuredContent?.error.code).toBe('bad_args');
    });
    it('returns explicit SVG fallback warnings and rejects oversized input', async () => {
        const { ok, call, editor } = fixture();
        const result = await ok('write_svg', { svg: '<svg width="80" height="40"><defs><clipPath id="clip"><rect width="20" height="20"/></clipPath></defs><g clip-path="url(#clip)"><rect width="40" height="20"/></g></svg>', target: 'board', position: 'last' });
        expect(result.warnings.length).toBeGreaterThan(0);
        expect(result.rawIds.some((id: string) => editor.page.objects[id].type === 'svg')).toBe(true);
        expect((await call('write_svg', { svg: 'x'.repeat(200001), target: 'board', position: 'last' })).structuredContent?.error.code).toBe('bad_args');
    });
    it('dispatches outline with agent ownership and cancellation context outside transactions', async () => {
        const commands = { run: vi.fn((_name, args) => { expect(args.author).toBe('alpha'); expect(args.signal).toBeInstanceOf(AbortSignal); return ['box']; }) };
        const { ok, call } = fixture({ services: { commands } });
        await ok('outline', { ids: ['box'], kind: 'stroke', revision: 0 });
        expect(commands.run).toHaveBeenCalledWith('path.outline-stroke', expect.objectContaining({ ids: ['box'], operationId: expect.any(String) }));
        expect((await call('outline', { ids: ['box'], kind: 'text', revision: 999 })).structuredContent?.error.code).toBe('stale_revision');
        expect(commands.run).toHaveBeenCalledTimes(1);
    });
    it('returns command-created outline IDs when selection changes during settling', async () => {
        const commands = { run: vi.fn(async () => ['box']) };
        const { ok, editor, view } = fixture({ services: { commands } });
        view.settled = vi.fn(async () => { editor.setSelection(['title']); });
        const result = await ok('outline', { ids: ['box'], kind: 'stroke', revision: 0 });
        expect(editor.selection).toEqual(['title']);
        expect(result.rawIds).toEqual(['box']);
        expect(result.diagnostics.map((d: Data) => d.id)).toEqual(['box']);
        expect((await ok('get_tree', { id: result.ids[0] })).tree.rawId).toBe('box');
    });
    it('reads settled recomposed Boolean paths after operand edits and reopening without stored content', async () => {
        const { editor, view, ok, call } = fixture();
        editor.transact('Reopen Boolean operands', doc => {
            const page = doc.pagesById[editor.pageId];
            insertShape(page, createShape('boolean', { id: 'reopened', childIds: [], booleanOperation: 'subtract' }), 'board');
            insertShape(page, createShape('rect', { id: 'outer', x: 0, y: 0, width: 100, height: 100 }), 'reopened');
            insertShape(page, createShape('rect', { id: 'inner', x: 25, y: 25, width: 50, height: 50 }), 'reopened');
        });
        let projected: Data | undefined;
        view.settled = vi.fn(async () => {
            const result = await combinePaths([editor.page.objects.reopened], 'flatten', { wasmUrl: resolve('node_modules/canvaskit-wasm/bin/full/canvaskit.wasm'), objects: editor.page.objects });
            projected = { ...editor.page.objects.reopened, content: result.segments, fillRule: result.fillRule };
        });
        view.projectedShape = () => projected;
        expect(editor.page.objects.reopened.content).toBeUndefined();
        const original = await ok('get_path', { id: 'reopened' });
        expect(original.segments.filter((s: Data) => s.command === 'close')).toHaveLength(2);
        expect(original.editable).toBe(false);
        editor.transact('Change operand', doc => {
            doc.pagesById[editor.pageId].objects.outer.width = 120;
            doc.pagesById[editor.pageId].objects.reopened.content = [{ command: 'move', x: 999, y: 999 }];
        });
        const changed = await ok('get_path', { id: 'reopened' });
        expect(changed.revision).toBeGreaterThan(original.revision);
        expect(changed.segments).not.toEqual(original.segments);
        expect(changed.segments.some((s: Data) => s.x === 120)).toBe(true);
        expect(changed.segments.some((s: Data) => s.x === 999)).toBe(false);
        view.projectedShape = () => undefined;
        expect((await call('get_path', { id: 'reopened' })).structuredContent?.error.code).toBe('invalid');
    });
    it('does not commit asynchronous geometry after the document changes', async () => {
        const ready = deferred();
        const combinePaths = vi.fn(async () => { await ready.promise; return { segments: [], bounds: { x: 0, y: 0, width: 0, height: 0 } }; });
        const { editor, ok, call } = fixture({ services: { combinePaths } });
        editor.transact('Add operand', doc => insertShape(doc.pagesById[editor.pageId], createShape('ellipse', { id: 'circle' }), 'board'));
        const context = await ok('get_context');
        const request = call('boolean', { ids: ['box', 'circle'], operation: 'union', revision: context.revision });
        await vi.waitFor(() => expect(combinePaths).toHaveBeenCalled());
        editor.transact('Concurrent edit', doc => { doc.pagesById[editor.pageId].objects.box.name = 'Changed'; });
        ready.resolve();
        expect((await request).structuredContent?.error.code).toBe('stale_revision');
        expect(editor.page.objects.box.parentId).toBe('board');
    });
});

describe('image MCP integration', () => {
    it('forwards local removal/restoration with agent operation and rejects stale image edits', async () => {
        const images = { removeBackground: vi.fn(async (_id, operation, signal) => { expect(operation.author).toBe('alpha'); expect(signal).toBeInstanceOf(AbortSignal); }), restore: vi.fn() };
        const { ok, call } = fixture({ services: { images } });
        await ok('image', { id: 'box', action: 'remove_background', revision: 0 });
        expect(images.removeBackground).toHaveBeenCalledWith('box', expect.objectContaining({ label: 'agent:alpha' }), expect.any(AbortSignal));
        await ok('image', { id: 'box', action: 'restore', revision: 0 });
        expect(images.restore).toHaveBeenCalledWith('box', expect.objectContaining({ author: 'alpha' }));
        expect((await call('image', { id: 'box', action: 'restore', revision: 1 })).structuredContent?.error.code).toBe('stale_revision');
        expect(images.restore).toHaveBeenCalledTimes(1);
    });
});
