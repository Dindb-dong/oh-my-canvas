import type { CanvasDocument, Data, EditorStore, Shape } from '../contracts';
import { copy, uid, locate } from '../components/model';
const refs: Record<string, string> = { paint: 'fillStyleId', fill: 'fillStyleId', stroke: 'strokeStyleId', text: 'textStyleId', effect: 'effectStyleId' };
const same = (a: any, b: any) => JSON.stringify(a) === JSON.stringify(b);
function runs(content: any, fn: (run: Data) => void) {
    if (!content || typeof content !== 'object')
        return;
    if (typeof content.text === 'string')
        fn(content);
    for (const child of content.children || [])
        runs(child, fn);
}
function styleValue(style: Data): any {
    return style.value ?? style.data ?? (style.type === 'effect' ? style.effects : style.type === 'text' ? style.text : style.paints) ?? {};
}
function fields(style: Data, kind: string): Data {
    const value = styleValue(style);
    if (kind === 'text')
        return Object.fromEntries(['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'letterSpacing', 'lineHeight', 'textDecoration', 'textDecorationStyle', 'textDecorationThickness', 'textTransform'].filter(key => value?.[key] !== undefined).map(key => [key, value[key]]));
    if (kind === 'effect')
        return Array.isArray(value) ? { shadows: value } : Object.fromEntries(['shadows', 'blur', 'blurHidden', 'backgroundBlur', 'backgroundBlurHidden'].filter(key => value?.[key] !== undefined).map(key => [key, value[key]]));
    return { [kind === 'stroke' ? 'strokes' : 'fills']: Array.isArray(value) ? value : value.paints || value.fills || [] };
}
function applyTo(target: Data, style: Data, kind: string, old?: Data, force = false): void {
    const next = fields(style, kind), previous = old ? fields(old, kind) : {};
    for (const [key, value] of Object.entries(next))
        if (force || !old || same(target[key], previous[key]))
            target[key] = copy(value);
    for (const key of Object.keys(previous))
        if (!(key in next) && same(target[key], previous[key]))
            delete target[key];
}
export function reconcileStyles(before: CanvasDocument, draft: CanvasDocument): void {
    for (const page of Object.values(draft.pagesById))
        for (const shape of Object.values(page.objects)) {
            const oldShape = before.pagesById[page.id]?.objects[shape.id];
            const visit = (target: Data, old?: Data) => {
                for (const kind of ['fill', 'stroke', 'text', 'effect']) {
                    const key = refs[kind], id = target[key];
                    if (!id)
                        continue;
                    const style = draft.styles?.[id];
                    if (!style) {
                        delete target[key];
                        continue;
                    }
                    const oldStyle = before.styles?.[id];
                    if (!oldStyle || !same(oldStyle, style)) {
                        const changed = new Set<string>();
                        if (old)
                            for (const field of Object.keys(fields(style, kind)))
                                if (!same(old[field], target[field]))
                                    changed.add(field);
                        const saved: Data = {};
                        for (const field of changed)
                            saved[field] = copy(target[field]);
                        applyTo(target, style, kind, oldStyle);
                        Object.assign(target, saved);
                    }
                }
            };
            visit(shape, oldShape);
            const prior: Data[] = [];
            runs(oldShape?.content, r => prior.push(r));
            let index = 0;
            runs(shape.content, r => visit(r, prior[index++]));
        }
}
function normalizedType(type: string): string {
    if (type === 'fill' || type === 'stroke')
        return 'paint';
    if (!['paint', 'text', 'effect'].includes(type))
        throw Error('Unknown style type');
    return type;
}
export function createStyleService(editor: EditorStore) {
    const service = {
        list(query = '') {
            return copy(Object.values(editor.doc.styles || {}).filter(s => (!s.libraryId || editor.doc.libraries?.[s.libraryId]?.enabled || service.users(s.id).some((user: Data) => !editor.doc.pagesById[user.pageId]?.isLibrary)) && `${s.name} ${s.description || ''}`.toLowerCase().includes(query.toLowerCase())));
        },
        create(type: string, name: string, value: any, description = '') {
            normalizedType(type);
            validateValue(type, value);
            if (!name.trim())
                throw Error('Style name required');
            return editor.transact('style:create', doc => {
                const s = { id: uid(), type: normalizedType(type), name, description, [normalizedType(type) === 'paint' ? 'paints' : normalizedType(type) === 'text' ? 'text' : 'effects']: copy(value) };
                (doc.styles ||= {})[s.id] = s;
                return copy(s);
            });
        },
        update(id: string, patch: Data) {
            return editor.transact('style:update', doc => {
                const s = doc.styles?.[id];
                if (!s)
                    throw Error('Unknown style');
                if (patch.type)
                    normalizedType(patch.type);
                for (const k of ['name', 'description', 'value', 'type', 'paints', 'text', 'effects'])
                    if (patch[k] !== undefined)
                        s[k] = copy(patch[k]);
                if (patch.value !== undefined) {
                    s[s.type === 'paint' ? 'paints' : s.type === 'text' ? 'text' : 'effects'] = copy(patch.value);
                    delete s.value;
                }
                validateValue(s.type, styleValue(s));
                if (!s.name?.trim())
                    throw Error('Style name required');
                return copy(s);
            });
        },
        rename(id: string, name: string) {
            return service.update(id, { name });
        },
        remove(id: string) {
            return editor.transact('style:remove', doc => {
                if (!doc.styles?.[id])
                    throw Error('Unknown style');
                delete doc.styles[id];
                for (const pg of Object.values(doc.pagesById))
                    for (const s of Object.values(pg.objects)) {
                        for (const key of Object.values(refs))
                            if (s[key] === id)
                                delete s[key];
                        runs(s.content, r => {
                            for (const key of Object.values(refs))
                                if (r[key] === id)
                                    delete r[key];
                        });
                    }
                return true;
            });
        },
        apply(id: string, ids: string[], kind?: string) {
            return editor.transact('style:apply', doc => {
                const s = doc.styles?.[id];
                if (!s)
                    throw Error('Unknown style');
                kind = ({ fills: 'fill', strokes: 'stroke', effects: 'effect' } as Record<string, string>)[kind || ''] || kind;
                const use = kind || (s.type === 'paint' ? 'fill' : s.type);
                if (!refs[use] || normalizedType(use) !== normalizedType(s.type))
                    throw Error('Incompatible style kind');
                for (const shapeId of ids) {
                    const target = locate(doc, shapeId)?.shape;
                    if (!target)
                        throw Error('Unknown shape');
                    target[refs[use]] = id;
                    if ((use === 'text' || use === 'fill') && target.type === 'text') {
                        runs(target.content, r => {
                            r[refs[use]] = id;
                            applyTo(r, s, use, undefined, true);
                        });
                    }
                    else
                        applyTo(target, s, use, undefined, true);
                }
                return { selection: ids };
            });
        },
        detach(ids: string[], kind?: string) {
            return editor.transact('style:detach', doc => {
                kind = ({ fills: 'fill', strokes: 'stroke', effects: 'effect' } as Record<string, string>)[kind || ''] || kind;
                const keys = kind ? [refs[kind]] : Object.values(refs);
                if (keys.some(k => !k))
                    throw Error('Unknown style kind');
                for (const id of ids) {
                    const s = locate(doc, id)?.shape;
                    if (!s)
                        throw Error('Unknown shape');
                    for (const key of keys)
                        delete s[key];
                    runs(s.content, r => {
                        for (const key of keys)
                            delete r[key];
                    });
                }
                return { selection: ids };
            });
        },
        users(id: string) {
            const found: Data[] = [];
            for (const page of Object.values(editor.doc.pagesById))
                for (const s of Object.values(page.objects)) {
                    if (Object.values(refs).some(key => s[key] === id))
                        found.push({ pageId: page.id, id: s.id });
                    let index = 0;
                    runs(s.content, r => {
                        if (Object.values(refs).some(key => r[key] === id))
                            found.push({ pageId: page.id, id: s.id, run: index });
                        index++;
                    });
                }
            return found;
        },
        run(action: string, args: Data = {}) {
            const ids = args.ids || args.selection || editor.selection;
            switch (action) {
                case 'create': return service.create(args.type, args.name, args.value ?? args.data, args.description);
                case 'update':
                case 'edit': return service.update(args.id, args.patch || args);
                case 'rename': return service.rename(args.id, args.name);
                case 'remove':
                case 'delete': return service.remove(args.id);
                case 'apply': return service.apply(args.id || args.styleId, ids, args.kind);
                case 'detach': return service.detach(ids, args.kind);
                case 'list': return service.list(args.query);
                default: throw Error(`Unknown style action ${action}`);
            }
        },
        reconcile: reconcileStyles,
    };
    return service;
}
function validateValue(type: string, value: any): void {
    if (type === 'paint' && !Array.isArray(value))
        throw Error('Paint style requires a paints array');
    if ((type === 'text' || type === 'effect') && (!value || typeof value !== 'object' || Array.isArray(value)))
        throw Error('Text and effect styles require an object');
}
