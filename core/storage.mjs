import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { Replica } from './replica.mjs';
import {MAX_ENVELOPE_BYTES} from './document.mjs';
import {MAX_STATE_BYTES,MAX_LARGE_BYTES} from './capacity.mjs';
import {gzipSync,gunzipSync} from 'node:zlib';
export const validId = id => typeof id === 'string' && /^[a-f0-9-]{36}$/.test(id);
function assertMetadata(record) {
  if (!record || !validId(record.id) || typeof record.title !== 'string' || !record.title.trim() || record.title.length > 1024) throw Error('Invalid canvas metadata: title or ID');
  for (const field of ['createdAt','updatedAt']) if (record[field] !== undefined && (typeof record[field] !== 'string' || record[field].length > 64 || !Number.isFinite(Date.parse(record[field])))) throw Error(`Invalid canvas metadata: ${field}`);
  if (record.thumbnail !== undefined && (typeof record.thumbnail !== 'string' || record.thumbnail.length >= 500000 || !record.thumbnail.startsWith('data:image/'))) throw Error('Invalid canvas metadata: thumbnail');
}
export async function atomicWrite(file, data, {backup=true}={}) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await fs.open(tmp, 'wx', 0o600);
    try { await handle.writeFile(data); await handle.sync(); } finally { await handle.close(); }
    if(backup)try { await fs.copyFile(file, `${file}.bak`); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    await fs.rename(tmp, file);
    const dir = await fs.open(path.dirname(file), 'r');
    try { await dir.sync(); } catch (e) { if (!['EINVAL','EPERM','EBADF'].includes(e.code)) throw e; } finally { await dir.close(); }
  } finally { await fs.rm(tmp, { force: true }); }
}
export function encodeFile({ id, title, replica, createdAt, thumbnail }) {
  assertMetadata({id,title,createdAt,thumbnail});
  const bytes=replica.state,version=bytes.byteLength>MAX_STATE_BYTES?3:2;
  const state = Buffer.from(version===3?gzipSync(bytes):bytes).toString('base64');
  const data=JSON.stringify({ format: 'oh-my-canvas', version, id, title, createdAt, updatedAt: new Date().toISOString(), thumbnail, sha256: createHash('sha256').update(state).digest('hex'), state });
  if(Buffer.byteLength(data)>MAX_ENVELOPE_BYTES)throw Error('Portable file exceeds 384 MiB');return data;
}
function envelope(data) {
  if (Buffer.byteLength(data) > MAX_ENVELOPE_BYTES) throw Error('File exceeds 384 MiB');
  const f = JSON.parse(data);
  if (!f || f.format !== 'oh-my-canvas' || ![1,2,3].includes(f.version) || !validId(f.id) || typeof f.state !== 'string' || createHash('sha256').update(f.state).digest('hex') !== f.sha256) throw Error('Invalid or damaged Oh My Canvas file');
  assertMetadata(f);return f;
}
export function decodeFile(data) {
  const f=envelope(data),encoded=Buffer.from(f.state,'base64');
  const state=f.version===3?gunzipSync(encoded,{maxOutputLength:MAX_LARGE_BYTES}):encoded;
  // Encoded state is transport data; retaining its string duplicates hundreds of MiB for large libraries.
  delete f.state;data='';
  const replica = new Replica({ state });
  replica.document;
  return { ...f, replica };
}
export class Store {
  constructor(dir) { this.dir = dir; this.pending = new Map(); this.saved = new Map(); this.listed = new Map(); this.listing = null; }
  file(id) { if (!validId(id)) throw Error('Invalid document ID'); return path.join(this.dir, `${id}.omc`); }
  async load(id) {
    const file = this.file(id);
    try { return decodeFile(await fs.readFile(file, 'utf8')); }
    catch (original) {
      try { const recovered = decodeFile(await fs.readFile(`${file}.bak`, 'utf8')); recovered.recovered = true; this.saved.delete(id); return recovered; }
      catch { throw original; }
    }
  }
  async save(record) {
    assertMetadata(record);
    // Capture the requested revision before waiting for an earlier fsync.
    const {id,title,createdAt,thumbnail}=record, state=record.replica.state, recovered=!!record.recovered;
    const fingerprint=createHash('sha256').update(JSON.stringify([title,createdAt,thumbnail])).update(state).digest('hex');
    const writing = (this.pending.get(id) ?? Promise.resolve()).catch(() => {}).then(async () => {
      if(!recovered && this.saved.get(id)===fingerprint)return;
      const data=encodeFile({id,title,createdAt,thumbnail,replica:{state}});
      await atomicWrite(this.file(id),data,{backup:!recovered});
      this.saved.set(id,fingerprint);
    });
    this.pending.set(id, writing);
    try { await writing;record.recovered=false; } finally { if (this.pending.get(id) === writing) this.pending.delete(id); }
  }
  async list() {
    if(this.listing)return this.listing;
    this.listing=this.readList();
    try{return await this.listing;}finally{this.listing=null;}
  }
  async readList() {
    await fs.mkdir(this.dir, { recursive: true });
    const items = [];
    for (const name of await fs.readdir(this.dir)) {
      if (!name.endsWith('.omc') || !validId(name.slice(0,-4))) continue;
      try {
        const id=name.slice(0,-4),file=this.file(id),stat=await fs.stat(file),signature=stat.mtimeMs+':'+stat.size,large=stat.size>24*1024*1024;
        const cached=this.listed.get(id);if(cached?.signature===signature){items.push(cached.metadata);continue;}
        let f;
        if(large){
          // A library listing verifies its envelope without instantiating another full CRDT replica.
          try{f=envelope(await fs.readFile(file,'utf8'));}
          catch(original){try{f=envelope(await fs.readFile(file+'.bak','utf8'));f.recovered=true;}catch{throw original;}}
        }else f=await this.load(id);
        const metadata={ id: f.id, title: f.title, updatedAt: f.updatedAt, createdAt: f.createdAt, thumbnail: f.thumbnail, recovered: !!f.recovered };
        items.push(metadata);f.replica?.destroy();delete f.state;
        if(!f.recovered)this.listed.set(id,{signature,metadata});
      } catch { items.push({ id: name.slice(0,-4), title: 'Damaged document', damaged: true }); }
    }
    return items.sort((a,b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  }
  async remove(id) { await this.pending.get(id); this.listed.delete(id); this.saved.delete(id); await fs.rm(this.file(id), {force:true}); await fs.rm(`${this.file(id)}.bak`, {force:true}); }
}
