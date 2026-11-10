import type { CanvasDocument, Data, Shape, RenderView } from '../contracts';
import { applyLayout } from '../layout';
import { SceneWriter } from '../render';
import { shape, richText, textValue, uid } from './model';
import { parseMarkup, cssDeclarations, escapeAttr, escapeText, serializeNode, type MarkupNode } from './markup';
export interface ImportOptions extends Data {
    x?: number;
    y?: number;
    width?: number;
    height?: number;
    parentId?: string;
    id?: () => string;
}
export interface Imported {
    objects: Record<string, Shape>;
    rootIds: string[];
    shapes: Shape[];
    warnings: string[];
    width: number;
    height: number;
}
const number = (v: any, f = 0) => { const n = parseFloat(v); return Number.isFinite(n) ? n : f; };
const length = (v: string | undefined, base: number, f = 0) => v?.endsWith('%') ? number(v) * base / 100 : number(v, f);
const textTags = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'span', 'a', 'label', 'strong', 'b', 'em', 'i', 'u', 's', 'small', 'code', 'pre', 'li', 'blockquote']);
const inlineTags = new Set(['span', 'a', 'label', 'strong', 'b', 'em', 'i', 'u', 's', 'small', 'code', 'br']);
const inherited = ['color', 'font-family', 'font-size', 'font-weight', 'font-style', 'text-align', 'line-height', 'letter-spacing', 'text-decoration', 'text-transform', 'white-space'];
const supported = new Set(['display', 'position', 'left', 'top', 'width', 'height', 'min-width', 'min-height', 'max-width', 'max-height', 'box-sizing', 'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left', 'gap', 'row-gap', 'column-gap', 'flex-direction', 'flex-wrap', 'justify-content', 'align-items', 'justify-items', 'place-items', 'align-self', 'align-content', 'flex', 'flex-grow', 'flex-shrink', 'flex-basis', 'grid-template-columns', 'grid-template-rows', 'grid-column', 'grid-row', 'grid-column-start', 'grid-row-start', 'grid-column-end', 'grid-row-end', 'overflow', 'overflow-x', 'overflow-y', 'background', 'background-color', 'background-image', 'border', 'border-width', 'border-style', 'border-color', 'outline', 'outline-width', 'outline-style', 'outline-color', 'border-radius', 'border-top', 'border-right', 'border-bottom', 'border-left', 'opacity', 'box-shadow', 'filter', 'backdrop-filter', 'mix-blend-mode', 'transform', 'transform-origin', 'object-fit', 'object-position', 'visibility', 'vertical-align', 'text-overflow', '-webkit-line-clamp', ...inherited]);
function runStyle(css: Data, tag: string): Data { return { fontFamily: css['font-family']?.replace(/^['"]|['"]$/g, ''), fontSize: number(css['font-size'], 16), fontWeight: css['font-weight'] ?? (['b', 'strong'].includes(tag) ? 700 : 400), fontStyle: css['font-style'] ?? (['em', 'i'].includes(tag) ? 'italic' : 'normal'), textDecoration: css['text-decoration'] ?? (tag === 'u' ? 'underline' : tag === 's' ? 'line-through' : 'none'), textTransform: css['text-transform'], letterSpacing: number(css['letter-spacing']), fills: [{ color: css.color ?? '#000000' }] }; }
function splitSpace(value: string) { return value.trim().split(/\s+(?![^()]*\))/); }
export function gridTracks(value: string): Data[] {
    const expanded = value.replace(/repeat\(\s*(\d+)\s*,\s*([^()]+)\)/g, (_, count, track) => Array.from({ length: Math.min(256, Math.max(1, Number(count))) }, () => track.trim()).join(' '));
    return splitSpace(expanded).map(track => track === 'auto' || /fr$/.test(track) ? { type: 'auto' } : { type: 'fixed', size: number(track) });
}
function padding(css: Data, base: number) { const all = splitSpace(css.padding ?? '0').map(v => length(v, base)); return [css['padding-top'] !== undefined ? length(css['padding-top'], base) : all[0], css['padding-right'] !== undefined ? length(css['padding-right'], base) : all[1] ?? all[0], css['padding-bottom'] !== undefined ? length(css['padding-bottom'], base) : all[2] ?? all[0], css['padding-left'] !== undefined ? length(css['padding-left'], base) : all[3] ?? all[1] ?? all[0]]; }
export function paintFromCss(css: Data): Data {
    const out: Data = {}, background = css['background-color'] ?? css.background;
    if (background && background !== 'none' && background !== 'transparent') {
        const gradient = /^(linear|radial)-gradient\((.*)\)$/i.exec(background);
        if (gradient) {
            const parts = gradient[2].split(/,(?![^()]*\))/).map(v => v.trim());
            let angle = 180;
            if (/deg$/.test(parts[0]))
                angle = number(parts.shift());
            const stops = parts.map((v, i) => { const m = /^(.*?)(?:\s+([\d.]+)%)?$/.exec(v)!; return { color: m[1], offset: m[2] ? number(m[2]) / 100 : i / Math.max(1, parts.length - 1) }; });
            const r = angle * Math.PI / 180;
            out.fills = [{ gradient: { type: gradient[1].toLowerCase(), x1: .5 - Math.sin(r) / 2, y1: .5 + Math.cos(r) / 2, x2: .5 + Math.sin(r) / 2, y2: .5 - Math.cos(r) / 2, stops } }];
        }
        else
            out.fills = [{ color: background }];
    }
    const bgImage = /url\(\s*['"]?(.*?)['"]?\s*\)/i.exec(css['background-image'] ?? background ?? '');
    if (bgImage)
        out.fills = [{ image: { id: bgImage[1], scaleMode: 'fill' } }];
    const border = splitSpace(css.border ?? css.outline ?? '');
    const width = number(css['border-width'] ?? css['outline-width'] ?? border.find(v => /^\d/.test(v)), 0), color = css['border-color'] ?? css['outline-color'] ?? border.find(v => !/^\d/.test(v) && !['solid', 'dashed', 'dotted', 'none', ''].includes(v)) ?? '#000';
    if (width)
        out.strokes = [{ color, width, style: css['border-style'] ?? css['outline-style'] ?? border.find(v => ['solid', 'dashed', 'dotted'].includes(v)) ?? 'solid', align: 'inside' }];
    if (css['border-radius']) {
        const r = splitSpace(css['border-radius']).map(v => length(v, 100));
        out.radii = [r[0], r[1] ?? r[0], r[2] ?? r[0], r[3] ?? r[1] ?? r[0]];
    }
    const sideWidths: Data = {};
    for (const side of ['top', 'right', 'bottom', 'left'])
        if (css['border-' + side]) {
            const parts = splitSpace(css['border-' + side]);
            sideWidths[side] = number(parts[0]);
            if (!out.strokes)
                out.strokes = [{ width: number(parts[0]), style: parts[1] ?? 'solid', color: parts.slice(2).join(' ') || '#000', align: 'inside' }];
        }
    if (Object.keys(sideWidths).length)
        out.strokeSides = { top: 0, right: 0, bottom: 0, left: 0, ...sideWidths };
    if (css['mix-blend-mode'])
        out.blendMode = css['mix-blend-mode'];
    if (css.opacity !== undefined)
        out.opacity = number(css.opacity, 1);
    if (css['box-shadow'] && css['box-shadow'] !== 'none')
        out.effects = css['box-shadow'].split(/,(?![^()]*\))/).map((s: string) => { const parts = splitSpace(s), nums = parts.filter(v => /^-?[\d.]/.test(v)).map(v => number(v)); return { type: s.includes('inset') ? 'innerShadow' : 'dropShadow', color: parts.find(v => /^(#|rgb|hsl)/.test(v)) ?? '#0008', x: nums[0] ?? 0, y: nums[1] ?? 0, blur: nums[2] ?? 0, spread: nums[3] ?? 0 }; });
    const blur = /blur\(([^)]+)\)/.exec(css.filter ?? '');
    if (blur)
        (out.effects ??= []).push({ type: 'blur', radius: number(blur[1]) });
    const backdrop = /blur\(([^)]+)\)/.exec(css['backdrop-filter'] ?? '');
    if (backdrop)
        out.backgroundBlur = number(backdrop[1]);
    return out;
}
export function importHtml(html: string, options: ImportOptions = {}): Imported {
    const ast = parseMarkup(html), objects: Record<string, Shape> = {}, warnings: string[] = [], rootIds: string[] = [], makeId = options.id ?? uid, parentId = options.parentId ?? 'root', baseWidth = options.width ?? 1000;
    let cursorY = options.y ?? 0;
    const styles = (node: MarkupNode, parent: Data) => {
        const tagStyle: Data = {};
        if (['strong', 'b'].includes(node.tag))
            tagStyle['font-weight'] = '700';
        if (['em', 'i'].includes(node.tag))
            tagStyle['font-style'] = 'italic';
        if (node.tag === 'u')
            tagStyle['text-decoration'] = 'underline';
        if (['s', 'del'].includes(node.tag))
            tagStyle['text-decoration'] = 'line-through';
        const css = { ...Object.fromEntries(inherited.filter(k => parent[k] !== undefined).map(k => [k, parent[k]])), ...tagStyle, ...cssDeclarations(node.attrs.style ?? '') };
        if (css['place-items']) {
            const [align, justify = align] = splitSpace(css['place-items']);
            css['align-items'] ??= align;
            css['justify-items'] ??= justify;
        }
        if (css.display === 'inline-block')
            warnings.push('Unsupported CSS display: inline-block');
        for (const k of Object.keys(css))
            if (/var\(/.test(css[k])) {
                warnings.push(`Unsupported CSS variable in ${k}`);
                delete css[k];
            }
        for (const k of Object.keys(css))
            if (!supported.has(k))
                warnings.push(`Unsupported CSS property: ${k}`);
        return css;
    };
    function rich(node: MarkupNode, css: Data): Data {
        const paragraphs: Data[] = [{ textAlign: css['text-align'] ?? 'left', lineHeight: css['line-height'] ? number(css['line-height']) : undefined, children: [] }];
        const add = (n: MarkupNode, c: Data) => {
            if (n.tag === '#text') {
                const text = c['white-space'] === 'pre' || c['white-space'] === 'pre-wrap' ? n.text! : n.text!.replace(/\s+/g, ' ');
                paragraphs.at(-1)!.children.push({ text, ...runStyle(c, node.tag) });
                return;
            }
            if (n.tag === 'br') {
                paragraphs.push({ textAlign: css['text-align'] ?? 'left', children: [] });
                return;
            }
            const next = styles(n, c);
            for (const child of n.children)
                add(child, next);
        };
        for (const n of node.children)
            add(n, css);
        return { type: 'richText', verticalAlign: css['vertical-align'] ?? 'top', children: paragraphs };
    }
    function convert(node: MarkupNode, parent: string, x: number, y: number, width: number, height: number, parentCss: Data): string | null {
        if (node.tag === '#text') {
            if (!node.text?.trim())
                return null;
            node = { tag: 'span', attrs: {}, children: [node] };
        }
        if (['html', 'body'].includes(node.tag)) {
            const group = shape('frame', { id: makeId(), parentId: parent, enclosingFrameId: parent, name: node.tag, x, y, width, height: 0, childIds: [], layout: { type: 'flex', direction: 'column' }, heightSizing: 'hug' });
            objects[group.id] = group;
            for (const n of node.children) {
                const id = convert(n, group.id, x, y, width, height, parentCss);
                if (id)
                    group.childIds!.push(id);
            }
            return group.id;
        }
        const css = styles(node, parentCss);
        if (css.display === 'none')
            return null;
        let w = length(css.width, width, width), h = length(css.height, height, 0);
        const absolute = css.position === 'absolute' || css.position === 'fixed';
        x += length(css.left, width);
        y += length(css.top, height);
        const common: Data = { fills: [], strokes: [], ...paintFromCss(css), id: makeId(), parentId: parent, enclosingFrameId: parent, name: node.attrs['data-name'] ?? node.attrs['aria-label'] ?? node.tag, dataRef: node.attrs['data-ref'], x, y, width: w, height: h, hidden: css.visibility === 'hidden', absolute, alignSelf: css['align-self'], minWidth: length(css['min-width'], width), minHeight: length(css['min-height'], height), maxWidth: css['max-width'] ? length(css['max-width'], width) : undefined, maxHeight: css['max-height'] ? length(css['max-height'], height) : undefined, inlineStyles: css, htmlTag: node.tag, htmlAttrs: Object.fromEntries(Object.entries(node.attrs).filter(([k]) => k.startsWith('data-'))) };
        if (node.attrs['data-ref'])
            common['data-ref'] = node.attrs['data-ref'];
        const radius = css['border-radius'];
        let s: Shape;
        if (node.tag === 'img') {
            s = shape('image', { ...common, height: h || length(node.attrs.height, height, 100), width: css.width ? w : length(node.attrs.width, width, w), image: { src: node.attrs.src ?? '', width: w, height: h || 100 }, objectFit: css['object-fit'] ?? 'fill', alt: node.attrs.alt ?? '' });
        }
        else if (node.tag === 'svg') {
            const source = serializeNode({ ...node, attrs: { xmlns: 'http://www.w3.org/2000/svg', ...node.attrs } });
            s = shape('svg', { ...common, width: css.width ? w : length(node.attrs.width, width, w), height: h || length(node.attrs.height, height, 100), image: { src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(source)}`, mimeType: 'image/svg+xml', width: w, height: h || 100 }, svg: source, viewBox: node.attrs.viewbox });
        }
        else if (textTags.has(node.tag) || node.tag === 'br') {
            const content = node.tag === 'br' ? richText('') : rich(node, css), fontSize = number(css['font-size'], 16), lines = content.children.length;
            h = h || lines * fontSize * (number(css['line-height'], 1.2) > 4 ? number(css['line-height']) / fontSize : number(css['line-height'], 1.2));
            s = shape('text', { ...common, height: h, content, autoResize: css.height ? 'none' : 'height', lineBreak: 'word', maxLines: number(css['-webkit-line-clamp']) || undefined, truncate: css['text-overflow'] === 'ellipsis' });
        }
        else if (node.tag === 'hr') {
            s = shape('rect', { ...common, height: h || 1, fills: common.fills ?? [{ color: '#999' }] });
        }
        else {
            const p = padding(css, w), display = css.display ?? 'block', isGrid = display === 'grid' || display === 'inline-grid', direction = css['flex-direction'] ?? (display === 'flex' || display === 'inline-flex' ? 'row' : 'column');
            s = shape(radius === '50%' ? 'ellipse' : 'frame', { ...common, height: h, childIds: [], layout: { type: isGrid ? 'grid' : 'flex', direction, wrap: css['flex-wrap'] === 'wrap' || css['flex-wrap'] === 'wrap-reverse', padding: p, gap: { row: number(css['row-gap'], number(splitSpace(css.gap ?? '0')[0])), column: number(css['column-gap'], number(splitSpace(css.gap ?? '0')[1] ?? splitSpace(css.gap ?? '0')[0])) }, justifyContent: css['justify-content'] ?? 'start', alignItems: css['align-items'] ?? 'start', justifyItems: css['justify-items'], alignContent: css['align-content'], columns: css['grid-template-columns'] ? gridTracks(css['grid-template-columns']) : undefined, rows: css['grid-template-rows'] ? gridTracks(css['grid-template-rows']) : undefined }, clipContent: ['hidden', 'clip'].includes(css.overflow), heightSizing: css.height ? 'fixed' : 'hug', widthSizing: css.width === 'auto' ? 'hug' : 'fixed' });
            if (s.type === 'ellipse' && node.children.some(n => n.tag !== '#text' || n.text?.trim())) {
                s.type = 'frame';
                warnings.push('Percentage-radius container retained as an editable rounded frame');
            }
            objects[s.id] = s;
            const inlineOnly = node.children.length > 0 && node.children.every(n => n.tag === '#text' || inlineTags.has(n.tag));
            if (inlineOnly) {
                const intrinsic = ['flex', 'inline-flex', 'grid', 'inline-grid'].includes(display);
                const content = rich(node, css), fontSize = number(css['font-size'], 16), t = shape('text', { id: makeId(), parentId: s.id, enclosingFrameId: s.id, x: x + p[3], y: y + p[0], width: Math.max(0, w - p[1] - p[3]), height: content.children.length * fontSize * 1.2, content, maxWidth: intrinsic ? Math.max(0, w - p[1] - p[3]) : undefined, autoResize: intrinsic ? 'widthAndHeight' : 'height', widthSizing: intrinsic ? 'hug' : 'fill' });
                objects[t.id] = t;
                s.childIds = [t.id];
            }
            else
                for (const child of node.children) {
                    const id = convert(child, s.id, x + p[3], y + p[0], Math.max(0, w - p[1] - p[3]), h || height, css);
                    if (id)
                        s.childIds!.push(id);
                }
        }
        if (css.flex === '1' || number(css['flex-grow']) > 0)
            s.widthSizing = 'fill';
        if (css.width?.endsWith('%'))
            s.widthSizing = 'fixed';
        if (css.height?.endsWith('%'))
            s.heightSizing = 'fixed';
        if (css['grid-column'] || css['grid-row'] || css['grid-column-start'] || css['grid-row-start']) {
            const col = (css['grid-column'] ?? `${css['grid-column-start'] ?? 1}/${css['grid-column-end'] ?? ''}`).split('/').map((v: string) => v.trim()), row = (css['grid-row'] ?? `${css['grid-row-start'] ?? 1}/${css['grid-row-end'] ?? ''}`).split('/').map((v: string) => v.trim());
            s.gridCell = { column: number(col[0], 1), row: number(row[0], 1), columnSpan: /span/.test(col[1] ?? '') ? number(col[1].replace('span', ''), 1) : col[1] ? number(col[1]) - number(col[0], 1) : 1, rowSpan: /span/.test(row[1] ?? '') ? number(row[1].replace('span', ''), 1) : row[1] ? number(row[1]) - number(row[0], 1) : 1 };
        }
        if (css.transform) {
            const rotation = /rotate\(\s*([-\d.]+)deg\)/.exec(css.transform);
            if (rotation)
                s.rotation = number(rotation[1]);
            const translation = /translate(?:3d)?\(\s*([^,)]+)(?:,\s*([^,)]+))?/.exec(css.transform);
            if (translation) {
                s.x += length(translation[1], w);
                s.y += length(translation[2], h);
            }
            if (!rotation && !translation)
                warnings.push(`Unsupported CSS transform: ${css.transform}`);
        }
        if (s.widthSizing)
            s.hSizing = s.widthSizing;
        if (s.heightSizing)
            s.vSizing = s.heightSizing;
        if (s.type === 'ellipse')
            delete s.childIds;
        objects[s.id] = s;
        return s.id;
    }
    for (const node of ast.children) {
        const id = convert(node, parentId, options.x ?? 0, cursorY, baseWidth, options.height ?? 1000, {});
        if (id) {
            rootIds.push(id);
            cursorY += objects[id].height;
        }
    }
    // Layout is shared with the renderer/editor, including nested flex/grid/hug rules.
    const root = shape('frame', { id: 'root', parentId: 'root', x: options.x ?? 0, y: options.y ?? 0, width: baseWidth, height: options.height ?? 1000, childIds: rootIds, layout: { type: 'flex', direction: 'column' }, heightSizing: 'hug' });
    const doc = { pages: ['import'], pagesById: { import: { id: 'import', objects: { ...objects, [root.id]: root } } } };
    applyLayout(doc, undefined, options);
    return { objects, rootIds, shapes: Object.values(objects), warnings: [...new Set(warnings)], width: Math.max(0, ...rootIds.map(id => objects[id].x + objects[id].width - (options.x ?? 0))), height: root.height };
}
export function exportHtml(doc: CanvasDocument, pageId: string, ids: string[], options: {
    view?: RenderView;
    limit?: number;
    alias?: (id: string) => string;
} = {}): string {
    const objects = doc.pagesById[pageId]?.objects;
    if (!objects)
        throw new Error('Page not found');
    const view = options.view;
    function node(id: string, parent?: Shape): string {
        const s = objects[id];
        if (!s)
            throw new Error(`Layer not found: ${id}`);
        const style: Record<string, string> = { position: 'absolute', left: `${s.x - (parent?.x ?? 0)}px`, top: `${s.y - (parent?.y ?? 0)}px`, width: `${s.width}px`, height: `${s.height}px`, 'box-sizing': 'border-box' };
        if (s.hidden)
            style.display = 'none';
        if (s.opacity !== undefined)
            style.opacity = String(s.opacity);
        if (s.rotation)
            style.transform = `rotate(${s.rotation}deg)`;
        if (s.fills?.[0]?.color)
            style['background-color'] = s.fills[0].color;
        if (s.strokes?.[0])
            style.border = `${s.strokes[0].width ?? 1}px ${s.strokes[0].style ?? 'solid'} ${s.strokes[0].color ?? '#000'}`;
        if (s.radii)
            style['border-radius'] = (Array.isArray(s.radii) ? s.radii : [s.radii]).map((v: any) => `${v}px`).join(' ');
        if (s.type === 'ellipse')
            style['border-radius'] = '50%';
        if (s.clipContent)
            style.overflow = 'hidden';
        if (s.type === 'text') {
            delete style['background-color'];
            Object.assign(style, view?.computedStyle(id, ['font-family', 'font-size', 'font-weight', 'font-style', 'color', 'line-height', 'letter-spacing', 'text-align']) ?? {});
        }
        const complex = s.type === 'path' || s.type === 'boolean' || s.isMaskGroup || s.maskType;
        if (complex)
            for (const key of ['transform', 'opacity', 'background-color', 'border', 'border-radius'])
                delete style[key];
        const attrs = `${options.alias ? ` data-id="${escapeAttr(options.alias(id))}"` : ''} data-name="${escapeAttr(s.name ?? s.type)}"${s.dataRef || s['data-ref'] ? ` data-ref="${escapeAttr(s.dataRef ?? s['data-ref'])}"` : ''} style="${escapeAttr(Object.entries(style).map(([k, v]) => `${k}:${v}`).join(';'))}"`;
        if (complex) {
            const bounds = { x: s.x, y: s.y, width: s.width, height: s.height };
            const svg = view?.sceneSvg?.([id], { bounds }) ?? new SceneWriter(objects, { exporting: true }).svg([id], bounds);
            return `<div${attrs}>${svg.replace('<svg ', '<svg overflow="visible" ')}</div>`;
        }
        if (s.type === 'image')
            return `<img${attrs} src="${escapeAttr(s.image?.src ?? '')}" alt="${escapeAttr(s.alt ?? '')}">`;
        if (s.type === 'svg')
            return `<img${attrs} src="${escapeAttr(s.image?.src ?? '')}">`;
        if (s.type === 'text') {
            const content = s.content?.children;
            if (!content)
                return `<div${attrs}>${escapeText(textValue(s)).replace(/\n/g, '<br>')}</div>`;
            return `<div${attrs}>${content.map((p: Data) => `<span style="text-align:${escapeAttr(p.textAlign ?? 'left')}">${(p.children ?? []).map((r: Data) => { const rs: Data = { 'font-family': r.fontFamily, 'font-size': r.fontSize !== undefined ? `${r.fontSize}px` : undefined, 'font-weight': r.fontWeight, 'font-style': r.fontStyle, 'text-decoration': r.textDecoration, color: r.fills?.[0]?.color, 'letter-spacing': r.letterSpacing !== undefined ? `${r.letterSpacing}px` : undefined }; return `<span style="${escapeAttr(Object.entries(rs).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}:${v}`).join(';'))}">${escapeText(r.text)}</span>`; }).join('') || '<br>'}</span>`).join('<br>')}</div>`;
        }
        return `<div${attrs}>${(s.childIds ?? []).map(child => node(child, s)).join('')}</div>`;
    }
    const html = ids.map(id => node(id)).join('\n');
    if (html.length > (options.limit ?? 2000000))
        throw new Error('HTML response exceeds limit');
    return html;
}
export { cssDeclarations };
