# Independent workspace and interaction implementation

## Authoring inputs and exposure

This lane authored only `editor/ui/**` and `editor/interaction/**`. Its inputs were the separately authored `editor/contracts.ts`, `docs/independent/{contracts.md,PLAN.md,PROVENANCE.md,parity-manifest.json,behavior-contract.md}`, machine-wide AGENTS instructions, standard DOM/Pointer/Selection/Clipboard/FontFace browser APIs, and the newly authored document, geometry, commands, component, style, asset and rendering service entry points. The lane read the installed Ponytail and Design Master workflow instructions; the explicit implementation-before-regression order took precedence over their normal test workflow.

This lane did **not** inspect `vendor/editor`, `vendor/canvas/paint`, inherited test implementations, or any other Leviosa checkout. It did receive bounded static reviews of the new implementation from the foundation, rendering and component lanes. The overall project has source-exposed planning; this report does not claim an unexposed clean-room process or legal clearance.

## Entrypoints and boundaries

- `createWorkspaceRoot(root, options)` creates the exact stage handed to the renderer and returns `{stage,shell,left,right,tools,overlays,header}`. It retains the DOM until workspace disposal.
- `mountWorkspace(root, services, options)` reuses that stage. It returns real `session`, `ix`, `vp`, `vector`, `find`, `picker`, Assets open, edit/editPath, clipboard, flush and asynchronous idempotent destroy handlers.
- UI changes use the document transaction/session API or injected command/component/style/asset services. Clipboard remapping and main-component duplication are delegated to the command registry.
- Rendering, layout, parsing, vector Boolean computation, rasterization and file writing remain in their owning services.
- The workspace provides host selectors `.file-name b`, `#stage`, `#overlay`, `.ltabs button` Assets, `.layers[role=tree]`, `.row[data-id]`, `.page-row[data-id]`, `.atile`, `#right`, `.design > section`, `#tools`, `[data-tool]`, `[data-key]`, `textarea[aria-label="Text editor"]`, `.find-bar[role=search]` and root `.collapsed`.

## Detailed feature mapping

Every row below is an implementation mapping, **not** a runtime verification claim. The implementation-complete checkpoint was recorded at `f86e063`; fresh regression checks were authored only after that checkpoint. Runtime evidence and remaining coverage limits are recorded in `docs/qa/independent-ui-coverage.md`.

| ID | Required behavior | New implementation |
| --- | --- | --- |
| C-01 | Mount, stage handoff, exact DOM, repeated disposal | `ui/index.ts` workspace root/mount/handle; AbortController, ResizeObserver and renderer subscriptions |
| C-02 | Desktop pages/Layers/Assets/Design and header | `ui/index.ts` renderLeft/renderAssets; `ui/style.ts` compact blue/white shell |
| C-03 | Eleven tools and remembered shape/pen split groups | `ui/index.ts` toolEntries, grouped menus, lastShape/lastPen, refreshToolbar |
| C-04 | Conditional command enablement, shortcut hints, context menus | `ui/index.ts` commandMenu, showContext, run; real registry enablement |
| C-05 | Command palette search and keyboard navigation | `ui/index.ts` quickActions and menu Arrow/Home/End/Escape handling |
| C-06 | Keyboard command family, native-input focus rules | `ui/index.ts` shortcutMap/key; platform Mod vs separate Ctrl; canvas node handling before layer commands |
| C-07 | Page add/rename/clone/reorder/delete | `ui/index.ts` pageAction; page clone generates unique IDs and remaps local component mains |
| C-08 | Layer selection, expansion, visibility/lock, ancestor handling | `ui/index.ts` tree; `interaction/canvas.ts` ancestorEditable/hit |
| C-09 | Layer drag order/nesting/world positions/cycle rejection | `ui/index.ts` tree drag/drop transaction; document reconciliation |
| C-10 | Inline layer rename, name/type filter | `ui/index.ts` editable `.name`, Enter/blur save/Escape rollback, Filter layers |
| C-11 | Single/multiple/marquee selection | `interaction/canvas.ts` down/move/up; rotated corners and locked/hidden ancestor eligibility |
| C-12 | Move, Alt duplicate-drag, Shift axis lock, reparent | `interaction/canvas.ts` move session, canonical cloneShapes and parentAt |
| C-13 | Rotated resize, proportions, center resize, multi-resize | `interaction/canvas.ts` local unorient/orient basis, shared resizeShape/transformShapes; frame constraints remain layout-owned |
| C-14 | Rotate multiple subtrees and world vector geometry | `interaction/canvas.ts` shared moveShape/setShapeOrientation; inspector rotateShapes |
| C-15 | Pan, anchored wheel/pinch zoom, fit, .01–200 limits | `interaction/canvas.ts` pan/zoom/fit, pointer map/pinch; ResizeObserver preserves origin/zoom |
| C-16 | Touch pan, double-tap text/vector edit, multi-select mode | `interaction/canvas.ts` touch branches; `ui/index.ts` mobile Multi |
| C-17 | Page/world guides and eligible frame-offset guides | `interaction/canvas.ts` ruler creation/guide move/remove; `ui/inspector.ts` guidePanel |
| C-18 | Pixel snapping, smart alignment guides and own-node snapping | `interaction/canvas.ts` snap/drawSnap, excluded descendants, node target snapping |
| C-19 | Square/row/column grids and visible toggles | `interaction/canvas.ts` drawFrameDecorations; inspector gridPanel controls; overlays excluded from export |
| C-20 | Frame/rectangle/ellipse/polygon/star/line/arrow/text creation | `interaction/canvas.ts` drawing preview and default click geometry; one commit/cancel rollback |
| C-21 | Open/closed pen, cubic drag handles, pencil paths | `interaction/canvas.ts` penDown/finishPen, outgoing/incoming world handles, refreshPath |
| C-22 | Path enter/double click, node/control selection and dragging | `interaction/canvas.ts` editPath/drawPathNodes and shared path helpers |
| C-23 | Cubic-preserving insert/delete, corner/smooth/symmetric | `interaction/canvas.ts` splitPathNode/deletePathNodes/convertPathNode |
| C-24 | Node 1/Shift-10 nudge, J/Mod-J endpoint join/merge | `interaction/canvas.ts` nodeKey; internal nodes do not close whole paths |
| C-25 | Compatible endpoint drop join/close | `interaction/canvas.ts` node-up endpoint eligibility and same-session joinPathEnds/closePath |
| C-26 | Exact cubic/even-odd hit behavior and live Boolean projection | `interaction/canvas.ts` shared hitTest, view.projectedShape and onRender overlay refresh |
| C-27 | Boolean operations/flatten/retained operands | Registry-driven context/quick actions; `ui/inspector.ts` Boolean operation/release controls |
| C-28 | Editable polygon/star count/ratio | `ui/inspector.ts` path.primitive controls |
| C-29 | Native caret/range/word-line navigation/deletion/IME | `interaction/text.ts` native contenteditable, paragraph/run metadata and composition events |
| C-30 | Rich paragraphs/runs, range splits, caret insertion formatting | `interaction/text.ts` read/render, applyStyle/applyParagraph, selectionStyle |
| C-31 | Rich/plain clipboard, text-local undo/redo and B/I/U | `interaction/text.ts` rich MIME, native DOM insertion and bounded local snapshot journal |
| C-32 | Empty cancellation/no ghost and same-page remote focus | Adopted new-text gesture session cancels to precreation base; native surface survives projection; renderer mutations rehide underlying text |
| C-33 | Font-settled final text commit and lifecycle flush | `interaction/text.ts` async exit awaits actual Unicode ensure then final preview/one commit; workspace flush/destroy await it |
| C-34 | Typography/mixed range values/paragraph/list controls | `ui/inspector.ts` typography; native list markers excluded from serialized characters and caret offsets |
| C-35 | Font family/face search/preview/recent/variable weight | `ui/inspector.ts` fontPicker and numeric weight; family changes await fonts before applying |
| C-36 | Truncation/line limits/leading trim/auto sizing/background/highlight | `ui/inspector.ts` Typography fields and advanced background editor; render/layout services consume fields |
| C-37 | Ordered multiple fills/strokes/effects add/edit/remove/hide/reorder | `ui/inspector.ts` paintPanel/effectsPanel |
| C-38 | Solid CSS color, RGB/HSL value, opacity and native eyedropper | `ui/inspector.ts` paint controls; EyeDropper only when platform supplies it |
| C-39 | Linear/radial/angular/diamond gradients, 16 stops, flip/rotate/handles | `ui/inspector.ts` gradient controls; `interaction/canvas.ts` endpoint gestures |
| C-40 | Image paint/fill/fit/crop/tile and image shape adjustments | `ui/inspector.ts` imagePaint/imagePanel; fractional crop and adjustment advanced fields |
| C-41 | Blend/opacity/radii/smoothing/stroke sides/caps/joins/decorations/dashes | `ui/inspector.ts` appearance and stroke panels |
| C-42 | Inner/drop shadows, blur/background blur, effect style | `ui/inspector.ts` effectsPanel; numeric field drag groups one session |
| C-43 | Frame clipping, legacy clip rectangle, masks/removal | `ui/inspector.ts` Frame, Clip rectangle, Mask; registry struct.mask |
| C-44 | Flex directions/wrap/justify/cross/baseline/content/gaps/padding | `ui/inspector.ts` layoutPanel, injected layout reconciliation |
| C-45 | Grid tracks/gaps/cells/spans/alignment | `ui/inspector.ts` layoutPanel and direct Grid cell controls |
| C-46 | Fixed/hug/fill/min/max/absolute/constraints | `ui/inspector.ts` sizing, optional min/max, constraints and shared geometry helpers |
| C-47 | Inspector mixed values/numeric keyboard increments and scrubbing | `ui/dom.ts` input helpers; inspector focus restoration and numeric-start/end session |
| C-48 | Component tiles by page/slash/variant family, all-page instance insert | `ui/index.ts` paginated catalog grouped by page/path, one tile per variant set named from source frame; renderer-owned cross-page SVG thumbnails with page-identity caching |
| C-49 | Create/combine/add/switch variants and component axes | `ui/inspector.ts` componentPanel; D run actions, returned page before selection |
| C-50 | Property CRUD/binding/set, text/boolean/swap, reset/detach | `ui/inspector.ts` component property dialogs/actions; mains detected despite dual flags |
| C-51 | Local paint/text/effect style CRUD/descriptions/detach | `ui/index.ts` editStyle; inspector stylePicker/saveStyle; range text/paint refs independent |
| C-52 | Active text style actions remain in the local session | Range formatting or preview-wrapped nested style transaction; whole-layer/component operations await text exit |
| C-53 | Persisted offline library snapshots/version/enable/update/remove/export | `ui/index.ts` libraryDialog and injected library service; no fabricated remote publishing |
| C-54 | Image/font catalog and persisted local font reload | `interaction/clipboard.ts` assets service metadata; `ui/index.ts` savedFonts/catalog tiles |
| C-55 | Shapes/subtrees/internal refs/copied main -> linked instance | `interaction/clipboard.ts` normalizes envelope then delegates remapping to Commands |
| C-56 | Legacy clipboard kind, native copy/cut/paste, paste-in-place/replace/properties | `interaction/clipboard.ts` shapes/objects envelopes including `leviosa-editor/shapes@1`; registry modes; frozen cut IDs |
| C-57 | Editable SVG/images/plain text import/paste | Injected formats and real image decode; fonts ensured before parser/transaction |
| C-58 | Multi-file picker/drop side-by-side and atomic insertion | `interaction/clipboard.ts` prepares all files first, one outer Place files transaction using synchronous `commands.pastePrepared` |
| C-59 | Find case/whole-word/cyclic reveal/replace one/all | `ui/index.ts` openFind; range-preserving text-run replacement and single transaction |
| C-60 | PNG/JPG/WebP/SVG/PDF per-layer export, multiple settings | `ui/inspector.ts` exportPanel/exportLayer with injected exporter |
| C-61 | Scale/fixed width/height/suffix/presets and clipboard PNG/SVG | Raster clamp .01–4, 512w/h presets; vector/PDF scale ignored; sequential awaited native saves |
| C-62 | Native cancel/errors, no premature success | Awaited export callback; cancellation returns quietly and errors use one accessible toast |
| C-63 | Mobile Layers/Assets/Design sheets and task controls | `ui/index.ts` mobile controls; `ui/style.ts` bottom sheets; create/undo/fit/duplicate/delete/order/multi/Done |
| C-64 | Agent overlays/resource cleanup | `interaction/canvas.ts` agent map; unsubscribers/aborts, numeric drag disposal and async text disposal |

## Static review closure

The foundation/component lanes identified real issues in initial authoring. The delivered code closes them through shared geometry/path helpers, canonical clipboard commands, page-aware component selection, canonical `componentProperties`, and main detection `isInstanceRoot && !isMain`. Whole-shape style calls no longer attempt a top-level transaction during active text editing. The renderer's independent scene callbacks refresh projected Boolean outlines without creating a document/history edit. Assets use renderer-owned `view.thumbnailSvg(pageId,id)` source scenes rather than a second thumbnail renderer, with contained family labels and no per-tile font embedding.

A second clipboard implementation was removed. Shape remapping, legacy references, copied component-main semantics and replace placement belong to the command service. The UI only reads platform clipboard/file payloads and supplies normalized envelope data. `pastePrepared(payload,args,mode)` runs synchronously inside the outer transaction, so a throw from shape insertion rolls back asset records and every placed shape together; no nested async command Promise escapes the rollback scope. All file reads, image decodes, font loads and SVG parsing finish before that transaction starts. The target page is checked again after font loading.

Public callback aliases include both `quickActions` and `openQuickActions`, plus `rename(id): Promise<string|null>`, `pasteText`, and `importClipboard`; these refer to actual dialogs/parsing/insertion handlers and are also installed into the shared service registry for commands.

## Verification and outstanding work

- Whole-tree TypeScript static checks pass after the final source changes. Native script syntax checks pass.
- Four newly authored `ui-*` harness files pass **16/16 cases**, verified 2026-11-03: range formatting, remote focus/rebase cancellation, text-local history/composition, empty creation rollback, delayed font commit, marker offsets, public paragraph indentation, compatibility textarea preview/cancel/mirroring, multi-file compound success/rollback, rotated resize and centered/off-center handle behavior, and locked-ancestor inspector protection with own-layer unlock, and dirty-field commits deferred until host projection reconstruction/focus restoration unwinds.
- The parent runs `scripts/independent-ui-e2e.mjs` against the actual isolated Electron application. The current actual Electron run passes **37/37 journeys with zero renderer errors**, finished 2026-11-03 21:07:24 KST; machine-readable results and screenshots live under `docs/qa/independent-ui/`. The latest separate actual-library replay passes at 2026-11-03 21:07:14 KST, including all sixteen source SVG previews and contained family labels on initial open and fresh-process reopen. The coverage document maps this evidence and retains limits for sub-options not directly exercised.
- No inherited test bodies were inspected. No regression tests were authored or executed before checkpoint `f86e063`.
- No known required control is intentionally disabled or backed by a placeholder. The implementation mapping alone does not establish behavioral parity. The detailed coverage document lists requirements still needing direct UI evidence.
- No commits, upload, deployment, installation or restricted-tree removal was performed by this lane.

## Native replay closure — 2026-11-03

The final full native run closes the earlier layout, touch setup and label-overflow failures. Mount readiness is now explicitly awaited; this was a harness correction, not the sole cause of layout reversion. Public MCP context and persisted snapshots exposed field changes occurring during host projection reconstruction. Inspector writes triggered by reconstruction/focus restoration are deferred until projection unwinds, and the parent corrected its durable projection baseline independently. The focused projection regression and full native flex/grid journey both pass.

The eligible actual-library journey imports the 1,065-object baseline through the main process, inserts a composed component from Assets, changes instance properties/variants, observes source propagation, saves, and reopens in a fresh process. Both visual audits confirm sixteen real renderer-owned source previews and bounded family labels. See `docs/qa/independent-ui-coverage.md` and `docs/qa/independent-library-e2e/report.json`. These journey passes do not claim exhaustive native execution of every inspector option, path topology or physical-device interaction.

A subsequent test-only addition, `UI-imported-html-drag`, bridges public HTML import, retained absolute CSS offsets, native pointer movement and native Undo/Redo. The final full replay passes **37/37** with zero renderer errors, including this added journey. Its persisted state assertions verify x/y 300/300 → 340/320 by native drag, Undo → 300/300, and Redo → 340/320 while the original CSS left/top declarations remain present and synchronized. No UI/interaction production changes were made for this test addition.

Final evidence refresh: the current 37/37 native report and latest actual-library replay close all previously reported UI blockers. `work/independent/ui-final.log` records the final native launch. Physical OS IME candidate selection, native dialog widgets, physical touch devices, assistive technology and unenumerated sub-option combinations retain the explicit evidence limits in the coverage matrix. No additional product source change was made for this evidence refresh.
