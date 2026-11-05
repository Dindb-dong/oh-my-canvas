/** Independently authored command registry. No inherited editor implementation is used. */
import type { EditorStore, Commands, Data, Page, Shape, CanvasDocument, Tool, Point } from '../contracts';
import { createShape, createPage, addPage, deletePage, duplicatePage, clone, newId, ROOT_ID, descendants, ancestors, topLevelIds, insertShape, removeShapes, reparentShapes, cloneShapes, moveTree, resizeTree, refreshFrames, isEditable, remapReferences } from '../document';
import { bounds, unionBounds, shapeBounds, rectOf, center, moveShape, resizeShape, updateGeometry, rotationMatrix, zoomAt, fitViewport, polygonPoints, identity, pathBounds, setShapeOrientation } from '../geometry';
import { insertPathNode, deletePathNodes, movePathNodes, setPathHandle, closePath, convertPathNode, joinPathEnds, regeneratePrimitive } from './path';
export * from './path';
export function groupShapes(page: Page, ids: string[], type = 'group', props: Data = {}): Shape {
    const top = topLevelIds(page, ids);
    if (!top.length)
        throw new Error('Select layers to group');
    const parents = top.map(id => page.objects[id].parentId), parentId = parents.every(id => id === parents[0]) ? parents[0] : ROOT_ID, parent = page.objects[parentId], index = Math.min(...top.map(id => parent.childIds!.indexOf(id)).filter(i => i >= 0)), box = unionBounds(top.map(id => shapeBounds(page.objects[id]))), group = createShape(type, { ...box, ...props, childIds: [] });
    insertShape(page, group, parentId, Number.isFinite(index) ? index : undefined);
    reparentShapes(page, top, group.id);
    return group;
}
export function ungroupShapes(page: Page, ids: string[]): string[] {
    const result: string[] = [];
    for (const id of topLevelIds(page, ids)) {
        const group = page.objects[id];
        if (!group.childIds)
            continue;
        const children = [...group.childIds], parent = page.objects[group.parentId], index = parent.childIds!.indexOf(id);
        reparentShapes(page, children, group.parentId, index);
        removeShapes(page, [id]);
        result.push(...children);
    }
    return result;
}
export function rotateShapes(page: Page, ids: string[], angle: number, origin?: Point): void {
    const top = topLevelIds(page, ids), pivot = origin ?? center(unionBounds(top.map(id => shapeBounds(page.objects[id])))), r = angle * Math.PI / 180, c = Math.cos(r), s = Math.sin(r);
    for (const id of top)
        for (const shape of descendants(page, id, true)) {
            const p = center(shape), dx = p.x - pivot.x, dy = p.y - pivot.y;
            moveShape(shape, pivot.x + dx * c - dy * s - p.x, pivot.y + dx * s + dy * c - p.y);
            setShapeOrientation(shape, (shape.rotation + angle) % 360);
        }
}
export function flipShapes(page: Page, ids: string[], axis: 'horizontal' | 'vertical'): void {
    const top = topLevelIds(page, ids), box = unionBounds(top.map(id => shapeBounds(page.objects[id]))), pivot = center(box);
    for (const id of top)
        for (const shape of descendants(page, id, true)) {
            const c = center(shape);
            moveShape(shape, axis === 'horizontal' ? 2 * (pivot.x - c.x) : 0, axis === 'vertical' ? 2 * (pivot.y - c.y) : 0);
            setShapeOrientation(shape, -shape.rotation, axis === 'horizontal' ? !shape.flipX : !!shape.flipX, axis === 'vertical' ? !shape.flipY : !!shape.flipY);
        }
}
export function alignShapes(page: Page, ids: string[], alignment: string): void {
    const roots = topLevelIds(page, ids), shapes = roots.map(id => page.objects[id]);
    if (!shapes.length)
        return;
    let box = unionBounds(shapes.map(shapeBounds));
    if (shapes.length === 1) {
        const parent = page.objects[shapes[0].parentId];
        if (parent.id !== ROOT_ID)
            box = shapeBounds(parent);
    }
    for (const shape of shapes) {
        const b = shapeBounds(shape), dx = alignment === 'left' ? box.x - b.x : alignment === 'right' ? box.x + box.width - b.x - b.width : alignment === 'h-center' ? box.x + box.width / 2 - b.x - b.width / 2 : 0, dy = alignment === 'top' ? box.y - b.y : alignment === 'bottom' ? box.y + box.height - b.y - b.height : alignment === 'v-center' ? box.y + box.height / 2 - b.y - b.height / 2 : 0;
        moveTree(page, shape.id, dx, dy);
    }
}
export function distributeShapes(page: Page, ids: string[], axis: 'h' | 'v', gap?: number): void {
    const horizontal = axis === 'h', position = horizontal ? 'x' : 'y', size = horizontal ? 'width' : 'height', shapes = topLevelIds(page, ids).map(id => page.objects[id]).sort((a, b) => a[position] - b[position]);
    if (shapes.length < 2)
        return;
    const box = unionBounds(shapes.map(shapeBounds)), space = gap ?? (box[size] - shapes.reduce((sum, s) => sum + shapeBounds(s)[size], 0)) / (shapes.length - 1);
    let cursor = shapeBounds(shapes[0])[position];
    for (const shape of shapes) {
        const b = shapeBounds(shape), delta = cursor - b[position];
        moveTree(page, shape.id, horizontal ? delta : 0, horizontal ? 0 : delta);
        cursor += b[size] + space;
    }
}
export function orderShapes(page: Page, ids: string[], mode: string): void {
    const selected = new Set(topLevelIds(page, ids)), parents = new Set([...selected].map(id => page.objects[id].parentId));
    for (const parentId of parents) {
        const parent = page.objects[parentId], list = parent.childIds!, chosen = list.filter(id => selected.has(id));
        if (mode === 'front')
            parent.childIds = [...list.filter(id => !selected.has(id)), ...chosen];
        else if (mode === 'back')
            parent.childIds = [...chosen, ...list.filter(id => !selected.has(id))];
        else if (mode === 'forward') {
            for (let i = list.length - 2; i >= 0; i--)
                if (selected.has(list[i]) && !selected.has(list[i + 1]))
                    [list[i], list[i + 1]] = [list[i + 1], list[i]];
        }
        else
            for (let i = 1; i < list.length; i++)
                if (selected.has(list[i]) && !selected.has(list[i - 1]))
                    [list[i], list[i - 1]] = [list[i - 1], list[i]];
    }
}
const PROPERTY_KEYS = ['fills', 'strokes', 'strokeWidth', 'strokeAlignment', 'strokeCap', 'strokeJoin', 'strokeDashArray', 'strokeSides', 'opacity', 'blendMode', 'effects', 'shadows', 'blur', 'backgroundBlur', 'radii', 'radius', 'radiusTopLeft', 'radiusTopRight', 'radiusBottomLeft', 'radiusBottomRight', 'cornerSmoothing', 'smoothing', 'textStyleId', 'fillStyleId', 'strokeStyleId', 'effectStyleId', 'textBackground'];
export function createCommands(editor: EditorStore, services: Data = {}): Commands {
    const registry = new Map<string, Data>();
    let clipboard: any = null, properties: Data | null = null, pasteCount = 0;
    const ids = (args: Data = {}) => (args.ids ?? (args.id ? [args.id] : editor.selection)) as string[];
    const editable = (args: Data = {}) => topLevelIds(editor.page, ids(args)).filter(id => isEditable(editor.page, id));
    const selected = (args: Data = {}) => ids(args).map(id => editor.page.objects[id]).filter(Boolean);
    // Layer toggles may clear their own flag, but cannot bypass an ancestor's protection.
    const toggleTargets = (args: Data, field: 'locked' | 'hidden') => selected(args).filter(shape =>
        shape.id !== ROOT_ID && !ancestors(editor.page, shape.id).some(parent => parent.locked || parent.hidden)
        && (field === 'locked' || !shape.locked));
    function editableTarget(page: Page, args: Data): Shape | undefined {
        const id = args.id ?? ids(args)[0];
        return isEditable(page, id) ? page.objects[id] : undefined;
    }
    function editPath(id: string, label: string, action: (shape: Shape, args: Data) => any) {
        edit(id, label, (page, args) => {
            const shape = editableTarget(page, args);
            if (shape)
                action(shape, args);
        });
    }
    function register(id: string, label: string, run: (args: Data) => any, enabled: () => boolean = () => true) {
        registry.set(id, { id, label, run, enabled });
    }
    function edit(id: string, label: string, action: (page: Page, args: Data, doc: CanvasDocument) => any, enabled: () => boolean = () => editable().length > 0) {
        register(id, label, args => {
            let selection: string[] | undefined;
            editor.transact({ id: args.operationId ?? newId('op'), label, author: args.author, group: args.group }, doc => {
                const result = action(doc.pagesById[editor.pageId], args, doc);
                if (Array.isArray(result))
                    selection = result;
            });
            if (selection)
                editor.setSelection(selection);
            return true;
        }, enabled);
    }
    const available = () => !editor.undo.blocked;
    register('edit.undo', 'Undo', () => editor.activeSession && editor.undoSession ? editor.undoSession() : editor.undoStep(), () => !editor.undo.blocked || !!editor.activeSession);
    register('edit.redo', 'Redo', () => editor.activeSession && editor.redoSession ? editor.redoSession() : editor.redoStep(), () => !editor.undo.blocked || !!editor.activeSession);
    for (const tool of ['move', 'frame', 'rect', 'ellipse', 'polygon', 'star', 'line', 'arrow', 'pencil', 'pen', 'text'] as Tool[])
        register(`tool.${tool}`, `Use ${tool}`, () => {
            editor.setTool(tool);
            return true;
        });
    edit('edit.delete', 'Delete', (page, args) => {
        removeShapes(page, editable(args));
        return [];
    });
    edit('edit.duplicate', 'Duplicate', (page, args, doc) => editable(args).map(id => {
        const instance = services.duplicateComponentMain?.(doc, page, id, { dx: args.dx ?? 10, dy: args.dy ?? 10 });
        return instance?.id ?? cloneShapes(page, [id], { dx: args.dx ?? 10, dy: args.dy ?? 10 })[0].id;
    }));
    edit('layer.rename', 'Rename', (page, args) => {
        const shape = editableTarget(page, args);
        if (!shape)
            return;
        shape.name = String(args.name ?? args.value ?? shape.name ?? 'Layer');
    });
    for (const [command, field] of [['lock', 'locked'], ['hide', 'hidden']] as const)
        edit(`layer.${command}`, command === 'lock' ? 'Lock layer' : 'Hide layer', (page, args) => {
            for (const shape of toggleTargets(args, field).map(s => page.objects[s.id])) {
                if (ancestors(page, shape.id).some(parent => parent.locked || parent.hidden))
                    continue;
                shape[field] = args.value ?? !shape[field];
                if (field === 'hidden')
                    shape.visible = !shape.hidden;
            }
        }, () => toggleTargets({}, field).length > 0);
    edit('struct.group', 'Group', (page, args) => [groupShapes(page, editable(args)).id]);
    edit('struct.frame', 'Frame selection', (page, args) => [groupShapes(page, editable(args), 'frame', { clipContent: args.clipContent ?? false, fills: args.fills ?? [] }).id]);
    edit('struct.ungroup', 'Ungroup', (page, args) => ungroupShapes(page, editable(args)), () => selected().some(s => s.childIds));
    edit('struct.mask', 'Use mask', (page, args) => {
        const chosen = editable(args);
        if (chosen.length === 1 && page.objects[chosen[0]].maskId) {
            const group = page.objects[chosen[0]];
            if (page.objects[group.maskId])
                delete page.objects[group.maskId].isMask;
            delete group.maskId;
            delete group.isMaskGroup;
            delete group.maskType;
            return [group.id];
        }
        if (chosen.length < 2)
            throw new Error('Select a mask and content');
        const group = groupShapes(page, chosen, 'group', { isMaskGroup: true, maskType: args.mode ?? 'alpha', maskId: args.maskId ?? chosen[0] });
        page.objects[group.maskId].isMask = true;
        return [group.id];
    }, () => editable().length >= 2 || selected().some(s => s.maskId));
    for (const alignment of ['left', 'right', 'top', 'bottom', 'h-center', 'v-center'])
        edit(`align.${alignment}`, `Align ${alignment}`, (page, args) => alignShapes(page, editable(args), alignment));
    for (const axis of ['h', 'v'] as const)
        edit(`distribute.${axis}`, `Distribute ${axis}`, (page, args) => distributeShapes(page, editable(args), axis, args.gap), () => editable().length >= 3);
    edit('arrange.tidy-up', 'Tidy up', (page, args) => {
        const shapes = editable(args).map(id => page.objects[id]).sort((a, b) => a.y - b.y || a.x - b.x);
        if (!shapes.length)
            return;
        const start = unionBounds(shapes.map(shapeBounds)), columns = args.columns ?? Math.ceil(Math.sqrt(shapes.length)), gap = args.gap ?? 16, width = Math.max(...shapes.map(s => s.width)), height = Math.max(...shapes.map(s => s.height));
        shapes.forEach((s, i) => moveTree(page, s.id, start.x + (i % columns) * (width + gap) - s.x, start.y + Math.floor(i / columns) * (height + gap) - s.y));
    });
    for (const mode of ['forward', 'backward', 'front', 'back'])
        edit(`order.${mode}`, `Send ${mode}`, (page, args) => orderShapes(page, editable(args), mode));
    for (const axis of ['h', 'v'])
        edit(`transform.flip-${axis}`, `Flip ${axis}`, (page, args) => flipShapes(page, editable(args), axis === 'h' ? 'horizontal' : 'vertical'));
    for (const [direction, dx, dy] of [['left', -1, 0], ['right', 1, 0], ['up', 0, -1], ['down', 0, 1]] as const)
        for (const step of [1, 10])
            edit(`nudge.${direction}${step === 10 ? '-10' : ''}`, `Move ${direction}`, (page, args) => {
                for (const id of editable(args))
                    moveTree(page, id, dx * (args.step ?? step), dy * (args.step ?? step));
            });
    for (let digit = 0; digit <= 9; digit++)
        edit(`layer.opacity-${digit}`, `Opacity ${digit === 0 ? 100 : digit * 10}%`, (page, args) => {
            for (const id of editable(args))
                page.objects[id].opacity = digit === 0 ? 1 : digit / 10;
        });
    edit('layout.add', 'Add layout', (page, args) => {
        const chosen = editable(args);
        let container: Shape;
        if (chosen.length === 1 && page.objects[chosen[0]].type === 'frame')
            container = page.objects[chosen[0]];
        else
            container = groupShapes(page, chosen, 'frame', { fills: [] });
        const children = (container.childIds ?? []).map(id => page.objects[id]), spread = unionBounds(children.map(shapeBounds)), direction = args.direction ?? (spread.height > spread.width ? 'column' : 'row');
        container.layout = { type: args.type ?? 'flex', direction, gap: typeof args.gap === 'number' ? { row: args.gap, column: args.gap } : args.gap ?? { row: 16, column: 16 }, padding: typeof args.padding === 'number' ? { top: args.padding, right: args.padding, bottom: args.padding, left: args.padding } : args.padding ?? { top: 0, right: 0, bottom: 0, left: 0 }, ...args.layout };
        return [container.id];
    });
    edit('layout.remove', 'Remove layout', (page, args) => {
        for (const id of editable(args))
            delete page.objects[id].layout;
    });
    for (const type of ['frame', 'rect', 'ellipse', 'polygon', 'star', 'line', 'arrow', 'pencil', 'pen', 'text', 'image', 'svg'])
        edit(`shape.create-${type}`, `Create ${type}`, (page, args) => {
            const shape = createShape(type, args.shape ?? args);
            insertShape(page, shape, args.parentId ?? ROOT_ID, args.index);
            return [shape.id];
        }, () => true);
    register('edit.enter', 'Edit selected layer', () => {
        const s = selected()[0];
        if (!s)
            return false;
        if (s.type === 'text') {
            if (!services.edit)
                return false;
            services.edit(s.id);
            return true;
        }
        if (s.type === 'path') {
            if (!services.editPath)
                return false;
            services.editPath(s.id);
            return true;
        }
        if (s.childIds?.length) {
            editor.setSelection(s.childIds);
            return true;
        }
        return false;
    }, () => editor.selection.length === 1);
    register('select.all', 'Select all', () => {
        editor.setSelection(editor.page.objects.root.childIds!.filter(id => !editor.page.objects[id].hidden && !editor.page.objects[id].locked));
        return true;
    });
    register('select.none', 'Deselect', () => {
        editor.setSelection([]);
        return true;
    });
    register('select.inverse', 'Invert selection', () => {
        const set = new Set(editor.selection);
        editor.setSelection(Object.keys(editor.page.objects).filter(id => !set.has(id) && isEditable(editor.page, id)));
        return true;
    });
    register('select.children', 'Select children', args => {
        editor.setSelection(selected(args).flatMap(s => s.childIds ?? []));
        return true;
    }, () => selected().some(s => s.childIds?.length));
    register('select.parent', 'Select parent', () => {
        editor.setSelection(selected().map(s => s.parentId).filter(id => id !== ROOT_ID));
        return true;
    }, () => selected().some(s => s.parentId !== ROOT_ID));
    for (const direction of ['next', 'previous'])
        register(`select.${direction}`, `Select ${direction}`, () => {
            const s = selected().at(-1), siblings = editor.page.objects[s?.parentId ?? ROOT_ID].childIds ?? [], index = s ? siblings.indexOf(s.id) : direction === 'next' ? -1 : 0;
            for (let n = 1; n <= siblings.length; n++) {
                const id = siblings[(index + (direction === 'next' ? n : -n) + siblings.length) % siblings.length], shape = editor.page.objects[id];
                if (!shape.hidden && !shape.locked) {
                    editor.setSelection([id]);
                    return true;
                }
            }
            return false;
        });
    register('select.matching', 'Select matching layers', args => {
        const shape = selected(args)[0];
        if (!shape)
            return false;
        const keys = args.keys ?? [args.property ?? 'type'];
        editor.setSelection(Object.values(editor.page.objects).filter(s => s.id !== ROOT_ID && keys.every((key: string) => JSON.stringify(s[key]) === JSON.stringify(shape[key]))).map(s => s.id));
        return true;
    }, () => editor.selection.length > 0);
    function flag(command: string, field: string, label: string) {
        register(command, label, args => {
            editor[field] = args.value ?? !editor[field];
            services.view?.render?.();
            editor.setViewport(editor.viewport);
            return true;
        });
    }
    for (const [command, field] of [['outlines', 'showOutlines'], ['toggle-ui', 'uiHidden'], ['pixel-grid', 'pixelSnap'], ['rulers', 'showRulers'], ['layout-grids', 'showGrids']])
        flag(`view.${command}`, field, command);
    register('view.quick-actions', 'Quick actions', () => {
        const open = services.openQuickActions ?? services.quickActions;
        if (!open)
            return false;
        open();
        return true;
    });
    register('view.zoom-in', 'Zoom in', () => {
        editor.setViewport(zoomAt(editor.viewport, editor.viewport.zoom * 1.2));
        return true;
    });
    register('view.zoom-out', 'Zoom out', () => {
        editor.setViewport(zoomAt(editor.viewport, editor.viewport.zoom / 1.2));
        return true;
    });
    register('view.zoom-100', 'Actual size', () => {
        editor.setViewport(zoomAt(editor.viewport, 1));
        return true;
    });
    register('view.zoom-selection', 'Zoom to selection', () => {
        if (!selected().length)
            return false;
        editor.setViewport(fitViewport(editor.viewport, unionBounds(selected().map(shapeBounds))));
        return true;
    }, () => editor.selection.length > 0);
    register('view.zoom-fit', 'Fit document', () => {
        editor.setViewport(fitViewport(editor.viewport, unionBounds(Object.values(editor.page.objects).filter(s => s.id !== ROOT_ID && !s.hidden).map(shapeBounds))));
        return true;
    });
    register('view.zoom', 'Zoom', args => {
        editor.setViewport(zoomAt(editor.viewport, args.zoom ?? 1, args.anchor));
        return true;
    });
    for (const direction of ['next', 'previous']) {
        register(`view.${direction}-page`, `${direction} page`, () => {
            const pages = editor.doc.pages, index = pages.indexOf(editor.pageId), next = (index + (direction === 'next' ? 1 : -1) + pages.length) % pages.length;
            editor.setPage(pages[next]);
            return true;
        });
        register(`view.${direction}-frame`, `${direction} frame`, () => {
            const frames = Object.values(editor.page.objects).filter(s => s.type === 'frame' && s.id !== ROOT_ID);
            if (!frames.length)
                return false;
            const selectedIndex = frames.findIndex(s => editor.selection.includes(s.id)), i = selectedIndex < 0 && direction === 'previous' ? 0 : selectedIndex, frame = frames[(i + (direction === 'next' ? 1 : -1) + frames.length) % frames.length];
            editor.setSelection([frame.id]);
            editor.setViewport(fitViewport(editor.viewport, shapeBounds(frame)));
            return true;
        });
    }
    edit('page.add', 'Add page', (_page, args, doc) => {
        const page = addPage(doc, args.name);
        editor.setPage(page.id);
    }, () => true);
    edit('page.rename', 'Rename page', (page, args) => {
        page.name = String(args.name ?? args.value ?? 'Page');
    }, () => true);
    edit('page.duplicate', 'Duplicate page', (_page, args, doc) => {
        const page = duplicatePage(doc, args.id ?? editor.pageId);
        editor.setPage(page.id);
    }, () => true);
    edit('page.delete', 'Delete page', (_page, args, doc) => deletePage(doc, args.id ?? editor.pageId), () => editor.doc.pages.length > 1);
    async function writeClipboard(value: any): Promise<void> {
        clipboard = clone(value);
        pasteCount = 0;
        const text = JSON.stringify(value);
        if (services.clipboard?.writeText)
            await services.clipboard.writeText(text);
        else if (typeof navigator !== 'undefined' && navigator.clipboard)
            await navigator.clipboard.writeText(text);
    }
    async function readClipboard(): Promise<any> {
        let text: string | undefined;
        if (services.clipboard?.readText)
            text = await services.clipboard.readText();
        else if (typeof navigator !== 'undefined' && navigator.clipboard) {
            try {
                text = await navigator.clipboard.readText();
            }
            catch {
            }
        }
        if (text) {
            try {
                return JSON.parse(text);
            }
            catch {
                return { kind: 'text', text };
            }
        }
        return clipboard;
    }
    async function copy(args: Data): Promise<boolean> {
        const chosen = topLevelIds(editor.page, ids(args));
        if (!chosen.length)
            return false;
        await writeClipboard({ kind: 'oh-my-canvas/shapes', version: 1, roots: chosen, shapes: chosen.flatMap(id => descendants(editor.page, id, true)).map(clone), pageId: editor.pageId, origin: unionBounds(chosen.map(id => shapeBounds(editor.page.objects[id]))) });
        return true;
    }
    register('edit.copy', 'Copy', copy, () => editor.selection.length > 0);
    register('edit.cut', 'Cut', async (args) => {
        const sourceIds = [...ids(args)];
        if (!await copy({ ...args, ids: sourceIds }))
            return false;
        return await commands.run('edit.delete', { ...args, ids: sourceIds });
    }, () => editable().length > 0);
    register('edit.copy-properties', 'Copy properties', async (args) => {
        const s = selected(args)[0];
        if (!s)
            return false;
        properties = Object.fromEntries(PROPERTY_KEYS.filter(k => k in s).map(k => [k, clone(s[k])]));
        if (s.type === 'text' && s.content?.children)
            properties.textFormatting = clone(s.content.children).map((p: Data) => ({ ...p, children: p.children.map(({ text, ...format }: Data) => format) }));
        await writeClipboard({ kind: 'oh-my-canvas/properties', version: 1, properties });
        return true;
    }, () => editor.selection.length > 0);
    register('edit.paste-properties', 'Paste properties', async (args) => {
        const payload = await readClipboard(), value = payload?.properties ?? properties;
        if (!value)
            return false;
        editor.transact('Paste properties', doc => {
            for (const id of editable(args)) {
                const shape = doc.pagesById[editor.pageId].objects[id];
                for (const key of PROPERTY_KEYS)
                    if (key in value)
                        shape[key] = clone(value[key]);
                if (shape.type === 'text' && value.textFormatting && shape.content?.children) {
                    shape.content.children = shape.content.children.map((paragraph: Data, i: number) => {
                        const source = value.textFormatting[Math.min(i, value.textFormatting.length - 1)];
                        if (!source)
                            return paragraph;
                        return { ...paragraph, ...clone(source), children: paragraph.children.map((run: Data, j: number) => ({ ...run, ...clone(source.children[Math.min(j, source.children.length - 1)] ?? {}), text: run.text })) };
                    });
                }
            }
        });
        return true;
    }, () => editable().length > 0);
    /** Prepared records are synchronous so a failed nested import aborts its entire outer candidate. */
    function pastePrepared(payload: Data, args: Data = {}, mode: 'paste' | 'paste-in-place' | 'paste-replace' = 'paste'): string[] {
        if (!payload || typeof payload !== 'object')
            throw new Error('A prepared clipboard payload is required');
        if (payload.kind === 'text') {
            let id = '';
            editor.transact('Paste text', doc => {
                const shape = createShape('text', { text: String(payload.text ?? ''), x: args.x ?? editor.viewport.vbox.x + 20, y: args.y ?? editor.viewport.vbox.y + 20 });
                id = shape.id;
                insertShape(doc.pagesById[editor.pageId], shape, args.parentId ?? ROOT_ID);
            });
            editor.setSelection([id]);
            return [id];
        }
        if (payload.kind && !['oh-my-canvas/shapes', 'leviosa-editor/shapes@1'].includes(payload.kind))
            throw new Error('Prepare imported content as shape records before inserting it');
        const source = payload.shapes ?? payload.objects;
        if (!source || typeof source !== 'object')
            throw new Error('Prepared clipboard payload has no shapes');
        const shapes: Shape[] = clone(Array.isArray(source) ? source : Object.values(source)), roots: string[] = payload.roots ?? shapes.filter(s => !shapes.some(p => p.id === s.parentId)).map(s => s.id), mapping = new Map(shapes.map(s => [s.id, newId()])), selection: string[] = [];
        if (!shapes.length || !Array.isArray(roots) || !roots.length)
            throw new Error('Prepared clipboard payload has no root layers');
        editor.transact('Paste layers', doc => {
            const page = doc.pagesById[editor.pageId], replaced = mode === 'paste-replace' ? editable(args) : [], parentId = args.parentId ?? (replaced.length ? page.objects[replaced[0]].parentId : ROOT_ID), original = payload.origin ?? unionBounds(shapes.filter(s => roots.includes(s.id)).map(shapeBounds)), targetIds = mode === 'paste-in-place' ? editable(args) : replaced, target = targetIds.length ? unionBounds(targetIds.map(id => shapeBounds(page.objects[id]))) : null, offset = mode === 'paste-in-place' ? 0 : 10 * (++pasteCount), dx = target ? target.x + (mode === 'paste-in-place' ? (target.width - original.width) / 2 : 0) - original.x : args.x !== undefined ? args.x - original.x : offset, dy = target ? target.y + (mode === 'paste-in-place' ? (target.height - original.height) / 2 : 0) - original.y : args.y !== undefined ? args.y - original.y : offset;
            for (const s of shapes) {
                const oldId = s.id;
                s.id = mapping.get(oldId)!;
                Object.assign(s, remapReferences(s, mapping));
                s.parentId = roots.includes(oldId) ? parentId : s.parentId;
                s.enclosingFrameId = mapping.get(s.enclosingFrameId) ?? s.enclosingFrameId ?? ROOT_ID;
                if (s.componentId && !doc.components?.[s.componentId])
                    for (const key of ['componentId', 'sourceId', 'isMain', 'isInstanceRoot', 'overrides', 'componentPropertyRefs', 'componentProperties', 'componentSourceIds', 'componentOuterSourceId'])
                        delete s[key];
                moveShape(s, dx, dy);
                page.objects[s.id] = s;
                if (roots.includes(oldId))
                    selection.push(s.id);
            }
            page.objects[parentId].childIds!.push(...selection);
            refreshFrames(page);
            for (let i = 0; i < selection.length; i++) {
                const id = selection[i], s = page.objects[id];
                if (s.isMain && services.duplicateComponentMain) {
                    const instance = services.duplicateComponentMain(doc, page, id, { parentId: s.parentId, dx: s.x - (doc.pagesById[doc.components?.[s.componentId]?.mainPageId]?.objects[doc.components?.[s.componentId]?.mainId]?.x ?? s.x), dy: s.y - (doc.pagesById[doc.components?.[s.componentId]?.mainPageId]?.objects[doc.components?.[s.componentId]?.mainId]?.y ?? s.y) });
                    if (instance) {
                        removeShapes(page, [id]);
                        selection[i] = instance.id;
                    }
                }
            }
            if (replaced.length)
                removeShapes(page, replaced);
        });
        editor.setSelection(selection);
        return selection;
    }
    for (const mode of ['paste', 'paste-in-place', 'paste-replace'] as const) {
        register(`edit.${mode}`, mode, args => {
            if (args.payload) {
                pastePrepared(args.payload, args, mode);
                return true;
            }
            if (editor.inTransaction)
                throw new Error('Read and prepare clipboard content before starting a transaction');
            return (async () => {
                const payload = await readClipboard();
                if (!payload)
                    return false;
                if (payload.kind === 'text' && /^\s*<svg(?:\s|>)/i.test(payload.text ?? '') && services.importClipboard)
                    return !!await services.importClipboard(payload, { ...args, mode });
                if (payload.kind === 'text' && services.pasteText)
                    return !!await services.pasteText(payload.text, { ...args, mode });
                if ((payload.kind && !['oh-my-canvas/shapes', 'leviosa-editor/shapes@1', 'text'].includes(payload.kind)) || (!payload.shapes && !payload.objects && payload.kind !== 'text'))
                    return services.importClipboard ? !!await services.importClipboard(payload, { ...args, mode }) : false;
                pastePrepared(payload, args, mode);
                return true;
            })();
        });
    }
    for (const operation of ['union', 'subtract', 'intersect', 'exclude', 'flatten'])
        register(operation === 'flatten' ? 'path.flatten' : `bool.${operation}`, operation, async (args) => {
            const vector = (s: Shape): boolean => ['rect', 'ellipse', 'path', 'boolean', 'group'].includes(s.type);
            const selectedIds = editable(args).flatMap(id => operation === 'flatten' && editor.page.objects[id].type === 'group' ? descendants(editor.page, id).filter(s => ['rect', 'ellipse', 'path', 'boolean'].includes(s.type) && !ancestors(editor.page, s.id).slice(0, ancestors(editor.page, s.id).findIndex(parent => parent.id === id)).some(parent => parent.type === 'frame')).map(s => s.id) : [id]).filter(id => vector(editor.page.objects[id])), snapshot = editor.doc, shapes = topLevelIds(editor.page, selectedIds).map(id => clone(editor.page.objects[id]));
            selectedIds.splice(0, selectedIds.length, ...shapes.map(s => s.id));
            if (!shapes.length)
                return false;
            const combine = services.combinePaths ?? services.boolean;
            if (!combine)
                throw new Error('Vector operation service is unavailable');
            const operands = operation === 'flatten' ? selectedIds.flatMap(id => editor.page.objects[id].type === 'boolean' ? [editor.page.objects[id]] : descendants(editor.page, id, true).filter(s => !s.childIds?.length && vector(s))) : shapes;
            const result = await combine(operands, operation, { objects: editor.page.objects });
            if (editor.doc !== snapshot)
                throw new Error('Document changed while computing the path');
            let resultId = '';
            editor.transact(operation === 'flatten' ? 'Flatten paths' : `Boolean ${operation}`, doc => {
                const page = doc.pagesById[editor.pageId], box = result.bounds ?? pathBounds(result.segments), shape = createShape(operation === 'flatten' ? 'path' : 'boolean', { ...Object.fromEntries(PROPERTY_KEYS.filter(key => key in shapes[0]).map(key => [key, clone(shapes[0][key])])), name: operation === 'flatten' ? 'Flattened path' : `Boolean ${operation}`, ...box, rotation: 0, transform: identity(), inverseTransform: identity(), flipX: false, flipY: false, id: newId(), type: operation === 'flatten' ? 'path' : 'boolean', content: result.segments, fillRule: result.fillRule, booleanOperation: operation, childIds: operation === 'flatten' ? undefined : [], primitive: undefined });
                resultId = shape.id;
                const parentId = shapes.every(s => s.parentId === shapes[0].parentId) ? shapes[0].parentId : ROOT_ID, index = page.objects[parentId].childIds!.indexOf(shapes[0].id);
                insertShape(page, shape, parentId, index);
                if (operation === 'flatten')
                    removeShapes(page, selectedIds);
                else {
                    reparentShapes(page, selectedIds, shape.id);
                    shape.childIds = [...selectedIds];
                }
            });
            editor.setSelection([resultId]);
            return true;
        }, () => editable().some(id => ['rect', 'ellipse', 'path', 'boolean', 'group'].includes(editor.page.objects[id].type)));
    for (const [command, kind, label] of [['path.outline-stroke', 'stroke', 'Outline stroke'], ['text.outline', 'text', 'Outline text']])
        register(command, label, async args => {
            const chosen = topLevelIds(editor.page, ids(args));
            if (!chosen.length) throw new Error('Select layers to outline');
            if (chosen.some(id => !isEditable(editor.page, id))) throw new Error('Every source layer must be editable');
            if (editor.activeSession) throw new Error('Finish the active edit before outlining');
            const pageId = editor.pageId, snapshot = editor.doc, sources = chosen.map(id => clone(editor.page.objects[id]));
            if (!services.outline) throw new Error('Outline service is unavailable');
            const prepared: Data[][] = [];
            for (const source of sources) {
                args.signal?.throwIfAborted();
                prepared.push(await services.outline(source, kind, { signal: args.signal }));
            }
            args.signal?.throwIfAborted();
            if (editor.doc !== snapshot || editor.pageId !== pageId || editor.activeSession) throw new Error('Document changed while preparing outlines');
            const created: string[] = [];
            editor.transact({ id: args.operationId ?? newId('op'), label: args.author ? `agent:${args.author}` : label, author: args.author }, doc => {
                const page = doc.pagesById[pageId];
                for (let index = 0; index < sources.length; index++) {
                    const source = page.objects[sources[index].id], parts = prepared[index] as Data[];
                    if (!isEditable(page, source.id)) throw new Error('The source layer is no longer editable');
                    if (!parts.length || parts.some(part => !part.segments?.length)) throw new Error('The outline result is empty');
                    const box = unionBounds(parts.map(part => pathBounds(part.segments)));
                    // Retain the source layout/clip box; child paths already use world coordinates.
                    const container = source.type === 'text' || page.objects[source.parentId].layout ? 'frame' : 'group';
                    const layout = Object.fromEntries(['absolute', 'layoutPositioning', 'layoutChild', 'hSizing', 'vSizing', 'widthSizing', 'heightSizing', 'layoutSizing', 'alignSelf', 'gridCell', 'constraints', 'minWidth', 'maxWidth', 'minHeight', 'maxHeight', 'inlineStyles'].filter(key => source[key] !== undefined).map(key => [key, clone(source[key])]));
                    const group = createShape(container, { ...layout, ...(container === 'frame' ? { x: source.x, y: source.y, width: source.width, height: source.height, rotation: source.rotation, transform: clone(source.transform), inverseTransform: clone(source.inverseTransform) } : box), clip: !!source.clip, fills: [], strokes: [], name: `${source.name ?? source.type} outlines`, childIds: [], outlineSourceId: source.id, opacity: source.opacity, blendMode: source.blendMode, effects: clone(source.effects ?? []), shadows: clone(source.shadows ?? []), blur: source.blur, backgroundBlur: source.backgroundBlur });
                    insertShape(page, group, source.parentId, page.objects[source.parentId].childIds!.indexOf(source.id) + 1);
                    for (const part of parts) {
                        const path = createShape('path', { ...pathBounds(part.segments), name: kind === 'text' ? 'Glyph outlines' : 'Stroke outline', content: part.segments, fills: part.fills, fillRule: part.fillRule ?? 'nonzero', strokes: [], rotation: 0, transform: identity(), inverseTransform: identity() });
                        insertShape(page, path, group.id);
                    }
                    source.hidden = true;
                    created.push(group.id);
                }
            });
            editor.setSelection(created);
            return created;
        }, () => editable().some(id => kind === 'text' ? editor.page.objects[id].type === 'text' : ['path', 'boolean', 'rect', 'ellipse'].includes(editor.page.objects[id].type) && editor.page.objects[id].strokes?.some((stroke: Data) => !stroke.hidden && stroke.visible !== false)));
    for (const action of ['create', 'combine-variants', 'instance', 'add-variant', 'reset', 'detach'])
        register(`component.${action}`, `Component ${action}`, args => {
            if (!services.components?.run)
                throw new Error('Component service is unavailable');
            const result = services.components.run(({ 'combine-variants': 'combine', 'add-variant': 'add_variant' } as Record<string, string>)[action] ?? action, { ...args, ids: ids(args) });
            if (result.pageId && result.pageId !== editor.pageId)
                editor.setPage(result.pageId);
            if (result.selection)
                editor.setSelection(result.selection);
            else if (result.ids)
                editor.setSelection(result.ids);
            else if (result.id)
                editor.setSelection([result.id]);
            return true;
        }, () => action === 'instance' || editor.selection.length > 0);
    register('file.place-image', 'Place image', async (args) => {
        const chosen = args.images ?? args.image ?? (args.src ? args : await services.placeImage?.());
        if (!chosen)
            return false;
        const images = Array.isArray(chosen) ? chosen : [chosen], selection: string[] = [];
        let x = args.x ?? editor.viewport.vbox.x + 20, y = args.y ?? editor.viewport.vbox.y + 20;
        editor.transact('Place images', doc => {
            const page = doc.pagesById[editor.pageId];
            for (const image of images) {
                if (typeof (image.src ?? image.url) !== 'string')
                    throw new Error('Image source is required');
                const width = image.width ?? 100, height = image.height ?? 100;
                const shape = createShape('image', { ...args, x, y, width, height, image: { src: image.src ?? image.url, width, height, mimeType: image.mimeType } });
                insertShape(page, shape, args.parentId ?? ROOT_ID);
                selection.push(shape.id);
                x += width + 20;
            }
        });
        editor.setSelection(selection);
        return true;
    });
    for (const format of ['png', 'svg'])
        register(`export.copy-${format}`, `Copy ${format.toUpperCase()}`, async (args) => {
            const chosen = ids(args);
            if (!chosen.length)
                return false;
            if (format === 'svg') {
                const text = await services.export.svg(chosen);
                if (services.clipboard?.writeText)
                    await services.clipboard.writeText(text);
                else
                    await navigator.clipboard.writeText(text);
            }
            else {
                const bytes = await services.export.png(chosen[0], args.scale ?? 1);
                if (!bytes)
                    return false;
                const blob = new Blob([bytes], { type: 'image/png' });
                if (services.clipboard?.writeImage)
                    await services.clipboard.writeImage(blob);
                else
                    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
            }
            return true;
        }, () => editor.selection.length > 0);
    editPath('path.insert-node', 'Insert node', (shape, args) => insertPathNode(shape, args.index, args.t));
    editPath('path.delete-nodes', 'Delete nodes', (shape, args) => deletePathNodes(shape, args.indices ?? [args.index]));
    editPath('path.move-nodes', 'Move nodes', (shape, args) => movePathNodes(shape, args.indices ?? [args.index], args.dx ?? 0, args.dy ?? 0));
    editPath('path.handle', 'Move handle', (shape, args) => setPathHandle(shape, args.index, args.handle, args.point, args.mode));
    editPath('path.close', 'Close path', (shape, args) => closePath(shape, args.closed ?? true, args.index));
    edit('path.join', 'Join open endpoints', (page, args) => {
        const chosen = editable(args);
        if (!chosen.length)
            throw new Error('Select a path');
        const first = page.objects[chosen[0]], other = chosen.length > 1 ? page.objects[chosen[1]] : undefined;
        joinPathEnds(first, other, args);
        if (other)
            removeShapes(page, [other.id]);
        return [first.id];
    });
    edit('path.merge', 'Merge open endpoints', (page, args) => {
        const chosen = editable(args);
        if (!chosen.length)
            throw new Error('Select a path');
        const first = page.objects[chosen[0]], other = chosen.length > 1 ? page.objects[chosen[1]] : undefined;
        joinPathEnds(first, other, { ...args, merge: true });
        if (other)
            removeShapes(page, [other.id]);
        return [first.id];
    });
    edit('path.primitive', 'Edit polygon or star', (page, args) => {
        for (const id of editable(args))
            regeneratePrimitive(page.objects[id], args.primitive ?? args);
    });
    editPath('path.open', 'Open path', (shape, args) => closePath(shape, false, args.index));
    editPath('path.mirror', 'Set handle mirroring', (path, args) => {
        const indices = args.indices ?? [args.index];
        for (const index of indices) {
            const node = path.content?.[index];
            if (!node || node.command === 'close')
                throw new Error('Unknown path node');
            node.handleMode = args.mode ?? 'angleLength';
        }
    });
    edit('page.reorder', 'Reorder page', (_page, args, doc) => {
        const id = args.id ?? editor.pageId, index = doc.pages.indexOf(id);
        if (index < 0)
            throw new Error('Unknown page');
        doc.pages.splice(index, 1);
        doc.pages.splice(Math.max(0, Math.min(doc.pages.length, args.index ?? 0)), 0, id);
    }, () => true);
    editPath('path.convert-node', 'Convert node', (shape, args) => convertPathNode(shape, args.index, args.kind ?? 'corner'));
    const aliases: Record<string, string> = { 'view.zoom-to-fit': 'view.zoom-fit', 'view.zoom-to-selection': 'view.zoom-selection', 'view.zoom-reset': 'view.zoom-100', 'view.zoom-actual': 'view.zoom-100', 'edit.select-all': 'select.all', 'layer.group': 'struct.group', 'layer.ungroup': 'struct.ungroup', 'path.union': 'bool.union', 'path.subtract': 'bool.subtract', 'path.intersect': 'bool.intersect', 'path.exclude': 'bool.exclude' };
    const shortcuts: Record<string, string> = { 'edit.undo': 'Mod+Z', 'edit.redo': 'Mod+Shift+Z', 'edit.copy': 'Mod+C', 'edit.cut': 'Mod+X', 'edit.paste': 'Mod+V', 'edit.paste-in-place': 'Mod+Shift+V', 'edit.paste-replace': 'Mod+Shift+R', 'edit.copy-properties': 'Mod+Alt+C', 'edit.paste-properties': 'Mod+Alt+V', 'edit.delete': 'Delete', 'edit.duplicate': 'Mod+D', 'layer.rename': 'Mod+R', 'struct.group': 'Mod+G', 'struct.ungroup': 'Mod+Shift+G', 'struct.frame': 'Mod+Alt+G', 'struct.mask': 'Ctrl+Mod+M', 'path.flatten': 'Mod+E', 'path.join': 'J', 'path.merge': 'Mod+J', 'component.create': 'Mod+Alt+K', 'component.detach': 'Mod+Alt+B', 'layout.add': 'Shift+A', 'layout.remove': 'Alt+Shift+A', 'order.forward': 'Mod+]', 'order.backward': 'Mod+[', 'order.front': 'Mod+Alt+]', 'order.back': 'Mod+Alt+[', 'align.left': 'Alt+A', 'align.right': 'Alt+D', 'align.top': 'Alt+W', 'align.bottom': 'Alt+S', 'align.h-center': 'Alt+H', 'align.v-center': 'Alt+V', 'distribute.h': 'Ctrl+Alt+H', 'distribute.v': 'Ctrl+Alt+V', 'arrange.tidy-up': 'Ctrl+Alt+T', 'transform.flip-h': 'Shift+H', 'transform.flip-v': 'Shift+V', 'layer.lock': 'Mod+Shift+L', 'layer.hide': 'Mod+Shift+H', 'view.zoom-in': '=', 'view.zoom-out': '-', 'view.zoom-100': 'Shift+0', 'view.zoom-fit': 'Shift+1', 'view.zoom-selection': 'Shift+2', 'view.next-frame': 'N', 'view.previous-frame': 'Shift+N', 'view.next-page': 'PageDown', 'view.previous-page': 'PageUp', 'view.outlines': 'Mod+Y', 'view.toggle-ui': 'Mod+\\', 'view.pixel-grid': ',', 'view.rulers': 'Shift+R', 'view.layout-grids': 'Ctrl+G', 'select.all': 'Mod+A', 'select.inverse': 'Mod+Shift+A', 'select.children': 'Enter', 'select.parent': 'Shift+Enter', 'select.next': 'Tab', 'select.previous': 'Shift+Tab', 'select.matching': 'Mod+Alt+A', 'select.none': 'Escape', 'file.place-image': 'Mod+Shift+K', 'export.copy-png': 'Mod+Shift+C', 'view.quick-actions': 'Mod+/' };
    for (const [tool, key] of Object.entries({ move: 'V', frame: 'F', rect: 'R', ellipse: 'O', polygon: 'Shift+P', star: '', line: 'L', arrow: 'Shift+L', pencil: 'Shift+P', pen: 'P', text: 'T' }))
        shortcuts[`tool.${tool}`] = key;
    for (const direction of ['left', 'right', 'up', 'down']) {
        shortcuts[`nudge.${direction}`] = `Arrow${direction[0].toUpperCase() + direction.slice(1)}`;
        shortcuts[`nudge.${direction}-10`] = `Shift+${shortcuts[`nudge.${direction}`]}`;
    }
    for (let digit = 0; digit <= 9; digit++)
        shortcuts[`layer.opacity-${digit}`] = String(digit);
    for (const [id, key] of Object.entries(shortcuts)) {
        const entry = registry.get(id);
        if (entry)
            entry.shortcut = key;
    }
    const rename = registry.get('layer.rename')!;
    const renameRun = rename.run;
    rename.run = async (args: Data) => {
        if (args.name !== undefined || args.value !== undefined)
            return renameRun(args);
        const id = args.id ?? ids(args)[0];
        if (!isEditable(editor.page, id))
            return false;
        const name = await services.rename?.(id);
        if (name === undefined || name === null)
            return false;
        return renameRun({ ...args, name });
    };
    const commands: Commands = { get(id: string) {
            return registry.get(aliases[id] ?? id);
        }, enabled(id: string) {
            const entry = commands.get(id);
            if (!entry)
                return false;
            if (editor.undo.blocked && !id.startsWith('view.') && !id.startsWith('select.') && !['edit.undo', 'edit.redo', 'edit.copy', 'edit.copy-properties'].includes(id))
                return false;
            return !!entry.enabled();
        }, run(id: string, args: Data = {}) {
            const entry = commands.get(id);
            if (!entry)
                return false;
            if (!commands.enabled(id) && !args.ids && !args.id)
                return false;
            if (editor.undo.blocked && !id.startsWith('view.') && !id.startsWith('select.') && !['edit.undo', 'edit.redo', 'edit.copy', 'edit.copy-properties'].includes(id))
                return false;
            return entry.run(args);
        }, list() {
            return [...registry.values()].map(({ run, enabled, ...entry }) => ({ ...entry, enabled: commands.enabled(entry.id) }));
        }, register(id: string, entry: Data) {
            if (typeof entry.run !== 'function')
                throw new Error('A command needs an implementation');
            register(id, entry.label ?? id, entry.run, entry.enabled ?? (() => true));
        }, pastePrepared, importPrepared: pastePrepared, destroy() {
            registry.clear();
            clipboard = null;
            properties = null;
        } };
    return commands;
}
