import type {BackgroundImage} from './index';

export async function removeBackground(src:string,signal?:AbortSignal):Promise<BackgroundImage> {
    signal?.throwIfAborted();
    if(typeof src!=='string'||src.length>24*1024*1024||!/^data:image\/(png|jpeg|webp|gif|avif|bmp);base64,/.test(src))throw Error('Choose an embedded raster image up to 16 MiB');
    const image=new Image();image.src=src;
    await image.decode();signal?.throwIfAborted();
    const width=image.naturalWidth,height=image.naturalHeight;
    if(!width||!height||width*height>16000000)throw Error('Background removal supports images up to 16 megapixels');
    const small=document.createElement('canvas');small.width=small.height=320;
    const context=small.getContext('2d',{willReadFrequently:true});
    if(!context)throw Error('Image processing is unavailable');
    context.drawImage(image,0,0,320,320);
    const input=context.getImageData(0,0,320,320).data;
    const pixels=await new Promise<Uint8ClampedArray>((resolve,reject)=>{
        const worker=new Worker(new URL('./background.worker.ts',import.meta.url),{type:'module'});
        const timer=setTimeout(()=>finish(Error('Background removal timed out. Try a smaller image.')),55000);
        const abort=()=>finish(signal?.reason??Error('Background removal cancelled'));
        function finish(error?:unknown,result?:Uint8ClampedArray){clearTimeout(timer);signal?.removeEventListener('abort',abort);worker.terminate();if(error)reject(error);else resolve(result!);}
        signal?.addEventListener('abort',abort,{once:true});
        worker.onerror=()=>finish(Error('Could not load local background removal. Rebuild or reinstall the app.'));
        worker.onmessage=event=>event.data.error?finish(Error(event.data.error)):finish(undefined,event.data.pixels);
        worker.postMessage({pixels:input,base:new URL('/background-removal/',location.href).href},[input.buffer]);
    });
    signal?.throwIfAborted();
    context.putImageData(new ImageData(pixels as Uint8ClampedArray<ArrayBuffer>,320,320),0,0);
    const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;
    const output=canvas.getContext('2d');if(!output)throw Error('Image processing is unavailable');
    output.drawImage(image,0,0);output.globalCompositeOperation='destination-in';output.drawImage(small,0,0,width,height);
    const data=canvas.toDataURL('image/png');
    if(data.length>Math.ceil(16*1024*1024/3)*4+100)throw Error('The transparent image exceeds 16 MiB');
    return {src:data,width,height,mimeType:'image/png'};
}
