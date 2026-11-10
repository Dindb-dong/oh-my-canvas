import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Replica} from '../core/replica.mjs';
import {changesBetween} from '../core/document.mjs';
import {documentFixture} from './helpers.mjs';

function patch(replica,mutate,history=false){
  const before=replica.document,after=structuredClone(before);
  mutate(after.pagesById.page.objects.label);
  replica.patch(changesBetween(before,after),'Initialize canvas',undefined,{recordHistory:history});
}
test('initial normalization persists without introducing a user Undo entry',()=>{
  const r=new Replica({document:documentFixture()});
  try{
    patch(r,s=>{s.name='Normalized';s.y=180;});
    assert.equal(r.undo.undoStack.length,0);
    const reopened=new Replica({state:r.state});
    try{assert.equal(reopened.document.pagesById.page.objects.label.y,180);assert.equal(reopened.document.pagesById.page.objects.label.name,'Normalized');}finally{reopened.destroy();}
    patch(r,s=>{s.x=90;},true);r.history('undo');
    assert.equal(r.document.pagesById.page.objects.label.x,30);
    assert.equal(r.document.pagesById.page.objects.label.y,180);
  }finally{r.destroy();}
});
test('system replacements collect superseded payloads and keep speculative/live replicas equivalent',()=>{
  const r=new Replica({document:documentFixture()});
  try{
    for(let i=0;i<10;i++){
      patch(r,s=>{s.name=`${i}:`+'x'.repeat(2*1024*1024);});
      assert.equal(r.undo.undoStack.length,0);
      assert.ok(r.state.byteLength<3*1024*1024,'System history must not accumulate ten large prior names');
      // Scalar edits need not allocate a speculative document. Request one
      // explicitly here to check both its lazy seed and later live updates.
      assert.deepEqual(r.validateState(r.validator()),r.document);
    }
    patch(r,s=>{s.y=45;},true);r.history('undo');assert.equal(r.document.pagesById.page.objects.label.y,40);
  }finally{r.destroy();}
});
test('invalid system initialization is atomic and does not poison subsequent initialization',()=>{
  const r=new Replica({document:documentFixture()});
  try{
    const before=r.document,bytes=Buffer.from(r.state);
    assert.throws(()=>patch(r,s=>{s.width=Infinity;}));
    assert.deepEqual(r.document,before);assert.deepEqual(Buffer.from(r.state),bytes);
    patch(r,s=>{s.name='Recovered';});assert.equal(r.document.pagesById.page.objects.label.name,'Recovered');assert.equal(r.undo.undoStack.length,0);
  }finally{r.destroy();}
});
