import https from 'node:https';
import { X509Certificate, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { WebSocketServer, WebSocket } from 'ws';
import selfsigned from 'selfsigned';
import {MAX_ENVELOPE_BYTES} from './document.mjs';

const MAX = MAX_ENVELOPE_BYTES;
const safeEqual = (a,b) => typeof a === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const cleanName = s => String(s || 'Designer').replace(/[\x00-\x1f]/g,'').slice(0,40);
export function parseInvite(text) {
  if (typeof text !== 'string' || text.length > 16000 || !text.startsWith('omc://join/')) throw Error('Paste a valid Oh My Canvas invitation');
  let data;
  try { data = JSON.parse(Buffer.from(text.slice(11), 'base64url').toString()); } catch { throw Error('Invitation is damaged'); }
  if(data.v!==2)throw Error('Update Oh My Canvas on all teammates before joining this session');
  const url = new URL(data.url);
  if (url.protocol !== 'wss:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash || !/^[a-f0-9-]{36}$/.test(data.room) || !/^[a-f0-9]{64}$/.test(data.token) || typeof data.cert !== 'string') throw Error('Invalid invitation fields');
  new X509Certificate(data.cert);
  return data;
}
export class Collaboration extends EventEmitter {
  constructor({ replica, id, title, name = 'Designer', peerId = randomUUID() }) {
    super(); this.replica = replica; this.id = id; this.title = title; this.name = cleanName(name); this.peerId = peerId;
    this.mode = 'offline'; this.clients = new Map(); this.closed = false; this.connected = false;
    this.unsubscribe = replica.onUpdate((update, origin) => {
      if (origin === 'load') return;
      const msg = { type:'update', data:Buffer.from(update).toString('base64') };
      if (this.mode === 'host') this.broadcast(msg);
      else if (origin !== 'remote' && this.socket?.readyState === WebSocket.OPEN && this.connected) this.send(this.socket,msg);
    });
  }
  status() {
    return { mode:this.mode, connected:this.mode === 'host' || this.connected, peers:[{id:this.peerId,name:this.name,host:this.mode==='host'}, ...this.clients.values()].map(p => ({id:p.id,name:p.name,host:!!p.host})), port:this.port, error:this.error || null };
  }
  changed() { this.emit('status',this.status()); }
  send(ws,msg) { if (ws.readyState === WebSocket.OPEN) { if (ws.bufferedAmount > MAX * 2) ws.close(1013,'Connection too slow'); else ws.send(JSON.stringify(msg)); } }
  broadcast(msg, except) { for (const [ws] of this.clients) if (ws !== except) this.send(ws,msg); }
  async host({ port = 0, bind = '0.0.0.0' } = {}) {
    if (this.mode !== 'offline') throw Error('Leave the current session first');
    const pems = await selfsigned.generate([{ name:'commonName',value:'Oh My Canvas' }], { days:365, keySize:2048, algorithm:'sha256', extensions:[{name:'basicConstraints',cA:true},{name:'keyUsage',digitalSignature:true,keyEncipherment:true,keyCertSign:true}] });
    this.cert = pems.cert; this.token = randomBytes(32).toString('hex'); this.mode = 'host';
    this.server = https.createServer({key:pems.private,cert:pems.cert}, (_,res) => { res.writeHead(404);res.end(); });
    this.wss = new WebSocketServer({ noServer:true, maxPayload:MAX, perMessageDeflate:false });
    this.server.on('upgrade',(req,socket,head) => {
      const reject = code => {socket.end(`HTTP/1.1 ${code}\r\nConnection: close\r\n\r\n`);};
      if (req.headers.origin || req.url !== '/' || !safeEqual(req.headers.authorization, `Bearer ${this.token}`)) return reject('401 Unauthorized');
      if (this.clients.size >= 3) return reject('409 Conflict');
      this.wss.handleUpgrade(req,socket,head, ws => this.accept(ws));
    });
    try {
      await new Promise((resolve,reject) => { this.server.once('error',reject); this.server.listen(port,bind,resolve); });
      this.port = this.server.address().port;
      this.pulse = setInterval(() => { for (const [ws,p] of this.clients) { if (p.alive === false) ws.terminate(); else {p.alive=false;ws.ping();} } },15000);
      this.changed(); return this.port;
    } catch (e) { this.mode='offline';this.server.close();throw e; }
  }
  invite(address) {
    if (this.mode !== 'host') throw Error('Start hosting first');
    const u = new URL(`wss://${address}`);
    if (!u.port) u.port = String(this.port);
    const data = { v:2,url:u.origin+'/',room:this.id,title:this.title,token:this.token,cert:this.cert };
    const invite = 'omc://join/'+Buffer.from(JSON.stringify(data)).toString('base64url');
    parseInvite(invite); return invite;
  }
  accept(ws) {
    const info = {id:randomUUID(),name:'Connecting…',alive:true};
    this.clients.set(ws,info);
    const authTimer = setTimeout(() => ws.close(1008,'Hello required'),5000);
    ws.on('pong',() => {info.alive=true;});
    ws.on('message',data => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'hello' && !info.ready) {
          if (msg.v!==2)throw Error('Incompatible canvas protocol; update Oh My Canvas');
          if (msg.room !== this.id || typeof msg.id !== 'string') throw Error('Wrong room');
          clearTimeout(authTimer);info.ready=true;info.id=msg.id;info.name=cleanName(msg.name);
          this.send(ws,{type:'welcome',v:2,id:this.id,title:this.title,state:Buffer.from(this.replica.state).toString('base64'),host:{id:this.peerId,name:this.name,host:true}});
          this.presence();
        } else if (!info.ready) throw Error('Hello required');
        else if (msg.type === 'update') this.replica.receive(Buffer.from(msg.data,'base64'));
        else if (msg.type === 'cursor') {
          const cursor = this.cleanCursor(msg.cursor); this.broadcast({type:'cursor',id:info.id,name:info.name,cursor},ws);this.emit('cursor',{id:info.id,name:info.name,cursor});
        } else throw Error('Unknown message');
      } catch(e) {this.send(ws,{type:'error',message:String(e.message).slice(0,300)});this.emit('warning','A collaboration update was rejected: '+e.message);ws.close(1008,'Invalid collaboration message'); }
    });
    ws.on('error',() => {});
    ws.on('close',() => { clearTimeout(authTimer);this.clients.delete(ws);this.presence();this.emit('cursor',{id:info.id,cursor:null}); });
  }
  presence() {
    const peers = [{id:this.peerId,name:this.name,host:true},...[...this.clients.values()].filter(p=>p.ready).map(p=>({id:p.id,name:p.name}))];
    this.broadcast({type:'peers',peers});this.changed();
  }
  async join(invitation) {
    if (this.mode !== 'offline') throw Error('Leave the current session first');
    this.invitation = parseInvite(invitation);this.mode='guest';
    if (this.invitation.room !== this.id) throw Error('Invitation belongs to a different document');
    await this.connect();
  }
  connect() {
    if (this.closed) return Promise.resolve();
    return new Promise((resolve,reject) => {
      let welcomed=false;
      const {url,cert,token} = this.invitation;
      const expected = new X509Certificate(cert).fingerprint256;
      const ws = this.socket = new WebSocket(url,{ ca:cert,rejectUnauthorized:true,checkServerIdentity:(_,peer) => peer.fingerprint256 === expected ? undefined : Error('Host certificate changed'),headers:{Authorization:`Bearer ${token}`},maxPayload:MAX,perMessageDeflate:false,handshakeTimeout:8000 });
      const timeout = setTimeout(()=>ws.terminate(),12000);
      ws.on('open',()=>this.send(ws,{type:'hello',v:2,id:this.peerId,name:this.name,room:this.id}));
      ws.on('message',data => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.type === 'welcome') {
            if(msg.v!==2)throw Error('Incompatible canvas protocol; update Oh My Canvas');
            if (msg.id !== this.id) throw Error('Wrong document');
            this.replica.receive(Buffer.from(msg.state,'base64'));
            this.connected=true;welcomed=true;this.error=null;this.retry=0;
            clearTimeout(timeout);
            // Full state also contains local offline updates the host does not yet have.
            this.send(ws,{type:'update',data:Buffer.from(this.replica.state).toString('base64')});
            this.clients = new Map([[msg.host.id,msg.host]]);this.changed();resolve();
          } else if (!welcomed) throw Error('Welcome required');
          else if (msg.type === 'update') this.replica.receive(Buffer.from(msg.data,'base64'));
          else if (msg.type === 'peers') {this.clients=new Map(msg.peers.filter(p=>p.id!==this.peerId).map(p=>[p.id,p]));this.changed();}
          else if (msg.type === 'cursor') this.emit('cursor',msg);
          else if (msg.type === 'error') {this.error=String(msg.message).slice(0,300);this.emit('warning',this.error);}
        } catch(e) {this.error=e.message;this.emit('warning','A collaboration update was rejected: '+e.message);ws.close(1008,'Invalid collaboration message');}
      });
      ws.on('error',e=>{this.error=e.message;});
      ws.on('close',(code)=>{
        clearTimeout(timeout);this.connected=false;this.clients.clear();this.error=this.error || `Host disconnected (${code})`;this.changed();
        if (!welcomed) reject(Error(this.error));
        if (!this.closed) this.reconnect=setTimeout(()=>this.connect().catch(()=>{}),Math.min(1000*2**(this.retry=(this.retry||0)+1),15000));
      });
    });
  }
  cleanCursor(c) {
    if (!c) return null;
    if (!Number.isFinite(c.x) || !Number.isFinite(c.y) || typeof c.page !== 'string') throw Error('Invalid cursor');
    return {x:c.x,y:c.y,page:c.page,selection:Array.isArray(c.selection)?c.selection.filter(s=>typeof s==='string').slice(0,50):[]};
  }
  cursor(c) {
    const cursor=this.cleanCursor(c);
    if (this.mode==='host') this.broadcast({type:'cursor',id:this.peerId,name:this.name,cursor});
    else if (this.connected) this.send(this.socket,{type:'cursor',cursor});
  }
  async close() {
    this.closed=true;clearTimeout(this.reconnect);clearInterval(this.pulse);this.unsubscribe();
    this.socket?.terminate();for (const [ws] of this.clients) if (typeof ws.terminate==='function') ws.terminate();
    this.wss?.close();if(this.server) await new Promise(r=>this.server.close(r));
    this.clients.clear();this.mode='offline';this.connected=false;this.changed();
  }
}
