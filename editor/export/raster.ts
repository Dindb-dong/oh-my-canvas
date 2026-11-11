import type { Rect } from '../contracts';
import { embedImageSource } from '../images/assets';
export async function inlineSVGImages(svg: string, options: { signal?: AbortSignal; maxBytes?: number } = {}): Promise<string> {
    options.signal?.throwIfAborted();
    const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
    if (doc.querySelector('parsererror'))
        throw new Error('Invalid generated SVG');
    const sources = new Map<string, Element[]>();
    for (const image of doc.querySelectorAll('image')) {
        const src = image.getAttribute('href') ?? image.getAttributeNS('http://www.w3.org/1999/xlink', 'href');
        if (!src || src.startsWith('data:'))
            continue;
        const images = sources.get(src) ?? []; images.push(image); sources.set(src, images);
    }
    const pending = [...sources], budget = { left: options.maxBytes ?? 256 * 1024 * 1024 }, abort = new AbortController();
    const signal = options.signal ? AbortSignal.any([options.signal, abort.signal]) : abort.signal;
    let cursor = 0;
    try {
        await Promise.all(Array.from({ length: Math.min(4, pending.length) }, async () => {
            while (cursor < pending.length) {
                signal.throwIfAborted();
                const [src, images] = pending[cursor++];
                const data = await embedImageSource(src, value => value, budget, signal);
                for (const image of images) {
                    image.setAttribute('href', data);
                    image.removeAttributeNS('http://www.w3.org/1999/xlink', 'href');
                }
            }
        }));
    } catch (error) { abort.abort(error); throw error; }
    return new XMLSerializer().serializeToString(doc.documentElement);
}
export async function rasterizeSVG(svg: string, bounds: Rect, scale = 1, type = 'image/png', quality = .92, background?: string): Promise<Blob> {
    if (!Number.isFinite(scale) || scale <= 0)
        throw new Error('Export scale must be positive');
    const width = Math.max(1, Math.round(bounds.width * scale)), height = Math.max(1, Math.round(bounds.height * scale));
    if (width * height > 268435456 || width > 32767 || height > 32767)
        throw new Error('Export dimensions exceed the browser canvas limit');
    const source = await inlineSVGImages(svg);
    const url = URL.createObjectURL(new Blob([source], { type: 'image/svg+xml' }));
    try {
        const image = new Image();
        await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('SVG rasterization timed out')), 20000);
            image.onload = () => {
                clearTimeout(timer);
                resolve();
            };
            image.onerror = () => {
                clearTimeout(timer);
                reject(new Error('SVG could not be decoded for export'));
            };
            image.src = url;
        });
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext('2d');
        if (!context)
            throw new Error('Canvas 2D is unavailable');
        if (background || type === 'image/jpeg') {
            context.fillStyle = background ?? '#ffffff';
            context.fillRect(0, 0, width, height);
        }
        context.drawImage(image, 0, 0, width, height);
        return await new Promise<Blob>((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('Image encoding failed')), type, quality));
    }
    finally {
        URL.revokeObjectURL(url);
    }
}
