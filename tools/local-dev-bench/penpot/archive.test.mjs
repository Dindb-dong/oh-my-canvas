import assert from 'node:assert/strict';
import {test} from 'node:test';
import {archiveHash,snapshotCode,validateArchiveEvidence} from './archive.mjs';

const fileId = n => `00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const box = (id,name,parent,type,bounds,fill) => ({
  id:fileId(id),name,parent,type,bounds,editable:true,fills:[[fill,1]],
});
const source = {
  fileId:fileId(1),pageId:fileId(2),
  fileName:'OMC Benchmark LD09 / small / 0',pageName:'LD09 lifecycle',
  shapes:[
    {...box(3,'LD09 lifecycle board',null,'board',[0,0,400,240],'#fffefa'),
      layout:'column',gap:12,padding:[16,16,16,16]},
    {...box(4,'LD09 editable caption','LD09 lifecycle board','text',[16,16,285,30],'#000000'),
      text:'Library status: awaiting review',font:'fixture-font',size:'19'},
    box(5,'Qualification swatch','LD09 lifecycle board','rectangle',[16,58,64,32],'#2952a3'),
    box(6,'Qualification indicator','LD09 lifecycle board','ellipse',[16,102,16,16],'#065f46'),
  ],
};
const events = [
  'headless_launch_requested','headless_browser_ready','first_window','fresh_project_ready',
  'import_upload_requested','import_review_ready','import_confirmed','import_complete',
  'first_native_content','asset_font_ready','native_equivalence_verified','first_accepted_edit',
  'warm_reopen_requested','warm_reopen_content','warm_reopen_verified',
].map((name,elapsedMs) => ['first_window','asset_font_ready'].includes(name) ? {name,status:'unobservable'}
  : {name,status:'observed',elapsedMs});

function evidence() {
  const bytes = Buffer.alloc(64);
  bytes.writeUInt32BE(0x504b0304);
  const archiveSha256 = archiveHash(bytes);
  const imported = structuredClone(source);
  imported.fileId = fileId(7);
  imported.shapes[0].id = fileId(8);
  const edited = structuredClone(imported);
  edited.shapes[1].text = 'Library status: ready for review';
  edited.shapes[1].bounds[2] = 300;
  return {
    bytes,
    bundle:{source,archiveSha256},
    candidate:{
      schema:'penpot-ld09-archive/1',route:'native-penpot-archive-import',
      archiveSha256,imported,edited,reopened:structuredClone(edited),events:structuredClone(events),
      saveResponseObserved:false,
    },
  };
}

test('archive proof checks exact input digest, imported native semantics, and edit persistence', () => {
  const proof = evidence();
  validateArchiveEvidence(proof.bundle,proof.candidate,proof.bytes);
  proof.bytes[55] = 1;
  assert.throws(() => validateArchiveEvidence(proof.bundle,proof.candidate,proof.bytes));
  assert.throws(() => archiveHash(Buffer.from('not a Penpot archive')));
  assert.doesNotThrow(() => new Function('penpot',snapshotCode(fileId(1),true)));
});

test('archive proof rejects relabelled files, altered contents, and out-of-order clocks', () => {
  const {bundle,candidate,bytes} = evidence();
  const changed = structuredClone(candidate);
  changed.imported.fileId = bundle.source.fileId;
  assert.throws(() => validateArchiveEvidence(bundle,changed,bytes));
  changed.imported.fileId = candidate.imported.fileId;
  changed.imported.shapes[2].bounds[0] = 22;
  assert.throws(() => validateArchiveEvidence(bundle,changed,bytes), /archive semantics/);
  changed.imported = candidate.imported;
  changed.reopened.shapes[1].id = fileId(9);
  assert.throws(() => validateArchiveEvidence(bundle,changed,bytes), /lost a native identity/);
  changed.reopened = candidate.reopened;
  changed.events.at(-1).elapsedMs = 0;
  assert.throws(() => validateArchiveEvidence(bundle,changed,bytes));
});
