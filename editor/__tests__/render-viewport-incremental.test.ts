import { expect, it } from 'vitest';
import { createDocument, createShape, insertShape } from '../document';
import { ViewportPreparation, type ViewportChanges } from '../render/viewport';
import type { Data, Rect, Shape } from '../contracts';

const viewport = { x: 0, y: 0, width: 800, height: 600 };
type Objects = Record<string, Shape>;
function fixture(): Objects {
    const doc = createDocument(), page = doc.pagesById[doc.pages[0]];
    for (const shape of [
        createShape('group', { id: 'board', width: 30000, height: 1000, strokes: [{ width: 1 }] }),
        createShape('group', { id: 'overflow', parentId: 'board', x: 10000, width: 200, height: 200 }),
        createShape('rect', { id: 'moving', parentId: 'overflow', x: 10000 }),
        createShape('frame', { id: 'clipped', parentId: 'board', x: 20000, width: 200, height: 200, clipContent: true }),
        createShape('text', { id: 'text', parentId: 'clipped', x: 20000 }),
        createShape('group', { id: 'dependent', parentId: 'board', width: 200, height: 200 }),
        createShape('rect', { id: 'mask', parentId: 'dependent' }),
        createShape('rect', { id: 'far', parentId: 'dependent', x: 10000 }),
        createShape('rect', { id: 'edge', x: -390, width: 20 })
    ]) insertShape(page, shape);
    for (let i = 0; i < 520; i++) insertShape(page, createShape('rect', { id: `pad${i}`, x: 50000 + i * 1000 }));
    return page.objects;
}
function edit(objects: Objects, id: string, patch: Data): Objects {
    return { ...objects, [id]: createShape(patch.type ?? objects[id].type, { ...objects[id], ...patch }) };
}
function hint(before: Objects, after: Objects, ids: string[]): ViewportChanges { return { before, after, ids: new Set(ids) }; }
function parity(preparation: ViewportPreparation, source: Objects, selected: string[] = [], area: Rect = viewport) {
    const fresh = new ViewportPreparation(); fresh.update(source, area, selected);
    expect(preparation.roots).toEqual(fresh.roots);
    expect(Object.keys(preparation.objects).sort()).toEqual(Object.keys(fresh.objects).sort());
    for (const id of Object.keys(preparation.objects)) expect(preparation.objects[id]).toBe(source[id]);
}

it('matches full preparation as child geometry, clipping, mask, and filter dependencies change', () => {
    let source = fixture(); const preparation = new ViewportPreparation(); preparation.update(source, viewport);
    for (const [id, patch] of [
        ['moving', { x: 20 }], ['overflow', { clipContent: true }], ['overflow', { clipContent: false }],
        ['dependent', { isMaskGroup: true, maskType: 'alpha' }], ['dependent', { isMaskGroup: false }],
        ['dependent', { effects: [{ type: 'dropShadow', offset: { x: -10000, y: 0 }, radius: 12 }] }],
        ['dependent', { effects: [] }], ['dependent', { hidden: true }], ['dependent', { hidden: false }],
        ['moving', { x: 10000 }]
    ] as [string, Data][]) {
        const next = edit(source, id, patch);
        preparation.update(next, viewport, [], hint(source, next, [id])); source = next;
        parity(preparation, source);
    }
    expect(preparation.objects.moving).toBeUndefined();
    expect(preparation.objects.far).toBeUndefined();
});

it('preserves prepared identities and overscan after an offscreen edit', () => {
    const source = fixture(), preparation = new ViewportPreparation(); preparation.update(source, viewport);
    const objects = preparation.objects, roots = preparation.roots;
    expect(objects.edge).toBe(source.edge);
    const next = edit(source, 'text', { text: 'Offscreen change' }), shifted = { ...viewport, x: 100 };
    expect(preparation.update(next, shifted, [], hint(source, next, ['text']))).toBe(false);
    expect(preparation.objects).toBe(objects); expect(preparation.roots).toBe(roots);
    expect(preparation.objects.edge).toBe(source.edge);
    // The retained preparation area is still the original overscan, not a new
    // window centered on the shifted viewport.
    parity(preparation, next);
    const entered = edit(next, 'moving', { x: 100 });
    expect(preparation.update(entered, shifted, [], hint(next, entered, ['moving']))).toBe(true);
    expect(preparation.roots).toBe(roots); expect(preparation.objects.board).toBe(objects.board);
    expect(preparation.objects.moving).toBe(entered.moving); parity(preparation, entered);
});

it('rebuilds on missing, stale, or mismatched change spans', () => {
    for (const mode of ['missing', 'wrong-before', 'wrong-after']) {
        const source = fixture(), preparation = new ViewportPreparation(); preparation.update(source, viewport);
        const next = edit(source, 'moving', { x: 30 });
        const changes = mode === 'missing' ? undefined : hint(mode === 'wrong-before' ? { ...source } : source, mode === 'wrong-after' ? { ...next } : next, []);
        preparation.update(next, viewport, [], changes);
        expect(preparation.objects.moving).toBe(next.moving); parity(preparation, next);
    }
});

it('rebuilds across reparenting, child ordering, addition, deletion, and type changes', () => {
    let source = fixture(); const preparation = new ViewportPreparation(); preparation.update(source, viewport);
    const apply = (next: Objects, ids: string[], selected: string[] = []) => {
        preparation.update(next, viewport, selected, hint(source, next, ids)); source = next; parity(preparation, source, selected);
    };
    let next = edit(source, 'moving', { parentId: 'dependent', x: 20 });
    next = edit(next, 'overflow', { childIds: [] }); next = edit(next, 'dependent', { childIds: ['mask', 'moving', 'far'] });
    apply(next, ['moving', 'overflow', 'dependent'], ['moving']);
    apply(edit(source, 'dependent', { childIds: ['far', 'moving', 'mask'], isMaskGroup: true }), ['dependent'], ['moving']);
    next = { ...source, added: createShape('rect', { id: 'added', parentId: 'overflow', x: 10 }) };
    apply(edit(next, 'overflow', { childIds: ['added'] }), ['added', 'overflow']);
    next = edit(source, 'overflow', { childIds: [] }); delete next.added;
    apply(next, ['added', 'overflow']);
    apply(edit(source, 'overflow', { type: 'frame', clipContent: true }), ['overflow']);
    expect(preparation.objects.added).toBeUndefined();
});

it('retains complete backdrop sources and reconstructs bounds when the last backdrop disappears', () => {
    let source = fixture(); const preparation = new ViewportPreparation(); preparation.update(source, viewport);
    const apply = (next: Objects, ids: string[]) => {
        preparation.update(next, viewport, [], hint(source, next, ids)); source = next; parity(preparation, source);
    };
    apply(edit(source, 'mask', { backgroundBlur: 8 }), ['mask']); expect(preparation.objects.pad519).toBe(source.pad519);
    apply(edit(source, 'moving', { x: 20 }), ['moving']);
    apply(edit(source, 'far', { effects: [{ type: 'background-blur', radius: 12 }] }), ['far']);
    apply(edit(source, 'mask', { backgroundBlur: 0 }), ['mask']); expect(preparation.objects.pad519).toBe(source.pad519);
    apply(edit(source, 'far', { effects: [] }), ['far']); expect(preparation.objects.pad519).toBeUndefined();
    expect(preparation.objects.moving).toBe(source.moving);
});
