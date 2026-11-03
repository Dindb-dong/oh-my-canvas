/** Original isolated transaction and gesture-session editor. */
import type { CanvasDocument, Page, EditorStore, EditorOptions, EditorEvent, Operation, Mutator, Viewport, Tool } from '../contracts';
import { updateGeometry, reconcileShapeGeometry } from '../geometry';
import { clone, newId, ROOT_ID } from './factory';
import { refreshFrames } from './tree';
import { validateDocument } from './validation';
import { share, patches, applyPatches } from './journal';
export * from './factory';
export * from './tree';
export * from './validation';
interface Session {
    base: CanvasDocument;
    operation: Operation;
    history: CanvasDocument[];
    future: CanvasDocument[];
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
        before: CanvasDocument;
        after: CanvasDocument;
        operation: Operation;
    }[] = [];
    private future: typeof this.past = [];
    private options: EditorOptions;
    private dead = false;
    private pending: EditorEvent[] = [];
    private nestedFailure: unknown = null;
    lastOperation: Operation | undefined;
    private pageViews = new Map<string, Viewport>();
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
            for (const s of Object.values(page.objects))
                reconcileShapeGeometry(before?.pagesById[pageId]?.objects[s.id], s);
            refreshFrames(page);
        }
    }
    private prepare(before: CanvasDocument, draft: CanvasDocument): CanvasDocument {
        this.normalize(draft, before);
        const intermediate = clone(draft);
        this.options.reconcile?.(before, draft);
        this.normalize(draft, intermediate);
        validateDocument(draft);
        this.options.validate?.(draft);
        return share(before, draft);
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
        const before = this.doc, draft = clone(before), op = typeof operation === 'string' ? { id: newId('op'), label: operation } : { ...operation, id: operation.id || newId('op') }, ui = { selection: [...this.selection], pageId: this.pageId, hover: this.hover, tool: this.tool, viewport: this.viewport };
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
            this.committed = this.prepare(before, draft);
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
            this.recordHistory({ before, after: this.doc, operation: op });
            this.future = [];
            this.prune();
            this.lastOperation = op;
            const event: EditorEvent = { changes: patches(before, this.doc), operation: op };
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
    private recordHistory(entry: {
        before: CanvasDocument;
        after: CanvasDocument;
        operation: Operation;
    }): void {
        this.past.push(entry);
        let bytes = 0;
        for (let i = this.past.length - 1; i >= 0; i--) {
            bytes += new TextEncoder().encode(JSON.stringify(patches(this.past[i].before, this.past[i].after))).byteLength;
            if (i < this.past.length - 100 || bytes > 16 * 1024 * 1024) {
                this.past.splice(0, i + 1);
                break;
            }
        }
    }
    begin(label: string): boolean {
        if (this.session || this.candidate || this.dead)
            return false;
        this.session = { base: this.doc, operation: { id: newId('op'), label }, history: [this.doc], future: [] };
        this.undo.blocked = true;
        return true;
    }
    preview(mutate: Mutator): void {
        if (!this.session)
            throw new Error('No active session');
        const before = this.doc, draft = clone(before), ui = { selection: [...this.selection], pageId: this.pageId, hover: this.hover, tool: this.tool, viewport: this.viewport };
        this.candidate = draft;
        this.pending = [];
        this.nestedFailure = null;
        try {
            const result = mutate(draft);
            if (result && typeof (result as any).then === 'function')
                throw new Error('Previews must be synchronous');
            if (this.nestedFailure)
                throw this.nestedFailure;
            this.committed = this.prepare(before, draft);
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
            this.session.history.push(this.doc);
            if (this.session.history.length > 100)
                this.session.history.shift();
            this.session.future = [];
            this.prune();
            const event: EditorEvent = { deltas: true };
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
        const changes = patches(session.base, this.doc);
        if (!changes.length)
            return false;
        this.recordHistory({ before: session.base, after: this.doc, operation: session.operation });
        this.future = [];
        this.lastOperation = session.operation;
        this.emit({ changes, operation: session.operation });
        return true;
    }
    cancelSession(): void {
        if (!this.session)
            return;
        this.doc = this.session.base;
        this.session = null;
        this.undo.blocked = false;
        this.prune();
        this.emit({ deltas: true });
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
        this.session = null;
        this.undo.blocked = false;
        this.doc = share(this.doc, next);
        this.past = [];
        this.future = [];
        this.lastOperation = undefined;
        this.prune();
        this.emit({ projection: true, page: true, selection: true });
    }
    receiveDocument(doc: CanvasDocument): void {
        const remote = clone(doc);
        validateDocument(remote);
        this.normalize(remote);
        if (this.session) {
            const previousBase = this.session.base;
            const rebase = (snapshot: CanvasDocument): CanvasDocument => {
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
                return this.prepare(remote, candidate);
            };
            const history = this.session.history.map(rebase), future = this.session.future.map(rebase), current = rebase(this.doc);
            this.session.base = remote;
            this.session.history = history;
            this.session.future = future;
            this.doc = current;
        }
        else
            this.doc = share(this.doc, remote);
        this.prune();
        this.emit({ projection: true, deltas: true });
    }
    undoStep(): boolean {
        if (this.session) {
            const { history, future } = this.session;
            if (history.length < 2)
                return false;
            future.push(history.pop()!);
            this.doc = history.at(-1)!;
            this.prune();
            this.emit({ deltas: true });
            return true;
        }
        if (this.undo.blocked)
            return false;
        const entry = this.past.at(-1);
        if (!entry)
            return false;
        const before = this.doc, next = this.prepare(before, applyPatches(before, patches(entry.after, entry.before)));
        this.doc = next;
        this.past.pop();
        this.future.push(entry);
        this.prune();
        this.lastOperation = { id: newId('op'), label: 'Undo', author: entry.operation.author };
        this.emit({ changes: patches(before, next), operation: this.lastOperation });
        return true;
    }
    redoStep(): boolean {
        if (this.session) {
            const next = this.session.future.pop();
            if (!next)
                return false;
            this.doc = next;
            this.session.history.push(next);
            this.prune();
            this.emit({ deltas: true });
            return true;
        }
        if (this.undo.blocked)
            return false;
        const entry = this.future.at(-1);
        if (!entry)
            return false;
        const before = this.doc, next = this.prepare(before, applyPatches(before, patches(entry.before, entry.after)));
        this.doc = next;
        this.future.pop();
        this.past.push(entry);
        this.prune();
        this.lastOperation = { id: newId('op'), label: 'Redo', author: entry.operation.author };
        this.emit({ changes: patches(before, next), operation: this.lastOperation });
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
