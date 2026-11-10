import type { CanvasDocument, Data, EditorStore, Shape } from '../contracts';
import { addPage, duplicatePage, deletePage, clone, createShape, insertShape, ancestors, descendants, topLevelIds, isEditable, moveTree, resizeTree, removeShapes, remapReferences } from '../document';
import { groupShapes, ungroupShapes, alignShapes, distributeShapes, orderShapes, rotateShapes, flipShapes } from '../commands';
import { unionBounds, shapeBounds, fitViewport } from '../geometry';
import { richText, textValue, uid } from '../formats/model';
import { SHAPE_PROPERTIES, TEXT_STYLE_PROPERTIES, validateShapeProperties, validateTextStyleProperties, validateJson } from './properties';
import { referencedAssets, prepareAssetTransfer, mergeTransferredAssets } from '../images/assets';

export function requireEditable(editor: EditorStore, ids: string[], ownFlags?: Data): void {
    if (!ids.length || new Set(ids).size !== ids.length) throw Error('Choose distinct layers');
    for (const id of ids) {
        const shape = editor.page.objects[id];
        if (!shape || id === 'root') throw Error('Choose existing non-root layers');
        if (ancestors(editor.page, id).some(parent => parent.locked || parent.hidden)) throw Error('A layer ancestor is locked or hidden');
        if (shape.locked || shape.hidden) {
            const keys = Object.keys(ownFlags ?? {});
            if (!keys.length || keys.some(key => key !== 'locked' && key !== 'hidden') || shape.locked && ownFlags?.locked !== false || shape.hidden && ownFlags?.hidden !== false)
                throw Error('Layer is locked or hidden; clear its own flags separately');
        }
    }
}
export function applyEditorOperation(name: string, args: Data, editor: EditorStore, doc: CanvasDocument, services: Data): Data | undefined {
    const page = doc.pagesById[editor.pageId];
    if (name === 'page') {
        const id = args.pageId ?? editor.pageId;
        if (args.action === 'create') {
            const created = addPage(doc, args.name); editor.setPage(created.id); return { pageId: created.id };
        }
        if (!doc.pagesById[id]) throw Error('Page was not found');
        if (args.action === 'duplicate') {
            const source = doc.pagesById[id], created = duplicatePage(doc, id);
            const shapeMap = new Map(Object.keys(source.objects).map((key, index) => [key, Object.keys(created.objects)[index]]));
            const componentMap = new Map(Object.values(doc.components ?? {}).filter(component => component.mainPageId === id).map(component => [component.id, uid()]));
            const mapping = new Map([...shapeMap, ...componentMap]);
            for (const shape of Object.values(created.objects)) Object.assign(shape, remapReferences(shape, mapping));
            for (const component of Object.values(doc.components ?? {})) if (component.mainPageId === id) {
                const copied = remapReferences(clone(component), mapping); copied.id = componentMap.get(component.id)!; copied.mainPageId = created.id; copied.mainId = shapeMap.get(component.mainId)!;
                (doc.components ||= {})[copied.id] = copied;
            }
            if (args.name !== undefined) created.name = args.name;
            editor.setPage(created.id); return { pageId: created.id };
        }
        if (args.action === 'rename') doc.pagesById[id].name = args.name;
        else if (args.action === 'delete') { deletePage(doc, id); if (editor.pageId === id) editor.setPage(doc.pages[0]); }
        else if (args.action === 'reorder') { doc.pages.splice(doc.pages.indexOf(id), 1); doc.pages.splice(Math.min(args.index, doc.pages.length), 0, id); }
        else if (args.action === 'update') Object.assign(doc.pagesById[id], clone(args.properties));
        else throw Error('Unknown page action');
        return { pageId: editor.pageId, pages: doc.pages.map(key => ({ id: key, name: doc.pagesById[key].name })) };
    }
    if (name === 'create_shape') {
        const parentId = args.parentId ?? 'root', parent = page.objects[parentId];
        if (!parent?.childIds || parentId !== 'root' && !isEditable(page, parentId)) throw Error('Choose an editable container');
        const properties = args.properties ?? {}; validateShapeProperties(properties);
        const shape = createShape(args.type, { ...properties, id: uid(), ...Object.fromEntries(['x', 'y', 'width', 'height'].filter(key => args[key] !== undefined).map(key => [key, args[key]])) });
        insertShape(page, shape, parentId); return { rawIds: [shape.id], selection: [shape.id] };
    }
    if (name === 'edit_shapes') {
        const ids = args.ids as string[], roots = topLevelIds(page, ids);
        validateShapeProperties(Object.fromEntries(['fills', 'layout'].filter(key => args[key] !== undefined).map(key => [key, args[key]])));
        requireEditable(editor, ids, args.action === 'patch' ? args.properties : undefined);
        if (args.action === 'patch') {
            validateShapeProperties(args.properties);
            for (const id of roots) {
                const shape = page.objects[id], properties = clone(args.properties);
                if (shape.constrainProportions && shape.width && shape.height) { if (typeof properties.width === 'number' && properties.height === undefined) properties.height = shape.height * properties.width / shape.width; else if (typeof properties.height === 'number' && properties.width === undefined) properties.width = shape.width * properties.height / shape.height; }
                if (properties.rotation !== undefined && properties.rotation !== null) { rotateShapes(page, [id], properties.rotation - shape.rotation); delete properties.rotation; }
                if (properties.x !== undefined && properties.x !== null || properties.y !== undefined && properties.y !== null) {
                    moveTree(page, id, (properties.x ?? shape.x) - shape.x, (properties.y ?? shape.y) - shape.y); delete properties.x; delete properties.y;
                }
                if (properties.width !== undefined && properties.width !== null || properties.height !== undefined && properties.height !== null) {
                    resizeTree(page, id, { x: shape.x, y: shape.y, width: properties.width ?? shape.width, height: properties.height ?? shape.height }); delete properties.width; delete properties.height;
                }
                for (const [key, value] of Object.entries(properties)) { if (value === null) delete shape[key]; else shape[key] = value; }
                if ('hidden' in properties) shape.visible = !shape.hidden;
            }
        }
        else if (args.action === 'group' || args.action === 'frame') return { selection: [groupShapes(page, roots, args.action === 'frame' ? 'frame' : 'group', { ...(args.name ? { name: args.name } : {}), ...(args.action === 'frame' ? { clipContent: args.clipContent ?? false, fills: args.fills ?? [] } : {}) }).id] };
        else if (args.action === 'ungroup') return { selection: ungroupShapes(page, roots) };
        else if (args.action === 'mask') {
            if (roots.length < 2) throw Error('Choose a mask and content');
            const maskId = args.maskId ?? roots[0]; if (!roots.includes(maskId)) throw Error('Mask must belong to the chosen layers');
            const group = groupShapes(page, roots, 'group', { isMaskGroup: true, maskId, maskType: args.mode ?? 'alpha' }); page.objects[maskId].isMask = true; return { selection: [group.id] };
        }
        else if (args.action === 'unmask') for (const id of roots) { const shape = page.objects[id]; if (shape.maskId && page.objects[shape.maskId]) delete page.objects[shape.maskId].isMask; delete shape.maskId; delete shape.isMaskGroup; delete shape.maskType; }
        else if (args.action === 'align') alignShapes(page, roots, args.alignment);
        else if (args.action === 'distribute') { if (roots.length < 2) throw Error('Choose at least two layers'); distributeShapes(page, roots, args.axis, args.gap); }
        else if (args.action === 'order') orderShapes(page, roots, args.mode);
        else if (args.action === 'flip') flipShapes(page, roots, args.axis === 'h' ? 'horizontal' : 'vertical');
        else if (args.action === 'translate') for (const id of roots) moveTree(page, id, args.dx, args.dy);
        else if (args.action === 'resize') for (const id of roots) { const shape = page.objects[id], width = args.width ?? (shape.constrainProportions && args.height !== undefined && shape.height ? shape.width * args.height / shape.height : shape.width), height = args.height ?? (shape.constrainProportions && args.width !== undefined && shape.width ? shape.height * args.width / shape.width : shape.height); resizeTree(page, id, { x: shape.x, y: shape.y, width, height }); }
        else if (args.action === 'rotate') rotateShapes(page, roots, args.angle, args.origin);
        else if (args.action === 'tidy') {
            const shapes = roots.map(id => page.objects[id]).sort((a, b) => a.y - b.y || a.x - b.x), box = unionBounds(shapes.map(shapeBounds)), columns = args.columns ?? Math.ceil(Math.sqrt(shapes.length)), gap = args.gap ?? 16, width = Math.max(...shapes.map(shape => shape.width)), height = Math.max(...shapes.map(shape => shape.height));
            shapes.forEach((shape, index) => moveTree(page, shape.id, box.x + index % columns * (width + gap) - shape.x, box.y + Math.floor(index / columns) * (height + gap) - shape.y));
        }
        else if (args.action === 'layout') {
            if (args.layout === null) for (const id of roots) delete page.objects[id].layout;
            else { const container = roots.length === 1 && page.objects[roots[0]].type === 'frame' ? page.objects[roots[0]] : groupShapes(page, roots, 'frame', { fills: [] }); container.layout = clone(args.layout); return { selection: [container.id] }; }
        }
        else throw Error('Unknown shape action');
        return { selection: roots };
    }
    if (name === 'edit_text') {
        requireEditable(editor, [args.id]); const shape = page.objects[args.id]; if (shape.type !== 'text') throw Error('Choose a text layer');
        const content = shape.content?.children ? clone(shape.content) : richText(textValue(shape));
        const fullText = textValue({ ...shape, content }), range = args.range ?? { start: 0, end: fullText.length };
        if (range.start > range.end || range.end > fullText.length) throw Error('Text range is outside the layer');
        validateTextStyleProperties(args.style ?? {});
        if (args.action === 'replace') shape.content = replaceText(content, range.start, range.end, args.text);
        else if (args.action === 'find_replace') {
            if (!args.find) throw Error('Find text must not be empty');
            const expression = new RegExp(args.find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), args.caseSensitive === false ? 'giu' : 'gu');
            const matches: number[] = [];
            for (const match of fullText.matchAll(expression)) {
                const index = match.index!;
                if (index < range.start || index + match[0].length > range.end) continue;
                if (args.wholeWord && (/[\p{L}\p{N}_]/u.test(fullText.slice(0, index).at(-1) ?? '') || /[\p{L}\p{N}_]/u.test(fullText[index + match[0].length] ?? ''))) continue;
                matches.push(index); if (args.all === false) break;
            }
            let result = content; for (const index of matches.reverse()) result = replaceText(result, index, index + args.find.length, args.replace); shape.content = result;
            return { selection: [shape.id], replacements: matches.length };
        }
        else if (args.action === 'range_style') {
            const paragraphKeys = new Set(['textAlign', 'lineHeight', 'paragraphSpacing', 'paragraphIndent', 'listType', 'listLevel', 'verticalAlign']);
            if (Object.keys(args.style).some(key => paragraphKeys.has(key))) throw Error('Use paragraph_style for paragraph formatting');
            let position = 0;
            for (const paragraph of content.children) {
                const next: Data[] = [];
                for (const run of paragraph.children) {
                    const end = position + run.text.length, a = Math.max(0, range.start - position), b = Math.min(run.text.length, range.end - position);
                    if (a < b) { if (a > 0) next.push({ ...run, text: run.text.slice(0, a) }); const styled = { ...run, ...clone(args.style), text: run.text.slice(a, b) }; for (const key of Object.keys(args.style)) if (args.style[key] === null) delete styled[key]; next.push(styled); if (b < run.text.length) next.push({ ...run, text: run.text.slice(b) }); } else next.push(run);
                    position = end;
                }
                paragraph.children = next; position++;
            }
            shape.content = content;
        }
        else if (args.action === 'paragraph_style') {
            const allowed = new Set(['textAlign', 'lineHeight', 'paragraphSpacing', 'paragraphIndent', 'listType', 'listLevel', 'verticalAlign']);
            if (Object.keys(args.style).some(key => !allowed.has(key))) throw Error('Use range_style for character formatting');
            let position = 0;
            for (const paragraph of content.children) { const end = position + paragraph.children.reduce((sum: number, run: Data) => sum + run.text.length, 0); if (range.end >= position && range.start <= end) Object.assign(paragraph, clone(args.style)); position = end + 1; }
            if (args.style.verticalAlign !== undefined) content.verticalAlign = args.style.verticalAlign;
            shape.content = content;
        }
        else throw Error('Unknown text action');
        return { selection: [shape.id] };
    }
    return undefined;
}
function replaceText(content: Data, start: number, end: number, replacement: string): Data {
    const chunks: Data[] = []; let offset = 0, inherited: Data = {}, paragraphStyle: Data = {};
    for (const [index, paragraph] of content.children.entries()) {
        const { children, ...style } = paragraph; paragraphStyle = style;
        for (const run of children) { const { text, ...format } = run; if (offset <= start) inherited = format; chunks.push({ start: offset, end: offset + text.length, text, format, paragraph: style }); offset += text.length; }
        if (index < content.children.length - 1) { chunks.push({ start: offset, end: offset + 1, text: '\n', format: inherited, paragraph: Object.fromEntries(Object.entries(content.children[index + 1]).filter(([key]) => key !== 'children')) }); offset++; }
    }
    const selected = chunks.find(chunk => chunk.start <= start && chunk.end >= start); if (selected) paragraphStyle = selected.paragraph;
    const tokens: Data[] = [
        ...chunks.filter(chunk => chunk.start < start).map(chunk => ({ ...chunk, text: chunk.text.slice(0, Math.min(chunk.text.length, start - chunk.start)) })),
        { text: replacement, format: inherited, paragraph: paragraphStyle },
        ...chunks.filter(chunk => chunk.end > end).map(chunk => ({ ...chunk, text: chunk.text.slice(Math.max(0, end - chunk.start)) })),
    ];
    const paragraphs: Data[] = [{ ...clone(content.children[0] ?? {}), children: [] }];
    for (const token of tokens) {
        const parts = token.text.split('\n');
        parts.forEach((text: string, index: number) => { if (index) paragraphs.push({ ...clone(token.paragraph), children: [] }); if (text) paragraphs.at(-1)!.children.push({ ...clone(token.format), text }); });
    }
    for (const paragraph of paragraphs) if (!paragraph.children.length) paragraph.children = [{ ...clone(inherited), text: '' }];
    return { ...content, children: paragraphs };
}

export function applyView(args: Data, editor: EditorStore): Data {
    if (args.action === 'select') editor.setSelection(args.ids);
    else if (args.action === 'tool') editor.setTool(args.tool);
    else if (args.action === 'fit') {
        const ids = args.ids?.length ? args.ids : editor.page.objects.root.childIds ?? [];
        if (ids.length) editor.setViewport(fitViewport(editor.viewport, unionBounds(ids.map((id: string) => shapeBounds(editor.page.objects[id])))));
    }
    else if (args.action === 'set') {
        if (args.viewport) editor.setViewport(clone(args.viewport));
        for (const [key, value] of Object.entries(args.flags ?? {})) editor[key] = value;
        editor.setViewport(editor.viewport);
    }
    else if (args.action !== 'get') throw Error('Unknown view action');
    return { viewport: editor.viewport, selection: [...editor.selection], tool: editor.tool, flags: Object.fromEntries(['showOutlines', 'uiHidden', 'pixelSnap', 'showRulers', 'showGrids', 'snapping', 'multiSelect'].map(key => [key, editor[key] ?? (key === 'snapping')])) };
}

const PROPERTY_KEYS = ['fills', 'strokes', 'strokeWidth', 'strokeAlignment', 'strokeCap', 'strokeJoin', 'strokeDashArray', 'strokeSides', 'opacity', 'blendMode', 'effects', 'shadows', 'blur', 'backgroundBlur', 'radii', 'radius', 'radiusTopLeft', 'radiusTopRight', 'radiusBottomLeft', 'radiusBottomRight', 'cornerSmoothing', 'smoothing', 'textStyleId', 'fillStyleId', 'strokeStyleId', 'effectStyleId', 'textBackground'];
export function clipboardPayload(args: Data, editor: EditorStore): Data {
    const ids = topLevelIds(editor.page, args.ids ?? []);
    if (!ids.length || ids.includes('root')) throw Error('Choose layers to copy');
    if (args.action === 'copy_properties') {
        const shape = editor.page.objects[ids[0]];
        const properties = Object.fromEntries(PROPERTY_KEYS.filter(key => key in shape).map(key => [key, clone(shape[key])]));
        if (shape.type === 'text') properties.textFormatting = clone(shape.content.children).map((paragraph: Data) => ({ ...Object.fromEntries(Object.entries(paragraph).filter(([key]) => Object.hasOwn(TEXT_STYLE_PROPERTIES.properties, key))), children: paragraph.children.map((run: Data) => Object.fromEntries(Object.entries(run).filter(([key]) => Object.hasOwn(TEXT_STYLE_PROPERTIES.properties, key)))) }));
        return { kind: 'oh-my-canvas/properties', version: 1, properties, ...dependencies(editor.doc, [properties as Shape]) };
    }
    return { kind: 'oh-my-canvas/shapes', version: 1, ...dependencies(editor.doc, ids.flatMap(id => descendants(editor.page, id, true))), roots: ids, shapes: ids.flatMap(id => descendants(editor.page, id, true)).map(clone), pageId: editor.pageId, origin: unionBounds(ids.map(id => shapeBounds(editor.page.objects[id]))) };
}
export function pasteProperties(payload: Data, ids: string[], editor: EditorStore): Data {
    if (payload?.kind !== 'oh-my-canvas/properties' || !payload.properties || typeof payload.properties !== 'object') throw Error('A copied properties payload is required');
    validateJson(payload);
    payload = prepareAssetTransfer(payload, editor.doc.assets);
    mergeTransferredAssets(editor.doc, payload);
    const value = clone(payload.properties);
    for (const key of Object.keys(value)) if (![...PROPERTY_KEYS, 'textFormatting'].includes(key)) throw Error(`Unsupported clipboard property: ${key}`);
    validateShapeProperties(Object.fromEntries(Object.entries(value).filter(([key]) => Object.hasOwn((SHAPE_PROPERTIES as Data).properties, key))));
    if (value.textFormatting !== undefined) {
        if (!Array.isArray(value.textFormatting) || !value.textFormatting.length || value.textFormatting.length > 10000) throw Error('Invalid copied text formatting');
        for (const paragraph of value.textFormatting) {
            const { children, ...style } = paragraph;
            validateTextStyleProperties(style);
            if (!Array.isArray(children) || !children.length || children.length > 10000) throw Error('Invalid copied text runs');
            for (const run of children) validateTextStyleProperties(run);
        }
    }
    for (const key of ['fillStyleId', 'strokeStyleId', 'textStyleId', 'effectStyleId']) if (value[key] && (!editor.doc.styles?.[value[key]] || JSON.stringify(editor.doc.styles[value[key]]) !== JSON.stringify(payload.styleDefinitions?.[value[key]]))) delete value[key];
    requireEditable(editor, ids);
    for (const id of ids) {
        const shape = editor.page.objects[id];
        for (const key of PROPERTY_KEYS) if (key in value) shape[key] = clone(value[key]);
        if (shape.type === 'text' && value.textFormatting?.length) shape.content.children = shape.content.children.map((paragraph: Data, i: number) => {
            const source = value.textFormatting[Math.min(i, value.textFormatting.length - 1)];
            return { ...paragraph, ...clone(source), children: paragraph.children.map((run: Data, j: number) => ({ ...run, ...clone(source.children[Math.min(j, source.children.length - 1)] ?? {}), text: run.text })) };
        });
    }
    return { selection: ids };
}
export function validateClipboardPayload(payload: Data): void {
    validateJson(payload);
    if (payload?.kind === 'text') { if (typeof payload.text !== 'string') throw Error('Clipboard text is required'); return; }
    if (payload?.kind !== 'oh-my-canvas/shapes' || !Array.isArray(payload.shapes) || !Array.isArray(payload.roots) || !payload.shapes.length || payload.shapes.length > 2000 || !payload.roots.length) throw Error('A bounded canvas shapes payload is required');
    const ids = new Set(payload.shapes.map((shape: Shape) => shape.id));
    if (ids.size !== payload.shapes.length || ids.has('root') || payload.roots.some((id: string) => !ids.has(id)) || new Set(payload.roots).size !== payload.roots.length) throw Error('Invalid clipboard layer IDs');
    for (const shape of payload.shapes) {
        if (typeof shape.id !== 'string' || !shape.id || ['__proto__', 'constructor', 'prototype'].includes(shape.id)) throw Error('Invalid clipboard layer ID');
        const properties = Object.fromEntries(Object.entries(shape).filter(([key]) => Object.hasOwn((SHAPE_PROPERTIES as Data).properties, key)));
        validateShapeProperties(properties);
    }
}

const COMPONENT_FIELDS = ['componentId', 'sourceId', 'isMain', 'isInstanceRoot', 'isVariantSet', 'variantSetId', 'variantProperties', 'overrides', 'componentPropertyRefs', 'componentProperties', 'componentSourceIds', 'componentOuterSourceId', 'componentRootId', 'componentRoot', 'sourceMap', 'instanceMap', 'propertyValues'];
export function prepareClipboardPayload(payload: Data, doc: CanvasDocument): Data {
    const prepared = prepareAssetTransfer(payload, doc.assets);
    if (prepared.kind !== 'oh-my-canvas/shapes') return prepared;
    const detached = prepared.shapes.some((shape: Shape) => shape.componentId && (!doc.components?.[shape.componentId] || JSON.stringify(doc.components[shape.componentId]) !== JSON.stringify(prepared.componentDefinitions?.[shape.componentId])));
    for (const shape of prepared.shapes) {
        if (detached) for (const key of COMPONENT_FIELDS) delete shape[key];
        const detachStyle = (record: Data) => {
            for (const key of ['fillStyleId', 'strokeStyleId', 'textStyleId', 'effectStyleId']) if (record[key] && (!doc.styles?.[record[key]] || JSON.stringify(doc.styles[record[key]]) !== JSON.stringify(prepared.styleDefinitions?.[record[key]]))) delete record[key];
            for (const child of record.children ?? []) detachStyle(child);
        };
        detachStyle(shape); if (shape.content && typeof shape.content === 'object') detachStyle(shape.content);
        if (shape.assetId && (!doc.assets?.[shape.assetId] || doc.assets[shape.assetId].src !== shape.image?.src)) delete shape.assetId;
    }
    return prepared;
}
export function selectionDocument(editor: EditorStore, ids: string[]): CanvasDocument {
    const roots = topLevelIds(editor.page, ids), objects: Record<string, Shape> = { root: createShape('frame', { id: 'root', parentId: 'root', enclosingFrameId: 'root', childIds: [], fills: [] }) };
    objects.root.childIds = roots;
    for (const id of roots) for (const shape of descendants(editor.page, id, true)) {
        const copied = clone(shape); if (roots.includes(copied.id)) copied.parentId = 'root';
        for (const key of COMPONENT_FIELDS) delete copied[key];
        stripStyleReferences(copied); objects[copied.id] = copied;
    }
    const page = { id: editor.page.id, name: editor.page.name, objects };
    return { pages: [page.id], pagesById: { [page.id]: page }, components: {}, libraries: {}, styles: {}, assets: dependencies(editor.doc, Object.values(objects)).assetDefinitions };
}

function stripStyleReferences(value: Data): void {
    for (const key of ['fillStyleId', 'strokeStyleId', 'textStyleId', 'effectStyleId']) delete value[key];
    for (const child of value.children ?? []) stripStyleReferences(child);
    if (value.content && typeof value.content === 'object' && !Array.isArray(value.content)) stripStyleReferences(value.content);
}
function dependencies(doc: CanvasDocument, shapes: Shape[]): Data {
    const componentIds = new Set<string>(), styleIds = new Set<string>(), assetIds = new Set<string>(), families = new Set<string>();
    const visit = (value: any, key = '') => {
        if (typeof value === 'string') {
            if (key === 'componentId') componentIds.add(value);
            if (key.endsWith('StyleId')) styleIds.add(value);
            if (key === 'assetId') assetIds.add(value);
            if (key === 'fontFamily') value.split(',').forEach((family: string) => families.add(family.trim().replace(/^['"]|['"]$/g, '')));
        } else if (value && typeof value === 'object') for (const [childKey, child] of Object.entries(value)) visit(child, childKey);
    };
    shapes.forEach(shape => visit(shape));
    const styles = Object.fromEntries([...styleIds].filter(id => doc.styles?.[id]).map(id => [id, clone(doc.styles![id])]));
    Object.values(styles).forEach(style => visit(style));
    const assets = { ...referencedAssets(shapes, doc.assets), ...Object.fromEntries(Object.entries<Data>(doc.assets ?? {}).filter(([id, asset]) => assetIds.has(id) || asset.kind === 'font' && families.has(asset.family)).map(([id, asset]) => [id, clone(asset)])) };
    return { componentDefinitions: Object.fromEntries([...componentIds].filter(id => doc.components?.[id]).map(id => [id, clone(doc.components![id])])), styleDefinitions: styles, assetDefinitions: assets };
}
