# Oh My Canvas design system

## Source of truth
Accepted direction, 2026-11-03. Covers the desktop library, editor shell, local MCP and collaboration dialogs. The user's Figma home screenshot supplies the composition: narrow white navigation, quiet gray native chrome, a generous main area, large preview cards and compact metadata. This is an original local workspace, with its own icon and blue accent drawn from the supplied app icon.

The actual app document **Oh My Canvas UI Kit** contains an editable component board created through the installed app's MCP. Its source and readback are in `docs/design/components.html`, `canvas-components.png`, and `mcp-layout-result.json`. Implemented shell rules live in `src/style.css`; this document owns design intent. Update these together when changing the system. The user revised the color direction on 2026-11-03: follow the icon’s blue, sky and pale lavender rather than the earlier green.

## Brand
A quiet place to create. Personal ownership, clear tools, room to think. White and neutral gray carry the interface; blue signals a primary action or selection. Sky blue and pale lavender are supporting accents, used sparingly in thumbnails and collaborator identity. The supplied blue gradient icon remains the app identity. Avoid decorative dashboard graphics, promotional banners and unnecessary color.

## Product
Help a person find a local canvas quickly, design without an account, and bring an agent or up to three teammates into the open document. Success means a visible saved file, a working edit, and a clear connection state. No pretend cloud workspace, AI generation promise, community feed or subscription experience.

## People and jobs
The solo designer opens recent work or searches by name. The returning creator stars important files and chooses a dense list. A teammate uses an invitation to join an existing canvas. An agent uses local MCP to inspect and edit an explicitly identified document, independently of the visible tab. Local ownership is always visible.

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

Desktop MCP adds local document discovery, creation, opening, naming and duplication plus existing-page selection. Document names and IDs are separate from page names and layer aliases. Document mutations require an explicit stable document ID; reads may use the session binding. Opening or focusing another document preserves existing sessions.

### Multiple document tabs (2026-11-09)

The isolated **Oh My Canvas · Inline naming** design document contains **States / Multiple document tabs / 2026-11-09** (`31314c67-1211-4a8e-8741-77d92ddf80e8`), the **Canvas / Document tab** main (`component-042d59c8-753a-4d8c-b206-cd6c893ba922`) and linked instance (`component-c341b76b-9130-487e-bd9f-a1e2b29467fa`). Its shareable editable source is `docs/design/document-tabs.html`. It was reopened before implementation without touching the installed user's active document.

A 40 px shell tab strip stays above the library and document editors. **Your canvases** opens the library, each canvas tab selects its retained editor, and the plus control creates a blank canvas. Keep native traffic-light clearance, neutral chrome and the existing blue selected underline. Long names truncate with a full title tooltip. Close has a separate labeled button. Tab buttons use a roving focus position and Left/Right/Home/End keyboard selection; overflow scrolls horizontally at the 960 px minimum width.

Closing a tab flushes that document. Agents and collaborators can keep it running in the background, with an **Active** marker on open tabs and activity text in the library. MCP navigation defaults to background operation; only explicit focus changes reveal a document. The inline title stays inside each document header. Every editor has an isolated document runtime so typing, selection, page and tool state survive UI tab changes. A failure must identify its document and preserve other work.

### Selection and layer movement (2026-11-05)

Canvas selections show each included shape plus aggregate transform bounds. Selected layer rows remain visibly selected on hover. A 2 px blue line indicates sibling insertion; a container outline indicates insertion inside. These states reuse the existing selection colors and map to `editor/interaction/canvas.ts` and `editor/ui/index.ts` / `style.ts`.

Canvas Shift-click toggles individual membership. Layer Shift-click uses a visible-row anchor range; Ctrl/Meta-click toggles individual rows. Empty unselected frame interior supports marquee, with partial intersection selecting eligible group units. Moving layers preserves relative order and canvas geometry. Pen input has unobstructed anchors and a live next-segment preview.

### Vector precision and image cutout (2026-11-05)

The editable **Oh My Canvas UI Kit** document, page `10e6f879-40f8-4352-8d71-c6179ff89e64`, contains **States / Vector precision and image cutout / 2026-11-05**, board `f70f7827-2951-4755-8ee7-8dd484a24371`. Its three inspector mains are Vector precision (`component-d17b5666-fb02-468b-bd5c-cf20863a5a1e`), Text outlines (`component-b37807fd-cae4-4584-b9b4-4aff8af5f0c4`), and Image cutout (`component-330c7dea-bff4-40b6-91f7-5036ff835c32`). Board and mains were read back after returning to the library and reopening the document. The overview was visually reviewed without clipping.

Reuse existing inspector sections, labeled numeric fields and native selects. A selected path node exposes its world-space coordinates, node type, incoming/outgoing handle coordinates, and tangent angles and lengths. Angles are measured clockwise from world +X; zero-length handles retain the anchor until a positive length is entered. Other contours, including holes, remain independent. Outline actions create editable paths while preserving the source. Image background removal creates an alpha PNG locally on Windows, Linux and macOS and offers Restore original. Loading disables duplicate actions; errors leave source content intact and appear in the existing inspector status treatment. The board's 260 px reference panels map to `editor/ui/inspector.ts`; node selection and handles map to `editor/interaction/canvas.ts`. Existing desktop minimum size, focus and undo behavior apply. Runtime comparison evidence is tracked separately from this design reference.

### Inspector axes and help (2026-11-10)

The editable **Oh My Canvas UI Kit** document contains **States / Inspector axis labels and help / 2026-11-10**, board `c03405dd-bb63-4855-959d-acbe4648e2f7`, and the **Inspector / Alignment help** main `component-86a2fd41-9380-415c-b823-a7c89a27f3ea`. The board and component were saved and read back before implementation.

Separate layer alignment into **Horizontal (X)** (left/center/right) and **Vertical (Y)** (top/middle/bottom). Keep existing Tabler icons and command semantics. Label distribution and flip controls by direction. Reuse the compact inspector typography, neutral surfaces and 6 px dark help popup shown on the board. A delegated tooltip covers every right-panel button, field, checkbox and select, including controls created by later selection changes. Hover waits 450 ms; keyboard focus shows help immediately. Escape, pointer exit, scrolling, editing and teardown dismiss it. Preserve existing accessible names and description references. Explain position, sizing, text, layout, paint, effects, guides and exports in context; never place helper copy in the canvas document itself.

HTML-imported anonymous labels in flex/grid containers should retain intrinsic text size so parent alignment can place them. Grid `place-items` expands into axis alignment. Text alignment within a box and alignment of the box within a parent remain distinct. Verify actual first-render glyph position with native Chromium, rather than trusting synthetic text metrics alone. The mapping is `editor/ui/inspector.ts`, `inspector-help.ts`, `style.ts`, `editor/formats/html.ts` and `editor/layout/index.ts`.

## Implementation constraints
Reuse the existing editor and Electron bridge. No new UI framework or network service. Never connect a cosmetic control to fake data. Preferences are device-local and independently validated. Preserve existing library/import/new/export selectors for regression tests. Keep offline fonts and CanvasKit assets. No uploads, analytics, or external fonts.

## Open questions
Automatic host migration and NAT traversal remain future product work. External-machine routing is not visually or automatically proven by this redesign. The design document is an editable local file, not an embedded read-only screenshot.

## Reusable design-system components

The detailed reference supplied by the user supersedes the initial small component board. Deliver true main components, variants, live instances and editable properties. The dedicated **Oh My Canvas Component Library** contains 14 families / 170 variants plus connected compositions, arranged as labeled state matrices. Axes include Style, Size, State, Destination and Tone. The source generator, manifest and previews live under `docs/design/system/`; these are editable canvas objects rather than flattened screenshots.

Use the existing Assets grid and Design property controls, with discoverable Components entry, Create component, Combine variants, Insert instance and Add variant actions. Purple outlines/diamonds indicate component relationships; blue remains the product action color. Main updates must preserve instance overrides; Reset/Detach must behave distinctly. All compound component actions must be one collaborative Undo step. MCP must expose the same engine operations and remain usable in a background window.

Select triggers use flat white surfaces, an 8 px radius, 34 px compact height, right-aligned 16 px chevron, and blue focus indication. Retain native select keyboard behavior. Default, hover, focus and disabled examples belong in the detailed library; avoid macOS's raised popup-button skin in the app's library toolbar.

### Fixed page controls and selection reveal (2026-11-10)

The editable **Oh My Canvas UI Kit** document (`0a736844-1df5-43e8-a79f-3a5d7e6b6a64`), page `10e6f879-40f8-4352-8d71-c6179ff89e64`, contains **States / Fixed pages and layer reveal / 2026-11-10** (`2164c2c7-5b34-4973-930e-c68e764d6661`). Its **Sidebar / Compact page navigation** main (`component-3c266b85-8e3a-4b84-b4df-4d0009e3cf10`) has a linked example instance (`component-fd39b310-0c67-45ba-97ba-9f5e8d56e41c`). The document was saved and its board/component read back. The shareable editable reference is `docs/design/sidebar-navigation.html`; preview text describes behavior rather than proving runtime interaction.

Keep Layers/Assets tabs, Pages and the layer filter fixed above an independently scrolling layer tree. One or two pages retain rows; three or more use the existing labeled native select with a 34 px flat white field, 8 px radius, existing chevron and blue keyboard focus. The adjacent current-page menu keeps rename, clone, delete and Move up/Move down available; the add control stays in the Pages heading. Assets has its own scroller. Preserve existing sidebar widths, typography, neutral borders and selection colors.

Canvas selection outside frames reveals that layer. Inside a frame, reveal the nearest containing frame; selecting a frame reveals the frame itself. Expand only the target's ancestors, preserving the target frame's collapsed state and the actual selected shapes. For multiple selection, use the last selected member as the reveal target. Clear a layer filter only when it hides that target. Scroll only the layer tree and only when the target is outside its visible bounds. Repeated canvas clicks reveal an already selected target; direct layer clicks, range selection, context menus, drag/drop and ordinary property changes preserve scroll. Do not switch away from Assets automatically.

The implementation maps to `editor/ui/index.ts` and `editor/ui/style.ts`. Compare at 1500 × 980 and the supported 960 × 640 minimum with long layers and page names. Real Electron checks cover fixed controls, two/three-page transitions, direct and nested canvas selection, repeated selection, filter reveal, page actions and Assets scrolling. Platform and hardware limits are reported with delivery evidence.
