export function sampleCanvas(){
  return {width:1000,height:900,pages:[{id:crypto.randomUUID(),name:'Studio',width:1000,height:900,background:'#ffffff',children:[
    {id:crypto.randomUUID(),type:'text',name:'Studio name',x:64,y:58,width:850,height:28,text:'OH MY CANVAS / STUDIO 01',fontFamily:'IBM Plex Sans',fontSize:16,fontWeight:'500',fill:'#64748b'},
    {id:crypto.randomUUID(),type:'text',name:'Headline',x:60,y:150,width:860,height:190,text:'A little room\nfor a big idea.',fontFamily:'IBM Plex Sans',fontSize:76,fontWeight:'600',lineHeight:1.12,fill:'#202124'},
    {id:crypto.randomUUID(),type:'text',name:'Introduction',x:64,y:380,width:550,height:65,text:'Draw it. Shape it. Make it yours.\nYour workspace starts here.',fontFamily:'IBM Plex Sans',fontSize:22,fill:'#64748b'},
    {id:crypto.randomUUID(),type:'figure',subType:'rect',name:'Blue',x:64,y:530,width:272,height:250,fill:'#2563eb',cornerRadius:12},
    {id:crypto.randomUUID(),type:'figure',subType:'ellipse',name:'Sky',x:364,y:530,width:250,height:250,fill:'#7dd3fc'},
    {id:crypto.randomUUID(),type:'figure',subType:'rect',name:'Lavender',x:642,y:530,width:294,height:250,fill:'#c4b5fd',cornerRadius:12},
    {id:crypto.randomUUID(),type:'text',name:'Footer',x:64,y:826,width:870,height:25,text:'100% LOCAL                                      YOUR NEXT GREAT THING',fontFamily:'IBM Plex Sans',fontSize:13,fill:'#64748b'}
  ]}]};
}
export function blankCanvas(){return {width:1000,height:800,pages:[{id:crypto.randomUUID(),width:1000,height:800,children:[]}]};}
