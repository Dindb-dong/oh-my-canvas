import type { Data, Page, Shape } from '../contracts';
import { moveTree, resizeTree } from '../document';
import { boxGeometry } from '../geometry';
import { paintFromCss, gridTracks } from '../formats/html';
import { cssDeclarations } from '../formats/markup';
const px = (value: string) => {
    const n = parseFloat(value);
    if (!Number.isFinite(n))
        throw new Error(`Invalid numeric CSS value: ${value}`);
    return n;
};
const runProperties: Record<string, string> = { 'font-family': 'fontFamily', 'font-size': 'fontSize', 'font-weight': 'fontWeight', 'font-style': 'fontStyle', 'letter-spacing': 'letterSpacing', 'text-decoration': 'textDecoration', 'text-transform': 'textTransform' };
export function applyStyles(page: Page, s: Shape, input: Record<string, string>): string[] {
    const ignored: string[] = [], styles: Data = s.inlineStyles ??= {};
    for (const [raw, value] of Object.entries(input)) {
        const key = raw.toLowerCase();
        if (key !== raw || !/^--[\w-]+$|^[a-z]+(?:-[a-z]+)*$/.test(key))
            throw new Error('Styles require kebab-case CSS keys');
        if (value === '')
            delete styles[key];
        else
            styles[key] = value;
        if (value !== '') {
            const parsed = cssDeclarations(`${key}:${value}`);
            if (Object.keys(parsed).some(property => property !== key))
                throw new Error('A CSS value cannot inject additional declarations');
        }
        const remove = value === '';
        if (/var\(/.test(value)) {
            ignored.push(key);
            continue;
        }
        if (['width', 'height', 'left', 'top', 'min-width', 'min-height', 'max-width', 'max-height', 'opacity', 'border-radius', 'gap', 'row-gap', 'column-gap', 'padding', 'font-size', 'letter-spacing'].includes(key) && !remove && !['auto', 'fit-content', 'min-content', 'max-content'].includes(value) && !value.endsWith('%'))
            px(value);
        if (key === 'width' || key === 'height') {
            const mode = key + 'Sizing';
            if (remove || value === 'auto' || value === 'fit-content')
                s[mode] = 'hug';
            else if (value.endsWith('%')) {
                s[mode] = 'fixed';
                const parent = page.objects[s.parentId];
                const size = px(value) / 100 * (key === 'width' ? parent.width : parent.height);
                resizeTree(page, s.id, { x: s.x, y: s.y, width: key === 'width' ? size : s.width, height: key === 'height' ? size : s.height });
            }
            else {
                s[mode] = 'fixed';
                resizeTree(page, s.id, { x: s.x, y: s.y, width: key === 'width' ? Math.max(0, px(value)) : s.width, height: key === 'height' ? Math.max(0, px(value)) : s.height });
            }
        }
        else if (key === 'left' || key === 'top') {
            const n = (key === 'left' ? page.objects[s.parentId]?.x ?? 0 : page.objects[s.parentId]?.y ?? 0) + (remove ? 0 : px(value) * (value.endsWith('%') ? (key === 'left' ? page.objects[s.parentId].width : page.objects[s.parentId].height) / 100 : 1));
            moveTree(page, s.id, key === 'left' ? n - s.x : 0, key === 'top' ? n - s.y : 0);
        }
        else if (['background', 'background-color', 'background-image'].includes(key)) {
            const paint = paintFromCss(styles);
            s.fills = paint.fills ?? [];
        }
        else if (key === 'opacity') {
            if (remove)
                delete s.opacity;
            else
                s.opacity = Math.max(0, Math.min(1, px(value)));
        }
        else if (key === 'display') {
            s.hidden = !remove && value === 'none';
            if (!remove && ['flex', 'grid'].includes(value))
                s.layout = { ...s.layout, type: value };
            else if (remove && s.layout)
                delete s.layout;
        }
        else if (key === 'visibility')
            s.hidden = !remove && value === 'hidden';
        else if (key === 'position')
            s.absolute = !remove && ['absolute', 'fixed'].includes(value);
        else if (key === 'overflow')
            s.clipContent = !remove && ['hidden', 'clip'].includes(value);
        else if (key === 'border-radius') {
            if (remove)
                delete s.radii;
            else if (value === '50%' && s.type === 'rect')
                s.type = 'ellipse';
            else {
                const r = value.split(/\s+/).map(px);
                s.radii = [r[0], r[1] ?? r[0], r[2] ?? r[0], r[3] ?? r[1] ?? r[0]];
            }
        }
        else if (key === 'box-shadow' || key === 'filter' || key === 'backdrop-filter' || key === 'mix-blend-mode' || key.startsWith('outline') || /^border-(top|right|bottom|left)$/.test(key)) {
            const paint = paintFromCss(styles);
            if (key === 'box-shadow' || key === 'filter')
                s.effects = paint.effects ?? [];
            else if (key === 'backdrop-filter') {
                if (remove)
                    delete s.backgroundBlur;
                else
                    s.backgroundBlur = paint.backgroundBlur;
            }
            else if (key === 'mix-blend-mode') {
                if (remove)
                    delete s.blendMode;
                else
                    s.blendMode = value;
            }
            else {
                s.strokes = paint.strokes ?? [];
                s.strokeSides = paint.strokeSides;
            }
        }
        else if (key === 'border' || key === 'border-width' || key === 'border-color' || key === 'border-style') {
            if (remove) {
                if (key === 'border')
                    s.strokes = [];
                else if (s.strokes?.[0])
                    delete s.strokes[0][key === 'border-width' ? 'width' : key === 'border-color' ? 'color' : 'style'];
            }
            else {
                const stroke = s.strokes?.[0] ?? { color: '#000', width: 1 };
                if (key === 'border') {
                    const bits = value.split(/\s+/);
                    stroke.width = px(bits[0]);
                    stroke.style = bits[1] ?? 'solid';
                    stroke.color = bits.slice(2).join(' ') || '#000';
                }
                else
                    stroke[key === 'border-width' ? 'width' : key === 'border-color' ? 'color' : 'style'] = key === 'border-width' ? px(value) : value;
                s.strokes = [stroke, ...s.strokes?.slice(1) ?? []];
            }
        }
        else if (key in runProperties || key === 'color' || key === 'text-align' || key === 'line-height') {
            if (s.type !== 'text') {
                ignored.push(key);
                continue;
            }
            for (const p of s.content?.children ?? []) {
                if (key === 'text-align') {
                    if (remove)
                        delete p.textAlign;
                    else
                        p.textAlign = value;
                }
                else if (key === 'line-height') {
                    if (remove)
                        delete p.lineHeight;
                    else
                        p.lineHeight = px(value);
                }
                else
                    for (const r of p.children ?? []) {
                        if (key === 'color')
                            r.fills = remove ? [] : [{ color: value }];
                        else {
                            const prop = runProperties[key];
                            if (remove)
                                delete r[prop];
                            else
                                r[prop] = ['font-size', 'letter-spacing'].includes(key) ? px(value) : value;
                        }
                    }
            }
        }
        else if (['flex-direction', 'flex-wrap', 'justify-content', 'align-items', 'align-content', 'gap', 'row-gap', 'column-gap', 'padding', 'grid-template-columns', 'grid-template-rows'].includes(key)) {
            s.layout ??= { type: 'flex', direction: 'row' };
            const map: Data = { 'flex-direction': 'direction', 'flex-wrap': 'wrap', 'justify-content': 'justifyContent', 'align-items': 'alignItems', 'align-content': 'alignContent', 'row-gap': 'rowGap', 'column-gap': 'columnGap', 'grid-template-columns': 'columns', 'grid-template-rows': 'rows' };
            const property = map[key] ?? key;
            if (remove)
                delete s.layout[property];
            else
                s.layout[property] = ['gap', 'row-gap', 'column-gap'].includes(key) ? px(value) : key === 'padding' ? value.split(/\s+/).map(px) : key.startsWith('grid-template') ? gridTracks(value) : value;
        }
        else if (key === 'align-self') {
            if (remove)
                delete s.alignSelf;
            else
                s.alignSelf = value;
        }
        else if (key === 'flex' || key === 'flex-grow') {
            s.widthSizing = remove || value === '0' ? 'fixed' : 'fill';
        }
        else if (/^m(in|ax)-(width|height)$/.test(key)) {
            const property = key.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
            if (remove)
                delete s[property];
            else
                s[property] = px(value);
        }
        else if (key === 'transform') {
            if (remove) {
                s.rotation = 0;
                delete (s as Data).transform;
            }
            else {
                const rotate = /^rotate\(\s*([-\d.]+)deg\)$/.exec(value);
                if (rotate) {
                    s.rotation = Number(rotate[1]);
                    delete (s as Data).transform;
                }
                else
                    ignored.push(key);
            }
        }
        else
            ignored.push(key);
    }
    if (s.widthSizing)
        s.hSizing = s.widthSizing;
    if (s.heightSizing)
        s.vSizing = s.heightSizing;
    Object.assign(s, boxGeometry(s));
    return ignored;
}
