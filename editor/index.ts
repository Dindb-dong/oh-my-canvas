/** Desktop facade for the independently authored editor services. */
import type {Data,EditorServices,MountOptions} from './contracts';
import {Editor} from './document';
import {createCommands} from './commands';
import {outlineStroke,outlineText} from './render/outline';
import {createComponentService,reconcileComponents,duplicateComponentMain} from './components';
import {createStyleService,reconcileStyles} from './styles';
import {createAssetService,createLibraryService,normalizeLibraries,reconcileLibraries} from './assets';
import {createFontCatalog} from './fonts';
import {createImageService} from './images';
import {createRenderer,combinePaths} from './render';
import {createExporter} from './export';
import {applyLayout} from './layout';
import {importCanvasJson,importSvg,importHtml,exportCanvasJson,exportHtml,portableDocument} from './formats';
import {createWorkspaceRoot,mountWorkspace} from './ui';
import {assertDocument,assertDocumentChanges} from '../core/document.mjs';

export {importCanvasJson,exportCanvasJson,portableDocument} from './formats';
export {installLvMcp} from './mcp';
export {screenToWorld,worldToScreen} from './geometry';
export * from './contracts';

export async function mountEditor(root:HTMLElement,options:MountOptions) {
  const previousInert=root.inert;
  root.inert=true;root.setAttribute('aria-busy','true');
  const cleanup:Array<()=>unknown|Promise<unknown>>=[];
  let destroyed=false;
  async function dispose(){
    if(destroyed)return [];destroyed=true;
    const errors:unknown[]=[];
    for(const release of cleanup.reverse()){try{await release();}catch(error){errors.push(error);}}
    root.replaceChildren();root.classList.remove('lv-editor');
    return errors;
  }
  try {
  const workspace=createWorkspaceRoot(root,options);
  const initial=importCanvasJson(options.document);
  normalizeLibraries(initial);
  const fonts=createFontCatalog(options.faces??[],options);
  cleanup.push(()=>fonts.destroy());
  fonts.syncAssets(initial.assets??{});
  const initialText=Object.values(initial.pagesById).flatMap(page=>Object.values(page.objects)).filter(shape=>shape.type==='text').map(shape=>typeof shape.content==='string'?shape.content:JSON.stringify(shape.content??shape.text??'')).join('\n');
  await fonts.ensure(initialText);
  applyLayout(initial,undefined,options);
  const editor=new Editor(initial,{
    reconcileChanges(before,draft,scope){
      const globalChange=['components','styles','libraries','assets'].some(key=>scope.documentFields.has(key));
      if(!globalChange&&!scope.shapes.size&&!scope.topologyPages.size)return;
      reconcileLibraries(before,draft);
      const componentChange=scope.documentFields.has('components')||Object.keys(before.components??{}).length>0||Object.keys(draft.components??{}).length>0||[...scope.shapes].some(([pageId,ids])=>[...ids].some(id=>{
        const shape=draft.pagesById[pageId]?.objects[id],old=before.pagesById[pageId]?.objects[id];
        return shape?.componentId||shape?.isInstanceRoot||shape?.isMain||old?.componentId||old?.isInstanceRoot||old?.isMain;
      }));
      if(componentChange)reconcileComponents(before,draft);
      if(globalChange||componentChange){
        reconcileStyles(before,draft);
        applyLayout(draft,before,options);
      }else{
        // Unchanged style definitions can affect only the edited shapes/runs.
        const pagesById=Object.fromEntries([...scope.shapes].filter(([id])=>!!draft.pagesById[id]).map(([id,ids])=>[id,{id,objects:Object.fromEntries([...ids].filter(key=>!!draft.pagesById[id].objects[key]).map(key=>[key,draft.pagesById[id].objects[key]]))}]));
        reconcileStyles(before,{pages:Object.keys(pagesById),pagesById,styles:draft.styles});
        applyLayout(draft,before,options,scope);
      }
    },
    validate(draft){assertDocument(draft);},
    validateChanges(before,draft){assertDocumentChanges(before,draft);},
    onTiming:options.onTiming,
  });
  cleanup.push(()=>editor.destroy());
  // Constructor normalization creates the immutable editor baseline. Prime its
  // core validation proof during load, so the first small edit is incremental.
  assertDocument(editor.doc);
  const images=createImageService(editor,options);
  cleanup.push(()=>images.destroy());
  let projectedAssets=editor.doc.assets;
  cleanup.push(editor.on(event=>{
    if(!(event.changes||event.projection||event.deltas)||projectedAssets===editor.doc.assets)return;
    projectedAssets=editor.doc.assets;fonts.syncAssets(projectedAssets??{});
  }));
  const components=createComponentService(editor);
  const styles=createStyleService(editor);
  const assets=createAssetService(editor);
  const libraries=createLibraryService(editor);
  const view=createRenderer(editor,workspace.stage,{...options,fonts,fontCatalog:fonts});
  cleanup.push(()=>view.destroy());
  const exporter=createExporter(editor,view,{...options,fonts,fontCatalog:fonts,saveFile:options.exportFile});
  const registry={
    editor,fonts,components,styles,assets,libraries,images,view,export:exporter,
    resolveImageSource:options.resolveImageSource,
    duplicateComponentMain,
    async outline(shape:any,kind:string,operation:any={}) {
      if(kind==='stroke') {
        await view.settled();
        return outlineStroke(shape.type==='boolean' ? view.projectedShape?.(shape.id)??shape : shape,{wasmUrl:options.wasmUrl,...operation});
      }
      await view.settled();
      return outlineText(shape,view.textFragments(shape.id),fonts.sources(),operation);
    },
    formats:{importDesignFile:options.importDesignFile,importCanvasJson,exportCanvasJson,portableDocument,importSvg,importHtml,exportHtml},
    boolean:(operation:string,shapes:any[])=>combinePaths(shapes,operation as any,{wasmUrl:options.wasmUrl,objects:editor.page.objects}),
    combinePaths:(shapes:any[],operation:string)=>combinePaths(shapes,operation as any,{wasmUrl:options.wasmUrl,objects:editor.page.objects}),
  };
  const services:EditorServices=Object.assign(registry,{commands:createCommands(editor,registry)});
  cleanup.push(()=>services.commands.destroy?.());
  const interaction=mountWorkspace(root,services,options);
  cleanup.push(()=>interaction.destroy());
  if(interaction.assets?.open)Object.assign(assets,{open:interaction.assets.open});
  // Commands receive the same mutable service registry; callbacks arrive after
  // the workspace exists, without introducing a UI import into the model.
  for(const key of ['edit','editPath','placeImage','openFind','openQuickActions','quickActions','rename','openFontPicker','pasteText','importClipboard','paste','copy','cut']){
    if(typeof interaction[key]==='function')services[key]=interaction[key].bind(interaction);
  }
  const handle={
    ...interaction,editor,view:services.view,renderer:services.view,
    export:services.export,fonts,commands:services.commands,assets:services.assets,
    services,save:options.save??null,loadStats:null,
    set:editor.setViewport.bind(editor),
    ready:()=>!destroyed,
    addFonts:(faces:any[])=>fonts.add(faces),
    async flush(){await interaction.flush?.();await services.view.settled();},
    async destroy(){
      if(destroyed)return;
      try{await interaction.flush?.();}catch(error){await dispose();throw error;}
      const errors=await dispose();
      if(errors.length)throw new AggregateError(errors,'Editor cleanup failed');
    },
  };
  await services.view.settled();
  return handle;
  }catch(error){await dispose();throw error;}finally{root.inert=previousInert;root.removeAttribute('aria-busy');}
}
