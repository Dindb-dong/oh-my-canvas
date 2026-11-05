import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { create } from 'fontkit';
import decompress from 'wawoff2/decompress.js';
import { outlineStroke, outlineText, glyphSegments } from '../render/outline';
import { pathBounds } from '../geometry';
import { createCommands } from '../commands';
import { Editor, createDocument, createShape, insertShape } from '../document';
import type { TextFragment } from '../render/scene';

const wasmUrl = resolve('node_modules/canvaskit-wasm/bin/full/canvaskit.wasm');
const latinFile = 'node_modules/@fontsource-variable/ibm-plex-sans/files/ibm-plex-sans-latin-wght-normal.woff2';
const fragment = (text: string, width: number, style = {}): TextFragment => ({ text, x: 10, y: 20, baseline: 58, width, height: 48, paragraph: 0, style: { fontFamily: 'IBM Plex Sans', fontWeight: '600', fontSize: '48px', fontStyle: 'normal', color: '#123456', letterSpacing: '2px', ...style } });
afterEach(() => vi.unstubAllGlobals());
describe('editable vector outlines', () => {
    it('uses exact font quadratic conversion and retains separate closed contours', () => {
        const segments = glyphSegments([{command:'moveTo',args:[0,0]}, {command:'quadraticCurveTo',args:[3,6,6,0]}, {command:'closePath',args:[]}, {command:'moveTo',args:[1,1]}, {command:'lineTo',args:[2,1]}, {command:'closePath',args:[]}], 10, 20, 2);
        expect(segments[1]).toEqual({command:'curve',x1:14,y1:12,x2:18,y2:12,x:22,y:20});
        expect(segments.filter(s=>s.command==='close')).toHaveLength(2);
    });
    it('outlines actual round strokes into closed cubic paths with expected bounds', async () => {
        const source = createShape('path', { content: [{command:'move',x:10,y:10},{command:'line',x:110,y:10}], fills:[], strokes:[{color:'#f00',width:12,cap:'round'}] });
        const [part] = await outlineStroke(source, {wasmUrl});
        expect(part.segments.some(s=>s.command==='curve')).toBe(true);
        expect(part.segments.at(-1)?.command).toBe('close');
        const box=pathBounds(part.segments);
        expect(box.x).toBeCloseTo(4,3);expect(box.y).toBeCloseTo(4,3);
        expect(box.width).toBeCloseTo(112,3);expect(box.height).toBeCloseTo(12,3);
        expect(part.fills).toEqual([{color:'#f00'}]);
    });
    it('rejects unsupported stroke appearance without mutating its source', async () => {
        const source=createShape('path',{strokes:[{color:'#000',width:3,dashes:[2,2]}]});
        const before=structuredClone(source);
        await expect(outlineStroke(source,{wasmUrl})).rejects.toThrow('centered solid');
        expect(source).toEqual(before);
    });
    it('extracts real variable WOFF2 glyphs with kerning, spacing and weight', async () => {
        const bytes=await readFile(latinFile),font=create(await decompress(bytes)).getVariation({wght:600});
        const width=font.layout('Logo AV',{liga:false,clig:false}).advanceWidth*48/font.unitsPerEm+14;
        vi.stubGlobal('fetch',vi.fn(async()=>new Response(bytes)));
        const [part]=await outlineText(createShape('text'),[fragment('Logo AV',width)],[{family:'IBM Plex Sans',url:'font.woff2',weight:'100 900'}]);
        expect(part.segments.filter(s=>s.command==='move').length).toBeGreaterThan(6);
        expect(part.segments.filter(s=>s.command==='close').length).toBeGreaterThan(6);
        expect(pathBounds(part.segments).width).toBeGreaterThan(150);
        expect(part.fills).toEqual([{color:'#123456'}]);
    });
    it('selects an actual italic face before equal-weight normal faces and rejects synthetic italics', async () => {
        const bytes=await readFile('node_modules/@fontsource-variable/ibm-plex-sans/files/ibm-plex-sans-latin-wght-italic.woff2');
        const font=create(await decompress(bytes)).getVariation({wght:600}),width=font.layout('Logo').advanceWidth*48/font.unitsPerEm;
        const fetch=vi.fn(async()=>new Response(bytes));vi.stubGlobal('fetch',fetch);
        const actual=fragment('Logo',width,{fontStyle:'italic',letterSpacing:'0px'});
        const faces=[{family:'IBM Plex Sans',url:'normal.woff2',weight:'100 900',style:'normal'},{family:'IBM Plex Sans',url:'italic.woff2',weight:'100 900',style:'italic'}];
        const [part]=await outlineText(createShape('text'),[actual],faces);
        expect(part.segments.length).toBeGreaterThan(20);
        expect(fetch.mock.calls[0][0]).toBe('italic.woff2');
        await expect(outlineText(createShape('text'),[actual],[faces[0]])).rejects.toThrow('Synthetic font styles');
    });
    it('honors named normal/bold face descriptors and rejects undeclared synthetic weights', async () => {
        const bytes=await readFile(latinFile),font=create(await decompress(bytes)).getVariation({wght:700});
        const width=font.layout('Logo').advanceWidth*48/font.unitsPerEm;
        const fetch=vi.fn(async()=>new Response(bytes));vi.stubGlobal('fetch',fetch);
        const bold=fragment('Logo',width,{fontWeight:'700',letterSpacing:'0px'});
        const faces=[{family:'IBM Plex Sans',url:'normal.woff2',weight:'normal'},{family:'IBM Plex Sans',url:'bold.woff2',weight:'bold'}];
        await outlineText(createShape('text'),[bold],faces);
        expect(fetch.mock.calls[0][0]).toBe('bold.woff2');
        await expect(outlineText(createShape('text'),[bold],[faces[0]])).rejects.toThrow('Synthetic font weights');
    });
    it('resolves Korean WOFF2 subset glyphs from the actual font file', async () => {
        const folder='node_modules/@fontsource-variable/noto-sans-kr/files';
        let bytes: Uint8Array|undefined, font: ReturnType<typeof create>|undefined;
        for(const file of (await readdir(folder)).filter(file=>file.endsWith('.woff2'))){
            const candidate=await readFile(`${folder}/${file}`), parsed=create(candidate);
            if(parsed.hasGlyphForCodePoint('가'.codePointAt(0)!)){bytes=candidate;font=create(await decompress(candidate)).getVariation({wght:400});break;}
        }
        expect(bytes).toBeDefined();
        vi.stubGlobal('fetch',vi.fn(async()=>new Response(bytes)));
        const width=font!.layout('가').advanceWidth*48/font!.unitsPerEm;
        const [part]=await outlineText(createShape('text'),[fragment('가',width,{fontFamily:'Noto Sans KR',fontWeight:'400',letterSpacing:'0px'})],[{family:'Noto Sans KR',url:'korean.woff2',weight:'100 900'}]);
        expect(part.segments.filter(s=>s.command==='close').length).toBeGreaterThan(1);
    });
    it('rejects unavailable font files and mismatched shaping instead of substituting', async () => {
        await expect(outlineText(createShape('text'),[fragment('A',50)],[])).rejects.toThrow('actual font file');
        vi.stubGlobal('fetch',vi.fn(async()=>new Response(await readFile(latinFile))));
        await expect(outlineText(createShape('text'),[fragment('A',500)],[{family:'IBM Plex Sans',url:'font.woff2',weight:'100 900'}])).rejects.toThrow('shaping differs');
    });
});
function fixture(outline: (...args:any[])=>any) {
    const doc=createDocument(),page=doc.pagesById[doc.pages[0]],source=createShape('text',{id:'source',x:10,y:20,width:200,height:60,name:'Wordmark'});
    insertShape(page,source);const editor=new Editor(doc);editor.setSelection(['source']);
    return {editor,commands:createCommands(editor,{outline})};
}
const parts=[{segments:[{command:'move',x:10,y:20},{command:'line',x:30,y:20},{command:'line',x:30,y:40},{command:'close'}],fills:[{color:'#000'}]}];
describe('outline transactions',()=>{
    it('keeps the original hidden, preserves text layout box and restores both with one undo',async()=>{
        const {editor,commands}=fixture(async()=>parts);
        const ids=await commands.run('text.outline',{author:'agent',operationId:'outline-op'}) as string[];
        expect(editor.page.objects.source.hidden).toBe(true);
        expect(editor.page.objects[ids[0]]).toMatchObject({type:'frame',x:10,y:20,width:200,height:60,outlineSourceId:'source'});
        expect(editor.page.objects[ids[0]].childIds).toHaveLength(1);
        editor.undoStep();expect(editor.page.objects.source.hidden).not.toBe(true);expect(editor.page.objects[ids[0]]).toBeUndefined();
    });
    it('preserves a first-child vector mask while keeping the original editable',async()=>{
        const {editor,commands}=fixture(async()=>parts);
        editor.transact('Mask',doc=>{
            const page=doc.pagesById[editor.pageId],mask=createShape('group',{id:'mask',childIds:[],isMaskGroup:true,maskType:'vector'});
            insertShape(page,mask);
            page.objects.root.childIds=page.objects.root.childIds!.filter(id=>id!=='source');
            page.objects.source.parentId='mask';mask.childIds=['source'];
        });
        const ids=await commands.run('text.outline',{id:'source'}) as string[];
        expect(editor.page.objects.mask.childIds).toEqual([ids[0],'source']);
        expect(editor.page.objects[ids[0]].type).toBe('group');
        expect(editor.page.objects.source.hidden).toBe(true);
    });
    it('does not commit stale, cancelled, locked or active-session requests',async()=>{
        const {editor,commands}=fixture(async()=>{editor.transact('Concurrent change',doc=>{doc.name='Changed';});return parts;});
        await expect(commands.run('text.outline')).rejects.toThrow('Document changed');expect(editor.page.objects.source.hidden).not.toBe(true);
        const cancelled=fixture(async()=>parts),controller=new AbortController();controller.abort();
        await expect(cancelled.commands.run('text.outline',{signal:controller.signal})).rejects.toThrow();
        cancelled.editor.transact('Lock',doc=>{doc.pagesById[cancelled.editor.pageId].objects.source.locked=true;});
        await expect(cancelled.commands.run('text.outline',{id:'source'})).rejects.toThrow('editable');
        const active=fixture(async()=>parts);active.editor.begin('Editing');
        expect(active.commands.run('text.outline',{id:'source'})).toBe(false);active.editor.cancelSession();
    });
});
