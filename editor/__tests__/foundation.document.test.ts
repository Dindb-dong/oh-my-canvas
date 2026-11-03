/** Fresh transaction/tree expectations, independent of retired private tests. */
import { describe, it, expect, vi } from 'vitest';
import { Editor, createDocument, createShape, insertShape, removeShapes, reparentShapes, cloneShapes, duplicatePage, addPage, deletePage, validateDocument, descendants, topLevelIds, moveTree } from '../document';
const setup = () => {
    const doc = createDocument(), page = doc.pagesById[doc.pages[0]];
    insertShape(page, createShape('rect', { id: 'a', x: 10, y: 20, width: 30, height: 40 }));
    insertShape(page, createShape('rect', { id: 'b', x: 80, y: 100, width: 20, height: 20 }));
    return new Editor(doc);
};
describe('DOC-01/DOC-03 isolated immutable document tree', () => {
    it('creates exactly one valid root and retains opaque document metadata', () => {
        const doc = createDocument({ extra: { licenseNote: 'owned' } });
        validateDocument(doc);
        expect(doc.pages).toHaveLength(1);
        expect(doc.pagesById[doc.pages[0]].objects.root.parentId).toBe('root');
        expect(doc.extra).toEqual({ licenseNote: 'owned' });
    });
    it('publishes changed branches only and emits one labelled compound operation', () => {
        const e = setup(), before = e.doc, beforeB = e.page.objects.b, events: any[] = [];
        e.on(ev => events.push(ev));
        const value = e.transact({ id: 'op-explicit', label: 'Compound', author: 'alice', group: 'gesture' }, doc => {
            doc.pagesById[e.pageId].objects.a.x = 50;
            return e.transact('nested', draft => {
                draft.pagesById[e.pageId].objects.a.name = 'Changed';
                return 42;
            });
        });
        expect(value).toBe(42);
        expect(e.doc).not.toBe(before);
        expect(before.pagesById[e.pageId].objects.a.x).toBe(10);
        expect(e.page.objects.b).toBe(beforeB);
        expect(events).toHaveLength(1);
        expect(events[0].operation).toEqual({ id: 'op-explicit', label: 'Compound', author: 'alice', group: 'gesture' });
    });
    it('does not emit or replace references for a no-op transaction', () => {
        const e = setup(), doc = e.doc, listener = vi.fn();
        e.on(listener);
        e.transact('Nothing', () => {
        });
        expect(e.doc).toBe(doc);
        expect(listener).not.toHaveBeenCalled();
    });
    it('rolls model and UI state back when a mutator or reconciliation fails', () => {
        const e = setup(), original = e.doc, events = vi.fn();
        e.setSelection(['a']);
        e.on(events);
        expect(() => e.transact('Bad', doc => {
            doc.pagesById[e.pageId].objects.a.x = NaN;
            e.setSelection(['b']);
        })).toThrow();
        expect(e.doc).toBe(original);
        expect(e.selection).toEqual(['a']);
        expect(events).not.toHaveBeenCalled();
        const f = new Editor(e.doc, { reconcile() {
                throw Error('Rejected derivative');
            } });
        expect(() => f.transact('Fail', doc => doc.pagesById[f.pageId].objects.a.name = 'discard')).toThrow('Rejected derivative');
        expect(f.page.objects.a.name).not.toBe('discard');
    });
    it('aborts an outer candidate even when a nested failure is caught by caller', () => {
        const e = setup(), original = e.doc;
        expect(() => e.transact('Outer', doc => {
            doc.pagesById[e.pageId].objects.a.name = 'partial';
            try {
                e.transact('Inner', () => {
                    throw Error('Inner failure');
                });
            }
            catch {
            }
        })).toThrow('Inner failure');
        expect(e.doc).toBe(original);
    });
    it('rejects async outer and nested mutations synchronously', () => {
        const e = setup(), doc = e.doc;
        expect(() => e.transact('Async', async () => 42)).toThrow(/synchronous/);
        expect(() => e.transact('Outer', () => {
            e.transact('Inner', async () => 42);
        })).toThrow(/synchronous/);
        expect(e.doc).toBe(doc);
    });
    it.each(['orphan', 'duplicate-child', 'cycle', 'missing-child', 'invalid-root', 'nonfinite-path'])('rejects %s without partial publication', kind => {
        const e = setup(), doc = e.doc;
        expect(() => e.transact('Invalid', d => {
            const p = d.pagesById[e.pageId];
            if (kind === 'orphan')
                p.objects.a.parentId = 'none';
            if (kind === 'duplicate-child')
                p.objects.root.childIds!.push('a');
            if (kind === 'cycle') {
                p.objects.a.childIds = ['root'];
                p.objects.a.type = 'group';
            }
            if (kind === 'missing-child')
                p.objects.root.childIds!.push('missing');
            if (kind === 'invalid-root')
                p.objects.root.parentId = 'a';
            if (kind === 'nonfinite-path')
                insertShape(p, createShape('path', { content: [{ command: 'move', x: NaN, y: 0 }] }));
        })).toThrow();
        expect(e.doc).toBe(doc);
    });
    it('rejects document capacity before overwriting a valid state', () => {
        const e = setup(), original = e.doc;
        expect(() => e.transact('Oversize', doc => doc.extra = 'x'.repeat(16 * 1024 * 1024))).toThrow(/16 MiB/);
        expect(e.doc).toBe(original);
    });
    it('reparents in world coordinates and rejects containment cycles', () => {
        const e = setup();
        e.transact('Group', doc => {
            const page = doc.pagesById[e.pageId];
            insertShape(page, createShape('group', { id: 'g', childIds: [] }));
            reparentShapes(page, ['a'], 'g');
        });
        expect(e.page.objects.a.x).toBe(10);
        expect(e.page.objects.a.parentId).toBe('g');
        expect(() => e.transact('Cycle', doc => reparentShapes(doc.pagesById[e.pageId], ['g'], 'a'))).toThrow();
    });
    it('duplicates complete subtrees with fresh internal mask references and source order', () => {
        const e = setup();
        e.transact('Tree', doc => {
            const p = doc.pagesById[e.pageId];
            insertShape(p, createShape('group', { id: 'g', childIds: [], maskId: 'a', isMaskGroup: true }));
            reparentShapes(p, ['b', 'a'], 'g');
            const roots = cloneShapes(p, ['g'], { dx: 20, dy: 30 });
            const copy = roots[0];
            expect(copy.id).not.toBe('g');
            expect(copy.childIds).toHaveLength(2);
            expect(copy.maskId).toBe(copy.childIds![0]);
            expect(p.objects[copy.childIds![0]].x).toBe(30);
            expect(topLevelIds(p, [...copy.childIds!, copy.id])).toEqual([copy.id]);
        });
    });
    it('adds, duplicates and deletes pages without sharing mutable entities', () => {
        const e = setup();
        e.transact('Pages', doc => {
            const second = addPage(doc, 'Second'), copy = duplicatePage(doc, e.pageId);
            expect(copy.objects.root).not.toBe(doc.pagesById[e.pageId].objects.root);
            expect(copy.objects.root.childIds).not.toContain('a');
            deletePage(doc, second.id);
        });
        expect(e.doc.pages).toHaveLength(2);
        expect(() => {
            const d = createDocument();
            deletePage(d, d.pages[0]);
        }).toThrow();
    });
    it('moves a subtree together, including canonical path controls', () => {
        const e = setup();
        e.transact('Vector group', doc => {
            const p = doc.pagesById[e.pageId];
            insertShape(p, createShape('group', { id: 'g', childIds: [] }));
            insertShape(p, createShape('path', { id: 'p', content: [{ command: 'move', x: 0, y: 0 }, { command: 'curve', x1: 1, y1: 2, x2: 3, y2: 4, x: 5, y: 6 }] }), 'g');
            moveTree(p, 'g', 10, 20);
        });
        expect(e.page.objects.p.content[1]).toMatchObject({ x1: 11, y1: 22, x2: 13, y2: 24, x: 15, y: 26 });
    });
});
describe('HIST-01/MCP-02/COL-02 sessions and projections', () => {
    it('previews are nondurable, cancel rolls back, and commit is one operation', () => {
        const e = setup(), events: any[] = [];
        e.on(event => events.push(event));
        expect(e.begin('Drag')).toBe(true);
        expect(e.undo.blocked).toBe(true);
        e.preview(doc => doc.pagesById[e.pageId].objects.a.x = 25);
        e.preview(doc => doc.pagesById[e.pageId].objects.a.x = 35);
        expect(events.every(ev => !ev.changes)).toBe(true);
        e.cancelSession();
        expect(e.page.objects.a.x).toBe(10);
        expect(e.undo.blocked).toBe(false);
        expect(e.begin('Second drag')).toBe(true);
        e.preview(doc => doc.pagesById[e.pageId].objects.a.x = 50);
        expect(e.commitSession()).toBe(true);
        expect(events.filter(ev => ev.changes)).toHaveLength(1);
        expect(e.lastOperation?.label).toBe('Second drag');
        expect(e.undoStep()).toBe(true);
        expect(e.page.objects.a.x).toBe(10);
        expect(e.redoStep()).toBe(true);
        expect(e.page.objects.a.x).toBe(50);
    });
    it('keeps session-local undo when host overrides durable undo', () => {
        const e = setup();
        e.begin('Text');
        e.preview(doc => doc.pagesById[e.pageId].objects.a.name = 'One');
        e.preview(doc => doc.pagesById[e.pageId].objects.a.name = 'Two');
        e.undoStep = () => {
            throw Error('Host undo must not run');
        };
        expect(e.undoSession()).toBe(true);
        expect(e.page.objects.a.name).toBe('One');
        expect(e.redoSession()).toBe(true);
        expect(e.page.objects.a.name).toBe('Two');
        e.cancelSession();
    });
    it('blocks durable mutations while a user session is active', () => {
        const e = setup();
        e.begin('Busy');
        expect(() => e.transact('Agent', doc => doc.extra = 1)).toThrow(/busy/);
        expect(e.begin('Nested session')).toBe(false);
        e.cancelSession();
    });
    it('rebases local previews and session history onto remote fields and new siblings', () => {
        const e = setup(), events: any[] = [];
        e.on(event => events.push(event));
        e.begin('Local');
        e.preview(doc => doc.pagesById[e.pageId].objects.a.x = 30);
        e.preview(doc => doc.pagesById[e.pageId].objects.a.x = 40);
        const remote = structuredClone(e.doc);
        remote.pagesById[e.pageId].objects.a.x = 10;
        remote.pagesById[e.pageId].objects.a.name = 'Remote label';
        insertShape(remote.pagesById[e.pageId], createShape('rect', { id: 'remote' }));
        e.receiveDocument(remote);
        expect(e.page.objects.a.x).toBe(40);
        expect(e.page.objects.a.name).toBe('Remote label');
        expect(e.page.objects.root.childIds).toContain('remote');
        expect(events.at(-1).projection).toBe(true);
        expect(events.at(-1).changes).toBeUndefined();
        e.undoSession();
        expect(e.page.objects.a.x).toBe(30);
        expect(e.page.objects.a.name).toBe('Remote label');
        e.cancelSession();
        expect(e.page.objects.a.x).toBe(10);
        expect(e.page.objects.root.childIds).toContain('remote');
    });
    it('does not resurrect a remotely deleted active layer on cancel/commit', () => {
        const e = setup();
        e.setSelection(['a']);
        e.begin('Local');
        e.preview(doc => doc.pagesById[e.pageId].objects.a.name = 'Editing');
        const remote = structuredClone(e.doc);
        removeShapes(remote.pagesById[e.pageId], ['a']);
        e.receiveDocument(remote);
        expect(e.selection).toEqual([]);
        expect(e.page.objects.a).toBeUndefined();
        e.commitSession();
        expect(e.page.objects.a).toBeUndefined();
    });
    it('preserves independent remote fields through fallback local undo/redo', () => {
        const e = setup();
        e.transact('Move', doc => doc.pagesById[e.pageId].objects.a.x = 30);
        const remote = structuredClone(e.doc);
        remote.pagesById[e.pageId].objects.a.name = 'From peer';
        e.receiveDocument(remote);
        e.undoStep();
        expect(e.page.objects.a.x).toBe(10);
        expect(e.page.objects.a.name).toBe('From peer');
        e.redoStep();
        expect(e.page.objects.a.x).toBe(30);
        expect(e.page.objects.a.name).toBe('From peer');
    });
    it('rejects invalid replacement and preserves active live state', () => {
        const e = setup(), doc = e.doc;
        e.begin('Local');
        const invalid = structuredClone(doc);
        invalid.pages = [];
        expect(() => e.replaceDocument(invalid)).toThrow();
        expect(e.doc).toBe(doc);
        expect(e.activeSession).toBe(true);
        e.cancelSession();
        e.destroy();
        expect(() => e.transact('After destroy', () => {
        })).toThrow(/destroyed/);
    });
});
describe('adversarial projections and geometry publication', () => {
    it('merges remote/new local siblings, then undoes only the committed local addition', () => {
        const e = setup(), base = structuredClone(e.doc);
        e.begin('Create');
        e.preview(doc => insertShape(doc.pagesById[e.pageId], createShape('rect', { id: 'local' })));
        const remote = structuredClone(base);
        insertShape(remote.pagesById[e.pageId], createShape('rect', { id: 'peer' }));
        e.receiveDocument(remote);
        expect(new Set(e.page.objects.root.childIds)).toEqual(new Set(['a', 'b', 'local', 'peer']));
        e.commitSession();
        e.undoStep();
        expect(e.page.objects.local).toBeUndefined();
        expect(e.page.objects.peer).toBeDefined();
        expect(e.page.objects.root.childIds).toContain('peer');
        e.redoStep();
        expect(e.page.objects.local).toBeDefined();
        expect(e.page.objects.root.childIds).toContain('peer');
    });
    it('drops a local preview child when its remote parent is deleted', () => {
        const e = setup();
        e.transact('Container', doc => insertShape(doc.pagesById[e.pageId], createShape('frame', { id: 'frame', childIds: [] })));
        const baseline = structuredClone(e.doc);
        e.begin('Nested draw');
        e.preview(doc => insertShape(doc.pagesById[e.pageId], createShape('rect', { id: 'local' }), 'frame'));
        const remote = structuredClone(baseline);
        removeShapes(remote.pagesById[e.pageId], ['frame']);
        e.receiveDocument(remote);
        expect(e.page.objects.frame).toBeUndefined();
        expect(e.page.objects.local).toBeUndefined();
        e.cancelSession();
        expect(e.page.objects.local).toBeUndefined();
    });
    it('normalizes direct path scalar edits before a reconciliation hook consumes them', () => {
        const doc = createDocument(), page = doc.pagesById[doc.pages[0]];
        insertShape(page, createShape('line', { id: 'path', x: 0, y: 0, width: 10, height: 10 }));
        const observed: any[] = [];
        const e = new Editor(doc, { reconcile(_before, draft) {
                observed.push(structuredClone(draft.pagesById[e.pageId].objects.path.content));
            } });
        e.transact('Rotate direct', d => {
            d.pagesById[e.pageId].objects.path.rotation = 90;
        });
        expect(observed[0][0].x).toBeCloseTo(10);
        expect(observed[0][0].y).toBeCloseTo(0);
        e.transact('Width direct', d => {
            d.pagesById[e.pageId].objects.path.width = 20;
        });
        expect(e.page.objects.path.content[0].x).toBeCloseTo(15);
        expect(e.page.objects.path.content[0].y).toBeCloseTo(-5);
    });
    it('retains session redo history through remote projection', () => {
        const e = setup(), baseline = structuredClone(e.doc);
        e.begin('Typing');
        e.preview(doc => doc.pagesById[e.pageId].objects.a.name = 'First');
        e.preview(doc => doc.pagesById[e.pageId].objects.a.name = 'Second');
        e.undoSession();
        const remote = structuredClone(baseline);
        remote.pagesById[e.pageId].objects.b.name = 'Peer';
        e.receiveDocument(remote);
        expect(e.page.objects.a.name).toBe('First');
        expect(e.redoSession()).toBe(true);
        expect(e.page.objects.a.name).toBe('Second');
        expect(e.page.objects.b.name).toBe('Peer');
        e.cancelSession();
    });
});
it('creates transparent structural groups while retaining explicitly supplied fills',()=>{expect(createShape('group').fills).toEqual([]);expect(createShape('group',{fills:[{color:'#ff0000'}]}).fills).toEqual([{color:'#ff0000'}]);});
