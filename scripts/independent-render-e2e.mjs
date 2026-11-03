/** Fresh post-barrier Electron rendering regressions; no inherited test imports. */
import {_electron as electron} from 'playwright';
import {build} from 'esbuild';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {decodeFile} from '../core/storage.mjs';
const execute=promisify(execFile);
const root=process.cwd();
const temporary=await fs.mkdtemp(path.join(os.tmpdir(),'omc-independent-render-'));
const output=path.join(root,'docs/qa');
let app;
try{
 const bundle=await build({entryPoints:[path.join(root,'editor/__tests__/render-browser.ts')],bundle:true,format:'iife',globalName:'IndependentRenderQA',platform:'browser',external:['fs','path'],write:false,logLevel:'silent'});
 app=await electron.launch({args:[root,`--profile=${path.join(temporary,'profile')}`],env:{...process.env,ELECTRON_DISABLE_SECURITY_WARNINGS:'true'},timeout:45000});
 const page=await app.firstWindow();
 page.on('console',message=>{if(message.text().startsWith('RENDER_PROFILE'))console.log(message.text());});
 const errors=[];page.on('pageerror',error=>errors.push(String(error)));
 await page.locator('#new').waitFor({timeout:30000});
 await page.evaluate(bundle.outputFiles[0].text+';globalThis.IndependentRenderQA=IndependentRenderQA;');
 const faces=JSON.parse(await fs.readFile(path.join(root,'src/fonts.json'),'utf8'));
 if(process.argv.includes('--library-profile')){const record=decodeFile(await fs.readFile(path.join(root,'docs/design/system/component-library.omc'),'utf8'));const document=record.replica.document;record.replica.destroy();const result=await page.evaluate(async({document,faces})=>globalThis.IndependentRenderQA.profileLarge(document,faces),{document,faces});await fs.writeFile(path.join(output,'independent-render-library-profile-optimized.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2));}else{
 const result=await page.evaluate(async faces=>globalThis.IndependentRenderQA.runAll(faces),faces);
 const security=await page.evaluate(()=>globalThis.IndependentRenderQA.mountSvgSecurityFrame());
 if(security.links!==5||security.sentinel!==0)throw Error('SVG security frame did not preserve safe links or ran animation');
 let activated;for(let index=0;index<5;index++){if(index)await page.evaluate(()=>globalThis.IndependentRenderQA.mountSvgSecurityFrame());await page.frameLocator('#svg-security-frame').locator('a').nth(index).click();activated=await page.evaluate(()=>globalThis.IndependentRenderQA.finishSvgSecurityFrame());if(activated.sentinel!==0)throw Error('Exported SVG activated JavaScript through SVG animation');}
 result.svgSecurity={linksClicked:security.links,sentinel:activated.sentinel};result.assertions+=7;
 result.harnessSHA256=createHash('sha256').update(bundle.outputFiles[0].contents).digest('hex');result.canvasKitWasmSHA256=createHash('sha256').update(await fs.readFile(path.join(root,'dist/canvaskit.wasm'))).digest('hex');
 await page.screenshot({path:path.join(output,'independent-render-gallery.png'),fullPage:false});
 const screenBoard=await page.screenshot({clip:{x:0,y:0,width:380,height:280},scale:'css'});await fs.writeFile(path.join(output,'independent-render-screen-board.png'),screenBoard);
 const artifacts=await page.evaluate(()=>globalThis.IndependentRenderQA.artifacts());await fs.writeFile(path.join(output,'independent-render-scene.svg'),artifacts.svg);for(const format of ['png','jpeg','webp','pdf'])await fs.writeFile(path.join(output,'independent-render-export.'+format),Buffer.from(artifacts[format],'base64'));
 const visual=await page.evaluate(async ({screen,exported})=>{
  async function decode(data){const bitmap=await createImageBitmap(await(await fetch('data:image/png;base64,'+data)).blob());const canvas=document.createElement('canvas');canvas.width=bitmap.width;canvas.height=bitmap.height;const context=canvas.getContext('2d');context.drawImage(bitmap,0,0);bitmap.close();return context.getImageData(0,0,canvas.width,canvas.height).data;}
  const a=await decode(screen),b=await decode(exported);let total=0,large=0,missingInk=0;
  for(let index=0;index<a.length;index+=4){const difference=Math.max(...[0,1,2].map(channel=>Math.abs(a[index+channel]-b[index+channel])));total+=Math.abs(a[index]-b[index])+Math.abs(a[index+1]-b[index+1])+Math.abs(a[index+2]-b[index+2]);if(difference>48)large++;const pixel=index/4,x=pixel%380,y=Math.floor(pixel/380);if(x>=25&&x<340&&y>=140&&y<260){const darkA=Math.max(a[index],a[index+1],a[index+2])<140,darkB=Math.max(b[index],b[index+1],b[index+2])<140,whiteA=Math.min(a[index],a[index+1],a[index+2])>245,whiteB=Math.min(b[index],b[index+1],b[index+2])>245;if(darkA&&whiteB||darkB&&whiteA)missingInk++;}}
  return {meanAbsoluteChannelError:total/(380*280*3),largeDifferencePixels:large,largeDifferenceFraction:large/(380*280),textMissingInkPixels:missingInk};
 },{screen:screenBoard.toString('base64'),exported:artifacts.png});
 result.screenExport={...visual,pass:visual.meanAbsoluteChannelError<3&&visual.largeDifferenceFraction<.03&&visual.textMissingInkPixels<300};result.cases.push({name:'Actual browser screen pixels agree with self-contained exported PNG',requirements:['TEXT-03','EXP-01','PAINT-01'],pass:result.screenExport.pass});result.assertions+=3;
 // The actual BrowserWindow is minimized. Timers/resource capture must still settle.
 await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].minimize());
 result.background=await page.evaluate(async()=>globalThis.IndependentRenderQA.backgroundCapture());
 await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].restore());
 // Exercise the actual trusted preload -> main-process export-file -> atomic disk writer.
 await page.evaluate(async()=>globalThis.omc.invoke('create',{title:'Renderer regression',document:globalThis.IndependentRenderQA.currentDocument()}));
 const nativePath=path.join(temporary,'native-save.png');
 await app.evaluate(({dialog},file)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath:file});},nativePath);
 const save=await page.evaluate(async data=>{const binary=atob(data),bytes=Uint8Array.from(binary,character=>character.charCodeAt(0));return globalThis.omc.invoke('export-file',{name:'native-save.png',mime:'image/png',bytes});},artifacts.png);
 const disk=await fs.readFile(nativePath);await fs.writeFile(path.join(output,'independent-render-native-save.png'),disk);
 const nativeChecks=[{name:'Actual main-process native-save disk write',pass:save===true&&disk.equals(Buffer.from(artifacts.png,'base64'))}];
 await app.evaluate(({dialog})=>{dialog.showSaveDialog=async()=>({canceled:true});});
 const cancel=await page.evaluate(()=>globalThis.omc.invoke('export-file',{name:'canceled.png',mime:'image/png',bytes:new Uint8Array([1,2,3])}));nativeChecks.push({name:'Actual main-process native-save cancellation',pass:cancel===false});
 const blocker=path.join(temporary,'blocker');await fs.writeFile(blocker,'A file, not a directory');
 await app.evaluate(({dialog},file)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath:file});},path.join(blocker,'failure.png'));
 const error=await page.evaluate(async()=>{try{await globalThis.omc.invoke('export-file',{name:'failure.png',mime:'image/png',bytes:new Uint8Array([1,2,3])});return '';}catch(error){return String(error);}});nativeChecks.push({name:'Actual main-process native-save write error',pass:/ENOTDIR|EEXIST/.test(error)});
 result.native=nativeChecks;result.assertions+=nativeChecks.length;for(const check of nativeChecks)result.cases.push({...check,requirements:['EXP-02']});
 const pdfInfo=await execute('/opt/homebrew/bin/pdfinfo',[path.join(output,'independent-render-export.pdf')],{timeout:10000});
 await execute('/opt/homebrew/bin/pdftoppm',['-singlefile','-scale-to-x','380','-scale-to-y','280','-png',path.join(output,'independent-render-export.pdf'),path.join(output,'independent-render-pdf-decoded')],{timeout:10000});
 const renderedPdf=await fs.readFile(path.join(output,'independent-render-pdf-decoded.png'));
 const pdfPixel=await page.evaluate(async data=>{const image=await createImageBitmap(await(await fetch('data:image/png;base64,'+data)).blob());const canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;const context=canvas.getContext('2d');context.drawImage(image,0,0);image.close();return {width:canvas.width,height:canvas.height,pixel:[...context.getImageData(50,50,1,1).data]};},renderedPdf.toString('base64'));
 const popplerPass=/Pages:\s+1/.test(pdfInfo.stdout)&&/380 x 280 pts/.test(pdfInfo.stdout)&&pdfPixel.width===380&&pdfPixel.height===280&&[29,98,56].every((channel,index)=>Math.abs(channel-pdfPixel.pixel[index])<=5);
 result.pdfParser={name:'Poppler pdfinfo and actual page rasterization',pass:popplerPass,info:pdfInfo.stdout,pixel:pdfPixel};result.cases.push({name:result.pdfParser.name,requirements:['EXP-01'],pass:popplerPass});result.assertions+=5;
 result.pageErrors=errors;
 result.date=new Date().toISOString();
 result.profile='Task-owned temporary profile; removed after run';
 await fs.mkdir(output,{recursive:true});
 await fs.writeFile(path.join(output,'independent-render-results.json'),JSON.stringify(result,null,2)+'\n');
 const failures=result.cases.filter(test=>!test.pass);
 console.log(JSON.stringify({cases:result.cases.length,assertions:result.assertions,failures,background:result.background,pageErrors:errors},null,2));
 if(failures.length||errors.length||!result.background.pass)process.exitCode=1;
 }
}catch(error){console.error(error);process.exitCode=1;}finally{
 if(app){const child=app.process();await app.evaluate(({app})=>app.exit(0)).catch(()=>{});if(child.exitCode===null)await new Promise(resolve=>{const timer=setTimeout(resolve,5000);child.once('exit',()=>{clearTimeout(timer);resolve();});});}
 await fs.rm(temporary,{recursive:true,force:true,maxRetries:10,retryDelay:150});
}
