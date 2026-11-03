import type { Data, EditorStore, ExportService, Rect, RenderView } from '../contracts';
import { boundsOf } from '../render/scene';
import { inlineSVGImages, rasterizeSVG } from './raster';
export function createExporter(editor: EditorStore, view: RenderView, options: Data = {}): ExportService {
    const idsFor = (ids: string[]) => ids.length ? ids : editor.page.objects.root?.childIds ?? [];
    async function svg(ids: string[], settings: Data = {}) {
        await view.settled();
        if (typeof view.sceneSvg !== 'function')
            throw new Error('Renderer SVG service is unavailable');
        const chosen = idsFor(ids);
        for (const id of chosen)
            if (!editor.page.objects[id])
                throw new Error(`Unknown layer: ${id}`);
        let source = view.sceneSvg(chosen, settings);
        const css = await options.fonts?.embeddedCss?.();
        if (css)
            source = source.replace('<defs>', '<defs><style>' + css.replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</style>');
        return inlineSVGImages(source);
    }
    async function raster(id: string, settings: Data = {}) {
        const shape = editor.page.objects[id];
        if (!shape)
            throw new Error(`Unknown layer: ${id}`);
        await view.settled();
        const bounds: Rect = settings.bounds ?? view.bounds?.([id]) ?? boundsOf([shape]);
        const constraint = settings.constraint;
        const scale = constraint?.type === 'width' ? constraint.value / bounds.width : constraint?.type === 'height' ? constraint.value / bounds.height : constraint?.type === 'scale' ? constraint.value : settings.scale ?? 1;
        const format = String(settings.type ?? settings.format ?? 'image/png').toLowerCase();
        const type = format.includes('/') ? format : format === 'jpg' ? 'image/jpeg' : `image/${format}`;
        if (!['image/png', 'image/jpeg', 'image/webp'].includes(type))
            throw new Error(`Unsupported raster type: ${type}`);
        const source = await svg([id], { bounds, omitFill: settings.omitFill });
        return rasterizeSVG(source, bounds, scale, type, settings.quality ?? .92, settings.background);
    }
    async function pdf(id: string, settings: Data = {}) {
        const shape = editor.page.objects[id];
        if (!shape)
            throw new Error(`Unknown layer: ${id}`);
        await view.settled();
        const bounds = settings.bounds ?? view.bounds?.([id]) ?? boundsOf([shape]);
        const image = await raster(id, { bounds, type: 'image/jpeg', background: settings.background ?? '#fff' });
        const bitmap = await createImageBitmap(image);
        try {
            return jpegPDF(new Uint8Array(await image.arrayBuffer()), bitmap.width, bitmap.height, bounds.width, bounds.height);
        }
        finally {
            bitmap.close();
        }
    }
    return {
        svg, async png(id, scale = 1, bounds) {
            const blob = await raster(id, { scale, bounds, type: 'image/png' });
            return new Uint8Array(await blob.arrayBuffer());
        }, raster, pdf, async saveFile(blob: Blob, name: string) {
            const save = options.exportFile ?? options.saveFile;
            if (save)
                return await save(blob, name);
            if ('showSaveFilePicker' in window) {
                try {
                    const handle = await (window as any).showSaveFilePicker({ suggestedName: name });
                    const writable = await handle.createWritable();
                    await writable.write(blob);
                    await writable.close();
                    return { saved: true };
                }
                catch (error) {
                    if (error instanceof DOMException && error.name === 'AbortError')
                        return { canceled: true };
                    throw error;
                }
            }
            const url = URL.createObjectURL(blob);
            try {
                const a = document.createElement('a');
                a.href = url;
                a.download = name;
                a.click();
                return { downloaded: true };
            }
            finally {
                setTimeout(() => URL.revokeObjectURL(url), 1000);
            }
        }, async layer(id: string, settings: Data = {}) {
            const format = settings.format ?? 'png';
            if (format === 'svg')
                return new Blob([await svg([id], settings)], { type: 'image/svg+xml' });
            if (format === 'pdf')
                return pdf(id, settings);
            return raster(id, settings);
        }
    };
}
function jpegPDF(image: Uint8Array, pixelWidth: number, pixelHeight: number, width: number, height: number): Blob {
    const encoder = new TextEncoder(), parts: Uint8Array[] = [], offsets = [0];
    let position = 0;
    const push = (s: string | Uint8Array) => {
        const bytes = typeof s === 'string' ? encoder.encode(s) : s;
        parts.push(bytes);
        position += bytes.length;
    };
    push('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
    const object = (id: number, body: string) => {
        offsets[id] = position;
        push(`${id} 0 obj\n${body}\nendobj\n`);
    };
    object(1, '<< /Type /Catalog /Pages 2 0 R >>');
    object(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
    object(3, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`);
    offsets[4] = position;
    push(`4 0 obj\n<< /Type /XObject /Subtype /Image /Width ${pixelWidth} /Height ${pixelHeight} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${image.length} >>\nstream\n`);
    push(image);
    push('\nendstream\nendobj\n');
    const commands = `q\n${width} 0 0 ${height} 0 0 cm\n/Im0 Do\nQ\n`;
    object(5, `<< /Length ${encoder.encode(commands).length} >>\nstream\n${commands}endstream`);
    const xref = position;
    push(`xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(offset => String(offset).padStart(10, '0') + ' 00000 n \n').join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
    return new Blob(parts as BlobPart[], { type: 'application/pdf' });
}
