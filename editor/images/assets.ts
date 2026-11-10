import type {Data} from '../contracts';
export function imageSource(image: Data | undefined, assets: Data = {}): string {
    return image?.src ?? image?.url ?? (image?.assetId ? assets[image.assetId]?.src : image?.id) ?? '';
}
export function referencedAssets(value: unknown, assets: Data = {}): Data {
    const result: Data = {}, seen = new Set<object>();
    const visit = (value: any) => {
        if (!value || typeof value !== 'object' || seen.has(value)) return;
        seen.add(value);
        if (typeof value.assetId === 'string' && !value.type && !value.src && assets[value.assetId]) result[value.assetId] = assets[value.assetId];
        for (const child of Object.values(value)) visit(child);
    };
    visit(value); return result;
}

export function detachImageAsset(value: any, id: string, src: string): void {
    if (!value || typeof value !== 'object') return;
    if (value.assetId === id && !value.type && !value.src) {value.src=src;delete value.assetId;}
    for (const child of Object.values(value)) detachImageAsset(child,id,src);
}
