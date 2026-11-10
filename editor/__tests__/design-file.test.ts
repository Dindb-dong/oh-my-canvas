import {describe,it,expect} from 'vitest';
import {zipSync,strToU8} from 'fflate';
import {figFixture,sketchFixture} from './fixtures/design-files';
import {importDesignFile,DESIGN_FILE_LIMIT} from '../formats/design-file';
import {validateImportedDocument} from '../mcp/import-document';
import {imageSource,referencedAssets} from '../images/assets';
import {exportCanvasJson,importCanvasJson} from '../formats/canvas';

const layers=(doc:any)=>Object.values<any>(doc.pagesById[doc.pages[0]].objects);
describe('native design files',()=>{
    it.each([false,true])('decodes actual Kiwi binary with ZIP and raw containers (zstd=%s)',zstd=>{
        const fixture=figFixture(zstd);
        for(const bytes of [fixture.binary,fixture.zip]){
            const {document,warnings}=importDesignFile(bytes,'fig');validateImportedDocument(document);
            expect(document.pages).toHaveLength(1);expect(layers(document).map(s=>s.name)).toContain('Circle');
            const title=layers(document).find(s=>s.name==='Title');expect([title.x,title.y]).toEqual([110,215]);expect(title.content.children[0].children[0]).toMatchObject({text:'Hello 한글',fontFamily:'Arial',fontSize:20,fontWeight:700});
            expect(layers(document).find(s=>s.name==='Vector').content).toHaveLength(4);
            expect(warnings).toEqual([]);
        }
    });
    it('imports all Sketch pages and nested editable geometry, and survives canvas round trip',()=>{
        const {document,warnings}=importDesignFile(sketchFixture(),'sketch');validateImportedDocument(document);
        expect(document.pages.map(id=>document.pagesById[id].name)).toEqual(['Screen','Second']);
        const title=layers(document).find(s=>s.name==='Title');expect([title.x,title.y]).toEqual([110,215]);
        expect(title.content.children[0].children[0].text).toBe('Hello 한글');
        expect(layers(document).find(s=>s.name==='Triangle').content).toHaveLength(5);
        const roundTrip=importCanvasJson(exportCanvasJson(document));validateImportedDocument(roundTrip);expect(layers(roundTrip).find(s=>s.name==='Title').content).toEqual(title.content);expect(warnings).toEqual([]);
    });
    it('imports embedded bitmap bytes without retaining local paths',()=>{
        const png=Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==','base64'));
        const bytes=zipSync({'document.json':strToU8('{"pages":[{"_ref":"pages/one"}]}'),'pages/one.json':strToU8(JSON.stringify({layers:Array.from({length:3},()=>({_class:'bitmap',frame:{width:10,height:10},image:{_ref:'images/a.png'}}))})),'images/a.png':png});
        const {document}=importDesignFile(bytes,'sketch');validateImportedDocument(document);const image=layers(document).find(s=>s.type==='image').image;expect(document.assets[image.assetId].src).toMatch(/^data:image\/png;base64,/);expect(Object.keys(document.assets)).toHaveLength(1);expect(layers(document).filter(s=>s.type==='image').every(s=>s.image.assetId===image.assetId)).toBe(true);expect(imageSource(image,document.assets)).toBe(document.assets[image.assetId].src);expect(referencedAssets(layers(document),document.assets)).toEqual(document.assets);const again=importCanvasJson(exportCanvasJson(document));expect(again.assets[image.assetId]).toEqual(document.assets[image.assetId]);
    });
    it('rejects malformed, missing, oversized and traversal archives before importing',()=>{
        expect(()=>importDesignFile(new Uint8Array(DESIGN_FILE_LIMIT+1),'fig')).toThrow(/256 MiB/);
        expect(()=>importDesignFile(strToU8('{}'),'fig')).toThrow(/Figma/);
        expect(()=>importDesignFile(zipSync({'other.json':strToU8('{}')}),'sketch')).toThrow(/Sketch/);
        expect(()=>importDesignFile(zipSync({'document.json':strToU8('{"pages":[{"_ref":"pages/missing"}]}')}),'sketch')).toThrow(/Missing/);
        expect(()=>importDesignFile(sketchFixture({'../outside':strToU8('x')}),'sketch')).toThrow(/path/);
        const oversized=zipSync({'large':new Uint8Array(1)});const central=oversized.findIndex((_,i)=>oversized[i]===80&&oversized[i+1]===75&&oversized[i+2]===1&&oversized[i+3]===2);new DataView(oversized.buffer).setUint32(central+24,DESIGN_FILE_LIMIT+1,true);expect(()=>importDesignFile(oversized,'sketch')).toThrow(/expanded/);
        const fixture=figFixture().binary;expect(()=>importDesignFile(fixture.subarray(0,fixture.length-3),'fig')).toThrow(/Truncated/);
    });
    it('rejects negative dimensions and excessive hierarchy depth',()=>{
        const make=(layers:any[])=>zipSync({'document.json':strToU8('{"pages":[{"_ref":"pages/one"}]}'),'pages/one.json':strToU8(JSON.stringify({layers}))});
        expect(()=>importDesignFile(make([{_class:'rectangle',frame:{width:-1,height:1}}]),'sketch')).toThrow(/dimensions/);
        let n:any={_class:'rectangle',frame:{width:1,height:1}};for(let i=0;i<102;i++)n={_class:'group',layers:[n]};
        expect(()=>importDesignFile(make([n]),'sketch')).toThrow(/deep/);
    });
});
