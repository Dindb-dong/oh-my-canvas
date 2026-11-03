# Document, geometry and command lane

Status: statically implemented; strict TypeScript entry checks passed. Runtime verification is deliberately pending the parent implementation-complete barrier. This is an implementation map, not a parity verification claim.

## Authoring inputs and exposure

- `editor/contracts.ts`, `docs/independent/contracts.md`, `PLAN.md`, `parity-manifest.json`, `PROVENANCE.md`, and the independently worded `behavior-contract.md`.
- Read original host `core/geometry.mjs` and the two coordinate conversion call sites in `src/main.js` to confirm persisted/CRDT and host-call interoperability. Those host files are not the restricted editor implementation. World path endpoints and both cubic controls already contain orientation; scalar geometry and orientation caches must remain compatible with that representation.
- Standard TypeScript/ECMAScript APIs, elementary affine algebra, cubic de Casteljau subdivision, derivative-root extrema, winding/ray fill rules, and authored tree/journal algorithms.
- Other workers' newly authored component module was read to establish the `duplicateComponentMain` helper boundary. No restricted `vendor/editor`, `vendor/canvas/paint`, private tests, or Leviosa checkout was read by this lane. No copied implementation or old test bodies were used. The overall project has source-exposed planning and makes no clean-room claim.
- No dependency installation, downloads, network writes, test authoring or test execution. Existing TypeScript compiler was reused. Disk measurement before work: approximately 63 GiB available. Only owned source files and this report were written by this lane.

## Public interfaces

`document/index.ts` exports `Editor`, all factory/tree/validation helpers, and aliases `getDescendants`/`getAncestors`. `Editor` accepts a document or `{doc,pageId?,viewport?}` plus `EditorOptions`. Its `doc` getter exposes the candidate during a nested transaction; published documents share unchanged branches after successful reconciliation. `lastOperation`, `activeSession`, `inTransaction`, `undoSession`, and `redoSession` are available to integrations. Native `undoStep`/`redoStep` overrides do not remove session-local history.

Geometry exports include `boxGeometry`, `updateGeometry`, `reconcileShapeGeometry`, `moveShape`, `resizeShape`, `setShapeOrientation`, `transformShapes`, `orientedPathBox`, bounds/points/matrix helpers, path flatten/hit helpers, constraints, snapping, polygon points, and viewport helpers. `screenToWorld`/`worldToScreen` accept both `(point,viewport)` and the original host `(viewport,point)` call order.

`commands/index.ts` exports `createCommands` and pure group/ungroup/rotate/flip/align/distribute/order helpers. `commands/path.ts` exports path node/handle/insertion/deletion/open/close/reversal/join/merge/primitive operations. The registry supports `get`, `enabled`, `run`, `list`, `register`, `destroy`, and shortcut hints.

## Feature mapping

| Requirement / detailed behavior | New implementation |
| --- | --- |
| DOC-01: document/page factories, stable IDs, one self-parented root, world hierarchy and layer order | `factory.ts`: createDocument/createPage/createShape; `tree.ts`: insertShape/removeShapes/reparentShapes/topLevelIds/refreshFrames |
| DOC-01: page add/rename/duplicate/delete/reorder, layer rename/lock/hide | `tree.ts`: addPage/deletePage/duplicatePage; commands page.*, layer.* |
| DOC-01/DOC-03: duplicate child rejection, cycle/orphan/missing-parent/invalid-root rejection; finite bounded scalar/matrix/path coordinates; 16 MiB document capacity | `validation.ts`: validateDocument; `Editor.prepare` validates isolated candidates before publication |
| DOC-03: changed immutable branches, unchanged identity, failed edits leave model/UI unchanged | `journal.ts`: share; `Editor.transact/preview`: isolated draft, buffered UI events, rollback, nested failure propagation |
| GEO-01: affine inverse/composition, center-relative orientation, scalar box/corners/transform/inverse caches; world-oriented cubic controls | geometry matrix/boxGeometry/reconcileShapeGeometry/mapBetweenBoxes/setShapeOrientation |
| GEO-01: screen/world inverse, anchor zoom 0.01–200, pan, fit, remembered page viewport | geometry screenToWorld/worldToScreen/zoomAt/panViewport/fitViewport; Editor pageViews/setPage |
| GEO-01/GEO-02: world-preserving reparent/group/ungroup; move/resize/rotate/flip single/multi/subtrees | tree reparentShapes/moveTree/resizeTree; geometry moveShape/resizeShape/transformShapes; commands groupShapes/ungroupShapes/rotateShapes/flipShapes |
| GEO-02: locking/hidden ancestors; alignment, distributions, tidy, nudge 1/10, stacking changes | tree isEditable; commands alignShapes/distributeShapes/orderShapes, arrange.tidy-up, nudge.*, layer.* |
| GEO-02: clipboard fresh IDs, subtree order and internal references, normal/overselection/replacement, property styles including rich-text formatting | commands clipboard read/write/copy/paste and property handlers; tree remapReferences/cloneShapes; accepts fresh envelope and legacy `leviosa-editor/shapes@1` |
| VEC-01: all eleven tool IDs and canonical shape records for frame/rect/ellipse/polygon/star/line/arrow/pencil/pen/text | factory createShape; commands tool.* and shape.create-*; interactive gesture construction/cancellation belongs to C |
| VEC-02: canonical world content commands, open/closed straight/cubic paths, nodes/handles/corner/smooth/symmetric modes, insertion/deletion, node nudge, join/merge/reverse, polygon/star controls | commands/path.ts; path.insert-node/delete-nodes/move-nodes/handle/convert-node/open/close/mirror/join/merge/primitive |
| VEC-02: curve bounds and filled/stroked vector hit behavior | geometry pathBounds derivative roots; flattenPath adaptive cubic subdivision; hitTest winding/evenodd and stroke-distance |
| VEC-02: union/subtract/intersect/exclude retaining operands; flatten eligible vector leaves; identity orientation on returned world geometry | bool.* / path.flatten commands await injected combinePaths and reject stale results; B owns CanvasKit implementation and live operand-derived render/export cache |
| Masks: bottom child, alpha/vector/luminance fields, toggle/remove | struct.mask group writes isMaskGroup/maskType/maskId and toggles group mask status; B/C own rendering and inspector |
| LAY-01/LAY-02: layout add/infer/remove, structured gap/padding; geometry constraint primitive | layout.add/remove commands; geometry applyConstraints; B `applyLayout(doc,before)` owns all automatic reconciliation so constraints are not applied twice |
| Guides/view state: rulers, pixel snap, grids, outlines, UI toggle, quick actions, next/previous frame/page | view.* commands, canonical showRulers/showGrids/showOutlines/uiHidden/pixelSnap fields; guide manipulation/snapping UI belongs to C |
| Selection: all/none/inverse/children/parent/next/previous/matching, text/path Enter callbacks | select.* / edit.enter commands; Editor selection/hover validation and projection pruning |
| HIST-01/MCP-02/COL-02: one durable operation for compound edits, nested transaction join, reconciliation-before-validation, preview/cancel/session-local undo, author/group metadata, projection without durable changes | Editor transaction/session methods; bounded history journal; receiveDocument rebases local session history/future and merges remote child-list additions without recording local durable edits |
| Components: create/combine/instance/add variant/reset/detach command bridge; duplicate/copy main -> linked instance | component.* command IDs map to D action names; injected duplicateComponentMain; D reconciliation handles duplicated page mains |
| AST-01/EXP-02: side-by-side multi-image placement in one operation, copy PNG/SVG via real service/clipboard | file.place-image and export.copy-* commands; renderer/export/fonts/assets/formats belong to other lanes |

## Service handoff

`createCommands(editor,services)` consumes these injected implementations:

- `components.run(action,args)` and `duplicateComponentMain(doc,page,id,options)`; returned component `pageId` and `selection` are applied.
- `combinePaths(shapes,operation,{objects})` or alias `boolean`; yields world `segments` and `fillRule`. The result is persisted as canonical `content`. B must resolve retained boolean operands dynamically for later edits.
- `export.svg(ids)`, `export.png(id,scale)`; `clipboard.readText/writeText/writeImage` when the host supplies an adapter, otherwise standard browser clipboard.
- `edit(id)`, `editPath(id)`, `quickActions()`, `rename(id)`, `placeImage()`, `pasteText(text)`, `importClipboard(payload,args)`. Missing optional callbacks return false or surface an unavailable-service error; they do not produce fake success.

Parent reconciliation should call component/style/library reconciliation plus B `applyLayout(draft,before)` through `EditorOptions.reconcile`. Layout/component/text rendering and asset measurements are not duplicated in this lane.

## Verification and remaining work

Strict TypeScript checks on the document/geometry/commands entry points passed using the installed compiler, ES2022 + DOM libraries, ESNext modules, Bundler resolution, strict mode and skipLibCheck. These checks are syntax/type evidence only.

No known intentionally deferred implementation or placeholder is present in the A-owned feature surface. Full integration wiring, every behavior's fresh regression expectations, actual UI/IME/clipboard/native undo, CRDT author isolation and projection races, CanvasKit booleans, measured layout/rendering and save/reopen still require the parent checkpoint and post-barrier verification. Any findings from those checks must be fixed before a parity claim.

## Follow-up static integration review

At the parent's request this lane read only newly authored UI/interaction/render modules. No regressions were authored or executed. Findings were sent to the owning lanes and parent; implementation-complete must not be inferred until owners resolve them:

- C: repeated path rotation must transform initial world content explicitly; rotated resize needs the local handle basis; pen and direct deletion must refresh path bounds. C acknowledged these and the zoom range correction.
- C: the separate clipboard implementation omitted legacy envelopes, linked-main duplication and internal references; asynchronous cut must capture source IDs. Shared A commands/helpers are available.
- C: inspector container rotation must rotate world child geometry; text edit overlays must include flips/full orientation; path hit and marquee must match real cubic/filled geometry and ancestor eligibility.
- C: selected-node arrows, incoming/outgoing mirror mapping, selected endpoint join/merge and compatible endpoint drop need complete UI wiring. Multi-file imports must prepare resources first, then place side-by-side in one operation.
- B: live boolean content must have matching derived bounds/corners and invalidate for fill rule/radii/other path geometry changes; explicit disabled mask flags must suppress stored mask type.

A's canonical property-copy coverage was expanded during this review to include shadows, blur, background blur, individual radii and corner smoothing. Latest own strict TypeScript checks pass; runtime validation remains gated.

### Compound import atomicity closure

The command registry now exposes `pastePrepared(payload,args?,mode?)` and alias `importPrepared`, returning selected IDs synchronously. Supplied shape-payload command execution is synchronous; clipboard reads, font/image preparation and optional format imports remain outside the candidate. C confirmed its multi-file placement now calls this helper directly inside one outer transaction. Nested Promise-returning mutators are rejected synchronously and poison the outer candidate. Prepared errors therefore propagate into the outer rollback instead of becoming an unobserved rejected Promise after partial asset commits.

Async text/import callbacks receive `mode` plus placement arguments; quick-action callbacks accept either public alias. Boolean command creation consumes CanvasKit's tight bounds when provided. C added rename/quick-action callbacks and B reported closure of its derived boolean-bounds/cache and disabled-mask findings. These are static implementation closures; fresh runtime proof remains pending the parent barrier.

## Fresh post-barrier foundation regression evidence

The parent checkpoint (`docs/independent/implementation-complete.md`, commit `f86e063`) authorized regression work. This lane then authored three new files from the behavior contracts and mathematical oracles, without reading or copying inherited test bodies:

- `editor/__tests__/foundation.geometry.test.ts`: affine inverse/composition and viewport round trips; known rotated corners; anchor zoom/fit; already-oriented world path move/resize/rotate and direct scalar reconciliation; constraints/snapping; analytic cubic derivative extrema; de Casteljau equivalence; attached controls, mirrored/aligned handles, reversal/open/close/deletion/join; oriented stars; true cubic strokes and evenodd holes.
- `editor/__tests__/foundation.document.test.ts`: root/metadata/tree validity; unchanged identity and immutable changed entities; compound operation ID/author/group; no-op behavior; mutator/reconciliation/validation rollback; nested caught failure and Promise rejection; invalid trees/path geometry/capacity; subtree duplication and references; page operations; nondurable previews, cancellation, session-local history with host undo override; remote fields/siblings/deletions/history/redo rebasing and no resurrection.
- `editor/__tests__/foundation.commands.test.ts`: required command registry, all tool IDs and primitive factories; align/distribute/tidy/order/nudge/opacity; group/frame/mask/layout; subtree rotation/flip; rename/lock/hide/delete; selection/page/frame/view navigation; injected text/path/quick-action/components/image/export adapters; synchronous prepared paste rollback, legacy envelopes/internal refs/order/overselection/replacement/properties/cut race; all injected boolean operations and stale/failing results; mixed-content flatten preservation; node commands; atomic page navigation.

Final scoped commands passed:

```
npx vitest run editor/__tests__/foundation*.test.ts
# 3 files passed; 138 tests passed; 0 failed

./node_modules/.bin/tsc --noEmit --target ES2022 --lib DOM,DOM.Iterable,ESNext --module ESNext --moduleResolution Bundler --strict --skipLibCheck editor/__tests__/foundation*.test.ts
# passed
```

Concrete production defects reproduced by fresh expectations and fixed before the passing run:

1. Reference-map dictionary keys were renamed indiscriminately: valid IDs `a`/`b` corrupted affine matrix keys during clone/page duplication. Key rewriting is now limited to actual reference dictionaries; component-source mapping values are remapped explicitly. Geometry/text/style metadata keys remain intact.
2. Page add/duplicate scheduled selection/navigation in a microtask outside the candidate. The page change now runs synchronously against the candidate, emits within the same successful event, and rolls back if a later outer mutation fails.
3. Previous-frame navigation from an empty selection skipped the last frame. It now starts at the final frame and continues cycling correctly.

Feature groups with passing pure/scoped evidence: DOC-01, DOC-03, GEO-01, GEO-02, VEC-01, VEC-02, LAY-01/LAY-02 command/constraint primitives, HIST-01 editor mechanics, MCP-02 atomic/busy mechanics, COL-02 editor projection mechanics, and command bridges for CMP/AST/EXP/UI. The service-adapter checks prove plumbing, not actual CanvasKit geometry, font/image rendering, native clipboard/save, UI/IME interaction, host author-isolated Yjs undo, disk durability or real four-process TLS collaboration. Those remain integration evidence owned by parent/other lanes. No broad parity or publication-readiness claim follows from these 138 tests.

Additional real-render feedback from B produced two new failing foundation expectations before fixes: structural groups must be transparent by default (explicit fills still preserved), and shared constraints must accept serialized `leftAndRight` / `topAndBottom`. Both production fixes now pass in the final **138/138** scoped run; strict TypeScript on the fresh test entries also passes. B was asked to rerun its pixel mask case against the actual default factory.
