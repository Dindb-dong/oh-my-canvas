import assert from 'node:assert/strict';
import {isDeepStrictEqual} from 'node:util';

import {withPaper} from './ld03.mjs';

const copyName = 'OMC Benchmark LD03 verification / ld03-copy-cap-01';
const pageName = 'LD03 preflight / field-relay-cap-01';
const boardName = 'Field relay roster';
const prefix = 'omc-ld03-field-relay-cap-01';
const expectedDigest = 'b7017f570e4fcdb728cf715ad9bcfdc26b905c91d3b687e19c81125ec76a2a57';
const tokenDefinitions = [
  ['target.accent', 'color', 'target-accent'],
  ['target.spacing', 'spacing', 'target-spacing'],
  ['keep.accent', 'color', 'keep-accent'],
  ['keep.spacing', 'spacing', 'keep-spacing'],
].map(([key,type,suffix]) => ({key,type,name:`--${type}-${prefix}-${suffix}`}));

function validValues(style) {
  return typeof style?.accent === 'string' && /^#[a-f0-9]{6}$/i.test(style.accent) &&
    Number.isInteger(style.spacing_px) && style.spacing_px >= 0 && style.spacing_px <= 128;
}
const compact = get => ({
  target: {accent: get('target.accent'), spacing_px: get('target.spacing')},
  archive: {accent: get('keep.accent'), spacing_px: get('keep.spacing')},
});

export function verifyPaperLd03Clone({scope, originalScope, cloneReceipt, fixture}) {
  assert.equal(fixture.workload, 'LD03');
  assert.equal(fixture.source_family_id, 'field-relay');
  assert.equal(fixture.fixture_sha256, expectedDigest);
  assert.equal(cloneReceipt.status, 'copied-background-readable');
  assert.match(scope.fileId, /^[-\w]+$/);
  assert.equal(scope.fileId, cloneReceipt.copy.fileId);
  assert.equal(scope.fileName, copyName);
  assert.equal(scope.fileName, cloneReceipt.copy.name);
  assert.match(originalScope.fileId, /^[-\w]+$/);
  assert.notEqual(scope.fileId, originalScope.fileId);
  assert.equal(scope.prefix, prefix);
  assert.equal(scope.pageId, cloneReceipt.candidatePage.id);
  assert.equal(cloneReceipt.candidatePage.name, pageName);
  assert.ok(typeof scope.boardId === 'string' && scope.boardId);
}

function verifyRegistration(registration) {
  verifyPaperLd03Clone(registration);
  const {baseline, scope, fixture} = registration;
  assert.equal(baseline.document_id, scope.fileId);
  assert.equal(baseline.style_identity, 'paper-file-scoped-custom-property-name');
  assert.match(baseline.raster_sha256, /^[0-9a-f]{64}$/);
  assert.equal(baseline.nodes.length, fixture.logical_objects);
  assert.equal(baseline.styles.length, tokenDefinitions.length);
  for (const {key, type, name} of tokenDefinitions) {
    const target = fixture.start.styles.find(row => row.key === key);
    const found = baseline.styles.filter(row => row.key === key);
    assert.equal(found.length, 1);
    assert.equal(found[0].kind, type === 'color' ? 'color' : 'length');
    assert.equal(found[0].native_id, JSON.stringify([scope.fileId,name]));
    assert.equal(found[0].value, target.value, 'Independent initial shared values differ from the fixture');
  }
  assert.deepEqual(Object.fromEntries(baseline.nodes.map(node => [node.key,node.native_id])),scope.nodes,
    'Independent initial native ID map differs from the approved scope');
  assert.equal(scope.nodes.board, scope.boardId);
  assert.equal(new Set(Object.values(scope.nodes)).size, fixture.logical_objects);
}

function normalizeTokens(results) {
  const rows = results.flatMap(result => result.tokens);
  assert.equal(rows.length, tokenDefinitions.length);
  const values = new Map();
  for (const wanted of tokenDefinitions) {
    const matched = rows.filter(row => row?.name === wanted.name && row.type === wanted.type);
    assert.equal(matched.length, 1, 'Incorrect native binding inventory');
    const v = matched[0].value;
    if (wanted.type === 'color') {
      assert.match(v, /^#[a-f0-9]{6}$/i);
      values.set(wanted.key,v.toLowerCase());
    } else {
      assert.match(v, /^(0|[1-9][0-9]*)px$/);
      values.set(wanted.key, Number(v.slice(0,-2)));
    }
  }
  const current = compact(key => values.get(key));
  assert.ok(validValues(current.target) && validValues(current.archive));
  return current;
}

export function createPaperLd03ModelHandlers(registration) {
  verifyRegistration(registration);
  const scope = structuredClone(registration.scope);
  const connect = registration.connect ?? (task => withPaper(scope, task));
  const audit = registration.audit ?? (() => {});
  let last = compact(key => registration.baseline.styles.find(row => row.key === key).value);
  let active = false;
  let halted = false;

  function nativeCaller(read) {
    return async function call(name, args = {}) {
      const arguments_ = {...args,fileId:scope.fileId};
      try {
        const result = await read({name,arguments:arguments_});
        audit({action:name,arguments:arguments_,result});
        return result;
      } catch (error) {
        audit({action:name,arguments:arguments_,error:error.message});
        throw error;
      }
    };
  }

  async function inspectNative(call) {
    const home = await call('get_basic_info');
    assert.equal(home.fileName,scope.fileName);
    assert.ok(home.pages.some(page => page.id === scope.pageId && page.name === pageName));
    const page = await call('get_basic_info',{pageId:scope.pageId});
    assert.equal(page.fileName,scope.fileName);
    assert.ok(page.artboards.some(board => board.id === scope.boardId && board.name === boardName));
    const rows = [];
    for (const type of ['color','spacing']) {
      rows.push(await call('get_tokens',{types:[type],namePattern:`--${type}-${prefix}-*`,format:'json'}));
    }
    return normalizeTokens(rows);
  }

  async function run(action) {
    assert.ok(!halted, 'Paper tool paused after a prior binding or write mismatch');
    assert.ok(!active, 'Paper tool already has an in-flight operation');
    active = true;
    try {
      return await connect(read => action(nativeCaller(read)));
    } finally {
      active = false;
    }
  }

  async function checked(call) {
    try {
      const current = await inspectNative(call);
      assert.ok(isDeepStrictEqual(current,last), 'Registered or last committed shared values differ');
      return current;
    } catch {
      halted = true;
      throw new Error('Paper shared values did not match the approved target and state');
    }
  }

  return {
    async inspect() {
      return await run(checked);
    },
    async apply(values) {
      assert.ok(values && Object.keys(values).sort().join(',') === 'accent,spacing_px' && validValues(values),
        'Invalid Paper shared value inputs');
      const requested = {accent:values.accent.toLowerCase(),spacing_px:values.spacing_px};
      return await run(async call => {
        const current = await checked(call);
        const tokens = [
          {name:tokenDefinitions[0].name,value:requested.accent},
          {name:tokenDefinitions[1].name,value:`${requested.spacing_px}px`},
        ];
        try {
          const acknowledgement = await call('set_tokens',{tokens});
          assert.equal(acknowledgement.tokens.length,2);
          assert.deepEqual(acknowledgement.tokens.map(row => [row.name,row.result]).sort(),
            tokens.map(row => [row.name,'updated']).sort());
          const observed = await inspectNative(call);
          assert.ok(isDeepStrictEqual(observed,{target:requested,archive:current.archive}), 'Candidate or archive differs');
          last = observed;
          return observed;
        } catch {
          halted = true;
          try {
            const observed = await inspectNative(call);
            audit({action:'reconcile-set-tokens',observed,
              targetMatchesRequest:isDeepStrictEqual(observed.target,requested),
              archiveUnchanged:isDeepStrictEqual(observed.archive,current.archive)});
          } catch {
            audit({action:'reconcile-set-tokens',observed:null});
          }
          throw new Error('Paper write could not be confirmed. Further writes are disabled');
        }
      });
    },
  };
}
