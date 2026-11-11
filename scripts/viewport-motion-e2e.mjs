/** Native pixel oracle for the translated SVG surface.
 * Build the app first, then run under a native display (xvfb-run on Linux CI):
 * node scripts/viewport-motion-e2e.mjs --output /absolute/evidence/viewport
 * This compares the existing direct SVG viewport with the live renderer at the
 * same logical camera. It is not a comparison with an original Figma rendering.
 */
import {_electron as electron} from 'playwright';
import {build} from 'esbuild';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';

const args={};
for(let i=2;i<process.argv.length;i+=2){
  const key=process.argv[i],value=process.argv[i+1];
  assert.ok(['--output','--label','--timeout'].includes(key)&&value&&!value.startsWith('--'),'Expected --output, --label, or --timeout followed by a value');
  args[key.slice(2)]=value;
}
const root=process.cwd(),output=args.output,timeout=Number(args.timeout??120000);
assert.ok(typeof output==='string'&&path.isAbsolute(output),'--output requires an absolute evidence directory');
assert.ok(Number.isSafeInteger(timeout)&&timeout>=30000&&timeout<=300000,'--timeout must be 30000–300000 milliseconds');
await fs.mkdir(output,{recursive:true});
const temporary=await fs.mkdtemp(path.join(os.tmpdir(),'omc-viewport-motion-'));
const result={schemaVersion:1,label:String(args.label??'current'),at:new Date().toISOString(),timeoutMs:timeout,
  environment:{platform:process.platform,arch:process.arch,node:process.version,cpu:os.cpus()[0]?.model,display:process.env.DISPLAY??null},
  comparison:'Live translated SVG surface against the existing direct SVG viewport, with the same logical camera and text measurements.',
  limitations:['Synthetic clips, alpha masks, shadows, blur, text, paths, and bitmap assets; not a source-Figma fidelity oracle.','Pixel thresholds permit edge antialiasing differences. This does not measure hardware GPU frame rate.'],
  thresholds:{meanAbsoluteChannelError:1,largeDifferenceCutoff:24,largeDifferenceFraction:.015,maxTileMeanAbsoluteChannelError:16,tileSize:32},
  checks:[],rendererErrors:[],consoleErrors:[],failedResponses:[],failedRequests:[]};
let app,page,expired=false,write=Promise.resolve();
const save=()=>{const json=JSON.stringify(result,null,2)+'\n';write=write.then(()=>fs.writeFile(path.join(output,'result.json'),json));return write;};
function active(){if(expired)throw Error('Viewport oracle exceeded its global deadline');}
function killOwned(reason){
  const child=app?.process();
  if(child&&child.exitCode===null&&child.signalCode===null){result.forcedTermination={pid:child.pid,reason,at:new Date().toISOString()};child.kill('SIGKILL');}
}
let rejectExpiration;
const expiration=new Promise((_,reject)=>{rejectExpiration=reject;});
const watchdog=setTimeout(()=>{
  expired=true;result.timedOut=true;result.failure='Viewport oracle exceeded its global deadline';
  void save().finally(()=>killOwned(result.failure));
  rejectExpiration(Error(result.failure));
},timeout);
async function bounded(run,ms=30000){
  active();let timer;
  try{return await Promise.race([Promise.resolve().then(run),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Viewport oracle operation exceeded '+ms+' ms')),ms);}),expiration]);}
  finally{clearTimeout(timer);}
}
async function check(name,run,ms){
  active();result.pendingCheck={name,at:new Date().toISOString()};await save();const began=performance.now();
  try{const detail=await bounded(run,ms);active();result.checks.push({name,pass:detail?.pass!==false,ms:performance.now()-began,...detail});return detail;}
  catch(error){result.checks.push({name,pass:false,ms:performance.now()-began,error:String(error),stack:error.stack});throw error;}
  finally{delete result.pendingCheck;await save();}
}
const observed=new WeakSet();
function observe(candidate){
  if(observed.has(candidate))return;observed.add(candidate);
  candidate.on('pageerror',error=>result.rendererErrors.push({url:candidate.url(),error:String(error)}));
  candidate.on('console',message=>{if(message.type()==='error')result.consoleErrors.push({url:candidate.url(),text:message.text(),location:message.location()});});
  candidate.on('response',response=>{if(response.status()>=400)result.failedResponses.push({url:response.url(),status:response.status()});});
  candidate.on('requestfailed',request=>result.failedRequests.push({url:request.url(),error:request.failure()?.errorText}));
}
async function compare(a,b){
  return page.evaluate(async({a,b,thresholds})=>{
    async function decode(base64){
      const image=await createImageBitmap(await(await fetch('data:image/png;base64,'+base64)).blob());
      const canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;
      const context=canvas.getContext('2d');context.drawImage(image,0,0);image.close();
      return {width:canvas.width,height:canvas.height,pixels:context.getImageData(0,0,canvas.width,canvas.height).data};
    }
    const x=await decode(a),y=await decode(b);
    if(x.width!==y.width||x.height!==y.height)throw Error('Screenshot dimensions differ');
    const columns=Math.ceil(x.width/thresholds.tileSize),rows=Math.ceil(x.height/thresholds.tileSize),tiles=new Float64Array(columns*rows),counts=new Uint32Array(tiles.length);
    let total=0,large=0,different=0,maximum=0,referenceBluePixels=0;
    for(let i=0;i<x.pixels.length;i+=4){
      const pixel=i/4,px=pixel%x.width,py=Math.floor(pixel/x.width),tile=Math.floor(py/thresholds.tileSize)*columns+Math.floor(px/thresholds.tileSize);
      let sum=0,peak=0;
      for(let channel=0;channel<3;channel++){const d=Math.abs(x.pixels[i+channel]-y.pixels[i+channel]);sum+=d;peak=Math.max(peak,d);}
      total+=sum;tiles[tile]+=sum;counts[tile]++;maximum=Math.max(maximum,peak);
      if(peak)different++;if(peak>thresholds.largeDifferenceCutoff)large++;
      if(Math.abs(y.pixels[i]-36)<3&&Math.abs(y.pixels[i+1]-106)<3&&Math.abs(y.pixels[i+2]-152)<3)referenceBluePixels++;
    }
    const pixels=x.width*x.height,mean=total/(pixels*3),fraction=large/pixels,tileMeans=[...tiles].map((sum,index)=>sum/(counts[index]*3));
    const worst=Math.max(...tileMeans),worstIndex=tileMeans.indexOf(worst);
    return {width:x.width,height:x.height,meanAbsoluteChannelError:mean,maximumChannelError:maximum,differentPixels:different,largeDifferencePixels:large,largeDifferenceFraction:fraction,maxTileMeanAbsoluteChannelError:worst,worstTile:{x:(worstIndex%columns)*thresholds.tileSize,y:Math.floor(worstIndex/columns)*thresholds.tileSize},referenceBluePixels,pass:mean<=thresholds.meanAbsoluteChannelError&&fraction<=thresholds.largeDifferenceFraction&&worst<=thresholds.maxTileMeanAbsoluteChannelError};
  },{a:a.toString('base64'),b:b.toString('base64'),thresholds:result.thresholds});
}
async function journey(){
  let bundleText;
  await check('Build isolated browser fixture',async()=>{
    const built=await build({entryPoints:[path.join(root,'editor/__tests__/viewport-motion-browser.ts')],bundle:true,format:'iife',globalName:'ViewportMotionQA',platform:'browser',external:['fs','path'],write:false,logLevel:'silent'});
    bundleText=built.outputFiles[0].text;result.harnessSHA256=createHash('sha256').update(built.outputFiles[0].contents).digest('hex');return {bytes:built.outputFiles[0].contents.length};
  });
  await check('Launch actual visible Electron window',async()=>{
    app=await electron.launch({args:[...(process.getuid?.()===0?['--no-sandbox']:[]),root,'--profile='+path.join(temporary,'profile')],env:{...process.env,OMC_TEST_BACKGROUND:'1',ELECTRON_DISABLE_SECURITY_WARNINGS:'true'},timeout:30000});
    if(expired){killOwned('Launch completed after deadline');active();}
    app.context().on('page',observe);for(const candidate of app.context().pages())observe(candidate);
    page=await app.firstWindow();page.setDefaultTimeout(30000);
    await page.waitForFunction(()=>typeof document.querySelector('#new')?.onclick==='function',null,{timeout:30000});
    result.environment.native=await app.evaluate(({app,BrowserWindow})=>{
      const window=BrowserWindow.getAllWindows()[0];window.setContentSize(1100,850);window.showInactive();
      return {versions:process.versions,gpuFeatureStatus:app.getGPUFeatureStatus(),visible:window.isVisible()};
    });
    assert.equal(result.environment.native.visible,true,'A hidden native window cannot provide the pixel oracle');
    await page.evaluate(bundleText+';globalThis.ViewportMotionQA=ViewportMotionQA;');
    const fixture=await page.evaluate(()=>globalThis.ViewportMotionQA.setup());
    assert.ok(fixture.objects>512&&fixture.diagnostics.translatedViewport,'Fixture did not enable the translated surface');
    return {fixture};
  },45000);
  const cases=[
    {name:'initial',x:0,y:0,zoom:1,width:800,height:601},
    {name:'pan-integer',x:120,y:80,zoom:1,width:800,height:601},
    {name:'pan-fractional',x:120.25,y:80.5,zoom:1,width:800,height:601},
    {name:'zoom',x:200,y:180,zoom:1.5,width:800,height:601},
    {name:'overscan-exit',x:600,y:300,zoom:1.5,width:800,height:601},
    {name:'resize',x:300,y:160,zoom:.75,width:641,height:479},
    {name:'root-blend-fallback',x:0,y:0,zoom:1,width:800,height:601,rootBlend:'multiply'}
  ];
  let previousAnchors;
  for(const camera of cases)await check(camera.name,async()=>{
    const live=await page.evaluate(camera=>globalThis.ViewportMotionQA.render({...camera,direct:false}),camera);
    assert.equal(live.diagnostics.translatedViewport,!camera.rootBlend,'Incorrect viewport mode for the compositing dependency');
    if(camera.name.startsWith('pan-'))assert.equal(live.diagnostics.surfaceReanchors,previousAnchors,'A pan within overscan rebuilt the SVG coordinate system');
    else if(previousAnchors!==undefined&&!camera.rootBlend)assert.ok(live.diagnostics.surfaceReanchors>previousAnchors,'Zoom, resize, or overscan exit did not reanchor');
    previousAnchors=live.diagnostics.surfaceReanchors;
    const screen=await page.locator('#viewport-motion-oracle').screenshot({path:path.join(output,camera.name+'-screen.png'),scale:'css'});
    const direct=await page.evaluate(camera=>globalThis.ViewportMotionQA.render({...camera,direct:true}),camera);
    assert.deepEqual(live.viewport,direct.viewport,'Direct oracle used a different logical viewport');
    const expected=await page.locator('#viewport-motion-oracle').screenshot({path:path.join(output,camera.name+'-direct.png'),scale:'css'});
    const mapping=await page.evaluate(()=>globalThis.ViewportMotionQA.hit({x:150,y:290}));
    assert.equal(mapping.hit,'shadow','World hit testing changed with the surface transform');
    assert.ok(Math.abs(mapping.roundTrip.x-150)<1e-7&&Math.abs(mapping.roundTrip.y-290)<1e-7,'World/screen mapping did not round trip');
    assert.ok(Math.abs(mapping.screen.x-(150-camera.x)*camera.zoom)<1e-7&&Math.abs(mapping.screen.y-(290-camera.y)*camera.zoom)<1e-7,'Interaction mapping does not match the logical viewport');
    const pixels=await compare(screen,expected);
    if(camera.name==='initial')assert.ok(pixels.referenceBluePixels>5000,'The reference screenshot did not render the solid fixture geometry');
    return {pass:pixels.pass,camera,diagnostics:live.diagnostics,mapping,pixels};
  });
  await bounded(()=>page.evaluate(()=>globalThis.ViewportMotionQA.destroy()));
}
try{await Promise.race([journey(),expiration]);}
catch(error){result.failure=String(error);result.stack=error.stack;}
finally{
  clearTimeout(watchdog);
  if(app){
    let closeTimer;
    try{await Promise.race([app.close(),new Promise((_,reject)=>{closeTimer=setTimeout(()=>reject(Error('Native close exceeded 15000 ms')),15000);})]);}
    catch(error){result.cleanupError=String(error);killOwned('Bounded oracle cleanup');}
    finally{clearTimeout(closeTimer);}
  }
  try{await fs.rm(temporary,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
  catch(error){result.profileCleanupError=String(error);}
  result.finishedAt=new Date().toISOString();result.pass=!result.failure&&!result.rendererErrors.length&&result.checks.every(check=>check.pass);
  await save();console.log(JSON.stringify({pass:result.pass,checks:result.checks.map(({name,pass,ms,pixels})=>({name,pass,ms,pixels})),failure:result.failure,rendererErrors:result.rendererErrors},null,2));
  if(!result.pass)process.exitCode=1;
}
