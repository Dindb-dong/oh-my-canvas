// CRDT geometry has one scalar box and one orientation. Render caches are derived.
const identity = Object.freeze({a:1,b:0,c:0,d:1,e:0,f:0});
const clean = n => Math.abs(n-Math.round(n))<1e-9 ? Math.round(n) : n;
const derived = new Set(['box','corners','inverseTransform','transform','rotation','flipX','flipY']);
const validMatrix = m => m && ['a','b','c','d'].every(k=>Number.isFinite(m[k]));
export const hasGeometry = s => s.box && validMatrix(s.transform) && ['x','y','width','height'].every(k=>Number.isFinite(s[k]));
export const geometricField = (s,k) => (derived.has(k) || (k==='content' && Array.isArray(s.content))) && hasGeometry(s);

function inverse(m){
  const det=m.a*m.d-m.b*m.c;
  return Math.abs(det)<1e-12 ? identity : {a:m.d/det,b:-m.b/det,c:-m.c/det,d:m.a/det,e:0,f:0};
}
function orientation(s){
  return {transform:s.transform,rotation:s.rotation??0,path:Array.isArray(s.content),...(s.flipX?{flipX:true}:{}),...(s.flipY?{flipY:true}:{})};
}
function mapPath(content,point){
  return content.map(seg=>{
    if(seg.command==='close')return seg;
    const p=point(seg.x,seg.y);
    if(seg.command!=='curve')return {...seg,...p};
    const a=point(seg.x1,seg.y1),b=point(seg.x2,seg.y2);
    return {...seg,...p,x1:a.x,y1:a.y,x2:b.x,y2:b.y};
  });
}
function localPath(content,box,t){
  const inv=inverse(t),cx=box.x+box.width/2,cy=box.y+box.height/2;
  return mapPath(content,(x,y)=>({x:clean((inv.a*(x-cx)+inv.c*(y-cy)+box.width/2)/(box.width||1)),y:clean((inv.b*(x-cx)+inv.d*(y-cy)+box.height/2)/(box.height||1))}));
}
export function geometryEntries(s){
  if(!hasGeometry(s))return [];
  const entries=[['orientation',orientation(s)]];
  // Path points are world-space in the editor; storing a unit-box path lets a
  // concurrent translation/resize merge without a stale path undoing that move.
  if(Array.isArray(s.content))entries.push(['path',localPath(s.content,s.box,s.transform)]);
  return entries;
}
export function restoreGeometry(s,fields){
  const o=fields?.orientation ?? (hasGeometry(s)?orientation(s):null);
  if(!o || !validMatrix(o.transform) || !['x','y','width','height'].every(k=>Number.isFinite(s[k])))return;
  // Old files retain their original world path, box and transform as its basis.
  // New scalar edits never write those caches; this also upgrades legacy files
  // without rewriting their CRDT history or requiring an eager migration.
  const path=o.path===false ? null : fields?.path ?? (Array.isArray(s.content)&&s.box ? localPath(s.content,s.box,s.transform) : null);
  if(o.path===false && Array.isArray(s.content))delete s.content;
  const box={x:s.x,y:s.y,width:s.width,height:s.height};
  const t={a:o.transform.a,b:o.transform.b,c:o.transform.c,d:o.transform.d,e:0,f:0};
  const point=(x,y)=>({x:clean(t.a*(x-box.width/2)+t.c*(y-box.height/2)+box.x+box.width/2),y:clean(t.b*(x-box.width/2)+t.d*(y-box.height/2)+box.y+box.height/2)});
  s.box=box;s.transform=t;s.inverseTransform=inverse(t);s.rotation=o.rotation??0;
  if(o.flipX)s.flipX=true;else delete s.flipX;
  if(o.flipY)s.flipY=true;else delete s.flipY;
  s.corners=[point(0,0),point(box.width,0),point(box.width,box.height),point(0,box.height)];
  if(path)s.content=mapPath(path,(x,y)=>point(x*(box.width||1),y*(box.height||1)));
}
