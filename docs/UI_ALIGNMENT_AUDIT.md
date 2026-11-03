# Interface alignment audit

The 2026-11-04 audit preserves the existing blue Tabler design system and fixes three reproduced layout defects:

- Tool-menu `space-between` distributed space between icon, label and shortcut, leaving labels at inconsistent horizontal positions. Rows now keep icon/label together and send the shortcut to the trailing edge.
- App-modal close buttons relied on inline SVG baseline alignment. Their glyphs now center in both axes inside a stable minimum control box.
- Long canvas names could wrap the adjacent editor subtitle. The title still truncates with an ellipsis, while the subtitle stays on one line.

The empty-library mark also uses the shared SVG plus instead of a font glyph. The earlier T, ballpoint Pen and freehand Pencil choices are retained. Existing keyboard shortcuts, accessible labels, disabled states, menu actions and tool behavior remain intact.

## Verification

`node scripts/ui-layout-e2e.mjs` checks **81 scenes / 2,565 visible icon controls** across 1500 × 980, the supported minimum 960 × 640, and a 1200 × 800 window at 125% application zoom. It covers empty/populated/grid/list libraries, file actions, app dialogs, tool and context menus, find/replace, rect/text/frame inspectors at multiple scroll positions, fonts, Assets, component creation, styles, exports and long titles with four displayed peers. Geometry checks include icon containment, center alignment, label gap, checkbox alignment, header wrapping and static-toolbar clipping. The final run has zero geometry failures and zero renderer errors.

The four-peer state is a display fixture, not a new network connectivity test. All documents and names in this audit are synthetic. Native macOS window captures avoid the cropped right/bottom area produced by renderer-only screenshots at non-default application zoom. Local MCP configuration is visibly redacted for screenshot privacy; its real value is restored after each capture.

Raw results and screenshots are in [the layout report](qa/ui-layout/report.json). Representative captures: [tool menu](qa/ui-layout/minimum-tools-2.png), [font picker](qa/ui-layout/desktop-font-dialog.png), [scaled header with four peers](qa/ui-layout/scaled-long-title-four-peers.png), and [app-modal close control](qa/ui-layout/minimum-mcp-dialog.png).

The existing Electron UI suite passes **37/37**, editor tests **353/353**, host tests **40/40**, syntax/strict types and build pass, and documentation checks cover 17 documents and 289 local links/images. Rebuilt package smoke verifies the actual bundled MCP CLI; package provenance checks 364 file comparisons with no mismatches. Earlier broader engine review and cross-platform/network limitations remain in [the independent verification record](independent/VERIFICATION.md); this audit does not claim exhaustive visual coverage of every possible document or operating system.

## First private remote

The source repository begins at the reviewed independent snapshot, rather than the retired company-source Git history. The first hosted repository is private under `Dindb-dong/oh-my-canvas`. Source-history inspection checks regular source paths, excluded private/generated directories, per-file upload size and explicit credential/home-path patterns. This is scoped evidence, not exhaustive secret detection or legal clearance. Local document backups, runtime credentials, node_modules, build output and app bundles stay outside the uploaded source history.
