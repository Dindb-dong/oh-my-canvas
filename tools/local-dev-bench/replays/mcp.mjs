import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';

let require = createRequire(import.meta.url);
try {
  require.resolve('@modelcontextprotocol/sdk/client/index.js');
} catch (error) {
  if (error.code !== 'MODULE_NOT_FOUND') throw error;
  const firstWorktree = execFileSync('git', ['worktree', 'list', '--porcelain'], {
    cwd: new URL('.', import.meta.url),
    encoding: 'utf8',
  }).split('\n')[0];
  if (!firstWorktree.startsWith('worktree ')) throw error;
  require = createRequire(join(firstWorktree.slice('worktree '.length), 'package.json'));
}

const load = specifier => import(pathToFileURL(require.resolve(specifier)));
export const {Client} = await load('@modelcontextprotocol/sdk/client/index.js');
export const {StreamableHTTPClientTransport} = await load('@modelcontextprotocol/sdk/client/streamableHttp.js');

export {require as benchRequire};
