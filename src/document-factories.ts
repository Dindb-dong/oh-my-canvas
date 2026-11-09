import {importCanvasJson} from '../editor/formats/canvas';
import {blankCanvas,sampleCanvas} from './sample';

export const blankDocument=()=>importCanvasJson(blankCanvas());
export const sampleDocument=()=>importCanvasJson(sampleCanvas());
