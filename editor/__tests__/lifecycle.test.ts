// @vitest-environment jsdom
import {beforeEach,expect,it,vi} from 'vitest';
import {createDocument} from '../document';
const state=vi.hoisted(()=>({events:[] as string[],mountError:false,flushError:false,cleanupError:false}));
vi.mock('../fonts',()=>({createFontCatalog:()=>({syncAssets:vi.fn(),ensure:async()=>{},catalog:()=>[],destroy:()=>{state.events.push('fonts');if(state.cleanupError)throw Error('Font cleanup failed');}})}));
vi.mock('../render',()=>({combinePaths:vi.fn(),createRenderer:()=>({settled:async()=>{},destroy:()=>state.events.push('view')})}));
vi.mock('../export',()=>({createExporter:()=>({})}));
vi.mock('../ui',()=>({createWorkspaceRoot:(root:HTMLElement)=>{const stage=document.createElement('div');root.append(stage);return {stage};},mountWorkspace:()=>{if(state.mountError)throw Error('Workspace mount failed');return {flush:async()=>{if(state.flushError)throw Error('Text flush failed');},destroy:()=>state.events.push('interaction')};}}));
import {mountEditor} from '../index';
beforeEach(()=>{state.events=[];state.mountError=false;state.flushError=false;state.cleanupError=false;document.body.replaceChildren();});
const setup=()=>{const root=document.createElement('div');document.body.append(root);return root;};
it('normal disposal reports cleanup failures while releasing remaining resources and DOM',async()=>{
 const root=setup(),handle=await mountEditor(root,{document:createDocument()});state.cleanupError=true;
 await expect(handle.destroy()).rejects.toThrow('Editor cleanup failed');
 expect(state.events).toEqual(['interaction','view','fonts']);expect(root.childNodes.length).toBe(0);await handle.destroy();
});
it('flush failure remains the reported cause and still releases every mounted resource',async()=>{
 const root=setup(),handle=await mountEditor(root,{document:createDocument()});state.flushError=true;state.cleanupError=true;
 await expect(handle.destroy()).rejects.toThrow('Text flush failed');expect(state.events).toEqual(['interaction','view','fonts']);expect(root.childNodes.length).toBe(0);
});
it('failed mount releases earlier services and preserves original failure over cleanup errors',async()=>{
 const root=setup();state.mountError=true;state.cleanupError=true;
 await expect(mountEditor(root,{document:createDocument()})).rejects.toThrow('Workspace mount failed');expect(state.events).toEqual(['view','fonts']);expect(root.childNodes.length).toBe(0);expect(root.inert).toBeFalsy();expect(root.hasAttribute('aria-busy')).toBe(false);
});
