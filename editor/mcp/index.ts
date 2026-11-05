/** Independent MCP dispatcher. Model changes use the editor's isolated transactions. */
import type { CanvasDocument, Data, EditorStore, RenderView, Shape, Page, ToolResult, EditorServices } from '../contracts';
import { createShape, insertShape, removeShapes, reparentShapes, cloneShapes, descendants, topLevelIds } from '../document';
import { importHtml, exportHtml } from '../formats';
import { richText, textValue, uid } from '../formats/model';
import { safeUrl } from '../formats/markup';
import { applyStyles } from './style';
import { TOOLS, validateToolArgs } from './defs';
import { GUIDES } from './guides';
export { TOOLS };
export interface McpOptions extends Data {
    services?: Partial<EditorServices>;
    fonts?: () => Data[];
    undo?: (agent: string) => boolean | Promise<boolean>;
    editing?: () => string | null;
    onHighlight?: (agent: string, ids: string[]) => void;
    afterWrite?: () => void | Promise<void>;
    timeoutMs?: number;
    global?: boolean;
}
class McpError extends Error {
    constructor(public code: string, message: string) { super(message); }
}
const writes = new Set(['write_html', 'update', 'move', 'duplicate', 'delete', 'batch', 'create_board', 'component', 'undo']);
interface AgentState {
    aliases: Map<string, string>;
    reverse: Map<string, string>;
    counter: number;
}
export function installLvMcp(editor: EditorStore, view: RenderView, options: McpOptions = {}) {
    let disposed = false, revision = 0, queue: Promise<unknown> = Promise.resolve(), latest = editor.lastOperation;
    const sessions = new Map<string, AbortController>();
    const agents = new Map<string, AgentState>(), cache = new Map<string, {
        signature: string;
        result: Promise<ToolResult>;
        bytes: number;
    }>();
    let cacheBytes = 0;
    const evict = (key: string) => {
        const entry = cache.get(key);
        if (entry)
            cacheBytes -= entry.bytes;
        cache.delete(key);
    };
    const trimCache = () => {
        while (cache.size > 500 || cacheBytes > 8 * 1024 * 1024) {
            const key = cache.keys().next().value;
            if (key === undefined)
                break;
            evict(key);
        }
    };
    const services = options.services ?? {};
    const unsubscribe = editor.on(event => {
        if (event.changes) {
            revision++;
            latest = event.operation;
        }
        else if (event.projection) {
            revision++;
            latest = { id: uid(), label: 'projection' };
        }
    });
    function state(agent: string) {
        let s = agents.get(agent);
        if (!s) {
            s = { aliases: new Map(), reverse: new Map(), counter: 0 };
            agents.set(agent, s);
        }
        return s;
    }
    function alias(agent: string, id: string) {
        const s = state(agent);
        if (!s.reverse.has(id)) {
            let short = `n${++s.counter}`;
            while (editor.page.objects[short])
                short = `n${++s.counter}`;
            s.aliases.set(short, id);
            s.reverse.set(id, short);
        }
        return s.reverse.get(id)!;
    }
    function resolve(agent: string, value: string, page = editor.page): string {
        if (typeof value !== 'string' || !value)
            throw new McpError('bad_args', 'A layer ID is required');
        if (value.startsWith('@')) {
            const matches = Object.values(page.objects).filter(s => (s.dataRef ?? s['data-ref'] ?? s.htmlAttrs?.['data-ref']) === value.slice(1));
            if (matches.length !== 1)
                throw new McpError(matches.length ? 'invalid' : 'not_found', matches.length ? 'Reference is not unique' : `Reference ${value} was not found`);
            return matches[0].id;
        }
        const id = page.objects[value] ? value : state(agent).aliases.get(value) ?? value;
        if (!page.objects[id])
            throw new McpError('not_found', `Layer ${value} was not found`);
        return id;
    }
    const describe = (agent: string, s: Shape, detailed = false): Data => ({ id: alias(agent, s.id), rawId: s.id, name: s.name ?? s.type, kind: s.type, ...s.dataRef || s['data-ref'] ? { ref: s.dataRef ?? s['data-ref'] } : {}, ...detailed ? { x: s.x, y: s.y, width: s.width, height: s.height, hidden: !!s.hidden, locked: !!s.locked, parent: s.parentId === 'root' ? 'root' : alias(agent, s.parentId), ...s.type === 'text' ? { text: textValue(s) } : {}, ...s.layout ? { layout: s.layout } : {}, ...s.fills?.length ? { fills: s.fills } : {}, ...s.childIds ? { childCount: s.childIds.length } : {} } : {} });
    function response(data: Data, images: Data[] = []): ToolResult { return { content: [{ type: 'text', text: JSON.stringify(data) }, ...images], structuredContent: data }; }
    function failure(error: unknown): ToolResult { const e = error as any; return { ...response({ ok: false, error: { code: e?.code ?? 'failed', message: e?.message ?? String(error) }, revision }), isError: true }; }
    const busy = () => !!(editor.undo.blocked || editor.activeSession || options.editing?.());
    function destination(agent: string, target: string, position: string, page: Page): {
        parent: string;
        index: number;
    } {
        const id = resolve(agent, target, page), s = page.objects[id];
        if (position === 'first' || position === 'last') {
            if (!s.childIds)
                throw new McpError('invalid', 'Target is not a container');
            return { parent: id, index: position === 'first' ? 0 : s.childIds.length };
        }
        if (id === 'root')
            throw new McpError('invalid', 'The root has no siblings');
        const parent = page.objects[s.parentId];
        return { parent: parent.id, index: parent.childIds!.indexOf(id) + (position === 'after' ? 1 : 0) };
    }
    function apply(agent: string, name: string, args: Data, doc: CanvasDocument, affected: Set<string>, warnings: string[]): Data {
        const page = doc.pagesById[editor.pageId];
        if (!page)
            throw new McpError('not_found', 'Active page was removed');
        if (name === 'create_board') {
            const boards = (page.objects.root.childIds ?? []).map(id => page.objects[id]);
            const x = boards.length ? Math.max(...boards.map(s => s.x + s.width)) + 100 : 0;
            const s = createShape('frame', { id: options.newId?.() ?? uid(), x, y: 0, width: args.width, height: args.height ?? 0, name: args.name ?? 'Board', layout: { type: 'flex', direction: 'column', gap: 0 }, heightSizing: args.height === undefined ? 'hug' : 'fixed', childIds: [], fills: [{ color: '#fff' }] });
            insertShape(page, s, 'root');
            affected.add(s.id);
            return { id: alias(agent, s.id), rawId: s.id };
        }
        if (name === 'write_html') {
            const replaceId = args.position === 'replace' ? resolve(agent, args.target, page) : null;
            if (replaceId === 'root')
                throw new McpError('invalid', 'Cannot replace the root');
            const dest = destination(agent, args.target, args.position === 'replace' ? 'before' : args.position, page), parent = page.objects[dest.parent], parsed = (() => {
                try {
                    return importHtml(args.html, { x: parent.x, y: parent.y, width: parent.width || 1000, parentId: parent.id, id: options.newId });
                }
                catch (error) {
                    throw new McpError('bad_html', (error as Error).message);
                }
            })();
            if (!parsed.rootIds.length)
                throw new McpError('bad_html', 'HTML has no editable content');
            warnings.push(...parsed.warnings);
            const add = (id: string, parentId: string, index?: number) => {
                const source = parsed.objects[id], children = [...source.childIds ?? []];
                const s = { ...source, ...source.childIds ? { childIds: [] } : {} };
                insertShape(page, s, parentId, index);
                for (const child of children)
                    add(child, id);
                affected.add(id);
                alias(agent, id);
            };
            parsed.rootIds.forEach((id, index) => add(id, parent.id, dest.index + index));
            if (replaceId)
                removeShapes(page, [replaceId]);
            return { ids: parsed.rootIds.map(id => alias(agent, id)), rawIds: parsed.rootIds };
        }
        if (name === 'update') {
            const id = resolve(agent, args.id, page);
            if (id === 'root')
                throw new McpError('invalid', 'Root updates are not supported');
            const s = page.objects[id];
            if (args.style)
                warnings.push(...applyStyles(page, s, args.style).map(k => `Ignored CSS key: ${k}`));
            if (args.text !== undefined) {
                if (s.type !== 'text')
                    throw new McpError('invalid', 'Text can only be assigned to text layers');
                const first = s.content?.children?.[0]?.children?.[0] ?? {};
                s.content = richText(args.text, Object.fromEntries(Object.entries(first).filter(([k]) => k !== 'text')));
            }
            if (args.attrs)
                for (const [key, value] of Object.entries(args.attrs) as [
                    string,
                    string
                ][]) {
                    if (key === 'name')
                        s.name = value;
                    else if (key === 'src') {
                        if (!['image', 'svg'].includes(s.type))
                            throw new McpError('invalid', 'src requires an image layer');
                        if (!safeUrl(value))
                            throw new McpError('invalid', 'Unsafe image URL');
                        s.image = { ...s.image, src: value };
                    }
                    else if (key === 'hidden') {
                        if (!['true', 'false', ''].includes(value))
                            throw new McpError('bad_args', 'hidden must be true or false');
                        s.hidden = value === 'true';
                    }
                    else
                        warnings.push(`Ignored attribute: ${key}`);
                }
            affected.add(id);
            return { id: alias(agent, id), rawId: id };
        }
        if (name === 'move') {
            const id = resolve(agent, args.id, page);
            if (id === 'root')
                throw new McpError('invalid', 'Cannot move the root');
            const dest = destination(agent, args.target, args.position, page);
            if ((args.position === 'before' || args.position === 'after') && id === resolve(agent, args.target, page))
                throw new McpError('invalid', 'Cannot move a layer relative to itself');
            const s = page.objects[id];
            if (s.parentId === dest.parent && page.objects[dest.parent].childIds!.indexOf(id) < dest.index)
                dest.index--;
            reparentShapes(page, [id], dest.parent, dest.index);
            affected.add(id);
            return { id: alias(agent, id) };
        }
        if (name === 'duplicate') {
            const id = resolve(agent, args.id, page);
            if (id === 'root')
                throw new McpError('invalid', 'Cannot duplicate the root');
            const dest = args.target ? destination(agent, args.target, args.position ?? 'after', page) : destination(agent, id, 'after', page);
            const instance = services.duplicateComponentMain?.(doc, page, id, { parentId: dest.parent, dx: 0, dy: 0 });
            const roots: Shape[] = instance ? [instance] : cloneShapes(page, [id], { parentId: dest.parent, index: dest.index });
            if (instance)
                reparentShapes(page, [instance.id], dest.parent, dest.index);
            for (const root of roots)
                for (const s of descendants(page, root.id, true)) {
                    affected.add(s.id);
                    alias(agent, s.id);
                }
            return { ids: roots.map(s => alias(agent, s.id)), rawIds: roots.map(s => s.id) };
        }
        if (name === 'delete') {
            const ids = args.ids.map((id: string) => resolve(agent, id, page));
            if (ids.includes('root'))
                throw new McpError('invalid', 'Cannot delete the root');
            removeShapes(page, ids);
            return { deleted: ids.map((id: string) => alias(agent, id)) };
        }
        if (name === 'component') {
            if (!services.components)
                throw new McpError('failed', 'Component service is unavailable');
            const resolved = { ...args };
            for (const key of ['id', 'parent', 'layer'])
                if (resolved[key])
                    resolved[key] = resolve(agent, resolved[key], page);
            if (resolved.source && !doc.components?.[resolved.source])
                throw new McpError('not_found', 'Source component was not found');
            if (args.ids)
                resolved.ids = args.ids.map((id: string) => resolve(agent, id, page));
            const result = services.components.run(args.action, resolved);
            if (result.pageId && result.pageId !== editor.pageId) {
                if (!doc.pagesById[result.pageId])
                    throw new McpError('invalid', 'Component returned a missing page');
                editor.setPage(result.pageId);
            }
            const resultPage = doc.pagesById[editor.pageId];
            const scan = (value: any, key = '') => {
                if (typeof value === 'string' && resultPage.objects[value] && ['id', 'ids', 'selection', 'mainId', 'instanceId', 'rootId', 'created'].includes(key))
                    affected.add(value);
                else if (Array.isArray(value))
                    value.forEach(v => scan(v, key));
                else if (value && typeof value === 'object')
                    for (const [k, v] of Object.entries(value))
                        scan(v, k);
            };
            scan(result);
            return { ...result, ...Array.isArray(result.selection) ? { rawSelection: result.selection, selection: result.selection.map((id: string) => alias(agent, id)) } : {} };
        }
        throw new McpError('unknown_tool', `Unsupported write tool: ${name}`);
    }
    function check(signal: AbortSignal) {
        if (signal.aborted)
            throw signal.reason;
    }
    async function waiting<T>(work: Promise<T> | T, signal: AbortSignal): Promise<T> {
        check(signal);
        let abort!: () => void;
        try {
            return await Promise.race([work, new Promise<never>((_, reject) => {
                abort = () => reject(signal.reason);
                signal.addEventListener('abort', abort, { once: true });
            })]);
        }
        finally {
            signal.removeEventListener('abort', abort);
        }
    }
    async function settled(signal: AbortSignal) {
        await waiting((async () => { await view.settled(); await options.afterWrite?.(); })(), signal);
    }
    function diagnostics(ids: string[]) { const measured = view.measure(ids.filter(id => editor.page.objects[id])); return [...measured].map(([id, m]) => ({ id, bounds: { x: m.x, y: m.y, width: m.w, height: m.h }, clippedText: m.clippedText, overflowParent: m.overflowParent, ...m.fontFallback ? { fontFallback: m.fontFallback } : {}, ...m.imageFailed ? { imageFailed: true } : {} })); }
    async function execute(agent: string, name: string, args: Data, signal: AbortSignal): Promise<ToolResult> {
        check(signal);
        if (!TOOLS.some(t => t.name === name))
            throw new McpError('unknown_tool', `Unknown tool: ${name}`);
        const invalid = validateToolArgs(name, args);
        if (invalid)
            throw new McpError('bad_args', invalid);
        if (writes.has(name) && busy())
            throw new McpError('busy', 'A user edit is in progress');
        if (name === 'undo') {
            const last = latest ?? editor.lastOperation;
            if (!options.undo && last?.label !== `agent:${agent}` && last?.author !== agent)
                throw new McpError('nothing_to_undo', 'The latest edit does not belong to this agent');
            const ok = options.undo ? await waiting(options.undo(agent), signal) : editor.undoStep();
            if (!ok)
                throw new McpError('nothing_to_undo', 'There is no eligible agent edit');
            latest = { id: uid(), label: 'Undo' };
            await settled(signal);
            return response({ ok: true, revision });
        }
        if (writes.has(name)) {
            let preflightText = JSON.stringify(args);
            for (const op of name === 'batch' ? args.ops : [{ tool: name, args }]) {
                if (op.tool !== 'update' || !op.args.style?.['font-family'])
                    continue;
                try {
                    const id = resolve(agent, op.args.id);
                    preflightText += ' ' + descendants(editor.page, id, true).filter(s => s.type === 'text').map(textValue).join('\n');
                }
                catch { /* A reference created by an earlier batch write is represented in the HTML arguments. */ }
            }
            await waiting(services.fonts?.ensure?.(preflightText), signal);
            check(signal);
            if (busy())
                throw new McpError('busy', 'A user edit started while fonts were loading');
            const s = state(agent), saved = { aliases: new Map(s.aliases), reverse: new Map(s.reverse), counter: s.counter }, affected = new Set<string>(), warnings: string[] = [];
            let result: Data;
            try {
                result = editor.transact({ id: uid(), label: `agent:${agent}`, author: agent }, doc => {
                    if (name === 'batch') {
                        const results: Data[] = [];
                        for (const op of args.ops)
                            results.push(apply(agent, op.tool, op.args, doc, affected, warnings));
                        return { results };
                    }
                    return apply(agent, name, args, doc, affected, warnings);
                });
            }
            catch (error) {
                Object.assign(s, saved);
                if (error instanceof McpError)
                    throw error;
                throw new McpError('invalid', (error as Error).message);
            }
            await settled(signal);
            const ids = [...affected].filter(id => editor.page.objects[id]);
            options.onHighlight?.(agent, ids);
            const measuredIds = [...new Set(ids.flatMap(id => descendants(editor.page, id, true).map(s => s.id)))], measured = diagnostics(measuredIds);
            for (const diagnostic of measured) {
                const label = alias(agent, diagnostic.id);
                if (diagnostic.clippedText)
                    warnings.push(`Clipped text: ${label}`);
                if (diagnostic.overflowParent)
                    warnings.push(`Overflows parent: ${label}`);
                if (diagnostic.fontFallback)
                    warnings.push(`Font fallback: ${label} (${diagnostic.fontFallback})`);
                if (diagnostic.imageFailed)
                    warnings.push(`Image failed: ${label}`);
            }
            return response({ ok: true, ...result, revision, diagnostics: measured, warnings: [...new Set(warnings)] });
        }
        const page = editor.page;
        if (name === 'get_context')
            return response({ ok: true, revision, page: { id: page.id, name: page.name }, pages: editor.doc.pages.map(id => ({ id, name: editor.doc.pagesById[id].name })), viewport: editor.viewport, selection: editor.selection.map(id => alias(agent, id)), boards: (page.objects.root.childIds ?? []).map(id => alias(agent, id)), boardDetails: (page.objects.root.childIds ?? []).map(id => describe(agent, page.objects[id], true)), editing: options.editing?.() ?? null });
        if (name === 'get_tree') {
            if (args.detail === 'detailed')
                await settled(signal);
            const id = args.id ? resolve(agent, args.id) : 'root', depth = args.depth ?? 4;
            let count = 0, truncated = false;
            const walk = (key: string, level: number): Data | null => {
                if (count >= 400) {
                    truncated = true;
                    return null;
                }
                count++;
                const s = page.objects[key], value = describe(agent, s, args.detail === 'detailed');
                if (s.childIds?.length) {
                    value.childCount = s.childIds.length;
                    if (level < depth)
                        value.children = s.childIds.map(id => walk(id, level + 1)).filter(Boolean);
                    else
                        value.collapsed = true;
                }
                return value;
            };
            const tree = walk(id, 0);
            return response({ ok: true, revision, tree, count, truncated, ...args.detail === 'detailed' ? { diagnostics: diagnostics(descendants(page, id, true).slice(0, 400).map(s => s.id)) } : {} });
        }
        if (name === 'find') {
            const start = args.within ? resolve(agent, args.within) : 'root', rows = descendants(page, start, true), matches = rows.filter(s => (args.text === undefined || textValue(s).toLocaleLowerCase().includes(args.text.toLocaleLowerCase())) && (args.kind === undefined || s.type === args.kind) && (args.name === undefined || String(s.name ?? '').toLocaleLowerCase().includes(args.name.toLocaleLowerCase())));
            return response({ ok: true, revision, matches: matches.slice(0, 50).map(s => describe(agent, s, true)), truncated: matches.length > 50 });
        }
        if (name === 'get_html') {
            await settled(signal);
            const id = resolve(agent, args.id);
            let html: string;
            try {
                html = exportHtml(editor.doc, editor.pageId, [id], { view, limit: 200000, alias: id => alias(agent, id) });
            }
            catch (e) {
                throw new McpError('invalid', (e as Error).message);
            }
            return response({ ok: true, revision, html });
        }
        if (name === 'get_styles') {
            await settled(signal);
            return response({ ok: true, revision, styles: args.ids.map((key: string) => { const id = resolve(agent, key); return { id: alias(agent, id), rawId: id, style: view.computedStyle(id, args.keys) }; }) });
        }
        if (name === 'screenshot') {
            await settled(signal);
            const id = args.id ? resolve(agent, args.id) : undefined;
            const shot = await waiting(view.screenshot(id, { mode: args.mode ?? 'slice', slice: args.slice ?? 0 }), signal);
            if (!shot?.data || !shot.mimeType)
                throw new McpError('failed', 'Renderer returned no screenshot');
            return response({ ok: true, revision, ...shot.slices !== undefined ? { slices: shot.slices } : {} }, [{ type: 'image', data: shot.data, mimeType: shot.mimeType }]);
        }
        if (name === 'components') {
            if (!services.components)
                throw new McpError('failed', 'Component service is unavailable');
            const result = services.components.list(args.query, args.offset ?? 0);
            return response({ ok: true, revision, ...result });
        }
        if (name === 'fonts') {
            const catalog = options.fonts?.() ?? services.fonts?.catalog() ?? [];
            const query = (args.query ?? '').toLocaleLowerCase();
            return response({ ok: true, revision, fonts: catalog.filter((font: Data) => JSON.stringify(font).toLocaleLowerCase().includes(query)) });
        }
        if (name === 'assets') {
            const sources = (options.sources ?? []).filter((source: Data) => !args.kind || source.kind === args.kind), provider = options.assets;
            let result: Data[] = [];
            if (provider) {
                if (typeof provider === 'function')
                    result = await waiting(provider(args), signal);
                else if (typeof provider.search === 'function')
                    result = await waiting(provider.search(args.query ?? '', args.kind), signal);
                else if (typeof provider.list === 'function')
                    result = await waiting(provider.list(args.query ?? ''), signal);
            }
            for (const source of sources) {
                const rows = await waiting(typeof source.search === 'function' ? source.search(args.query ?? '') : typeof source.list === 'function' ? source.list(args.query ?? '') : [], signal);
                result.push(...rows);
            }
            return response({ ok: true, revision, assets: result, configured: !!provider || sources.length > 0 });
        }
        if (name === 'get_guide') {
            const topic = args.topic ?? 'html';
            return response({ ok: true, revision, topic, guide: GUIDES[topic] });
        }
        throw new McpError('unknown_tool', `Unknown tool: ${name}`);
    }
    function handleToolCall(agent: string, name: string, args: Data = {}, context: {
        idempotencyKey?: string;
        signal?: AbortSignal;
    } = {}): Promise<ToolResult> {
        if (typeof agent !== 'string' || !agent.trim() || agent.length > 200)
            return Promise.resolve(failure(new McpError('bad_args', 'Invalid agent identifier')));
        if (disposed)
            return Promise.resolve(failure(new McpError('failed', 'MCP session has ended')));
        const key = context.idempotencyKey ? `${agent}\0${context.idempotencyKey}` : null;
        let signature: string;
        try {
            args = structuredClone(args);
            signature = JSON.stringify({ name, args }, (_, value) => value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value);
        }
        catch {
            return Promise.resolve(failure(new McpError('bad_args', 'Arguments must be JSON serializable')));
        }
        if (key) {
            const previous = cache.get(key);
            if (previous)
                return previous.signature === signature ? previous.result : Promise.resolve(failure(new McpError('bad_args', 'Idempotency key was already used for a different request')));
        }
        let session = sessions.get(agent);
        if (!session) {
            session = new AbortController();
            sessions.set(agent, session);
        }
        const request = new AbortController();
        const signal = AbortSignal.any([session.signal, request.signal, ...context.signal ? [context.signal] : []]);
        const timer = setTimeout(() => request.abort(new McpError('timeout', 'Tool response exceeded its time limit; inspect revision before retrying')), Math.min(60000, Math.max(1, options.timeoutMs ?? 60000)));
        state(agent);
        const work = queue.then(() => execute(agent, name, args, signal));
        queue = work.then(() => { }, () => { });
        const task = waiting(work, signal).catch(error => failure(signal.aborted && !(signal.reason instanceof McpError) ? new McpError('cancelled', 'Tool cancelled; applied changes are not rolled back; inspect revision before retrying') : error)).finally(() => clearTimeout(timer));
        if (key) {
            const entry = { signature, result: task, bytes: signature.length * 2 };
            cache.set(key, entry);
            cacheBytes += entry.bytes;
            trimCache();
            void task.then(result => {
                if (cache.get(key) !== entry)
                    return;
                const bytes = JSON.stringify(result).length * 2;
                entry.bytes += bytes;
                cacheBytes += bytes;
                trimCache();
            });
        }
        return task;
    }
    const globalTarget: Data | undefined = options.target ?? (typeof window !== 'undefined' ? window : undefined);
    const api = { tools: () => TOOLS.map(t => structuredClone(t)), handleToolCall, endSession(agent?: string) {
            if (agent) {
                sessions.get(agent)?.abort(new McpError('failed', 'MCP session has ended'));
                sessions.delete(agent);
                agents.delete(agent);
                for (const key of cache.keys())
                    if (key.startsWith(`${agent}\0`))
                        evict(key);
                options.onHighlight?.(agent, []);
            }
            else {
                for (const name of agents.keys()) {
                    sessions.get(name)?.abort(new McpError('failed', 'MCP session has ended'));
                    options.onHighlight?.(name, []);
                }
                sessions.clear();
                agents.clear();
                cache.clear();
                cacheBytes = 0;
            }
        }, dispose() {
            if (disposed)
                return;
            disposed = true;
            unsubscribe();
            api.endSession();
            if (globalTarget?.lvMcp === api)
                delete globalTarget.lvMcp;
        } };
    if (options.global !== false && globalTarget)
        globalTarget.lvMcp = api;
    return api;
}
