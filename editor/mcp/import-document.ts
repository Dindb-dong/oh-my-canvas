import type { Data } from '../contracts';
import { SHAPE_PROPERTIES, TEXT_STYLE_PROPERTIES, validateJson, validateShapeProperties, validateTextStyleProperties, validateVisualProperties } from './properties';

const extensionFields = ['editorLayout', 'editorText', 'editorBool', 'editorFrame', 'editorGrid', 'editorExport', 'editorVector', 'editorStyle'];
const record = (value: unknown): value is Data => !!value && typeof value === 'object' && !Array.isArray(value);
const ownFields = (value: Data, fields: Data): Data => Object.fromEntries(Object.entries(value).filter(([key]) => Object.hasOwn(fields, key)));
function visualShape(shape: unknown): void {
    if (!record(shape)) throw Error('Imported shape must be an object');
    const properties = ownFields(shape, SHAPE_PROPERTIES.properties);
    // Legacy fields feed the primitive factory before the document model exists.
    if (shape.primitive || ['polygon', 'star'].includes(shape.type)) {
        const primitive = record(shape.primitive) ? { ...shape.primitive } : {};
        for (const key of ['count', 'sides', 'points', 'ratio', 'innerRatio', 'innerRadius']) if (shape[key] !== undefined) primitive[key] = shape[key];
        properties.primitive = primitive;
    }
    validateShapeProperties(properties);
    const text = ownFields(shape, TEXT_STYLE_PROPERTIES.properties);
    if (Object.keys(text).length) validateTextStyleProperties(text);
    for (const field of extensionFields) if (shape[field] !== undefined) {
        if (!record(shape[field])) throw Error(`Imported ${field} must be an object`);
        const extension = ownFields(shape[field], SHAPE_PROPERTIES.properties);
        if (field === 'editorLayout' && ['flex', 'grid'].includes(shape[field].type)) extension.layout = shape[field];
        validateShapeProperties(extension);
    }
}
function style(style: unknown): void {
    if (!record(style)) throw Error('Imported style must be an object');
    const value = style.value ?? style.data ?? (style.type === 'paint' ? style.paints : style.type === 'text' ? style.text : style.effects);
    if (value === undefined) return;
    validateJson(value);
    if (style.type === 'paint' || style.type === 'fill' || style.type === 'stroke') validateVisualProperties({ fills: value });
    else if (style.type === 'text') { if (!record(value)) throw Error('Imported text style must be an object'); validateTextStyleProperties(ownFields(value, TEXT_STYLE_PROPERTIES.properties)); }
    else if (style.type === 'effect') validateVisualProperties(Array.isArray(value) ? { effects: value } : value);
}

/** Validate MCP file imports before conversion and before mounting; retain unrelated metadata verbatim. */
export function validateImportedDocument(input: unknown): void {
    if (!record(input)) throw Error('Imported canvas must be an object');
    let count = 0;
    const shape = (value: unknown) => { if (++count > 20000) throw Error('Imported canvas exceeds 20000 shapes'); visualShape(value); };
    if (input.pagesById !== undefined) {
        if (!record(input.pagesById) || Object.keys(input.pagesById).length > 100) throw Error('Imported canvas has invalid pages');
        for (const page of Object.values<Data>(input.pagesById)) {
            if (!record(page) || !record(page.objects)) throw Error('Imported page has invalid objects');
            for (const value of Object.values(page.objects)) shape(value);
            if (page.guides !== undefined) validateShapeProperties({ guides: page.guides });
        }
    } else {
        if (!Array.isArray(input.pages ?? []) || (input.pages?.length ?? 0) > 20000) throw Error('Imported legacy pages must be a bounded array');
        if (input.editorRootLayers !== undefined && !record(input.editorRootLayers)) throw Error('Imported root layers must be a record');
        const stack = [...input.pages ?? []];
        for (const rows of Object.values(input.editorRootLayers ?? {})) {
            if (!Array.isArray(rows) || stack.length + rows.length > 20000) throw Error('Imported root layers must be bounded arrays');
            stack.push(...rows);
        }
        while (stack.length) {
            const value = stack.pop(); shape(value);
            if (value.children !== undefined) {
                if (!Array.isArray(value.children)) throw Error('Imported layer children must be an array');
                if (stack.length + count + value.children.length > 20000) throw Error('Imported canvas exceeds 20000 shapes');
                stack.push(...value.children);
            }
        }
    }
    for (const styles of [input.styles, input.editorStyles]) if (styles !== undefined) {
        if (!record(styles)) throw Error('Imported styles must be records');
        for (const value of Object.values(styles)) style(value);
    }
    for (const libraries of [input.libraries, input.editorLibraries]) if (libraries !== undefined) {
        if (!record(libraries)) throw Error('Imported libraries must be records');
        for (const library of Object.values<Data>(libraries)) {
            if (!record(library)) throw Error('Imported library must be an object');
            const objects = Object.values(library.objects ?? {});if (objects.length > 20000) throw Error('Imported library exceeds 20000 shapes');
            for (const value of objects) visualShape(value);
            for (const value of Object.values(library.styles ?? {})) style(value);
        }
    }
    if (input.assets !== undefined) {
        if (!record(input.assets)) throw Error('Imported assets must be records');
        for (const asset of Object.values<Data>(input.assets)) {
            if (!record(asset)) throw Error('Imported asset must be an object');
            validateJson(asset);
            if (asset.kind !== 'font') validateVisualProperties({ image: asset });
        }
    }
}
