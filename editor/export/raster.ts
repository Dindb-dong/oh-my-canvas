import type { Rect } from '../contracts';
export async function inlineSVGImages(svg: string): Promise<string> {
    const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
    if (doc.querySelector('parsererror'))
        throw new Error('Invalid generated SVG');
    await Promise.all([...doc.querySelectorAll('image')].map(async (image) => {
        const src = image.getAttribute('href') ?? image.getAttributeNS('http://www.w3.org/1999/xlink', 'href');
        if (!src || src.startsWith('data:'))
            return;
        const response = await fetch(src);
        if (!response.ok)
            throw new Error(`Image export failed: ${response.status}`);
        const blob = await response.blob();
        const data = await new Promise<string>((resolve, reject) => {
            const r = new FileReader();
            r.onerror = () => reject(r.error);
            r.onload = () => resolve(String(r.result));
            r.readAsDataURL(blob);
        });
        image.setAttribute('href', data);
        image.removeAttributeNS('http://www.w3.org/1999/xlink', 'href');
    }));
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
