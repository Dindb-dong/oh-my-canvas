import {DESIGN_FILE_LIMIT} from '../core/capacity.mjs';
import path from 'node:path';
import {decodeFile,encodeFile} from '../core/storage.mjs';
import {assertDocument,MAX_ENVELOPE_BYTES,MAX_DOCUMENT_BYTES} from '../core/document.mjs';
import {parseInvite} from '../core/collaboration.mjs';
import {canvasTitle} from './document-actions.mjs';
import {readExplicitFile,writeExplicitFile,MAX_INLINE_BYTES,MAX_EXPORT_BYTES} from './file-transfer.mjs';

export const DESKTOP_TOOL_NAMES=new Set(['workspace','preferences','save_document','delete_document','import_document','export_document','import_resource','collaboration']);
const error=(code,message)=>Object.assign(Error(message),{code});
export function createWorkspaceTools({readDesignFile,manager,store,profile,sourceRoot,importCanvasJson,exportCanvasJson,validateImportedDocument,runtimeRequest,preferences,notifyPreferences,connection,about,windowState,capabilities,sampleColor,requestQuit,editorTool,join,host,stopSession,checkBusy,context}){
  async function targeted(id,signal){
    if(!id)throw error('document_required','An explicit documentId is required');
    const entry=await manager.load(id);signal?.throwIfAborted();return entry;
  }
  async function withEntry(id,signal,work){
    const entry=await targeted(id,signal);entry.holds=(entry.holds??0)+1;
    try{return await work(entry);}finally{entry.holds--;await manager.release(entry);}
  }
  return async function desktopTool(call,signal){
    const args=call.args,agent=call.agent,request=(entry,name,args)=>runtimeRequest(entry,name,args,{signal,agent});signal?.throwIfAborted();
    if(call.name==='workspace'){
      if(args.action==='state')return {ok:true,...manager.state(),boundDocumentId:manager.bindings.get(agent)??null};
      if(args.action==='show_library')return {ok:true,...manager.showLibrary()};
      if(args.action==='connection')return {ok:true,...connection(args)};
      if(args.action==='sample_color')return {ok:true,...await sampleColor(args)};
      if(args.action==='capabilities')return {ok:true,...capabilities(),limits:{inlineBytes:MAX_INLINE_BYTES,importBytes:MAX_ENVELOPE_BYTES,exportBytes:MAX_EXPORT_BYTES,resourceBytes:MAX_DOCUMENT_BYTES}};
      if(args.action==='quit'){requestQuit();return {ok:true,quitting:true};}
      if(args.action==='about')return {ok:true,...about()};
      if(args.action==='window')return {ok:true,...windowState(args)};
      if(args.action==='focus'){const entry=await manager.open(args.documentId,{agent,focus:true,signal});return {ok:true,documentId:entry.record.id,...manager.state()};}
      if(args.action==='close'){
        const entry=await targeted(args.documentId,signal);await checkBusy(entry,agent,signal);await manager.closeTab(args.documentId,{guardBusy:true,signal,agent});
        if(args.release!==false)await manager.releaseAgent(agent,args.documentId);
        return {ok:true,...manager.state(),boundDocumentId:manager.bindings.get(agent)??null};
      }
      throw error('bad_args','Unknown workspace action');
    }
    if(call.name==='preferences'){
      if(args.action==='get')return {ok:true,preferences:await preferences()};
      if(args.action!=='set')throw error('bad_args','Unknown preferences action');
      const data={};
      if(args.name!==undefined){if(typeof args.name!=='string'||!args.name.trim()||args.name.length>40||/[\x00-\x1f]/.test(args.name))throw error('bad_args','Name must contain 1–40 printable characters');data.name=args.name;}
      if(args.view!==undefined)data.view=args.view;
      if(args.starred!==undefined){
        await withEntry(args.documentId,signal,async()=>{});data.documentId=args.documentId;data.starred=args.starred;
      }
      const result=await preferences(data);notifyPreferences(result);return {ok:true,preferences:result};
    }
    if(call.name==='save_document')return withEntry(args.id,signal,async entry=>{
      await checkBusy(entry,agent,signal);if(entry.runtime)await request(entry,'flush',{guardBusy:true});signal?.throwIfAborted();await manager.save(entry);
      return {ok:true,documentId:entry.record.id,saved:true};
    });
    if(call.name==='delete_document'){
      if(!args.expectedTitle)throw error('bad_args','expectedTitle must match the current canvas title');
      await manager.remove(args.id,{expectedTitle:args.expectedTitle,beforeRemove:entry=>entry.runtime?request(entry,'prepare-delete'):undefined,cancelRemove:entry=>entry.runtime?runtimeRequest(entry,'cancel-delete'):undefined});
      return {ok:true,documentId:args.id,deleted:true};
    }
    if(call.name==='import_document'){
      if((args.payload===undefined)===(args.filePath===undefined))throw error('bad_args','Supply exactly one of payload or filePath');
      const design=['fig','sketch'].includes(args.format);
      if(design&&!args.filePath)throw error('bad_args','Design imports require an explicit filePath');
      const bytes=args.filePath?await readExplicitFile(args.filePath,{limit:design?DESIGN_FILE_LIMIT:MAX_ENVELOPE_BYTES,protectedDirectory:profile,signal}):Buffer.from(args.payload,'utf8');
      if(bytes.length>(design?DESIGN_FILE_LIMIT:MAX_ENVELOPE_BYTES))throw error('bad_args',`Document file exceeds ${(design?DESIGN_FILE_LIMIT:MAX_ENVELOPE_BYTES)/1024/1024} MiB`);
      const raw=design?'':bytes.toString('utf8'),options={agent,focus:args.focus??false,signal};let entry,warnings=[];
      if(design){
        const result=await readDesignFile(bytes,args.format);warnings=result.warnings;validateImportedDocument(result.document);
        entry=await manager.create(args.title??path.basename(args.filePath,path.extname(args.filePath)),assertDocument(result.document),options);
      }else if(args.format==='json'){
        const input=JSON.parse(raw);validateImportedDocument(input);const document=assertDocument(importCanvasJson(input));validateImportedDocument(document);
        entry=await manager.create(args.title??(args.filePath?path.basename(args.filePath,path.extname(args.filePath)):'Imported canvas'),document,options);
      }else{
        const record=decodeFile(raw);
        try{validateImportedDocument(record.replica.document);}catch(error){record.replica.destroy();throw error;}
        if(args.mode==='copy'){try{entry=await manager.create(args.title??record.title,record.replica.document,options);}finally{record.replica.destroy();}}
        else try{
          if(args.title!==undefined)record.title=canvasTitle(args.title);
          const existing=manager.entries.get(record.id);
          if(existing){
            if(existing.agents.size||existing.collab||existing.holds||manager.deleting.has(record.id))throw error('busy','Imported canvas is in use. Release its agent bindings and collaboration first');
            await checkBusy(existing,agent,signal);record.replica.receive(existing.record.replica.state);
          }
          if(!existing){try{const saved=await store.load(record.id);try{record.replica.receive(saved.replica.state);}finally{saved.replica.destroy();}}catch(e){if(e.code!=='ENOENT')throw e;}}
          validateImportedDocument(record.replica.document);entry=await manager.load(record.id,record);
          if(args.title!==undefined)await manager.rename(entry.record.id,args.title,{signal});
          entry.holds=(entry.holds??0)+1;
          try{await manager.save(entry);await manager.open(entry.record.id,options);}finally{entry.holds--;}
        }catch(e){if(!entry)record.replica.destroy();else if(!entry.runtime&&!entry.tabOpen&&!entry.agents.size&&!entry.collab)manager.discard(entry);throw e;}
      }
      return {ok:true,documentId:entry.record.id,document:{id:entry.record.id,title:entry.record.title},...(warnings.length?{warnings}:{}),context:await context(entry,agent,signal)};
    }
    if(call.name==='export_document')return withEntry(args.id,signal,async entry=>{
      await checkBusy(entry,agent,signal);if(entry.runtime)await request(entry,'flush',{guardBusy:true});signal?.throwIfAborted();await manager.save(entry);
      let bytes,mimeType;
      if(args.format==='omc'){bytes=Buffer.from(encodeFile(entry.record));mimeType='application/vnd.ohmycanvas+json';}
      else if(args.format==='json'){bytes=Buffer.from(JSON.stringify(exportCanvasJson(entry.record.replica.document)));mimeType='application/json';}
      else{
        await manager.ensureRuntime(entry);
        const exported=await request(entry,'export-data',{format:args.format,ids:args.ids,scale:args.scale,quality:args.quality,bounds:args.bounds,background:args.background,omitFill:args.omitFill,constraint:args.constraint,agent});
        if(typeof exported.data!=='string'||exported.data.length>Math.ceil(MAX_EXPORT_BYTES*4/3)+4)throw error('invalid','Invalid or oversized renderer export');
        bytes=Buffer.from(exported.data,'base64');mimeType=exported.mimeType;
      }
      signal?.throwIfAborted();if(bytes.length>MAX_EXPORT_BYTES)throw error('invalid','Export exceeds 100 MiB');
      if(args.filePath)return {ok:true,documentId:entry.record.id,format:args.format,mimeType,...await writeExplicitFile(args.filePath,bytes,{overwrite:args.overwrite??false,protectedDirectory:profile,protectedDirectories:sourceRoot?[sourceRoot]:[],signal})};
      if(bytes.length>MAX_INLINE_BYTES)throw error('response_limit','Export is too large for an inline response; supply filePath');
      return {ok:true,documentId:entry.record.id,format:args.format,mimeType,encoding:'base64',data:bytes.toString('base64'),bytes:bytes.length};
    });
    if(call.name==='import_resource')return withEntry(args.documentId,signal,async entry=>{
      await checkBusy(entry,agent,signal);
      const bytes=await readExplicitFile(args.filePath,{limit:MAX_DOCUMENT_BYTES,protectedDirectory:profile,signal});
      let name,toolArgs;
      if(args.kind==='library'){name='libraries';toolArgs={action:'add',snapshot:JSON.parse(bytes.toString('utf8'))};}
      else{
        const extension=path.extname(args.filePath).slice(1).toLowerCase(),types={png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',webp:'image/webp',gif:'image/gif',bmp:'image/bmp',ico:'image/x-icon',avif:'image/avif',svg:'image/svg+xml',woff2:'font/woff2',woff:'font/woff',ttf:'font/ttf',otf:'font/otf'};
        const mimeType=types[extension];if(!mimeType||args.kind==='font'&&!mimeType.startsWith('font/')||args.kind!=='font'&&!mimeType.startsWith('image/'))throw error('bad_args','File type does not match the resource kind');
        name='document_assets';toolArgs={action:'add',kind:args.kind,name:args.name??path.basename(args.filePath),dataUrl:`data:${mimeType};base64,${bytes.toString('base64')}`,...Object.fromEntries(['family','weight','fontStyle','unicodeRange'].filter(key=>args[key]!==undefined).map(key=>[key,args[key]]))};
      }
      signal?.throwIfAborted();const result=await editorTool(entry,{agent,name,args:toolArgs},signal);
      if(result.isError)throw error(result.structuredContent?.error?.code??'invalid',result.structuredContent?.error?.message??'Resource import failed');
      return {...result.structuredContent,documentId:entry.record.id};
    });
    if(call.name==='collaboration'){
      if(args.action==='join'){
        const invitation=parseInvite(args.invite);
        if(args.documentId!==invitation.room)throw error('document_required','documentId must match the document in this invitation');
        const result=await join({...args,agent,signal,focus:args.focus??false,replace:false});return {ok:true,...result};
      }
      return withEntry(args.documentId,signal,async entry=>{
        if(args.action==='status')return {ok:true,documentId:entry.record.id,...entry.collab?.status()??{mode:'offline',connected:false,peers:[]}};
        if(args.action==='cursor'){
          if(!entry.collab)throw error('invalid','Start or join collaboration first');
          if(args.cursor){const page=entry.record.replica.document.pagesById[args.cursor.page];if(!page||(args.cursor.selection??[]).some(id=>!page.objects[id]))throw error('bad_args','Cursor page or selection was not found');}
          entry.collab.cursor(args.cursor??null);return {ok:true,documentId:entry.record.id};
        }
        await checkBusy(entry,agent,signal);signal?.throwIfAborted();
        if(args.action==='host'){
          if(entry.collab)throw error('busy','Leave the existing collaboration session before hosting');
          if(entry.runtime)await request(entry,'flush',{guardBusy:true});
          const result=await host(entry,args);return {ok:true,documentId:entry.record.id,...result};
        }
        if(args.action==='invite'){
          if(!entry.collab||entry.collab.mode!=='host')throw error('invalid','Start hosting this canvas first');
          return {ok:true,documentId:entry.record.id,invite:entry.collab.invite(args.address)};
        }
        if(args.action==='leave'){await stopSession(entry);return {ok:true,documentId:entry.record.id,mode:'offline'};}
        throw error('bad_args','Unknown collaboration action');
      });
    }
    throw error('unknown_tool','Unknown desktop tool');
  };
}
