import https from 'node:https';
import { X509Certificate, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { WebSocketServer, WebSocket } from 'ws';
import * as Y from 'yjs';
import selfsigned from 'selfsigned';
import { decodeBase64 } from './assets.mjs';
import { CollaborationTransfer, COLLAB_FRAME_BYTES, COLLAB_PROTOCOL_VERSION } from './collaboration-transfer.mjs';

export { COLLAB_FRAME_BYTES, COLLAB_CHUNK_BYTES, COLLAB_STATE_BYTES, COLLAB_TRANSFER_BYTES } from './collaboration-transfer.mjs';
const VERSION = COLLAB_PROTOCOL_VERSION;
const ID = /^[a-f0-9-]{36}$/;
const safeEqual = (a, b) => typeof a === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const cleanName = value => String(value || 'Designer').replace(/[\x00-\x1f]/g, '').slice(0, 40);
const stateVector = replica => Buffer.from(Y.encodeStateVector(replica.ydoc)).toString('base64');
function parseVector(value) {
  if (typeof value !== 'string' || value.length > 128 * 1024) throw Error('Invalid collaboration state vector');
  const vector = decodeBase64(value, 'state vector'); Y.decodeStateVector(vector); return vector;
}

export function parseInvite(text) {
  if (typeof text !== 'string' || text.length > 16000 || !text.startsWith('omc://join/')) throw Error('Paste a valid Oh My Canvas invitation');
  let data;
  try { data = JSON.parse(Buffer.from(text.slice(11), 'base64url').toString()); } catch { throw Error('Invitation is damaged'); }
  if (data.v !== VERSION) throw Error('Update Oh My Canvas on all teammates before joining this session');
  const url = new URL(data.url);
  if (url.protocol !== 'wss:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash || !ID.test(data.room) || !/^[a-f0-9]{64}$/.test(data.token) || typeof data.cert !== 'string') throw Error('Invalid invitation fields');
  new X509Certificate(data.cert); return data;
}

export class Collaboration extends EventEmitter {
  constructor({ replica, id, title, name = 'Designer', peerId = randomUUID(), assets, persist, onMetric }) {
    super(); Object.assign(this, { replica, id, title, peerId, assets, persist, onMetric });
    this.name = cleanName(name); this.mode = 'offline'; this.clients = new Map(); this.closed = false; this.connected = false;
    this.budget = { used: 0 }; this.transfers = new Set();
    this.unsubscribe = replica.onUpdate((update, origin) => {
      if (origin === 'load') return;
      if (this.mode === 'host') {
        for (const [ws, info] of this.clients) if (info.ready && ws !== this.receivingFrom) info.transfer.sendUpdate(update).catch(() => {});
      } else if (origin !== 'remote' && this.connected) this.transfer?.sendUpdate(update).catch(() => {});
    });
  }
  status() {
    return { mode: this.mode, connected: this.mode === 'host' || this.connected, peers: [{ id: this.peerId, name: this.name, host: this.mode === 'host' }, ...this.clients.values()].map(peer => ({ id: peer.id, name: peer.name, host: !!peer.host })), port: this.port, error: this.error || null };
  }
  changed() { this.emit('status', this.status()); }
  warning(error) { this.error = String(error.message ?? error).slice(0, 300); this.emit('warning', 'A collaboration update was rejected: ' + this.error); }
  makeTransfer(ws, onApply) {
    const transfer = new CollaborationTransfer({ ws, replica: this.replica, assets: this.assets, persist: this.persist, budget: this.budget, onMetric: this.onMetric, onApply,
      applyUpdate: update => { this.receivingFrom = ws; try { this.replica.receive(update); } finally { this.receivingFrom = null; } },
      onError: error => this.warning(error) });
    this.transfers.add(transfer); ws.on('close', () => { transfer.dispose(); this.transfers.delete(transfer); });
    return transfer;
  }
  send(ws, message) {
    const transfer = this.mode === 'host' ? this.clients.get(ws)?.transfer : this.transfer;
    transfer?.send(message).catch(error => transfer.fail(error));
  }
  broadcast(message, except) {
    for (const [ws, info] of this.clients) if (ws !== except && info.synced) this.send(ws, message);
  }
  async host({ port = 0, bind = '0.0.0.0' } = {}) {
    if (this.mode !== 'offline') throw Error('Leave the current session first');
    const pems = await selfsigned.generate([{ name: 'commonName', value: 'Oh My Canvas' }], { days: 365, keySize: 2048, algorithm: 'sha256', extensions: [{ name: 'basicConstraints', cA: true }, { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, keyCertSign: true }] });
    this.cert = pems.cert; this.token = randomBytes(32).toString('hex'); this.mode = 'host';
    this.server = https.createServer({ key: pems.private, cert: pems.cert }, (_, response) => { response.writeHead(404); response.end(); });
    this.wss = new WebSocketServer({ noServer: true, maxPayload: COLLAB_FRAME_BYTES, perMessageDeflate: false });
    this.server.on('upgrade', (request, socket, head) => {
      const reject = code => socket.end(`HTTP/1.1 ${code}\r\nConnection: close\r\n\r\n`);
      if (request.headers.origin || request.url !== '/' || !safeEqual(request.headers.authorization, `Bearer ${this.token}`)) return reject('401 Unauthorized');
      if (this.clients.size >= 3) return reject('409 Conflict');
      this.wss.handleUpgrade(request, socket, head, ws => this.accept(ws));
    });
    try {
      await new Promise((resolve, reject) => { this.server.once('error', reject); this.server.listen(port, bind, resolve); });
      this.port = this.server.address().port;
      this.pulse = setInterval(() => { for (const [ws, peer] of this.clients) { if (peer.alive === false) ws.terminate(); else { peer.alive = false; ws.ping(); } } }, 15000);
      this.changed(); return this.port;
    } catch (error) { this.mode = 'offline'; this.server.close(); throw error; }
  }
  invite(address) {
    if (this.mode !== 'host') throw Error('Start hosting first');
    const url = new URL(`wss://${address}`); if (!url.port) url.port = String(this.port);
    const data = { v: VERSION, url: url.origin + '/', room: this.id, title: this.title, token: this.token, cert: this.cert };
    const invitation = 'omc://join/' + Buffer.from(JSON.stringify(data)).toString('base64url'); parseInvite(invitation); return invitation;
  }
  accept(ws) {
    const info = { id: randomUUID(), name: 'Connecting…', alive: true };
    this.clients.set(ws, info);
    const authTimer = setTimeout(() => ws.close(1008, 'Hello required'), 5000);
    info.transfer = this.makeTransfer(ws);
    ws.on('pong', () => { info.alive = true; });
    ws.on('message', raw => info.transfer.read(raw, async message => {
      if (message.type === 'hello' && !info.ready) {
        if (message.v !== VERSION) throw Error('Incompatible canvas protocol; update Oh My Canvas');
        if (message.room !== this.id || !ID.test(message.id) || message.id === this.peerId || [...this.clients.values()].some(peer => peer !== info && peer.ready && peer.id === message.id)) throw Error('Wrong room or peer identity');
        const vector = parseVector(message.vector);
        clearTimeout(authTimer); info.ready = true; info.id = message.id; info.name = cleanName(message.name);
        const welcome = { v: VERSION, id: this.id, title: this.title, vector: stateVector(this.replica), host: { id: this.peerId, name: this.name, host: true } };
        const update = Y.encodeStateAsUpdate(this.replica.ydoc, vector);
        info.transfer.sendUpdate(update, { welcome }).then(() => { info.synced = true; this.presence(); }).catch(() => {});
      } else if (!info.ready) throw Error('Hello required');
      else if (await info.transfer.handle(message)) return;
      else if (message.type === 'cursor' && info.synced) {
        const cursor = this.cleanCursor(message.cursor);
        this.broadcast({ type: 'cursor', id: info.id, name: info.name, cursor }, ws); this.emit('cursor', { id: info.id, name: info.name, cursor });
      } else throw Error('Unknown collaboration message');
    }));
    ws.on('error', () => {});
    ws.on('close', () => { clearTimeout(authTimer); this.clients.delete(ws); this.presence(); this.emit('cursor', { id: info.id, cursor: null }); });
  }
  presence() {
    const peers = [{ id: this.peerId, name: this.name, host: true }, ...[...this.clients.values()].filter(peer => peer.synced).map(peer => ({ id: peer.id, name: peer.name }))];
    this.broadcast({ type: 'peers', peers }); this.changed();
  }
  async join(invitation) {
    if (this.mode !== 'offline') throw Error('Leave the current session first');
    this.invitation = parseInvite(invitation);
    if (this.invitation.room !== this.id) throw Error('Invitation belongs to a different document');
    this.mode = 'guest'; await this.connect();
  }
  connect() {
    if (this.closed) return Promise.resolve();
    return new Promise((resolve, reject) => {
      let welcomed = false;
      const { url, cert, token } = this.invitation, expected = new X509Certificate(cert).fingerprint256;
      const ws = this.socket = new WebSocket(url, { ca: cert, rejectUnauthorized: true, checkServerIdentity: (_, peer) => peer.fingerprint256 === expected ? undefined : Error('Host certificate changed'), headers: { Authorization: `Bearer ${token}` }, maxPayload: COLLAB_FRAME_BYTES, perMessageDeflate: false, handshakeTimeout: 8000 });
      const handshakeTimer = setTimeout(() => ws.terminate(), 60000);
      const transfer = this.transfer = this.makeTransfer(ws, async ({ welcome }) => {
        if (!welcome) return;
        if (welcomed || welcome.v !== VERSION || welcome.id !== this.id || !ID.test(welcome.host?.id)) throw Error('Invalid collaboration welcome');
        const vector = parseVector(welcome.vector);
        this.connected = true; welcomed = true; this.error = null; this.retry = 0; clearTimeout(handshakeTimer);
        this.clients = new Map([[welcome.host.id, welcome.host]]);
        // Send only local/offline changes absent from the host's captured vector.
        const offline = Y.encodeStateAsUpdate(this.replica.ydoc, vector);
        // The canonical empty Yjs v1 update is [0, 0]. Avoid asking the host to
        // re-materialize and validate a large canvas when there is nothing to add.
        if (offline.byteLength !== 2 || offline[0] !== 0 || offline[1] !== 0) transfer.sendUpdate(offline).catch(() => {});
        this.changed(); resolve();
      });
      ws.on('open', () => transfer.send({ type: 'hello', v: VERSION, id: this.peerId, name: this.name, room: this.id, vector: stateVector(this.replica) }).catch(error => transfer.fail(error)));
      ws.on('message', raw => transfer.read(raw, async message => {
        if (message.type === 'state-start') {
          if (!welcomed && (!message.welcome || message.welcome.v !== VERSION || message.welcome.id !== this.id || !ID.test(message.welcome.host?.id))) throw Error('Welcome required');
          if (!welcomed) { parseVector(message.welcome.vector); clearTimeout(handshakeTimer); }
          else if (message.welcome) throw Error('Duplicate collaboration welcome');
        }
        if (await transfer.handle(message)) return;
        if (!welcomed) throw Error('Welcome required');
        if (message.type === 'peers') {
          if (!Array.isArray(message.peers) || message.peers.length > 4 || message.peers.some(peer => !ID.test(peer.id))) throw Error('Invalid collaboration peers');
          this.clients = new Map(message.peers.filter(peer => peer.id !== this.peerId).map(peer => [peer.id, { ...peer, name: cleanName(peer.name) }])); this.changed();
        } else if (message.type === 'cursor') this.emit('cursor', message);
        else throw Error('Unknown collaboration message');
      }));
      ws.on('error', error => { this.error = error.message; });
      ws.on('close', code => {
        clearTimeout(handshakeTimer); this.connected = false; this.clients.clear(); this.error = this.error || `Host disconnected (${code})`; this.changed();
        if (!welcomed) reject(Error(this.error));
        if (!this.closed) this.reconnect = setTimeout(() => this.connect().catch(() => {}), Math.min(1000 * 2 ** (this.retry = (this.retry || 0) + 1), 15000));
      });
    });
  }
  cleanCursor(cursor) {
    if (!cursor) return null;
    if (!Number.isFinite(cursor.x) || !Number.isFinite(cursor.y) || typeof cursor.page !== 'string' || cursor.page.length > 1024) throw Error('Invalid cursor');
    return { x: cursor.x, y: cursor.y, page: cursor.page, selection: Array.isArray(cursor.selection) ? cursor.selection.filter(value => typeof value === 'string' && value.length <= 1024).slice(0, 50) : [] };
  }
  cursor(value) {
    const cursor = this.cleanCursor(value);
    if (this.mode === 'host') this.broadcast({ type: 'cursor', id: this.peerId, name: this.name, cursor });
    else if (this.connected) this.send(this.socket, { type: 'cursor', cursor });
  }
  async close() {
    this.closed = true; clearTimeout(this.reconnect); clearInterval(this.pulse); this.unsubscribe();
    for (const transfer of this.transfers) transfer.dispose();
    this.socket?.terminate(); for (const [ws] of this.clients) if (typeof ws.terminate === 'function') ws.terminate();
    this.wss?.close(); if (this.server) await new Promise(resolve => this.server.close(resolve));
    this.clients.clear(); this.mode = 'offline'; this.connected = false; this.changed();
  }
}
