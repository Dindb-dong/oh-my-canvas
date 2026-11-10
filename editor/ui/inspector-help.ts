const explanations: Record<string, string> = {
    X: 'Horizontal position on the page, in canvas units.',
    Y: 'Vertical position on the page, in canvas units.',
    W: 'Layer width, in canvas units.',
    H: 'Layer height, in canvas units.',
    Rotate: 'Clockwise rotation, in degrees.',
    Opacity: 'Layer visibility from 0 (transparent) to 1 (opaque).',
    Proportions: 'Keep the width and height ratio when resizing.',
    Hidden: 'Hide this layer from the canvas and exports.',
    Locked: 'Prevent direct selection and editing of this layer.',
    'Align horizontal center': 'Center layers along the horizontal (X) axis.',
    'Align vertical center': 'Center layers along the vertical (Y) axis.',
    'Distribute horizontally': 'Make the horizontal gaps between layers equal.',
    'Distribute vertically': 'Make the vertical gaps between layers equal.',
    'Flip horizontally': 'Mirror layers left to right.',
    'Flip vertically': 'Mirror layers top to bottom.',
    'Font size': 'Text size, in canvas units.',
    'Line height': 'Distance between text baselines.',
    'Letter spacing': 'Additional spacing between letters.',
    'Pixel snapping': 'Snap edited geometry to whole canvas units.',
    'Smart guides': 'Snap moving layers to nearby edges and centers.',
    'Clip content': 'Hide child content outside this frame.',
    'Typography:Align': 'Align text horizontally within its text box.',
    'Layout:Align': 'Align children across the main axis chosen by Direction.',
    'Stroke:Align': 'Place the stroke inside, centered on, or outside the shape edge.',
    'Layout grids:Align': 'Position the layout grid inside the frame.',
    'Typography:Style': 'Use normal or italic text.',
    'Stroke:Style': 'Choose a solid, dashed or dotted stroke.',
    'Constraints:Vertical': 'How this layer responds vertically when its parent resizes.',
    Name: 'The layer or page name shown in the document tree.',
    Blend: 'How this layer combines its colors with the content behind it.',
    Smoothing: 'Smooth the transition between straight edges and rounded corners.',
    'Choose font family': 'Choose the typeface used by the selected text.',
    Size: 'Size of the selected text or layout-grid cells, in canvas units.',
    Weight: 'Font weight; larger values produce heavier text.',
    Case: 'Change the displayed letter case without rewriting the text.',
    Letter: 'Additional spacing between letters, in canvas units.',
    Line: 'Line height; values up to 4 are multipliers, larger values are canvas units.',
    Vertical: 'Position text at the top, center or bottom of its text box.',
    Decoration: 'Add an underline or a line through the text.',
    'Line style': 'Appearance of the text decoration line.',
    Thickness: 'Thickness of the text decoration line.',
    Paragraph: 'Additional spacing after each paragraph.',
    Indent: 'Indent the first line of a paragraph.',
    List: 'Use plain paragraphs, bullet points or a numbered list.',
    Level: 'Indentation level of the list item.',
    Resize: 'Keep a fixed text box, grow its height, or hug both text dimensions.',
    Truncate: 'Cut off overflowing text with an ellipsis.',
    'Max lines': 'Maximum number of visible text lines.',
    'Leading trim': 'Trim extra space above and below the text using cap-height metrics.',
    Layout: 'Arrange children manually, with flex layout, or in a grid.',
    Direction: 'Row uses a horizontal main axis; column uses a vertical main axis. Reverse swaps the order.',
    Wrap: 'Move children onto another line when the main axis runs out of room.',
    Distribute: 'Place children along the main axis chosen by Direction.',
    Lines: 'Position wrapped lines along the cross axis.',
    columns: 'Grid column tracks: enter canvas-unit sizes or auto, separated by spaces.',
    rows: 'Grid row tracks: enter canvas-unit sizes or auto, separated by spaces.',
    'Row gap': 'Vertical spacing between layout rows.',
    'Column gap': 'Horizontal spacing between layout columns.',
    Width: 'Horizontal size or sizing rule.',
    Height: 'Vertical size or sizing rule.',
    'Min W': 'Minimum layer width.', 'Max W': 'Maximum layer width.',
    'Min H': 'Minimum layer height.', 'Max H': 'Maximum layer height.',
    'Absolute position': 'Keep this child at its explicit position instead of placing it in the parent layout.',
    Horizontal: 'How this layer responds horizontally when its parent resizes.',
    Row: 'Grid row where this child starts, counted from 1.',
    Column: 'Grid column where this child starts, counted from 1.',
    'Row span': 'Number of grid rows occupied by this child.',
    'Column span': 'Number of grid columns occupied by this child.',
    'H align': 'Place this child horizontally inside its grid cell.',
    'V align': 'Place this child vertically inside its grid cell.',
    Color: 'Choose a color.', 'Color value': 'Enter a CSS color value.',
    Alpha: 'Paint opacity from 0 (transparent) to 1 (opaque).',
    Paint: 'Use a solid color, gradient or image paint.',
    Aspect: 'Adjust the gradient proportions.',
    Stop: 'Position of this color along the gradient.',
    Dashes: 'Alternating dash and gap lengths, separated by commas.',
    Cap: 'Shape of the stroke ends.', Join: 'Shape where stroke segments meet.',
    Start: 'Marker at the start of the stroke.', End: 'Marker at the end of the stroke.',
    Blur: 'Blur radius, in canvas units.', Shadow: 'Shadow color and geometry.',
    Spread: 'Expand or contract the shadow before blurring.',
    Fit: 'How the image fits its box.', Crop: 'The image region visible inside its box.',
    Scale: 'Scale factor applied to the exported image.',
    Format: 'File type for this export.', Suffix: 'Text added to the exported filename.',
    'Omit fill on export': 'Export this frame without its background fill.',
    'Use as mask': 'Use this layer to control the visibility of masked content.',
    'Fill rule': 'How overlapping path contours determine the filled region.',
    'Mirror handles': 'How moving one curve handle affects the opposite handle.',
    'Node type': 'Use a corner, smooth tangent or symmetric curve node.',
    Points: 'Number of polygon vertices or star points.', Ratio: 'Ratio between a star’s inner and outer radius.',
    Axis: 'X measures horizontal position; Y measures vertical position.',
    Position: 'Guide position along the selected axis, in canvas units.',
    Rulers: 'Show page rulers and draggable guides.',
    Pattern: 'Show a square grid, columns or rows.',
    Count: 'Number of grid columns or rows.', Gutter: 'Space between grid columns or rows.',
    Offset: 'Distance from the frame edge to the layout grid.',
    'Fit canvas': 'Zoom and pan to show the canvas contents.',
};

/** One delegated tooltip covers controls in every dynamically rebuilt inspector section. */
export function createInspectorHelp(root: HTMLElement) {
    const abort = new AbortController(), options = { signal: abort.signal };
    const tooltip = document.createElement('div');
    tooltip.className = 'omc-inspector-tooltip';
    tooltip.id = `inspector-help-${crypto.randomUUID()}`;
    tooltip.role = 'tooltip';
    let control: HTMLElement | null = null, timer: ReturnType<typeof setTimeout> | undefined;
    let title: string | null = null, describedBy: string | null = null;
    function hide() {
        clearTimeout(timer);
        tooltip.remove();
        if (control) {
            if (title !== null) control.setAttribute('title', title);
            if (describedBy === null) control.removeAttribute('aria-describedby');
            else control.setAttribute('aria-describedby', describedBy);
        }
        control = null;
    }
    function show(target: HTMLElement, delayed: boolean) {
        if (target === control) return;
        hide();
        const label = target.getAttribute('aria-label') || target.getAttribute('title') ||
            target.closest('label')?.textContent?.trim() || target.textContent?.trim();
        if (!label) return;
        control = target;
        title = target.getAttribute('title');
        describedBy = target.getAttribute('aria-describedby');
        // Suppress a second, native title popup while the contextual help is active.
        target.removeAttribute('title');
        const display = () => {
            if (!target.isConnected) { hide(); return; }
            const section = target.closest('section')?.querySelector('h3')?.textContent?.trim();
            const contextual = (title && title !== label ? title : undefined) ?? explanations[`${section}:${label}`] ?? explanations[label] ??
                (label.startsWith('Pad ') ? 'Inner spacing on this side of the layout container.' :
                label.startsWith('R ') ? 'Corner radius, in canvas units.' : undefined);
            tooltip.textContent = contextual ? `${label} — ${contextual}` :
                section ? `${section} · ${label}` : label;
            target.setAttribute('aria-describedby', [describedBy, tooltip.id].filter(Boolean).join(' '));
            document.body.append(tooltip);
            const rect = target.getBoundingClientRect(), box = tooltip.getBoundingClientRect();
            tooltip.style.left = `${Math.max(8, Math.min(rect.right - box.width, innerWidth - box.width - 8))}px`;
            tooltip.style.top = `${Math.max(8, rect.top >= box.height + 12 ? rect.top - box.height - 8 : Math.min(rect.bottom + 8, innerHeight - box.height - 8))}px`;
        };
        if (delayed) timer = setTimeout(display, 450);
        else display();
    }
    const target = (event: Event) => {
        const hit = event.target instanceof Element ? event.target : null;
        const node = hit?.closest<HTMLElement>('button,input,select,textarea,[role="button"]') ?? hit?.closest('label')?.querySelector<HTMLElement>('input,select,textarea');
        return node && root.contains(node) ? node : null;
    };
    root.addEventListener('pointerover', event => { const node = target(event); if (node) show(node, true); }, options);
    root.addEventListener('pointerout', event => {
        if (control && (!(event.relatedTarget instanceof Node) || !control.contains(event.relatedTarget))) hide();
    }, options);
    root.addEventListener('focusin', event => { const node = target(event); if (node) { hide(); show(node, false); } }, options);
    root.addEventListener('focusout', hide, options);
    root.addEventListener('pointerdown', hide, options);
    root.addEventListener('input', hide, options);
    root.addEventListener('change', hide, options);
    root.addEventListener('scroll', hide, { ...options, capture: true });
    window.addEventListener('keydown', event => {
        if (event.key === 'Escape' && control) { event.preventDefault(); event.stopPropagation(); hide(); }
    }, { ...options, capture: true });
    return { hide, destroy() { hide(); abort.abort(); } };
}
