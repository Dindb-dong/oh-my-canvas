import type { Data, Shape } from '../contracts';
import { cachedTextMetric, retainTextMetric, textMetricKey } from './metric-cache';
import { textHTML, num, type TextFragment } from './scene';
export interface TextSize {
    width: number;
    height: number;
    scrollWidth: number;
    scrollHeight: number;
}
export function measureTextScene(objects: Record<string, Shape>, measurements: HTMLElement, options: Data = {}) {
    const fragments = new Map<string, TextFragment[]>(), textSizes = new Map<string, TextSize>();
    measurements.replaceChildren();
    const canvas = document.createElement('canvas'), ctx = canvas.getContext('2d')!;
    for (const s of Object.values(objects)) {
        if (s.type !== 'text')
            continue;
        const html = textHTML(s, options), key = textMetricKey('scene', s.width, s.height, html);
        const cached = cachedTextMetric<{
            fragments: TextFragment[];
            size: TextSize;
        }>(key);
        if (cached) {
            fragments.set(s.id, cached.fragments.map(fragment => ({
                ...fragment, x: fragment.x + s.x, y: fragment.y + s.y, baseline: fragment.baseline + s.y, style: { ...fragment.style }
            })));
            textSizes.set(s.id, { ...cached.size });
            continue;
        }
        const box = document.createElement('div');
        Object.assign(box.style, { position: 'relative', width: `${s.width}px`, height: `${s.height}px` });
        box.innerHTML = html;
        measurements.append(box);
        const root = box.firstElementChild as HTMLElement;
        const origin = box.getBoundingClientRect();
        const list: TextFragment[] = [];
        for (const run of root.querySelectorAll<HTMLElement>('[data-run]')) {
            const style = getComputedStyle(run);
            const snapshot: Record<string, string> = {};
            for (const key of ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'letterSpacing', 'color', 'textDecorationLine', 'textDecorationStyle', 'backgroundColor', 'textTransform', 'fontVariantCaps', 'textDecorationThickness', 'fontVariationSettings', 'lineHeight'])
                snapshot[key] = style[key as keyof CSSStyleDeclaration] as string;
            if (run.dataset.paints)
                snapshot.paints = run.dataset.paints;
            ctx.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
            const metrics = ctx.measureText('Hg');
            const ascent = metrics.fontBoundingBoxAscent ?? parseFloat(style.fontSize) * .8;
            const paragraph = Number(run.closest('[data-paragraph]')?.getAttribute('data-paragraph') ?? 0);
            const walker = document.createTreeWalker(run, NodeFilter.SHOW_TEXT);
            let text: Node | null;
            while ((text = walker.nextNode())) {
                const value = text.textContent ?? '';
                const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
                for (const chunk of segmenter.segment(value)) {
                    const range = document.createRange();
                    range.setStart(text, chunk.index);
                    range.setEnd(text, chunk.index + chunk.segment.length);
                    const rect = range.getBoundingClientRect();
                    if (!rect.height)
                        continue;
                    let rendered = chunk.segment;
                    if (style.textTransform === 'uppercase')
                        rendered = rendered.toLocaleUpperCase();
                    if (style.textTransform === 'lowercase')
                        rendered = rendered.toLocaleLowerCase();
                    if (style.textTransform === 'capitalize' && (chunk.index === 0 || /\s/u.test(value[chunk.index - 1])))
                        rendered = rendered.toLocaleUpperCase();
                    const x = s.x + rect.x - origin.x, y = s.y + rect.y - origin.y;
                    const previous = list.at(-1);
                    if (previous && previous.paragraph === paragraph && previous.style === snapshot && Math.abs(previous.y - y) < .25 && Math.abs(previous.x + previous.width - x) < .5) {
                        previous.text += rendered;
                        previous.width = rect.right - origin.x + s.x - previous.x;
                    }
                    else
                        list.push({
                            text: rendered, x, y, width: rect.width, height: rect.height, baseline: y + ascent, style: snapshot, paragraph
                        });
                }
            }
        }
        const maxLines = num(s.maxLines, Infinity);
        if (s.truncate || Number.isFinite(maxLines)) {
            const ys = [...new Set(list.map(f => Math.round(f.y * 10) / 10))].sort((a, b) => a - b);
            const accepted = new Set(ys.slice(0, maxLines));
            for (let i = list.length - 1; i >= 0; i--)
                if (!accepted.has(Math.round(list[i].y * 10) / 10) || list[i].y + list[i].height > s.y + s.height + .5)
                    list.splice(i, 1);
            if (s.truncate && list.length) {
                const last = list.at(-1)!;
                const overflow = root.scrollHeight > root.clientHeight + .5 || ys.length > maxLines;
                if (overflow) {
                    ctx.font = `${last.style.fontStyle} ${last.style.fontWeight} ${last.style.fontSize} ${last.style.fontFamily}`;
                    while (last.text && last.x + ctx.measureText(last.text + '…').width > s.x + s.width)
                        last.text = last.text.slice(0, -1);
                    last.text += '…';
                    last.width = ctx.measureText(last.text).width;
                }
            }
        }
        fragments.set(s.id, list);
        const paragraphBox = root.querySelector<HTMLElement>('[data-paragraphs]')!;
        const size = { width: root.getBoundingClientRect().width, height: root.getBoundingClientRect().height, scrollWidth: Math.max(root.scrollWidth, paragraphBox.scrollWidth), scrollHeight: Math.max(root.scrollHeight, paragraphBox.scrollHeight) };
        textSizes.set(s.id, size);
        retainTextMetric(key, { fragments: list.map(fragment => ({
                ...fragment, x: fragment.x - s.x, y: fragment.y - s.y, baseline: fragment.baseline - s.y, style: { ...fragment.style }
            })), size: { ...size } });
    }
    return { fragments, textSizes };
}
