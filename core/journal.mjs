import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';

const HEADER_BYTES = 36; // uint32 payload length followed by SHA-256(payload).
export const MAX_JOURNAL_RECORD_BYTES = 384 * 1024 * 1024;
const corrupt = message => Object.assign(Error(`Invalid save journal: ${message}`), { code: 'JOURNAL_CORRUPT' });

export function encodeJournalRecord(record) {
  const payload = Buffer.from(JSON.stringify(record));
  if (!payload.length || payload.length > MAX_JOURNAL_RECORD_BYTES) throw Error('Save journal record exceeds storage limit');
  const header = Buffer.allocUnsafe(HEADER_BYTES);
  header.writeUInt32BE(payload.length);
  createHash('sha256').update(payload).digest().copy(header, 4);
  return Buffer.concat([header, payload]);
}

export function decodeJournal(bytes, { afterSequence = 0 } = {}) {
  const records = []; let offset = 0, sequence = afterSequence;
  while (offset < bytes.length) {
    if (bytes.length - offset < HEADER_BYTES) break;
    const length = bytes.readUInt32BE(offset);
    if (!length || length > MAX_JOURNAL_RECORD_BYTES) throw corrupt('record length');
    const end = offset + HEADER_BYTES + length;
    if (end > bytes.length) break; // Only an incomplete final append is recoverable.
    const payload = bytes.subarray(offset + HEADER_BYTES, end);
    if (!createHash('sha256').update(payload).digest().equals(bytes.subarray(offset + 4, offset + HEADER_BYTES))) throw corrupt('checksum mismatch');
    let record;
    try { record = JSON.parse(payload); } catch { throw corrupt('record JSON'); }
    if (record?.version !== 1 || !Number.isSafeInteger(record.sequence) || record.sequence !== sequence + 1) throw corrupt('record sequence');
    records.push(record); sequence = record.sequence; offset = end;
  }
  return { records, sequence, validBytes: offset, truncatedBytes: bytes.length - offset };
}

export async function appendJournal(file, bytes, validBytes, { repairTail = false } = {}) {
  const handle = await fs.open(file, 'r+');
  let changed = false;
  try {
    const stat = await handle.stat();
    if (stat.size < validBytes || stat.size > validBytes && !repairTail) throw Object.assign(Error('Canvas journal changed in another writer; reload before saving'), { code: 'STORE_CONFLICT' });
    // A previous interrupted write is discarded only up to the last verified
    // record boundary. Never continue appending after unverified bytes.
    if (stat.size !== validBytes) { changed = true; await handle.truncate(validBytes); }
    let written = 0;
    while (written < bytes.length) {
      changed = true;
      const result = await handle.write(bytes, written, bytes.length - written, validBytes + written);
      if (!result.bytesWritten) throw Error('Save journal write made no progress');
      written += result.bytesWritten;
    }
    await handle.sync();
  } catch (error) {
    if (changed) try { await handle.truncate(validBytes); await handle.sync(); } catch {}
    throw error;
  } finally { await handle.close(); }
}
