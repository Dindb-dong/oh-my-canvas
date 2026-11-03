import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { Replica } from './replica.mjs';
import {MAX_ENVELOPE_BYTES} from './document.mjs';
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
  const state = Buffer.from(replica.state).toString('base64');
  const data=JSON.stringify({ format: 'oh-my-canvas', version: 2, id, title, createdAt, updatedAt: new Date().toISOString(), thumbnail, sha256: createHash('sha256').update(state).digest('hex'), state });
  if(Buffer.byteLength(data)>MAX_ENVELOPE_BYTES)throw Error('Portable file exceeds 24 MiB');return data;
}
export function decodeFile(data) {
  if (Buffer.byteLength(data) > MAX_ENVELOPE_BYTES) throw Error('File exceeds 24 MiB');
  const f = JSON.parse(data);
  if (!f || f.format !== 'oh-my-canvas' || ![1,2].includes(f.version) || !validId(f.id) || typeof f.state !== 'string' || createHash('sha256').update(f.state).digest('hex') !== f.sha256) throw Error('Invalid or damaged Oh My Canvas file');
  assertMetadata(f);
  const replica = new Replica({ state: Buffer.from(f.state, 'base64') });
  replica.document;
  return { ...f, replica };
}
export class Store {
  constructor(dir) { this.dir = dir; this.pending = new Map(); }
  file(id) { if (!validId(id)) throw Error('Invalid document ID'); return path.join(this.dir, `${id}.omc`); }
  async load(id) {
    const file = this.file(id);
    try { return decodeFile(await fs.readFile(file, 'utf8')); }
    catch (original) {
      try { const recovered = decodeFile(await fs.readFile(`${file}.bak`, 'utf8')); recovered.recovered = true; return recovered; }
      catch { throw original; }
    }
  }
  async save(record) {
    // Serialize writes for each document; a slow earlier fsync must not overwrite a newer state.
    const data = encodeFile(record), id = record.id;
    const writing = (this.pending.get(id) ?? Promise.resolve()).catch(() => {}).then(() => atomicWrite(this.file(id), data,{backup:!record.recovered}));
    this.pending.set(id, writing);
    try { await writing;record.recovered=false; } finally { if (this.pending.get(id) === writing) this.pending.delete(id); }
  }
  async list() {
    await fs.mkdir(this.dir, { recursive: true });
    const items = [];
    for (const name of await fs.readdir(this.dir)) {
      if (!name.endsWith('.omc') || !validId(name.slice(0,-4))) continue;
      try {
        const f = await this.load(name.slice(0,-4));
        items.push({ id: f.id, title: f.title, updatedAt: f.updatedAt, createdAt: f.createdAt, thumbnail: f.thumbnail, recovered: !!f.recovered }); f.replica.destroy();
      } catch { items.push({ id: name.slice(0,-4), title: 'Damaged document', damaged: true }); }
    }
    return items.sort((a,b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  }
  async remove(id) { await this.pending.get(id); await fs.rm(this.file(id), {force:true}); await fs.rm(`${this.file(id)}.bak`, {force:true}); }
}
