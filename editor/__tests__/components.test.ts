/** Fresh independent synthetic regressions, authored after barrier f86e063. No inherited test inputs. */
import { describe, it, expect } from 'vitest';
import { Editor, createDocument, createPage, createShape, insertShape, removeShapes, descendants } from '../document';
import { createComponentService, reconcileComponents, duplicateComponentMain } from '../components';
import { reconcileStyles } from '../styles';
import { reconcileLibraries } from '../assets';
import type { Shape } from '../contracts';
function setup() {
    const doc = createDocument({ pageId: 'page-a' });
    const page = doc.pagesById['page-a'];
    const other = createPage('Second', 'page-b');
    doc.pages.push(other.id);
    doc.pagesById[other.id] = other;
    insertShape(page, createShape('frame', { id: 'card', name: 'Card', x: 100, y: 100, width: 200, height: 100 }));
    insertShape(page, createShape('text', { id: 'label', name: 'Label', x: 110, y: 120, width: 140, height: 24, content: { type: 'richText', children: [{ children: [{ text: 'Start', fontSize: 16, fontWeight: 400, fills: [{ color: '#111111' }] }] }] } }), 'card');
    insertShape(page, createShape('rect', { id: 'badge', name: 'Badge', x: 260, y: 115, width: 20, height: 20, fills: [{ color: '#ff0000' }] }), 'card');
    const editor = new Editor(doc, { reconcile(before, draft) {
            reconcileLibraries(before, draft);
            reconcileComponents(before, draft);
            reconcileStyles(before, draft);
        } });
    const service = createComponentService(editor);
    const created = service.run('create', { id: 'card', name: 'Card' });
    return { editor, service, componentId: created.componentId as string };
}
function linked(editor: Editor, rootId: string, sourceId: string, pageId = editor.pageId): Shape {
    const found = descendants(editor.doc.pagesById[pageId], rootId, true).find(s => s.sourceId === sourceId);
    if (!found)
        throw Error(`No linked ${sourceId}`);
    return found;
}
function text(shape: Shape) {
    return shape.content.children.map((p: any) => p.children.map((r: any) => r.text).join('')).join('\n');
}
function instance(ctx: ReturnType<typeof setup>, options: Record<string, any> = {}) {
    return ctx.service.run('instance', { source: ctx.componentId, x: 500, y: 300, ...options }).selection[0] as string;
}
describe('components: source/instance lifecycle and atomic history', () => {
    it('creates from multiple shapes and duplicates a main as a linked instance', () => {
        const { editor, service, componentId } = setup();
        const copy = editor.transact('Duplicate main', doc => duplicateComponentMain(doc, doc.pagesById['page-a'], 'card', { dx: 400, dy: 200 })!);
        expect(copy.id).not.toBe('card');
        expect(editor.page.objects[copy.id]).toMatchObject({ componentId, isInstanceRoot: true, sourceId: 'card', x: 500, y: 300 });
        expect(linked(editor, copy.id, 'label').x).toBe(510);
        editor.transact('Loose shape', doc => insertShape(doc.pagesById['page-a'], createShape('rect', { id: 'loose', x: 0, y: 0, width: 10, height: 10 })));
        const created = service.run('create', { ids: ['card', 'loose'], name: 'Wrapper' });
        expect(editor.page.objects[created.selection[0]].childIds).toEqual(['card', 'loose']);
    });
    it('propagates source fields, child creation/deletion/reordering across pages', () => {
        const ctx = setup(), id = instance(ctx, { pageId: 'page-b' });
        const { editor } = ctx;
        expect(linked(editor, id, 'label', 'page-b')).toMatchObject({ x: 510, y: 320 });
        editor.transact('Edit source', doc => {
            const p = doc.pagesById['page-a'];
            p.objects.badge.fills = [{ color: '#00ff00' }];
            insertShape(p, createShape('ellipse', { id: 'dot', name: 'Dot', x: 130, y: 160, width: 12, height: 12 }), 'card');
            p.objects.card.childIds = ['dot', 'badge', 'label'];
        });
        const p = editor.doc.pagesById['page-b'];
        expect(p.objects[id].childIds!.map(k => p.objects[k].sourceId)).toEqual(['dot', 'badge', 'label']);
        expect(linked(editor, id, 'dot', 'page-b')).toMatchObject({ type: 'ellipse', x: 530, y: 360 });
        expect(linked(editor, id, 'badge', 'page-b').fills).toEqual([{ color: '#00ff00' }]);
        editor.transact('Delete source child', doc => removeShapes(doc.pagesById['page-a'], ['dot']));
        expect(descendants(editor.doc.pagesById['page-b'], id).some(s => s.sourceId === 'dot')).toBe(false);
    });
    it('keeps character overrides while accepting source typography, and inversely keeps typography overrides', () => {
        const ctx = setup(), a = instance(ctx), b = instance(ctx, { x: 800, y: 300 });
        const { editor } = ctx;
        const aText = linked(editor, a, 'label').id, bText = linked(editor, b, 'label').id;
        editor.transact('Override A characters', doc => {
            const shape = doc.pagesById['page-a'].objects[aText];
            const style = shape.content.children[0].children[0];
            shape.content.children[0].children = [{ ...style, text: 'Custom ' }, { ...style, text: 'tail' }];
        });
        editor.transact('Override B style', doc => doc.pagesById['page-a'].objects[bText].content.children[0].children[0].fontSize = 30);
        editor.transact('Change main text and style', doc => {
            const run = doc.pagesById['page-a'].objects.label.content.children[0].children[0];
            run.text = 'Source changed';
            run.fontSize = 22;
        });
        expect(text(editor.page.objects[aText])).toBe('Custom tail');
        expect(editor.page.objects[aText].content.children[0].children.every((r: any) => r.fontSize === 22)).toBe(true);
        expect(text(editor.page.objects[bText])).toBe('Source changed');
        expect(editor.page.objects[bText].content.children[0].children[0].fontSize).toBe(30);
    });
    it('does not treat a root world move as a source override', () => {
        const ctx = setup(), id = instance(ctx);
        const { editor } = ctx;
        editor.transact('Move instance', doc => {
            const p = doc.pagesById['page-a'];
            for (const s of descendants(p, id, true)) {
                s.x += 80;
                s.y -= 40;
            }
        });
        expect(editor.page.objects[id].overrides || []).not.toContain('x');
        expect(linked(editor, id, 'label').overrides || []).not.toContain('x');
        editor.transact('Move source child', doc => doc.pagesById['page-a'].objects.label.x += 5);
        expect(linked(editor, id, 'label')).toMatchObject({ x: 595, y: 280 });
    });
    it('resets edits and preserves placement; one operation can be undone atomically', () => {
        const ctx = setup(), id = instance(ctx);
        const { editor, service } = ctx;
        const label = linked(editor, id, 'label').id;
        editor.transact('Overrides', doc => {
            doc.pagesById['page-a'].objects[label].content.children[0].children[0].text = 'Different';
            doc.pagesById['page-a'].objects[id].width = 333;
        });
        const events: any[] = [];
        editor.on(e => {
            if (e.changes)
                events.push(e);
        });
        service.run('reset', { id });
        expect(text(editor.page.objects[label])).toBe('Start');
        expect(editor.page.objects[id]).toMatchObject({ x: 500, y: 300, width: 200 });
        expect(events).toHaveLength(1);
        expect(editor.undoStep()).toBe(true);
        expect(text(editor.page.objects[label])).toBe('Different');
        expect(editor.page.objects[id].width).toBe(333);
    });
    it('detaches without losing appearance and handles deleted sources', () => {
        const ctx = setup(), a = instance(ctx), b = instance(ctx, { x: 800, y: 300 });
        const { editor, service } = ctx;
        const label = linked(editor, a, 'label').id;
        service.run('detach', { id: a });
        expect(editor.page.objects[a].componentId).toBeUndefined();
        expect(text(editor.page.objects[label])).toBe('Start');
        expect(editor.page.objects[label].sourceId).toBeUndefined();
        editor.transact('Remove main', doc => removeShapes(doc.pagesById['page-a'], ['card']));
        expect(editor.doc.components![ctx.componentId].deleted).toBe(true);
        expect(editor.page.objects[b].componentId).toBeUndefined();
        expect(descendants(editor.page, b)).toHaveLength(2);
    });
    it('joins a parent transaction and rolls back a cyclic instance insertion', () => {
        const ctx = setup();
        const { editor, service } = ctx;
        const events: any[] = [];
        editor.on(e => {
            if (e.changes)
                events.push(e);
        });
        editor.transact({ id: 'agent-step', label: 'Agent operation' }, () => {
            instance(ctx);
            instance(ctx, { x: 800, y: 300 });
        });
        expect(events).toHaveLength(1);
        expect(events[0].operation.id).toBe('agent-step');
        const before = editor.doc;
        expect(() => service.run('instance', { source: ctx.componentId, parent: 'card' })).toThrow(/cycle/i);
        expect(editor.doc).toBe(before);
        expect(events).toHaveLength(1);
    });
});
describe('components: variants and properties (all twelve public actions)', () => {
    it('combines mains, rejects duplicate axes/value combinations, switches with preserved text override', () => {
        const ctx = setup(), { editor, service } = ctx;
        editor.transact('Second main shape', doc => {
            const p = doc.pagesById['page-a'];
            insertShape(p, createShape('frame', { id: 'secondary', name: 'Secondary', x: 100, y: 400, width: 220, height: 100 }));
            insertShape(p, createShape('text', { id: 'secondary-label', name: 'Label', x: 110, y: 420, width: 140, height: 24, text: 'Second' }), 'secondary');
        });
        const other = service.run('create', { id: 'secondary', name: 'State=Pressed' });
        editor.transact('Name first', doc => doc.components![ctx.componentId].name = 'State=Normal');
        const combined = service.run('combine', { ids: ['card', 'secondary'], name: 'Control' });
        expect(editor.page.objects[combined.selection[0]].isVariantSet).toBe(true);
        const id = instance(ctx), label = linked(editor, id, 'label').id;
        editor.transact('Override label', doc => doc.pagesById['page-a'].objects[label].content.children[0].children[0].text = 'Keep me');
        const result = service.run('variant', { id, name: 'State', value: 'Pressed' });
        expect(result.selection).toEqual([id]);
        expect(editor.page.objects[id].componentId).toBe(other.componentId);
        expect(text(editor.page.objects[label])).toBe('Keep me');
        expect(editor.page.objects[id].width).toBe(220);
        const before = editor.doc;
        expect(() => service.run('add_variant', { id: 'secondary', variantProperties: [{ name: 'State', value: 'Pressed' }] })).toThrow(/duplicate variant/i);
        expect(editor.doc).toBe(before);
    });
    it('switches one axis in a multi-axis family and remaps property values by definition name', () => {
        const ctx = setup(), { editor, service } = ctx;
        editor.transact('Second variant', doc => {
            const p = doc.pagesById['page-a'];
            insertShape(p, createShape('frame', { id: 'large', name: 'Large', x: 100, y: 400, width: 240, height: 100 }));
            insertShape(p, createShape('text', { id: 'large-label', name: 'Label', x: 110, y: 420, width: 140, height: 24, text: 'Large' }), 'large');
        });
        const other = service.run('create', { id: 'large', name: 'Size=Large, State=Normal' }).componentId;
        editor.transact('Name first variant', doc => doc.components![ctx.componentId].name = 'Size=Small, State=Normal');
        service.run('combine', { ids: ['card', 'large'], name: 'Button' });
        const original = service.run('property', { id: 'card', name: 'Title', propertyType: 'text', value: 'Small' }).property;
        service.run('bind', { id: 'card', property: original.id, propertyType: 'text', layer: 'label' });
        const replacement = service.run('property', { id: 'large', name: 'Title', propertyType: 'text', value: 'Large' }).property;
        service.run('bind', { id: 'large', property: replacement.id, propertyType: 'text', layer: 'large-label' });
        const id = instance(ctx);
        service.run('set_property', { id, property: original.id, value: 'User title' });
        editor.transact('Legacy property container', doc => {
            const root = doc.pagesById['page-a'].objects[id];
            root.propertyValues = root.componentProperties;
            delete root.componentProperties;
        });
        service.run('variant', { id, name: 'Size', value: 'Large' });
        expect(editor.page.objects[id].componentId).toBe(other);
        expect(editor.page.objects[id].componentProperties[replacement.id]).toBe('User title');
        expect(text(descendants(editor.page, id).find(s => s.type === 'text')!)).toBe('User title');
        const before = editor.doc;
        expect(() => editor.transact('Invalid axes', doc => doc.components![other].variantProperties = [{ name: 'Size', value: 'Large' }, { name: 'Size', value: 'Normal' }])).toThrow(/axes/);
        expect(editor.doc).toBe(before);
    });
    it('infers named axes when adding the first variant set', () => {
        const { editor, service, componentId } = setup();
        editor.transact('Name main', doc => doc.components![componentId].name = 'State=Normal');
        const result = service.run('add_variant', { id: 'card', name: 'State=Pressed' });
        expect(editor.doc.components![componentId].variantProperties).toEqual([{ name: 'State', value: 'Normal' }]);
        expect(editor.doc.components![result.componentId].variantProperties).toEqual([{ name: 'State', value: 'Pressed' }]);
    });
    it('adds variants from another-page instances and preserves property definitions', () => {
        const ctx = setup(), { editor, service } = ctx;
        const property = service.run('property', { id: 'card', name: 'Title', propertyType: 'text', value: 'Start' }).property;
        const id = instance(ctx, { pageId: 'page-b' });
        editor.setPage('page-b');
        const result = service.run('add_variant', { id, value: 'Alternate' });
        expect(result.pageId).toBe('page-a');
        const c = editor.doc.components![result.componentId];
        expect(c.properties).toEqual([property]);
        expect(c.variantProperties).toEqual([{ name: 'Variant', value: 'Alternate' }]);
        expect(editor.doc.pagesById['page-a'].objects[c.mainId].isMain).toBe(true);
    });
    it('creates/binds/edits/sets/removes text and boolean properties with defaults and explicit values', () => {
        const ctx = setup(), { editor, service } = ctx;
        const label = service.run('property', { id: 'card', name: 'Title', propertyType: 'text', value: 'Default' }).property;
        service.run('bind', { id: 'card', property: label.id, propertyType: 'text', layer: 'label' });
        const visible = service.run('bind', { id: 'card', name: 'Badge visible', propertyType: 'boolean', layer: 'badge' }).property;
        const a = instance(ctx), b = instance(ctx, { x: 800, y: 300 });
        expect(text(linked(editor, a, 'label'))).toBe('Default');
        service.run('set_property', { id: a, property: label.id, value: 'Mine' });
        service.run('set_property', { id: a, property: visible.id, value: 'false' });
        service.run('edit_property', { id: 'card', property: label.id, name: 'Renamed', value: 'New default' });
        expect(text(linked(editor, a, 'label'))).toBe('Mine');
        expect(text(linked(editor, b, 'label'))).toBe('New default');
        expect(linked(editor, a, 'badge').hidden).toBe(true);
        expect(linked(editor, b, 'badge').hidden).toBe(false);
        const before = editor.doc;
        expect(() => service.run('set_property', { id: a, property: visible.id, value: 'maybe' })).toThrow(/Boolean/);
        expect(editor.doc).toBe(before);
        service.run('remove_property', { id: 'card', property: label.id });
        expect(editor.doc.components![ctx.componentId].properties.some((p: any) => p.id === label.id)).toBe(false);
        expect(linked(editor, a, 'label').componentPropertyRefs?.characters).toBeUndefined();
        expect(editor.page.objects[a].componentProperties[label.id]).toBeUndefined();
    });
    it('preserves other legacy propertyValues when setting one property', () => {
        const ctx = setup(), { editor, service } = ctx;
        const title = service.run('property', { id: 'card', name: 'Title', propertyType: 'text', value: 'Start' }).property;
        service.run('bind', { id: 'card', property: title.id, propertyType: 'text', layer: 'label' });
        const visible = service.run('bind', { id: 'card', layer: 'badge', name: 'Visible', propertyType: 'boolean' }).property;
        const id = instance(ctx);
        editor.transact('Legacy values', doc => doc.pagesById['page-a'].objects[id].propertyValues = { [title.id]: 'Legacy', [visible.id]: false });
        service.run('set_property', { id, property: title.id, value: 'Updated' });
        expect(text(linked(editor, id, 'label'))).toBe('Updated');
        expect(linked(editor, id, 'badge').hidden).toBe(true);
        service.run('detach', { id });
        expect(editor.page.objects[id].propertyValues).toBeUndefined();
    });
    it('rejects cross-main property bindings without changing the candidate', () => {
        const ctx = setup(), { editor, service } = ctx;
        const p = service.run('property', { id: 'card', name: 'Text', propertyType: 'text' }).property;
        editor.transact('External text', doc => insertShape(doc.pagesById['page-a'], createShape('text', { id: 'outside', text: 'Outside' })));
        const before = editor.doc;
        expect(() => service.run('bind', { id: 'card', property: p.id, propertyType: 'text', layer: 'outside' })).toThrow(/belong/);
        expect(editor.doc).toBe(before);
    });
    it('retains nested instances through adding variants and detaching the outer instance', () => {
        const ctx = setup(), { editor, service } = ctx;
        editor.transact('Wrapper', doc => insertShape(doc.pagesById['page-a'], createShape('frame', { id: 'wrapper', x: 600, y: 100, width: 300, height: 200 })));
        const nested = service.run('instance', { source: ctx.componentId, parent: 'wrapper', x: 620, y: 130 }).selection[0];
        const outer = service.run('create', { id: 'wrapper', name: 'Wrapper' });
        const clone = service.run('add_variant', { id: 'wrapper', value: 'Other' });
        const cloneMain = editor.page.objects[clone.selection[0]];
        expect(descendants(editor.page, cloneMain.id).filter(s => s.isInstanceRoot && !s.isMain).map(s => s.componentId)).toContain(ctx.componentId);
        const inserted = service.run('instance', { source: outer.componentId, x: 1000, y: 100 }).selection[0];
        service.run('detach', { id: inserted });
        const retained = descendants(editor.page, inserted).find(s => s.isInstanceRoot);
        expect(retained?.componentId).toBe(ctx.componentId);
        editor.transact('Change nested source', doc => doc.pagesById['page-a'].objects.badge.fills = [{ color: '#0000ff' }]);
        expect(descendants(editor.page, retained!.id).find(s => s.name === 'Badge')?.fills).toEqual([{ color: '#0000ff' }]);
        expect(editor.page.objects[nested].componentId).toBe(ctx.componentId);
    });
    it('propagates nested source style edits and resets an outer instance to inherited nested text values', () => {
        const ctx = setup(), { editor, service } = ctx;
        const p = service.run('property', { id: 'card', name: 'Title', propertyType: 'text', value: 'Start' }).property;
        service.run('bind', { id: 'card', property: p.id, propertyType: 'text', layer: 'label' });
        editor.transact('Wrapper', doc => insertShape(doc.pagesById['page-a'], createShape('frame', { id: 'wrapper', x: 600, y: 100, width: 300, height: 200 })));
        const nested = service.run('instance', { source: ctx.componentId, parent: 'wrapper', x: 620, y: 130 }).selection[0];
        service.run('set_property', { id: nested, property: p.id, value: 'Nested default' });
        const outer = service.run('create', { id: 'wrapper', name: 'Wrapper' }).componentId;
        const inserted = service.run('instance', { source: outer, x: 1000, y: 100 }).selection[0];
        const localText = descendants(editor.page, inserted).find(s => s.type === 'text')!.id;
        expect(text(editor.page.objects[localText])).toBe('Nested default');
        editor.transact('Local nested characters', doc => doc.pagesById['page-a'].objects[localText].content.children[0].children[0].text = 'Local edit');
        editor.transact('Base typography', doc => doc.pagesById['page-a'].objects.label.content.children[0].children[0].fontSize = 25);
        expect(text(editor.page.objects[localText])).toBe('Local edit');
        expect(editor.page.objects[localText].content.children[0].children[0].fontSize).toBe(25);
        service.run('reset', { id: inserted });
        const resetText = descendants(editor.page, inserted).find(s => s.type === 'text')!;
        expect(text(resetText)).toBe('Nested default');
        expect(resetText.content.children[0].children[0].fontSize).toBe(25);
    });
    it('swaps a bound nested component and rejects cycles', () => {
        const ctx = setup(), { editor, service } = ctx;
        editor.transact('Alternate and wrapper', doc => {
            const p = doc.pagesById['page-a'];
            insertShape(p, createShape('frame', { id: 'alt', name: 'Alt', x: 0, y: 0, width: 70, height: 30 }));
            insertShape(p, createShape('rect', { id: 'alt-child', x: 0, y: 0, width: 10, height: 10 }), 'alt');
            insertShape(p, createShape('frame', { id: 'wrapper', x: 600, y: 100, width: 300, height: 200 }));
        });
        const alternate = service.run('create', { id: 'alt', name: 'Alt' }).componentId;
        const inner = service.run('instance', { source: ctx.componentId, parent: 'wrapper', x: 620, y: 130 }).selection[0];
        const outer = service.run('create', { id: 'wrapper', name: 'Wrapper' }).componentId;
        const p = service.run('bind', { id: 'wrapper', layer: inner, name: 'Control', propertyType: 'swap' }).property;
        const inserted = service.run('instance', { source: outer, x: 1000, y: 100 }).selection[0];
        service.run('set_property', { id: inserted, property: p.id, value: alternate });
        expect(descendants(editor.page, inserted).find(s => s.isInstanceRoot)?.componentId).toBe(alternate);
        const before = editor.doc;
        expect(() => service.run('set_property', { id: 'wrapper', property: p.id, value: outer })).toThrow(/cycle/i);
        expect(editor.doc).toBe(before);
    });
    it('retains an outer swap binding when its main default changes to another component', () => {
        const ctx = setup(), { editor, service } = ctx;
        editor.transact('Alternative and wrapper', doc => {
            const page = doc.pagesById['page-a'];
            insertShape(page, createShape('ellipse', { id: 'alternate', x: 0, y: 0, width: 20, height: 20 }));
            insertShape(page, createShape('frame', { id: 'wrapper', x: 600, y: 100, width: 300, height: 200 }));
        });
        const alternate = service.run('create', { id: 'alternate', name: 'Alternate' }).componentId;
        const nested = service.run('instance', { source: ctx.componentId, parent: 'wrapper', x: 620, y: 130 }).selection[0];
        const outer = service.run('create', { id: 'wrapper', name: 'Wrapper' }).componentId;
        const property = service.run('bind', { id: 'wrapper', layer: nested, name: 'Control', propertyType: 'swap', value: alternate }).property;
        expect(editor.page.objects[nested].componentId).toBe(alternate);
        expect(editor.page.objects[nested].componentPropertyRefs?.mainComponent).toBe(property.id);
        const inserted = service.run('instance', { source: outer, x: 1000, y: 100 }).selection[0];
        service.run('set_property', { id: inserted, property: property.id, value: ctx.componentId });
        expect(descendants(editor.page, inserted).find(s => s.isInstanceRoot)?.componentId).toBe(ctx.componentId);
        expect(editor.page.objects[nested].componentId).toBe(alternate);
        const swappedText = descendants(editor.page, inserted).find(shape => shape.type === 'text')!;
        const stableId = swappedText.id;
        editor.transact('Local swapped descendant', doc => doc.pagesById['page-a'].objects[stableId].content.children[0].children[0].text = 'Nested local override');
        editor.transact('Unrelated source paint', doc => doc.pagesById['page-a'].objects.badge.fills = [{ color: '#111188' }]);
        expect(editor.page.objects[stableId]).toBeDefined();
        expect(text(editor.page.objects[stableId])).toBe('Nested local override');
        service.run('set_property', { id: inserted, property: property.id, value: alternate });
        expect(descendants(editor.page, inserted).find(s => s.isInstanceRoot)?.componentId).toBe(alternate);
    });
    it('paginates 200 stable records and rejects invalid offsets', () => {
        const { editor, service } = setup();
        editor.transact('Catalog records', doc => {
            for (let i = 0; i < 205; i++) {
                const id = 'catalog-' + i;
                insertShape(doc.pagesById['page-a'], createShape('frame', { id: 'main-' + i, componentId: id, isMain: true, x: i * 10, y: 500, width: 5, height: 5 }));
                doc.components![id] = { id, name: 'Catalog ' + i, mainId: 'main-' + i, mainPageId: 'page-a', deleted: false };
            }
        });
        const first = service.list('catalog', 0), last = service.list('catalog', 200);
        expect(first.components).toHaveLength(200);
        expect(first.total).toBe(205);
        expect(first.nextOffset).toBe(200);
        expect(last.components).toHaveLength(5);
        expect(last.nextOffset).toBeNull();
        expect(service.list('catalog', 0)).toEqual(first);
        expect(() => service.list('', -1)).toThrow();
    });
});
