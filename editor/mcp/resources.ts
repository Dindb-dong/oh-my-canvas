import type { CanvasDocument, Data, EditorStore } from '../contracts';
import { createAssetService, createLibraryService } from '../assets';
import { createStyleService } from '../styles';
import { isEditable, newId, validateDocument } from '../document';
import { validateVisualProperties } from './properties';

const copy = <T>(value: T): T => structuredClone(value);
const resourceNames = new Set(['styles', 'libraries', 'document_assets']);
const reads: Record<string, string[]> = { styles: ['list', 'get', 'users'], libraries: ['list', 'get', 'export'], document_assets: ['list'] };
const own = (record: Data | undefined, id: string) => record && Object.hasOwn(record, id) ? record[id] : undefined;

function json(value: unknown, depth = 0, budget = { nodes: 0 }): void {
    if (++budget.nodes > 100000 || depth > 40)
        throw Error('Resource data exceeds the complexity limit');
    if (value === null || typeof value === 'string' || typeof value === 'boolean')
        return;
    if (typeof value === 'number' && Number.isFinite(value))
        return;
    if (!value || typeof value !== 'object' || ![Object.prototype, Array.prototype, null].includes(Object.getPrototypeOf(value)))
        throw Error('Resources must contain finite JSON values');
    for (const [key, child] of Object.entries(value)) {
        if (['__proto__', 'prototype', 'constructor'].includes(key))
            throw Error('Unsafe resource key');
        if (['src', 'url'].includes(key) && typeof child === 'string' && !child.startsWith('data:'))
            throw Error('Resource sources must be embedded data URLs');
        json(child, depth + 1, budget);
    }
}
function payload(value: unknown): void {
    json(value);
    if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 16 * 1024 * 1024)
        throw Error('Resource payload exceeds 16 MiB');
}
function required(value: unknown, label: string): string {
    if (typeof value !== 'string' || !value.trim() || value.length > 240)
        throw Error(`${label} must contain 1–240 characters`);
    return value;
}
function identifier(value: unknown, label: string): string {
    const result = required(value, label);
    if (['__proto__', 'constructor', 'prototype'].includes(result))
        throw Error(`Invalid ${label}`);
    return result;
}
function draftEditor(doc: CanvasDocument, pageId: string): EditorStore {
    return { doc, pageId, get page() { return doc.pagesById[pageId]; }, selection: [], transact<T>(_operation: unknown, mutate: (draft: CanvasDocument) => T) { return mutate(doc); } } as unknown as EditorStore;
}
function targets(doc: CanvasDocument, pageId: string, ids: unknown): string[] {
    const page = doc.pagesById[pageId];
    if (!page || !Array.isArray(ids) || !ids.length || ids.length > 200 || new Set(ids).size !== ids.length || ids.some(id => typeof id !== 'string' || !isEditable(page, id)))
        throw Error('Choose 1–200 distinct editable layers on the current page');
    return ids;
}
function parent(doc: CanvasDocument, pageId: string, parentId = 'root'): void {
    const page = doc.pagesById[pageId], shape = page?.objects[parentId];
    if (!shape?.childIds || (parentId !== 'root' && !isEditable(page, parentId)))
        throw Error('Destination must be an editable container');
}
function metadata(asset: Data): Data {
    const { src, ...result } = asset;
    return { ...copy(result), embedded: typeof src === 'string' && src.startsWith('data:') };
}
function styleValue(style: Data): unknown {
    return style.value ?? (style.type === 'paint' ? style.paints : style.type === 'text' ? style.text : style.effects);
}
function validateStyleValue(type: string, value: any): void {
    payload(value);
    if (type === 'paint') {
        if (!Array.isArray(value) || value.some(paint => !paint || typeof paint !== 'object' || Array.isArray(paint)))
            throw Error('Paint styles require an array of paint records');
    }
    else if (!['text', 'effect'].includes(type) || !value || typeof value !== 'object' || Array.isArray(value))
        throw Error('Text and effect styles require an object');
    validateVisualProperties(type === 'paint' ? { fills: value } : value);
    for (const key of ['fontSize', 'fontWeight', 'letterSpacing', 'paragraphSpacing', 'paragraphIndent', 'blur', 'backgroundBlur'])
        if (value[key] !== undefined && (typeof value[key] !== 'number' || !Number.isFinite(value[key]) || Math.abs(value[key]) > 1e9))
            throw Error(`Invalid style ${key}`);
}
function assetInputs(args: Data): Data[] {
    const kind = args.kind ?? 'image', faces = args.faces;
    if (!['image', 'svg', 'font'].includes(kind))
        throw Error('Unknown asset kind');
    if (faces !== undefined && (kind !== 'font' || !Array.isArray(faces) || !faces.length || faces.length > 100))
        throw Error('Font faces must contain 1–100 records');
    return (faces ?? [args]).map((face: Data, index: number) => {
        const src = face.dataUrl ?? face.url ?? args.dataUrl;
        const match = typeof src === 'string' && /^data:([^;,]+);base64,([A-Za-z0-9+/]*={0,2})$/.exec(src);
        if (!match || !match[2] || match[2].length % 4 !== 0)
            throw Error('Assets require a nonempty base64 data URL');
        const mimeType = match[1].toLowerCase();
        if (kind === 'font' ? !/^(font\/(woff2?|ttf|otf)|application\/(font-woff|x-font-ttf|x-font-opentype|octet-stream))$/.test(mimeType) : !/^image\/(png|jpe?g|webp|gif|avif|bmp|x-icon|vnd\.microsoft\.icon|svg\+xml)$/.test(mimeType))
            throw Error('Asset MIME type does not match its kind');
        if (kind === 'svg' && mimeType !== 'image/svg+xml')
            throw Error('SVG assets require an SVG MIME type');
        for (const field of ['width', 'height'])
            if (args[field] !== undefined && (!Number.isFinite(args[field]) || args[field] <= 0 || args[field] > 100000))
                throw Error('Asset dimensions must be positive and at most 100000');
        const asset: Data = { id: faces ? args.assetIds?.[index] ?? newId('asset') : args.id ?? newId('asset'), name: required(face.name ?? args.name ?? face.family, 'Asset name'), kind: mimeType === 'image/svg+xml' ? 'svg' : kind, src, mimeType, ...args.width !== undefined ? { width: args.width } : {}, ...args.height !== undefined ? { height: args.height } : {} };
        identifier(asset.id, 'Asset ID');
        if (kind === 'font') {
            asset.family = required(face.family ?? args.family, 'Font family');
            const weight = face.weight ?? args.weight;
            if (weight !== undefined) {
                if (!(typeof weight === 'number' && Number.isFinite(weight) && weight >= 1 && weight <= 1000) && !(typeof weight === 'string' && /^(normal|bold|[1-9]\d{0,2}(?:\s+[1-9]\d{0,2})?|1000)$/.test(weight)))
                    throw Error('Invalid font weight');
                asset.weight = weight;
            }
            const style = face.style ?? args.fontStyle;
            if (style !== undefined) {
                if (!['normal', 'italic', 'oblique'].includes(style))
                    throw Error('Invalid font style');
                asset.style = style;
            }
            const unicodeRange = face.unicodeRange ?? args.unicodeRange;
            if (unicodeRange !== undefined) {
                if (typeof unicodeRange !== 'string' || !/^U\+[0-9A-F?]{1,6}(?:-[0-9A-F]{1,6})?(?:\s*,\s*U\+[0-9A-F?]{1,6}(?:-[0-9A-F]{1,6})?)*$/i.test(unicodeRange))
                    throw Error('Invalid font Unicode range');
                asset.unicodeRange = unicodeRange;
            }
        }
        return asset;
    });
}

export function isResourceRead(name: string, args: Data): boolean {
    return resourceNames.has(name) && reads[name].includes(args.action);
}

export function readResourceOperation(name: string, args: Data, doc: CanvasDocument, pageId: string, _services: Data = {}): Data {
    const editor = draftEditor(doc, pageId);
    if (name === 'styles') {
        const service = createStyleService(editor);
        if (args.action === 'list')
            return { styles: service.list(args.query ?? '') };
        const style = own(doc.styles, required(args.id, 'Style ID'));
        if (!style)
            throw Error('Unknown style');
        if (args.action === 'users')
            return { users: service.users(args.id) };
        if (args.action === 'get')
            return { style: copy(style) };
    }
    if (name === 'libraries') {
        if (args.action === 'list')
            return { libraries: Object.values(doc.libraries ?? {}).map(library => ({ id: library.id, name: library.name, version: library.version, enabled: library.enabled, components: Object.keys(library.components ?? {}).length, styles: Object.keys(library.styles ?? {}).length })) };
        const library = own(doc.libraries, required(args.id, 'Library ID'));
        if (!library)
            throw Error('Unknown library');
        if (args.action === 'get' || args.action === 'export')
            return { library: copy(library), ...args.action === 'export' ? { snapshot: copy(library) } : {} };
    }
    if (name === 'document_assets' && args.action === 'list')
        return { assets: Object.values<Data>(doc.assets ?? {}).filter(asset => (!args.kind || asset.kind === args.kind) && `${asset.name ?? ''} ${asset.family ?? ''}`.toLowerCase().includes((args.query ?? '').toLowerCase())).map(metadata) };
    throw Error(`Unknown resource read: ${name}/${args.action}`);
}

export function applyResourceOperation(name: string, args: Data, doc: CanvasDocument, pageId: string, _services: Data = {}): Data {
    const editor = draftEditor(doc, pageId);
    if (name === 'styles') {
        const service = createStyleService(editor);
        if (args.action === 'create') {
            validateStyleValue(args.type, args.value);
            return { style: service.create(args.type, required(args.name, 'Style name'), args.value, args.description ?? '') };
        }
        if (args.action === 'detach') {
            const ids = targets(doc, pageId, args.ids);
            return createStyleService(draftEditor({ ...doc, pages: [pageId], pagesById: { [pageId]: doc.pagesById[pageId] } }, pageId)).detach(ids, args.kind);
        }
        const style = own(doc.styles, required(args.id, 'Style ID'));
        if (!style)
            throw Error('Unknown style');
        if (args.action === 'update') {
            const patch = args.patch ?? {};
            if (!patch || typeof patch !== 'object' || Array.isArray(patch) || Object.keys(patch).some(key => !['name', 'description', 'value', 'paints', 'text', 'effects'].includes(key)))
                throw Error('Style patches support name, description and value fields');
            payload(patch);
            validateStyleValue(style.type, patch.value ?? patch[style.type === 'paint' ? 'paints' : style.type === 'text' ? 'text' : 'effects'] ?? styleValue(style));
            return { style: service.update(args.id, patch) };
        }
        if (args.action === 'duplicate')
            return { style: service.create(style.type, args.name ?? `${style.name} copy`, styleValue(style), style.description ?? '') };
        if (args.action === 'delete')
            return { removed: service.remove(args.id) };
        if (args.action === 'apply') {
            const ids = targets(doc, pageId, args.ids);
            return createStyleService(draftEditor({ ...doc, pages: [pageId], pagesById: { [pageId]: doc.pagesById[pageId] } }, pageId)).apply(args.id, ids, args.kind);
        }
    }
    if (name === 'libraries') {
        const service = createLibraryService(editor);
        if (args.action === 'add' || args.action === 'update') {
            payload(args.snapshot);
            identifier(args.snapshot?.id, 'Library ID');
            for (const style of Object.values<Data>(args.snapshot?.styles ?? {}))
                validateStyleValue(style.type, styleValue(style));
            for (const shape of Object.values<Data>(args.snapshot?.objects ?? {}))
                validateVisualProperties(shape);
            if (args.action === 'add' && doc.pagesById[`library-page:${args.snapshot?.id}`])
                throw Error('Library page already exists; update the linked snapshot instead');
            if (args.action === 'add' && [ ...Object.keys(args.snapshot.components ?? {}).map(id => own(doc.components, `library:${args.snapshot.id}:${id}`)), ...Object.keys(args.snapshot.styles ?? {}).map(id => own(doc.styles, `library:${args.snapshot.id}:${id}`)) ].some(Boolean))
                throw Error('Library source IDs conflict with local resources');
            const library = args.action === 'add' ? service.add(args.snapshot) : service.update(required(args.id, 'Library ID'), args.snapshot);
            validateDocument(doc);
            return { library: { id: library.id, name: library.name, version: library.version, enabled: library.enabled } };
        }
        required(args.id, 'Library ID');
        if (args.action === 'enable') {
            if (typeof args.enabled !== 'boolean')
                throw Error('Library enabled must be boolean');
            const library = service.enable(args.id, args.enabled);
            return { library: { id: library.id, name: library.name, version: library.version, enabled: library.enabled } };
        }
        if (args.action === 'remove')
            return { removed: service.remove(args.id) };
        if (args.action === 'insert') {
            parent(doc, pageId, args.parentId);
            return service.insert(args.id, required(args.componentId, 'Library component ID'), { parentId: args.parentId ?? 'root', pageId, ...args.x !== undefined ? { x: args.x, y: args.y } : {} });
        }
    }
    if (name === 'document_assets') {
        const service = createAssetService(editor);
        if (args.action === 'add') {
            const inputs = assetInputs(args);
            for (const input of inputs) {
                payload(input);
                if (own(doc.assets, input.id))
                    throw Error('Asset ID already exists');
            }
            const assets = inputs.map(input => service.addFile(input));
            return { asset: metadata(assets[0]), assets: assets.map(metadata) };
        }
        required(args.id, 'Asset ID');
        if (args.action === 'remove')
            return { removed: service.remove(args.id) };
        if (args.action === 'place') {
            parent(doc, pageId, args.parentId);
            const asset = own(doc.assets, args.id);
            if (!asset)
                throw Error('Unknown asset');
            if (!asset.src?.startsWith('data:'))
                throw Error('Only embedded assets can be placed through MCP');
            return service.place(args.id, { pageId, parentId: args.parentId ?? 'root', x: args.x ?? 0, y: args.y ?? 0, width: args.width, height: args.height });
        }
    }
    throw Error(`Unknown resource operation: ${name}/${args.action}`);
}

export async function prepareResourceOperation(name: string, args: Data, doc: CanvasDocument, pageId: string, services: Data, signal?: AbortSignal): Promise<{ args: Data; release?: () => void }> {
    if (name === 'clipboard' && ['paste', 'paste_properties'].includes(args.action) && args.payload?.assetDefinitions) {
        const definitions = args.payload.assetDefinitions;
        if (!definitions || typeof definitions !== 'object' || Array.isArray(definitions) || Object.keys(definitions).length > 100)
            throw Error('Clipboard font definitions must contain at most 100 records');
        const preparedAssets: Data = {};
        for (const source of Object.values<Data>(definitions)) {
            if (source?.kind !== 'font') continue;
            const [asset] = assetInputs({ kind: 'font', id: source.id, name: source.name, family: source.family, dataUrl: source.src, weight: source.weight, fontStyle: source.style, unicodeRange: source.unicodeRange });
            payload(asset);
            const existing = Object.values<Data>({ ...doc.assets, ...preparedAssets }).find(candidate => candidate.kind === 'font' && candidate.src === asset.src && candidate.family === asset.family && candidate.weight === asset.weight && candidate.style === asset.style && candidate.unicodeRange === asset.unicodeRange);
            if (existing) continue;
            if (own(doc.assets, asset.id) || own(preparedAssets, asset.id)) asset.id = newId('asset');
            preparedAssets[asset.id] = asset;
        }
        if (!Object.keys(preparedAssets).length) return { args };
        if (!services.fonts?.prepareAssets) throw Error('Font preparation service is unavailable');
        const release = await services.fonts.prepareAssets({ ...doc.assets, ...preparedAssets });
        if (signal?.aborted) { release?.(); signal.throwIfAborted(); }
        return { args: { ...args, preparedAssets }, release };
    }
    if (name !== 'document_assets' || args.action !== 'add')
        return { args };
    const inputs = assetInputs(args);
    args = { ...args, ...args.faces ? { assetIds: inputs.map(input => input.id) } : { id: inputs[0].id } };
    const trial = copy(doc);
    applyResourceOperation(name, args, trial, pageId, services);
    if (inputs[0].kind === 'font') {
        if (!services.fonts?.prepareAssets)
            throw Error('Font preparation service is unavailable');
        const release = await services.fonts.prepareAssets(trial.assets);
        if (signal?.aborted) {
            release?.();
            signal.throwIfAborted();
        }
        return { args, release };
    }
    if (typeof Image !== 'undefined') {
        const image = new Image();
        image.src = inputs[0].src;
        await image.decode();
        if (!image.naturalWidth || !image.naturalHeight)
            throw Error('Image asset has no pixels');
        args = { ...args, width: args.width ?? image.naturalWidth, height: args.height ?? image.naturalHeight };
    }
    return { args };
}
