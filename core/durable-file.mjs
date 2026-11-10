import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export async function syncDirectory(directory) {
  const handle = await fs.open(directory, 'r');
  try {
    await handle.sync();
  } catch (error) {
    // Windows and some filesystems do not support syncing directory handles.
    if (!['EINVAL', 'EPERM', 'EBADF'].includes(error.code)) throw error;
  } finally {
    await handle.close();
  }
}

export async function atomicWrite(file, data, { backup = true } = {}) {
  const directory = path.dirname(file), created = await fs.mkdir(directory, { recursive: true });
  if (created) {
    // Persist each newly created directory entry, not only the final file's
    // parent. This matters for the first save of a document/asset after a crash.
    let current = path.resolve(created);
    const target = path.resolve(directory);
    while (true) {
      await syncDirectory(path.dirname(current));
      if (current === target) break;
      current = path.join(current, path.relative(current, target).split(path.sep)[0]);
    }
  }
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await fs.open(temporary, 'wx', 0o600);
    try { await handle.writeFile(data); await handle.sync(); }
    finally { await handle.close(); }
    if (backup) {
      try {
        // A synced backup must precede publication of its replacement. Otherwise
        // the visible .bak can disappear after a power loss despite the save ACK.
        const previous = await fs.readFile(file);
        await atomicWrite(`${file}.bak`, previous, { backup: false });
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    await fs.rename(temporary, file);
    await syncDirectory(directory);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}
