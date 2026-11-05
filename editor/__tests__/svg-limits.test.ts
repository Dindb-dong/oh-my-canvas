import {describe,it,expect} from 'vitest';
import {importSvg,parseSvgPath,SVG_IMPORT_LIMITS} from '../formats/svg';

describe('SVG import resource limits',()=>{
    it('stops a tiny acyclic exponential use graph before allocating too many layers',()=>{
        const defs=['<g id="n0"><rect width="1" height="1"/></g>'];
        for(let i=1;i<30;i++)defs.push(`<g id="n${i}"><use href="#n${i-1}"/><use href="#n${i-1}"/></g>`);
        const input=`<svg><defs>${defs.join('')}</defs><use href="#n29"/></svg>`;
        let allocated=0;
        expect(input.length).toBeLessThan(2500);
        expect(()=>importSvg(input,{id:()=>`layer-${++allocated}`})).toThrow(/layer limit/);
        expect(allocated).toBeLessThanOrEqual(SVG_IMPORT_LIMITS.layers);
    });
    it('bounds deep acyclic references and rejects cycles',()=>{
        const defs=['<rect id="n0" width="1" height="1"/>'];
        for(let i=1;i<150;i++)defs.push(`<use id="n${i}" href="#n${i-1}"/>`);
        expect(()=>importSvg(`<svg><defs>${defs.join('')}</defs><use href="#n149"/></svg>`)).toThrow(/traversal limit/);
        expect(()=>importSvg('<svg><defs><g id="loop"><use href="#loop"/></g></defs><use href="#loop"/></svg>')).toThrow(/Cyclic/);
    });
    it('charges the aggregate path budget across repeated instances',()=>{
        const path='M0 0'+'L1 1'.repeat(999);
        const input=`<svg><defs><path id="p" d="${path}"/></defs>${'<use href="#p"/>'.repeat(11)}</svg>`;
        expect(()=>importSvg(input)).toThrow(/segment|complex|token/i);
        expect(importSvg(input.replace('<use href="#p"/>','')).shapes).toHaveLength(10);
    });
    it('bounds token scans and checks segment growth for close, curve, and arc commands',()=>{
        expect(()=>parseSvgPath('M0 0'+'Z'.repeat(10000))).toThrow(/complex|segment/i);
        expect(()=>parseSvgPath('M0 0 C1 1 2 2 3 3',1)).toThrow(/complex|segment|token/i);
        expect(()=>parseSvgPath('M0 0 A10 10 0 1 1 20 0',2)).toThrow(/complex|segment/i);
        expect(()=>parseSvgPath('M0 0'+'0 '.repeat(100000))).toThrow(/complex/i);
        expect(()=>parseSvgPath(' '.repeat(2000001))).toThrow(/complex/i);
    });
    it('charges copied defs and serialized fallback pictures before retaining duplicates',()=>{
        const input=`<svg><defs><filter id="f"><feImage data-padding="${'x'.repeat(200000)}"/></filter></defs>${'<rect filter="url(#f)" width="10" height="10"/>'.repeat(100)}</svg>`;
        let allocated=0;
        expect(()=>importSvg(input,{id:()=>`layer-${++allocated}`})).toThrow(/fallback picture byte limit/);
        expect(allocated).toBeLessThan(10);
    });
    it('preserves ordinary editable SVG, holes, use transforms and static fallback effects',()=>{
        const result=importSvg('<svg width="40" height="30"><defs><path id="p" d="M0 0H10V10H0ZM2 2V8H8V2Z"/><clipPath id="c"><rect width="10" height="10"/></clipPath></defs><use href="#p" x="4"/><g clip-path="url(#c)"><circle r="8"/></g></svg>');
        expect(result.shapes.map(shape=>shape.type)).toEqual(['path','svg']);
        expect(result.shapes[0].content.filter((segment:{command:string})=>segment.command==='close')).toHaveLength(2);
        expect(result.shapes[1].svg).toContain('<clipPath');
        expect(result.shapes[1].image.src).toMatch(/^data:image\/svg\+xml/);
    });
});
