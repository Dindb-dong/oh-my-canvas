import {describe,it,expect} from 'vitest';
import {zipSync,strToU8,deflateSync} from 'fflate';
import {parseFigBinary,encodeFigParts,assembleCanvasFig} from 'openfig-core';
import {figFixture,sketchFixture} from './fixtures/design-files';
import {importDesignFile,importDesignFileProgressively,type DesignImportBatch,type DesignImportManifest} from '../formats/design-file';
import {validateDocument} from '../document';
import {validateImportedDocument} from '../mcp/import-document';
import {importCanvasJson} from '../formats/canvas';

const rectangle=(index=0)=>({_class:'rectangle',name:`Rectangle ${index}`,do_objectID:`rectangle-${index}`,frame:{width:10,height:10}});
const sketchPages=(layers:any[][],files:Record<string,Uint8Array>={})=>zipSync({
    'document.json':strToU8(JSON.stringify({pages:layers.map((_,index)=>({_ref:`pages/${index}`}))})),
    ...Object.fromEntries(layers.map((rows,index)=>[`pages/${index}.json`,strToU8(JSON.stringify({name:`Page ${index}`,do_objectID:`page-${index}`,layers:rows}))])),...files,
});
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return {promise,resolve};};

describe('progressive native design conversion',()=>{
    it('publishes a stable manifest and one validated first page before awaiting the consumer',async()=>{
        const delivered:DesignImportBatch[]=[],first=deferred(),release=deferred();let manifest!:DesignImportManifest;
        const done=importDesignFileProgressively(sketchFixture(),'sketch',{
            onManifest(value){manifest=value;expect(delivered).toHaveLength(0);},
            async onBatch(batch){
                validateImportedDocument(batch.document);validateDocument(batch.document);
                // This importer already emits the editor's canonical format.
                expect(importCanvasJson(batch.document)).toEqual(batch.document);
                delivered.push(batch);
                if(batch.sequence===1){first.resolve();await release.promise;}
            },
        });
        await first.promise;
        expect(manifest.pages.map(p=>p.name)).toEqual(['Screen','Second']);
        expect(delivered).toHaveLength(1);expect(delivered[0].document.pages).toHaveLength(1);
        expect(delivered[0].completedPages).toBe(1);
        await new Promise(resolve=>setTimeout(resolve,20));expect(delivered).toHaveLength(1);
        release.resolve();const summary=await done;
        expect(delivered.flatMap(batch=>batch.pageIds)).toEqual(manifest.pages.map(p=>p.id));
        expect(delivered.map(batch=>batch.sequence)).toEqual([1,2]);
        expect(summary).toMatchObject({complete:true,pageCount:2,objectCount:7,assetCount:0});
        expect(summary.timings.consumerWait).toBeGreaterThanOrEqual(15);
        expect(summary.timings.firstPageReady).toBeLessThanOrEqual(summary.timings.total);
        expect(summary).not.toHaveProperty('document');
    });

    it('groups small pages while keeping an oversized page complete and alone',async()=>{
        const rows=[1,1,7,1,1,1,1].map(count=>Array.from({length:count},(_,index)=>rectangle(index)));
        const batches:DesignImportBatch[]=[];
        await importDesignFileProgressively(sketchPages(rows),'sketch',{batchObjects:6,onBatch(batch){batches.push(batch);}});
        expect(batches.map(batch=>batch.pageIds.length)).toEqual([1,1,1,3,1]);
        expect(batches[2].document.pagesById[batches[2].pageIds[0]].objects).toSatisfy(objects=>Object.keys(objects).length===8);
        const byPages:DesignImportBatch[]=[];
        await importDesignFileProgressively(sketchPages(rows.map(()=>[rectangle()])),'sketch',{onBatch(batch){byPages.push(batch);}});
        expect(byPages.map(batch=>batch.pageIds.length)).toEqual([1,4,2]);
    });

    it('resolves a first-page Figma instance from a later page before publishing it',async()=>{
        const fig=parseFigBinary(figFixture().binary),canvas=fig.nodes.find(n=>n.type==='CANVAS')!;
        const node=(id:number,type:string,name:string,parent:number)=>({guid:{sessionID:0,localID:id},type,name,parentIndex:{guid:{sessionID:0,localID:parent},position:String(id)},size:{x:50,y:50},transform:{m00:1,m01:0,m02:0,m10:0,m11:1,m12:0}});
        fig.message.nodeChanges.push({...canvas,guid:{sessionID:0,localID:100},name:'Components',parentIndex:{...canvas.parentIndex!,position:'z'}},
            node(101,'SYMBOL','Master',100),node(102,'RECTANGLE','Shared child',101),
            {...node(7,'INSTANCE','First page instance',1),symbolData:{symbolID:{sessionID:0,localID:101}}});
        const parts=encodeFigParts(fig),binary=assembleCanvasFig({...parts,messageCompressed:deflateSync(parts.messageRaw)}),batches:DesignImportBatch[]=[];
        await importDesignFileProgressively(binary,'fig',{onBatch(batch){batches.push(batch);}});
        const page=batches[0].document.pagesById[batches[0].pageIds[0]],instance=Object.values(page.objects).find(s=>s.name==='First page instance')!;
        expect(instance.childIds).toHaveLength(1);
        expect(page.objects[instance.childIds![0]]).toMatchObject({name:'Shared child',importSource:{nodeId:'0:102'},parentId:instance.id});
        expect(batches[0].warnings.some(w=>w.includes('ordinary layers'))).toBe(true);
        expect(batches[0].document.components).toEqual({});
        expect(batches[1].document.pagesById[batches[1].pageIds[0]].name).toBe('Components');
    });

    it('declares shared raster dependencies in every batch and sends their bytes once',async()=>{
        const png=Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==','base64'));
        const bitmap={_class:'bitmap',frame:{width:10,height:10},image:{_ref:'images/a.png'}},batches:DesignImportBatch[]=[];
        const input=sketchPages([[bitmap],[bitmap],[bitmap]],{'images/a.png':png});
        const summary=await importDesignFileProgressively(input,'sketch',{binaryAssets:true,batchPages:1,onBatch(batch){batches.push(batch);}});
        expect(batches.map(b=>b.blobs!.length)).toEqual([1,0,0]);
        const asset=Object.values(batches[0].document.assets!)[0];
        expect(batches.every(b=>Object.values(b.document.assets!)[0]===asset)).toBe(true);
        expect(asset.src).toMatch(/^omc-asset:sha256:/);expect(batches[0].blobs![0].bytes).toEqual(png);
        expect(summary.assetCount).toBe(1);
        const complete=importDesignFile(input,'sketch',{binaryAssets:true});
        expect(complete.document.assets).toEqual(batches[0].document.assets);
        expect(complete.document.pages).toHaveLength(3);
    });

    it('rejects a later malformed page after delivering only the valid first page',async()=>{
        const pages:DesignImportBatch[]=[];
        await expect(importDesignFileProgressively(sketchPages([[rectangle()],[{...rectangle(),frame:{width:-1,height:10}}]]),'sketch',{
            onBatch(batch){pages.push(batch);},
        })).rejects.toThrow(/dimensions/);
        expect(pages).toHaveLength(1);validateDocument(pages[0].document);
    });

    it('cancels a suspended callback without converting later pages or reporting completion',async()=>{
        const controller=new AbortController(),first=deferred(),release=deferred(),batches:DesignImportBatch[]=[];
        const done=importDesignFileProgressively(sketchFixture(),'sketch',{
            signal:controller.signal,async onBatch(batch){batches.push(batch);first.resolve();await release.promise;},
        });
        const rejected=expect(done).rejects.toThrow(/cancel requested/);
        await first.promise;controller.abort(Error('cancel requested'));await rejected;release.resolve();
        expect(batches).toHaveLength(1);validateDocument(batches[0].document);
    });

    it('propagates a consumer failure before attempting any later page',async()=>{
        let calls=0;
        await expect(importDesignFileProgressively(sketchFixture(),'sketch',{onBatch(){calls++;throw Error('durable save failed');}})).rejects.toThrow('durable save failed');
        expect(calls).toBe(1);
    });
});
