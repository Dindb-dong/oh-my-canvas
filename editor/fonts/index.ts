import { invalidateTextMetrics, textMetricRevision } from '../render/metric-cache';
import type { Data, FontCatalog, FontFaceInput } from '../contracts';
interface CatalogRecord {
    input: FontFaceInput;
    permanent: boolean;
    face: FontFace;
    promise?: Promise<FontFace>;
    error?: string;
    embedded?: Promise<string>;
    ranges?: Array<[
        number,
        number
    ]>;
}
export function createFontCatalog(initial: FontFaceInput[] = [], options: Data = {}): FontCatalog {
    const records: CatalogRecord[] = [];
    let destroyed = false;
    const prepared = new Map<string, FontFace>();
    const signature = (input: FontFaceInput) => JSON.stringify(input);
    function assetInputs(assets: Data): FontFaceInput[] {
        return Object.values<Data>(assets ?? {}).filter(asset => asset.kind === 'font' && asset.src && asset.family).map(asset => ({
            family: asset.family, url: asset.src, ...(asset.weight !== undefined ? { weight: asset.weight } : {}), ...(asset.style ? { style: asset.style } : {}), ...(asset.unicodeRange ? { unicodeRange: asset.unicodeRange } : {})
        }));
    }
    function makeFace(input: FontFaceInput) {
        return new FontFace(input.family, `url(${JSON.stringify(input.url)})`, { weight: String(input.weight ?? '100 900'), style: input.style ?? 'normal', ...(input.unicodeRange ? { unicodeRange: input.unicodeRange } : {}) });
    }
    function add(inputs: FontFaceInput[], permanent = true) {
        if (destroyed)
            throw new Error('Font catalog is destroyed');
        let added = false;
        for (const input of inputs) {
            const existing = records.find(record => signature(record.input) === signature(input));
            if (existing) {
                if (permanent)
                    existing.permanent = true;
                continue;
            }
            const face = prepared.get(signature(input)) ?? makeFace(input);
            document.fonts.add(face);
            added = true;
            records.push({ input: { ...input }, permanent, face, ranges: parseRanges(input.unicodeRange) });
        }
        if (added)
            invalidateTextMetrics();
    }
    add(initial);
    function syncAssets(assets: Data) {
        if (destroyed)
            throw new Error('Font catalog is destroyed');
        const inputs = assetInputs(assets), desired = new Set(inputs.map(signature));
        let removed = false;
        for (let index = records.length - 1; index >= 0; index--) {
            const record = records[index];
            if (!record.permanent && !desired.has(signature(record.input))) {
                document.fonts.delete(record.face);
                records.splice(index, 1);
                removed = true;
            }
        }
        if (removed)
            invalidateTextMetrics();
        add(inputs, false);
        prepared.clear();
    }
    async function prepareAssets(assets: Data) {
        if (destroyed)
            throw new Error('Font catalog is destroyed');
        const staged: Array<{
            key: string;
            face: FontFace;
        }> = [];
        const release = () => {
            let removed = false;
            for (const { key, face } of staged) {
                if (prepared.get(key) === face)
                    prepared.delete(key);
                if (!records.some(record => record.face === face)) {
                    document.fonts.delete(face);
                    removed = true;
                }
            }
            if (removed)
                invalidateTextMetrics();
        };
        const results = await Promise.allSettled(assetInputs(assets).map(async (input) => {
            const key = signature(input);
            if (records.some(record => signature(record.input) === key))
                return;
            const face = prepared.get(key) ?? makeFace(input);
            prepared.set(key, face);
            staged.push({ key, face });
            await face.load();
            if (destroyed)
                throw new Error('Font catalog was destroyed while loading assets');
            document.fonts.add(face);
        }));
        const errors = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected').map(result => result.reason);
        if (errors.length) {
            release();
            throw new AggregateError(errors, 'Font asset preparation failed');
        }
        if (staged.length)
            invalidateTextMetrics();
        return release;
    }
    async function ensure(text: string, family?: string) {
        const revision = textMetricRevision();
        let newlyLoaded = false;
        const codes = [...new Set([...text].map(character => character.codePointAt(0)!))].sort((a, b) => a - b);
        await Promise.all(records.filter(record => (!family || record.input.family === family) && matchesRange(codes, record.ranges)).map(async (record) => {
            try {
                const wasLoaded = record.face.status === 'loaded';
                record.promise ??= record.face.load();
                await record.promise;
                if (!wasLoaded && record.face.status === 'loaded')
                    newlyLoaded = true;
            }
            catch (error) {
                record.error = String(error);
            }
        }));
        if (!destroyed)
            await document.fonts.ready;
        if (newlyLoaded && textMetricRevision() === revision)
            invalidateTextMetrics();
    }
    async function embeddedCss() {
        const styles = await Promise.all(records.filter(record => record.face.status === 'loaded').map(async (record) => {
            record.embedded ??= fetch(record.input.url).then(async (response) => {
                if (!response.ok)
                    throw new Error(`Could not embed font ${record.input.family}: ${response.status}`);
                return blobDataURL(await response.blob());
            });
            const source = await record.embedded, input = record.input;
            return `@font-face{font-family:${JSON.stringify(input.family)};src:url(${JSON.stringify(source)});font-weight:${input.weight ?? '100 900'};font-style:${input.style ?? 'normal'};${input.unicodeRange ? `unicode-range:${input.unicodeRange};` : ''}}`;
        }));
        return styles.join('\n');
    }
    return {
        catalog() {
            const groups = new Map<string, Data>();
            for (const record of records) {
                let group = groups.get(record.input.family);
                if (!group) {
                    group = { family: record.input.family, label: record.input.label, faces: [] };
                    groups.set(record.input.family, group);
                }
                const descriptor = String(record.input.weight ?? 400), range = descriptor.split(/\s+/).map(Number);
                const weights = range.length === 2 ? Array.from({ length: Math.max(1, Math.floor((range[1] - range[0]) / 100) + 1) }, (_, index) => range[0] + index * 100) : [Number.isFinite(Number(descriptor)) ? Number(descriptor) : descriptor === 'bold' ? 700 : 400];
                for (const weight of weights) {
                    const style = record.input.style ?? 'normal', existing = group.faces.find((face: Data) => face.weight === weight && face.style === style);
                    if (existing) {
                        if (record.face.status === 'loaded')
                            existing.status = 'loaded';
                        if (record.error)
                            existing.errors = [...(existing.errors ?? []), record.error];
                    }
                    else
                        group.faces.push({ weight, style, status: record.face.status, ...(record.error ? { errors: [record.error] } : {}) });
                }
            }
            return [...groups.values()];
        },
        sources() { return records.map(record => ({ ...record.input })); },
        add, ensure, embeddedCss, syncAssets, prepareAssets,
        async ready() {
            await ensure(options.sampleText ?? 'Aa한글😀');
        },
        destroy() {
            destroyed = true;
            for (const record of records)
                document.fonts.delete(record.face);
            records.length = 0;
            prepared.clear();
            invalidateTextMetrics();
        }
    };
}
function parseRanges(specification?: string): Array<[
    number,
    number
]> | undefined {
    if (!specification)
        return undefined;
    return specification.split(',').map(part => {
        const value = part.trim().replace(/^U\+/i, '');
        const [start, end] = value.includes('?') ? [value.replace(/\?/g, '0'), value.replace(/\?/g, 'F')] : value.split('-');
        return [parseInt(start, 16), parseInt(end ?? start, 16)] as [
            number,
            number
        ];
    });
}
/** Query each compiled interval against unique sorted characters, never reparsing per glyph. */
function matchesRange(codes: number[], ranges?: Array<[
    number,
    number
]>): boolean {
    if (!ranges)
        return true;
    return ranges.some(([start, end]) => {
        let low = 0, high = codes.length;
        while (low < high) {
            const middle = (low + high) >>> 1;
            if (codes[middle] < start)
                low = middle + 1;
            else
                high = middle;
        }
        return low < codes.length && codes[low] <= end;
    });
}
function blobDataURL(blob: Blob) {
    return new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob);
    });
}
