import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';

const script = fileURLToPath(new URL('../resource_window.py', import.meta.url));

export async function openPhaseSampler(output, {python = 'python3', program = script} = {}) {
  const child = spawn(python, [program, output], {stdio: ['pipe', 'pipe', 2]});
  await once(child, 'spawn');
  const exited = once(child, 'exit');
  const lines = createInterface({input: child.stdout});
  const replies = lines[Symbol.asyncIterator]();
  child.stdin.on('error', () => {});

  return {
    async send(command) {
      assert.ok(child.exitCode === null && child.signalCode === null, 'Resource sampler is not running');
      child.stdin.write(JSON.stringify(command) + '\n');
      const {value, done} = await replies.next();
      assert.ok(!done, 'Phase sampler exited without responding');
      const reply = JSON.parse(value);
      assert.ok(reply.ok, reply.error ?? 'Phase sampler rejected the request');
      return reply;
    },
    async close() {
      child.stdin.end();
      const timeout = setTimeout(() => child.kill('SIGTERM'), 3000);
      try {
        await exited;
      } finally {
        clearTimeout(timeout);
        lines.close();
      }
    },
  };
}
