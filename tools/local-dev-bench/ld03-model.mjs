import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {chmod} from 'node:fs/promises';
import {createServer} from 'node:net';

const maxRequest = 1024;
const writeLimit = 4;
const inspectTool = 'inspect_shared_values';
const applyTool = 'set_shared_values';

function values(args) {
  if (!args || Object.keys(args).sort().join() !== 'accent,spacing_px' ||
      typeof args.accent !== 'string' || !/^#[0-9a-f]{6}$/i.test(args.accent) ||
      !Number.isInteger(args.spacing_px) || args.spacing_px < 0 || args.spacing_px > 128) {
    throw new Error('Expected a six-digit accent and integer spacing_px between 0 and 128');
  }
  return {accent: args.accent.toLowerCase(), spacing_px: args.spacing_px};
}

// Callers put the socket in their private temporary profile or run directory.
export async function withLD03Broker(path, {inspect, apply}, events, run) {
  let writes = 0;
  let active;
  const sockets = new Set();
  const server = createServer(socket => {
    sockets.add(socket);
    socket.setTimeout(45_000, () => socket.destroy());
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => socket.destroy());
    let input = '';
    const reply = body => socket.end(JSON.stringify(body) + '\n');
    const read = chunk => {
      input += chunk;
      if (Buffer.byteLength(input) > maxRequest) {
        socket.off('data', read);
        reply({error: 'Request too large'});
        return;
      }
      if (!input.includes('\n')) return;
      socket.off('data', read);
      if (active) {
        reply({error: 'Another operation is in progress'});
        return;
      }
      active = (async () => {
        const event = {status: 'rejected'};
        const start = performance.now();
        try {
          const {name, arguments: args} = JSON.parse(input);
          let invoke;
          if (name === inspectTool && args && !Array.isArray(args) && typeof args === 'object' && !Object.keys(args).length) {
            invoke = inspect;
          } else if (name === applyTool) {
            const request = values(args);
            if (writes >= writeLimit) throw new Error('Write limit reached');
            writes += 1;
            event.arguments = request;
            invoke = () => apply(request);
          } else {
            throw new Error('Unsupported tool or arguments');
          }
          event.name = name;
          event.status = 'running';
          const state = await invoke();
          const result = {target: values(state.target), archive: values(state.archive)};
          event.status = 'ok';
          reply({result});
        } catch (error) {
          const ran = event.status === 'running';
          event.status = ran ? 'failed' : 'rejected';
          event.error = error.message;
          reply({error: ran ? 'Product operation failed. Inspect before trying another write.' : error.message});
        } finally {
          event.ms = performance.now() - start;
          events.push(event);
        }
      })().finally(() => { active = undefined; });
    };
    socket.setEncoding('utf8');
    socket.on('data', read);
  });
  server.listen(path);
  await once(server, 'listening');
  try {
    await chmod(path, 0o600);
    return await run();
  } finally {
    for (const socket of sockets) socket.destroy();
    await Promise.all([active, new Promise(resolve => server.close(resolve))]);
  }
}

export async function runLD03Agent(command, socketPath, signal) {
  const child = spawn(command, [socketPath], {stdio: ['ignore', 2, 2], signal});
  const [code, killedBy] = await once(child, 'exit');
  if (code !== 0) throw new Error(`LD03 agent exited with ${code ?? killedBy}`);
}
