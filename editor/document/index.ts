/** Original isolated transaction and gesture-session editor. */
import type { CanvasDocument, Page, Shape, EditorStore, EditorOptions, EditorEvent, EditorChangeScope, Operation, Mutator, Viewport, Tool } from '../contracts';
import { reconcileShapeGeometry } from '../geometry';
import { clone, newId, ROOT_ID } from './factory';
import { refreshFrames } from './tree';
import { validateDocument, validateDocumentChanges, validateDocumentSize } from './validation';
import { share, patches, patchesAtPaths, applyPatches, inversePatches, type Patch } from './journal';
import { normalizePathContent } from '../geometry/svg-path';
import { geometryUnchanged } from './geometry-state';
import { documentDraft } from './draft';
import { changeScope, changedPaths } from './changes';
export * from './factory';
export * from './tree';
export * from './validation';
interface Session {
    base: CanvasDocument;
    operation: Operation;
    history: CanvasDocument[];
    future: CanvasDocument[];
    paths: Map<string, string[]>;
}
export class Editor implements EditorStore {
    [key: string]: any;
    private committed!: CanvasDocument;
    pageId: string;
    selection: string[] = [];
    hover: string | null = null;
    tool: Tool = 'move';
    viewport: Viewport = { vport: { width: 1000, height: 800 }, vbox: { x: 0, y: 0, width: 1000, height: 800 }, zoom: 1 };
    undo: {
        blocked: boolean;
        [key: string]: any;
    } = { blocked: false };
    private listeners = new Set<(event: EditorEvent) => void>();
    private candidate: CanvasDocument | null = null;
    private session: Session | null = null;
    private past: {
        bytes: number;
        forward: Patch[];
        reverse: Patch[];
        operation: Operation;
    }[] = [];
    private future: typeof this.past = [];
    private options: EditorOptions;
    private dead = false;
    private pending: EditorEvent[] = [];
    private nestedFailure: unknown = null;
    lastOperation: Operation | undefined;
    private pageViews = new Map<string, Viewport>();
    private preparedPaths: string[][] = [];
    constructor(input: CanvasDocument | {
        doc: CanvasDocument;
        [key: string]: any;
    }, options: EditorOptions = {}) {
        this.options = options;
        this.doc = clone('doc' in input ? input.doc : input as CanvasDocument);
        validateDocument(this.doc);
        this.pageId = this.doc.pages[0];
        if ('doc' in input) {
            if (input.pageId && this.doc.pagesById[input.pageId])
                this.pageId = input.pageId;
            if (input.viewport)
                this.viewport = clone(input.viewport);
        }
        this.normalize(this.doc);
        validateDocumentSize(this.doc);
    }
    get doc(): CanvasDocument {
        return this.candidate ?? this.committed;
    }
    set doc(value: CanvasDocument) {
        this.committed = value;
    }
    get page(): Page {
        return (this.candidate ?? this.doc).pagesById[this.pageId];
    }
    get activeSession(): boolean {
        return !!this.session;
    }
    undoSession(): boolean {
        return this.session ? Editor.prototype.undoStep.call(this) : false;
    }
    redoSession(): boolean {
        return this.session ? Editor.prototype.redoStep.call(this) : false;
    }
    get inTransaction(): boolean {
        return !!this.candidate;
    }
    on(listener: (event: EditorEvent) => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }
    private emit(event: EditorEvent): void {
        if (this.candidate) {
            this.pending.push(event);
            return;
        }
        for (const listener of [...this.listeners])
            listener(event);
    }
    private normalize(doc: CanvasDocument, before?: CanvasDocument): void {
        for (const pageId of doc.pages) {
            const page = doc.pagesById[pageId];
            for (const s of Object.values(page.objects)) {
                normalizePathContent(s, true);
                const previous = before?.pagesById[pageId]?.objects[s.id];
                if (!geometryUnchanged(previous, s))
                    reconcileShapeGeometry(previous, s);
            }
            refreshFrames(page);
        }
    }
    private timed<T>(phase: string, run: () => T): T {
        const start = performance.now();
        try { return run(); }
        finally { try { this.options.onTiming?.(phase, performance.now() - start); } catch { /* Metrics must not change commit semantics. */ } }
    }
    private changedShapeIds(before: CanvasDocument, after: CanvasDocument, paths?: string[][]): Record<string, string[]> {
        return Object.fromEntries([...changeScope(before, after, paths).shapes].map(([id, shapes]) => [id, [...shapes]]));
    }
    private normalizeChanges(doc: CanvasDocument, before: CanvasDocument, scope: EditorChangeScope, geometryBaseline?: (pageId: string, shapeId: string) => Shape | undefined): void {
        for (const [pageId, ids] of scope.shapes) {
            const page = doc.pagesById[pageId];
            if (!page) continue;
            for (const id of ids) {
                const shape = page.objects[id];
                if (!shape) continue;
                normalizePathContent(shape, true);
                const previous = geometryBaseline ? geometryBaseline(pageId, id) : before.pages.includes(pageId) ? before.pagesById[pageId]?.objects[id] : undefined;
                if (!geometryUnchanged(previous, shape)) reconcileShapeGeometry(previous, shape);
            }
        }
        for (const id of scope.topologyPages) if (doc.pagesById[id]) refreshFrames(doc.pagesById[id]);
    }
    private prepare(before: CanvasDocument, draft: CanvasDocument, paths = changedPaths(before, draft), isolation = documentDraft(draft)): CanvasDocument {
        const prior = this.candidate;
        try {
            // Keep one mutable entity draft through all phases. The checkpoint
            // detaches touched entities for pre-hook geometry without allocating
            // an intermediate immutable copy of a large page object index.
            this.candidate = isolation.draft;
            this.timed('normalize', () => this.normalizeChanges(isolation.draft, before, changeScope(before, draft, paths)));
            const normalized = this.timed('snapshot', () => isolation.checkpoint());
            const normalizedPages: string[] = normalized.get(['pages']);
            const directPaths = isolation.base === before ? normalized.paths : [...paths, ...normalized.paths];
            const directScope = changeScope(before, isolation.draft, directPaths);
            this.timed('reconcile', () => {
                if (this.options.reconcileChanges) this.options.reconcileChanges(before, isolation.draft, directScope);
                else this.options.reconcile?.(before, isolation.draft);
            });
            // The isolated pre-hook snapshot supplies geometry inputs. Only
            // entities opened by the hook can have changed, so a second full
            // object-index snapshot is unnecessary before reconciliation.
            const derivedPaths = isolation.possiblePaths();
            const derivedScope = changeScope(isolation.base, isolation.draft, derivedPaths);
            // A hook can restore the original topology after the first pass
            // updated derived frame IDs. Such pages still need the second pass.
            const finalScope = { ...derivedScope, topologyPages: new Set([...directScope.topologyPages, ...derivedScope.topologyPages]) };
            this.timed('normalize-derived', () => this.normalizeChanges(isolation.draft, isolation.base, finalScope, (pageId, id) => normalizedPages?.includes(pageId) ? normalized.get(['pagesById', pageId, 'objects', id]) : undefined));
            const prepared = this.timed('snapshot', () => isolation.finish());
            const touched = isolation.base === before ? prepared.paths : [...paths, ...prepared.paths];
            const scope = changeScope(before, prepared.document, touched);
            this.timed('validate', () => {
                validateDocumentChanges(before, prepared.document, scope);
                if (this.options.validateChanges) this.options.validateChanges(before, prepared.document, scope);
                else this.options.validate?.(prepared.document);
            });
            this.preparedPaths = touched;
            return isolation.base === before ? prepared.document : share(before, prepared.document);
        }
        finally { this.candidate = prior; }
    }
    private prune(): void {
        if (!this.doc.pagesById[this.pageId])
            this.pageId = this.doc.pages[0];
        this.selection = this.selection.filter(id => !!this.page.objects[id] && id !== ROOT_ID);
        if (this.hover && !this.page.objects[this.hover])
            this.hover = null;
    }
    transact<T>(operation: Operation | string, mutate: Mutator<T>): T {
        if (this.dead)
            throw new Error('Editor destroyed');
        if (this.candidate) {
            try {
                const result = mutate(this.candidate);
                if (result && typeof (result as any).then === 'function')
                    throw new Error('Nested transactions must be synchronous');
                return result;
            }
            catch (error) {
                this.nestedFailure = error;
                throw error;
            }
        }
        if (this.session)
            throw new Error('Editor busy with an active user session');
        const before = this.doc, isolation = documentDraft(before), draft = isolation.draft, op = typeof operation === 'string' ? { id: newId('op'), label: operation } : { ...operation, id: operation.id || newId('op') }, ui = { selection: [...this.selection], pageId: this.pageId, hover: this.hover, tool: this.tool, viewport: this.viewport };
        this.candidate = draft;
        this.pending = [];
        this.nestedFailure = null;
        let result: T;
        try {
            result = mutate(draft);
            if (this.nestedFailure)
                throw this.nestedFailure;
            if (result && typeof (result as any).then === 'function')
                throw new Error('Transactions must be synchronous');
            const paths = this.timed('draft', () => isolation.possiblePaths());
            this.committed = this.prepare(before, draft, paths, isolation);
        }
        catch (error) {
            Object.assign(this, ui);
            this.pending = [];
            throw error;
        }
        finally {
            this.candidate = null;
            this.nestedFailure = null;
        }
        if (this.doc !== before) {
            const changes = this.timed('patches', () => patchesAtPaths(before, this.doc, this.preparedPaths));
            this.recordHistory(before, changes, op);
            this.future = [];
            this.prune();
            this.lastOperation = op;
            const event: EditorEvent = { changes, changedShapeIds: this.changedShapeIds(before, this.doc, this.preparedPaths), operation: op };
            for (const queued of this.pending)
                Object.assign(event, queued);
            this.pending = [];
            this.emit(event);
        }
        else {
            const events = this.pending;
            this.pending = [];
            for (const event of events)
                this.emit(event);
        }
        return result!;
    }
    private recordHistory(before: CanvasDocument, changes: Patch[], operation: Operation): void {
        // Event listeners receive their own patch objects. History must remain
        // immutable even if a listener annotates or otherwise changes an event.
        const forward = clone(changes), reverse = inversePatches(before, forward);
        this.past.push({ forward, reverse, operation, bytes: new TextEncoder().encode(JSON.stringify(forward)).byteLength });
        let bytes = 0;
        for (let i = this.past.length - 1; i >= 0; i--) {
            bytes += this.past[i].bytes;
            if (i < this.past.length - 100 || bytes > 16 * 1024 * 1024) {
                this.past.splice(0, i + 1);
                break;
            }
        }
    }
    begin(label: string): boolean {
        if (this.session || this.candidate || this.dead)
            return false;
        this.session = { base: this.doc, operation: { id: newId('op'), label }, history: [this.doc], future: [], paths: new Map() };
        this.undo.blocked = true;
        return true;
    }
    preview(mutate: Mutator): void {
        if (!this.session)
            throw new Error('No active session');
        const before = this.doc, isolation = documentDraft(before), draft = isolation.draft, ui = { selection: [...this.selection], pageId: this.pageId, hover: this.hover, tool: this.tool, viewport: this.viewport };
        this.candidate = draft;
        this.pending = [];
        this.nestedFailure = null;
        try {
            const result = mutate(draft);
            if (result && typeof (result as any).then === 'function')
                throw new Error('Previews must be synchronous');
            if (this.nestedFailure)
                throw this.nestedFailure;
            const paths = this.timed('draft', () => isolation.possiblePaths());
            this.committed = this.prepare(before, draft, paths, isolation);
        }
        catch (error) {
            Object.assign(this, ui);
            this.pending = [];
            throw error;
        }
        finally {
            this.candidate = null;
            this.nestedFailure = null;
        }
        if (this.doc !== before) {
            for (const path of this.preparedPaths) this.session.paths.set(JSON.stringify(path), path);
            this.session.history.push(this.doc);
            if (this.session.history.length > 100)
                this.session.history.shift();
            this.session.future = [];
            this.prune();
            const event: EditorEvent = { deltas: true, changedShapeIds: this.changedShapeIds(before, this.doc, this.preparedPaths) };
            for (const queued of this.pending)
                Object.assign(event, queued);
            this.pending = [];
            this.emit(event);
        }
    }
    commitSession(): boolean {
        if (!this.session)
            return false;
        const session = this.session;
        this.session = null;
        this.undo.blocked = false;
        const changes = patchesAtPaths(session.base, this.doc, [...session.paths.values()]);
        if (!changes.length)
            return false;
        this.recordHistory(session.base, changes, session.operation);
        this.future = [];
        this.lastOperation = session.operation;
        this.emit({ changes, changedShapeIds: this.changedShapeIds(session.base, this.doc, [...session.paths.values()]), operation: session.operation });
        return true;
    }
    cancelSession(): void {
        if (!this.session)
            return;
        const before = this.doc;
        this.doc = this.session.base;
        this.session = null;
        this.undo.blocked = false;
        this.prune();
        this.emit({ deltas: true, changedShapeIds: this.changedShapeIds(before, this.doc) });
    }
    setSelection(ids: string[]): void {
        const next = [...new Set(ids)].filter(id => id !== ROOT_ID && this.page.objects[id]);
        if (JSON.stringify(next) === JSON.stringify(this.selection))
            return;
        this.selection = next;
        this.emit({ selection: true });
    }
    setHover(id: string | null): void {
        if (id !== this.hover) {
            this.hover = id && this.page.objects[id] ? id : null;
            this.emit({ hover: true });
        }
    }
    setPage(id: string): void {
        if (!this.doc.pagesById[id])
            throw new Error('Unknown page');
        if (id === this.pageId)
            return;
        if (this.session)
            this.commitSession();
        this.pageViews.set(this.pageId, clone(this.viewport));
        this.pageId = id;
        this.viewport = clone(this.pageViews.get(id) ?? this.viewport);
        this.selection = [];
        this.hover = null;
        this.emit({ page: true, selection: true, viewport: true });
    }
    setTool(tool: Tool): void {
        if (!['move', 'frame', 'rect', 'ellipse', 'polygon', 'star', 'line', 'arrow', 'pencil', 'pen', 'text'].includes(tool))
            throw new Error('Unknown tool');
        if (tool !== this.tool) {
            this.tool = tool;
            this.emit({ tool: true });
        }
    }
    setViewport(viewport: Viewport): void {
        if (!Number.isFinite(viewport.zoom) || viewport.zoom <= 0 || !Object.values(viewport.vbox).every(Number.isFinite) || !Object.values(viewport.vport).every(Number.isFinite))
            throw new Error('Invalid viewport');
        this.viewport = clone(viewport);
        this.emit({ viewport: true });
    }
    replaceDocument(doc: CanvasDocument): void {
        const next = clone(doc);
        validateDocument(next);
        this.normalize(next);
        validateDocumentSize(next);
        this.session = null;
        this.undo.blocked = false;
        this.doc = share(this.doc, next);
        this.past = [];
        this.future = [];
        this.lastOperation = undefined;
        this.prune();
        this.emit({ projection: true, page: true, selection: true });
    }
    receiveDocument(doc: CanvasDocument, options: { incremental?: boolean } = {}): void {
        const previous = this.doc, baseline = this.session?.base ?? previous;
        let remote: CanvasDocument;
        if (options.incremental) {
            // Internal host projections preserve immutable branches. This is still
            // validated; arbitrary snapshots must use the default full path.
            const scope = changeScope(baseline, doc);
            validateDocumentChanges(baseline, doc, scope);
            const projection = documentDraft(doc);
            this.normalizeChanges(projection.draft, baseline, scope);
            remote = projection.finish().document;
            validateDocumentChanges(baseline, remote, changeScope(baseline, remote));
        }
        else {
            remote = clone(doc);
            validateDocument(remote);
            this.normalize(remote);
            validateDocumentSize(remote);
        }
        // Validate the normalized identity that will become the next baseline.
        // Host validators keep immutable-branch proofs; losing that proof on a
        // remote metadata/page update makes the next small local edit validate
        // the entire document. Rejections must precede every session/publication
        // change, and an external snapshot still uses the full host boundary.
        remote = share(baseline, remote);
        if (options.incremental && this.options.validateChanges)
            this.options.validateChanges(baseline, remote, changeScope(baseline, remote));
        else
            this.options.validate?.(remote);
        if (this.session) {
            const previousBase = this.session.base;
            const rebased = new Map<CanvasDocument, CanvasDocument>();
            const rebase = (snapshot: CanvasDocument): CanvasDocument => {
                const existing = rebased.get(snapshot);
                if (existing)
                    return existing;
                const changes = patches(previousBase, snapshot).filter(change => {
                    const path = change.path;
                    if (path[0] !== 'pagesById')
                        return true;
                    const pageId = path[1];
                    if (!remote.pagesById[pageId] && previousBase.pagesById[pageId])
                        return false;
                    if (path[2] !== 'objects' || !path[3])
                        return true;
                    const id = path[3], old = previousBase.pagesById[pageId]?.objects[id], next = remote.pagesById[pageId]?.objects[id];
                    if (old && !next)
                        return false;
                    if (!old && change.value?.parentId) {
                        const parent = change.value.parentId;
                        if (previousBase.pagesById[pageId]?.objects[parent] && !remote.pagesById[pageId]?.objects[parent])
                            return false;
                    }
                    return true;
                });
                const candidate = applyPatches(remote, changes);
                const prepared = this.prepare(remote, candidate);
                rebased.set(snapshot, prepared);
                return prepared;
            };
            const history = this.session.history.map(rebase), future = this.session.future.map(rebase), current = rebase(this.doc);
            this.session.base = remote;
            this.session.history = history;
            this.session.future = future;
            this.doc = current;
            this.session.paths = new Map([...history, ...future, current].flatMap(snapshot => changedPaths(remote, snapshot)).map(path => [JSON.stringify(path), path]));
        }
        else
            this.doc = remote;
        this.prune();
        this.emit({ projection: true, deltas: true, changedShapeIds: this.changedShapeIds(previous, this.doc) });
    }
    undoStep(): boolean {
        if (this.session) {
            const { history, future } = this.session;
            if (history.length < 2)
                return false;
            const before = this.doc;
            future.push(history.pop()!);
            this.doc = history.at(-1)!;
            this.prune();
            this.emit({ deltas: true, changedShapeIds: this.changedShapeIds(before, this.doc) });
            return true;
        }
        if (this.undo.blocked)
            return false;
        const entry = this.past.at(-1);
        if (!entry)
            return false;
        const before = this.doc, next = this.prepare(before, applyPatches(before, entry.reverse));
        this.doc = next;
        this.past.pop();
        this.future.push(entry);
        this.prune();
        this.lastOperation = { id: newId('op'), label: 'Undo', author: entry.operation.author };
        this.emit({ changes: patchesAtPaths(before, next, this.preparedPaths), changedShapeIds: this.changedShapeIds(before, next, this.preparedPaths), operation: this.lastOperation });
        return true;
    }
    redoStep(): boolean {
        if (this.session) {
            const next = this.session.future.pop();
            if (!next)
                return false;
            const before = this.doc;
            this.doc = next;
            this.session.history.push(next);
            this.prune();
            this.emit({ deltas: true, changedShapeIds: this.changedShapeIds(before, this.doc) });
            return true;
        }
        if (this.undo.blocked)
            return false;
        const entry = this.future.at(-1);
        if (!entry)
            return false;
        const before = this.doc, next = this.prepare(before, applyPatches(before, entry.forward));
        this.doc = next;
        this.future.pop();
        this.past.push(entry);
        this.prune();
        this.lastOperation = { id: newId('op'), label: 'Redo', author: entry.operation.author };
        this.emit({ changes: patchesAtPaths(before, next, this.preparedPaths), changedShapeIds: this.changedShapeIds(before, next, this.preparedPaths), operation: this.lastOperation });
        return true;
    }
    destroy(): void {
        this.listeners.clear();
        this.session = null;
        this.candidate = null;
        this.past = [];
        this.future = [];
        this.undo.blocked = false;
        this.dead = true;
    }
}
export { descendants as getDescendants, ancestors as getAncestors } from './tree';
