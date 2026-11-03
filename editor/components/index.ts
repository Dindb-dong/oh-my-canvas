import type { CanvasDocument, Data, EditorStore, Page, Shape } from '../contracts';
import { copy, uid, locate, subtree, frame, cloneTree, component, validateVariants } from './model';
import { reconcileComponents, syncInstance, propertyValue, applyProperties, textOnly, detachComponent } from './reconcile';
export { reconcileComponents } from './reconcile';
export { validateComponents } from './model';
const same = (a: any, b: any) => JSON.stringify(a) === JSON.stringify(b);
function record(doc: CanvasDocument, page: Page, main: Shape, name: string, path?: string): Data {
    const c = { id: uid(), name, path, mainId: main.id, mainPageId: page.id, variantProperties: [], properties: [] };
    (doc.components ||= {})[c.id] = c;
    main.componentId = c.id;
    main.isMain = true;
    delete main.isInstanceRoot;
    delete main.sourceId;
    delete main.overrides;
    return c;
}
export function createComponentService(editor: EditorStore) {
    return {
        reconcile: reconcileComponents,
        list(query = '', offset = 0) {
            if (!Number.isInteger(offset) || offset < 0)
                throw Error('Invalid offset');
            const rows = Object.values(editor.doc.components || {}).filter(c => !c.deleted && (!c.libraryId || editor.doc.libraries?.[c.libraryId]?.enabled) && `${c.path || ''}/${c.name}`.toLowerCase().includes(query.toLowerCase()));
            return { components: copy(rows.slice(offset, offset + 200)), total: rows.length, nextOffset: offset + 200 < rows.length ? offset + 200 : null };
        },
        run(action: string, input: Data = {}) {
            const args: Data = { ...input, componentId: input.componentId || input.source, parentId: input.parentId || input.parent, shapeId: input.shapeId || input.layer, type: input.type || input.propertyType };
            if ((args.x === undefined) !== (args.y === undefined))
                throw Error('x and y must be supplied together');
            const result: Data = editor.transact(`component:${action}`, doc => {
                const page = doc.pagesById[args.pageId || editor.pageId];
                if (!page)
                    throw Error('Unknown page');
                const ids: string[] = args.ids || args.selection || (args.id ? [args.id] : editor.selection);
                let root = ids[0] ? page.objects[ids[0]] : undefined;
                let c = action === 'instance' && args.componentId ? component(doc, args.componentId) : root?.componentId ? component(doc, root.componentId) : args.componentId ? component(doc, args.componentId) : undefined;
                const selection = () => ({ selection: root ? [root.id] : [], componentId: c?.id });
                if (action === 'create') {
                    if (!ids.length)
                        throw Error('Select shapes');
                    root = ids.length === 1 ? page.objects[ids[0]] : frame(page, ids, args.name || 'Component');
                    if (!root)
                        throw Error('Missing selection');
                    if (root.isMain)
                        throw Error('Already a main component');
                    c = record(doc, page, root, args.name || root.name || 'Component', args.path);
                    return selection();
                }
                if (action === 'instance') {
                    if (!c)
                        throw Error('componentId required');
                    if (c.libraryId && !doc.libraries?.[c.libraryId]?.enabled)
                        throw Error('Library disabled or unavailable');
                    const source = doc.pagesById[c.mainPageId];
                    const main = source.objects[c.mainId];
                    const parentId = args.parentId || 'root';
                    if (!page.objects[parentId])
                        throw Error('Unknown parent');
                    root = cloneTree(source, main.id, page, parentId, (args.x ?? main.x) - main.x, (args.y ?? main.y) - main.y, true, c.id);
                    return selection();
                }
                if (action === 'combine') {
                    if (ids.length < 2)
                        throw Error('Select two or more mains');
                    const components = ids.map(id => {
                        const s = page.objects[id];
                        if (!s?.isMain)
                            throw Error('Variants must be mains');
                        return component(doc, s.componentId);
                    });
                    root = frame(page, ids, args.name || 'Variants');
                    root.isVariantSet = true;
                    root.variantSetId = root.id;
                    const axis = args.axis || 'Variant';
                    components.forEach((v, i) => {
                        v.variantSetId = root!.id;
                        v.variantProperties = args.values ? [{ name: axis, value: String(args.values[i]) }] : parseVariantName(v.name).length ? parseVariantName(v.name) : v.variantProperties?.length ? v.variantProperties : [{ name: axis, value: String(v.name || i + 1) }];
                    });
                    validateVariants(doc, root.id);
                    return { selection: [root.id], variantSetId: root.id };
                }
                if (!root && c)
                    root = doc.pagesById[c.mainPageId]?.objects[c.mainId];
                if (!c || !root)
                    throw Error('Component selection required');
                const rootPage = locate(doc, root.id)!.page;
                if (action === 'add_variant') {
                    if (!root.isMain) {
                        root = doc.pagesById[c.mainPageId].objects[c.mainId];
                    }
                    const sourcePage = doc.pagesById[c.mainPageId];
                    let set = sourcePage.objects[c.variantSetId];
                    if (!set) {
                        set = frame(sourcePage, [root.id], args.setName || c.name);
                        set.isVariantSet = true;
                        c.variantSetId = set.id;
                        const named = parseVariantName(c.name);
                        const requested = args.variantProperties || parseVariantName(args.name || '');
                        c.variantProperties = copy(c.variantProperties?.length ? c.variantProperties : named.length ? named : requested.length ? requested.map((p: Data) => ({ name: p.name, value: args.originalValue || 'Default' })) : [{ name: args.axis || 'Variant', value: args.originalValue || 'Default' }]);
                    }
                    const clone = cloneTree(sourcePage, root.id, sourcePage, set.id, args.dx ?? root.width + 24, args.dy ?? 0);
                    const next = record(doc, sourcePage, clone, args.name || `${c.name} copy`, c.path);
                    next.properties = copy(c.properties || []);
                    next.variantSetId = set.id;
                    next.variantProperties = copy(args.variantProperties || (parseVariantName(args.name || '').length ? parseVariantName(args.name) : c.variantProperties));
                    if (!args.variantProperties && !parseVariantName(args.name || '').length) {
                        const first = next.variantProperties[0];
                        if (first)
                            first.value = args.value || `${first.value} copy`;
                    }
                    validateVariants(doc, set.id);
                    return { selection: [clone.id], componentId: next.id, pageId: sourcePage.id };
                }
                if (action === 'variant') {
                    if (!root.isInstanceRoot || root.isMain)
                        throw Error('Select an instance');
                    let nextId = args.variantId || args.targetComponentId;
                    if (!nextId && doc.components?.[args.value])
                        nextId = args.value;
                    if (!nextId) {
                        const requested = parseVariantName(String(args.value || ''));
                        if (args.name)
                            requested.push({ name: args.name, value: String(args.value) });
                        const matches = Object.values(doc.components || {}).filter(v => {
                            if (v.deleted || v.variantSetId !== c!.variantSetId)
                                return false;
                            if (v.name === args.value)
                                return true;
                            const props = v.variantProperties || [];
                            if (requested.length)
                                return props.every((p: Data) => p.value === (requested.find(q => q.name === p.name)?.value || (c!.variantProperties || []).find((q: Data) => q.name === p.name)?.value));
                            const changes = props.filter((p: Data) => p.value !== (c!.variantProperties || []).find((q: Data) => q.name === p.name)?.value);
                            return changes.length === 1 && changes[0].value === args.value;
                        });
                        if (matches.length !== 1)
                            throw Error('Variant value must identify exactly one variant');
                        nextId = matches[0].id;
                    }
                    const next = component(doc, nextId);
                    if (!c.variantSetId || next.variantSetId !== c.variantSetId)
                        throw Error('Variant must belong to the same set');
                    const source = doc.pagesById[next.mainPageId];
                    remapVariant(rootPage, root, doc.pagesById[c.mainPageId], doc.pagesById[c.mainPageId].objects[c.mainId], source, source.objects[next.mainId], c, next);
                    if (root.componentOuterSourceId || Object.keys(root.componentSourceIds || {}).length > 1)
                        root.overrides = [...(root.overrides || []), 'componentId'];
                    root.componentId = next.id;
                    root.sourceId = next.mainId;
                    syncInstance(doc, rootPage, root, source, source.objects[next.mainId]);
                    applyProperties(doc, rootPage, root, next);
                    return { selection: [root.id], componentId: next.id };
                }
                if (action === 'reset') {
                    if (!root.isInstanceRoot || root.isMain)
                        throw Error('Select an instance');
                    const sources = new Map<string, Shape>();
                    for (const s of subtree(rootPage, root.id)) {
                        const sourceId = s.componentSourceIds?.[c.id] || s.sourceId;
                        const source = sourceId ? locate(doc, sourceId)?.shape : undefined;
                        if (source)
                            sources.set(s.id, source);
                        s.overrides = ['__command'];
                        delete s.componentProperties;
                        delete s.propertyValues;
                    }
                    syncInstance(doc, rootPage, root, doc.pagesById[c.mainPageId], doc.pagesById[c.mainPageId].objects[c.mainId]);
                    for (const s of subtree(rootPage, root.id)) {
                        const source = sources.get(s.id);
                        s.overrides = [...(source?.overrides || []), '__command'];
                        if (source?.componentProperties)
                            s.componentProperties = copy(source.componentProperties);
                        if (source?.propertyValues)
                            s.propertyValues = copy(source.propertyValues);
                    }
                    return selection();
                }
                if (action === 'detach') {
                    if (!root.isInstanceRoot || root.isMain)
                        throw Error('Select an instance');
                    detachComponent(doc, rootPage, root.id);
                    return { selection: [root.id] };
                }
                if (action === 'property' || (action === 'bind' && !args.property && !args.propertyId)) {
                    const type = args.type || 'text';
                    if (!['boolean', 'text', 'swap'].includes(type))
                        throw Error('Unknown property type');
                    if (!args.name)
                        args.name = type === 'text' ? 'Text' : type === 'boolean' ? 'Visible' : 'Component';
                    if ((c.properties || []).some((p: Data) => p.name === args.name))
                        throw Error('Duplicate property name');
                    const p = { id: uid(), name: args.name, type, default: propertyValue({ type }, args.default ?? args.value ?? (type === 'boolean' ? true : '')) };
                    if (p.type === 'swap' && p.default)
                        component(doc, String(p.default));
                    (c.properties ||= []).push(p);
                    if (action === 'bind') {
                        args.propertyId = p.id;
                        args.createdProperty = true;
                    }
                    else
                        return { ...selection(), property: copy(p) };
                }
                const p = (c.properties || []).find((p: Data) => p.id === (args.propertyId || args.property));
                if (!p)
                    throw Error('Unknown component property');
                if (action === 'bind' && args.type && args.type !== p.type)
                    throw Error('Property type mismatch');
                if (action === 'edit_property') {
                    if (args.name && c.properties.some((other: Data) => other !== p && other.name === args.name))
                        throw Error('Duplicate property name');
                    if (args.name)
                        p.name = args.name;
                    if (args.default !== undefined || args.value !== undefined)
                        p.default = propertyValue(p, args.default ?? args.value);
                    applyProperties(doc, doc.pagesById[c.mainPageId], doc.pagesById[c.mainPageId].objects[c.mainId], c);
                    return { ...selection(), property: copy(p) };
                }
                if (action === 'remove_property') {
                    c.properties = c.properties.filter((v: Data) => v !== p);
                    for (const pg of Object.values(doc.pagesById))
                        for (const s of Object.values(pg.objects)) {
                            for (const [key, id] of Object.entries(s.componentPropertyRefs || {}))
                                if (id === p.id)
                                    delete s.componentPropertyRefs[key];
                            if (s.componentProperties)
                                delete s.componentProperties[p.id];
                            if (s.propertyValues)
                                delete s.propertyValues[p.id];
                        }
                    return selection();
                }
                if (action === 'bind') {
                    const target = locate(doc, args.shapeId || args.targetId || root.id);
                    if (!target)
                        throw Error('Unknown binding target');
                    const mainPage = doc.pagesById[c.mainPageId];
                    const owned = subtree(mainPage, c.mainId);
                    if (target.page !== mainPage || !owned.some(s => s.id === target.shape.id))
                        throw Error('Property target must belong to main');
                    let ancestor = target.shape;
                    while (ancestor.id !== c.mainId) {
                        if (ancestor.isInstanceRoot && ancestor !== target.shape)
                            throw Error('Cannot bind through a nested component');
                        ancestor = mainPage.objects[ancestor.parentId];
                    }
                    const key = p.type === 'boolean' ? 'visible' : p.type === 'text' ? 'characters' : 'mainComponent';
                    if (p.type === 'text' && target.shape.type !== 'text')
                        throw Error('Text binding requires text');
                    if (p.type === 'swap' && !target.shape.isInstanceRoot)
                        throw Error('Swap binding requires nested instance');
                    if (args.createdProperty && args.value === undefined && args.default === undefined) {
                        p.default = p.type === 'boolean' ? !target.shape.hidden : p.type === 'swap' ? target.shape.componentId : textOnly(target.shape.content).join('');
                    }
                    (target.shape.componentPropertyRefs ||= {})[key] = p.id;
                    applyProperties(doc, mainPage, mainPage.objects[c.mainId], c);
                    return { ...selection(), property: copy(p) };
                }
                if (action === 'set_property') {
                    const value = propertyValue(p, args.value);
                    if (p.type === 'swap' && value)
                        component(doc, String(value));
                    if (root.isMain)
                        p.default = value;
                    else if (root.isInstanceRoot)
                        (root.componentProperties ||= copy(root.propertyValues || {}))[p.id] = value;
                    else
                        throw Error('Select main or instance');
                    applyProperties(doc, rootPage, root, c);
                    return selection();
                }
                throw Error(`Unknown component action ${action}`);
            });
            return result;
        }
    };
}
/** Used by clipboard commands inside their already-isolated candidate. */
export function duplicateComponentMain(doc: CanvasDocument, page: Page, id: string, options: Data = {}): Shape | undefined {
    const main = page.objects[id];
    if (!main?.isMain || !main.componentId)
        return;
    const c = component(doc, main.componentId);
    return cloneTree(doc.pagesById[c.mainPageId], c.mainId, page, options.parentId || main.parentId, options.dx ?? 0, options.dy ?? 0, true, c.id);
}
function remapVariant(page: Page, root: Shape, oldPage: Page, oldMain: Shape, nextPage: Page, nextMain: Shape, oldComponent: Data, nextComponent: Data): void {
    const sourceMap = new Map<string, string>([[oldMain.id, nextMain.id]]);
    const pair = (a: Shape, b: Shape) => {
        const used = new Set<string>();
        for (const [index, aid] of (a.childIds || []).entries()) {
            const left = oldPage.objects[aid];
            const candidates = (b.childIds || []).map(id => nextPage.objects[id]);
            const right = candidates.find(s => !used.has(s.id) && s.type === left.type && s.name === left.name) || candidates.find((s, i) => i === index && !used.has(s.id) && s.type === left.type);
            if (right) {
                used.add(right.id);
                sourceMap.set(left.id, right.id);
                pair(left, right);
            }
        }
    };
    pair(oldMain, nextMain);
    for (const s of subtree(page, root.id)) {
        const oldId = s.componentSourceIds?.[oldComponent.id] || s.sourceId;
        const nextId = sourceMap.get(oldId);
        if (nextId) {
            s.sourceId = nextId;
            (s.componentSourceIds ||= {})[nextComponent.id] = nextId;
        }
        s.overrides = [...(s.overrides || []), '__command'];
    }
    const previousValues = root.componentProperties || root.propertyValues;
    if (previousValues) {
        const values: Data = {};
        for (const p of oldComponent.properties || []) {
            const next = (nextComponent.properties || []).find((q: Data) => q.name === p.name && q.type === p.type);
            if (next && Object.hasOwn(previousValues, p.id))
                values[next.id] = copy(previousValues[p.id]);
        }
        root.componentProperties = values;
        delete root.propertyValues;
    }
}
function parseVariantName(name: string): {
    name: string;
    value: string;
}[] {
    const parts = name.split(",").map(part => part.trim().split("="));
    return parts.every(pair => pair.length === 2 && pair[0].trim() && pair[1].trim()) ? parts.map(([name, value]) => ({ name: name.trim(), value: value.trim() })) : [];
}
