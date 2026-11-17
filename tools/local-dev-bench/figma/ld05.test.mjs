import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';
import {mergeLD05NativeHandoff, planLD05NativeCycle, planLD05Refresh} from './ld05.mjs';
import {projectSource, verifyProjection} from './ld05-run.mjs';

const run = (figma, {code}) => new (Object.getPrototypeOf(async function () {}).constructor)('figma',code)(figma);
const rawPng = [137,80,78,71,13,10,26,10,1,2];
const imageHash = '1234567890abcdef';

test('three scoped Figma edit receipts round trip independently into shared LD05 source merge', async () => {
  const contract = fileURLToPath(new URL('../ld05_contract.py',import.meta.url));
  const source = spawnSync('python3',['-B',contract,'route-board'],{encoding:'utf8'});
  assert.equal(source.status,0,source.stderr);
  const fixture = JSON.parse(source.stdout);
  const fileKey = 'synthetic-draft';
  const sessionId = '5bd636ba-7048-4fad-a896-46207a0bac92';
  let serial = 0;
  const nodes = new Map();
  const make = (type,parent,details) => {
    const node = {id:'1:'+ ++serial,type,parent,visible:true,locked:false,children:[],...details};
    nodes.set(node.id,node);
    parent?.children.push(node);
    return node;
  };
  const page = make('PAGE');
  const root = make('FRAME',page);
  const list = make('FRAME',root,{layoutMode:'VERTICAL',layoutWrap:'NO_WRAP',itemSpacing:12});
  const rgb = {r:37/255,g:51/255,b:87/255};
  const add = title => {
    const frame = make('FRAME',list,{cornerRadius:6,name:'standard'});
    const heading = make('TEXT',frame,{characters:title,fontName:{family:'Inter',style:'Regular'},fontSize:20,
      fills:[{type:'SOLID',color:rgb}]});
    const detail = make('TEXT',frame,{characters:'Baseline detail',getStyledTextSegments:()=>[]});
    const asset = make('RECTANGLE',frame,{fills:[{type:'IMAGE',imageHash}]});
    return {frame:frame.id,heading:heading.id,detail:detail.id,asset:asset.id,title};
  };
  const cards = fixture.cycles[0].source_state.cards.map(add);
  const scope = {fileKey,page:page.id,root:root.id,list:list.id,cards};
  const figma = {fileKey, getNodeByIdAsync:async id=>nodes.get(id), async setCurrentPageAsync() {},
    createImage:bytes=>{assert.deepEqual([...bytes],rawPng);return {hash:imageHash};},
    async loadFontAsync() {}, getImageByHash:hash=>hash===imageHash ? {getBytesAsync:async()=>new Uint8Array(rawPng)} : null};
  let css = '--card-gap: 12px; --card-radius: 6px; --card-heading-size: 20px; --accent: #253357; ' +
    '--variant-border: #718096; .cards { flex-direction: column; } .cards li { min-inline-size: 0; }';
  let data = 'export const extraCard = {"title":"Harbor transfer","detail":"Baseline detail","image":"city-route.png"};\n';
  for (let cycle = 1; cycle <= 3; cycle++) {
    if (cycle === 3) cards.push(add(fixture.cycles[2].result.cards.at(-1)));
    const changes = {...fixture.cycles[cycle-1].result,imageHash,imageBytes:rawPng};
    const plan = planLD05NativeCycle({fileKey,sessionId,scope,cycle,changes});
    await assert.rejects(run({...figma,fileKey:'other'},plan.edit),/Wrong synthetic Draft/);
    if (cycle === 3) {
      assert.throws(()=>planLD05NativeCycle({fileKey,sessionId,scope,cycle,changes:{...changes,imageBytes:undefined}}));
      // Model the remote server retaining only image hashes referenced by a fill.
      const lookup = figma.getImageByHash;
      let recreated = false;
      figma.getImageByHash = hash=>recreated?lookup(hash):null;
      const create = figma.createImage;
      figma.createImage = bytes=>{recreated=true;return create(bytes);};
    }
    await run(figma,plan.edit);
    const reobserved = await run(figma,plan.read);
    ({css,data} = await mergeLD05NativeHandoff({fixture,scope,cycle,reobserved,css,data,
      assetSha256:createHash('sha256').update(Buffer.from(rawPng)).digest('hex')}));
    if (cycle === 3) {
      await assert.rejects(mergeLD05NativeHandoff({fixture,scope,cycle,reobserved,css,data,
        assetSha256:'0'.repeat(64)}),/Uploaded original differs/);
    }
  }
  assert.match(css,/--card-gap: 20px;.*--accent: #145467;.*--variant-border: #8c3822;.*flex-flow: row wrap;.*flex: 1 1 14rem/);
  assert.match(data,/"detail":"Last pickup 17:40".*"image":"quay-route.png".*"variant":"priority"/);
});

test('browser-observed refresh and independent native readback preserve real source data and assets', () => {
  const fixture={title:'Source board',widths:[360,768,1200]};
  const wanted={cards:['One','Two'],keyboard_before:'Idle',keyboard_after:'Done',component:'Card',check_control_name:'Toggle'};
  const state={cards:wanted.cards.map(label=>({label,detail:'Body',variant:'standard',src:'./assets/first.png',loaded:true})),
    controlName:'Toggle',beforePress:'Idle',statusVisible:true,afterPress:'Done',styles:{gap:'12px',radius:'6px',heading:'20px',wrap:'nowrap',accent:'rgb(37, 51, 87)',
      variantBorder:'rgba(0, 0, 0, 0)'}};
  const assets={'first.png':Buffer.from(rawPng)};
  const hash=value=>createHash('sha256').update(value).digest('hex');
  const app_source="import {Card as createCard} from './card.mjs';";
  const module_source='export function createCard() {}\nexport {createCard as Card};';
  const boundary={app_source,module_source,app_sha256:hash(app_source),module_sha256:hash(module_source),
    initial_module_sha256:hash(module_source)};
  const source=projectSource(fixture,wanted,{evaluatedHtml:'<h1>Source board</h1>',states:
    fixture.widths.map(width=>({...state,width}))},assets,boundary);
  const scope={fileKey:'synthetic',page:'1:1',root:'1:2',list:'1:3',cards:[
    {frame:'1:4',heading:'1:5',detail:'1:6',asset:'1:7'},
    {frame:'1:8',heading:'1:9',detail:'1:10',asset:'1:11'},
  ]};
  const observed={document_id:scope.fileKey,page_id:scope.page,root_id:scope.root,list_id:scope.list,
    labels:source.labels,gap:12,direction:'VERTICAL',cards:scope.cards.map((card,index)=>({
      frameId:card.frame,headingId:card.heading,detailId:card.detail,assetId:card.asset,
      title:source.cards[index].title,detail:'Body',variant:'standard',radius:6,headingSize:20,
      accent:'#253357',imageBytes:rawPng,
    }))};
  verifyProjection(scope,observed,source,assets);
  assert.throws(()=>verifyProjection(scope,{...observed,page_id:'other'},source,assets));
  const damaged=structuredClone(observed);
  damaged.cards[0].imageBytes[0]=0;
  assert.throws(()=>verifyProjection(scope,damaged,source,assets),/Native source asset differs/);
});

test('native refresh creates real editable source rows and preserves their IDs across three cycles', async () => {
  let serial=100;
  const nodes=new Map();
  const figma={fileKey:'synthetic',root:{children:[]}, async loadFontAsync() {},
    async getNodeByIdAsync(id){return nodes.get(id);},
    async setCurrentPageAsync(page){this.currentPage=page;},
    getImageByHash:hash=>hash===imageHash?{getBytesAsync:async()=>new Uint8Array(rawPng)}:null,
    createImage:()=>({hash:imageHash})};
  const make=(type,parent)=>{
    const node={id:'1:'+ ++serial,type,children:[],visible:true,locked:false,layoutWrap:'NO_WRAP',
      resize(width,height){this.width=width;this.height=height;},
      appendChild(child){child.parent?.children.splice(child.parent.children.indexOf(child),1);child.parent=this;this.children.push(child);},
      insertChild(index,child){this.appendChild(child);this.children.pop();this.children.splice(index,0,child);},
      getStyledTextSegments(){return [{fontName:this.fontName}];},fills:[],strokes:[]};
    nodes.set(node.id,node);
    parent?.appendChild(node);
    return node;
  };
  figma.createPage=()=>{const page=make('PAGE');figma.root.children.push(page);return page;};
  for (const type of ['Frame','Text','Rectangle']) figma['create'+type]=()=>make(type.toUpperCase(),figma.currentPage);
  const anchors=Array.from({length:10},(_,index)=>{
    const page=figma.createPage();page.name='Atlas '+index;return {id:page.id,name:page.name};
  });
  const source={labels:{title:'Board',component:'Card'},cards:[{title:'One',detail:'First',variant:'standard',image:'first.png'},
    {title:'Two',detail:'Second',variant:'standard',image:'first.png'}],images:{'first.png':rawPng},
    gap:12,radius:6,headingSize:20,accent:'#253357',variantBorder:'#718096',wrap:false};
  const sessionId='5bd636ba-7048-4fad-a896-46207a0bac92';
  const pageName='LD05 route-board 012345abcdef';
  let scope;
  for (let cycle=1;cycle<=3;cycle++) {
    const prior=scope;
    if(cycle===2){source.labels.field_name='Dispatch note';source.labels.invalid_result='Invalid';}
    if(cycle===3){source.cards.push({title:'Three',detail:'Third',variant:'standard',image:'first.png'});source.wrap=true;}
    const plan=planLD05Refresh({fileKey:figma.fileKey,sessionId,pageName,scope,source,anchors});
    scope=await run(figma,plan);
    assert.equal(scope.cards.length,source.cards.length);
    if(prior) assert.deepEqual(scope.cards.slice(0,prior.cards.length),prior.cards);
    const read=planLD05NativeCycle({fileKey:figma.fileKey,sessionId,scope,cycle:1,
      changes:{gap:20,radius:14,heading_size:24}}).read;
    const observed=await run(figma,read);
    verifyProjection(scope,observed,source,{'first.png':Buffer.from(rawPng)});
  }
  assert.equal(figma.root.children.length,11);
});
