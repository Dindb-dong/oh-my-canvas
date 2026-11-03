# Formats and MCP implementation record

Status: implementation checkpoint; runtime parity has **not** been established. Regression authoring/execution remains behind the parent's implementation-complete barrier. No old regression tests were copied or run. No commits or uploads were made by this lane.

## Authoring inputs and source exposure

This lane read `editor/contracts.ts`, `docs/independent/contracts.md`, `PLAN.md`, `PROVENANCE.md`, `parity-manifest.json`, and the separately authored source-observed `behavior-contract.md`. The parent supplied additional data-only serialization descriptions: the ordered `editorPages` metadata array, string-valued board `editorPage`, local SVG path string in `editorPath.content`, frame-local `editorFrame` geometry, and component `mainPageId` derivation. Original host `src/main.js`, `src/sample.js`, package/config files, and the newly authored sibling lanes were inspected to connect interfaces. The installed ponytail skill informed code organization, subject to the user's explicit full-scope and delayed-test requirements.

This lane did not read, copy, translate, template, or execute `vendor/editor`, `vendor/canvas/paint`, inherited test bodies, or another Leviosa source tree. The parent/behavior analyst's source exposure is explicitly acknowledged; this is not an unexposed clean-room claim. Public data names and tool names are retained for interoperability. HTML tokenization, SVG grammar/arc algebra, serialization and MCP dispatch were authored in this lane. Browser APIs and existing TypeScript were used without new dependencies.

## Shared boundaries

- `formats/model.ts` delegates shape/document creation and validation to A. MCP tree insertion, removal, reparenting, duplication, and traversal call A's draft helpers.
- `importHtml` calls B's `applyLayout` on an isolated import scene; it does not install a second live layout engine. The parent reconciles final candidates with the same layout implementation.
- SVG text baseline and intrinsic dimensions use B's DOM-based `measureTextLayout` when a browser DOM exists. Shared `SceneWriter`/`view.sceneSvg` provide vector HTML output rather than a separate paint renderer.
- `installLvMcp` consumes parent-injected components, fonts, assets/provider adapters, duplicate-main behavior and optional `afterWrite`. Components own their domain validation/reconciliation and join the existing outer transaction.
- MCP preloads font ranges before mutation, then rechecks user-busy state and deadline. After mutation it awaits view settlement and host durability via `afterWrite` before measuring touched layers.

## Feature-to-implementation mapping

| Requirement group | Implemented behavior | Files / entry points |
|---|---|---|
| DOC-02 / FMT-02 | Current-model normalization/validation; missing legacy IDs; 1000-size legacy defaults; vertical board placement with 100 gap per editor page; optional placement/column callback; local child coordinates become public world coordinates | `formats/canvas.ts` `importCanvasJson` |
| DOC-02 / FMT-02 | Ordered editor pages, board-to-page association, page guides/metadata; derive component main page from actual mains; local non-board root layers; components/styles/libraries and opaque metadata round trips | `formats/canvas.ts` import/export |
| DOC-02 / FMT-02 | Preserve editorLayout/Text/Path/Bool/Component(s)/Frame/Mask/Grid/Export/Pages/Page/StyleRef/Styles/Libraries/Vector/Style names and unknown wrapper metadata; text preserves rich data unless changed visible legacy text supersedes it; local path SVG string converts to world command records | `formats/canvas.ts` extension mappings, `flatSegments`, `svgPath` |
| FMT-01 | Inert non-DOM HTML tokenizer; entity decoding; quoted attributes/comments; input/node/depth limits; reject scripts/style blocks/frames/embedded objects/event handlers/executable URLs/class styling; never execute or fetch while parsing | `formats/markup.ts` `parseMarkup`, `safeUrl`, `cssDeclarations` |
| FMT-01 / LAY-01/02 | Ordinary blocks use vertical flow; flex/grid directions/wrap/alignment/gaps/padding; fixed/hug/fill and min/max sizing; percentages retained for shared responsive layout; absolute positioning; grid track/repeat and cell/span conversion | `formats/html.ts` `importHtml`, `gridTracks`; shared B layout |
| FMT-01 / PAINT/TEXT | Colors/gradients/image backgrounds; borders/side widths/outline/radii; 50% ellipse; opacity/blend/shadow/blur/backdrop blur; run fonts/weight/style/color/spacing/decoration/case; paragraphs/br; images and inline SVG pictures; data-name/data-ref; warnings for ignored CSS | `formats/html.ts` `paintFromCss`, `importHtml` |
| FMT-01 / EXP-01 | Inline CSS HTML export; rich runs/paragraphs; alias tags; settled computed typography; images; shared SVG scene for paths/booleans/masks; bounded output | `formats/html.ts` `exportHtml` |
| FMT-02 | Editable SVG rectangles/ellipses/lines/polygons/polylines/paths/groups/text/images/use; affine transforms including skew; viewBox aspect alignment; linear/radial paints; M/L/H/V/C/S/Q/T/A/Z grammar with quadratic/arc-to-cubic conversion; original XML case retained | `formats/svg.ts` `importSvg`, `parseSvgPath`; `markup.ts` source names |
| FMT-02 | Unsupported SVG elements, effects, clipping/masks, non-basic gradients and positioned tspans preserve safe original SVG pictures, with definitions and transforms; warnings explain fallback | `formats/svg.ts` `picture` |
| MCP-01 | Exactly 19 tool names, closed argument schemas, array/number/enum limits, required properties, find query validation, component action semantics, recursive batch validation | `mcp/defs.ts` `TOOLS`, `validateToolArgs` |
| MCP-01 | Context (string board aliases plus board details), ordered tree/depth/400 cap/collapsed subtrees, detailed diagnostics, HTML limit, computed style reads, find 50 cap, screenshot slice/overview, fonts, fresh guides | `mcp/index.ts` read dispatcher; `mcp/guides.ts` |
| MCP-01 / CMP-03 | Components call D's 200-record paginated catalog, preserving nextOffset; component sources/properties retain domain IDs while shapes resolve aliases | `mcp/index.ts` components/component dispatch |
| MCP-01 | Configured provider search is separate from local UI component assets; absent brand/upload/stock sources yield empty records and configured=false | `mcp/index.ts` assets dispatch |
| MCP-02 | Agent-scoped aliases, raw IDs and unique @data-ref; same-batch references resolve against the isolated candidate; selection highlighting and session/global disposal | `mcp/index.ts` agent/alias/session helpers |
| MCP-02 | Serialized calls; bounded response deadline including queue wait; idempotency signature collision rejection and cache deduplication; standard text/image + structured revision/errors | `mcp/index.ts` `handleToolCall`, result helpers |
| MCP-02 / HIST-01 | Single transaction labelled agent:<agent> per write/batch; exact write whitelist; busy mutation/undo refusal while reads remain available; rollback candidate/history/aliases on invalid batch/delete/component; own latest-step undo, with host authority and projection invalidation | `mcp/index.ts` execute/apply/undo; A transaction implementation |
| MCP-01/02 | HTML before/after/first/last/replace; text/attrs/CSS update; empty CSS removal; first run style preservation; move/duplicate/delete; main-component duplicate uses shared instance service; rightward board with vertical hug layout | `mcp/index.ts` write dispatcher; `mcp/style.ts` |
| TEXT-03 / MCP-02 | Font preloading, shared resource/layout settlement, host afterWrite, touched bounds, clipped text/parent overflow/font fallback/image failures, ignored-property warnings | `mcp/index.ts` preflight/settled/diagnostics |

## Compatibility bookkeeping

`editorPages` remains an ordered array of page metadata and board `editorPage` remains a string page ID. This implementation does not repurpose those fields as a full model snapshot. A newly authored transparent `editorRootLayers` object stores unframed root layers by editor page for export/import; the parent explicitly accepted a fresh opaque extension for this previously unspecified case. Unknown legacy records remain in `legacy` and unknown extension keys are carried forward.

In non-browser parsing, SVG editable text retains `svgBaseline.needsMeasurement=true` because DOM font metrics are unavailable. Browser UI/MCP must preload fonts before parsing/committing text imports, then use the shared measured layout. Unsupported SVG visual constructs remain source SVG pictures rather than disappearing or being claimed as editable vectors.

Timeout reports do not promise cancellation of arbitrary injected providers; a queued or font-preflight write rechecks its deadline before mutation. A write already committed before resource/durability timeout may exist; clients should inspect revision before retrying and use idempotency keys.

## Validation and remaining evidence

The lane ran strict TypeScript static checking of `editor/formats/index.ts` and `editor/mcp/index.ts` with ES2022/DOM/ESNext libraries. It passed after integration with A/B/D. TypeScript's parser/printer was also used to check syntax and format the authored files. These are static checks, not regression tests.

Still required after the parent's barrier: independent positive/negative format fixtures; exact advanced-extension and unknown-metadata round trips; browser typography and transform/gradient/picture comparisons; all-tool schema/result/limits checks; user/agent contention and rollback/history tests; real host durability and TLS/MCP participants; font/resource failures; large-input/capacity behavior; source/provenance audit. No runtime, visual, export decode, package or legal-independence claim is made by this lane.

## Bounded integration inspection before the regression barrier

Read only the newly authored facade, UI/interaction/commands contracts and original host wiring. Confirmed that MCP `afterWrite` uses `settle(false)` (so it does not finish a user's edit), that operation labels/IDs cross the host commit adapter, that A's geometry overloads accept the host's viewport-first call order, and that parser result shapes match C's clipboard adapter. Shared services and SVG font preloading are connected.

Corrected two lane-owned lifetime/preflight issues discovered statically: queued or font-preparing calls now recheck per-agent session generations/disposal before mutating; a font-family update preloads the existing target text in addition to new argument text. Parser layout now forwards typography options, and unspecified SVG fonts use the SVG serif default. Strict entry-point TypeScript checking still passes. No runtime or regression execution was introduced.

Reported cross-owner wiring gaps to their owners for resolution: prepared-payload paste must propagate nested failures synchronously into compound file-import rollback; quick-action/rename callback naming; facade assets panel opener preservation; mount failure cleanup; initialization refit durability; and standard host-level MCP error/idempotency transport. These reports are static findings, not assertions that they remain unresolved after subsequent parent/owner edits.

## Regression phase after implementation barrier `f86e063`

Fresh tests were authored only after the parent explicitly opened the regression phase. The test inputs are synthetic and independently written; the original host's authored `src/sample.js` sample/blank document functions are additionally exercised as permitted integration inputs. No inherited test body was read or copied. The test environment is the existing Node Vitest configuration: there are no service endpoints, network calls, production credentials, telemetry or external writes in these suites. MCP uses the real A document/transaction/geometry and D component/style domains; the RenderView boundary and font/host durability callbacks are explicit test doubles. Those doubles do not establish browser rendering or real persistence parity.

Latest lane run: `node node_modules/vitest/vitest.mjs run editor/__tests__/formats.test.ts editor/__tests__/mcp.test.ts` — **2 files passed, 121 tests passed** (35 formats + 86 MCP). The full project's `node node_modules/typescript/bin/tsc --noEmit` also passed. No commits or uploads were made.

| Matrix IDs | Fresh evidence |
|---|---|
| DOC-02, FMT-02 | Legacy placement/default IDs/sizes; actual authored sample/blank open; local nested frame/path coordinates; current-model input isolation; ordered multipage metadata, string editorPage association, root layer bookkeeping; advanced layout/text/path/boolean/component/mask/grid/export/style/vector wrappers; opaque metadata and domain-record round trip; malformed geometry rejection |
| FMT-01, LAY-01/02 | Rich inline runs/entity/br without browser heading defaults; analytic flex/grid/repeat/ellipse/image geometry; ignored CSS warnings; safe inline SVG XML case/viewBox; HTML export paragraph/alias/size limits; executable markup, attributes, URLs, classes, malformed input and CSS rejection |
| FMT-02, GEO-01 | Analytic path command endpoints and quadratic/arc conversion; compact/invalid arc flags; real cubic extrema instead of control hull; affine/skew/viewBox meet alignment; transformed path/use references; unsupported group clip/positioned-text pictures; cycle/script/unsafe URL/path grammar rejection |
| MCP-01 | All 19 exact names, closed argument schemas, each valid/unknown-property envelope, numeric/array/enum and semantic bounds; every tool dispatched; standard text/image/structured revision responses; alias-tagged HTML, styles, screenshots, search/tree caps, 200-component pagination, configured providers, no fake provider assets |
| MCP-02 | Single author-labelled transaction per compound write; later batch refs; invalid batch/delete/component rollback including aliases/component records/history; self-descendant/invalid replacement refusal; all read tools available while user transaction blocks writes/Undo; author/user/projection isolation; queue ordering; deadline, endSession/dispose and busy recheck; idempotency order normalization/key collisions; argument snapshot isolation; owned-global disposal; host durability wait |
| CMP-01/02/03 | All 12 actions through MCP and real domains; text/boolean/swap property transport; invalid property/duplicate-variant rollback; cross-page variant result/measurement; copied main becomes instance; nested instance swap isolation; real domain-backed paginated records |
| TEXT-03, HIST-01 | First text run style preservation, font preflight, injected shared bounds/clip/fallback diagnostics; standalone latest-author Undo; authoritative host Undo after normalized local projection and explicit host refusal |

Defects reproduced and fixed in this phase:

- Legacy `figure`/page props could override the resolved canonical factory type, causing `Invalid layer` on the authored host sample. Canonical type is now explicit.
- HTML's isolated shared-layout scene used a noncanonical root ID, preventing B's layout walk. It now uses the shared canonical root.
- Canonical empty paint arrays could erase a legacy explicit-null clear sentinel. Unchanged clear sentinels are retained on export.
- CSS updates bypassed the inert declaration URL/expression checks. The same safety parser now guards updates and compound writes roll back on rejection.
- Queued requests kept a caller's mutable argument object. Inputs are now cloned at submission before queueing/idempotency execution.
- SVG arcs needed the standards grammar for compact binary flags; invalid flags are refused and compact flags parse correctly.
- Imported SVG curve bounds used the control hull. The importer now delegates canonical records to A's analytic `pathBounds`.
- A normalizing local projection could hide eligible durable agent Undo. When a host Undo adapter is configured, that adapter authoritatively checks current history ownership; standalone local checks remain in effect.
- The fresh nested swap test exposed a D domain reconciliation issue. D corrected outer-owned bindings and frame/leaf source changes, and the same unweakened E test now passes.

Remaining evidence gaps belong to the broader parent verification phase: actual browser typography/raster/DOM line metrics, file decoding/native save/cancel/errors, real host durability and two SDK authors/four TLS participants, UI/clipboard/IME/touch interaction, packaging and provenance/legal review. These Node suites do not establish those outcomes, and the view/font/durability boundaries are explicitly mocked here.
