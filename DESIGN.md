# Oh My Canvas design system

## Source of truth
Accepted direction, 2026-11-03. Covers the desktop library, editor shell, local MCP and collaboration dialogs. The user's Figma home screenshot supplies the composition: narrow white navigation, quiet gray native chrome, a generous main area, large preview cards and compact metadata. This is an original local workspace, with its own icon and blue accent drawn from the supplied app icon.

The actual app document **Oh My Canvas UI Kit** contains an editable component board created through the installed app's MCP. Its source and readback are in `docs/design/components.html`, `canvas-components.png`, and `mcp-layout-result.json`. Implemented shell rules live in `src/style.css`; this document owns design intent. Update these together when changing the system. The user revised the color direction on 2026-11-03: follow the icon’s blue, sky and pale lavender rather than the earlier green.

## Brand
A quiet place to create. Personal ownership, clear tools, room to think. White and neutral gray carry the interface; blue signals a primary action or selection. Sky blue and pale lavender are supporting accents, used sparingly in thumbnails and collaborator identity. The supplied blue gradient icon remains the app identity. Avoid decorative dashboard graphics, promotional banners and unnecessary color.

## Product
Help a person find a local canvas quickly, design without an account, and bring an agent or up to three teammates into the open document. Success means a visible saved file, a working edit, and a clear connection state. No pretend cloud workspace, AI generation promise, community feed or subscription experience.

## People and jobs
The solo designer opens recent work or searches by name. The returning creator stars important files and chooses a dense list. A teammate uses an invitation to join an existing canvas. An agent uses local MCP to inspect and edit the open document. Local ownership is always visible.

## Information architecture
Native title strip → library/document identity → app actions. Library: My workspace, search, Recents, All canvases, Starred; content heading, Open/New actions, sort and view controls, canvas cards. Recents and All canvases currently show all files sorted by modification time; name sort is available. Starred filters actual saved preferences. Editor: layers/pages at left, editable canvas in the center, properties at right, tools near the canvas. Export, MCP and collaboration remain available in the title strip.

## Principles
Make every displayed control functional. Use whitespace before decoration. Let content previews lead. Keep metadata secondary. Keep the app usable at its minimum supported 960 × 640 window. Reveal destructive actions through a menu and explicit confirmation. Describe storage and connection outcomes truthfully.

## Visual language and tokens
IBM Plex Sans, bundled locally, with Noto Sans KR fallback. Body 13 px; metadata 11–12 px; section heading 26 px/600; dialog title 21 px. Ink `#202124`, secondary `#777777`, hairline `#e5e5e5`, surface `#f5f5f5`, white `#ffffff`, primary `#2563eb`, primary hover `#1d4ed8`, selected surface `#eff6ff`, selected ink `#1e40af`, sky `#7dd3fc`, lavender `#c4b5fd`. Keep at least 85–90% of the shell white or neutral; reserve saturated blue for actions, focus and selection. Do not fill whole panels with cyan/purple or turn every control into a gradient. Sky and lavender are decorative surfaces, with dark text. Primary blue with white text has a 5.17:1 contrast ratio. The muted color is for metadata, never the sole signal for a critical state. Main spacing uses 4/8/12/16/24/28/40 px. Sidebar 240 px (210 in compact windows). Header 52 px. Buttons 6–8 px radius; cards/dialogs 12 px. Shadows only for overlays and canvas content when helpful.

## Components and states
Preview card: neutral 215 px preview, editable document name, last edit time, star and actions. Hover changes its hairline; keyboard focus uses a blue outline. Favorite state is a filled star and `aria-pressed`. Grid/list buttons expose selected state. Search has an accessible label and empty results explain the next action. Empty library offers a blank canvas or sample. The primary button is solid blue, secondary button white with a thin border. Modal dialogs use native focus containment, Escape, a visible close control and focus restoration. Existing core persistence, validation errors and live connection states must remain intact.

## Accessibility
Use the pinned MIT Tabler Icons subset for interface controls, with a 24-unit viewBox, 18px default size and 1.75-unit stroke. Keep the supplied app brand icon unchanged. Text tools and text-layer badges use the T-shaped `letter-t` icon. Pen uses `ballpen`; freehand Pencil retains `pencil`. Do not use Unicode glyphs as drawing-tool icons; keyboard shortcut glyphs remain text. Full upstream notices and hashes live in `editor/ui/icons/tabler/`. Labeled app actions keep a 7 px icon gap; editor labeled actions use 6 px. Tool menus align icons and labels at the start with a 9 px gap, and shortcuts at the end. Close controls center their glyph in both axes. All icon-only actions have labels. Navigation uses `aria-current`, toggle actions use `aria-pressed`, search uses type search. Keep focus visible and support reduced motion. Hover-only star controls also appear on keyboard focus and compact windows. Color is supplemented by text or shape. Preserve native keyboard shortcuts and renderer text semantics. Small metadata is secondary; no essential workflow relies on it alone.

## Responsive behavior
Desktop-first Electron, minimum 960 × 640. Main content scrolls independently of navigation. Card columns adapt to available width; compact windows reduce padding and sidebar width. Dialogs fit the window with internal scrolling. Editor panels follow the existing supported compact layout; mobile is outside this app's scope.

## Interaction and content
Use concrete language: New canvas, Open file, Export, Starred. Show actual local dates and file counts. Search and sort act immediately; view and stars persist locally. Saved means persistence succeeded. A failed edit shows an actionable error. Collaboration shows host, guests, capacity, reconnecting and offline conditions. Local MCP does not remove the AI client's own costs or limits.

### Canvas naming and document access (2026-11-09)

The latest user direction replaces the separate Rename button with an inline title field. The editable **Oh My Canvas · Inline naming** document contains **States / Inline canvas title / 2026-11-09** (`2d076472-8553-4ecf-9a23-ebb97430abcc`), with the **Canvas / Editable title** main (`component-5bfa0b92-d2ec-43ad-aa6d-137634983461`) and linked example instance. It was authored in an isolated design profile to avoid changing another session's active canvas. The shareable source is `docs/design/inline-naming.html`. This supersedes the earlier separate-control board in the UI Kit.

Clicking `#document-title` reveals `#title-input` in the same header slot and selects its text. Enter or blur saves; Escape cancels. There is no separate Rename button. Keep the library heading passive. Each readable canvas retains **Actions → Rename canvas** and its focused dialog. **File → Rename canvas** opens the inline field in the editor. Trim names and limit them to 120 characters; persist before publishing. Keep the proposed name after a failed save and prevent duplicate submission. An inactive library rename does not open that canvas.

Use existing IBM Plex Sans, neutral surfaces, blue focus and spacing tokens. Compare at 1500 × 980 and the supported 960 × 640 minimum; long titles truncate in display mode while the focused field scrolls its own text. Mobile remains outside this desktop app's scope. Canvas state previews establish layout intent; runtime keyboard, blur, validation, failure and persistence behavior require separate checks.

The isolated design document was reopened in a fresh process with its board, component and linked instance intact. Real Electron comparison confirms the inline field uses the same title slot, with no extra Rename button, at desktop and minimum sizes. Enter, blur, Escape, synthetic IME composition, invalid names and restart persistence passed the workspace journey. Physical IME input and other operating systems remain unverified.

Desktop MCP adds local document discovery, creation, opening, naming and duplication plus existing-page selection. Document names and IDs are separate from page names and layer aliases. This increment still uses a single open editor; simultaneous document tabs and stable per-repository targeting require a separate lifecycle design.

### Selection and layer movement (2026-11-05)

Canvas selections show each included shape plus aggregate transform bounds. Selected layer rows remain visibly selected on hover. A 2 px blue line indicates sibling insertion; a container outline indicates insertion inside. These states reuse the existing selection colors and map to `editor/interaction/canvas.ts` and `editor/ui/index.ts` / `style.ts`.

Canvas Shift-click toggles individual membership. Layer Shift-click uses a visible-row anchor range; Ctrl/Meta-click toggles individual rows. Empty unselected frame interior supports marquee, with partial intersection selecting eligible group units. Moving layers preserves relative order and canvas geometry. Pen input has unobstructed anchors and a live next-segment preview.

### Vector precision and image cutout (2026-11-05)

The editable **Oh My Canvas UI Kit** document, page `10e6f879-40f8-4352-8d71-c6179ff89e64`, contains **States / Vector precision and image cutout / 2026-11-05**, board `f70f7827-2951-4755-8ee7-8dd484a24371`. Its three inspector mains are Vector precision (`component-d17b5666-fb02-468b-bd5c-cf20863a5a1e`), Text outlines (`component-b37807fd-cae4-4584-b9b4-4aff8af5f0c4`), and Image cutout (`component-330c7dea-bff4-40b6-91f7-5036ff835c32`). Board and mains were read back after returning to the library and reopening the document. The overview was visually reviewed without clipping.

Reuse existing inspector sections, labeled numeric fields and native selects. A selected path node exposes its world-space coordinates, node type, incoming/outgoing handle coordinates, and tangent angles and lengths. Angles are measured clockwise from world +X; zero-length handles retain the anchor until a positive length is entered. Other contours, including holes, remain independent. Outline actions create editable paths while preserving the source. Image background removal creates an alpha PNG locally on Windows, Linux and macOS and offers Restore original. Loading disables duplicate actions; errors leave source content intact and appear in the existing inspector status treatment. The board's 260 px reference panels map to `editor/ui/inspector.ts`; node selection and handles map to `editor/interaction/canvas.ts`. Existing desktop minimum size, focus and undo behavior apply. Runtime comparison evidence is tracked separately from this design reference.

## Implementation constraints
Reuse the existing editor and Electron bridge. No new UI framework or network service. Never connect a cosmetic control to fake data. Preferences are device-local and independently validated. Preserve existing library/import/new/export selectors for regression tests. Keep offline fonts and CanvasKit assets. No uploads, analytics, or external fonts.

## Open questions
Automatic host migration and NAT traversal remain future product work. External-machine routing is not visually or automatically proven by this redesign. The design document is an editable local file, not an embedded read-only screenshot.

## Reusable design-system components

The detailed reference supplied by the user supersedes the initial small component board. Deliver true main components, variants, live instances and editable properties. The dedicated **Oh My Canvas Component Library** contains 14 families / 170 variants plus connected compositions, arranged as labeled state matrices. Axes include Style, Size, State, Destination and Tone. The source generator, manifest and previews live under `docs/design/system/`; these are editable canvas objects rather than flattened screenshots.

Use the existing Assets grid and Design property controls, with discoverable Components entry, Create component, Combine variants, Insert instance and Add variant actions. Purple outlines/diamonds indicate component relationships; blue remains the product action color. Main updates must preserve instance overrides; Reset/Detach must behave distinctly. All compound component actions must be one collaborative Undo step. MCP must expose the same engine operations and remain usable in a background window.

Select triggers use flat white surfaces, an 8 px radius, 34 px compact height, right-aligned 16 px chevron, and blue focus indication. Retain native select keyboard behavior. Default, hover, focus and disabled examples belong in the detailed library; avoid macOS's raised popup-button skin in the app's library toolbar.
