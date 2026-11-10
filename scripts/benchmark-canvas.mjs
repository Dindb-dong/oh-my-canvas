import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';

// This measures JavaScript editing and SVG DOM work, not native browser layout,
// paint, frames per second, IPC or durable saving. Use the Electron acceptance
// suites for those paths. Run each revision in a separate process/cache scope.
const script = fileURLToPath(import.meta.url);
const checkout = path.resolve(path.dirname(script), '..');
const arg = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const positive = (name, fallback) => {
    const value = Number(arg(name) ?? fallback);
    if (!Number.isInteger(value) || value < 1) throw new Error(`--${name} must be a positive integer`);
    return value;
};
const samples = positive('samples', 12), nodes = positive('nodes', 1000);
const warmups = 3, burstSize = 8;
const statistics = values => {
    const sorted = [...values].sort((a, b) => a - b);
    return { median: sorted[Math.floor(sorted.length / 2)], p95: sorted[Math.ceil(sorted.length * .95) - 1] };
};

if (arg('worker')) {
    const source = path.resolve(arg('worker'));
    const temporary = await mkdtemp(path.join(os.tmpdir(), 'omc-canvas-benchmark-'));
    const dom = new JSDOM('<!doctype html><body></body>', { pretendToBeVisual: true });
    try {
        await readFile(path.join(source, 'package.json'));
        await symlink(path.join(checkout, 'node_modules'), path.join(temporary, 'node_modules'), 'dir');
        const exports = {
            'editor/document/index.ts': ['Editor', 'createDocument', 'createShape', 'insertShape'],
            'editor/render/index.ts': ['createRenderer'],
            'editor/assets/index.ts': ['reconcileLibraries'],
            'editor/components/index.ts': ['reconcileComponents'],
            'editor/styles/index.ts': ['reconcileStyles'],
            'editor/layout/index.ts': ['applyLayout'],
            'core/document.mjs': ['assertDocument'],
        };
        const bundle = path.join(temporary, 'editor.mjs');
        const compilation = await build({
            stdin: { contents: Object.entries(exports).map(([file, names]) => `export { ${names.join(', ')} } from ${JSON.stringify(path.join(source, file))};`).join('\n'), resolveDir: source, loader: 'js' },
            outfile: bundle, bundle: true, platform: 'node', format: 'esm', packages: 'external', logLevel: 'silent', metafile: true,
        });
        const digest = createHash('sha256');
        const inputs = Object.keys(compilation.metafile.inputs).filter(file => file !== '<stdin>').map(file => path.resolve(file)).sort((a, b) => path.relative(source, a).localeCompare(path.relative(source, b)));
        for (const file of inputs) digest.update(path.relative(source, file)).update('\0').update(await readFile(file)).update('\0');
        const sourceIdentity = { files: inputs.length, sha256: digest.digest('hex'), packageLockSha256: createHash('sha256').update(await readFile(path.join(checkout, 'package-lock.json'))).digest('hex') };
        const window = dom.window;
        for (const name of ['document', 'HTMLElement', 'HTMLCanvasElement', 'Element', 'Node', 'NodeFilter', 'SVGElement', 'MutationObserver', 'Image'])
            globalThis[name] = window[name];
        globalThis.window = window;
        globalThis.getComputedStyle = window.getComputedStyle.bind(window);
        globalThis.CSS = { escape: value => value }; // Fixture IDs are safe ASCII.
        globalThis.requestAnimationFrame = window.requestAnimationFrame.bind(window);
        globalThis.cancelAnimationFrame = window.cancelAnimationFrame.bind(window);
        window.HTMLCanvasElement.prototype.getContext = () => null; // No text or raster content in this fixture.
        Object.defineProperty(document, 'fonts', { value: Object.assign(new window.EventTarget(), { ready: Promise.resolve() }) });
        const { Editor, createDocument, createShape, insertShape, createRenderer, reconcileLibraries, reconcileComponents, reconcileStyles, applyLayout, assertDocument } = await import(pathToFileURL(bundle));
        const cases = {};
        for (const workload of ['committed-move', 'eight-preview-burst']) {
            const doc = createDocument({ pageId: 'benchmark-page' }), page = doc.pagesById[doc.pages[0]];
            for (let i = 0; i < nodes; i++) insertShape(page, createShape('rect', {
                id: `rect-${i}`, x: (i % 40) * 30, y: Math.floor(i / 40) * 30, width: 20, height: 20,
                fills: [{ color: i % 2 ? '#e2e8f0' : '#6366f1', opacity: 1 }],
            }));
            const editor = new Editor(doc, {
                reconcile(before, draft) {
                    reconcileLibraries(before, draft);
                    reconcileComponents(before, draft);
                    reconcileStyles(before, draft);
                    applyLayout(draft, before);
                },
                validate: assertDocument,
            });
            const stage = document.createElement('div');
            document.body.append(stage);
            let phases = [];
            const view = createRenderer(editor, stage, { onTiming: timing => phases.push(timing) });
            const scene = stage.querySelector('.canvas-scene');
            const observer = new window.MutationObserver(() => {});
            const records = [];
            try {
                await view.settled();
                for (let sample = -warmups; sample < samples; sample++) {
                    globalThis.gc?.();
                    phases = [];
                    const changed = view.element('rect-0');
                    const unchanged = nodes > 1 ? view.element(`rect-${nodes - 1}`) : null;
                    observer.observe(scene, { childList: true, attributes: true, subtree: true });
                    const start = performance.now();
                    const move = draft => { draft.pagesById[editor.pageId].objects['rect-0'].x += 1; };
                    if (workload === 'committed-move') editor.transact('Benchmark move', move);
                    else {
                        assert.equal(editor.begin('Benchmark drag'), true);
                        for (let step = 0; step < burstSize; step++) editor.preview(move);
                        editor.commitSession();
                    }
                    // Reading the final scene must flush queued work even if RAF has
                    // not run. This includes all rendering needed for the final state.
                    const measured = view.measure(['rect-0']).get('rect-0');
                    const elapsedMs = performance.now() - start;
                    const mutations = observer.takeRecords();
                    observer.disconnect();
                    assert.equal(measured.x, editor.page.objects['rect-0'].x);
                    assert.equal(Number(view.element('rect-0').querySelector('[data-geometry]').getAttribute('x')), editor.page.objects['rect-0'].x);
                    assert.equal(scene.querySelectorAll('[data-shape-id]').length, nodes);
                    const countTree = node => 1 + Array.from(node.childNodes).reduce((sum, child) => sum + countTree(child), 0);
                    const record = {
                        elapsedMs,
                        svgUpdates: phases.filter(phase => phase.phase === 'render.attachSvg').length,
                        addedDomNodes: mutations.reduce((sum, mutation) => sum + Array.from(mutation.addedNodes).reduce((count, node) => count + countTree(node), 0), 0),
                        removedDomNodes: mutations.reduce((sum, mutation) => sum + Array.from(mutation.removedNodes).reduce((count, node) => count + countTree(node), 0), 0),
                        attributeWrites: mutations.filter(mutation => mutation.type === 'attributes').length,
                        editedElementRetained: view.element('rect-0') === changed,
                        untouchedElementRetained: unchanged ? view.element(`rect-${nodes - 1}`) === unchanged : null,
                    };
                    if (sample >= 0) records.push(record);
                }
                const end = editor.page.objects['rect-0'].x;
                assert.equal(editor.undoStep(), true);
                assert.equal(editor.page.objects['rect-0'].x, end - (workload === 'committed-move' ? 1 : burstSize));
                assert.equal(editor.redoStep(), true);
                assert.equal(view.measure(['rect-0']).get('rect-0').x, end);
                assert.equal(Number(view.element('rect-0').querySelector('[data-geometry]').getAttribute('x')), end);
                cases[workload] = {
                    timeMs: statistics(records.map(record => record.elapsedMs)),
                    svgUpdatesPerSample: statistics(records.map(record => record.svgUpdates)),
                    addedDomNodesPerSample: statistics(records.map(record => record.addedDomNodes)),
                    removedDomNodesPerSample: statistics(records.map(record => record.removedDomNodes)),
                    editedElementAlwaysRetained: records.every(record => record.editedElementRetained),
                    untouchedElementAlwaysRetained: nodes > 1 ? records.every(record => record.untouchedElementRetained) : null,
                    samples: records,
                };
            } finally {
                observer.disconnect(); view.destroy(); editor.destroy(); stage.remove();
            }
        }
        console.log(JSON.stringify({ source: sourceIdentity, cases }));
    } finally {
        dom.window.close();
        await rm(temporary, { recursive: true, force: true });
    }
} else {
    const revisions = [...(arg('baseline') ? [['baseline', path.resolve(arg('baseline'))]] : []), ['current', checkout]];
    const report = {
        description: 'Editor transactions, production reconciliation/validation and SVG DOM updates in Node/jsdom',
        environment: { node: process.version, platform: process.platform, arch: process.arch },
        fixture: { rectangles: nodes, warmups, samples, previewEventsPerBurst: burstSize },
        excludes: ['native browser layout and paint', 'FPS', 'real input event timing', 'text shaping', 'raster decoding', 'Electron IPC', 'durable saves'],
        sources: {},
        runs: {},
    };
    for (const [name, source] of revisions) {
        const output = execFileSync(process.execPath, ['--expose-gc', script, `--worker=${source}`, `--samples=${samples}`, `--nodes=${nodes}`], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
        const result = JSON.parse(output);
        report.sources[name] = result.source;
        report.runs[name] = result.cases;
    }
    if (report.runs.baseline) {
        report.medianSpeedup = Object.fromEntries(Object.keys(report.runs.current).map(workload => [workload, report.runs.baseline[workload].timeMs.median / report.runs.current[workload].timeMs.median]));
    }
    if (arg('output')) {
        const output = path.resolve(arg('output'));
        await mkdir(path.dirname(output), { recursive: true });
        await writeFile(output, JSON.stringify(report, null, 2) + '\n');
    }
    console.log(JSON.stringify(report, null, 2));
}
