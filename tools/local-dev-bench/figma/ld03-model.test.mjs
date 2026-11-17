import assert from 'node:assert/strict';
import { test } from 'node:test';
import { figmaLD03Driver } from './ld03-model.mjs';

const scope = {
  fixture: 'field-relay', fileKey: 'approved_synthetic_draft',
  sessionId: '11111111-2222-4333-8444-555555555555',
  nativeIds: {'target/accent':'VariableID:1:3', 'target/spacing':'VariableID:1:4',
    'keep/accent':'VariableID:1:5', 'keep/spacing':'VariableID:1:6'},
  before: {target:{accent:'#2864dc',spacing_px:12},archive:{accent:'#2864dc',spacing_px:12}},
};

function fake() {
  const edits = [];
  const rows = Object.entries(scope.nativeIds).map(([name,id],index) => ({
    name, id, remote:false, variableCollectionId:'collection-1', resolvedType:index%2 ? 'FLOAT' : 'COLOR',
    valuesByMode: {'regular':index%2 ? 12 : {r:40/255,g:100/255,b:220/255,a:1}},
    setValueForMode(mode,value) {
      edits.push(this.id);
      this.valuesByMode[mode] = value;
    },
  }));
  const figma = {fileKey:scope.fileKey, variables:{
    async getLocalVariablesAsync(){return rows;},
    async getLocalVariableCollectionsAsync(){return [{id:'collection-1',modes:[{modeId:'regular'}],defaultModeId:'regular'}];},
  }};
  const invoke = async args => {
    assert.equal(args.fileKey,scope.fileKey);
    assert.equal(args.sessionId,scope.sessionId);
    const program = new (Object.getPrototypeOf(async function () {}).constructor)('figma',args.code);
    return {content:[{type:'text',text:JSON.stringify(await program(figma))}]};
  };
  return {figma, rows, edits, invoke};
}

test('official Figma driver exposes only typed inspect and a one-shot edit of two variables', async () => {
  const local = fake();
  const driver = figmaLD03Driver(scope,local.invoke);
  assert.deepEqual(await driver.inspect(),scope.before);
  const next = {accent:'#135B9D',spacing_px:21};
  assert.throws(() => driver.apply({...next, fileKey:'outside'}),/Invalid shared values/);
  const state = await driver.apply(next);
  assert.deepEqual(state,{target:{...next,accent:'#135b9d'},archive:scope.before.archive});
  assert.deepEqual(local.edits,['VariableID:1:3','VariableID:1:4']);
  assert.deepEqual(await driver.inspect(),state);
  assert.throws(() => driver.apply(next),/Only one native LD03 write/);
});

test('Figma scope mismatch or protected drift fails before native mutation', async () => {
  for (const corrupt of [
    ({figma}) => {figma.fileKey = 'unapproved_file';},
    ({rows}) => {rows[0].id = 'VariableID:2:4';},
    ({rows}) => {rows[2].valuesByMode.regular = {r:0,g:0,b:0};},
    ({rows}) => {rows[1].valuesByMode.regular = 18;},
  ]) {
    const local = fake();
    corrupt(local);
    await assert.rejects(figmaLD03Driver(scope,local.invoke).apply({accent:'#135b9d',spacing_px:21}),
      /Wrong synthetic|Wrong native|Protected archive|Target values/);
    assert.deepEqual(local.edits,[]);
  }
});

test('a failed native response consumes the only write attempt', async () => {
  const driver = figmaLD03Driver(scope, () => ({isError:true}));
  const valid = {accent:'#135b9d',spacing_px:21};
  await assert.rejects(driver.apply(valid),/Figma rejected/);
  assert.throws(() => driver.apply(valid),/Only one native LD03 write/);
});
