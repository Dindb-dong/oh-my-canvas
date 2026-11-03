/** Local, fail-closed source snapshot export. No source history or network is copied. */
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import { Replica } from '../core/replica.mjs';
import { decodeFile, encodeFile } from '../core/storage.mjs';
import { assertDocument, flatten } from '../core/document.mjs';
const ROOT = await fs.realpath(fileURLToPath(new URL('..', import.meta.url)));
const MANIFEST = 'PUBLICATION_MANIFEST.json';
const ROOT_FILES = new Set([
    '.gitignore', '.gitattributes', 'package.json', 'package-lock.json', 'index.html',
    'tsconfig.json', 'vite.config.mjs', 'vitest.config.mjs', 'LICENSE', 'THIRD_PARTY_NOTICES.md',
    'THIRD_PARTY_LICENSES.txt', 'README.md', 'README-ko.md', 'README-ja.md', 'README-zh-CN.md',
    'CONTRIBUTING.md', 'SECURITY.md', 'DESIGN.md', 'IMPLEMENTATION.md',
]);
const SOURCE_DIRS = new Set(['core', 'electron', 'cli', 'src', 'editor', 'tests', 'scripts', 'assets', 'licenses', 'fixtures', '.github']);
const PRIVATE_FILES = new Set([
    'docs/licensing/source-provenance.json', 'docs/independent/source-comparison.json',
    'docs/independent/PLAN.md', 'docs/independent/implementation-state.json',
    'scripts/audit-source-provenance.py',
]);
const SYNTHETIC_OMC = new Set(['docs/design/system/component-library.omc', 'docs/design/oh-my-canvas-ui-kit.omc']);
const HARD_DIRS = new Set(['.git', '.omx', '.worktrees', '.codex', '.agents', 'node_modules', 'vendor', 'apps', 'dist', 'release', 'work', 'profiles', 'profile', 'user-data', 'userdata', 'secrets', '.aws', '.ssh']);
const TEXT = /\.(?:[cm]?js|ts|tsx|jsx|json|md|txt|html?|css|ya?ml|svg|toml|ini|xml|py|sh)$/i;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const stable = value => JSON.stringify(value, null, 2) + '\n';
const git = (...args) => execFileSync('git', ['-C', ROOT, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
function relativeName(value) {
    if (typeof value !== 'string' || !value || value.includes('\0') || value.includes('\\') || path.posix.isAbsolute(value))
        throw Error('Expected a portable repository-relative path');
    const parts = value.split('/');
    if (parts.some(part => !part || part === '.' || part === '..'))
        throw Error(`Unsafe repository path: ${value}`);
    return parts.join('/');
}
function hardExcluded(file) {
    const parts = file.split('/');
    return parts.some(part => HARD_DIRS.has(part.toLowerCase())) || parts.some(part => /^\.env(?:\.|$)/i.test(part)) || /\.(?:key|pem|p12|pfx|mobileprovision|log|bak|tmp)$/i.test(file) || parts.includes('.DS_Store');
}
function allowed(file, evidence) {
    if (hardExcluded(file) || PRIVATE_FILES.has(file) || /(?:^|\/)source-(?:comparison|provenance)(?:[-.][^/]*)?\.json$/.test(file))
        return false;
    if (file.startsWith('docs/qa/'))
        return evidence.has(file);
    if (file.endsWith('.omc'))
        return SYNTHETIC_OMC.has(file);
    if (file.startsWith('docs/'))
        return /\.(?:md|json|html?)$/i.test(file);
    if (file === 'build/icon.png' || file === 'public/app-icon.png' || file === 'public/fonts/IBM-Plex-Sans-LICENSE.txt' || file === 'public/fonts/Noto-Sans-KR-LICENSE.txt')
        return true;
    return ROOT_FILES.has(file) || SOURCE_DIRS.has(file.split('/')[0]);
}
function inspectText(file, text) {
    const issues = [];
    if (/(?:\/Users\/[^/\s]+\/|\/home\/[^/\s]+\/|[A-Z]:\\Users\\[^\\\s]+\\)/.test(text))
        issues.push('machine-specific absolute home path');
    if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text))
        issues.push('private-key material');
    if (/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/.test(text))
        issues.push('AWS access-key identifier');
    if (/\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|xox[baprs]-[A-Za-z0-9-]{20,})\b/.test(text))
        issues.push('credential-shaped token');
    if (issues.length)
        throw Error(`Publication review required for ${file}: ${issues.join(', ')} (matched values are not printed)`);
}
function headings(text) {
    const ids = new Set([...text.matchAll(/\bid=["']([^"']+)["']/g)].map(match => match[1]));
    const seen = new Map();
    for (const match of text.matchAll(/^#{1,6} (.+)$/gm)) {
        const base = match[1].toLowerCase().replace(/<[^>]*>|[`*]/g, '').replace(/[^\p{L}\p{N}_ -]/gu, '').replace(/ /g, '-');
        const count = seen.get(base) ?? 0;
        seen.set(base, count + 1);
        ids.add(base + (count ? `-${count}` : ''));
    }
    return ids;
}
function verifiedUpstreamNotice(record,byName){
    if(!record.path.startsWith('licenses/native/texts/'))return false;
    const manifestRecord=byName.get('licenses/native/manifest.json');
    if(!manifestRecord)throw Error(`Native notice has no checksum manifest: ${record.path}`);
    const manifest=JSON.parse(manifestRecord.bytes.toString('utf8'));
    const relative=record.path.slice('licenses/native/'.length),entry=manifest.files?.find(item=>item.file===relative);
    if(!entry||entry.bytes!==record.bytes.length||entry.sha256!==sha(record.bytes))throw Error(`Native notice checksum mismatch: ${record.path}`);
    if(typeof entry.sourceUrl!=='string'||!entry.sourceUrl.startsWith('https://')||typeof entry.upstreamPath!=='string')throw Error(`Native notice lacks a canonical upstream route: ${record.path}`);
    return true;
}
function checkLinks(records) {
    const byName = new Map(records.map(record => [record.path, record])), problems = [];
    for (const record of records) {
        if (!record.path.endsWith('.md'))
            continue;
        // Verbatim third-party notices keep upstream-relative links, backed by pinned hashes and source URLs.
        if(verifiedUpstreamNotice(record,byName))continue;
        const text = record.bytes.toString('utf8').replace(/```[\s\S]*?```/g, '');
        const links = [...[...text.matchAll(/!?\[[^\]]*\]\((<[^>]+>|[^)\s]+)(?:\s+["'][^)]*)?\)/g)].map(match => match[1].replace(/^<|>$/g, '')), ...[...text.matchAll(/(?:href|src)=["']([^"']+)["']/g)].map(match => match[1]), ...[...text.matchAll(/^\s*\[[^\]]+\]:\s*(\S+)/gm)].map(match => match[1])];
        for (const link of links) {
            if (/^(?:https?:|mailto:|data:)/i.test(link))
                continue;
            if (/^[a-z][a-z0-9+.-]*:/i.test(link) || link.startsWith('/')) {
                problems.push(`${record.path}: nonportable local link`);
                continue;
            }
            let raw, fragment;
            try {
                const parts = link.split('#');
                raw = decodeURIComponent(parts[0].split('?')[0]);
                fragment = parts[1] ? decodeURIComponent(parts[1]) : '';
            }
            catch {
                problems.push(`${record.path}: malformed encoded link`);
                continue;
            }
            const target = raw ? path.posix.normalize(path.posix.join(path.posix.dirname(record.path), raw)) : record.path;
            if (target === '..' || target.startsWith('../')) {
                problems.push(`${record.path}: link escapes snapshot`);
                continue;
            }
            const found = byName.get(target), directory = target === '.' || records.some(item => item.path.startsWith(target.replace(/\/$/, '') + '/'));
            if (!found && !directory) {
                problems.push(`${record.path}: excluded or missing link target ${target}`);
                continue;
            }
            if (fragment && found && found.path.endsWith('.md') && !headings(found.bytes.toString('utf8')).has(fragment))
                problems.push(`${record.path}: missing anchor ${target}#${fragment}`);
        }
    }
    if (problems.length)
        throw Error(`Snapshot documentation has ${problems.length} unresolved local links; no files were exported:\n${[...new Set(problems)].slice(0, 100).join('\n')}`);
}
/** Seed one deterministic current document. No old Yjs update bytes enter the new replica. */
function newReplica(document, identity) {
    const replica = new Replica();
    replica.ydoc.clientID = createHash('sha256').update(identity).digest().readUInt32BE(0) || 1;
    replica.ydoc.transact(() => {
        for (const [key, value] of flatten(assertDocument(document)))
            replica.fields.set(key, value);
    }, 'publication-seed');
    replica.validateState(replica.ydoc);
    return replica;
}
function reseedOMC(file, source) {
    const old = decodeFile(source.toString('utf8'));
    let fresh, verified;
    try {
        const document = structuredClone(old.replica.document), documentHash = sha(stable(document));
        inspectText(file, JSON.stringify({ document, id: old.id, title: old.title, createdAt: old.createdAt, updatedAt: old.updatedAt }));
        fresh = newReplica(document, `${old.id}\n${documentHash}`);
        const envelope = JSON.parse(encodeFile({ id: old.id, title: old.title, replica: fresh, createdAt: old.createdAt }));
        envelope.updatedAt = old.updatedAt ?? old.createdAt ?? '1970-01-01T00:00:00.000Z';
        const output = Buffer.from(stable(envelope));
        verified = decodeFile(output.toString('utf8'));
        if (!isDeepStrictEqual(verified.replica.document, document) || verified.id !== old.id || verified.title !== old.title)
            throw Error(`Fresh-history semantic verification failed: ${file}`);
        if (fresh.undo.undoStack.length || fresh.undo.redoStack.length)
            throw Error(`Fresh replica unexpectedly contains undo history: ${file}`);
        return { bytes: output, transform: { kind: 'omc-current-document-fresh-history-v2', documentSha256: documentHash, previousStateBytes: old.replica.state.byteLength, newStateBytes: fresh.state.byteLength, thumbnailRemoved: old.thumbnail !== undefined } };
    }
    finally {
        old.replica.destroy();
        fresh?.destroy();
        verified?.replica.destroy();
    }
}
function parseArgs(args) {
    const result = { out: null, evidence: new Set(), check: false, initGit: false };
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === '--out') {
            if (!args[i + 1])
                throw Error('--out needs a new output directory');
            result.out = path.resolve(args[++i]);
        }
        else if (arg === '--allow-evidence') {
            if (!args[i + 1])
                throw Error('--allow-evidence needs one exact tracked path');
            result.evidence.add(relativeName(args[++i]));
        }
        else if (arg === '--check')
            result.check = true;
        else if (arg === '--init-git')
            result.initGit = true;
        else if (arg === '--help') {
            console.log('node scripts/prepare-publication.mjs --out /new/directory [--allow-evidence docs/qa/exact-file] [--init-git]\nUse --check instead of --out for read-only preflight. No network or commits are performed.');
            return null;
        }
        else
            throw Error(`Unknown option: ${arg}`);
    }
    if (!result.check && !result.out)
        throw Error('Specify --out with a new directory, or --check');
    if (result.check && result.initGit)
        throw Error('--check cannot initialize Git');
    return result;
}
async function prepare(options) {
    if ((await fs.realpath(git('rev-parse', '--show-toplevel').trim())) !== ROOT)
        throw Error('Exporter must live at its repository root');
    if (options.out) {
        const parent = await fs.realpath(path.dirname(options.out));
        options.out = path.join(parent, path.basename(options.out));
        const relative = path.relative(ROOT, options.out);
        if (!relative || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative)))
            throw Error('Snapshot output must be outside the source checkout');
        try {
            await fs.lstat(options.out);
            throw Error('Snapshot output already exists; choose a new directory');
        }
        catch (error) {
            if (error.code !== 'ENOENT')
                throw error;
        }
    }
    const objectFormat = git('rev-parse', '--show-object-format').trim();
    if (!['sha1', 'sha256'].includes(objectFormat))
        throw Error('Unsupported Git object format');
    const entries = git('ls-files', '--stage', '-z').split('\0').filter(Boolean).map(entry => {
        const tab = entry.indexOf('\t'), [mode, oid, stage] = entry.slice(0, tab).split(' ');
        if (tab < 0 || stage !== '0')
            throw Error('Resolve staged conflicts before preparing a snapshot');
        return { path: relativeName(entry.slice(tab + 1)), mode, oid };
    });
    const tracked = new Set(entries.map(entry => entry.path));
    for (const file of options.evidence) {
        if (!file.startsWith('docs/qa/') || !allowed(file,options.evidence) || !tracked.has(file))
            throw Error(`Explicit evidence must be a staged eligible docs/qa file: ${file}`);
    }
    const records = [];
    let total = 0;
    for (const entry of entries.filter(entry => allowed(entry.path, options.evidence)).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)) {
        if (!['100644', '100755'].includes(entry.mode))
            throw Error(`Only regular staged files may be exported: ${entry.path}`);
        const absolute = path.join(ROOT, entry.path), info = await fs.lstat(absolute);
        if (!info.isFile() || info.isSymbolicLink() || await fs.realpath(absolute) !== absolute)
            throw Error(`Symlink or nonregular source is forbidden: ${entry.path}`);
        if (info.size > 64 * 1024 * 1024)
            throw Error(`Review source files larger than 64 MiB separately: ${entry.path}`);
        const source = await fs.readFile(absolute), oid = createHash(objectFormat).update(`blob ${source.length}\0`).update(source).digest('hex');
        if (oid !== entry.oid)
            throw Error(`Stage the exact source bytes before export: ${entry.path}`);
        let bytes = source, transform;
        if (entry.path.endsWith('.omc'))
            ({ bytes, transform } = reseedOMC(entry.path, source));
        else {
            let text;
            if (TEXT.test(entry.path) || ROOT_FILES.has(entry.path))
                text = source.toString('utf8');
            else if (!source.includes(0)) {
                try {
                    text = new TextDecoder('utf8', { fatal: true }).decode(source);
                }
                catch {
                }
            }
            if (text !== undefined)
                inspectText(entry.path, text);
        }
        total += bytes.length;
        if (total > 512 * 1024 * 1024)
            throw Error('Snapshot exceeds the 512 MiB source budget; review the allowlist');
        records.push({ path: entry.path, mode: entry.mode === '100755' ? '0755' : '0644', sourceSha256: sha(source), sha256: sha(bytes), size: bytes.length, transform, bytes });
    }
    if (!records.some(record => record.path === 'package.json') || !records.some(record => record.path === 'editor/index.ts') || !records.some(record => record.path === 'LICENSE'))
        throw Error('Snapshot is missing required application files');
    checkLinks(records);
    const files = records.map(({ bytes, ...record }) => record);
    const manifest = { schemaVersion: 1, policy: 'docs/independent/publication-policy.md', source: 'staged regular files only; no repository history', sourceDigest: sha(stable(files.map(({ path, sourceSha256 }) => ({ path, sha256: sourceSha256 })))), snapshotDigest: sha(stable(files.map(({ path, sha256, size }) => ({ path, sha256, size })))), explicitEvidence: [...options.evidence].sort(), files };
    if (options.check) {
        console.log(stable({ mode: 'read-only-preflight', files: files.length, bytes: total, sourceDigest: manifest.sourceDigest, snapshotDigest: manifest.snapshotDigest }));
        return;
    }
    await fs.mkdir(options.out, { mode: 0o700 });
    try {
        for (const record of records) {
            const source = await fs.readFile(path.join(ROOT, record.path));
            if (sha(source) !== record.sourceSha256)
                throw Error(`Source changed after preflight: ${record.path}`);
            const destination = path.join(options.out, record.path);
            await fs.mkdir(path.dirname(destination), { recursive: true });
            await fs.writeFile(destination, record.bytes, { flag: 'wx', mode: parseInt(record.mode, 8) });
            await fs.chmod(destination,parseInt(record.mode,8));
            if(((await fs.stat(destination)).mode&0o777)!==parseInt(record.mode,8))throw Error(`Copied-file mode mismatch: ${record.path}`);
            if (sha(await fs.readFile(destination)) !== record.sha256)
                throw Error(`Copied-file hash mismatch: ${record.path}`);
        }
        const manifestBytes = stable(manifest);
        await fs.writeFile(path.join(options.out, MANIFEST), manifestBytes, { flag: 'wx', mode: 0o644 });
        if (sha(await fs.readFile(path.join(options.out, MANIFEST))) !== sha(manifestBytes))
            throw Error('Manifest readback mismatch');
        if (options.initGit)
            execFileSync('git', ['-c', 'init.templateDir=', 'init', '--initial-branch=main', options.out], { stdio: 'pipe' });
        console.log(stable({ output: options.out, files: files.length, bytes: total, manifestSha256: sha(manifestBytes), snapshotDigest: manifest.snapshotDigest, gitInitialized: options.initGit, committed: false, uploaded: false }));
    }
    catch (error) {
        await fs.writeFile(path.join(options.out, 'PUBLICATION_INCOMPLETE.txt'), 'Export did not complete. Do not publish this directory. Inspect the exporting command error.\n', { flag: 'wx' }).catch(() => {
        });
        throw error;
    }
}
export {relativeName,allowed,inspectText,checkLinks,reseedOMC,parseArgs};
const entryPoint=process.argv[1]?path.resolve(process.argv[1]):null;
if(entryPoint===fileURLToPath(import.meta.url)){
    try{const options=parseArgs(process.argv.slice(2));if(options)await prepare(options);}
    catch(error){console.error(`Publication export refused: ${error.message}`);process.exitCode=1;}
}
