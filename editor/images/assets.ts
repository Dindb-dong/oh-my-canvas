import type {CanvasDocument, Data} from '../contracts';
const external = /^omc-asset:sha256:([a-f0-9]{64})$/;
// Editor asset maps are immutable projections. Portable exports supply a new map.
const embeddedByHash = new WeakMap<Data, Map<string, string>>();
export const isExternalImageSource = (value: unknown): value is string => typeof value === 'string' && external.test(value);
export function assertPortableImages(value: unknown): void {
    const stack = [value], seen = new Set<object>();
    while (stack.length) {
        const record = stack.pop();
        if (!record || typeof record !== 'object' || seen.has(record)) continue;
        seen.add(record);
        for (const [key, child] of Object.entries(record)) {
            if (['src', 'url', 'id'].includes(key) && typeof child === 'string' && (child.startsWith('omc://') || isExternalImageSource(child))) throw Error('Resolve image assets with portableDocument before exporting');
            if (child && typeof child === 'object') stack.push(child);
        }
    }
}
export function imageSource(image: Data | undefined, assets: Data = {}): string {
    const source = image?.src ?? image?.url ?? (image?.assetId ? assets[image.assetId]?.src : image?.id) ?? '';
    if (isExternalImageSource(source)) {
        let embedded = embeddedByHash.get(assets);
        if (!embedded) {
            embedded = new Map();
            for (const [id, asset] of Object.entries<Data>(assets)) if (asset.src?.startsWith('data:')) {
                if (asset.hash) embedded.set(asset.hash, asset.src);
                if (/^[a-f0-9]{64}$/.test(id)) embedded.set(id, asset.src);
            }
            embeddedByHash.set(assets, embedded);
        }
        return embedded.get(external.exec(source)![1]) ?? source;
    }
    return source;
}
export function referencedAssets(value: unknown, assets: Data = {}): Data {
    const result: Data = {}, seen = new Set<object>(), hashes = new Map<string, string[]>();
    for (const [id, asset] of Object.entries<Data>(assets)) {
        const hash = external.exec(asset.src ?? '')?.[1] ?? asset.hash;
        if (hash) hashes.set(hash, [...hashes.get(hash) ?? [], id]);
    }
    const visit = (value: any) => {
        if (isExternalImageSource(value)) {
            const hash = external.exec(value)![1];
            for (const id of hashes.get(hash) ?? (assets[hash] ? [hash] : [])) result[id] = assets[id];
            return;
        }
        if (!value || typeof value !== 'object' || seen.has(value)) return;
        seen.add(value);
        if (typeof value.assetId === 'string' && assets[value.assetId]) result[value.assetId] = assets[value.assetId];
        for (const child of Object.values(value)) visit(child);
    };
    visit(value); return result;
}

/** One clipboard contract. Older UI payloads named this map `assets`. */
export function clipboardAssetDefinitions(payload: Data): Data {
    const definitions: Data = {};
    for (const source of [payload.assets, payload.assetDefinitions]) {
        if (source === undefined) continue;
        if (!source || typeof source !== 'object' || Array.isArray(source) || Object.keys(source).length > 10000) throw Error('Invalid clipboard asset definitions');
        for (const [id, asset] of Object.entries<Data>(source)) {
            if (!id || ['__proto__', 'prototype', 'constructor'].includes(id) || !asset || typeof asset !== 'object' || Array.isArray(asset) || typeof asset.src !== 'string') throw Error('Invalid clipboard asset definition');
            if (definitions[id] && JSON.stringify(definitions[id]) !== JSON.stringify(asset)) throw Error('Conflicting clipboard asset definitions');
            definitions[id] = asset;
        }
    }
    return definitions;
}

/** Remap collisions before insertion; never replace a destination image behind existing layers. */
export function prepareAssetTransfer(payload: Data, destination: Data = {}): Data {
    const prepared = structuredClone(payload), definitions = clipboardAssetDefinitions(prepared), incoming: Data = {}, mapping = new Map<string, string>();
    const identity = (asset: Data) => JSON.stringify([asset.kind, asset.src, ...asset.kind === 'font' ? ['family', 'weight', 'style', 'unicodeRange'].map(key => asset[key]) : []]);
    const existingSources = new Map(Object.entries<Data>(destination).map(([id, asset]) => [identity(asset), id]));
    for (const [id, asset] of Object.entries<Data>(definitions)) {
        const key = identity(asset), match = existingSources.get(key);
        let target = match ?? id;
        if (!match && (Object.hasOwn(destination, target) || Object.hasOwn(incoming, target))) do { target = `asset-${crypto.randomUUID()}`; } while (Object.hasOwn(destination, target) || Object.hasOwn(incoming, target));
        mapping.set(id, target);
        if (!Object.hasOwn(destination, target) || destination[target].deleted) incoming[target] = { ...asset, id: target, deleted: false };
        existingSources.set(key, target);
    }
    const remap = (value: any) => {
        if (!value || typeof value !== 'object') return;
        if (typeof value.assetId === 'string' && mapping.has(value.assetId)) value.assetId = mapping.get(value.assetId);
        if (typeof value.assetId === 'string' && !value.src && !value.url && !value.id && !Object.hasOwn(destination, value.assetId) && !Object.hasOwn(incoming, value.assetId)) throw Error(`Missing clipboard image asset: ${value.assetId}`);
        for (const [key, child] of Object.entries(value)) if (key !== 'assets' && key !== 'assetDefinitions') remap(child);
    };
    remap(prepared);
    prepared.assetDefinitions = incoming;
    delete prepared.assets;
    return prepared;
}

export function mergeTransferredAssets(doc: CanvasDocument, prepared: Data): void {
    const assets = clipboardAssetDefinitions(prepared);
    if (Object.keys(assets).length) Object.assign(doc.assets ??= {}, structuredClone(assets));
}

export async function embedImageSource(source: string, resolve: (source: string) => string, budget: { left: number }, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    const url = resolve(source);
    if (url.startsWith('data:')) {
        const comma = url.indexOf(','), content = url.slice(comma + 1);
        budget.left -= url.slice(0, comma).endsWith(';base64') ? Math.floor(content.length * 3 / 4) - (content.match(/=+$/)?.[0].length ?? 0) : new TextEncoder().encode(decodeURIComponent(content)).byteLength;
        if (budget.left < 0) throw Error('Image export exceeds the byte limit');
        return url;
    }
    if (isExternalImageSource(url)) throw Error('Image bytes are unavailable; open the document in its original workspace before exporting');
    const response = await fetch(url, { signal });
    if (!response.ok) throw Error(`Image export failed: ${response.status}`);
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > budget.left) { await response.body?.cancel(); throw Error('Image export exceeds the byte limit'); }
    const parts: Uint8Array[] = [];
    if (response.body) {
        const reader = response.body.getReader();
        try { for (;;) { signal?.throwIfAborted(); const part = await reader.read(); if (part.done) break; budget.left -= part.value.byteLength; if (budget.left < 0) throw Error('Image export exceeds the byte limit'); parts.push(part.value); } }
        catch (error) { await reader.cancel().catch(() => {}); throw error; }
        finally { reader.releaseLock(); }
    } else { const bytes = new Uint8Array(await response.arrayBuffer()); budget.left -= bytes.byteLength; if (budget.left < 0) throw Error('Image export exceeds the byte limit'); parts.push(bytes); }
    const type = response.headers.get('content-type')?.split(';')[0] || 'application/octet-stream';
    return new Promise<string>((resolve, reject) => {
        const reader = new FileReader(), aborted = () => reader.abort();
        signal?.addEventListener('abort', aborted, { once: true });
        reader.onloadend = () => signal?.removeEventListener('abort', aborted);
        reader.onabort = () => reject(signal?.reason ?? Error('Image export was cancelled'));
        reader.onerror = () => reject(reader.error); reader.onload = () => { try { signal?.throwIfAborted(); resolve(String(reader.result)); } catch (error) { reject(error); } };
        reader.readAsDataURL(new Blob(parts as BlobPart[], { type }));
    });
}

/** Explicit portable exports hydrate each immutable bitmap once in the asset map. */
export async function portableDocument<T extends CanvasDocument>(document: T, resolve: (source: string) => string = source => source, options: { signal?: AbortSignal; maxBytes?: number } = {}): Promise<T> {
    options.signal?.throwIfAborted();
    const result = structuredClone(document) as T & { assets: Data }, assets = result.assets ??= {}, sources = new Map<string, Promise<string>>(), sourceIds = new Map<string, string>(), budget = { left: options.maxBytes ?? 256 * 1024 * 1024 };
    const hydrate = (source: string) => { let task = sources.get(source); if (!task) { task = embedImageSource(source, resolve, budget, options.signal); sources.set(source, task); } return task; };
    for (const [id, asset] of Object.entries<Data>(assets)) if (isExternalImageSource(asset.src)) { sourceIds.set(asset.src, id); asset.hash ??= external.exec(asset.src)![1]; asset.src = await hydrate(asset.src); }
    const visit = async (value: any, insideAssets = false): Promise<void> => {
        if (!value || typeof value !== 'object') return;
        for (const [key, child] of Object.entries(value)) {
            if (isExternalImageSource(child)) {
                const hash = external.exec(child)![1];
                if (!insideAssets && ['src', 'url'].includes(key) && !value.kind && !value.type) {
                    let id = sourceIds.get(child) ?? Object.keys(assets).find(id => assets[id].hash === hash);
                    if (!id) { id = hash; if (assets[id]) id = `asset-${crypto.randomUUID()}`; assets[id] = { id, kind: 'image', name: hash, hash, src: await hydrate(child) }; sourceIds.set(child, id); }
                    value.assetId = id; delete value[key];
                } else value[key] = await hydrate(child);
            } else await visit(child, insideAssets || key === 'assets');
        }
    };
    await visit(result);
    options.signal?.throwIfAborted();
    return result;
}

export async function portableClipboard(payload: Data, resolve?: (source: string) => string, options: { signal?: AbortSignal; maxBytes?: number } = {}): Promise<Data> {
    const result = structuredClone(payload), definitions = clipboardAssetDefinitions(result);
    delete result.assets; delete result.assetDefinitions;
    const document = await portableDocument({ pages: [], pagesById: {}, assets: definitions, payload: result }, resolve, options);
    return { ...document.payload, assetDefinitions: document.assets };
}

export function detachImageAsset(value: any, id: string, src: string): void {
    if (!value || typeof value !== 'object') return;
    if (value.assetId === id && !value.type && !value.src) {value.src=src;delete value.assetId;}
    for (const child of Object.values(value)) detachImageAsset(child,id,src);
}
