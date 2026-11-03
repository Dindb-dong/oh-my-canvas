/** Bounded native typography measurements shared by layout, screen and source thumbnails. */
interface Entry {
    value: unknown;
    bytes: number;
}
interface State {
    revision: number;
    entries: Map<string, Entry>;
    bytes: number;
    hits: number;
    misses: number;
}
const documents = new WeakMap<Document, State>();
const MAX_ENTRIES = 4096;
const MAX_BYTES = 8 * 1024 * 1024;
function state(): State {
    let current = documents.get(document);
    if (current)
        return current;
    current = {
        revision: 0, entries: new Map(), bytes: 0, hits: 0, misses: 0
    };
    documents.set(document, current);
    const invalidate = () => {
        current!.revision++;
        current!.entries.clear();
        current!.bytes = 0;
    };
    document.fonts.addEventListener('loadingdone', invalidate);
    document.fonts.addEventListener('loadingerror', invalidate);
    return current;
}
export function textMetricRevision(): number {
    return state().revision;
}
export function invalidateTextMetrics(): void {
    const current = state();
    current.revision++;
    current.entries.clear();
    current.bytes = 0;
}
export function nativeTextCacheDiagnostics() {
    const current = state();
    return {
        revision: current.revision, entries: current.entries.size, bytes: current.bytes, hits: current.hits, misses: current.misses
    };
}
export function textMetricKey(kind: string, width: number, height: number, html: string): string {
    // The diagnostic layer ID cannot influence glyph metrics or line wrapping.
    return `${state().revision}:${kind}:${width}:${height}:${html.replace(/ data-text="[^"]*"/, '')}`;
}
export function cachedTextMetric<T>(key: string): T | undefined {
    const current = state(), entry = current.entries.get(key);
    if (!entry) {
        current.misses++;
        return undefined;
    }
    current.hits++;
    current.entries.delete(key);
    current.entries.set(key, entry);
    return entry.value as T;
}
export function retainTextMetric(key: string, value: unknown): void {
    const current = state(), bytes = key.length * 2 + JSON.stringify(value).length * 2;
    if (bytes > MAX_BYTES)
        return;
    const old = current.entries.get(key);
    if (old) {
        current.bytes -= old.bytes;
        current.entries.delete(key);
    }
    current.entries.set(key, { value, bytes });
    current.bytes += bytes;
    while (current.entries.size > MAX_ENTRIES || current.bytes > MAX_BYTES) {
        const oldest = current.entries.keys().next().value!;
        current.bytes -= current.entries.get(oldest)!.bytes;
        current.entries.delete(oldest);
    }
}
