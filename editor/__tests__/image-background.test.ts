import {describe,it,expect,vi} from 'vitest';
import {Editor,createDocument,createShape,insertShape} from '../document';
import {createImageService} from '../images';

const original={src:'data:image/png;base64,b3JpZw==',width:10,height:20,mimeType:'image/png'};
const result={src:'data:image/png;base64,cG5n',width:10,height:20,mimeType:'image/png' as const};
function fixture(removeBackground=vi.fn(async()=>result)) {
    const doc=createDocument(),page=doc.pagesById[doc.pages[0]];
    insertShape(page,createShape('image',{id:'photo',x:42,y:7,width:100,height:200,image:original}));
    const editor=new Editor(doc);
    return {editor,service:createImageService(editor,{removeBackground}),removeBackground};
}
describe('non-destructive image background removal',()=>{
    it('preserves geometry and original, restores, and undoes each operation once',async()=>{
        const {editor,service,removeBackground}=fixture();
        await service.removeBackground('photo');
        expect(removeBackground).toHaveBeenCalledWith(original.src,expect.any(AbortSignal));
        expect(editor.page.objects.photo).toMatchObject({x:42,y:7,width:100,height:200,image:result,originalImage:original});
        await service.removeBackground('photo');
        expect(editor.page.objects.photo.originalImage).toEqual(original);
        service.restore('photo');
        expect(editor.page.objects.photo.image).toEqual(original);
        expect(editor.page.objects.photo.originalImage).toBeUndefined();
        editor.undoStep();
        expect(editor.page.objects.photo.image).toEqual(result);
        editor.undoStep();
        expect(editor.page.objects.photo.image).toEqual(original);
    });
    it('rejects stale asynchronous results and concurrent requests',async()=>{
        let finish!:(value:typeof result)=>void;
        const {editor,service}=fixture(vi.fn(()=>new Promise(resolve=>finish=resolve)));
        const pending=service.removeBackground('photo');
        await expect(service.removeBackground('photo')).rejects.toThrow('already running');
        editor.transact('Move image',doc=>{doc.pagesById[editor.pageId].objects.photo.x=99;});
        finish(result);
        await expect(pending).rejects.toThrow('document changed');
        expect(editor.page.objects.photo.image).toEqual(original);
    });
    it('does not mutate locked images or failed/invalid results',async()=>{
        const {editor,service,removeBackground}=fixture();
        editor.transact('Lock',doc=>{doc.pagesById[editor.pageId].objects.photo.locked=true;});
        await expect(service.removeBackground('photo')).rejects.toThrow('locked');
        expect(removeBackground).not.toHaveBeenCalled();
        editor.undoStep();
        removeBackground.mockRejectedValueOnce(Error('No foreground subject'));
        await expect(service.removeBackground('photo')).rejects.toThrow('No foreground');
        removeBackground.mockResolvedValueOnce({...result,width:NaN});
        await expect(service.removeBackground('photo')).rejects.toThrow('invalid image');
        expect(editor.page.objects.photo.image).toEqual(original);
        expect(editor.page.objects.photo.originalImage).toBeUndefined();
    });
    it('reports unavailable backends without touching the document',async()=>{
        const {editor}=fixture(),service=createImageService(editor);
        expect(service.available).toBe(false);
        await expect(service.removeBackground('photo')).rejects.toThrow('unavailable');
    });
    it('cancels work when the caller aborts or the editor closes',async()=>{
        let finish!:(value:typeof result)=>void;
        const {editor,service}=fixture(vi.fn(()=>new Promise(resolve=>finish=resolve)));
        const controller=new AbortController();
        const pending=service.removeBackground('photo',{id:'agent-operation',author:'agent'},controller.signal);
        controller.abort(Error('Caller cancelled'));finish(result);
        await expect(pending).rejects.toThrow('Caller cancelled');
        expect(editor.page.objects.photo.originalImage).toBeUndefined();
        const closed=service.removeBackground('photo');service.destroy();finish(result);
        await expect(closed).rejects.toThrow('Editor closed');
    });
});
