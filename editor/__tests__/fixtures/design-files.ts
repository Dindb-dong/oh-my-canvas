import {zipSync,strToU8,deflateSync} from 'fflate';
import {zstdCompressSync} from 'node:zlib';
import {createEmptyFigDoc,encodeFigParts,assembleCanvasFig,createFigZip,appendVectorPayloadToDocument} from 'openfig-core';
export function figFixture(zstd=false){
    const fig=createEmptyFigDoc();
    const node=(id:number,type:string,name:string,parent=1,x=0,y=0)=>({guid:{sessionID:0,localID:id},type,name,parentIndex:{guid:{sessionID:0,localID:parent},position:String(id)},size:{x:100,y:60},transform:{m00:1,m01:0,m02:x,m10:0,m11:1,m12:y},fillPaints:[{type:'SOLID',color:{r:1,g:0,b:0,a:1}}]});
    fig.message.nodeChanges.push(node(3,'FRAME','Board',1,100,200),{...node(4,'TEXT','Title',3,10,15),textData:{characters:'Hello 한글'},fontSize:20,fontName:{family:'Arial',style:'Bold',postscript:'Arial-BoldMT'}},node(5,'ELLIPSE','Circle',3,30,40),{...node(6,'VECTOR','Vector',3),...appendVectorPayloadToDocument(fig,{width:100,height:60,fillPaths:[{svgPath:'M0 0L100 0L0 60Z'}]})});
    const parts=encodeFigParts(fig),binary=assembleCanvasFig({...parts,messageCompressed:zstd?zstdCompressSync(parts.messageRaw):deflateSync(parts.messageRaw)});
    return {binary,zip:createFigZip({canvasFig:binary})};
}
export function sketchFixture(extra:Record<string,Uint8Array>={}){
    const shape=(type:string,name:string,x:number,y:number,w:number,h:number,values={})=>({_class:type,name,frame:{x,y,width:w,height:h},...values});
    const files={'document.json':strToU8(JSON.stringify({pages:[{_ref:'pages/one'},{_ref:'pages/two'}]})),
    'pages/one.json':strToU8(JSON.stringify({name:'Screen',layers:[shape('artboard','Board',100,200,400,300,{layers:[shape('text','Title',10,15,100,20,{attributedString:{string:'Hello 한글',attributes:[]},style:{textStyle:{encodedAttributes:{MSAttributedStringFontAttribute:{attributes:{name:'Arial-Bold',size:20}}}}}}),shape('oval','Circle',30,40,50,50),shape('shapePath','Triangle',0,0,100,60,{isClosed:true,points:[{point:'{0, 0}'},{point:'{1, 0}'},{point:'{0, 1}'}]})]})]})),
    'pages/two.json':strToU8(JSON.stringify({name:'Second',layers:[shape('rectangle','Rectangle',-20,10,80,40,{style:{fills:[{fillType:0,color:{red:0,green:1,blue:0,alpha:1}}]}})]})),...extra};
    return zipSync(files);
}
