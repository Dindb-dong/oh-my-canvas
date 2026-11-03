/** Interoperability contracts written for the independent implementation.
 * Shape records intentionally retain unknown fields for portable-file compatibility.
 * Coordinates are WORLD coordinates, including path endpoints/control points.
 */
export type Data = Record<string, any>;
export type Point = {x:number;y:number};
export type Rect = Point & {width:number;height:number};
export type Matrix = {a:number;b:number;c:number;d:number;e:number;f:number};
export type ShapeType = 'frame'|'group'|'boolean'|'rect'|'ellipse'|'path'|'text'|'image'|'svg';
export interface Shape extends Data {id:string;type:ShapeType;parentId:string;enclosingFrameId:string;x:number;y:number;width:number;height:number;box:Rect;corners:Point[];transform:Matrix;inverseTransform:Matrix;rotation:number;childIds?:string[];content?:any;}
export interface Page extends Data {id:string;name?:string;objects:Record<string,Shape>;}
export interface CanvasDocument extends Data {pages:string[];pagesById:Record<string,Page>;components?:Record<string,Data>;styles?:Record<string,Data>;libraries?:Record<string,Data>;}
export interface Viewport {vport:{width:number;height:number};vbox:Rect;zoom:number;}
export type Tool = 'move'|'frame'|'rect'|'ellipse'|'polygon'|'star'|'line'|'arrow'|'pencil'|'pen'|'text';
export interface Operation {id:string;label?:string;author?:string;group?:string;}
export interface EditorEvent {changes?:unknown[];operation?:Operation;selection?:boolean;hover?:boolean;deltas?:boolean;viewport?:boolean;tool?:boolean;page?:boolean;projection?:boolean;}
export type Mutator<T=any> = (draft:CanvasDocument)=>T;
export interface EditorOptions {reconcile?:(before:CanvasDocument,draft:CanvasDocument)=>void;validate?:(draft:CanvasDocument)=>void;}
export interface EditorStore {
 doc:CanvasDocument;readonly page:Page;pageId:string;selection:string[];viewport:Viewport;tool:Tool;hover:string|null;
 undo:{blocked:boolean;[key:string]:any};[key:string]:any;
 on(listener:(event:EditorEvent)=>void):()=>void;
 transact<T>(operation:Operation|string,mutate:Mutator<T>):T;
 begin(label:string):boolean;preview(mutate:Mutator):void;commitSession():boolean;cancelSession():void;
 setSelection(ids:string[]):void;setHover(id:string|null):void;setPage(id:string):void;setTool(tool:Tool):void;setViewport(viewport:Viewport):void;
 replaceDocument(doc:CanvasDocument):void;receiveDocument(doc:CanvasDocument):void;
 undoStep():boolean;redoStep():boolean;destroy():void;
}
export interface Measured {x:number;y:number;w:number;h:number;scrollW:number;scrollH:number;clippedText:boolean;overflowParent:boolean;fontFallback?:string;imageFailed?:boolean;}
export interface Shot {data:string;mimeType:string;slices?:number;}
export interface FontFaceInput {family:string;url:string;weight?:number|string;style?:string;unicodeRange?:string;label?:string;}
export interface FontCatalog {[key:string]:any;catalog():Data[];add(faces:FontFaceInput[]):void;syncAssets(assets:Data):void;prepareAssets(assets:Data):Promise<()=>void>;ready():Promise<void>;destroy():void;}
export interface RenderView {
 settled():Promise<void>;measure(ids:string[]):Map<string,Measured>;computedStyle(id:string,keys?:string[]):Record<string,string>;
 screenshot(id?:string,options?:{mode?:'slice'|'overview';slice?:number}):Promise<Shot>;
 thumbnailSvg?(pageId:string,id:string):Promise<string>;
 element(id:string):HTMLElement|null;render():void;destroy():void;[key:string]:any;
}
export interface ExportService {svg(ids:string[]):Promise<string>;png(id:string,scale?:number,bounds?:Rect):Promise<Uint8Array|null>;raster(id:string,options?:Data):Promise<Blob|null>;pdf(id:string):Promise<Blob>;saveFile?:(blob:Blob,name:string)=>Promise<unknown>;[key:string]:any;}
export interface Commands {get(id:string):Data|undefined;enabled(id:string):boolean;run(id:string,args?:Data):boolean|Promise<boolean>;list():Data[];[key:string]:any;}
export interface ComponentService {run(action:string,args:Data):Data;list(query?:string,offset?:number):Data;reconcile(before:CanvasDocument,draft:CanvasDocument):void;[key:string]:any;}
export interface StyleService {[key:string]:any;}
export interface EditorServices {editor:EditorStore;view:RenderView;fonts:FontCatalog;export:ExportService;commands:Commands;components:ComponentService;styles:StyleService;[key:string]:any;}
export interface MountOptions extends Data {document:any;faces?:FontFaceInput[];title?:string;subtitle?:string;defaultFamily?:string;fallbacks?:string[];wasmUrl?:string;exportFile?:(blob:Blob,name:string)=>Promise<unknown>;}
export interface WorkspaceHandle {session:any;editingText():string|null;highlightAgent(agent:string,ids:string[]):void;edit(id:string,select?:boolean,create?:boolean):void;editPath(id:string):void;destroy():void;[key:string]:any;}
export type ToolResult = {content:Data[];structuredContent?:Data;isError?:boolean};
