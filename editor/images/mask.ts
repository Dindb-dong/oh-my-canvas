const SIZE=320,MEAN=[.485,.456,.406],STD=[.229,.224,.225];
export function imageTensor(data:Uint8ClampedArray):Float32Array {
    if(data.length!==SIZE*SIZE*4)throw Error('Expected a 320 × 320 image');
    let maximum=0;
    for(let i=0;i<data.length;i+=4)maximum=Math.max(maximum,data[i],data[i+1],data[i+2]);
    maximum=maximum||1;
    const tensor=new Float32Array(3*SIZE*SIZE);
    for(let i=0;i<SIZE*SIZE;i++)for(let channel=0;channel<3;channel++)tensor[channel*SIZE*SIZE+i]=(data[i*4+channel]/maximum-MEAN[channel])/STD[channel];
    return tensor;
}
export function maskPixels(values:Float32Array):Uint8ClampedArray {
    if(values.length!==SIZE*SIZE)throw Error('Background removal returned an invalid mask');
    let minimum=Infinity,maximum=-Infinity;
    for(const value of values){if(!Number.isFinite(value))throw Error('Background removal returned an invalid mask');minimum=Math.min(minimum,value);maximum=Math.max(maximum,value);}
    if(maximum-minimum<1e-5)throw Error('No distinct foreground subject was found. Try an image with clearer contrast.');
    const pixels=new Uint8ClampedArray(SIZE*SIZE*4);
    for(let i=0;i<values.length;i++){pixels[i*4]=pixels[i*4+1]=pixels[i*4+2]=255;pixels[i*4+3]=255*(values[i]-minimum)/(maximum-minimum);}
    return pixels;
}
