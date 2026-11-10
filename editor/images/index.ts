import {imageSource} from './assets';
import type { Data, EditorStore, Operation } from '../contracts';
import { clone, isEditable } from '../document';

export interface BackgroundImage {src:string;width:number;height:number;mimeType:'image/png';}
export function createImageService(editor:EditorStore, options:{removeBackground?:(src:string,signal?:AbortSignal)=>Promise<BackgroundImage>}={}) {
    let busy=false;
    const lifetime=new AbortController();
    const imageShape=(id:string)=>{
        const shape=editor.page.objects[id];
        if(!shape||shape.type!=='image'||!imageSource(shape.image,editor.doc.assets))throw Error('Select a raster image');
        if(!isEditable(editor.page,id))throw Error('The image or its parent is locked');
        return shape;
    };
    return {
        available:typeof options.removeBackground==='function',
        destroy(){lifetime.abort(Error('Editor closed'));},
        async removeBackground(id:string,operation:Operation|string='Remove image background',signal?:AbortSignal) {
            const activeSignal=signal?AbortSignal.any([signal,lifetime.signal]):lifetime.signal;
            activeSignal.throwIfAborted();
            if(!options.removeBackground)throw Error('Local background removal is unavailable in this editor');
            if(busy)throw Error('Background removal is already running');
            const shape=imageShape(id),snapshot=editor.doc,pageId=editor.pageId,original=clone(shape.image);
            if(editor.activeSession||editor.inTransaction)throw Error('Finish the current edit first');
            busy=true;
            try {
                const result=await options.removeBackground(imageSource(original,editor.doc.assets),activeSignal);
                activeSignal.throwIfAborted();
                if(editor.doc!==snapshot||editor.pageId!==pageId||editor.activeSession||editor.inTransaction)throw Error('The document changed during background removal. Please retry.');
                imageShape(id);
                if(result.mimeType!=='image/png'||!/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(result.src)||!Number.isSafeInteger(result.width)||!Number.isSafeInteger(result.height)||result.width<=0||result.height<=0||result.width*result.height>16000000)throw Error('Background removal returned an invalid image');
                editor.transact(operation,doc=>{
                    const target=doc.pagesById[pageId].objects[id];
                    target.originalImage??=original;
                    target.image={...target.image,...result};
                });
            } finally {busy=false;}
        },
        restore(id:string,operation:Operation|string='Restore original image') {
            lifetime.signal.throwIfAborted();
            const shape=imageShape(id);
            if(!shape.originalImage)return;
            if(editor.activeSession||editor.inTransaction)throw Error('Finish the current edit first');
            editor.transact(operation,doc=>{
                const target=doc.pagesById[editor.pageId].objects[id];
                target.image=clone(target.originalImage as Data);
                delete target.originalImage;
            });
        },
    };
}
