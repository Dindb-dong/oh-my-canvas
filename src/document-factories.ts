import {importCanvasJson} from '../editor/formats/canvas';
import {blankCanvas,sampleCanvas} from './sample';

export const blankDocument=()=>importCanvasJson(blankCanvas());
export const sampleDocument=()=>importCanvasJson(sampleCanvas());

export {importCanvasJson,exportCanvasJson} from '../editor/formats/canvas';
export {portableDocument} from '../editor/images/assets';

export {validateImportedDocument} from '../editor/mcp/import-document';
