# Reference projects and dependency evaluation

[Native plan](../NATIVE_ENGINE_PLAN.md) · [Implementation guide](IMPLEMENTATION_GUIDE.md) · [Rendering contract](RENDERING_AND_INTERCHANGE.md) · [Qualification](QUALIFICATION.md)

**Source review date:** 2026-11-11. **Status:** researched implementation inputs; no native dependency stack has yet been qualified in Oh My Canvas.

This catalog tells an implementer where to study existing code, which parts to evaluate as dependencies, and what evidence permits adoption. A repository's description, benchmark or supported platform list is not evidence that our editor meets its own correctness or performance requirements. The application continues to own document semantics, commands, persistence, collaboration, scheduling and resource budgets.

## 1. Selection policy and source snapshots

The commits below are immutable reading snapshots of upstream sources reviewed for this plan. They are **not a tested compatible dependency lock**. In particular, Blitz's own manifest pins some dependencies to different revisions from their current upstream heads. Start a Blitz experiment with its coherent dependency graph, then record the resolved lockfile, feature flags, target triple, Rust toolchain and native build inputs. Do not combine the newest version of every crate independently.

“Starting candidate” means the implementation begins with that component behind our adapter and must pass the experiments below. “Reference/alternative” means it is not a required dependency. Failure changes the adapter or selected implementation; it does not silently remove a required capability.

| Project and immutable snapshot | Role and initial disposition | Declared license evidence at that snapshot |
| --- | --- | --- |
| [Blitz `e65ec76e`](https://github.com/DioxusLabs/blitz/tree/e65ec76e1568a69ed83cbb4b94797db088607ec4) | Reference implementation and optional integration candidate for native HTML/CSS | [Workspace](https://github.com/DioxusLabs/blitz/blob/e65ec76e1568a69ed83cbb4b94797db088607ec4/Cargo.toml): `MIT OR Apache-2.0`; [`stylo_taffy`](https://github.com/DioxusLabs/blitz/blob/e65ec76e1568a69ed83cbb4b94797db088607ec4/packages/stylo_taffy/Cargo.toml) also offers `MPL-2.0` |
| [html5ever `a027c283`](https://github.com/servo/html5ever/tree/a027c2835472d518893c906dc29c42200af3c960) | Starting HTML parser candidate | [Workspace](https://github.com/servo/html5ever/blob/a027c2835472d518893c906dc29c42200af3c960/Cargo.toml): `MIT OR Apache-2.0` |
| [Stylo `32359dc3`](https://github.com/servo/stylo/tree/32359dc3f17780ee269980cb7a3a7f8597a1dc0e) | Starting CSS cascade/style candidate | [`stylo` package](https://github.com/servo/stylo/blob/32359dc3f17780ee269980cb7a3a7f8597a1dc0e/style/Cargo.toml): `MPL-2.0`; inspect other packages separately |
| [Taffy `5f3f035e`](https://github.com/DioxusLabs/taffy/tree/5f3f035e0a461db4f321af8e2ecf47abd2b709a0) | Starting box-layout candidate | [Package](https://github.com/DioxusLabs/taffy/blob/5f3f035e0a461db4f321af8e2ecf47abd2b709a0/Cargo.toml): `MIT` |
| [Parley `36f82852`](https://github.com/linebender/parley/tree/36f82852f0516108586e9f5a7b0056e872c1f933) | Starting text-layout candidate | [Workspace](https://github.com/linebender/parley/blob/36f82852f0516108586e9f5a7b0056e872c1f933/Cargo.toml): `Apache-2.0 OR MIT`; bundled fonts have separate notices |
| [rust-skia `982dc49d`](https://github.com/rust-skia/rust-skia/tree/982dc49d2377895283fe333b5b08e3ee7e57dec5) | First graphics-backend candidate; native Metal first on macOS | [Bindings license](https://github.com/rust-skia/rust-skia/blob/982dc49d2377895283fe333b5b08e3ee7e57dec5/LICENSE): MIT; underlying Skia and third parties are separate |
| [AnyRender `34debe75`](https://github.com/DioxusLabs/anyrender/tree/34debe75bdc5071576bde2d7bb4883d405259996) | Optional Blitz-to-renderer adapter, including Skia | [Workspace](https://github.com/DioxusLabs/anyrender/blob/34debe75bdc5071576bde2d7bb4883d405259996/Cargo.toml): `MIT OR Apache-2.0` |
| [winit `b31115a6`](https://github.com/rust-windowing/winit/tree/b31115a6eeb882ac2aaa886ac6371aa2cf642933) | Starting native window/event-loop candidate | [Workspace](https://github.com/rust-windowing/winit/blob/b31115a6eeb882ac2aaa886ac6371aa2cf642933/Cargo.toml): `Apache-2.0` |
| [AccessKit `dea43841`](https://github.com/AccessKit/accesskit/tree/dea4384134abe5d7b0734f56a0fdd8b80a16dfdd) | Starting accessibility-tree/platform adapter | [Workspace](https://github.com/AccessKit/accesskit/blob/dea4384134abe5d7b0734f56a0fdd8b80a16dfdd/Cargo.toml): `MIT OR Apache-2.0`; retain its additional [Chromium notice](https://github.com/AccessKit/accesskit/blob/dea4384134abe5d7b0734f56a0fdd8b80a16dfdd/LICENSE.chromium) where applicable |
| [GPUI in Zed `985bbf42`](https://github.com/zed-industries/zed/tree/985bbf42e684ef5b5a9312a6abf075aeafbaf5b9/crates/gpui) | Alternative controls/application framework | [GPUI package](https://github.com/zed-industries/zed/blob/985bbf42e684ef5b5a9312a6abf075aeafbaf5b9/crates/gpui/Cargo.toml): `Apache-2.0`; this does not describe every crate in Zed |
| [Vello `6293f3b7`](https://github.com/linebender/vello/tree/6293f3b74498582752c3734888608030dfd8cc0e) | Alternative graphics implementation | [Workspace](https://github.com/linebender/vello/blob/6293f3b74498582752c3734888608030dfd8cc0e/Cargo.toml): `Apache-2.0 OR MIT`; example assets have separate notices |
| [Yrs `e0b476b0`](https://github.com/y-crdt/y-crdt/tree/e0b476b0ce613453c70d0bb477b955808aa79a07) | Starting CRDT candidate behind the document adapter | [`yrs` package](https://github.com/y-crdt/y-crdt/blob/e0b476b0ce613453c70d0bb477b955808aa79a07/yrs/Cargo.toml): `MIT` |
| [Paper Shaders `e7003a2d`](https://github.com/paper-design/shaders/tree/e7003a2d4e6e932e30b8fa11ec1239e6ea48e16a) | Reference algorithms and parameter contracts for bounded native effect ports | [`LICENSE`](https://github.com/paper-design/shaders/blob/e7003a2d4e6e932e30b8fa11ec1239e6ea48e16a/LICENSE): Apache-2.0; preserve [`NOTICE`](https://github.com/paper-design/shaders/blob/e7003a2d4e6e932e30b8fa11ec1239e6ea48e16a/NOTICE) for incorporated material |

The native application may link native C/C++ libraries such as Skia. “Rust application” does not mean every dependency is implemented in Rust. “No browser DOM” means no required browser execution/rendering engine; a native semantic tree or a bounded native DOM projection is compatible with the target.

## 2. Blitz: the most relevant integration reference

Blitz's reviewed [README](https://github.com/DioxusLabs/blitz/blob/e65ec76e1568a69ed83cbb4b94797db088607ec4/README.md) describes a modular HTML/CSS engine and explicitly labels it beta. Its [CSS status page](https://blitz.is/status/css) is a useful changing inventory, not a conformance guarantee. The current code has separable parsing, style/layout, paint and shell boundaries; these are the useful reference points for this rewrite.

### Code reading order

| Order | Pinned code landmark | What to learn and adapt |
| --- | --- | --- |
| 1 | [`blitz-html/src/html_sink.rs`](https://github.com/DioxusLabs/blitz/blob/e65ec76e1568a69ed83cbb4b94797db088607ec4/packages/blitz-html/src/html_sink.rs) | How an html5ever `TreeSink` creates native nodes. Our import sink must preserve source mappings, diagnostics and stable design identity. |
| 2 | [`blitz-dom/src/document.rs`](https://github.com/DioxusLabs/blitz/blob/e65ec76e1568a69ed83cbb4b94797db088607ec4/packages/blitz-dom/src/document.rs) and [`mutator.rs`](https://github.com/DioxusLabs/blitz/blob/e65ec76e1568a69ed83cbb4b94797db088607ec4/packages/blitz-dom/src/mutator.rs) | Native document ownership and mutation entry points. Our validated command authority must remain in control of persistent edits. |
| 3 | [`blitz-dom/src/stylo.rs`](https://github.com/DioxusLabs/blitz/blob/e65ec76e1568a69ed83cbb4b94797db088607ec4/packages/blitz-dom/src/stylo.rs) | The adapter exposing native nodes to Stylo and translating style invalidation. |
| 4 | [`stylo_taffy/src/lib.rs`](https://github.com/DioxusLabs/blitz/blob/e65ec76e1568a69ed83cbb4b94797db088607ec4/packages/stylo_taffy/src/lib.rs) and [`blitz-dom/src/resolve.rs`](https://github.com/DioxusLabs/blitz/blob/e65ec76e1568a69ed83cbb4b94797db088607ec4/packages/blitz-dom/src/resolve.rs) | Conversion from computed CSS into layout inputs and ordering of style/layout work. Inspect invalidation cost before applying it to huge pages. |
| 5 | [`blitz-dom/src/stylo_to_parley.rs`](https://github.com/DioxusLabs/blitz/blob/e65ec76e1568a69ed83cbb4b94797db088607ec4/packages/blitz-dom/src/stylo_to_parley.rs) | Mapping CSS font/text properties into the text engine, including explicit font-feature handling. |
| 6 | [`blitz-paint/src/lib.rs`](https://github.com/DioxusLabs/blitz/blob/e65ec76e1568a69ed83cbb4b94797db088607ec4/packages/blitz-paint/src/lib.rs) and [`render.rs`](https://github.com/DioxusLabs/blitz/blob/e65ec76e1568a69ed83cbb4b94797db088607ec4/packages/blitz-paint/src/render.rs) | Translating a laid-out tree into drawing commands. Keep layout, hit testing and the display list on one revision. |
| 7 | [`blitz-shell/src/lib.rs`](https://github.com/DioxusLabs/blitz/blob/e65ec76e1568a69ed83cbb4b94797db088607ec4/packages/blitz-shell/src/lib.rs) | Window/events, IME, clipboard and platform hooks. These hooks need actual editor integration and platform testing. |

### What we can reuse

The first experiment has two implementations of the same scene: (A) a bounded Blitz projection driven from our canonical entities, and (B) direct adapters to the component libraries. Both receive the same semantic edits. Neither may treat Blitz node IDs, resolved styles or render caches as the durable collaborative schema. A style/layout projection may be rebuilt or evicted without changing canonical identity or Undo.

The reviewed [workspace manifest](https://github.com/DioxusLabs/blitz/blob/e65ec76e1568a69ed83cbb4b94797db088607ec4/Cargo.toml) connects `blitz-paint` through AnyRender and includes a Skia backend dependency. Therefore, evaluate the existing drawing adapter before writing a new one. This is a possible implementation shortcut; it does not establish mask, blend, font, GPU-residency or export parity.

Do not import the browser demonstration's lifecycle, arbitrary networking or scripting as application policy. Our resource resolver admits owned local assets and explicit imports. Any required external fetch has the same permission and cancellation rules as other import jobs. Background layout and MCP screenshots must work without starting the shell crate or opening a window.

### Blitz adoption experiment, `DEP-01`

Use one real imported page and a synthetic HTML fixture containing nested flex/grid, inherited variables, mixed text, clipping, transformed images, masks and effects. Change widths through 1440/768/390; edit a token, one text range and one child order; obtain the same region from a visible canvas and a headless screenshot. Add 100,000 simple nodes in a separate scaling fixture, then mutate a single leaf and a global style while collecting nodes visited and allocated bytes.

Pass requires the rendering/semantic cases in [the rendering contract](RENDERING_AND_INTERCHANGE.md), stable IDs and authored constraints after round trip, bounded projections, no shell dependency in headless mode, and measured isolation under [the qualification workload](QUALIFICATION.md). Every unsupported required feature is a failing case, not a skipped success. Record the integration surface and code needed for A and B. Select the lower-maintenance passing implementation. If A cannot meet ownership or residency boundaries, retain Blitz as a reference and use B; do not maintain two competing document authorities.

## 3. Parsing, CSS, layout and text components

### html5ever and Stylo

html5ever supplies parsing; the [parser entry point](https://github.com/servo/html5ever/blob/a027c2835472d518893c906dc29c42200af3c960/html5ever/src/lib.rs) and Blitz sink above illustrate the boundary. It does not supply our editable design model, CSS policy, resource ownership or export strategy. Test malformed HTML, fragment parsing, text/element identity and rejected active content before adding optimizations.

For Stylo, begin with [`style/dom.rs`](https://github.com/servo/stylo/blob/32359dc3f17780ee269980cb7a3a7f8597a1dc0e/style/dom.rs), [`style/traversal.rs`](https://github.com/servo/stylo/blob/32359dc3f17780ee269980cb7a3a7f8597a1dc0e/style/traversal.rs) and [invalidation](https://github.com/servo/stylo/tree/32359dc3f17780ee269980cb7a3a7f8597a1dc0e/style/invalidation). The integration must distinguish authored rules from computed values and retain dependency information for selectors, inheritance, variables and viewport changes. The CSS support level remains the one specified by this project, even if Stylo understands a larger syntax surface.

`DEP-02` compares the versioned CSS fixture matrix against the reference results, then tests local versus ancestor/token/viewport invalidation. Report both correctness and work visited. If integration cost is unacceptable, a smaller project-owned style resolver is allowed only when it passes the same required matrix; omitting cascade or variable semantics requires a recorded scope change, not a renamed importer.

### Taffy

Study [tree traits](https://github.com/DioxusLabs/taffy/blob/5f3f035e0a461db4f321af8e2ecf47abd2b709a0/src/tree/traits.rs), [layout cache](https://github.com/DioxusLabs/taffy/blob/5f3f035e0a461db4f321af8e2ecf47abd2b709a0/src/tree/cache.rs) and [layout algorithms](https://github.com/DioxusLabs/taffy/tree/5f3f035e0a461db4f321af8e2ecf47abd2b709a0/src/compute). The engine can adapt its own entity storage rather than duplicating the complete document into a second permanent tree. Text and replaced-element intrinsic measurements must come from the same resource/layout service used for rendering.

`DEP-03` tests nested percentage/auto/min/max sizing, wrapping, flex/grid changes, text measurement invalidation and a child whose size changes an offscreen ancestor. Compare cached and freshly recomputed results after each operation. A cache hit is acceptable only when its constraints, style revision, content and font inputs still match. If a required layout case fails, add an adapter correction or upstream fix with a regression; do not convert the frame to absolute positions to hide the failure.

### Parley

The [Parley API description](https://github.com/linebender/parley/blob/36f82852f0516108586e9f5a7b0056e872c1f933/parley/README.md) separates reusable font/layout contexts from produced layouts. Read [layout](https://github.com/linebender/parley/tree/36f82852f0516108586e9f5a7b0056e872c1f933/parley/src/layout), [editing](https://github.com/linebender/parley/tree/36f82852f0516108586e9f5a7b0056e872c1f933/parley/src/editing) and [editor example](https://github.com/linebender/parley/tree/36f82852f0516108586e9f5a7b0056e872c1f933/examples/editor). Use these for shaping/layout and cursor geometry; collaboration and canonical formatting operations remain ours.

`DEP-04` uses Korean IME, Arabic/Hebrew mixed with Latin, emoji sequences, combining marks, variable fonts and fallback fonts. Validate grapheme navigation, selection rectangles, line breaks, UTF-16 MCP ranges and glyph positioning in screen/screenshot/export. Pin font bytes for comparison. A backend that silently substitutes a different font or reshapes text for export fails. If Parley cannot supply a required behavior, qualify another native text adapter against the same corpus; a browser text-measurement fallback cannot satisfy the native target.

## 4. Drawing, windows and native controls

### Native Skia and AnyRender

Read rust-skia's [Metal driver example](https://github.com/rust-skia/rust-skia/blob/982dc49d2377895283fe333b5b08e3ee7e57dec5/skia-org/src/drivers/metal.rs), [surface](https://github.com/rust-skia/rust-skia/blob/982dc49d2377895283fe333b5b08e3ee7e57dec5/skia-safe/src/core/surface.rs) and [PDF driver](https://github.com/rust-skia/rust-skia/blob/982dc49d2377895283fe333b5b08e3ee7e57dec5/skia-org/src/drivers/pdf.rs). Native Skia is a native library dependency, distinct from CanvasKit's WebAssembly packaging. It does not decide which entities are dirty, keep documents small, or prevent main-thread work.

AnyRender's [core traits](https://github.com/DioxusLabs/anyrender/blob/34debe75bdc5071576bde2d7bb4883d405259996/crates/anyrender/src/lib.rs) distinguish drawing commands, window output and image output. Its [Skia implementation](https://github.com/DioxusLabs/anyrender/tree/34debe75bdc5071576bde2d7bb4883d405259996/crates/anyrender_skia/src) contains separate image, window and platform-backend paths. The reviewed [backend manifest](https://github.com/DioxusLabs/anyrender/blob/34debe75bdc5071576bde2d7bb4883d405259996/crates/anyrender_skia/Cargo.toml) is the authority for enabled native graphics features. Do not infer zero-copy presentation from the existence of a window interface.

`DEP-05` draws the same display list through direct Skia and the optional adapter: nested clips/masks, isolated blending groups, blur/backdrop dependencies, vector paths, scaled images, glyph runs and oversized export tiles. Compare pixels within the declared tolerances, export semantics, CPU/GPU allocation lifetime and presentation timing. Capture a GPU trace showing whether every frame performs a full-surface CPU readback/upload. If the adapter loses required drawing semantics or imposes that copy, keep the display-list boundary and use direct Skia. Headless screenshots may read back their requested result; ordinary on-screen presentation must not depend on screenshot readback.

Skia builds also have native toolchain and artifact provenance requirements. The pinned [bindings build guide](https://github.com/rust-skia/rust-skia/blob/982dc49d2377895283fe333b5b08e3ee7e57dec5/skia-bindings/README.md) describes source builds and prebuilt archives. Record which route the release uses, checksums and the exact Skia submodule. At this snapshot that submodule is [`47826ad8`](https://github.com/rust-skia/skia/tree/47826ad800f398b3cb4ce80b18b22860cf588ad0), with its own [license notice](https://github.com/rust-skia/skia/blob/47826ad800f398b3cb4ce80b18b22860cf588ad0/LICENSE). A clean dependency cache build and a prepared offline build are separate reproducibility tests.

### winit, AccessKit and GPUI

winit's [window/event description](https://github.com/rust-windowing/winit/blob/b31115a6eeb882ac2aaa886ac6371aa2cf642933/winit/README.md), [IME example](https://github.com/rust-windowing/winit/blob/b31115a6eeb882ac2aaa886ac6371aa2cf642933/winit/examples/ime.rs) and [clipboard example](https://github.com/rust-windowing/winit/blob/b31115a6eeb882ac2aaa886ac6371aa2cf642933/winit/examples/clipboard.rs) cover useful native seams. The application still needs controls, focus/selection policy, dialogs, menus and platform lifecycle behavior. AccessKit provides [semantic nodes](https://github.com/AccessKit/accesskit/blob/dea4384134abe5d7b0734f56a0fdd8b80a16dfdd/accesskit/src/lib.rs) and a [winit adapter](https://github.com/AccessKit/accesskit/blob/dea4384134abe5d7b0734f56a0fdd8b80a16dfdd/adapters/winit/src/lib.rs); meaningful labels, text ranges and actions are application work.

GPUI is an alternative for native controls and application state. Read its [getting-started/ownership description](https://github.com/zed-industries/zed/blob/985bbf42e684ef5b5a9312a6abf075aeafbaf5b9/crates/gpui/README.md) and the [input example](https://github.com/zed-industries/zed/blob/985bbf42e684ef5b5a9312a6abf075aeafbaf5b9/crates/gpui/examples/input.rs). Its own entities are view state, not a second collaborative authority. If chosen, integrate with its lifecycle instead of starting an independent competing winit event loop. GPUI's text system for application controls must not silently become a different layout authority for design-canvas text.

`DEP-06` compares the baseline shell and GPUI on a real inspector/layer list plus native canvas: 10,000 virtualized rows, keyboard traversal, Korean composition, clipboard, two windows at different DPI, resize/minimize/restore and screen-reader actions. Pass requires the desktop matrix in [qualification](QUALIFICATION.md), coherent canvas/font coordinates and efficient graphics interoperation. If GPUI requires an expensive canvas copy or breaks required accessibility/IME behavior, retain the baseline shell; if building controls on the baseline causes greater unresolved gaps, choose the passing framework and document the ownership adapter. Do not evaluate only a static “hello world.”

### Vello alternative

The reviewed [Vello README](https://github.com/linebender/vello/blob/6293f3b74498582752c3734888608030dfd8cc0e/README.md) distinguishes CPU, GPU and compute-research implementations with different maturity profiles. Name the exact crate in every experiment. `DEP-07` replays the same display-list corpus and resource-endurance test as `DEP-05`; it is an alternative evaluation after the baseline renderer works. A passing simple-path benchmark cannot replace mask/effect/text/export coverage. Preserve the renderer adapter so a later switch does not change canonical documents or commands.

## 5. Yrs and the replication boundary

Read [`yrs/src/doc.rs`](https://github.com/y-crdt/y-crdt/blob/e0b476b0ce613453c70d0bb477b955808aa79a07/yrs/src/doc.rs), [text](https://github.com/y-crdt/y-crdt/blob/e0b476b0ce613453c70d0bb477b955808aa79a07/yrs/src/types/text.rs), [Undo](https://github.com/y-crdt/y-crdt/blob/e0b476b0ce613453c70d0bb477b955808aa79a07/yrs/src/undo.rs), [update encoders/decoders](https://github.com/y-crdt/y-crdt/tree/e0b476b0ce613453c70d0bb477b955808aa79a07/yrs/src/updates) and the [UTF-16 benchmark](https://github.com/y-crdt/y-crdt/blob/e0b476b0ce613453c70d0bb477b955808aa79a07/yrs/benches/text_utf16.rs). Its [feature inventory](https://github.com/y-crdt/y-crdt/blob/e0b476b0ce613453c70d0bb477b955808aa79a07/yrs/README.md) is a starting point for compatibility testing, not a guarantee of compatibility with our schema, origins or retained history.

`DEP-08` exercises actual legacy updates with the pinned current Yjs implementation and candidate Yrs version in both directions. Include Unicode ranges, map deletions, concurrent parent/order changes, author Undo, missing causal updates and rejoin. Separately test the new shard schema and transaction envelopes from [storage and collaboration](STORAGE_AND_COLLABORATION.md). A legacy conversion that reseeds identities must use the explicit migration path; it must not join an old room as an equivalent replica.

Adopt only after the defined convergence/recovery checks pass and memory/restore measurements are available. If legacy wire compatibility fails, use a verified offline converter and explicit mixed-version rejection. If Yrs cannot satisfy the new schema semantics, record an alternative CRDT implementation decision before building more commands around it. Keeping a JS authority or a hidden Electron document indefinitely does not satisfy the native headless target.

## 6. Completion record for dependency experiments

Every `DEP-*` experiment produces one reviewable record containing:

1. Question, candidate revisions and exact resolved dependencies/features.
2. Reproduction commands, fixtures and hashes, fonts, hardware/platform and build mode.
3. Adapter boundaries, resource ownership and any source modifications.
4. Per-case results, unsupported cases, timings/allocations and failures; unmeasured fields are explicitly null.
5. Selected implementation, rejected alternatives, reasons, follow-up regressions and the milestone that consumes the result.

An experiment is complete when its adopter can reproduce the decision; a screenshot or a compilation-only result is insufficient. A blocking upstream issue needs a local regression and one of: a pinned fix, a maintained adapter/workaround that preserves the contract, or the documented alternative. “Wait for upstream” alone cannot close a required milestone. Use [the implementation guide](IMPLEMENTATION_GUIDE.md) for work ordering and [the capability matrix](CAPABILITY_MATRIX.md) for the coverage denominator.

## 7. Source and distribution hygiene

The license column records declarations observed in the named packages. It does not determine all obligations of a future resolved binary. Before adopting a dependency, retain its full license/notices and identify transitive native libraries, generated bindings, shaders, fonts and sample assets. Record modifications and upstream revision when adapting code; preserve their applicable notices in [third-party notices](../../THIRD_PARTY_NOTICES.md) and [implementation provenance](../independent/PROVENANCE.md).

In particular, do not apply the GPUI crate's declaration to unrelated Zed code; do not apply rust-skia's MIT declaration to Skia's third-party tree; and do not assume demonstration fonts/images are covered by a code repository's top-level license. Review Stylo's MPL-2.0 files and any modifications under their actual terms. Dependency selection must leave a reproducible notice inventory, not an unsupported “all dependencies are permissive” statement.

A public implementation must use independently authored or appropriately licensed material. Keep proprietary design sources, user files, credentials and internal review logs out of public examples. The large FIG fixture's availability in this repository is not blanket permission to reuse every third-party asset in a new distribution. Use small owned fixtures for public reproduction where redistribution rights are unclear, and report the scope of any separately authorized benchmark.

## 8. Paper Shaders: a bounded native effect-port reference

The reviewed [`@paper-design/shaders` package](https://github.com/paper-design/shaders/blob/e7003a2d4e6e932e30b8fa11ec1239e6ea48e16a/packages/shaders/package.json) declares version `0.0.82`. Its [export index](https://github.com/paper-design/shaders/blob/e7003a2d4e6e932e30b8fa11ec1239e6ea48e16a/packages/shaders/src/index.ts) and [30 shader source modules](https://github.com/paper-design/shaders/tree/e7003a2d4e6e932e30b8fa11ec1239e6ea48e16a/packages/shaders/src/shaders) define the dated reference catalog. The exact per-effect coverage list belongs in [the capability matrix](CAPABILITY_MATRIX.md); a passing mesh-gradient demo cannot stand for all effects.

Read [`mesh-gradient.ts`](https://github.com/paper-design/shaders/blob/e7003a2d4e6e932e30b8fa11ec1239e6ea48e16a/packages/shaders/src/shaders/mesh-gradient.ts) for parameter/uniform mapping and GLSL, [`shader-sizing.ts`](https://github.com/paper-design/shaders/blob/e7003a2d4e6e932e30b8fa11ec1239e6ea48e16a/packages/shaders/src/shader-sizing.ts) for coordinates/fit/scale, and [`shader-mount.ts`](https://github.com/paper-design/shaders/blob/e7003a2d4e6e932e30b8fa11ec1239e6ea48e16a/packages/shaders/src/shader-mount.ts) for the existing WebGL2, DOM and animation lifecycle. The algorithms and published parameter semantics are useful inputs. That browser mounting layer cannot be the native production renderer.

Implement a versioned built-in effect registry and reviewed native ports, initially through the qualified Skia/SkSL or equivalent backend. Preserve effect identity, algorithm version, parameters, image inputs, coordinate conventions and explicit animation time. Declare deterministic seed behavior for stochastic effects. Arbitrary JavaScript or unreviewed shader code embedded in a document is not executed. Unknown effect versions produce diagnostics and an explicit unsupported result according to [the rendering contract](RENDERING_AND_INTERCHANGE.md).

`DEP-09` compares each native effect with its pinned reference at fixture timestamps, including 0, 500 and 1000 ms where animated, with fixed resolution, pixel ratio, colors, uniforms, source images and seed. Include transparency, transformed/cropped input, zero-speed static effects, reverse/paused playback where supported, tile boundaries and repeated export. Compare within a per-effect declared tolerance; do not require bit-identical floating-point GPU output across devices without evidence. Save and replicate parameters, then reproduce the same sampled frame through GUI, headless MCP and image-sequence export.

Record GPU allocations, maximum effect surface, frame cost, cancellation and resource release. Live preview samples a clock; export samples explicit times independent of preview frame rate. Static vector export may rasterize an unsupported vector effect region only with its declared diagnostic and resolution policy. Image-sequence export is the baseline animation output; a video codec is a separately qualified adapter. If a native port fails, fix or replace that effect implementation while keeping the failed capability visible. Do not silently flatten editable parameters, skip frames, or reopen a hidden WebView to claim completion.

## 9. Paper as a product reference, not an implementation dependency

The reference workflow inventory lives in [the capability matrix](CAPABILITY_MATRIX.md). Relevant primary sources reviewed on this date are [MCP](https://paper.design/docs/mcp), [HTML paste](https://paper.design/docs/paste/html), [the dated build log](https://paper.design/build-log), [the roadmap](https://paper.design/roadmap) and [Paper Shaders](https://shaders.paper.design/).

Use the dated build log to reconcile stale pages: the October 2026 entry announces rich-text editing, while the HTML-paste page still contains an older no-rich-text statement. The August entry also documents agents working across background files. Record these source conflicts; do not turn an old limitation into the current capability ceiling. A roadmap item is not a shipped feature, and a shader catalogue is not proof of a general timeline/prototyping system. Test the required user workflow directly before declaring replacement parity.

Paper's service and agent integrations provide behavioral references. They do not become runtime dependencies, performance baselines measured under unknown conditions, or permission to copy proprietary implementation code.
