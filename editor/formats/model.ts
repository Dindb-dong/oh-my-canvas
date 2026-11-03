/** Original interchange helpers, authored from the frozen interoperability contract. */
import type { CanvasDocument, Data, Shape, ShapeType } from '../contracts';
import { boxGeometry } from '../geometry';
import { createShape, createDocument, validateDocument } from '../document';
export const copy = <T>(v: T): T => structuredClone(v);
export const uid = () => globalThis.crypto.randomUUID();
export const shape = (type: ShapeType, values: Data = {}): Shape => createShape(type, values);
export const documentModel = (): CanvasDocument => createDocument();
export function textValue(s: Shape): string {
    if (typeof s.content === 'string')
        return s.content;
    if (s.content?.children)
        return s.content.children.map((p: Data) => (p.children ?? []).map((r: Data) => r.text ?? '').join('')).join('\n');
    return String(s.text ?? '');
}
export function richText(text: string, style: Data = {}) { return { type: 'richText', verticalAlign: 'top', children: text.split('\n').map(line => ({ textAlign: 'left', children: [{ text: line, ...copy(style) }] })) }; }
export function assertFiniteDocument(doc: CanvasDocument) {
    for (const page of Object.values(doc.pagesById ?? {}))
        for (const s of Object.values(page.objects ?? {}))
            Object.assign(s, boxGeometry(s));
    validateDocument(doc);
}
