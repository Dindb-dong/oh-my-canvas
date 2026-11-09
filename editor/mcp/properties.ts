import type { Data } from '../contracts';
import { safeUrl } from '../formats/markup';

const number = { type: 'number', minimum: -1e9, maximum: 1e9 };
const positive = { type: 'number', minimum: 0, maximum: 1e9 };
const string = { type: 'string', maxLength: 200000 };
const boolean = { type: 'boolean' };
const object = { type: 'object', additionalProperties: true };
const array = { type: 'array', items: object, maxItems: 10000 };
const choice = (...values: string[]) => ({ type: 'string', enum: values });
const fields: Data = {
    name: string, x: number, y: number, width: positive, height: positive, rotation: number,
    opacity: { type: 'number', minimum: 0, maximum: 1 }, hidden: boolean, locked: boolean,
    constrainProportions: boolean, flipX: boolean, flipY: boolean, blendMode: string,
    fills: array, strokes: array, strokeWidth: positive, strokeAlignment: string,
    strokeCap: string, strokeJoin: string, strokeDashArray: { type: 'array', items: positive, maxItems: 200 }, strokeSides: object,
    radius: positive, radii: {}, radiusTopLeft: positive, radiusTopRight: positive,
    radiusBottomLeft: positive, radiusBottomRight: positive, cornerSmoothing: positive,
    clip: object, clipContent: boolean, omitFillOnExport: boolean,
    layout: object, hSizing: choice('fixed', 'hug', 'fill'), vSizing: choice('fixed', 'hug', 'fill'),
    widthSizing: choice('fixed', 'hug', 'fill'), heightSizing: choice('fixed', 'hug', 'fill'),
    minWidth: positive, maxWidth: positive, minHeight: positive, maxHeight: positive, absolute: boolean,
    horizontalConstraint: choice('left', 'right', 'leftAndRight', 'center', 'scale'),
    verticalConstraint: choice('top', 'bottom', 'topAndBottom', 'center', 'scale'),
    gridCell: object, layoutGrids: array, guides: array, shadows: array, effects: array,
    blur: positive, blurHidden: boolean, backgroundBlur: positive, backgroundBlurHidden: boolean,
    image: object, src: string, objectFit: choice('fill', 'contain', 'cover'), crop: object, adjust: object,
    svg: string, content: {}, autoResize: choice('none', 'widthAndHeight', 'height', 'width', 'fixed', 'auto'),
    truncate: boolean, maxLines: { type: 'integer', minimum: 1, maximum: 100000 }, leadingTrim: choice('none', 'capHeight'),
    fillRule: choice('nonzero', 'evenodd'), handleMode: choice('free', 'aligned', 'symmetric'), primitive: object,
    isMaskGroup: boolean, maskType: choice('alpha', 'vector', 'luminance'),
    booleanOperation: choice('union', 'subtract', 'intersect', 'exclude'), exportSettings: array,
    text: string, textBackground: object,
};
export const SHAPE_PROPERTIES = { type: 'object', properties: Object.fromEntries(Object.entries(fields).map(([key, schema]) => [key, { anyOf: [schema, { type: 'null' }] }])), additionalProperties: false };
export const TEXT_STYLE_PROPERTIES = {
    type: 'object', additionalProperties: false, properties: {
        fontFamily: string, fontSize: positive, fontWeight: positive, fontStyle: choice('normal', 'italic'),
        letterSpacing: number, fills: array, highlight: { anyOf: [object, { type: 'null' }] },
        textDecoration: choice('none', 'underline', 'line-through'), textDecorationStyle: choice('solid', 'dotted', 'wavy', 'double', 'dashed'),
        textDecorationThickness: positive, textTransform: choice('none', 'uppercase', 'lowercase', 'capitalize', 'smallCaps'),
        textAlign: choice('left', 'center', 'right', 'justify'), lineHeight: positive, paragraphSpacing: number, paragraphIndent: number,
        listType: choice('none', 'ordered', 'bullet'), listLevel: { type: 'integer', minimum: 0, maximum: 100 },
        verticalAlign: choice('top', 'center', 'bottom'),
    }
};
export function validateShapeProperties(properties: Data): void {
    if (!properties || typeof properties !== 'object' || Array.isArray(properties)) throw Error('Properties must be an object');
    for (const [key, value] of Object.entries(properties)) {
        if (!Object.hasOwn(fields, key)) throw Error(`Unsupported shape property: ${key}`);
        if (value !== null) check(fields[key], value, key);
    }
    validateJson(properties);
    validateVisualProperties(properties);
}
function record(value: unknown, name: string): asserts value is Data {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error(`${name} must be an object`);
}
function check(schema: Data, value: any, name: string): void {
    if (schema.anyOf) {
        for (const alternative of schema.anyOf) {
            try { check(alternative, value, name); return; } catch { /* Try the next allowed representation. */ }
        }
        throw Error(`${name} has an unsupported value`);
    }
    if (schema.type === 'null' && value !== null) throw Error(`${name} must be null`);
    if (schema.type === 'object') record(value, name);
    if (schema.type === 'array') {
        if (!Array.isArray(value) || value.length > (schema.maxItems ?? 10000)) throw Error(`${name} must be a bounded array`);
        value.forEach((item, index) => check(schema.items, item, `${name}[${index}]`));
    }
    if (schema.type === 'number' || schema.type === 'integer') {
        if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > 1e9 || schema.type === 'integer' && !Number.isInteger(value) || schema.minimum !== undefined && value < schema.minimum || schema.maximum !== undefined && value > schema.maximum) throw Error(`${name} has an invalid number`);
    }
    if (schema.type === 'string' && (typeof value !== 'string' || value.length > (schema.maxLength ?? 2000000))) throw Error(`${name} must be a bounded string`);
    if (schema.type === 'boolean' && typeof value !== 'boolean') throw Error(`${name} must be boolean`);
    if (schema.enum && !schema.enum.includes(value)) throw Error(`${name} has an unsupported value`);
}
function optionalNumbers(value: Data, keys: string[], name: string, minimum = -1e9): void {
    for (const key of keys) if (value[key] !== undefined) check({ ...number, minimum }, value[key], `${name}.${key}`);
}
function recordArray(value: unknown, name: string): Data[] {
    check(array, value, name);
    return value as Data[];
}
function paints(value: unknown, name: string): void {
    for (const paint of recordArray(value, name)) {
        optionalNumbers(paint, ['opacity'], name, 0);
        optionalNumbers(paint, ['width', 'thickness'], name, 0);
        if (paint.gradient !== undefined && paint.gradient !== null) {
            record(paint.gradient, `${name}.gradient`);
            optionalNumbers(paint.gradient, ['x1', 'y1', 'x2', 'y2', 'aspect', 'angle'], `${name}.gradient`);
            if (paint.gradient.stops !== undefined) for (const stop of recordArray(paint.gradient.stops, `${name}.gradient.stops`)) optionalNumbers(stop, ['offset', 'opacity'], 'Gradient stop');
        }
        if (paint.stops !== undefined) for (const stop of recordArray(paint.stops, `${name}.stops`)) optionalNumbers(stop, ['offset', 'opacity'], 'Gradient stop');
        if (paint.image !== undefined && paint.image !== null) image(paint.image, `${name}.image`);
        for (const key of ['dash', 'dashes', 'strokeDashArray']) if (paint[key] !== undefined) check({ type: 'array', items: positive, maxItems: 200 }, paint[key], `${name}.${key}`);
    }
}
function rectangle(value: unknown, name: string): void {
    record(value, name);
    optionalNumbers(value, ['x', 'y'], name);
    optionalNumbers(value, ['width', 'height'], name, 0);
}
function image(value: unknown, name: string): void {
    record(value, name);
    optionalNumbers(value, ['width', 'height', 'tileScale'], name, 0);
    if (value.crop !== undefined && value.crop !== null) rectangle(value.crop, `${name}.crop`);
    if (value.adjust !== undefined && value.adjust !== null) {
        record(value.adjust, `${name}.adjust`);
        optionalNumbers(value.adjust, ['exposure', 'contrast', 'saturation', 'temperature', 'tint', 'highlights', 'shadows'], `${name}.adjust`);
    }
}
export function validateTextStyleProperties(properties: Data): void {
    record(properties, 'Text style');
    for (const [key, value] of Object.entries(properties)) {
        const schema = (TEXT_STYLE_PROPERTIES.properties as Data)[key];
        if (!schema) throw Error(`Unsupported text style property: ${key}`);
        check(schema, value, `Text style.${key}`);
    }
    validateJson(properties);
    if (properties.fills !== undefined) paints(properties.fills, 'Text fills');
}
export function validateVisualProperties(properties: Data): void {
    for (const key of ['fills', 'strokes']) if (properties[key] !== undefined && properties[key] !== null) paints(properties[key], key);
    for (const key of ['shadows', 'effects']) if (properties[key] !== undefined && properties[key] !== null) for (const effect of recordArray(properties[key], key)) {
        optionalNumbers(effect, ['offsetX', 'offsetY', 'spread', 'opacity'], key);
        optionalNumbers(effect, ['blur', 'radius'], key, 0);
    }
    if (properties.image !== undefined && properties.image !== null) image(properties.image, 'Image');
    if (properties.crop !== undefined && properties.crop !== null) rectangle(properties.crop, 'Crop');
    if (properties.radii !== undefined && properties.radii !== null) {
        if (typeof properties.radii === 'number') check(positive, properties.radii, 'Radii');
        else if (Array.isArray(properties.radii)) {
            if (![1, 2, 4].includes(properties.radii.length)) throw Error('Radii needs one, two or four values');
            properties.radii.forEach((radius: unknown) => check(positive, radius, 'Radius'));
        }
        else { record(properties.radii, 'Radii'); optionalNumbers(properties.radii, ['topLeft', 'topRight', 'bottomLeft', 'bottomRight'], 'Radii', 0); }
    }
    if (properties.layout !== undefined && properties.layout !== null) {
        const layout = properties.layout; record(layout, 'Layout');
        if (layout.type !== undefined) check(choice('flex', 'grid'), layout.type, 'Layout type');
        for (const axis of ['rows', 'columns']) if (layout[axis] !== undefined) {
            const tracks = layout[axis];
            if (typeof tracks === 'number') check({ type: 'integer', minimum: 1, maximum: 1000 }, tracks, axis);
            else {
                if (!Array.isArray(tracks) || !tracks.length || tracks.length > 1000) throw Error(`${axis} must contain 1–1000 tracks`);
                for (const track of tracks) {
                    if (typeof track === 'number') check(positive, track, 'Grid track');
                    else if (typeof track === 'string') { if (!/^(auto|[\d.]+(?:px|fr)?)$/.test(track)) throw Error('Invalid grid track'); }
                    else { record(track, 'Grid track'); if (track.type !== undefined) check(choice('auto', 'fixed', 'fr'), track.type, 'Grid track type'); optionalNumbers(track, ['size', 'value', 'weight'], 'Grid track', 0); }
                }
            }
        }
        for (const key of ['gap', 'padding']) if (layout[key] !== undefined) {
            const value = layout[key];
            if (typeof value === 'number') check(number, value, `Layout ${key}`);
            else if (key === 'padding' && Array.isArray(value)) { if (![1, 2, 4].includes(value.length)) throw Error('Padding needs one, two or four values'); value.forEach(item => check(number, item, 'Padding')); }
            else { record(value, `Layout ${key}`); optionalNumbers(value, key === 'gap' ? ['row', 'column'] : ['top', 'right', 'bottom', 'left'], `Layout ${key}`); }
        }
    }
    if (properties.gridCell !== undefined && properties.gridCell !== null) {
        record(properties.gridCell, 'Grid cell');
        for (const key of ['row', 'column', 'rowSpan', 'columnSpan']) if (properties.gridCell[key] !== undefined) check({ type: 'integer', minimum: 1, maximum: 1000 }, properties.gridCell[key], `Grid cell.${key}`);
    }
    for (const key of ['layoutGrids', 'guides']) if (properties[key] !== undefined && properties[key] !== null) for (const item of recordArray(properties[key], key)) {
        if (key === 'guides') {
            check(choice('x', 'y'), item.axis, 'Guide axis'); check(number, item.position, 'Guide position');
        }
        else {
            if (item.pattern !== undefined) check(choice('grid', 'columns', 'rows'), item.pattern, 'Grid pattern');
            optionalNumbers(item, ['size', 'count'], 'Grid', 1); optionalNumbers(item, ['gutter', 'offset', 'opacity'], 'Grid');
        }
    }
    if (properties.content !== undefined && properties.content !== null && typeof properties.content !== 'string') {
        const content = properties.content;
        if (Array.isArray(content)) for (const segment of recordArray(content, 'Path segments')) {
            check(choice('move', 'line', 'curve', 'close'), segment.command, 'Path command');
            if (segment.command !== 'close') for (const key of segment.command === 'curve' ? ['x', 'y', 'x1', 'y1', 'x2', 'y2'] : ['x', 'y']) check(number, segment[key], `Path ${key}`);
        }
        else {
            record(content, 'Text content');
            for (const paragraph of recordArray(content.children, 'Text paragraphs')) {
                validateTextStyleProperties(Object.fromEntries(Object.entries(paragraph).filter(([key]) => Object.hasOwn(TEXT_STYLE_PROPERTIES.properties, key))));
                for (const run of recordArray(paragraph.children, 'Text runs')) {
                    check(string, run.text, 'Text run');
                    const style = Object.fromEntries(Object.entries(run).filter(([key]) => Object.hasOwn(TEXT_STYLE_PROPERTIES.properties, key)));
                    validateTextStyleProperties(style);
                }
            }
        }
    }
}
export function validateJson(value: unknown, depth = 0, budget = { nodes: 0 }): void {
    if (++budget.nodes > 100000 || depth > 24) throw Error('Property data exceeds the complexity limit');
    if (typeof value === 'number' && (!Number.isFinite(value) || Math.abs(value) > 1e9)) throw Error('Property numbers must be finite and within ±1e9');
    if (typeof value === 'string' && value.length > 2000000) throw Error('Property string exceeds 2 million characters');
    if (value && typeof value === 'object') {
        if (![Object.prototype, Array.prototype, null].includes(Object.getPrototypeOf(value))) throw Error('Property data must contain JSON records');
        for (const [key, child] of Object.entries(value)) {
            if (['__proto__', 'prototype', 'constructor'].includes(key)) throw Error('Unsafe property key');
            const embeddedFont = (value as Data).kind === 'font' && ['src', 'url'].includes(key) && typeof child === 'string' && /^data:(?:font\/(?:woff2?|ttf|otf)|application\/(?:font-woff|x-font-ttf|x-font-opentype|octet-stream));base64,[A-Za-z0-9+/]*={0,2}$/.test(child);
            if (['src', 'url', 'href', 'xlink:href'].includes(key) && child !== undefined && child !== null && (typeof child !== 'string' || !safeUrl(child)) && !embeddedFont) throw Error('Unsafe resource URL');
            validateJson(child, depth + 1, budget);
        }
    }
    else if (value !== undefined && value !== null && !['number', 'string', 'boolean'].includes(typeof value)) throw Error('Property data must contain JSON values');
}
