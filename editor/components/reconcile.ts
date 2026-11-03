import type { CanvasDocument, Data, Page, Shape } from '../contracts';
import { copy, uid, locate, subtree, geometry, translate, eraseTree, component, validateComponents, validateVariants } from './model';
const same = (a: any, b: any) => JSON.stringify(a) === JSON.stringify(b);
const local = new Set(['id', 'parentId', 'enclosingFrameId', 'childIds', 'sourceId', 'overrides', 'isMain', 'isInstanceRoot', 'componentId', 'componentProperties', 'propertyValues', 'componentOuterSourceId', 'componentSourceIds', 'box', 'corners', 'inverseTransform']);
const category = (key: string) => key;
function textMap(content: any, fn: (r: Data) => void): void {
    if (!content || typeof content !== 'object')
        return;
    if (typeof content.text === 'string')
        fn(content);
    for (const c of content.children || [])
        textMap(c, fn);
}
export function textOnly(content: any): string[] {
    const out: string[] = [];
    textMap(content, r => out.push(r.text));
    return out;
}
function mergeContent(source: any, current: any, overrides: Set<string>): any {
    if (overrides.has('content') || overrides.has('text') || (overrides.has('characters') && overrides.has('textStyle')))
        return copy(current);
    const keepCharacters = overrides.has('characters'), keepStyle = overrides.has('textStyle');
    const result = copy(keepCharacters ? current : source);
    if (!keepCharacters && !keepStyle)
        return result;
    const styleSource = keepCharacters ? source : current;
    const styleKeys = ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'textDecoration', 'textDecorationStyle', 'textDecorationThickness', 'textTransform', 'highlight', 'letterSpacing', 'fills', 'textStyleId', 'fillStyleId', 'lineHeight'];
    const paragraphKeys = ['textAlign', 'lineHeight', 'paragraphSpacing', 'paragraphIndent', 'listType', 'listLevel'];
    const styleRuns: Data[] = [];
    textMap(styleSource, r => styleRuns.push(r));
    let runIndex = 0;
    textMap(result, r => {
        const style = styleRuns[Math.min(runIndex++, styleRuns.length - 1)];
        if (!style)
            return;
        for (const key of styleKeys) {
            if (style[key] === undefined)
                delete r[key];
            else
                r[key] = copy(style[key]);
        }
    });
    const sourceParagraphs = styleSource?.children || [];
    for (const [index, paragraph] of (result?.children || []).entries()) {
        const style = sourceParagraphs[Math.min(index, sourceParagraphs.length - 1)];
        if (style)
            for (const key of paragraphKeys) {
                if (style[key] === undefined)
                    delete paragraph[key];
                else
                    paragraph[key] = copy(style[key]);
            }
    }
    return result;
}
function overrideChanges(old: Shape, current: Shape, isRoot: boolean, shiftX = 0, shiftY = 0): void {
    const set = new Set<string>(current.overrides || []);
    for (const key of new Set([...Object.keys(old), ...Object.keys(current)])) {
        if (local.has(key) || (isRoot && ['x', 'y'].includes(key)) || (key === 'x' && Math.abs(current.x - old.x - shiftX) < 1e-8) || (key === 'y' && Math.abs(current.y - old.y - shiftY) < 1e-8))
            continue;
        if (!same(old[key], current[key])) {
            if (key === 'content' && current.type === 'text') {
                if (!same(characterContent(old.content), characterContent(current.content)))
                    set.add('characters');
                const clean = (v: any) => ({ verticalAlign: v?.verticalAlign, paragraphs: (v?.children || []).map((paragraph: Data) => {
                        const fields = { ...paragraph };
                        delete fields.children;
                        const styles: Data[] = [];
                        for (const run of paragraph.children || []) {
                            const style = { ...run };
                            delete style.text;
                            if (!styles.length || !same(styles.at(-1), style))
                                styles.push(style);
                        }
                        return { fields, styles };
                    }) });
                if (!same(clean(old.content), clean(current.content)))
                    set.add('textStyle');
            }
            else
                set.add(category(key));
        }
    }
    current.overrides = [...set];
}
export function syncInstance(doc: CanvasDocument, page: Page, root: Shape, sourcePage: Page, main: Shape): void {
    let sourceRows = subtree(sourcePage, main.id);
    const currentRows = subtree(page, root.id);
    const mapping = new Map<string, Shape>([[main.id, root]]);
    for (const row of currentRows)
        if (row.id !== root.id && row.sourceId) {
            let id = row.componentSourceIds?.[root.componentId] || row.componentOuterSourceId || row.sourceId;
            const visited = new Set<string>();
            while (id && !visited.has(id)) {
                visited.add(id);
                if (sourceRows.some(s => s.id === id)) {
                    mapping.set(id, row);
                    break;
                }
                id = locate(doc, id)?.shape.sourceId;
            }
        }
    const swapped = new Set<string>(), skippedSources = new Set<string>(), protectedTargets = new Set<string>();
    const values = root.componentProperties || root.propertyValues || {};
    for (const src of sourceRows) {
        const dst = mapping.get(src.id);
        if (!dst || dst === root || !src.isInstanceRoot || !dst.isInstanceRoot || dst.componentId === src.componentId)
            continue;
        const binding = src.componentPropertyRefs?.mainComponent;
        const overrides = new Set(dst.overrides || []);
        if (!overrides.has('componentId') && !overrides.has('mainComponent') && !(binding && Object.hasOwn(values, binding) && values[binding] === dst.componentId))
            continue;
        swapped.add(src.id);
        for (const child of subtree(sourcePage, src.id).slice(1))
            skippedSources.add(child.id);
        for (const child of subtree(page, dst.id))
            protectedTargets.add(child.id);
    }
    sourceRows = sourceRows.filter(s => !skippedSources.has(s.id));
    const dx = root.x - main.x, dy = root.y - main.y;
    for (const original of sourceRows) {
        const src = copy(original);
        translate(src, dx, dy);
        let dst = mapping.get(src.id);
        if (!dst) {
            dst = copy(src);
            dst.id = uid();
            if (dst.childIds)
                dst.childIds = [];
            dst.sourceId = src.id;
            dst.overrides = copy(src.overrides || []);
            delete dst.isMain;
            page.objects[dst.id] = dst;
            mapping.set(src.id, dst);
        }
        if (swapped.has(src.id)) {
            const shiftX = src.x - dst.x, shiftY = src.y - dst.y;
            for (const child of subtree(page, dst.id))
                translate(child, shiftX, shiftY);
            dst.parentId = mapping.get(src.parentId)?.id || root.id;
            dst.enclosingFrameId = mapping.get(src.enclosingFrameId)?.id || root.enclosingFrameId;
            const ownDefinitions = doc.components?.[dst.componentId]?.properties || [];
            const ownRefs = Object.fromEntries(Object.entries(dst.componentPropertyRefs || {}).filter(([, id]) => ownDefinitions.some((p: Data) => p.id === id)));
            dst.componentPropertyRefs = { ...ownRefs, ...copy(src.componentPropertyRefs || {}) };
            dst.componentOuterSourceId = src.id;
            (dst.componentSourceIds ||= {})[root.componentId] = src.id;
            continue;
        }
        const overrides = new Set<string>(dst.overrides || []);
        for (const k of new Set([...Object.keys(src), ...Object.keys(dst)])) {
            if (local.has(k) || (dst === root && ['x', 'y'].includes(k)) || isOverridden(overrides, k))
                continue;
            if (k === 'componentPropertyRefs' && dst === root) {
                const definitions = doc.components?.[root.componentId]?.properties || [];
                const outer = Object.fromEntries(Object.entries(dst.componentPropertyRefs || {}).filter(([, id]) => !definitions.some((p: Data) => p.id === id)));
                const refs = { ...(src.componentPropertyRefs || {}), ...outer };
                if (Object.keys(refs).length)
                    dst.componentPropertyRefs = refs;
                else
                    delete dst.componentPropertyRefs;
                continue;
            }
            if (k === 'content') {
                dst.content = mergeContent(src.content, dst.content, overrides);
                continue;
            }
            if (src[k] === undefined)
                delete dst[k];
            else
                dst[k] = copy(src[k]);
        }
        if (dst !== root) {
            dst.parentId = mapping.get(src.parentId)?.id || root.id;
            dst.enclosingFrameId = mapping.get(src.enclosingFrameId)?.id || root.enclosingFrameId;
            if (!isOverridden(overrides, 'x'))
                dst.x = src.x;
            if (!isOverridden(overrides, 'y'))
                dst.y = src.y;
            if (src.isInstanceRoot) {
                dst.isInstanceRoot = true;
                if (!overrides.has('componentId') && !overrides.has('mainComponent'))
                    dst.componentId = src.componentId;
                dst.componentOuterSourceId = src.id;
            }
        }
        (dst.componentSourceIds ||= {})[root.componentId] = src.id;
        dst.sourceId = src.id;
        geometry(dst);
    }
    for (const src of sourceRows) {
        const dst = mapping.get(src.id)!;
        if (swapped.has(src.id))
            continue;
        if (!src.childIds && dst.childIds) {
            for (const id of [...dst.childIds])
                eraseTree(page, id);
            delete dst.childIds;
        }
        if (src.childIds && !new Set(dst.overrides || []).has('childIds')) {
            const custom = (dst.childIds || []).filter(id => !page.objects[id]?.sourceId);
            dst.childIds = [...src.childIds.map(id => mapping.get(id)!.id), ...custom];
        }
    }
    for (const row of currentRows)
        if (row !== root && row.sourceId && !protectedTargets.has(row.id) && ![...mapping.values()].includes(row)) {
            eraseTree(page, row.id);
        }
    root.sourceId = main.id;
}
export function propertyValue(p: Data, value: any): boolean | string {
    if (p.type === 'boolean') {
        if (value === 'true')
            return true;
        if (value === 'false')
            return false;
        if (typeof value !== 'boolean')
            throw Error('Boolean property requires true or false');
        return value;
    }
    if (typeof value !== 'string')
        throw Error('Text and swap properties require strings');
    return value;
}
export function applyProperties(doc: CanvasDocument, page: Page, root: Shape, c: Data): void {
    const values = root.componentProperties || root.propertyValues || {};
    for (const s of subtree(page, root.id))
        for (const [key, id] of Object.entries(s.componentPropertyRefs || {})) {
            const p = (c.properties || []).find((p: Data) => p.id === id);
            if (!p)
                continue;
            const explicit = Object.hasOwn(values, p.id);
            if (!explicit && !root.isMain)
                continue;
            if (!explicit && ((key === 'characters' && (s.overrides || []).includes('characters')) || (key === 'visible' && (s.overrides || []).includes('hidden')) || (key === 'mainComponent' && (s.overrides || []).includes('componentId'))))
                continue;
            const value = propertyValue(p, values[p.id] ?? p.default);
            if (key === 'visible')
                s.hidden = !value;
            else if (key === 'characters') {
                let first = true;
                textMap(s.content, r => {
                    r.text = first ? String(value) : '';
                    first = false;
                });
            }
            else if (key === 'mainComponent' && s.isInstanceRoot && value && s.componentId !== value) {
                const next = component(doc, String(value));
                const source = doc.pagesById[next.mainPageId]?.objects[next.mainId];
                if (!source)
                    throw Error('Swap source missing');
                s.componentId = value;
                validateComponents(doc);
                syncInstance(doc, page, s, doc.pagesById[next.mainPageId], source);
            }
        }
}
export function reconcileComponents(before: CanvasDocument, draft: CanvasDocument): void {
    for (const page of Object.values(draft.pagesById))
        for (const root of Object.values(page.objects)) {
            const c = root.componentId ? draft.components?.[root.componentId] : undefined;
            if (root.isMain && c && !c.deleted && root.id !== c.mainId) {
                const sourcePage = draft.pagesById[c.mainPageId], main = sourcePage?.objects[c.mainId];
                if (main) {
                    const pair = (target: Shape, source: Shape) => {
                        target.sourceId = source.id;
                        (target.componentSourceIds ||= {})[c.id] = source.id;
                        target.overrides = copy(source.overrides || []);
                        for (const [index, id] of (target.childIds || []).entries()) {
                            const sourceId = source.childIds?.[index];
                            if (sourceId)
                                pair(page.objects[id], sourcePage.objects[sourceId]);
                        }
                    };
                    pair(root, main);
                    delete root.isMain;
                    root.isInstanceRoot = true;
                }
            }
        }
    for (const page of Object.values(draft.pagesById))
        for (const s of Object.values(page.objects)) {
            const old = before.pagesById[page.id]?.objects[s.id];
            if (old && !s.overrides?.includes('__command'))
                updateBoundValues(draft, page, old, s);
            if (s.overrides?.includes('__command'))
                s.overrides = s.overrides.filter((key: string) => key !== '__command');
            else if (s.overrides?.includes('__reset'))
                s.overrides = [];
            else if (old?.sourceId && s.sourceId === old.sourceId && s.componentId === old.componentId && same(old.overrides, s.overrides)) {
                let parent = s;
                while (parent.parentId !== 'root' && !parent.isInstanceRoot)
                    parent = page.objects[parent.parentId];
                const prior = before.pagesById[page.id]?.objects[parent.id];
                overrideChanges(old, s, !!s.isInstanceRoot, prior ? parent.x - prior.x : 0, prior ? parent.y - prior.y : 0);
            }
        }
    for (const c of Object.values(draft.components || {})) {
        if (c.deleted)
            continue;
        if (!draft.pagesById[c.mainPageId]?.objects[c.mainId])
            c.deleted = true;
    }
    validateComponents(draft);
    for (const setId of new Set(Object.values(draft.components || {}).filter(c => !c.deleted && c.variantSetId).map(c => c.variantSetId)))
        validateVariants(draft, setId);
    const done = new Set<string>();
    const syncComponent = (id: string) => {
        if (done.has(id))
            return;
        done.add(id);
        const c = draft.components?.[id];
        if (!c || c.deleted)
            return;
        const mainPage = draft.pagesById[c.mainPageId], main = mainPage?.objects[c.mainId];
        if (!main)
            return;
        for (const s of subtree(mainPage, main.id))
            if (s.id !== main.id && s.isInstanceRoot && s.componentId)
                syncComponent(s.componentId);
        for (const page of Object.values(draft.pagesById))
            for (const root of Object.values(page.objects))
                if (root.isInstanceRoot && root.componentId === id && root.id !== c.mainId) {
                    syncInstance(draft, page, root, mainPage, main);
                    applyProperties(draft, page, root, c);
                }
    };
    for (const id of Object.keys(draft.components || {}))
        syncComponent(id);
    for (const page of Object.values(draft.pagesById))
        for (const root of Object.values(page.objects))
            if (root.isInstanceRoot && (!draft.components?.[root.componentId] || draft.components[root.componentId].deleted))
                detachComponent(draft, page, root.id);
    validateComponents(draft);
}
export function detachComponent(doc: CanvasDocument, page: Page, id: string): void {
    const root = page.objects[id], owner = root.componentId;
    const walk = (s: Shape) => {
        if (s.id !== id && s.isInstanceRoot && s.componentId) {
            const c = doc.components?.[s.componentId];
            if (c && !c.deleted) {
                const source = doc.pagesById[c.mainPageId];
                syncInstance(doc, page, s, source, source.objects[c.mainId]);
                for (const child of subtree(page, s.id)) {
                    if (child.componentSourceIds)
                        delete child.componentSourceIds[owner];
                    delete child.componentOuterSourceId;
                }
                return;
            }
        }
        delete s.componentId;
        delete s.sourceId;
        delete s.isMain;
        delete s.isInstanceRoot;
        delete s.overrides;
        delete s.componentProperties;
        delete s.propertyValues;
        delete s.componentPropertyRefs;
        delete s.componentOuterSourceId;
        delete s.componentSourceIds;
        for (const child of s.childIds || [])
            walk(page.objects[child]);
    };
    walk(root);
}
function characterContent(content: any): string[] {
    return (content?.children || []).map((paragraph: any) => {
        const texts: string[] = [];
        textMap(paragraph, r => texts.push(r.text));
        return texts.join('');
    });
}
function isOverridden(overrides: Set<string>, field: string): boolean {
    if (overrides.has(field))
        return true;
    const groups: Record<string, string[]> = { geometry: ['x', 'y', 'width', 'height', 'rotation', 'transform', 'flipX', 'flipY'], position: ['x', 'y'], size: ['width', 'height'], paint: ['fills', 'strokes'], effects: ['shadows', 'blur', 'blurHidden', 'backgroundBlur', 'backgroundBlurHidden'], layout: ['layout', 'hSizing', 'vSizing', 'minWidth', 'maxWidth', 'minHeight', 'maxHeight', 'gridCell', 'absolute', 'horizontalConstraint', 'verticalConstraint'] };
    return Object.entries(groups).some(([name, keys]) => overrides.has(name) && keys.includes(field));
}
function updateBoundValues(doc: CanvasDocument, page: Page, old: Shape, current: Shape): void {
    for (const [field, id] of Object.entries(current.componentPropertyRefs || {})) {
        let value: any;
        if (field === 'characters' && !same(characterContent(old.content), characterContent(current.content)))
            value = characterContent(current.content).join('\n');
        else if (field === 'visible' && old.hidden !== current.hidden)
            value = !current.hidden;
        else if (field === 'mainComponent' && old.componentId !== current.componentId)
            value = current.componentId;
        else
            continue;
        let owner: Shape | undefined = current;
        const seen = new Set<string>();
        while (owner && !seen.has(owner.id)) {
            seen.add(owner.id);
            const c = doc.components?.[owner.componentId];
            const p = c?.properties?.find((p: Data) => p.id === id);
            if (p) {
                if (owner.isMain)
                    p.default = value;
                else
                    (owner.componentProperties ||= copy(owner.propertyValues || {}))[String(id)] = value;
                break;
            }
            if (owner.id === 'root')
                break;
            owner = page.objects[owner.parentId];
        }
    }
}
