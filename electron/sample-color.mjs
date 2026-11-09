import os from 'node:os';
const unavailable=message=>Object.assign(Error(message),{code:'unavailable'});
export function createScreenSampler({screen,desktopCapturer,systemPreferences,platform=process.platform}){
  return async({x,y,displayId})=>{
    if(!Number.isFinite(x)||!Number.isFinite(y))throw Object.assign(Error('Screen coordinates must be finite'),{code:'bad_args'});
    if(platform==='darwin'&&systemPreferences.getMediaAccessStatus('screen')!=='granted')throw unavailable('Screen color sampling requires Screen Recording permission for this app in macOS System Settings');
    if(os.endianness()!=='LE')throw unavailable('Screen color sampling is not supported on this processor');
    const displays=screen.getAllDisplays(),display=displays.find(display=>(displayId===undefined||String(display.id)===displayId)&&x>=display.bounds.x&&y>=display.bounds.y&&x<display.bounds.x+display.bounds.width&&y<display.bounds.y+display.bounds.height);
    if(!display)throw Object.assign(Error('Coordinates are outside the requested display'),{code:'bad_args'});
    const width=Math.round(display.bounds.width*display.scaleFactor),height=Math.round(display.bounds.height*display.scaleFactor);
    if(width*height*displays.length>64*1024*1024)throw unavailable('Screen capture exceeds the 64 megapixel sampling budget');
    const sources=await desktopCapturer.getSources({types:['screen'],thumbnailSize:{width,height},fetchWindowIcons:false});
    const image=sources.find(source=>source.display_id===String(display.id))?.thumbnail;
    if(!image||image.isEmpty())throw unavailable('The operating system did not provide this screen');
    const size=image.getSize(),px=Math.min(size.width-1,Math.floor((x-display.bounds.x)*size.width/display.bounds.width)),py=Math.min(size.height-1,Math.floor((y-display.bounds.y)*size.height/display.bounds.height));
    // Electron's supported little-endian desktop runtimes expose opaque screen pixels in BGRA order.
    const pixel=image.crop({x:px,y:py,width:1,height:1}).toBitmap({scaleFactor:1});
    if(pixel.length!==4||pixel[3]!==255)throw unavailable('The operating system did not provide an opaque screen pixel');
    const rgba=[pixel[2],pixel[1],pixel[0],pixel[3]],color='#'+rgba.slice(0,3).map(value=>value.toString(16).padStart(2,'0')).join('');
    return {displayId:String(display.id),x,y,rgba,color};
  };
}
