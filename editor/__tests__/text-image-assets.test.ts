// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { Editor, createDocument, createShape, insertShape } from '../document';
import { createRenderer } from '../render';
import { SceneWriter, textHTML, type TextFragment } from '../render/scene';
import * as text from '../render/text';
import type { Data } from '../contracts';

vi.mock('../export/raster', () => ({ inlineSVGImages: async (source: string) => source }));
const hash = 'a'.repeat(64), source = 'omc-asset:sha256:' + hash, url = 'omc://canvas/assets/' + hash;
const resolveImageSource = (value: string) => value.startsWith('omc-asset:sha256:') ? 'omc://canvas/assets/' + value.slice(-64) : value;
const assets = { picture: { id: 'picture', kind: 'image', src: source } };
const cleanup: (() => void)[] = [];
afterEach(() => { cleanup.splice(0).reverse().forEach(fn => fn()); document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function painted(image: Data) {
    return createShape('text', { id: 'painted', width: 100, height: 30, content: { children: [{ children: [{ text: 'Image paint', fills: [{ image }] }] }] } });
}

it('resolves image asset IDs and direct canonical sources in rich text CSS and SVG fallback', () => {
    for (const image of [{ assetId: 'picture' }, { src: source }, { id: source }]) {
        const shape = painted(image), options = { assets, resolveImageSource };
        const html = textHTML(shape, options), svg = new SceneWriter({ painted: shape }, options).svg(['painted'], shape);
        for (const result of [html, svg]) {
            expect(result).toContain(url);
            expect(result).not.toContain('url(undefined)');
            expect(result).not.toContain('background-image:url(&quot;omc-asset:');
        }
    }
    const missing = textHTML(painted({ assetId: 'missing' }), { assets, resolveImageSource });
    expect(missing).toContain('background-image:none'); expect(missing).not.toContain('url(undefined)');
});

it('preserves inline images and image/solid paint order through text CSS resolution', () => {
    const inline = 'data:image/png;base64,AQID', shape = painted({ src: inline });
    shape.content.children[0].children[0].fills.push({ color: '#123456' });
    const html = textHTML(shape, { assets, resolveImageSource });
    expect(html).toContain(inline); expect(html).not.toContain('url(undefined)');
    // CSS paints are reversed to preserve the existing SVG compositing order.
    expect(html.indexOf('data:image/svg+xml,')).toBeLessThan(html.indexOf('background-image') + html.slice(html.indexOf('background-image')).indexOf(inline));
});

it('passes current assets and the URL resolver into screen and component thumbnail text measurement', async () => {
    vi.stubGlobal('CSS', { escape: (id: string) => id });
    Object.defineProperty(document, 'fonts', { configurable: true, value: Object.assign(new EventTarget(), { ready: Promise.resolve() }) });
    const measuredHTML: string[] = [];
    // Deterministic glyph boxes isolate asset propagation from native text layout.
    const measure = vi.spyOn(text, 'measureTextScene').mockImplementation((objects, _holder, options = {}) => ({
        fragments: new Map(Object.values(objects).filter(shape => shape.type === 'text').map(shape => {
            measuredHTML.push(textHTML(shape, options));
            const run = shape.content.children[0].children[0];
            return [shape.id, [{ text: run.text, x: shape.x, y: shape.y, width: 100, height: 30, baseline: shape.y + 20, paragraph: 0, style: {
                color: '#000000', fontFamily: 'sans-serif', fontSize: '20px', fontWeight: '400', fontStyle: 'normal', letterSpacing: '0px', paints: JSON.stringify(run.fills)
            } }] as TextFragment[]];
        })),
        textSizes: new Map()
    }));
    const doc = createDocument(); doc.assets = assets; insertShape(doc.pagesById[doc.pages[0]], painted({ assetId: 'picture' }));
    const editor = new Editor(doc), stage = document.createElement('div'); document.body.append(stage);
    const view = createRenderer(editor, stage, { resolveImageSource }); cleanup.push(() => editor.destroy(), () => view.destroy());
    expect(measuredHTML[0]).toContain(url); expect(stage.querySelector('pattern image')?.getAttribute('href')).toBe(url);
    measure.mockClear(); measuredHTML.length = 0;
    const thumbnail = await view.thumbnailSvg!(editor.pageId, 'painted');
    expect(measuredHTML).toHaveLength(1); expect(measuredHTML[0]).toContain(url); expect(thumbnail).toContain(url);
    const replacement = 'omc-asset:sha256:' + 'b'.repeat(64);
    editor.transact('Replace bitmap', draft => { draft.assets.picture.src = replacement; });
    measuredHTML.length = 0;
    const next = await view.thumbnailSvg!(editor.pageId, 'painted');
    expect(measuredHTML[0]).toContain(resolveImageSource(replacement)); expect(next).toContain(resolveImageSource(replacement));
    expect(next).not.toContain(url);
});
