/** Browser-only pixel oracle: a live translated scene versus the existing full
 * SVG export at the same logical camera, without changing production options. */
import { Editor, createDocument, createShape, insertShape } from '../document';
import { createRenderer } from '../render';
import { createCanvasInteraction } from '../interaction/canvas';
import type { Data, EditorServices } from '../contracts';

let state: { editor: Editor; view: ReturnType<typeof createRenderer>; interaction: ReturnType<typeof createCanvasInteraction>; stage: HTMLElement; direct: HTMLElement; overlay: HTMLElement } | undefined;
const frames = () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));

export async function setup() {
    const doc = createDocument(), page = doc.pagesById[doc.pages[0]];
    const bitmap = document.createElement('canvas'); bitmap.width = bitmap.height = 8;
    const context = bitmap.getContext('2d')!; context.fillStyle = '#08a6ae'; context.fillRect(0, 0, 8, 8); context.fillStyle = '#f7d24c'; context.fillRect(0, 0, 4, 4); context.fillRect(4, 4, 4, 4);
    doc.assets = { picture: { id: 'picture', kind: 'image', src: bitmap.toDataURL(), name: 'Checker' } };
    const specs: Data[] = [
        { id: 'board', type: 'frame', x: -100, y: -100, width: 1500, height: 1100, fills: [{ color: '#fff' }], clipContent: true, blendMode: 'normal' },
        { id: 'clip', type: 'frame', parentId: 'board', x: 50, y: 40, width: 170, height: 130, rotation: 12, clipContent: true, fills: [{ color: '#dde8f3' }] },
        { id: 'overflow', parentId: 'clip', x: 10, y: 10, width: 280, height: 220, fills: [{ type: 'linear', gradient: { type: 'linear', stops: [{ offset: 0, color: '#d62278' }, { offset: 1, color: '#4e40db' }] } }] },
        { id: 'masked', type: 'group', parentId: 'board', x: 300, y: 50, width: 200, height: 190, isMaskGroup: true, maskType: 'alpha' },
        { id: 'mask', type: 'ellipse', parentId: 'masked', x: 315, y: 65, width: 150, height: 150, fills: [{ color: '#fff', opacity: .8 }] },
        { id: 'picture', type: 'image', parentId: 'masked', x: 280, y: 40, width: 240, height: 220, image: { assetId: 'picture', width: 8, height: 8 } },
        { id: 'shadow', parentId: 'board', x: 90, y: 250, width: 170, height: 90, radius: 20, fills: [{ color: '#246a98' }], shadows: [{ offsetX: 45, offsetY: 20, blur: 48, color: '#071932', opacity: .7 }] },
        { id: 'blur', parentId: 'board', x: 420, y: 250, width: 150, height: 100, fills: [{ color: '#ff8f19' }], blur: 14 },
        { id: 'outside-shadow', parentId: 'board', x: -80, y: 230, width: 40, height: 80, fills: [{ color: '#6b254f' }], shadows: [{ offsetX: 70, offsetY: 0, blur: 20, color: '#6b254f', opacity: 1 }] },
        { id: 'label', type: 'text', parentId: 'board', x: 80, y: 390, width: 520, height: 100, autoResize: 'none', fontFamily: 'Arial', fontSize: 28, content: 'Viewport text Ω 123\nClipping, masks and shadows' },
        { id: 'edge-picture', type: 'image', parentId: 'board', x: 730, y: 100, width: 150, height: 170, image: { assetId: 'picture', width: 8, height: 8 } },
        { id: 'blend-base', parentId: 'board', x: 600, y: 80, width: 90, height: 120, fills: [{ color: '#3da4d9' }] },
        { id: 'nested-blend', parentId: 'board', x: 630, y: 100, width: 90, height: 120, fills: [{ color: '#e0696c' }], blendMode: 'multiply', opacity: .7 },
        { id: 'far', parentId: 'board', x: 900, y: 430, width: 180, height: 160, fills: [{ color: '#477c3d' }], strokes: [{ color: '#142c10', width: 12, align: 'outside' }] },
        { id: 'curve', type: 'path', parentId: 'board', x: 660, y: 350, width: 240, height: 100, fills: [], strokes: [{ color: '#273694', width: 8 }], content: [{ command: 'move', x: 660, y: 400 }, { command: 'curve', x1: 730, y1: 260, x2: 830, y2: 530, x: 900, y: 360 }] }
    ];
    for (const spec of specs) insertShape(page, createShape(spec.type ?? 'rect', spec));
    for (let i = 0; i < 520; i++) insertShape(page, createShape('rect', { id: 'offscreen-' + i, x: 50000 + i * 1000 }));
    const stage = document.createElement('div'); stage.id = 'viewport-motion-oracle';
    stage.style.cssText = 'position:fixed;left:0;top:0;width:800px;height:601px;background:#e5e7eb;overflow:hidden;z-index:2147483647;isolation:isolate';
    document.body.append(stage);
    const editor = new Editor(doc); editor.setViewport({ zoom: 1, vport: { width: 800, height: 601 }, vbox: { x: 0, y: 0, width: 800, height: 601 } });
    const view = createRenderer(editor, stage, { defaultFamily: 'Arial', fallbacks: ['sans-serif'] });
    const direct = document.createElement('div'); direct.style.cssText = 'position:absolute;inset:0;overflow:visible;display:none'; stage.append(direct);
    const overlay = document.createElement('div'); overlay.style.cssText = 'position:absolute;inset:0;pointer-events:none;display:none'; stage.append(overlay);
    const interaction = createCanvasInteraction(stage, overlay, { editor, view } as unknown as EditorServices, { active: false, exit: async () => {} } as any, { context() {}, changed() {}, importFiles: async () => {} });
    state = { editor, view, interaction, stage, direct, overlay };
    await view.settled(); await frames();
    return { objects: Object.keys(editor.page.objects).length, diagnostics: view.renderDiagnostics() };
}

export async function render(input: { x: number; y: number; zoom: number; width: number; height: number; direct: boolean; rootBlend?: string }) {
    const { editor, view, stage, direct } = state!;
    const blend = input.rootBlend ?? 'normal';
    if (editor.page.objects.board.blendMode !== blend) editor.transact('Fixture root blend', doc => { doc.pagesById[editor.pageId].objects.board.blendMode = blend; });
    stage.style.width = input.width + 'px'; stage.style.height = input.height + 'px';
    const bounds = { x: input.x, y: input.y, width: input.width / input.zoom, height: input.height / input.zoom };
    editor.setViewport({ zoom: input.zoom, vport: { width: input.width, height: input.height }, vbox: bounds });
    await view.settled();
    const scene = stage.querySelector<HTMLElement>('.canvas-scene')!;
    if (input.direct) {
        direct.innerHTML = view.sceneSvg(undefined, { bounds });
        const svg = direct.firstElementChild as SVGSVGElement;
        Object.assign(svg.style, { width: '100%', height: '100%', overflow: 'visible' });
        svg.setAttribute('preserveAspectRatio', 'none');
        scene.style.display = 'none'; direct.style.display = '';
    } else { scene.style.display = ''; direct.style.display = 'none'; }
    await frames();
    return { viewport: editor.viewport, diagnostics: view.renderDiagnostics() };
}

export function hit(world: { x: number; y: number }) {
    const { interaction } = state!, screen = interaction.screen(world), roundTrip = interaction.world(screen);
    return { hit: interaction.hit(world, true)?.id, screen, roundTrip };
}
export function destroy() { state?.interaction.destroy(); state?.view.destroy(); state?.editor.destroy(); state?.stage.remove(); state = undefined; }
