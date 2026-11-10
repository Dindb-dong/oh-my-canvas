import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import { once } from 'node:events';
import path from 'node:path';
import os from 'node:os';
import { WebSocket } from 'ws';
import * as Y from 'yjs';
import { Collaboration, parseInvite } from '../core/collaboration.mjs';
import { COLLAB_FRAME_BYTES, COLLAB_STATE_BYTES } from '../core/collaboration-transfer.mjs';
import { Store } from '../core/storage.mjs';
import { Replica } from '../core/replica.mjs';
import { assetRef, hashAsset } from '../core/assets.mjs';
import { changesBetween, MAX_ENVELOPE_BYTES } from '../core/document.mjs';
import { documentFixture, waitFor } from './helpers.mjs';

async function context(t) {
  const entries = [], directories = [];
  t.after(async () => {
    await Promise.all(entries.map(entry => entry.session.close()));
    entries.forEach(entry => entry.record.replica.destroy());
    await Promise.all(directories.map(directory => fs.rm(directory, { recursive: true, force: true })));
  });
  async function create(document, id = randomUUID(), name = 'Peer') {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'omc-transfer-')); directories.push(directory);
    const store = new Store(directory), record = { id, title: 'Shared', replica: new Replica(document ? { document: await store.prepareDocument(document) } : {}) }, events = [];
    if (document) await store.save(record);
    const session = new Collaboration({ replica: record.replica, id, title: record.title, name, assets: store.assets, persist: () => store.save(record), onMetric: event => events.push(event) });
    const entry = { store, record, session, events }; entries.push(entry); return entry;
  }
  async function host(document = documentFixture()) { const entry = await create(document, undefined, 'Host'); await entry.session.host({ bind: '127.0.0.1' }); entry.invite = entry.session.invite('127.0.0.1'); return entry; }
  async function guest(source) { const entry = await create(undefined, source.record.id, 'Guest'); await entry.session.join(source.invite); return entry; }
  return { create, host, guest };
}
async function rawPeer(t, host) {
  const invitation = parseInvite(host.invite);
  const socket = new WebSocket(invitation.url, { ca: invitation.cert, rejectUnauthorized: true, checkServerIdentity: () => undefined, headers: { Authorization: `Bearer ${invitation.token}` } });
  socket.on('error', () => {}); t.after(() => socket.terminate()); await once(socket, 'open');
  socket.send(JSON.stringify({ type: 'hello', v: 3, room: invitation.room, id: randomUUID(), name: 'Raw peer', vector: Buffer.from(Y.encodeStateVector(host.record.replica.ydoc)).toString('base64') }));
  return socket;
}
function updateWithAsset(replica, hash) {
  const remote = new Replica({ state: replica.state }), before = remote.document, after = structuredClone(before);
  after.assets = { image: { id: 'image', kind: 'image', mimeType: 'image/png', src: assetRef(hash) } };
  remote.patch(changesBetween(before, after), 'Add asset');
  const update = Y.encodeStateAsUpdate(remote.ydoc, Y.encodeStateVector(replica.ydoc)); remote.destroy(); return update;
}
function stateFrames(update, assets) {
  const id = randomUUID();
  return [{ type: 'state-start', id, bytes: update.length, sha256: createHash('sha256').update(update).digest('hex'), assets }, { type: 'state-chunk', id, offset: 0, data: Buffer.from(update).toString('base64') }, { type: 'state-end', id }];
}

test('a state larger than the old network envelope uses bounded frames and startup returns only the missing diff', async t => {
  const ctx = await context(t), document = documentFixture(); document.capacity = 'large'; document.notes = 'x'.repeat(MAX_ENVELOPE_BYTES + 1024);
  const host = await ctx.host(document), guest = await ctx.guest(host);
  assert.ok(host.record.replica.state.length > MAX_ENVELOPE_BYTES);
  assert.equal(guest.record.replica.document.notes.length, document.notes.length);
  await waitFor(() => [...host.session.clients.values()].every(peer => peer.synced), 10000);
  assert.ok(host.events.filter(event => event.stage === 'collaboration-frame').every(event => event.bytes <= COLLAB_FRAME_BYTES));
  assert.ok(host.events.filter(event => event.type === 'state-chunk').length > 20);
  assert.equal(guest.events.filter(event => event.type === 'state-start').length, 0);
  assert.equal(host.session.wss.options.maxPayload, COLLAB_FRAME_BYTES);
  assert.equal(MAX_ENVELOPE_BYTES, 24 * 1024 * 1024);
});

test('remote publication waits for verified asset durability and its ACK follows the save journal', async t => {
  const ctx = await context(t), bytes = Buffer.alloc(512 * 1024, 41), doc = documentFixture();
  doc.assets = { image: { id: 'image', kind: 'image', mimeType: 'image/png', src: `data:image/png;base64,${bytes.toString('base64')}` } };
  const host = await ctx.host(doc), guest = await ctx.create(undefined, host.record.id, 'Guest');
  const put = guest.store.assets.put.bind(guest.store.assets); let release, entered;
  const blocked = new Promise(resolve => { release = resolve; }), ready = new Promise(resolve => { entered = resolve; });
  guest.store.assets.put = async (...args) => { entered(); await blocked; return put(...args); };
  const joining = guest.session.join(host.invite); await ready;
  assert.equal(guest.record.replica.fields.size, 0);
  await assert.rejects(guest.store.assets.get(hashAsset(bytes)), /ENOENT/);
  release(); await joining;
  assert.equal(guest.record.replica.document.assets.image.src, assetRef(hashAsset(bytes)));
  assert.deepEqual((await guest.store.assets.get(hashAsset(bytes))).bytes, bytes);
  const reopened = await new Store(guest.store.dir).load(host.record.id);
  try { assert.deepEqual(reopened.replica.document, guest.record.replica.document); } finally { reopened.replica.destroy(); }
});

test('missing dependency declarations reject the remote update before publishing any references', async t => {
  const ctx = await context(t), host = await ctx.host(), before = Buffer.from(host.record.replica.state);
  const socket = await rawPeer(t, host), update = updateWithAsset(host.record.replica, hashAsset(Buffer.from('image'))), closed = once(socket, 'close');
  for (const message of stateFrames(update, [])) socket.send(JSON.stringify(message));
  await closed; assert.deepEqual(Buffer.from(host.record.replica.state), before); assert.equal(host.session.budget.used, 0);
});

test('asset digest mismatches fail before disk publication or document mutation', async t => {
  const ctx = await context(t), host = await ctx.host(), before = Buffer.from(host.record.replica.state), bytes = Buffer.from('expected-image'), hash = hashAsset(bytes);
  const socket = await rawPeer(t, host), update = updateWithAsset(host.record.replica, hash);
  const frames = stateFrames(update, [{ hash, mimeType: 'image/png', byteLength: bytes.length }]), id = frames[0].id;
  socket.on('message', raw => {
    const message = JSON.parse(raw);
    if (message.type !== 'state-need' || message.id !== id) return;
    const corrupt = Buffer.from(bytes); corrupt[0] ^= 1;
    for (const part of [{ type: 'asset-start', id, hash }, { type: 'asset-chunk', id, hash, offset: 0, data: corrupt.toString('base64') }, { type: 'asset-end', id, hash }]) socket.send(JSON.stringify(part));
  });
  const closed = once(socket, 'close'); for (const message of frames) socket.send(JSON.stringify(message)); await closed;
  assert.deepEqual(Buffer.from(host.record.replica.state), before); await assert.rejects(host.store.assets.get(hash), /ENOENT/); assert.equal(host.session.budget.used, 0);
});

test('oversized frames and declared states are refused independently of the local large-library budget', async t => {
  const ctx = await context(t), host = await ctx.host(), before = Buffer.from(host.record.replica.state);
  let socket = await rawPeer(t, host), closed = once(socket, 'close'); socket.send('x'.repeat(COLLAB_FRAME_BYTES + 1)); await closed;
  socket = await rawPeer(t, host); closed = once(socket, 'close');
  socket.send(JSON.stringify({ type: 'state-start', id: randomUUID(), bytes: COLLAB_STATE_BYTES + 1, sha256: '0'.repeat(64), assets: [] })); await closed;
  assert.deepEqual(Buffer.from(host.record.replica.state), before); assert.equal(host.session.budget.used, 0);
});

test('concurrent participants add independent assets, persist them and converge without losing either manifest entry', async t => {
  const ctx = await context(t), host = await ctx.host(), first = await ctx.guest(host), second = await ctx.guest(host);
  const entries = [first, second], hashes = [];
  for (const [index, entry] of entries.entries()) {
    const bytes = Buffer.alloc(32 * 1024, index + 1); hashes.push(hashAsset(bytes));
    const changes = await entry.store.prepareChanges([[JSON.stringify(['assets', `asset-${index}`]), { id: `asset-${index}`, kind: 'image', mimeType: 'image/png', src: `data:image/png;base64,${bytes.toString('base64')}` }]]);
    entry.record.replica.patch(changes, 'Add asset');
  }
  await waitFor(() => [host, first, second].every(entry => Object.keys(entry.record.replica.document.assets ?? {}).length === 2), 10000);
  for (const entry of [host, first, second]) for (const hash of hashes) assert.equal((await entry.store.assets.get(hash)).hash, hash);
  assert.deepEqual(first.record.replica.document, host.record.replica.document); assert.deepEqual(second.record.replica.document, host.record.replica.document);
});
