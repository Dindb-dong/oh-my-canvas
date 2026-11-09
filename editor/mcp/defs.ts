/** Public protocol schemas authored from docs/independent/contracts.md. */
import type { Data } from '../contracts';
const str = (extra: Data = {}) => ({ type: 'string', ...extra });
const num = (extra: Data = {}) => ({ type: 'number', ...extra });
const int = (extra: Data = {}) => ({ type: 'integer', ...extra });
const arr = (items: Data, minItems?: number, maxItems?: number) => ({ type: 'array', items, ...minItems !== undefined ? { minItems } : {}, ...maxItems !== undefined ? { maxItems } : {} });
const obj = (properties: Data = {}, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });
const enumeration = (values: string[]) => str({ enum: values });
const position = enumeration(['before', 'after', 'first', 'last']);
const point = obj({ x: num(), y: num() }, ['x', 'y']);
const stringMap = { type: 'object', additionalProperties: { type: 'string' } };
const batchNames = ['write_html', 'update', 'move', 'duplicate', 'delete', 'create_board'];
const tool = (name: string, description: string, inputSchema: Data) => ({ name, description, inputSchema });
export const EDITOR_TOOLS = [
    tool('get_context', 'Read the active page, viewport, selection, revision, and available boards.', obj()),
    tool('select_page', 'Select a page by its raw page ID and return refreshed context. Refuses active user edits; old page aliases cannot target the new page.', obj({ id: str({ minLength: 1 }) }, ['id'])),
    tool('get_tree', 'Read an ordered layer tree. Depth defaults to 4; output is capped at 400 nodes.', obj({ id: str(), depth: int({ minimum: 1, default: 4 }), detail: enumeration(['concise', 'detailed']) })),
    tool('get_html', 'Export a layer as editable HTML with inline styles.', obj({ id: str() }, ['id'])),
    tool('get_styles', 'Read computed CSS styles of up to 50 layers.', obj({ ids: arr(str(), 1, 50), keys: arr(str(), undefined, 40) }, ['ids'])),
    tool('find', 'Search layer text, type, or name inside an optional subtree. Returns at most 50 matches.', { ...obj({ text: str(), kind: str(), name: str(), within: str() }), anyOf: [{ required: ['text'] }, { required: ['kind'] }, { required: ['name'] }] }),
    tool('screenshot', 'Capture a settled layer or page. Slice mode supports zero-based slices; overview fits the scene.', obj({ id: str(), mode: enumeration(['slice', 'overview']), slice: int({ minimum: 0 }) })),
    tool('write_html', 'Insert sanitized HTML with inline CSS relative to a target layer.', obj({ html: str(), target: str(), position: enumeration(['before', 'after', 'first', 'last', 'replace']) }, ['html', 'target', 'position'])),
    tool('write_svg', 'Insert SVG as editable vector layers; unsupported elements are preserved as pictures with warnings. Standalone operation.', obj({ svg: str({ maxLength: 200000 }), target: str(), position: enumeration(['before', 'after', 'first', 'last', 'replace']) }, ['svg', 'target', 'position'])),
    tool('get_path', 'Read native cubic path segments and node indices in world coordinates. Use the returned revision when editing.', obj({ id: str() }, ['id'])),
    tool('edit_path', 'Edit native path nodes in world coordinates. Requires the revision from get_path; standalone atomic operation.', obj({ id: str(), revision: int({ minimum: 0 }), action: enumeration(['move_nodes', 'insert_node', 'delete_nodes', 'set_handle', 'convert_node', 'close', 'open']), indices: arr(int({ minimum: 0 }), 1, 1000), index: int({ minimum: 0 }), dx: num(), dy: num(), t: num(), handle: enumeration(['in', 'out']), point, mode: enumeration(['free', 'aligned', 'symmetric']), nodeKind: enumeration(['corner', 'smooth', 'symmetric']) }, ['id', 'revision', 'action'])),
    tool('boolean', 'Combine ordered vector operands non-destructively. Subtract removes later operands from the first. Flatten creates an editable path and hides preserved sources; other operations retain source children. Standalone operation.', obj({ ids: arr(str(), 1, 200), operation: enumeration(['union', 'subtract', 'intersect', 'exclude', 'flatten']), revision: int({ minimum: 0 }) }, ['ids', 'operation', 'revision'])),
    tool('outline', 'Convert strokes or text into editable paths while preserving hidden source layers. Standalone atomic operation.', obj({ ids: arr(str(), 1, 200), kind: enumeration(['stroke', 'text']), revision: int({ minimum: 0 }) }, ['ids', 'kind', 'revision'])),
    tool('image', 'Remove an image background locally or restore its preserved original. Standalone atomic operation.', obj({ id: str(), action: enumeration(['remove_background', 'restore']), revision: int({ minimum: 0 }) }, ['id', 'action', 'revision'])),
    tool('update', 'Update a layer using CSS declarations, text, or supported attributes. An empty CSS value removes a property.', obj({ id: str(), style: stringMap, text: str(), attrs: stringMap }, ['id'])),
    tool('move', 'Move a layer before or after a sibling, or first or last inside a container.', obj({ id: str(), target: str(), position }, ['id', 'target', 'position'])),
    tool('duplicate', 'Duplicate a subtree, optionally positioning the copy relative to a target.', obj({ id: str(), target: str(), position }, ['id'])),
    tool('delete', 'Remove up to 200 layers atomically, including their descendants.', obj({ ids: arr(str(), 1, 200) }, ['ids'])),
    tool('batch', 'Apply 1–100 supported writes atomically as one agent operation.', obj({ ops: arr(obj({ tool: enumeration(batchNames), args: { type: 'object', additionalProperties: true } }, ['tool', 'args']), 1, 100) }, ['ops'])),
    tool('create_board', 'Create a vertically laid-out board to the right of existing boards. Height hugs content when omitted.', obj({ width: num({ minimum: 1 }), height: num({ minimum: 1 }), name: str() }, ['width'])),
    tool('assets', 'Search configured local or optional asset providers. Unconfigured providers return no records.', obj({ query: str(), kind: enumeration(['brand', 'upload', 'stock']) })),
    tool('get_guide', 'Read practical guidance for layout, text, review, components, vector authoring, or local image editing.', obj({ topic: enumeration(['html', 'layout', 'text', 'review', 'components', 'vector', 'image', 'workspace']) })),
    tool('undo', 'Undo the latest edit only when it belongs to this agent.', obj()),
    tool('components', 'Search reusable components, with pages of at most 200 records.', obj({ query: str(), offset: int({ minimum: 0 }) })),
    tool('component', 'Create or modify reusable components, variants, instances, and typed properties atomically.', obj({ action: enumeration(['create', 'add_variant', 'combine', 'instance', 'variant', 'property', 'edit_property', 'remove_property', 'bind', 'set_property', 'reset', 'detach']), id: str(), ids: arr(str(), 1, 200), source: str(), parent: str(), layer: str(), name: str(), property: str(), propertyType: enumeration(['text', 'boolean', 'swap']), value: str(), x: num(), y: num() }, ['action'])),
    tool('fonts', 'List configured font families, optionally filtering by a case-insensitive query.', obj({ query: str() })),
] as const;
const documentId = str({ minLength: 36, maxLength: 36, pattern: '^[a-f0-9-]{36}$' });
const documentTitle = str({ minLength: 1, maxLength: 120, pattern: '\\S' });
export const WORKSPACE_TOOLS = [
    tool('list_documents', 'List local canvas metadata without opening a document. Optional query, zero-based offset and limit (default 50, maximum 100). No paths, thumbnails or document content.', obj({ query: str(), offset: int({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }), limit: int({ minimum: 1, maximum: 100, default: 50 }) })),
    tool('open_document', 'Open a local canvas by its document ID after saving pending edits. Returns document identity and refreshed context. Discard old layer aliases after navigation.', obj({ id: documentId }, ['id'])),
    tool('create_document', 'Create and open a blank local canvas, optionally named with 1–120 characters. Returns its saved document ID and refreshed context.', obj({ title: documentTitle })),
    tool('rename_document', 'Rename a local canvas by document ID without switching the open canvas. The trimmed title must contain 1–120 characters.', obj({ id: documentId, title: documentTitle }, ['id', 'title'])),
    tool('duplicate_document', 'Duplicate and open a local canvas by document ID, optionally naming the copy. Saves pending edits first and returns a new document ID and refreshed context.', obj({ id: documentId, title: documentTitle }, ['id'])),
] as const;
export const TOOLS = [...EDITOR_TOOLS, ...WORKSPACE_TOOLS] as const;
export type LvMcpToolName = typeof EDITOR_TOOLS[number]['name'];
export function validateToolArgs(name: string, args: unknown): string | null {
    const definition = TOOLS.find(t => t.name === name);
    if (!definition)
        return 'Unknown tool';
    function check(schema: Data, value: any, path: string): string | null {
        if (schema.type === 'object') {
            if (!value || typeof value !== 'object' || Array.isArray(value))
                return `${path} must be an object`;
            for (const key of schema.required ?? [])
                if (!Object.hasOwn(value, key))
                    return `${path}.${key} is required`;
            for (const [key, v] of Object.entries(value)) {
                if (Object.hasOwn(schema.properties ?? {}, key)) {
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
                if (!Object.hasOwn(value, key))
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
        if (schema.type === 'string') {
            if (typeof value !== 'string')
                return `${path} must be a string`;
            if (schema.minLength !== undefined && value.length < schema.minLength)
                return `${path} is too short`;
            if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value))
                return `${path} has an invalid format`;
            if (schema.maxLength !== undefined && value.length > schema.maxLength)
                return `${path} is too long`;
        }
        if (schema.type === 'number' || schema.type === 'integer') {
            if (typeof value !== 'number' || !Number.isFinite(value) || schema.type === 'integer' && !Number.isInteger(value))
                return `${path} must be a finite ${schema.type}`;
            if (schema.minimum !== undefined && value < schema.minimum)
                return `${path} must be at least ${schema.minimum}`;
            if (schema.maximum !== undefined && value > schema.maximum)
                return `${path} must be at most ${schema.maximum}`;
        }
        if (schema.enum && !schema.enum.includes(value))
            return `${path} has an unsupported value`;
        return null;
    }
    const error = check(definition.inputSchema, args, 'args');
    if (error)
        return error;
    if (name === 'edit_path') {
        const v = args as Data;
        const required: Record<string, string[]> = { move_nodes: ['indices', 'dx', 'dy'], insert_node: ['index'], delete_nodes: ['indices'], set_handle: ['index', 'handle', 'point'], convert_node: ['index', 'nodeKind'] };
        for (const key of required[v.action] ?? [])
            if (v[key] === undefined)
                return `${v.action} requires ${key}`;
        if (v.t !== undefined && (v.t <= 0 || v.t >= 1))
            return 't must be between 0 and 1';
    }
    if (name === 'boolean') {
        const value = args as Data;
        if (new Set(value.ids).size !== value.ids.length)
            return 'Boolean operands must be unique';
        if (value.operation !== 'flatten' && value.ids.length < 2)
            return 'Boolean operations require at least two operands';
    }
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
