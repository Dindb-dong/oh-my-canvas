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
Use the pinned MIT Tabler Icons subset for interface controls, with a 24-unit viewBox, 18px default size and 1.75-unit stroke. Keep the supplied app brand icon unchanged. Text tools and text-layer badges use the T-shaped `letter-t` icon. Pen uses `ballpen`; freehand Pencil retains `pencil`. Do not use Unicode glyphs as drawing-tool icons; keyboard shortcut glyphs remain text. Full upstream notices and hashes live in `editor/ui/icons/tabler/`. All icon-only actions have labels. Navigation uses `aria-current`, toggle actions use `aria-pressed`, search uses type search. Keep focus visible and support reduced motion. Hover-only star controls also appear on keyboard focus and compact windows. Color is supplemented by text or shape. Preserve native keyboard shortcuts and renderer text semantics. Small metadata is secondary; no essential workflow relies on it alone.

## Responsive behavior
Desktop-first Electron, minimum 960 × 640. Main content scrolls independently of navigation. Card columns adapt to available width; compact windows reduce padding and sidebar width. Dialogs fit the window with internal scrolling. Editor panels follow the existing supported compact layout; mobile is outside this app's scope.

## Interaction and content
Use concrete language: New canvas, Open file, Export, Starred. Show actual local dates and file counts. Search and sort act immediately; view and stars persist locally. Saved means persistence succeeded. A failed edit shows an actionable error. Collaboration shows host, guests, capacity, reconnecting and offline conditions. Local MCP does not remove the AI client's own costs or limits.

## Implementation constraints
Reuse the existing editor and Electron bridge. No new UI framework or network service. Never connect a cosmetic control to fake data. Preferences are device-local and independently validated. Preserve existing library/import/new/export selectors for regression tests. Keep offline fonts and CanvasKit assets. No uploads, analytics, or external fonts.

## Open questions
Automatic host migration and NAT traversal remain future product work. External-machine routing is not visually or automatically proven by this redesign. The design document is an editable local file, not an embedded read-only screenshot.

## Reusable design-system components

The detailed reference supplied by the user supersedes the initial small component board. Deliver true main components, variants, live instances and editable properties. The dedicated **Oh My Canvas Component Library** contains 14 families / 170 variants plus connected compositions, arranged as labeled state matrices. Axes include Style, Size, State, Destination and Tone. The source generator, manifest and previews live under `docs/design/system/`; these are editable canvas objects rather than flattened screenshots.

Use the existing Assets grid and Design property controls, with discoverable Components entry, Create component, Combine variants, Insert instance and Add variant actions. Purple outlines/diamonds indicate component relationships; blue remains the product action color. Main updates must preserve instance overrides; Reset/Detach must behave distinctly. All compound component actions must be one collaborative Undo step. MCP must expose the same engine operations and remain usable in a background window.

Select triggers use flat white surfaces, an 8 px radius, 34 px compact height, right-aligned 16 px chevron, and blue focus indication. Retain native select keyboard behavior. Default, hover, focus and disabled examples belong in the detailed library; avoid macOS's raised popup-button skin in the app's library toolbar.
