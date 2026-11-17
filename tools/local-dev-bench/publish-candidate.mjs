import {link, unlink, writeFile} from 'node:fs/promises';

export async function publishCandidate(path, evidence) {
  const pending = `${path}.pending`;
  await writeFile(pending, JSON.stringify(evidence) + '\n', {flag: 'wx', mode: 0o600});
  try {
    // Make the complete artifact visible atomically without replacing earlier evidence.
    await link(pending, path);
  } finally {
    await unlink(pending);
  }
}
