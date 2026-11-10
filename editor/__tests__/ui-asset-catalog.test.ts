// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Editor, createDocument, createShape, insertShape } from '../document';
import { createAssetService } from '../assets';
import { createCommands } from '../commands';
import { mountWorkspace } from '../ui';
import type { EditorServices } from '../contracts';

const cleanups: (() => void)[] = [];
beforeEach(() => {
    vi.stubGlobal('CSS', { escape: (s: string) => s });
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
});
afterEach(() => {
    cleanups.splice(0).reverse().forEach(fn => fn());
    document.body.replaceChildren();
    vi.restoreAllMocks(); vi.unstubAllGlobals();
});
it('resolves immutable image previews and hides retained deleted entries through Undo and redo', () => {
    const doc = createDocument(), page = doc.pagesById[doc.pages[0]];
    const src = 'omc-asset:sha256:' + 'a'.repeat(64), url = 'omc://canvas/assets/' + 'a'.repeat(64);
    doc.assets = { photo: { id: 'photo', name: 'Photo', kind: 'image', src, width: 20, height: 20 } };
    insertShape(page, createShape('image', { id: 'placed', image: { assetId: 'photo' } }));
    const editor = new Editor(doc), root = document.createElement('div');
    document.body.append(root);
    const services = { editor, assets: createAssetService(editor), resolveImageSource: (source: string) => source === src ? url : source,
        view: { element: () => null, settled: async () => {} }, fonts: { ensure: async () => {}, catalog: () => [], add() {} },
        components: { list: () => ({ components: [] }) }, styles: { list: () => [] }, libraries: { list: () => [] } } as unknown as EditorServices;
    services.commands = createCommands(editor, services);
    const workspace = mountWorkspace(root, services, { document: doc });
    cleanups.push(() => { workspace.destroy(); services.commands.destroy?.(); editor.destroy(); });
    root.querySelector<HTMLButtonElement>('.ltabs [aria-label="Assets"]')!.click();
    const preview = () => root.querySelector<HTMLImageElement>('.assets .asset-grid img');
    expect(preview()?.getAttribute('src')).toBe(url);
    services.assets.remove('photo');
    expect(editor.doc.assets.photo).toMatchObject({ deleted: true, src });
    expect(editor.page.objects.placed.image).toMatchObject({ assetId: 'photo' });
    expect(preview()).toBeNull();
    expect(editor.undoStep()).toBe(true);
    expect(preview()?.getAttribute('src')).toBe(url);
    expect(editor.redoStep()).toBe(true);
    expect(preview()).toBeNull();
});
