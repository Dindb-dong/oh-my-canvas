import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {importDesignFile} from '../formats/design-file';
import {figFixture,sketchFixture} from './fixtures/design-files';
import { describe, expect, it, vi } from 'vitest';
import { validateImportedDocument } from '../mcp/import-document';
import { importCanvasJson, exportCanvasJson } from '../formats/canvas';
import { createDocument, createShape, insertShape } from '../document';
import { createWorkspaceTools } from '../../electron/workspace-tools.mjs';
import { Replica } from '../../core/replica.mjs';
import { encodeFile } from '../../core/storage.mjs';

function native() {
    const document = createDocument();
    const page = document.pagesById[document.pages[0]];
    insertShape(page, createShape('rect', { id: 'shape', x: 10, y: 20, width: 100, height: 80 }), 'root');
    return document;
}
function host() {
    const converter = vi.fn(importCanvasJson), load = vi.fn(), create = vi.fn();
    const invoke = createWorkspaceTools({ importCanvasJson: converter, validateImportedDocument, manager: { load, create } });
    return { converter, load, create, call: (format: string, payload: string) => invoke({ name: 'import_document', args: { format, payload }, agent: 'test' }) };
}

describe('MCP imported document boundary', () => {
    it('rejects primitive counts before calling the converter or factory', async () => {
        const document = native(), page = document.pagesById[document.pages[0]];
        Object.assign(page.objects.shape, { type: 'path', content: undefined, primitive: { kind: 'star', count: 1e9 } });
        const fixture = host();
        await expect(fixture.call('json', JSON.stringify(document))).rejects.toThrow(/Primitive|primitive|count/);
        expect(fixture.converter).not.toHaveBeenCalled(); expect(fixture.create).not.toHaveBeenCalled();
        const legacy = { pages: [{ type: 'frame', width: 1000, height: 1000, children: [{ type: 'path', width: 100, height: 100, primitive: { kind: 'star', count: 1e9 } }] }] };
        await expect(fixture.call('json', JSON.stringify(legacy))).rejects.toThrow(/Primitive|primitive|count/);
        expect(fixture.converter).not.toHaveBeenCalled();
    });
    it('validates nested paints, text and resource fields before native or legacy conversion', () => {
        const document = native(), shape = document.pagesById[document.pages[0]].objects.shape;
        shape.fills = [{ gradient: { stops: 'invalid' } }];
        expect(() => validateImportedDocument(document)).toThrow(/stops|array/);
        expect(() => validateImportedDocument({ pages: [{ type: 'frame', editorStyle: { shadows: [{ blur: 'invalid' }] } }] })).toThrow(/blur|number/);
        const textDocument = native();textDocument.pagesById[textDocument.pages[0]].objects.shape.content = { children: [{ children: [{ text: 'Text', fontSize: 'invalid' }] }] };
        expect(() => validateImportedDocument(textDocument)).toThrow(/fontSize|number/);
        expect(() => validateImportedDocument({ ...native(), assets: { a: { kind: 'image', src: 'javascript:alert(1)' } } })).toThrow(/Unsafe resource/);
    });
    it('validates OMC documents before manager.load or opening an editor', async () => {
        const document = native();document.pagesById[document.pages[0]].objects.shape.fills = [{ gradient: { stops: 'invalid' } }];
        const replica = new Replica({ document });
        try {
            const payload = encodeFile({ id: crypto.randomUUID(), title: 'Unsafe nested paint', replica });
            const fixture = host();await expect(fixture.call('omc', payload)).rejects.toThrow(/stops|array/);
            expect(fixture.load).not.toHaveBeenCalled();expect(fixture.create).not.toHaveBeenCalled();
        } finally { replica.destroy(); }
    });
    it('retains unrelated metadata and valid native/legacy documents without rewriting them', () => {
        const document = native();document.customMetadata = { release: 1234567890123, nested: { arbitrary: ['retained'] } };
        const before = structuredClone(document);validateImportedDocument(document);expect(document).toEqual(before);
        const legacy = exportCanvasJson(document);validateImportedDocument(legacy);const converted = importCanvasJson(legacy);validateImportedDocument(converted);
        expect(converted.pagesById[converted.pages[0]].objects.shape.width).toBe(100);
    });
});


describe('MCP binary design imports', () => {
    it.each(['fig','sketch'])('imports %s from an explicit local file and retains every page', async format => {
        const directory = await mkdtemp(path.join(os.tmpdir(),'omc-design-mcp-'));
        try {
            const filePath = path.join(directory,'Design.'+format), bytes = format==='fig'?figFixture().zip:sketchFixture();
            await writeFile(filePath,bytes);
            const create = vi.fn(async(title,document)=>({record:{id:'imported',title,replica:{document}}}));
            const invoke = createWorkspaceTools({readDesignFile:importDesignFile,validateImportedDocument,manager:{create},context:async()=>({})});
            const result = await invoke({name:'import_document',agent:'test',args:{format,filePath}});
            expect(result.ok).toBe(true);expect(create.mock.calls[0][0]).toBe('Design');
            expect(create.mock.calls[0][1].pages).toHaveLength(format==='fig'?1:2);
            expect(create.mock.calls[0][2].focus).toBe(false);
            await expect(invoke({name:'import_document',agent:'test',args:{format,payload:'not binary'}})).rejects.toThrow(/filePath/);
            expect(create).toHaveBeenCalledTimes(1);
        } finally {await rm(directory,{recursive:true,force:true});}
    });
});
