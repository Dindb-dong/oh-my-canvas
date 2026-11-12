# Native editor shell and retained canvas contract

Status: implementation contract, 2026-11-12. Baseline: `origin/main` at `efe1421e` (PR #33). This contract specifies a bounded native-preview milestone; completed checks and runtime evidence must be recorded separately. It supplements `DESIGN.md` and the existing native-engine contracts.

## Outcome and boundaries

Make the existing Rust native editor feel like a coherent design tool: a compact document strip, clear page/layer hierarchy, a floating bottom tool palette, an organized property inspector, and selection dimensions. Use the composition of the user-supplied FigCraft reference while retaining Oh My Canvas identity and behavior. Reduce repeated scene painting during shell and selection updates using a bounded retained raster, with correctness tests and measured evidence.

Keep the current `winit` + `softbuffer` + CPU Skia host, native scene/layout/rendering crates, service-backed document model, local storage, HTML/import/export behavior, and existing MCP contract. The native preview remains opt-in and Electron remains the default. No document migration, dependency addition, framework replacement, upstream source transplantation, application replacement, release, merge, or deployment is part of this milestone.

FigCraft supplies a visual and architectural reference, not a file-format or API compatibility promise. Do not copy its branding, proprietary example documents, or unverified assets. OMC's existing licensed icon assets and design tokens remain authoritative.

## Evidence informing the change

The baseline native shell is concentrated in `native/apps/omc-desktop/src/paint.rs`: `controls()` builds hit targets and `render()` paints the entire shell and scene. Its purple accent conflicts with `DESIGN.md`'s blue. The 94 px header contains two rows of text buttons; the inspector is hidden below 1050 px. `draw()` renders, reads, and copies the entire window on each redraw. `paint_scene_preview()` repaints scene content even when only selection or control focus changes.

`app.rs` already builds scenes in a worker, rejects replies for the wrong document/page/revision, and supplies drag translations. Preserve those mechanisms. A second asynchronous raster worker, overscan, GPU rendering, tiles, and offscreen scene culling are deferred: each introduces additional invalidation or compositing risks and is unnecessary for this first measurable improvement.

## Design contract

Before visual code changes, establish an editable project-specific board through local OMC MCP, with reusable components and linked instances for the document tab, tool button, layer row, and inspector field. Include selected/focused states and desktop compositions at 1440 × 900 and 960 × 640. Include a representative Korean text object, long names, nested layers, and an empty selection. Save and read back the board; record its stable identifiers and shareable source in the maintained design handoff. Review the board before implementation and compare it with actual runtime screenshots afterward. A board is not runtime proof.

Use OMC's neutral white/gray shell, `#2563eb` action/selection blue, `#eff6ff` selected background, `#202124` main text, and `#e5e5e5` borders. Use the existing typography and fallback path; keep working Korean glyph shaping and font fallback. No decorative gradients or new dark theme. Reuse licensed Tabler outlines or simple drawn geometry for tool icons, never Unicode pictograms. Icon-only controls retain meaningful accessible labels and visible focus.

| Region | Required result | Existing behavior to retain |
|---|---|---|
| Document strip | One compact, calm strip with OMC identity, active document tabs, and clearly separated file actions. Keep text truncated within its own target; close targets must not overlap adjacent tabs or file actions. | Open/close, New, Import, Export, Save, Rename, actual status/error reporting. Do not add inactive collaboration/share controls. |
| Left navigation | A narrow identity/navigation area and a visually distinct pages/layers panel. Keep page controls clear and the layer list readable with indentation, selection and expansion state. A decorative rail must not suggest destinations that do not exist. | Page add/rename/select, document access, layer selection/expansion and scrolling. Do not silently drop existing actions to match a reference. |
| Canvas | Quiet gray workspace, uninterrupted editing area, crisp blue selection and handles; a small dimensions label for a supported selected shape. | Hit testing, drag preview, resize, pan, zoom, marquee, text editing and error overlays. Dimensions are read from real scene bounds and do not mutate nodes. |
| Bottom palette | Centered floating palette inside the viewport containing the existing six tools: Select, Frame, Rectangle, Ellipse, Text, Pan. Clearly show the active tool. Keep Undo/Redo/Fit discoverable without recreating a top button wall. | Existing commands and keyboard shortcuts. Palette receives clicks before canvas input and never creates a node through a control. |
| Right inspector | Neutral white surface, clear section hierarchy, compact aligned field pairs where existing semantics permit, visible selected-node identity and existing Design/Text/Assets modes. | Existing properties, catalogs, input validation and scrolling. No removed property merely for visual simplicity. |
| Status | Quiet status area with actual save/error state and zoom. | Preserve recovery text and errors. Technical revision/count metadata may remain secondary but must not dominate the shell. |

At 960 × 640, keep the inspector usable rather than hiding it at 1050 px. Reuse panel widths near the current 228/240 px where possible; the remaining viewport is sufficient for a compact six-tool palette. No control may leave the client area, overlap an unrelated hit target, or obscure the active text-edit field. Use shared geometry for painting, hit testing, focus and accessibility. Toolbar placement must account for the existing text-edit overlay; while editing, move or suppress the palette instead of covering input. Preserve macOS titlebar traffic-light clearance and test actual client-area geometry.

This milestone does not promise full tab overflow navigation, new page-management features, a redesigned library, native OS IME qualification, or a newly complete accessibility implementation. Preserve existing supported behavior and explicitly report any baseline limitation encountered in the required flows.

## Retained canvas contract

Cache only document content, underneath shell controls and live overlays. Selection outlines, dimensions, handles, marquee, caret/preedit, editing panels, errors and toolbar are repainted every frame. Keep `omc-render`'s document/export semantics unchanged.

Use a single desktop-owned cached image, bounded to at most 32 MiB of retained RGBA pixel storage. If size arithmetic overflows, dimensions are invalid, allocation fails, or the budget would be exceeded, skip caching and use the existing direct painter. Keep the existing frame-surface budget. Drop obsolete images rather than accumulating a per-document cache. The additional cache memory must be reported separately from total process/frame allocations.

An exact cache key must identify:

- The accepted scene generation, incremented whenever a scene/resources result is installed; document sequence alone is insufficient across documents and resource replacement.
- The viewport's physical size, device scale factor, and exact camera translation and zoom.
- Any other content-affecting input actually admitted to the cached path.

Invalidate on active document/page transition, scene/resources replacement, viewport resize, scale change, and camera change. Never cache partial/failed painting as a valid result. With `Drag::Move` or any nonempty preview translation, bypass the static cache so geometry is not frozen; the unchanged retained image may be reused after a cancelled preview only if its key still matches. Existing resize/draw preview overlays remain live. A late scene reply must still pass existing document/page/revision checks before becoming visible.

Prefer a small new desktop-local cache module with explicit lookup/store/clear and checked byte accounting. The integration owner decides the minimal borrowing shape; avoid a generic renderer abstraction or new dependency. The screenshot path must exercise the same composition order as the displayed window. Pixel alignment at 1× and 2× must not introduce an extra resampling blur or clipped edge.

## Parallel ownership and shared boundary

Commit and push this contract first as requested, then start the two independent implementation lanes. Do not open a PR before implementation and verification are complete.

| Owner | Exclusive files/responsibility | Boundary |
|---|---|---|
| Shell worker | `native/apps/omc-desktop/src/paint.rs`, `inspector.rs`; shell-local tests in those files | Own controls, visual drawing and inspector placement. Reuse `Action`, `Tool`, and `Control`; agree any new fields or constants with the integrator. Preserve a clearly marked single scene-paint call site for later cache integration. Do not edit app/event plumbing or renderer crates. |
| Cache worker | New `native/apps/omc-desktop/src/scene_cache.rs` and its unit tests | Own exact key, retained image lifecycle, budget/fallback rules, cache correctness checks and bounded measurement helper/test. Export the smallest concrete interface. Do not edit `paint.rs`, `app.rs`, `main.rs`, or shared crate APIs. Send required call-site changes to the integrator. |
| Integration owner | `app.rs`, `main.rs`, `geometry.rs`, `accessibility.rs`, `text_ui.rs` only as needed; `DESIGN.md`, this contract's final handoff, test fixture/evidence | Own canvas board, layout constants, cache scene-generation/invalidation state, event routing, shared signatures, final cache call-site wiring after shell worker finishes, runtime checks, review, commits and authorized delivery. |

Workers are not alone in the codebase: preserve other edits and coordinate requests rather than editing another owner's files. Freeze layout constants and cache API before integration. Avoid splitting `paint.rs` between simultaneous authors. Do not change Cargo dependencies or lockfiles unless a demonstrated blocker makes it unavoidable; none is expected.

## Validation and acceptance

Use an isolated temporary native profile and task-owned fixture. Do not open or migrate user documents for tests. Use one representative document with two pages, nested layers, rectangle/ellipse, Korean and Latin text, and a selection large enough to verify dimensions. Include a small image/gradient fixture for cache comparison if supported by existing helpers.

1. **Layout and interaction:** test or assert control bounds and non-overlap at both target window sizes. Run the actual native window, switch tools, draw/select/move/resize, use Undo/Redo, change a property, switch page/tab, and Save/reopen. Inspect screenshots at 1440 × 900 and 960 × 640; capture a short interaction recording. Confirm Korean text is readable, property input works, and palette clicks do not fall through to the canvas. Verify keyboard focus and active-tool state. If OS IME composition cannot be exercised, distinguish text rendering from OS input verification.
2. **Cache correctness:** verify a hit skips the expensive scene painter, unchanged selection/focus updates keep a hit, and scene generation, camera, viewport or scale changes cause misses. Verify document/page transitions cannot reuse old content; movement previews bypass; failed renders are not stored; oversize/allocation failure paths fall back. Compare cached and direct pixels for a deterministic representative scene at 1× and 2×, including a camera offset. Overlays must reflect current selection on a cache hit.
3. **Measurement:** on the same machine/build/fixture, warm up and measure at least 30 repeated stationary-viewport redraws in direct versus cached mode; report median and p95 render/composition time plus scene-paint invocation counts and retained bytes. A cache hit must cause zero scene repaints after warmup. Report a cold-cache sample separately. Timings describe this workload only; do not advertise general pan/zoom acceleration, 60 fps, or W1–W7 qualification. Investigate a warmed-path regression before retaining the optimization.
4. **Focused checks:** run `cargo fmt --all --check` and `cargo test --locked -p omc-desktop` from `native/` first. Build `omc-desktop`, `omc-service`, and `omc-cli` with the pinned toolchain. Run the existing native MCP E2E suite to demonstrate the shell/cache change has not broken service integration. Run full workspace tests if shared contracts changed or integration reveals a relevant concern; otherwise record the focused scope honestly.
5. **Runtime smoke:** run `target/debug/omc-desktop --profile <task-profile> --smoke-exit-ms 2000 --screenshot <task-image>` and inspect the produced image. An empty-window smoke alone does not satisfy populated-editor or interaction acceptance. Use the repository runner for repeatable assertions and native UI tooling for one-off interaction/visual evidence.
6. **Platform and storage limits:** macOS is the available execution target. Keep code portable, report Windows/Linux runtime and packaging as not run, and do not treat compilation as their runtime proof. The host currently has approximately 41 GiB available: remeasure before building, reuse a compatible Cargo target/cache, avoid duplicate release/debug builds and new container images, and stop expanding build scope if storage headroom becomes unsafe. Preserve shared and unrelated artifacts.

A complete milestone means the reviewed shell is implemented, the cache passes its correctness and measurement criteria, actual editing flows remain usable, and delivery states its real evidence and gaps. If a required runtime or performance check is blocked, report that work as incomplete rather than replacing it with a static or build-only claim. Keep internal logs and private local evidence under the primary checkout's ignored `internal/docs/`; publish only shareable design/runtime artifacts, with no public links to private internal paths.

## Explicitly deferred

- egui/tiny-skia adoption, asynchronous raster workers, latest-wins raster queues, overscan, tiling, GPU acceleration and global renderer refactoring.
- New tools or inspector capabilities, full library redesign, native OS menu redesign, collaboration changes, storage/schema migration and MCP/API redesign.
- Full native/Electron parity, comprehensive OS IME/screen-reader qualification, Windows/Linux packaging, and W1–W7 certification.
- Merge, release, installation replacement, deployment and destructive cleanup without separately applicable authorization.

## Trackpad pan follow-up

The stationary cache includes the camera translation, so ordinary trackpad scroll previously invalidated it on every frame. During canvas pan, draw a matching retained image at the new device-pixel offset and render overscan on one background worker. Keep at most one job in flight and refill near the edge of the retained image. Reject previews across scene generations, viewports, device scales or zooms. A fast move past overscan can expose workspace color until the worker catches up. Keep the worker-rendered, device-aligned view after pan settles so stopping does not trigger a synchronous scene repaint. Use the exact path for screenshots and return to it on scene changes, fit or zoom. Preserve direct drawing for editing previews and unsupported or unavailable raster paths.

The stationary raster remains bounded to 32 MiB. The pan worker and its retained image use up to 24 MiB each. The window presentation path reads the native Skia raster in place and writes RGB to the softbuffer, with the reserved byte cleared. This removes the additional full-window byte buffer. Skip repainting on idle pointer moves that do not change control hover, and build accessibility updates only when the adapter is active. The desktop still composites through a CPU window buffer.
