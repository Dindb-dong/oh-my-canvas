/** Public protocol schemas authored from docs/independent/contracts.md. */
import type { Data } from '../contracts';
const str = (extra: Data = {}) => ({ type: 'string', ...extra });
const num = (extra: Data = {}) => ({ type: 'number', ...extra });
const int = (extra: Data = {}) => ({ type: 'integer', ...extra });
const arr = (items: Data, minItems?: number, maxItems?: number) => ({ type: 'array', items, ...minItems !== undefined ? { minItems } : {}, ...maxItems !== undefined ? { maxItems } : {} });
const obj = (properties: Data = {}, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });
const enumeration = (values: string[]) => str({ enum: values });
const position = enumeration(['before', 'after', 'first', 'last']);
const stringMap = { type: 'object', additionalProperties: { type: 'string' } };
const batchNames = ['write_html', 'update', 'move', 'duplicate', 'delete', 'create_board'];
const tool = (name: string, description: string, inputSchema: Data) => ({ name, description, inputSchema });
export const TOOLS = [
    tool('get_context', 'Read the active page, viewport, selection, revision, and available boards.', obj()),
    tool('get_tree', 'Read an ordered layer tree. Depth defaults to 4; output is capped at 400 nodes.', obj({ id: str(), depth: int({ minimum: 1, default: 4 }), detail: enumeration(['concise', 'detailed']) })),
    tool('get_html', 'Export a layer as editable HTML with inline styles.', obj({ id: str() }, ['id'])),
    tool('get_styles', 'Read computed CSS styles of up to 50 layers.', obj({ ids: arr(str(), 1, 50), keys: arr(str(), undefined, 40) }, ['ids'])),
    tool('find', 'Search layer text, type, or name inside an optional subtree. Returns at most 50 matches.', { ...obj({ text: str(), kind: str(), name: str(), within: str() }), anyOf: [{ required: ['text'] }, { required: ['kind'] }, { required: ['name'] }] }),
    tool('screenshot', 'Capture a settled layer or page. Slice mode supports zero-based slices; overview fits the scene.', obj({ id: str(), mode: enumeration(['slice', 'overview']), slice: int({ minimum: 0 }) })),
    tool('write_html', 'Insert sanitized HTML with inline CSS relative to a target layer.', obj({ html: str(), target: str(), position: enumeration(['before', 'after', 'first', 'last', 'replace']) }, ['html', 'target', 'position'])),
    tool('update', 'Update a layer using CSS declarations, text, or supported attributes. An empty CSS value removes a property.', obj({ id: str(), style: stringMap, text: str(), attrs: stringMap }, ['id'])),
    tool('move', 'Move a layer before or after a sibling, or first or last inside a container.', obj({ id: str(), target: str(), position }, ['id', 'target', 'position'])),
    tool('duplicate', 'Duplicate a subtree, optionally positioning the copy relative to a target.', obj({ id: str(), target: str(), position }, ['id'])),
    tool('delete', 'Remove up to 200 layers atomically, including their descendants.', obj({ ids: arr(str(), 1, 200) }, ['ids'])),
    tool('batch', 'Apply 1–100 supported writes atomically as one agent operation.', obj({ ops: arr(obj({ tool: enumeration(batchNames), args: { type: 'object', additionalProperties: true } }, ['tool', 'args']), 1, 100) }, ['ops'])),
    tool('create_board', 'Create a vertically laid-out board to the right of existing boards. Height hugs content when omitted.', obj({ width: num({ minimum: 1 }), height: num({ minimum: 1 }), name: str() }, ['width'])),
    tool('assets', 'Search configured local or optional asset providers. Unconfigured providers return no records.', obj({ query: str(), kind: enumeration(['brand', 'upload', 'stock']) })),
    tool('get_guide', 'Read practical guidance for HTML, layout, text, visual review, or reusable components.', obj({ topic: enumeration(['html', 'layout', 'text', 'review', 'components']) })),
    tool('undo', 'Undo the latest edit only when it belongs to this agent.', obj()),
    tool('components', 'Search reusable components, with pages of at most 200 records.', obj({ query: str(), offset: int({ minimum: 0 }) })),
    tool('component', 'Create or modify reusable components, variants, instances, and typed properties atomically.', obj({ action: enumeration(['create', 'add_variant', 'combine', 'instance', 'variant', 'property', 'edit_property', 'remove_property', 'bind', 'set_property', 'reset', 'detach']), id: str(), ids: arr(str(), 1, 200), source: str(), parent: str(), layer: str(), name: str(), property: str(), propertyType: enumeration(['text', 'boolean', 'swap']), value: str(), x: num(), y: num() }, ['action'])),
    tool('fonts', 'List configured font families, optionally filtering by a case-insensitive query.', obj({ query: str() })),
] as const;
export type LvMcpToolName = typeof TOOLS[number]['name'];
export function validateToolArgs(name: string, args: unknown): string | null {
    const definition = TOOLS.find(t => t.name === name);
    if (!definition)
        return 'Unknown tool';
    function check(schema: Data, value: any, path: string): string | null {
        if (schema.type === 'object') {
            if (!value || typeof value !== 'object' || Array.isArray(value))
                return `${path} must be an object`;
            for (const key of schema.required ?? [])
                if (!(key in value))
                    return `${path}.${key} is required`;
            for (const [key, v] of Object.entries(value)) {
                if (schema.properties?.[key]) {
                    const error = check(schema.properties[key], v, `${path}.${key}`);
                    if (error)
                        return error;
                }
                else if (schema.additionalProperties === false)
                    return `${path}.${key} is unsupported`;
                else if (typeof schema.additionalProperties === 'object') {
                    const error = check(schema.additionalProperties, v, `${path}.${key}`);
                    if (error)
                        return error;
                }
            }
            if (schema.anyOf && !schema.anyOf.some((alternative: Data) => !check(alternative, value, path)))
                return `${path} requires a search query`;
        }
        if (schema.required && !schema.type)
            for (const key of schema.required)
                if (!(key in value))
                    return `${path}.${key} is required`;
        if (schema.type === 'array') {
            if (!Array.isArray(value))
                return `${path} must be an array`;
            if (schema.minItems !== undefined && value.length < schema.minItems || schema.maxItems !== undefined && value.length > schema.maxItems)
                return `${path} has an invalid item count`;
            for (let i = 0; i < value.length; i++) {
                const error = check(schema.items, value[i], `${path}[${i}]`);
                if (error)
                    return error;
            }
        }
        if (schema.type === 'string' && typeof value !== 'string')
            return `${path} must be a string`;
        if (schema.type === 'number' || schema.type === 'integer') {
            if (typeof value !== 'number' || !Number.isFinite(value) || schema.type === 'integer' && !Number.isInteger(value))
                return `${path} must be a finite ${schema.type}`;
            if (schema.minimum !== undefined && value < schema.minimum)
                return `${path} must be at least ${schema.minimum}`;
        }
        if (schema.enum && !schema.enum.includes(value))
            return `${path} has an unsupported value`;
        return null;
    }
    const error = check(definition.inputSchema, args, 'args');
    if (error)
        return error;
    if (name === 'component') {
        const value = args as Data;
        if (value.action !== 'instance' && !value.id && !value.ids?.length)
            return 'Component action requires id or ids';
        if (value.action === 'instance' && !value.source)
            return 'instance requires source';
        if (['property', 'bind'].includes(value.action) && !value.propertyType)
            return `${value.action} requires propertyType`;
        if (['variant', 'set_property'].includes(value.action) && value.value === undefined)
            return `${value.action} requires value`;
        if (['edit_property', 'remove_property', 'set_property'].includes(value.action) && !value.property)
            return `${value.action} requires property`;
        if ((value.x === undefined) !== (value.y === undefined))
            return 'x and y must be supplied together';
        if (value.propertyType === 'boolean' && value.value !== undefined && !['true', 'false'].includes(value.value))
            return 'Boolean property values must be true or false';
    }
    if (name === 'batch')
        for (const [i, op] of (args as Data).ops.entries()) {
            const nested = validateToolArgs(op.tool, op.args);
            if (nested)
                return `ops[${i}]: ${nested}`;
        }
    return null;
}
