import type { Data } from '../contracts';
import { SHAPE_PROPERTIES, TEXT_STYLE_PROPERTIES } from './properties';

const s = (extra: Data = {}) => ({ type: 'string', ...extra });
const n = (extra: Data = {}) => ({ type: 'number', ...extra });
const i = (extra: Data = {}) => ({ type: 'integer', ...extra });
const b = { type: 'boolean' };
const e = (values: string[]) => s({ enum: values });
const o = (properties: Data = {}, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });
const a = (items: Data, maxItems = 200, minItems = 0) => ({ type: 'array', items, minItems, maxItems });
const id = s({ minLength: 1, maxLength: 200 });
const ids = a(id, 200, 1);
const point = o({ x: n(), y: n() }, ['x', 'y']);
const rect = o({ x: n(), y: n(), width: n({ minimum: 0 }), height: n({ minimum: 0 }) }, ['x', 'y', 'width', 'height']);
const title = s({ minLength: 1, maxLength: 120, pattern: '\\S' });
const documentId = s({ minLength: 36, maxLength: 36, pattern: '^[a-f0-9-]{36}$' });
const json = { type: 'object', additionalProperties: true };
const tool = (name: string, description: string, inputSchema: Data) => ({ name, description, inputSchema });
const font = o({ family: s({ minLength: 1, maxLength: 200 }), url: s(), dataUrl: s(), weight: {}, style: e(['normal', 'italic', 'oblique']), unicodeRange: s() }, ['family']);
const textStyle = TEXT_STYLE_PROPERTIES;

export const AUTOMATION_EDITOR_TOOLS = [
    tool('page', 'List, create, rename, duplicate, delete, reorder or update page guides. Returns refreshed page context. Keeps at least one page; copies remap layer and component identities.', o({ action: e(['list', 'create', 'rename', 'duplicate', 'delete', 'reorder', 'update']), pageId: id, name: title, index: i({ minimum: 0 }), properties: o({ guides: a(o({ axis: e(['x', 'y']), position: n() }, ['axis', 'position']), 200) }) }, ['action'])),
    tool('create_shape', 'Create a native editable shape with explicit geometry and inspector properties, without drawing gestures.', o({ type: e(['frame', 'group', 'rect', 'ellipse', 'polygon', 'star', 'line', 'arrow', 'pencil', 'pen', 'path', 'text', 'image', 'svg']), parentId: id, x: n(), y: n(), width: n({ minimum: 0 }), height: n({ minimum: 0 }), properties: SHAPE_PROPERTIES }, ['type'])),
    tool('edit_shapes', 'Atomically edit explicit layers using native inspector properties, structure, geometry, layout or arrangement operations. Never uses the human selection.', o({ action: e(['patch', 'group', 'ungroup', 'frame', 'mask', 'unmask', 'align', 'distribute', 'tidy', 'order', 'flip', 'translate', 'resize', 'rotate', 'layout']), ids, properties: SHAPE_PROPERTIES, alignment: e(['left', 'right', 'top', 'bottom', 'h-center', 'v-center']), axis: e(['h', 'v']), gap: n(), columns: i({ minimum: 1, maximum: 200 }), mode: e(['front', 'back', 'forward', 'backward', 'alpha', 'luminance', 'vector']), dx: n(), dy: n(), width: n({ minimum: 0 }), height: n({ minimum: 0 }), angle: n(), origin: point, layout: {}, maskId: id, parentId: id, clipContent: b, fills: a(json, 100), name: title }, ['action', 'ids'])),
    tool('edit_text', 'Edit rich text ranges and paragraph styles, or find and replace text while preserving unaffected runs.', o({ id, action: e(['replace', 'range_style', 'paragraph_style', 'find_replace']), revision: i({ minimum: 0 }), range: o({ start: i({ minimum: 0 }), end: i({ minimum: 0 }) }, ['start', 'end']), text: s(), find: s({ minLength: 1 }), replace: s(), style: textStyle, caseSensitive: b, wholeWord: b, all: b }, ['id', 'action'])),
    tool('styles', 'Manage shared paint, text and effect styles; inspect users, apply and detach styles.', o({ action: e(['list', 'get', 'create', 'update', 'duplicate', 'delete', 'apply', 'detach', 'users']), id, ids, type: e(['paint', 'text', 'effect']), name: title, description: s({ maxLength: 10000 }), value: {}, patch: o({ name: title, description: s({ maxLength: 10000 }), value: {} }), kind: e(['fill', 'stroke', 'text', 'effect']), query: s() }, ['action'])),
    tool('libraries', 'Manage embedded component library snapshots, enable or unlink them, insert instances and export snapshots.', o({ action: e(['list', 'get', 'add', 'update', 'enable', 'remove', 'insert', 'export']), id, snapshot: json, enabled: b, componentId: id, parentId: id, x: n(), y: n() }, ['action'])),
    tool('document_assets', 'Manage embedded images, SVG and font assets. Sources must be embedded data URLs; no implicit filesystem or network fetch.', o({ action: e(['list', 'add', 'remove', 'place']), id, kind: e(['image', 'svg', 'font']), dataUrl: s(), name: s({ minLength: 1, maxLength: 240 }), faces: a(font, 100, 1), family: s({ minLength: 1, maxLength: 200 }), weight: {}, fontStyle: e(['normal', 'italic', 'oblique']), unicodeRange: s(), mimeType: s(), parentId: id, x: n(), y: n(), width: n({ minimum: 0 }), height: n({ minimum: 0 }), query: s() }, ['action'])),
    tool('clipboard', 'Copy or cut native layers and properties to a private agent clipboard or explicit transferable payload; paste in place, at coordinates or replacing explicit layers. Does not read the system clipboard.', o({ action: e(['copy', 'cut', 'paste', 'copy_properties', 'paste_properties']), ids, payload: json, mode: e(['normal', 'in_place', 'replace']), x: n(), y: n(), parentId: id }, ['action'])),
    tool('view', 'Read or set canvas viewport, selection, tool and display flags, or fit explicit layers. Changes are targeted to this document.', o({ action: e(['get', 'set', 'select', 'tool', 'fit']), viewport: o({ vport: o({ width: n({ exclusiveMinimum: 0 }), height: n({ exclusiveMinimum: 0 }) }, ['width', 'height']), vbox: rect, zoom: n({ minimum: 0.01, maximum: 256 }) }, ['vport', 'vbox', 'zoom']), ids: a(id), tool: e(['move', 'frame', 'rect', 'ellipse', 'polygon', 'star', 'line', 'arrow', 'pencil', 'pen', 'text']), flags: o(Object.fromEntries(['showOutlines', 'uiHidden', 'pixelSnap', 'showRulers', 'showGrids', 'multiSelect', 'snapping'].map(key => [key, b]))) }, ['action'])),
    tool('export_selection', 'Export explicit layers as SVG, PNG, JPG, WebP, PDF, HTML or editable JSON. Returns typed content or base64; no save dialog.', o({ format: e(['svg', 'png', 'jpg', 'webp', 'pdf', 'json', 'html']), ids, scale: n({ minimum: 0.01, maximum: 16 }), quality: n({ minimum: 0, maximum: 1 }), bounds: rect, background: s(), omitFill: b, constraint: o({ type: e(['scale', 'width', 'height']), value: n({ minimum: 0.01 }) }) }, ['format', 'ids'])),
    tool('redo', 'Redo only an edit previously undone by this agent, without consuming another user or agent history.', o()),
] as const;

export const AUTOMATION_WORKSPACE_TOOLS = [
    tool('workspace', 'Inspect tabs, focus or close an explicit document, show the library, inspect public connection/app information, control the app window or request a saved quit. Closing may release only this caller’s binding.', o({ action: e(['state', 'focus', 'close', 'show_library', 'connection', 'about', 'window', 'quit', 'capabilities', 'sample_color']), documentId, release: b, transport: e(['http', 'stdio']), fullscreen: b, visible: b, hideOthers: b, devTools: b, x: n(), y: n(), displayId: id }, ['action'])),
    tool('preferences', 'Read or update display name, library view and an explicit document favorite.', o({ action: e(['get', 'set']), name: s({ minLength: 1, maxLength: 40 }), view: e(['grid', 'list']), documentId, starred: b }, ['action'])),
    tool('save_document', 'Flush and durably save an explicit canvas without changing the visible tab.', o({ id: documentId }, ['id'])),
    tool('delete_document', 'Delete an unused canvas only when expectedTitle matches. Close and release its agent binding first; other agents or collaborators prevent deletion.', o({ id: documentId, expectedTitle: title }, ['id', 'expectedTitle'])),
    tool('import_document', 'Import .omc or canvas JSON from a bounded payload or explicit absolute local file path; .fig and .sketch require filePath without a dialog. Opening stays in the background by default.', o({ format: e(['omc', 'json', 'fig', 'sketch']), mode: e(['merge', 'copy']), payload: s(), filePath: s({ minLength: 1, maxLength: 4096 }), title, focus: b }, ['format'])),
    tool('export_document', 'Export a targeted canvas to typed content or an explicit absolute file path. Existing files are preserved unless overwrite is explicitly true.', o({ id: documentId, format: e(['omc', 'json', 'svg', 'png', 'jpg', 'webp', 'pdf', 'html']), filePath: s({ minLength: 1, maxLength: 4096 }), overwrite: b, ids, scale: n({ minimum: 0.01, maximum: 16 }), quality: n({ minimum: 0, maximum: 1 }), bounds: rect, background: s(), omitFill: b, constraint: o({ type: e(['scale', 'width', 'height']), value: n({ minimum: 0.01 }) }) }, ['id', 'format'])),
    tool('import_resource', 'Import an image, SVG, font or library snapshot from an explicit bounded local file into a targeted canvas. Uses no file dialog or HTTP body expansion.', o({ documentId, kind: e(['image', 'svg', 'font', 'library']), filePath: s({ minLength: 1, maxLength: 4096 }), name: s({ minLength: 1, maxLength: 240 }), family: s({ minLength: 1, maxLength: 200 }), weight: {}, fontStyle: e(['normal', 'italic', 'oblique']), unicodeRange: s() }, ['documentId', 'kind', 'filePath'])),
    tool('collaboration', 'Inspect, host, create invitations, join or leave an explicitly targeted collaboration session. Network actions happen only when requested; invitations grant edit access.', o({ action: e(['status', 'host', 'invite', 'join', 'leave', 'cursor']), documentId, invite: s({ minLength: 1, maxLength: 16000 }), address: s({ minLength: 1, maxLength: 300 }), port: i({ minimum: 0, maximum: 65535 }), name: s({ minLength: 1, maxLength: 40 }), focus: b, cursor: o({ x: n(), y: n(), page: id, selection: a(id) }, ['x', 'y', 'page']) }, ['action', 'documentId'])),
] as const;

export function validateAutomationArgs(name: string, args: Data): string | null {
    const requirements: Record<string, Record<string, string[]>> = {
        page: { rename: ['pageId', 'name'], duplicate: ['pageId'], delete: ['pageId'], reorder: ['pageId', 'index'], update: ['pageId', 'properties'] },
        edit_shapes: { patch: ['properties'], align: ['alignment'], distribute: ['axis'], order: ['mode'], flip: ['axis'], translate: ['dx', 'dy'], resize: ['width', 'height'], rotate: ['angle'], layout: ['layout'] },
        edit_text: { replace: ['text'], range_style: ['range', 'style'], paragraph_style: ['style'], find_replace: ['find', 'replace'] },
        styles: { get: ['id'], create: ['type', 'name', 'value'], update: ['id', 'patch'], duplicate: ['id'], delete: ['id'], apply: ['id', 'ids'], detach: ['ids'], users: ['id'] },
        libraries: { get: ['id'], add: ['snapshot'], update: ['id', 'snapshot'], enable: ['id', 'enabled'], remove: ['id'], insert: ['id', 'componentId'], export: ['id'] },
        document_assets: { add: ['kind', 'name'], remove: ['id'], place: ['id'] },
        clipboard: { copy: ['ids'], cut: ['ids'], copy_properties: ['ids'], paste_properties: ['ids'] },
        view: { select: ['ids'], tool: ['tool'] },
        workspace: { focus: ['documentId'], close: ['documentId'], sample_color: ['x', 'y'] },
        collaboration: { invite: ['address'], join: ['invite'] },
    };
    for (const key of requirements[name]?.[args.action] ?? [])
        if (args[key] === undefined) return `${args.action} requires ${key}`;
    if (name === 'clipboard' && args.action === 'paste' && args.mode === 'replace' && !args.ids?.length) return 'Paste replace requires explicit ids';
    if (name === 'import_document' && (typeof args.payload === 'string') === (typeof args.filePath === 'string')) return 'Supply exactly one payload or filePath';
    if (name === 'import_document' && ['fig', 'sketch'].includes(args.format) && !args.filePath) return 'Design imports require filePath';
    if (name === 'document_assets' && args.action === 'add' && !args.dataUrl && !args.faces) return 'add requires dataUrl or faces';
    if (name === 'preferences' && (args.starred !== undefined) !== (args.documentId !== undefined)) return 'starred and documentId must be supplied together';
    if (name === 'edit_text' && args.range && args.range.end < args.range.start) return 'Text range end must follow start';
    if (name === 'edit_shapes' && args.action === 'order' && !['front', 'back', 'forward', 'backward'].includes(args.mode)) return 'order requires an ordering mode';
    if (name === 'edit_shapes' && args.action === 'mask' && args.mode && !['alpha', 'luminance', 'vector'].includes(args.mode)) return 'mask requires alpha, luminance or vector mode';
    return null;
}
