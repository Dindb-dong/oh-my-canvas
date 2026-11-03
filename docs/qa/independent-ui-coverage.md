# Independent UI regression evidence

All tests in this lane were authored after implementation checkpoint `f86e063`. No inherited test bodies or restricted implementation trees were read. Tests use synthetic fixtures. The native runner uses the installed Playwright/Electron dependency and a new temporary profile; it does not expose production debug globals or use the default user profile.

## Current execution

- Whole-tree TypeScript: pass after final production edits.
- Fresh UI harness: **16/16 pass**, four files, final combined run 2026-11-03 20:40:27 KST. Command: `node node_modules/vitest/vitest.mjs run editor/__tests__/ui-text-session.test.ts editor/__tests__/ui-clipboard-atomic.test.ts editor/__tests__/ui-canvas-geometry.test.ts editor/__tests__/ui-inspector-locking.test.ts --reporter=dot`.
- Full actual Electron native run: **37/37 pass**, **zero renderer errors**, finished 2026-11-03 21:07:24 KST. Evidence: [`independent-ui/report.json`](independent-ui/report.json) and parent launch log `work/independent/ui-final.log`. This includes `UI-imported-html-drag`, which passes in 467ms after the renderer's imported absolute-layout fix. The result covers the 37 executed named journeys; it does not establish a pass for every sub-option or combination.
- The same run passes paint/effect controls (16-stop angular gradient/limit, stroke details, inner shadow), local style CRUD/value synchronization, component property dialogs, native text/IME and touch, file import, clipboard, layout, and all five export formats with cancellation/error routes.
- Actual eligible-library replay: **passed**, finished 2026-11-03 21:07:14 KST, with zero page errors. [`independent-library-e2e/report.json`](independent-library-e2e/report.json) records the 1,065-object/172-main/170-variant baseline, actual main-process import, composed Assets insertion, property/variant changes, source propagation, disk save and fresh-process reopen. Both initial and reopened visual audits verify **all 16 tiles have actual source SVG previews and contained family labels**. Screenshots: [initial Assets](independent-library-e2e/01-assets-library.png), [reopened Assets](independent-library-e2e/04-reopened-library.png).


All previously reported UI blockers are closed in the final native replay and actual-library replay. The matrix below retains limits on unenumerated sub-options and platform/hardware evidence; it does not label these limits as passing native cases.

## Evidence mapping

| Manifest | Native journey IDs | Additional focused evidence | Coverage limit |
| --- | --- | --- | --- |
| DOC-01 | UI-pages-layers | Actual layer rename/flags; page add/rename/clone/delete | Reorder/nest across every container is not exhaustively exercised here |
| GEO-01, GEO-02 | UI-tool-move, UI-resize, UI-rotate, UI-paste-here; UI-imported-html-drag | Three interaction-handler resize tests plus locked-ancestor and projection reentrancy tests: pointer grab offset, 90° local basis, Alt center anchor | Locked-ancestor inspector writes and own-unlock are covered by two fresh harness cases; skew/flip/multi-selection/reparent edge combinations remain additional evidence |
| VEC-01 | UI-tool-frame/rect/ellipse/polygon/star/line/arrow/pencil/pen/text/move, UI-cancel-draw, UI-cancel-tools | Real pointer/keyboard events, document snapshots, durable step counts | Every drawing option combination is not enumerated |
| VEC-02 | UI-path-nudge, UI-path-endpoint-drop, UI-path-merge | Native node movement and compatible path drop join | Curved closure, mirror modes, holes, multiple subpath topology and node insertion/deletion need broader UI enumeration |
| PAINT-01, PAINT-02 | UI-inspector-paint; UI-exports preserves fixture paint | Native angular gradient with 16 stops/limit, outside stroke/cap/join/dashes and inner shadow controls; rendering lane owns gallery | Image/per-side stroke and every gradient variant are not exhaustively driven |
| LAY-01, LAY-02 | UI-guides, UI-inspector-layout | Flex row/column and gap, grid tracks/padding with actual child positions | Hug/fill/constraints combinations require rendering/layout evidence and more direct journeys |
| TEXT-01, TEXT-02 | UI-text-rich, UI-text-range-history, UI-text-empty, UI-ime-native | Rich range preservation, same-page remote focus/cancel, local history despite host override, composition grouping, delayed font commit, marker offsets and paragraph indentation harnesses | OS candidate window selection, every paragraph/range/mixed-style control and physical keyboard layout are not exhaustively tested |
| TEXT-03 | UI-text-rich, UI-exports | Font-promise commit gate harness | Screen/export glyph measurement belongs to rendering lane |
| CMP-01, CMP-02 | UI-components, UI-component-properties | Main/Assets linked insertion/Add variant; text/boolean/swap property create/edit/remove dialogs | Bind/instance property values/reset/detach still need direct UI evidence; service tests are separate |
| CMP-03 | Separate actual-library replay | 1,065-object baseline, 172 mains, 170 variants, 14 sets; composed insertion, instance property/variant controls, propagation, fresh-process reopen and 16 real previews/contained labels | Evidence comes from the eligible library journey, rather than synthetic fixtures; not every library instance/variant combination is enumerated |
| AST-01 | UI-files-atomic, UI-clipboard, UI-styles-crud; actual-library visual audits | Compound file rollback; paint style create/apply/rename/value sync/duplicate/delete; 16 actual source previews and contained labels before/after reopen | Text/effect style CRUD, offline libraries and font catalog need more native journeys |
| FMT-01, FMT-02 | UI-files-atomic, UI-clipboard, UI-paste-here; UI-imported-html-drag | Real native file picker route with image/SVG fixtures and canonical OS clipboard shape JSON | Exhaustive HTML/SVG parser cases belong to formats lane |
| EXP-01, EXP-02 | UI-exports | Actual PNG/JPG/WebP/SVG/PDF files, signatures, Chromium raster decode, size assertions, save cancel and error toast | Dialog choices use test-side Electron adapter; platform dialog widgets are not manually driven |
| HIST-01 | UI-tool-move, UI-text-range-history, UI-files-atomic; UI-imported-html-drag | Durable counts and local text journal; atomic failure rollback | Multi-client selective undo belongs to parent collaboration regression |
| COL-01, COL-02 | No network collaboration in isolated UI runner | Same-page remote text projection/focus/cancel in actual Editor harness | Parent's four-client evidence is required separately |
| UI-01 | UI-find, UI-mobile, UI-touch-native, UI-pages-layers | Native DOM, real responsive window, CDP touch pan/pinch and IME composition | Physical touch hardware, assistive technology and exhaustive keyboard navigation remain additional evidence |
| APP-01 | Fresh fixture through home/native file import each case | Temporary profile removed in finally; no upload | Full application durability/update lifecycle belongs to parent |

## Imported HTML native follow-up

`UI-imported-html-drag` inserts an absolute `<div>` through public `window.lvMcp.handleToolCall(..., "write_html", ...)` into the fixture board at CSS left/top 300px/300px. It asserts persisted position, uses actual pointer movement by +40/+20, then checks persisted x/y 340/320 and synchronized CSS offsets. Native keyboard Undo/Redo must restore both geometry and CSS without deleting the original left/top declarations. The test uses the same actual Electron application, public API and snapshot IPC as the rest of the runner; no production code or debug global was added. It passed in the full 37/37 replay at 21:07:24 KST, including the persisted CSS/geometry checks after drag, Undo and Redo.

## Resolved diagnostics

Earlier 34/36 and focused failure reports remain as historical evidence. The touch test initially contacted the board, correctly entering a shape gesture; it now contacts visible blank canvas for pan and separately checks pinch zoom. Native fixture setup also waits for `window.lvMcp` and `#editor.inert === false`, because stage creation precedes asynchronous bootstrap. This mount gate improved harness correctness but did not alone explain the layout failure.

The layout trace recorded a real local padding update followed by reversion in persisted host state. Inspector reconstruction and focus restoration could synchronously fire a dirty field's native change while host projection was active. C now defers such field transactions until reconstruction unwinds; a fresh harness case verifies the durable event occurs after the host projection guard clears. The parent also corrected host projection's durable baseline so retained local previews do not suppress a later durable diff. Both the 36/36 replay and subsequent final 37/37 replay pass the previously failing flex/grid persistence journey after these fixes.

Actual-library visual checks exposed inherited button `white-space:nowrap` on long family names. Explicit wrapping/containment and renderer-owned cross-page source thumbnails now pass all 16 tile checks on initial open and fresh-process reopen. Historical overflow screenshots are preserved separately.

## Platform and test boundaries

`UI-ime-native` uses Chromium's actual `Input.imeSetComposition` and `Input.insertText` events; it does not open a macOS candidate window. `UI-touch-native` dispatches actual Chromium touch input through CDP, rather than manually invoking interaction handlers; it does not substitute for physical-device testing. Native file open/save uses deterministic test-side Electron dialog responses while the actual import/export IPC, encoders and disk writers execute. Export failure uses a task-owned blocking file path.

Historical failure screenshots under `independent-ui/` may depict earlier defects or ambiguous test locators; current report rows determine current failures. The production mapping in `editor/ui/IMPLEMENTATION.md` records implemented controls separately from executed proof. No exhaustive UI parity claim is made while rows above retain evidence limits.
