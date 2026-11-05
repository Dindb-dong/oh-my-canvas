import {describe,it,expect} from 'vitest';
import {imageTensor,maskPixels} from '../images/mask';
describe('U2Netp tensor and alpha conversion',()=>{
    it('matches RGB CHW ImageNet normalization and handles black without NaN',()=>{
        const data=new Uint8ClampedArray(320*320*4);data[0]=255;data[1]=127;
        const tensor=imageTensor(data);
        expect(tensor[0]).toBeCloseTo((1-.485)/.229);
        expect(tensor[320*320]).toBeCloseTo((127/255-.456)/.224);
        expect(tensor[2*320*320]).toBeCloseTo(-.406/.225);
        expect([...imageTensor(new Uint8ClampedArray(data.length))].every(Number.isFinite)).toBe(true);
        expect(()=>imageTensor(new Uint8ClampedArray(4))).toThrow();
    });
    it('maps saliency to transparent/opaque alpha and rejects unusable masks',()=>{
        const values=new Float32Array(320*320);values[1]=1;values[2]=.5;
        const mask=maskPixels(values);
        expect([...mask.slice(0,12)]).toEqual([255,255,255,0,255,255,255,255,255,255,255,128]);
        expect(()=>maskPixels(new Float32Array(320*320).fill(.5))).toThrow('No distinct');
        values[5]=NaN;expect(()=>maskPixels(values)).toThrow('invalid mask');
    });
});
