import assert from 'node:assert/strict';
import test from 'node:test';
import {normalizePaperLD06,paperLD06Markup} from './ld06.mjs';

const row=(id,name,parentId,component,box,textContent)=>({id,name,parentId,component,
  worldX:box[0],worldY:box[1],width:box[2],height:box[3],textContent,isLocked:false,isVisible:true});

test('normalizes actual native values without upgrading CSS font labels to font bytes or glyph evidence',()=>{
  const scope={fileId:'synthetic-file'};
  const details={canvas:row('root','canvas','page','Frame',[300,400,1040,920]),
    card:row('card','card','root','Frame',[324,488,306,200]),
    caption:row('caption','caption','card','Text',[null,null,246,22],'실제 관찰 문구'),
    image:row('picture','image','card','Frame',[340,504,160,104])};
  const styles={caption:{fontFamily:'"Noto Sans KR"'},picture:{backgroundSize:'cover',backgroundPosition:'center'}};
  const images={image:{width:96,height:128,rgba_sha256:'actual-decoded-pixels',stored_sha256:'actual-stored-png'}};
  const observed=normalizePaperLD06(scope,details,styles,images),caption=observed.nodes.find(x=>x.key==='caption');
  assert.equal(caption.text,'실제 관찰 문구');
  assert.equal(caption.font_family,'Noto Sans KR');
  assert.equal(caption.bounds,null);
  assert.equal(caption.font_sha256,undefined);
  assert.equal(caption.fully_visible,undefined);
  assert.equal(observed.glyph_render,undefined);
  assert.deepEqual(observed.nodes.find(x=>x.key==='card').bounds,[24,88,306,200]);
  const picture=observed.nodes.find(x=>x.key==='image');
  assert.equal(picture.asset_rgba_sha256,'actual-decoded-pixels');
  assert.deepEqual(picture.crop_source_px,[0,32.8,96,62.4]);
  const unpositioned=normalizePaperLD06(scope,details,{picture:{backgroundSize:'cover'}},images);
  assert.equal(unpositioned.nodes.find(x=>x.key==='image').crop_source_px,undefined);
  assert.throws(()=>normalizePaperLD06(scope,{...details,caption:{...details.caption,parentId:'outside'}},styles,images),/parent missing/);
});

test('native import markup retains editable text and escaped registered asset paths',()=>{
  const parent={bounds:[24,88,306,200]},fixture={font:{family:'Noto Sans KR'}};
  const caption={key:'card/0/caption',kind:'text',text:'실제 <문구> & source',bounds:[40,245,246,22]};
  const html=paperLD06Markup(caption,parent,fixture);
  assert.match(html,/layer-name="card\/0\/caption"/);
  assert.match(html,/left:16px;top:157px/);
  assert.match(html,/실제 &lt;문구&gt; &amp; source/);
  const image={key:'card/0/image',kind:'image',bounds:[40,104,160,104]};
  assert.match(paperLD06Markup(image,parent,fixture,{path:'/synthetic/input.png'}),/paper-asset:\/\/\/synthetic\/input.png/);
  assert.throws(()=>paperLD06Markup(image,parent,fixture),/asset/);
});
