import { describe, expect, it } from 'vitest';
import { validateDesktopToolArgs, validateToolArgs, TOOLS } from '../mcp/defs';

const documentId = '12345678-1234-1234-1234-123456789abc';
describe('automation schema trust boundaries', () => {
    it.each([
        ['page', { action: 'rename', pageId: 'p' }],
        ['page', { action: 'update', pageId: 'p', properties: { guides: [{ axis: 'z', position: 4 }] } }],
        ['edit_shapes', { action: 'translate', ids: ['x'], dx: 4 }],
        ['edit_shapes', { action: 'patch', ids: ['x'], properties: { parentId: 'other' } }],
        ['edit_shapes', { action: 'patch', ids: ['x'], properties: { width: '100' } }],
        ['edit_shapes', { action: 'patch', ids: ['x'], properties: { opacity: 2 } }],
        ['edit_shapes', { action: 'patch', ids: ['x'], properties: { width: -1 } }],
        ['edit_text', { action: 'range_style', id: 'x', range: { start: 4, end: 1 }, style: {} }],
        ['styles', { action: 'update', id: 'x', patch: { type: 'effect' } }],
        ['view', { action: 'tool', tool: 'eval' }],
        ['view', { action: 'set', flags: { execute: true } }],
        ['preferences', { action: 'set', starred: true }],
        ['import_document', { format: 'json' }],
        ['import_document', { format: 'json', payload: '{}', filePath: '/tmp/a.json' }],
        ['export_document', { id: documentId, format: 'json', overwrite: 'yes' }],
        ['delete_document', { id: documentId }],
        ['collaboration', { action: 'join', documentId }],
    ] as Array<[string, any]>)('rejects malformed %s %#', (name, args) => {
        expect(validateToolArgs(name, args)).not.toBeNull();
    });
    it('supports explicit removal and validates nested alternatives', () => {
        expect(validateToolArgs('edit_shapes', { action: 'patch', ids: ['x'], properties: { layout: null, fills: [] } })).toBeNull();
        expect(validateToolArgs('edit_shapes', { action: 'patch', ids: ['x'], properties: { layout: 4 } })).not.toBeNull();
        expect(validateToolArgs('find', {})).not.toBeNull();
        expect(validateToolArgs('find', { text: '' })).toBeNull();
    });
    it('blocks document overrides inside atomic batches', () => {
        expect(validateDesktopToolArgs('batch', { documentId, ops: [{ tool: 'create_shape', args: { type: 'rect', documentId } }] })).not.toBeNull();
        expect(validateDesktopToolArgs('batch', { documentId, ops: [{ tool: 'create_shape', args: { type: 'rect', width: 20 } }] })).toBeNull();
    });
    it('keeps every public top-level schema closed', () => {
        for (const tool of TOOLS) expect(tool.inputSchema.additionalProperties, tool.name).toBe(false);
    });
});
