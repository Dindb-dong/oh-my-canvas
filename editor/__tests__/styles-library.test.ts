/** Fresh independent synthetic regressions, authored after barrier f86e063. No inherited test inputs. */
import { describe, it, expect } from 'vitest';
import { Editor, createDocument, createPage, createShape, insertShape, descendants } from '../document';
import { createComponentService, reconcileComponents } from '../components';
import { createStyleService, reconcileStyles } from '../styles';
import { createAssetService, createLibraryService, normalizeLibraries, reconcileLibraries, type LibrarySnapshot } from '../assets';
import type { CanvasDocument, Data, Shape } from '../contracts';
function mount(doc: CanvasDocument) {
    normalizeLibraries(doc);
    const editor = new Editor(doc, { reconcile(before, draft) {
            reconcileLibraries(before, draft);
            reconcileComponents(before, draft);
            reconcileStyles(before, draft);
        } });
    return { editor, styles: createStyleService(editor), libraries: createLibraryService(editor), components: createComponentService(editor), assets: createAssetService(editor) };
}
function setup() {
    const doc = createDocument({ pageId: 'a' });
    doc.pages.push('b');
    doc.pagesById.b = createPage('B', 'b');
    insertShape(doc.pagesById.a, createShape('rect', { id: 'one', width: 40, height: 30 }));
    insertShape(doc.pagesById.b, createShape('rect', { id: 'two', width: 40, height: 30 }));
    insertShape(doc.pagesById.a, createShape('text', { id: 'words', x: 0, y: 100, width: 100, height: 30, content: { type: 'richText', children: [{ children: [{ text: 'Alpha', fontSize: 12, fills: [{ color: '#123456' }] }, { text: ' beta', fontSize: 18, fills: [{ color: '#654321' }] }] }] } }));
    return mount(doc);
}
function snapshot(version = 1): LibrarySnapshot {
    const main = createShape('frame', { id: 'button-main', name: 'Normal', x: 10, y: 20, width: 120, height: 40, childIds: ['button-label'], componentId: 'button', isMain: true, isInstanceRoot: true, fillStyleId: 'brand', fills: [{ color: '#336699' }] });
    const label = createShape('text', { id: 'button-label', name: 'Label', parentId: 'button-main', enclosingFrameId: 'button-main', x: 20, y: 30, width: 80, height: 20, componentPropertyRefs: { characters: 'title-property' }, content: { type: 'richText', children: [{ children: [{ text: 'Library title', fontSize: 14, textStyleId: 'body', fillStyleId: 'brand', fills: [{ color: '#336699' }] }] }] } });
    const result:LibrarySnapshot={ id: 'kit', name: 'Offline UI Kit', version, enabled: true, components: { button: { id: 'button', name: 'State=Normal', mainId: main.id, variantSetId: 'buttons', variantProperties: [{ name: 'State', value: 'Normal' }], properties: [{ id: 'title-property', name: 'Title', type: 'text', default: 'Library title' }] } }, objects: { [main.id]: main, [label.id]: label }, styles: { brand: { id: 'brand', name: 'Colors/Brand', type: 'paint', paints: [{ color: '#336699' }] }, body: { id: 'body', name: 'Type/Body', type: 'text', text: { fontSize: 14, fontWeight: 400, lineHeight: 20 } }, unused: { id: 'unused', name: 'Colors/Unused', type: 'paint', paints: [{ color: '#ffff00' }] } }, variantSets: { buttons: { id: 'buttons', name: 'Button' } } };
    const pressed=createShape('frame',{...main,id:'button-pressed',name:'Pressed',componentId:'pressed',x:180,childIds:['label-pressed']});const pressedLabel=createShape('text',{...label,id:'label-pressed',parentId:pressed.id,enclosingFrameId:pressed.id,x:190});result.objects[pressed.id]=pressed;result.objects[pressedLabel.id]=pressedLabel;result.components.pressed={...structuredClone(result.components.button),id:'pressed',name:'State=Pressed',mainId:pressed.id,variantProperties:[{name:'State',value:'Pressed'}]};return result;
}
function chars(s: Shape) {
    return s.content.children.map((p: Data) => p.children.map((r: Data) => r.text).join('')).join('\n');
}
function nestedLabel(editor: Editor, root: string) {
    return descendants(editor.page, root).find(s => s.type === 'text')!;
}
describe('local styles resolve references without erasing explicit content', () => {
    it('creates/renames/describes/slash-groups paint styles and updates all pages in one operation', () => {
        const { editor, styles } = setup();
        const style = styles.create('paint', 'Colors/Primary', [{ color: '#ff0000' }]);
        styles.apply(style.id, ['one', 'two']);
        styles.rename(style.id, 'Colors/Action');
        styles.update(style.id, { description: 'Primary action' });
        const events: any[] = [];
        editor.on(e => {
            if (e.changes)
                events.push(e);
        });
        styles.update(style.id, { paints: [{ color: '#00ff00' }] });
        expect(editor.doc.pagesById.a.objects.one.fills).toEqual([{ color: '#00ff00' }]);
        expect(editor.doc.pagesById.b.objects.two.fills).toEqual([{ color: '#00ff00' }]);
        expect(events).toHaveLength(1);
        expect(styles.list('action')[0]).toMatchObject({ name: 'Colors/Action', description: 'Primary action' });
        expect(styles.users(style.id)).toEqual([{ pageId: 'a', id: 'one' }, { pageId: 'b', id: 'two' }]);
    });
    it('preserves explicit paint overrides on one user while updating another', () => {
        const { editor, styles } = setup(), style = styles.create('paint', 'Brand', [{ color: '#ff0000' }]);
        styles.apply(style.id, ['one', 'two']);
        editor.transact('Local override', doc => doc.pagesById.b.objects.two.fills = [{ color: '#0000ff' }]);
        styles.update(style.id, { paints: [{ color: '#00ff00' }] });
        expect(editor.doc.pagesById.a.objects.one.fills).toEqual([{ color: '#00ff00' }]);
        expect(editor.doc.pagesById.b.objects.two.fills).toEqual([{ color: '#0000ff' }]);
        expect(editor.doc.pagesById.b.objects.two.fillStyleId).toBe(style.id);
    });
    it('applies independent text/paint refs to rich runs and never copies characters from style payloads', () => {
        const { editor, styles } = setup(), font = styles.create('text', 'Type/Body', { fontSize: 24, fontWeight: 700, lineHeight: 30, text: 'Do not insert', fills: [{ color: '#badbad' }] }), paint = styles.create('paint', 'Color/Text', [{ color: '#ff8800' }]);
        styles.apply(font.id, ['words']);
        styles.apply(paint.id, ['words']);
        let shape = editor.page.objects.words;
        expect(chars(shape)).toBe('Alpha beta');
        for (const run of shape.content.children[0].children) {
            expect(run).toMatchObject({ fontSize: 24, fontWeight: 700, textStyleId: font.id, fillStyleId: paint.id });
            expect(run.fills).toEqual([{ color: '#ff8800' }]);
        }
        editor.transact('Run typography override', doc => doc.pagesById.a.objects.words.content.children[0].children[1].fontSize = 40);
        styles.update(font.id, { text: { fontSize: 28, fontWeight: 500, lineHeight: 34 } });
        shape = editor.page.objects.words;
        expect(shape.content.children[0].children.map((r: Data) => r.fontSize)).toEqual([28, 40]);
        expect(chars(shape)).toBe('Alpha beta');
        styles.detach(['words'], 'text');
        expect(shape.fillStyleId).toBe(paint.id);
        expect(editor.page.objects.words.content.children[0].children[0].textStyleId).toBeUndefined();
        expect(editor.page.objects.words.content.children[0].children[0].fillStyleId).toBe(paint.id);
    });
    it('syncs effect fields separately and remove/detach preserve rendered values', () => {
        const { editor, styles } = setup();
        const style = styles.create('effect', 'Effects/Card', { shadows: [{ style: 'drop', offsetX: 0, offsetY: 3, blur: 5, spread: 0, color: '#000000' }], blur: 1, backgroundBlur: 2 });
        styles.apply(style.id, ['one', 'two']);
        editor.transact('Override layer blur', doc => doc.pagesById.a.objects.one.blur = 9);
        styles.update(style.id, { effects: { shadows: [], blur: 4, backgroundBlur: 6 } });
        expect(editor.doc.pagesById.a.objects.one).toMatchObject({ blur: 9, backgroundBlur: 6, shadows: [] });
        expect(editor.doc.pagesById.b.objects.two.blur).toBe(4);
        styles.detach(['one'], 'effect');
        styles.remove(style.id);
        expect(editor.doc.pagesById.a.objects.one.blur).toBe(9);
        expect(editor.doc.pagesById.b.objects.two.blur).toBe(4);
        expect(editor.doc.pagesById.b.objects.two.effectStyleId).toBeUndefined();
    });
    it('rejects invalid style kinds/values and rolls back an apply to missing targets', () => {
        const { editor, styles } = setup();
        expect(() => styles.create('paint', 'Invalid', {})).toThrow(/array/);
        const style = styles.create('paint', 'Brand', [{ color: '#123456' }]);
        const before = editor.doc;
        expect(() => styles.apply(style.id, ['one', 'missing'])).toThrow(/Unknown shape/);
        expect(editor.doc).toBe(before);
        expect(() => styles.apply(style.id, ['one'], 'text')).toThrow(/Incompatible/);
        expect(editor.doc).toBe(before);
    });
});
describe('offline library snapshots and local assets', () => {
    it('links editable source objects, one family tile and inserts the first variant', () => {
        const { editor, libraries, assets } = setup();
        libraries.add(snapshot());
        const rows = assets.list();
        expect(rows).toHaveLength(1);
        expect(rows[0].variants).toHaveLength(2);
        const result = assets.insert(rows[0].id, { x: 400, y: 200 });
        const shape = editor.page.objects[result.selection[0]];
        expect(shape).toMatchObject({ isInstanceRoot: true, x: 400, y: 200, width: 120, height: 40 });
        expect(chars(nestedLabel(editor, shape.id))).toBe('Library title');
        expect(editor.doc.pagesById['library-page:kit'].objects['library:kit:buttons']).toMatchObject({ isVariantSet: true, name: 'Button' });
    });
    it('disables availability while preserving existing instances and styles actually used outside source pages', () => {
        const { editor, libraries, assets, components, styles } = setup();
        libraries.add(snapshot());
        const inserted = libraries.insert('kit', 'button', { x: 400, y: 200 }).selection[0];
        libraries.enable('kit', false);
        expect(components.list().components).toHaveLength(0);
        expect(assets.list().filter((r: Data) => r.componentId)).toHaveLength(0);
        expect(styles.list().map((s: Data) => s.id).sort()).toEqual(['library:kit:body', 'library:kit:brand']);
        expect(chars(nestedLabel(editor, inserted))).toBe('Library title');
        expect(() => libraries.insert('kit', 'button')).toThrow(/disabled/);
        expect(() => components.run('instance', { source: 'library:kit:button' })).toThrow(/disabled/);
        libraries.enable('kit', true);
        expect(components.list().components).toHaveLength(2);
        expect(styles.list()).toHaveLength(3);
    });
    it('updates geometry and styles once while preserving instance text/paint overrides', () => {
        const { editor, libraries, components } = setup();
        libraries.add(snapshot());
        const inserted = libraries.insert('kit', 'button', { x: 400, y: 200 }).selection[0];
        components.run('set_property', { id: inserted, property: 'title-property', value: 'Custom title' });
        editor.transact('Instance paint override', doc => doc.pagesById.a.objects[inserted].fills = [{ color: '#222222' }]);
        const next = snapshot(2);
        next.objects['button-main'].width = 160;
        next.styles.brand.paints = [{ color: '#00aa00' }];
        next.objects['button-main'].fills = [{ color: '#00aa00' }];
        next.objects['button-label'].content.children[0].children[0].text = 'New source';
        next.components.button.properties[0].default = 'New source';
        const events: any[] = [];
        editor.on(e => {
            if (e.changes)
                events.push(e);
        });
        libraries.update('kit', next);
        expect(events).toHaveLength(1);
        expect(editor.page.objects[inserted]).toMatchObject({ width: 160, x: 400, y: 200 });
        expect(editor.page.objects[inserted].fills).toEqual([{ color: '#222222' }]);
        expect(chars(nestedLabel(editor, inserted))).toBe('Custom title');
        expect(nestedLabel(editor, inserted).content.children[0].children[0].fills).toEqual([{ color: '#00aa00' }]);
        expect(editor.doc.libraries!.kit.version).toBe(2);
    });
    it('permits additive properties but rejects incompatible property/style updates without partial changes', () => {
        const { editor, libraries } = setup();
        libraries.add(snapshot());
        const additive = snapshot(2);
        additive.components.button.properties.push({ id: 'show', name: 'Show', type: 'boolean', default: true });
        libraries.update('kit', additive);
        const before = editor.doc;
        const bad = snapshot(3);
        bad.components.button.properties[0].type = 'boolean';
        expect(() => libraries.update('kit', bad)).toThrow(/Incompatible/);
        expect(editor.doc).toBe(before);
        const badStyle = structuredClone(additive);
        badStyle.styles.brand.type = 'text';
        expect(() => libraries.update('kit', badStyle)).toThrow(/Incompatible/);
        expect(editor.doc).toBe(before);
    });
    it('hydrates legacy raw component/style IDs from snapshots offline and survives JSON reopen', () => {
        const doc = createDocument({ pageId: 'a' });
        doc.libraries = { kit: snapshot() };
        const p = doc.pagesById.a;
        insertShape(p, createShape('frame', { id: 'offline', componentId: 'button', sourceId: 'button-main', isInstanceRoot: true, x: 400, y: 200, width: 120, height: 40, fillStyleId: 'brand' }));
        insertShape(p, createShape('text', { id: 'offline-label', sourceId: 'button-label', x: 410, y: 210, width: 80, height: 20, content: { type: 'richText', children: [{ children: [{ text: 'Library title', fontSize: 14, textStyleId: 'body', fillStyleId: 'brand' }] }] } }), 'offline');
        const { editor } = mount(doc);
        expect(editor.page.objects.offline.componentId).toBe('library:kit:button');
        expect(editor.page.objects['offline-label'].sourceId).toBe('library:kit:button-label');
        expect(editor.page.objects['offline-label'].content.children[0].children[0].textStyleId).toBe('library:kit:body');
        const reopened = mount(JSON.parse(JSON.stringify(editor.doc)));
        reopened.editor.transact('Source change after offline reopen', draft => draft.pagesById['library-page:kit'].objects['library:kit:button-label'].content.children[0].children[0].text = 'Reopened');
        expect(chars(reopened.editor.page.objects['offline-label'])).toBe('Reopened');
    });
    it('unlinks the snapshot while retaining editable local definitions and linked users', () => {
        const { editor, libraries, components } = setup();
        libraries.add(snapshot());
        const inserted = libraries.insert('kit', 'button', { x: 400, y: 200 }).selection[0];
        libraries.remove('kit');
        expect(editor.doc.libraries!.kit).toBeUndefined();
        expect(editor.doc.components!['library:kit:button'].libraryId).toBeUndefined();
        expect(components.list().components).toHaveLength(2);
        editor.transact('Edit unlinked local main', doc => doc.pagesById['library-page:kit'].objects['library:kit:button-main'].width = 180);
        expect(editor.page.objects[inserted].width).toBe(180);
    });
    it('persists local asset metadata and places/removes images without claiming font placement', () => {
        const { editor, assets } = setup();
        const asset = assets.addFile({ name: 'Pixel', src: 'data:image/png;base64,AA==', width: 2, height: 3, mimeType: 'image/png' });
        const result = assets.place(asset.id, { x: 42, y: 73 });
        expect(editor.page.objects[result.selection[0]]).toMatchObject({ type: 'image', x: 42, y: 73, width: 2, height: 3, image: { src: 'data:image/png;base64,AA==' } });
        expect(assets.list('pixel')).toHaveLength(1);
        assets.remove(asset.id);
        expect(editor.page.objects[result.selection[0]].image.src).toBe('data:image/png;base64,AA==');
        const font = assets.addFile({ name: 'Font', src: 'data:font/woff2;base64,AA==', kind: 'font' });
        expect(() => assets.place(font.id)).toThrow(/font catalog/);
        expect(() => assets.addFile({ name: 'Unsafe', src: 'javascript:alert(1)' })).toThrow(/Unsupported/);
    });
});
