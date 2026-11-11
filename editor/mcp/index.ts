/** Independent MCP dispatcher. Model changes use the editor's isolated transactions. */
import type { CanvasDocument, Data, EditorStore, RenderView, Shape, Page, ToolResult, EditorServices } from '../contracts';
import { createShape, insertShape, removeShapes, reparentShapes, cloneShapes, descendants, topLevelIds, isEditable } from '../document';
import { importHtml, importSvg, exportHtml } from '../formats';
import { richText, textValue, uid } from '../formats/model';
import { safeUrl } from '../formats/markup';
import { insertPathNode, deletePathNodes, movePathNodes, setPathHandle, closePath, convertPathNode } from '../commands/path';
import { identity, pathBounds } from '../geometry';
import { createCommands } from '../commands';
import { joinPathEnds, regeneratePrimitive } from '../commands/path';
import { exportCanvasJson } from '../formats';
import { portableDocument, portableClipboard } from '../images/assets';
import { applyEditorOperation, applyView, requireEditable, clipboardPayload, pasteProperties, validateClipboardPayload, prepareClipboardPayload, selectionDocument } from './operations';
import { isResourceRead, readResourceOperation, applyResourceOperation, prepareResourceOperation } from './resources';
import { applyStyles } from './style';
import { EDITOR_TOOLS, DOCUMENT_MUTATIONS, validateToolArgs } from './defs';
import { GUIDES } from './guides';
export { EDITOR_TOOLS as TOOLS };
export interface McpOptions extends Data {
    services?: Partial<EditorServices>;
    fonts?: () => Data[];
    undo?: (agent: string, signal?: AbortSignal, requestId?: string) => boolean | Promise<boolean>;
    redo?: (agent: string, signal?: AbortSignal, requestId?: string) => boolean | Promise<boolean>;
    editing?: () => string | null;
    onHighlight?: (agent: string, ids: string[]) => void;
    afterWrite?: () => void | Promise<void>;
    timeoutMs?: number;
    global?: boolean;
}
class McpError extends Error {
    constructor(public code: string, message: string) { super(message); }
}
const writes = new Set(DOCUMENT_MUTATIONS.filter(name => name !== 'select_page'));
interface AgentState {
    aliases: Map<string, { id: string; pageId: string }>;
    reverse: Map<string, string>;
    counter: number;
    clipboard?: Data;
}
export function installLvMcp(editor: EditorStore, view: RenderView, options: McpOptions = {}) {
    let disposed = false, revision = 0, pageGeneration = 0, queue: Promise<unknown> = Promise.resolve(), latest = editor.lastOperation;
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
    let redoOwner: string | null = null, redoRevision = -1;
    const unsubscribe = editor.on(event => {
        if (event.changes) {
            revision++;
            latest = event.operation;
        }
        else if (event.projection) {
            revision++;
            latest = { id: uid(), label: 'projection' };
        }
        if (event.page) {
            pageGeneration++;
            if (!event.changes && !event.projection)
                revision++;
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
        const key = `${editor.pageId}\0${id}`;
        if (!s.reverse.has(key)) {
            let short = `n${++s.counter}`;
            while (editor.page.objects[short])
                short = `n${++s.counter}`;
            s.aliases.set(short, { id, pageId: editor.pageId });
            s.reverse.set(key, short);
        }
        return s.reverse.get(key)!;
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
        const mapped = state(agent).aliases.get(value);
        if (mapped && mapped.pageId !== page.id)
            throw new McpError('not_found', `Layer alias ${value} belongs to another page; read the current context`);
        const id = mapped?.id ?? value;
        if (!page.objects[id])
            throw new McpError('not_found', `Layer ${value} was not found`);
        return id;
    }
    const describe = (agent: string, s: Shape, detailed = false): Data => ({ id: alias(agent, s.id), rawId: s.id, name: s.name ?? s.type, kind: s.type, ...s.dataRef || s['data-ref'] ? { ref: s.dataRef ?? s['data-ref'] } : {}, ...detailed ? { properties: structuredClone(Object.fromEntries(Object.entries(s).filter(([key]) => !['id','parentId','enclosingFrameId','childIds','box','corners','transform','inverseTransform'].includes(key)))), x: s.x, y: s.y, width: s.width, height: s.height, hidden: !!s.hidden, locked: !!s.locked, parent: s.parentId === 'root' ? 'root' : alias(agent, s.parentId), ...s.type === 'text' ? { text: textValue(s) } : {}, ...s.layout ? { layout: s.layout } : {}, ...s.fills?.length ? { fills: s.fills } : {}, ...s.childIds ? { childCount: s.childIds.length } : {} } : {} });
    function response(data: Data, images: Data[] = []): ToolResult { return { content: [{ type: 'text', text: JSON.stringify(data) }, ...images], structuredContent: data }; }
    function failure(error: unknown): ToolResult { const e = error as any; return { ...response({ ok: false, error: { code: e?.code ?? 'failed', message: e?.message ?? String(error) }, revision }), isError: true }; }
    function context(agent: string): ToolResult {
        const page = editor.page;
        return response({ ok: true, revision, page: { id: page.id, name: page.name }, pages: editor.doc.pages.map(id => ({ id, name: editor.doc.pagesById[id].name })), viewport: editor.viewport, selection: editor.selection.map(id => alias(agent, id)), boards: (page.objects.root.childIds ?? []).map(id => alias(agent, id)), boardDetails: (page.objects.root.childIds ?? []).map(id => describe(agent, page.objects[id], true)), editing: options.editing?.() ?? null });
    }
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
        if (name === 'clipboard' && args.preparedAssets) Object.assign(doc.assets ||= {}, structuredClone(args.preparedAssets));
        if (['page', 'create_shape', 'edit_shapes', 'edit_text', 'styles', 'libraries', 'document_assets', 'clipboard'].includes(name)) {
            const resolved = { ...args };
            if (args.ids) resolved.ids = args.ids.map((id: string) => resolve(agent, id, page));
            for (const key of ['parentId', 'maskId']) if (args[key]) resolved[key] = resolve(agent, args[key], page);
            if (name === 'edit_text') resolved.id = resolve(agent, args.id, page);
            let result: Data | undefined;
            if (name === 'clipboard') {
                if (['copy', 'cut', 'copy_properties'].includes(args.action)) {
                    if (args.action === 'cut') requireEditable(editor, resolved.ids);
                    const payload = args.preparedClipboardPayload ?? clipboardPayload(resolved, editor);
                    state(agent).clipboard = structuredClone(payload);
                    if (args.action === 'cut') removeShapes(page, resolved.ids);
                    result = { payload, ...(args.action === 'cut' ? { deleted: resolved.ids } : {}) };
                } else {
                    let payload = args.payload ?? state(agent).clipboard;
                    if (!payload) throw new McpError('bad_args', 'Copy content or supply a clipboard payload first');
                    if (args.action === 'paste_properties') result = pasteProperties(payload, resolved.ids, editor);
                    else {
                        validateClipboardPayload(payload);
                        payload = prepareClipboardPayload(payload, doc);
                        if (resolved.parentId && resolved.parentId !== 'root') requireEditable(editor, [resolved.parentId]);
                        if (args.mode === 'replace') requireEditable(editor, resolved.ids ?? []);
                        const commands = createCommands(editor, { duplicateComponentMain: services.duplicateComponentMain });
                        const mode = args.mode === 'replace' ? 'paste-replace' : args.mode === 'in_place' ? 'paste-in-place' : 'paste';
                        const changed = commands.run('edit.' + mode, { ...resolved, ids: resolved.ids ?? [], payload });
                        if (changed !== true) throw new McpError('invalid', 'Clipboard insertion failed');
                        result = { selection: [...editor.selection] };
                    }
                }
            } else if (['styles', 'libraries', 'document_assets'].includes(name)) {
                if (resolved.ids) requireEditable(editor, resolved.ids);
                if (resolved.parentId && resolved.parentId !== 'root') requireEditable(editor, [resolved.parentId]);
                result = applyResourceOperation(name, resolved, doc, editor.pageId, services);
            } else result = applyEditorOperation(name, resolved, editor, doc, services);
            if (!result) throw new McpError('unknown_tool', 'Unsupported operation');
            const selection = result.selection ?? result.rawIds ?? [];
            for (const id of selection) if (editor.page.objects[id]) affected.add(id);
            return { ...result, ...result.selection ? { rawIds: result.selection, ids: result.selection.map((id: string) => alias(agent, id)), selection: result.selection.map((id: string) => alias(agent, id)) } : result.rawIds ? { ids: result.rawIds.map((id: string) => alias(agent, id)) } : {} };
        }
        if (name === 'create_board') {
            const boards = (page.objects.root.childIds ?? []).map(id => page.objects[id]);
            const x = boards.length ? Math.max(...boards.map(s => s.x + s.width)) + 100 : 0;
            const s = createShape('frame', { id: options.newId?.() ?? uid(), x, y: 0, width: args.width, height: args.height ?? 0, name: args.name ?? 'Board', layout: { type: 'flex', direction: 'column', gap: 0 }, heightSizing: args.height === undefined ? 'hug' : 'fixed', childIds: [], fills: [{ color: '#fff' }] });
            insertShape(page, s, 'root');
            affected.add(s.id);
            return { id: alias(agent, s.id), rawId: s.id };
        }
        if (name === 'write_html' || name === 'write_svg') {
            const replaceId = args.position === 'replace' ? resolve(agent, args.target, page) : null;
            if (replaceId === 'root')
                throw new McpError('invalid', 'Cannot replace the root');
            const dest = destination(agent, args.target, args.position === 'replace' ? 'before' : args.position, page), parent = page.objects[dest.parent];
            if (parent.id !== 'root' && !isEditable(page, parent.id) || replaceId && !isEditable(page, replaceId))
                throw new McpError('invalid', 'Insertion destination is locked or hidden');
            const parsed = (() => {
                try {
                    return (name === 'write_svg' ? importSvg : importHtml)(args.svg ?? args.html, { x: parent.x, y: parent.y, width: parent.width || 1000, parentId: parent.id, id: options.newId });
                }
                catch (error) {
                    throw new McpError(name === 'write_svg' ? 'bad_svg' : 'bad_html', (error as Error).message);
                }
            })();
            if (!parsed.rootIds.length)
                throw new McpError(name === 'write_svg' ? 'bad_svg' : 'bad_html', 'Input has no editable content');
            if (name === 'write_svg' && (parsed.shapes.length > 2000 || parsed.shapes.reduce((count, s) => count + (Array.isArray(s.content) ? s.content.length : 0), 0) > 10000))
                throw new McpError('bad_svg', 'SVG exceeds the 2000 layer or 10000 segment limit');
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
        if (name === 'edit_path') {
            const id = resolve(agent, args.id, page), shape = page.objects[id];
            if (shape.type !== 'path' || !Array.isArray(shape.content))
                throw new McpError('invalid', 'Choose an editable path; use boolean with operation flatten before node editing');
            if (!isEditable(page, id))
                throw new McpError('invalid', 'Path is locked or hidden');
            if (args.action === 'join' || args.action === 'merge') {
                const otherId = args.otherId ? resolve(agent, args.otherId, page) : undefined;
                if (otherId === id) throw new McpError('bad_args', 'Choose distinct paths');
                if (otherId) requireEditable(editor, [otherId]);
                joinPathEnds(shape, otherId ? page.objects[otherId] : undefined, { merge: args.action === 'merge', firstStart: args.firstStart, secondEnd: args.secondEnd });
                if (otherId) removeShapes(page, [otherId]);
                affected.add(id); return { id: alias(agent, id), rawId: id };
            }
            if (args.action === 'primitive') { regeneratePrimitive(shape, args.primitive); affected.add(id); return { id: alias(agent, id), rawId: id }; }
            const indices = args.indices ?? (args.index === undefined ? [] : [args.index]);
            if (indices.some((index: number) => !shape.content[index] || shape.content[index].command === 'close'))
                throw new McpError('bad_args', 'Unknown path node index');
            if (args.action === 'move_nodes') movePathNodes(shape, indices, args.dx, args.dy);
            else if (args.action === 'insert_node') insertPathNode(shape, args.index, args.t);
            else if (args.action === 'delete_nodes') deletePathNodes(shape, indices);
            else if (args.action === 'set_handle') setPathHandle(shape, args.index, args.handle, args.point, args.mode);
            else if (args.action === 'convert_node') convertPathNode(shape, args.index, args.nodeKind);
            else closePath(shape, args.action === 'close', args.index);
            affected.add(id);
            return { id: alias(agent, id), rawId: id };
        }
        if (name === 'boolean') {
            const ids = args.ids.map((id: string) => resolve(agent, id, page)), first = page.objects[ids[0]], prepared = args.prepared, flatten = args.operation === 'flatten';
            const parentId = ids.every((id: string) => page.objects[id].parentId === first.parentId) ? first.parentId : 'root';
            const shape = createShape(flatten ? 'path' : 'boolean', { ...Object.fromEntries(['fills', 'strokes', 'strokeWidth', 'strokeAlignment', 'strokeCap', 'strokeJoin', 'strokeDashArray', 'opacity', 'blendMode', 'effects', 'shadows', 'blur', 'backgroundBlur', ...(flatten ? ['absolute', 'layoutPositioning', 'layoutChild', 'hSizing', 'vSizing', 'widthSizing', 'heightSizing', 'layoutSizing', 'alignSelf', 'gridCell', 'constraints', 'minWidth', 'maxWidth', 'minHeight', 'maxHeight'] : [])].filter(key => key in first).map(key => [key, structuredClone(first[key])])), id: options.newId?.() ?? uid(), type: flatten ? 'path' : 'boolean', ...(flatten ? { flattenSourceIds: [...ids] } : { childIds: [], booleanOperation: args.operation }), name: flatten ? 'Flattened path' : `Boolean ${args.operation}`, ...(prepared.bounds ?? pathBounds(prepared.segments)), transform: identity(), inverseTransform: identity(), rotation: 0, flipX: false, flipY: false, content: prepared.segments, fillRule: prepared.fillRule });
            delete shape.primitive;
            insertShape(page, shape, parentId, page.objects[parentId].childIds!.indexOf(first.id));
            if (flatten)
                for (const id of ids) page.objects[id].hidden = true;
            else {
                reparentShapes(page, ids, shape.id);
                shape.childIds = [...ids];
            }
            affected.add(shape.id);
            return { id: alias(agent, shape.id), rawId: shape.id, operands: ids.map((id: string) => alias(agent, id)) };
        }
        if (name === 'update') {
            const id = resolve(agent, args.id, page);
            if (id === 'root')
                throw new McpError('invalid', 'Root updates are not supported');
            const s = page.objects[id];
            requireEditable(editor, [id], args.attrs && Object.keys(args.attrs).length === 1 && args.attrs.hidden === 'false' && !args.style && args.text === undefined ? { hidden: false } : undefined);
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
            requireEditable(editor, [id]);
            const dest = destination(agent, args.target, args.position, page);
            if (dest.parent !== 'root') requireEditable(editor, [dest.parent]);
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
            requireEditable(editor, [id]);
            const dest = args.target ? destination(agent, args.target, args.position ?? 'after', page) : destination(agent, id, 'after', page);
            const instance = services.duplicateComponentMain?.(doc, page, id, { parentId: dest.parent, dx: 0, dy: 0 });
            const roots: Shape[] = instance ? [instance] : cloneShapes(page, [id], { parentId: dest.parent, index: dest.index });
            if (dest.parent !== 'root') requireEditable(editor, [dest.parent]);
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
            requireEditable(editor, ids);
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
            for (const id of [...resolved.ids ?? [], ...resolved.id ? [resolved.id] : [], ...resolved.parent ? [resolved.parent] : []]) if (id !== 'root') requireEditable(editor, [id]);
            if (args.action === 'axes') {
                const shape = page.objects[resolved.id ?? resolved.ids?.[0]], component = doc.components?.[shape?.componentId];
                if (!component || !shape.isMain) throw new McpError('invalid', 'Choose a main component to edit variant axes');
                component.variantProperties = structuredClone(args.variantProperties); affected.add(shape.id); return { componentId: component.id, variantProperties: component.variantProperties };
            }
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
    async function readExport(agent: string, args: Data, signal: AbortSignal, checkScope: () => void, maxBytes: number, wholeDocument = false): Promise<{ mime: string; bytes: Uint8Array }> {
        if (busy()) throw new McpError('busy', 'A user edit is in progress');
        await settled(signal); checkScope();
        const snapshot = editor.doc, sourcePage = editor.pageId;
        const guard = () => { check(signal); checkScope(); if (editor.doc !== snapshot || editor.pageId !== sourcePage) throw new McpError('stale_revision', 'Canvas changed during export; read context before retrying'); };
        const ids = args.ids?.length ? args.ids.map((id: string) => resolve(agent, id)) : [...editor.page.objects.root.childIds ?? []];
        let bytes: Uint8Array, mime: string;
        if (args.format === 'json') {
            const portable = await portableDocument(wholeDocument ? snapshot : selectionDocument(editor, ids), services.resolveImageSource, { signal, maxBytes }); guard();
            bytes = new TextEncoder().encode(JSON.stringify(wholeDocument ? exportCanvasJson(portable) : portable)); mime = 'application/json';
        }
        else if (args.format === 'html') {
            if (!ids.length) throw new McpError('invalid', 'Choose layers to export');
            const portable = await portableDocument(selectionDocument(editor, ids), services.resolveImageSource, { signal, maxBytes }); guard();
            bytes = new TextEncoder().encode(exportHtml(portable, sourcePage, ids, { view, limit: maxBytes })); mime = 'text/html';
        }
        else if (args.format === 'svg') {
            if (!services.export || !ids.length) throw new McpError('invalid', 'Choose layers to export');
            const source = await waiting((services.export as Data).svg(ids, args), signal); guard(); bytes = new TextEncoder().encode(source); mime = 'image/svg+xml';
        } else {
            if (!services.export || ids.length !== 1) throw new McpError('invalid', 'Choose one layer for a raster or PDF export');
            const blob = await waiting(services.export.layer(ids[0], args), signal); guard();
            if (blob.size > maxBytes) throw new McpError('response_limit', 'Export exceeds the byte limit; use export_document with filePath for large exports');
            bytes = new Uint8Array(await waiting(blob.arrayBuffer(), signal)); mime = blob.type;
        }
        guard(); if (bytes.byteLength > maxBytes) throw new McpError('response_limit', 'Export exceeds the byte limit; use export_document with filePath for large exports');
        return { bytes, mime };
    }
    async function execute(agent: string, name: string, args: Data, signal: AbortSignal, requestId: string | undefined, admittedPage: { id: string; generation: number }): Promise<ToolResult> {
        const checkPage = () => {
            check(signal);
            if (writes.has(name) && (editor.pageId !== admittedPage.id || pageGeneration !== admittedPage.generation))
                throw new McpError('page_changed', 'The selected page changed after this request was admitted; read context before retrying');
        };
        checkPage();
        if (!EDITOR_TOOLS.some(t => t.name === name))
            throw new McpError('unknown_tool', `Unknown tool: ${name}`);
        const invalid = validateToolArgs(name, args);
        if (invalid)
            throw new McpError('bad_args', invalid);
        const semanticRead = isResourceRead(name, args) || name === 'page' && args.action === 'list' || name === 'view' && args.action === 'get' || name === 'clipboard' && ['copy', 'copy_properties'].includes(args.action);
        if ((writes.has(name) && !semanticRead || name === 'select_page') && busy())
            throw new McpError('busy', 'A user edit is in progress');
        if (isResourceRead(name, args)) return response({ ok: true, revision, ...readResourceOperation(name, args, editor.doc, editor.pageId, services) });
        if (name === 'page' && args.action === 'list') return response({ ok: true, revision, pages: editor.doc.pages.map(id => ({ id, name: editor.doc.pagesById[id].name, guides: editor.doc.pagesById[id].guides ?? [] })), pageId: editor.pageId });
        if (name === 'clipboard' && ['copy', 'copy_properties'].includes(args.action)) {
            const snapshot = editor.doc;
            const resolved = { ...args, ids: args.ids.map((id: string) => resolve(agent, id)) };
            const payload = await portableClipboard(clipboardPayload(resolved, editor), services.resolveImageSource, { signal, maxBytes: 16 * 1024 * 1024 });
            checkPage();
            if (editor.doc !== snapshot) throw new McpError('stale_revision', 'Canvas changed while copying; retry against the current revision');
            state(agent).clipboard = structuredClone(payload);
            return response({ ok: true, revision, payload });
        }
        if (name === 'view') {
            const resolved = { ...args, ...(args.ids ? { ids: args.ids.map((id: string) => resolve(agent, id)) } : {}) };
            const result = applyView(resolved, editor); view.render(); await settled(signal);
            return response({ ok: true, revision, ...result, selection: result.selection.map((id: string) => alias(agent, id)) });
        }
        if (name === 'export_selection') {
            const exported = await readExport(agent, args, signal, checkPage, 4 * 1024 * 1024);
            const text = ['json', 'html', 'svg'].includes(args.format);
            let data: string;
            if (text) data = new TextDecoder().decode(exported.bytes);
            else { let binary = ''; for (let offset = 0; offset < exported.bytes.length; offset += 8192) binary += String.fromCharCode(...exported.bytes.subarray(offset, offset + 8192)); data = btoa(binary); }
            return response({ ok: true, revision, format: args.format, mimeType: exported.mime, encoding: text ? 'utf8' : 'base64', data });
        }
        if (name === 'select_page') {
            if (!editor.doc.pages.includes(args.id))
                throw new McpError('not_found', 'Page was not found');
            editor.setPage(args.id);
            await settled(signal);
            return context(agent);
        }
        if (name === 'undo') {
            const last = latest ?? editor.lastOperation;
            if (!options.undo && last?.label !== `agent:${agent}` && last?.author !== agent)
                throw new McpError('nothing_to_undo', 'The latest edit does not belong to this agent');
            check(signal);
            const ok = options.undo ? await waiting(options.undo(agent, signal, requestId), signal) : editor.undoStep();
            if (!ok)
                throw new McpError('nothing_to_undo', 'There is no eligible agent edit');
            redoOwner = agent; redoRevision = revision;
            latest = { id: uid(), label: 'Undo' };
            await settled(signal);
            return response({ ok: true, revision });
        }
        if (name === 'redo') {
            if (!options.redo && (redoOwner !== agent || redoRevision !== revision)) throw new McpError('nothing_to_redo', 'There is no eligible agent redo');
            const ok = options.redo ? await waiting(options.redo(agent, signal, requestId), signal) : editor.redoStep();
            if (!ok) throw new McpError('nothing_to_redo', 'There is no eligible agent redo');
            redoOwner = null; await settled(signal); return response({ ok: true, revision });
        }
        if (name === 'image') {
            if (args.revision !== revision)
                throw new McpError('stale_revision', 'Document changed; read the context before editing the image');
            if (!services.images)
                throw new McpError('failed', 'Image editing service is unavailable');
            const id = resolve(agent, args.id), operation = { id: uid(), label: `agent:${agent}`, author: agent };
            await waiting(args.action === 'remove_background' ? services.images.removeBackground(id, operation, signal) : services.images.restore(id, operation), signal);
            check(signal);
            await settled(signal);
            options.onHighlight?.(agent, [id]);
            return response({ ok: true, revision, id: alias(agent, id), rawId: id, diagnostics: diagnostics([id]), warnings: [] });
        }
        if (name === 'outline') {
            if (args.revision !== revision)
                throw new McpError('stale_revision', 'Document changed; read the context before converting');
            if (!services.commands)
                throw new McpError('failed', 'Outline command service is unavailable');
            const ids = args.ids.map((id: string) => resolve(agent, id));
            if (new Set(ids).size !== ids.length)
                throw new McpError('bad_args', 'Outline layers must be unique');
            if (ids.some((id: string) => !isEditable(editor.page, id) || (args.kind === 'text' ? editor.page.objects[id].type !== 'text' : !['path', 'boolean', 'rect', 'ellipse'].includes(editor.page.objects[id].type))))
                throw new McpError('invalid', 'Choose editable layers matching the outline kind');
            const result: unknown = await waiting(services.commands.run(args.kind === 'stroke' ? 'path.outline-stroke' : 'text.outline', { ids, author: agent, operationId: uid(), signal }), signal);
            check(signal);
            if (!Array.isArray(result) || !result.length || result.some(id => typeof id !== 'string'))
                throw new McpError('invalid', 'Outline command returned no created layer IDs');
            const createdIds: string[] = [...result];
            await settled(signal);
            const created = createdIds.filter(id => editor.page.objects[id]);
            options.onHighlight?.(agent, created);
            return response({ ok: true, revision, ids: created.map(id => alias(agent, id)), rawIds: created, diagnostics: diagnostics(created), warnings: [] });
        }
        if (writes.has(name)) {
            if (name === 'clipboard' && args.action === 'cut') {
                const sourceDocument = editor.doc;
                const resolved = { ...args, ids: args.ids.map((id: string) => resolve(agent, id)) };
                const preparedClipboardPayload = await portableClipboard(clipboardPayload(resolved, editor), services.resolveImageSource, { signal, maxBytes: 16 * 1024 * 1024 });
                checkPage();
                if (editor.doc !== sourceDocument) throw new McpError('stale_revision', 'Canvas changed while copying; no layers were cut');
                args = { ...args, preparedClipboardPayload };
            }
            if (name === 'clipboard' && ['paste', 'paste_properties'].includes(args.action) && !args.payload) args = { ...args, payload: state(agent).clipboard };
            const prepared = await waiting(prepareResourceOperation(name, args, editor.doc, editor.pageId, services, signal), signal);
            args = prepared.args;
            try {
            checkPage(); if (!semanticRead && busy()) throw new McpError('busy', 'A user edit started while preparing assets');
            if (name === 'batch' && args.ops.some((op: Data) => op.tool === 'document_assets' && op.args.action === 'add')) throw new McpError('bad_args', 'Asset uploads require standalone preparation; add first, then batch place operations');
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
            checkPage();
            if (!semanticRead && busy())
                throw new McpError('busy', 'A user edit started while fonts were loading');
            for (const op of name === 'batch' ? args.ops : [{ tool: name, args }]) if (op.tool === 'edit_text' && op.args.revision !== undefined && op.args.revision !== revision) throw new McpError('stale_revision', 'Document changed; read the text/context again before editing');
            if (name === 'edit_path' || name === 'boolean') {
                if (args.revision !== revision)
                    throw new McpError('stale_revision', 'Document changed; read the path/context again before editing');
            }
            if (name === 'boolean') {
                const ids = args.ids.map((id: string) => resolve(agent, id));
                if (topLevelIds(editor.page, ids).length !== ids.length || ids.some((id: string) => !isEditable(editor.page, id) || descendants(editor.page, id, true).some(s => !['rect', 'ellipse', 'path', 'boolean', 'group'].includes(s.type))))
                    throw new McpError('invalid', 'Choose distinct editable vector operands without ancestor/descendant overlap');
                const combine = services.combinePaths ?? services.boolean;
                if (!combine)
                    throw new McpError('failed', 'Vector operation service is unavailable');
                const snapshot = editor.doc, pageId = editor.pageId;
                const prepared = await waiting(combine(ids.map((id: string) => structuredClone(editor.page.objects[id])), args.operation, { objects: editor.page.objects }), signal);
                checkPage();
                if (editor.doc !== snapshot || editor.pageId !== pageId || args.revision !== revision)
                    throw new McpError('stale_revision', 'Document changed while computing paths');
                if (busy())
                    throw new McpError('busy', 'A user edit started while computing paths');
                args = { ...args, prepared };
            }
            const s = state(agent), saved = { aliases: new Map(s.aliases), reverse: new Map(s.reverse), counter: s.counter, clipboard: s.clipboard ? structuredClone(s.clipboard) : undefined }, affected = new Set<string>(), warnings: string[] = [];
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
            return response({ ok: true, ...result, ...name === 'page' ? { context: context(agent).structuredContent } : {}, revision, diagnostics: measured, warnings: [...new Set(warnings)] });
            } finally { prepared.release?.(); }
        }
        const page = editor.page;
        if (name === 'get_path') {
            await settled(signal);
            const id = resolve(agent, args.id), stored = editor.page.objects[id];
            const shape = stored.type === 'boolean' && view.projectedShape ? view.projectedShape(id) : stored;
            if (!shape || !['path', 'boolean'].includes(shape.type) || !Array.isArray(shape.content))
                throw new McpError('invalid', 'Layer has no native path geometry');
            if (shape.content.length > 10000)
                throw new McpError('invalid', 'Path exceeds the 10000 segment inspection limit');
            return response({ ok: true, revision, id: alias(agent, id), rawId: id, coordinateSpace: 'world', fillRule: shape.fillRule ?? 'nonzero', editable: stored.type === 'path' && isEditable(editor.page, id), segments: shape.content.map((segment: Data, index: number) => ({ ...segment, index })) });
        }
        if (name === 'get_context')
            return context(agent);
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
            const id = resolve(agent, args.id), snapshot = editor.doc, sourcePage = editor.pageId;
            let html: string;
            try {
                const portable = await portableDocument(selectionDocument(editor, [id]), services.resolveImageSource, { signal, maxBytes: 200000 });
                check(signal);
                if (editor.doc !== snapshot || editor.pageId !== sourcePage) throw new McpError('stale_revision', 'Canvas changed during export; read context before retrying');
                html = exportHtml(portable, sourcePage, [id], { view, limit: 200000, alias: id => alias(agent, id) });
            }
            catch (e) {
                if (e instanceof McpError) throw e;
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
            const shot = await waiting(view.screenshot(id, { mode: args.mode ?? 'slice', slice: args.slice ?? 0, ...args.id ? {} : { scope: 'page' as const } }), signal);
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
        requestId?: string;
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
        const requestId = context.requestId, admittedPage = { id: editor.pageId, generation: pageGeneration };
        const work = queue.then(() => execute(agent, name, args, signal, requestId, admittedPage));
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
    const api = { exportData(agent: string, args: Data, context: { signal?: AbortSignal } = {}) {
            const captured = { pageId: editor.pageId, generation: pageGeneration }, controller = new AbortController();
            const signal = context.signal ? AbortSignal.any([controller.signal, context.signal]) : controller.signal;
            const timer = setTimeout(() => controller.abort(new McpError('timeout', 'Export timed out')), 60000);
            const checkScope = () => { check(signal); if (disposed || editor.pageId !== captured.pageId || pageGeneration !== captured.generation) throw new McpError('page_changed', 'Selected page changed during export'); };
            const work = queue.then(() => { checkScope(); return readExport(agent, structuredClone(args), signal, checkScope, 100 * 1024 * 1024, true); });
            queue = work.then(() => {}, () => {});
            return waiting(work, signal).finally(() => clearTimeout(timer));
        }, resolveIds(agent: string, ids: string[]) { return ids.map(id => resolve(agent, id)); }, tools: () => EDITOR_TOOLS.map(t => structuredClone(t)), handleToolCall, endSession(agent?: string) {
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
