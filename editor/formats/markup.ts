import type { Data } from '../contracts';
export interface MarkupNode {
    tag: string;
    attrs: Record<string, string>;
    children: MarkupNode[];
    text?: string;
    sourceTag?: string;
    sourceNames?: Record<string, string>;
}
const voidTags = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
// SVG pictures are static. SMIL can mutate a harmless href into an executable
// URL after sanitization, so both import and scene export share this policy.
const forbidden = new Set([
    'script', 'style', 'iframe', 'object', 'embed', 'link', 'meta', 'base',
    'audio', 'video', 'foreignobject', 'handler', 'listener',
    'animate', 'set', 'animatemotion', 'animatetransform', 'animatecolor',
    'discard', 'mpath', 'animation'
]);
export function unsafeMarkupElement(tag: string): boolean {
    return forbidden.has(tag.split(':').at(-1)!.toLowerCase());
}
export const escapeText = (s: any) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
export const escapeAttr = (s: any) => escapeText(s).replace(/"/g, '&quot;');
export function entities(s: string): string {
    return s.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (_, v: string) => {
        if (v[0] === '#') {
            const n = v[1].toLowerCase() === 'x' ? parseInt(v.slice(2), 16) : parseInt(v.slice(1), 10);
            return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '\ufffd';
        }
        return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' } as Data)[v.toLowerCase()];
    });
}
export function safeUrl(value: string): boolean { const v = value.replace(/[\u0000-\u0020\u007f]/g, '').toLowerCase(); return !/^(javascript|vbscript|file|blob):/.test(v) && (!v.startsWith('data:') || /^data:image\/(png|jpe?g|gif|webp|avif|bmp|x-icon|vnd\.microsoft\.icon|svg\+xml);/i.test(v)); }
/** An inert tokenizer: it never creates DOM, fetches resources, or evaluates markup. */
export function parseMarkup(input: string, options: {
    svg?: boolean;
} = {}): MarkupNode {
    if (typeof input !== 'string' || input.length > 2000000)
        throw new Error('Markup is too large');
    const root: MarkupNode = { tag: '#root', attrs: {}, children: [] }, stack = [root];
    let index = 0, count = 0;
    while (index < input.length) {
        if (input.startsWith('<!--', index)) {
            const end = input.indexOf('-->', index + 4);
            if (end < 0)
                throw new Error('Unclosed comment');
            index = end + 3;
            continue;
        }
        if (input[index] !== '<') {
            let end = input.indexOf('<', index);
            if (end < 0)
                end = input.length;
            stack.at(-1)!.children.push({ tag: '#text', attrs: {}, children: [], text: entities(input.slice(index, end)) });
            index = end;
            continue;
        }
        let end = index + 1, quote = '';
        for (; end < input.length; end++) {
            const c = input[end];
            if (quote) {
                if (c === quote)
                    quote = '';
            }
            else if (c === '"' || c === "'")
                quote = c;
            else if (c === '>')
                break;
        }
        if (end === input.length)
            throw new Error('Unclosed tag');
        let raw = input.slice(index + 1, end).trim();
        index = end + 1;
        if (raw.startsWith('!') || raw.startsWith('?')) {
            if (!/^!doctype\s+html$/i.test(raw) && !options.svg)
                throw new Error('Unsupported declaration');
            continue;
        }
        if (raw[0] === '/') {
            const tag = raw.slice(1).trim().toLowerCase();
            const match = stack.map(n => n.tag).lastIndexOf(tag);
            if (match > 0)
                stack.length = match;
            continue;
        }
        const m = /^([\w:-]+)/.exec(raw);
        if (!m)
            throw new Error('Malformed tag');
        const tag = m[1].toLowerCase();
        if (unsafeMarkupElement(tag))
            throw new Error(`Unsafe element <${tag}>`);
        const attrs: Record<string, string> = {}, sourceNames: Record<string, string> = {};
        let tail = raw.slice(m[0].length).replace(/\/\s*$/, '');
        while (tail.trim()) {
            tail = tail.trimStart();
            const a = /^([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/.exec(tail);
            if (!a)
                throw new Error('Malformed attribute');
            const key = a[1].toLowerCase(), value = entities(a[2] ?? a[3] ?? a[4] ?? '');
            sourceNames[key] = a[1];
            tail = tail.slice(a[0].length);
            if (/^on/.test(key) || key === 'srcdoc')
                throw new Error(`Unsafe attribute ${key}`);
            if (['src', 'href', 'xlink:href'].includes(key) && !safeUrl(value))
                throw new Error('Unsafe resource URL');
            if (key === 'class' && !options.svg)
                throw new Error('Class-based styling is unsupported; use inline CSS');
            if (key !== 'class')
                attrs[key] = value;
        }
        const node: MarkupNode = { tag, attrs, children: [], sourceTag: m[1], sourceNames };
        stack.at(-1)!.children.push(node);
        if (++count > 10000)
            throw new Error('Markup has too many nodes');
        if (!voidTags.has(tag) && !raw.endsWith('/')) {
            stack.push(node);
            if (stack.length > 100)
                throw new Error('Markup nesting is too deep');
        }
    }
    return root;
}
export function cssDeclarations(value: string): Record<string, string> {
    const output: Record<string, string> = {};
    let token = '', quote = '', depth = 0;
    const consume = () => {
        const index = token.indexOf(':');
        if (index > 0) {
            const key = token.slice(0, index).trim().toLowerCase(), v = token.slice(index + 1).trim().replace(/\s*!important$/i, '');
            if (/expression\s*\(|javascript\s*:|@import|behavior\s*:/i.test(v))
                throw new Error('Unsafe CSS');
            for (const u of v.matchAll(/url\(\s*['"]?(.*?)['"]?\s*\)/gi))
                if (!safeUrl(u[1]))
                    throw new Error('Unsafe CSS URL');
            output[key] = v;
        }
        token = '';
    };
    for (const c of value) {
        if (quote) {
            token += c;
            if (c === quote)
                quote = '';
        }
        else if (c === '"' || c === "'") {
            quote = c;
            token += c;
        }
        else if (c === '(') {
            depth++;
            token += c;
        }
        else if (c === ')') {
            depth--;
            token += c;
        }
        else if (c === ';' && depth === 0)
            consume();
        else
            token += c;
    }
    consume();
    return output;
}
export function serializeNode(n: MarkupNode): string {
    if (n.tag === '#text')
        return escapeText(n.text);
    if (n.tag === '#root')
        return n.children.map(serializeNode).join('');
    return `<${n.sourceTag ?? n.tag}${Object.entries(n.attrs).map(([k, v]) => ` ${n.sourceNames?.[k] ?? k}="${escapeAttr(v)}"`).join('')}>${n.children.map(serializeNode).join('')}</${n.sourceTag ?? n.tag}>`;
}
