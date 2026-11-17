# Native implementation and measurement map

**Source baseline:** [`ad7a58d147d1987589e147fb92b51155118b90a5`](https://github.com/Dindb-dong/oh-my-canvas/tree/ad7a58d147d1987589e147fb92b51155118b90a5), inspected on 2026-11-17. Line positions below refer to that baseline. Links to repository files are convenient navigation; use the pinned revision when reproducing this audit.

**Evidence class:** source inspection. This document reports implemented paths, test-harness scope, hypotheses, and instrumentation requirements. It does not report a new benchmark run, a product comparison result, or successful completion of the native qualification gates. Proposed spans, counters, and experiments below are not implemented by this documentation change.

## 1. What the implementation actually does

The native implementation contains a structured, editable document model, an attributed operation engine, SQLite persistence, document worker processes, a workspace service, a native desktop, and a browser-free rendering path. HTML/CSS is an authoring and interchange interface to that model. It is not the sole canonical representation of an arbitrary browser DOM or executable web application.

The principal paths are:

| Path | Implementation | What the distinction means for a benchmark |
| --- | --- | --- |
| AI or desktop mutation | Command adapter → workspace admission → document worker → engine candidate → SQLite transaction and durable receipt | Measure model/tool overhead separately from durable engine execution. |
| Desktop update after a normal mutation | Command response → full `document.snapshot` RPC → snapshot installation → background scene build → draw submission | A fast command receipt does not establish a fast visible edit. |
| External edit becoming visible | Desktop periodically requests the active document's full snapshot → changed revision schedules a scene build | Agent-to-visible latency includes polling delay and reconstruction. |
| Native scene | Component projection → authored/computed CSS → fresh Taffy layout tree → scene items and text → Skia | Page selection bounds emitted scene content, but some preparation traverses the whole document. |
| Desktop presentation | macOS Metal path when available; otherwise software raster and a row copy into the presentation buffer | Record the actual presentation backend, not only the crate feature list. |
| Agent screenshot/export | Service-side snapshot, layout, render and encoding paths | Offscreen output is not a measurement of interactive display presentation. |

[Native README](../../native/README.md) still states that the existing Electron application remains the default until the original native completion gates pass. [The native capability matrix](../native-engine/CAPABILITY_MATRIX.md) and [qualification guide](../native-engine/QUALIFICATION.md) explicitly pin their initial 2026-11-11 planning state. Their initial `NOT_RUN` labels are not an inventory of all code added since that date; their target values are not measured results either.

## 2. Evidence ledger

The observations in this ledger are directly supported by source. The performance consequences are hypotheses to measure.

| ID | Source and baseline location | Observed behavior | Measurement implication |
| --- | --- | --- | --- |
| N01 | [Model](../../native/crates/omc-model/src/lib.rs), `Node` at 131; `DocumentContent` at 304; `DocumentSnapshot` at 384 | A document has pages, a map of stable node identities, properties, and metadata. Nodes retain hierarchy and ordering. | Record authored nodes, projected component nodes, pages, depth, and metadata separately. HTML byte length alone does not describe workload size. |
| N02 | [Style](../../native/crates/omc-style/src/lib.rs), `compute_styles` at 90–147; `compute_one` at 149–225 | Each call parses the document stylesheet, starts from all document node IDs, computes parent-before-child styles, and tests stylesheet rules/selectors per node. | Vary unrelated page count, tree depth, rule count, and selector structure independently of the visible scene. Track total styled nodes and selector attempts. |
| N03 | [Layout](../../native/crates/omc-layout/src/lib.rs), `layout` at 46–151 | Layout computes styles and builds child indexes over the snapshot, constructs a new `TaffyTree`, then traverses the requested root. Text measurement occurs in its measurement callback. | A small changed subtree does not currently imply small style/layout preparation. Separate style, index, Taffy construction, layout, and shaping spans. |
| N04 | [Components](../../native/crates/omc-scene/src/components.rs), `resolve_components` at 17–108 | A child index is built across the snapshot. If relevant component instances or bindings need expansion, the snapshot is cloned and projected nodes are inserted into the copy. Without them, the snapshot is borrowed. | Compare identical visible geometry with and without components, including instances on a small page in a large document. Measure expansion count and clone/peak allocation cost. |
| N05 | [Scene](../../native/crates/omc-scene/src/lib.rs), `build_scene_in_color_profile` at 291 onward; `Scene::item`/`hit_test_filter` at 132–170 | Scene construction resolves components, performs layout, and copies node data into scene items. ID lookup is a linear search; hit testing scans scene items in reverse order and checks ancestors. | Vary scene size and hit/miss location. Include an empty-space pointer path, dense overlap, nested clipping, and selection operations. |
| N06 | [Engine](../../native/crates/omc-engine/src/lib.rs), `candidate` at 654; `validate_candidate` at 1467; `execute` at 424–620 | A mutation candidate initially contains an empty node map and a shared catalog. Changed nodes and their ancestry are validated; the durable result reports changed IDs. | Localized writes have a credible incremental foundation. Verify cost as total node count, changed-node count, ancestry depth, and prior operations increase. Do not infer constant time. |
| N07 | [Storage](../../native/crates/omc-storage/src/lib.rs), `node_state` at 247–274; [sync](../../native/crates/omc-sync/src/lib.rs), `NodeState::project` at 475 | Node-state reads load the seed and all matching operations through the requested revision; projection replays live operations. | Equal visible documents with different histories may have different read/edit costs. Benchmark history length per node and catalog, not just file/node count. A WAL checkpoint is not operation-history compaction. |
| N08 | [Engine](../../native/crates/omc-engine/src/lib.rs), `project_snapshot` at 298–412 | Full snapshots enumerate retained entity IDs, reconstruct their states, project nodes, and walk ancestry for visibility and deterministic containment repair. | Time reconstruction, SQL calls/rows, operation bytes, ancestry work, allocation, and serialization. Include deleted-node history, deep trees, and old revisions. |
| N09 | [Desktop client](../../native/apps/omc-desktop/src/client.rs), `snapshot` at 533; command/Undo handlers at 895–949; [app](../../native/apps/omc-desktop/src/app.rs), polling at 4322–4330 | Ordinary edits and Undo request a full snapshot after the command. When not dragging or waiting for an edit/poll, the active document is polled after more than 750 ms. | Separate durable-response latency from full-update latency. Measure unchanged polling CPU/bytes and external-change-to-visible latency. A headless scalar-write benchmark excludes this path. |
| N10 | [Desktop client](../../native/apps/omc-desktop/src/client.rs), `Bridge::start` at 285–347; `call_limit` at 482–530 | One bridge thread handles a bounded queue of 32 requests serially. Replies are read into bytes, parsed to JSON, and converted to typed snapshots; ordinary replies have a 16 MiB limit. | Measure queue delay and copies. Treat reply-limit failures as failures/unsupported capacity, not missing slow samples. Check whether background file work delays later desktop requests. |
| N11 | [App](../../native/apps/omc-desktop/src/app.rs), scene worker at 548–655; `schedule_scene` at 1140–1190; `Event::Scene` at 3923 onward | Scene work is off the UI thread with a bounded request channel. Accepted scenes clear scene/pan/move caches and replace resources. Stale replies trigger a new scene request. | Count scheduled, accepted, and discarded builds. Test bursts and remote edits during dragging; measure the time and resource cost of discarded work. Cloning the request's `Arc` is cheap; component projection inside the worker can still clone document contents. |
| N12 | [Storage](../../native/crates/omc-storage/src/lib.rs), `verify_sqlite` at 10–42; `commit` at 445–459; `write_commit` at 477–572 | WAL, `synchronous=FULL`, and disabled automatic WAL checkpointing are configured; macOS also enables full-sync settings. A transaction writes operations, changed projections, routes/shards, frontiers, metadata, and the receipt. | Report durable acknowledgement independently of visible preview. Measure actual disk writes, WAL growth, explicit checkpoint cost, and reopen correctness. Do not weaken durability to improve a comparison. |
| N13 | [Workspace](../../native/crates/omc-workspace/src/lib.rs), `open` at 68–113; [service](../../native/apps/omc-service/src/main.rs), `workspace.list` at 276–298 | Service startup visits existing document databases to reconcile the catalog. A thumbnail-enabled listing serially snapshots and renders up to 15 nonarchived documents. | Vary saved-library size independently of open tabs. Separate process launch, catalog recovery, thumbnail readiness, first usable document, and all-content readiness. |
| N14 | [Admission](../../native/crates/omc-workspace/src/admission.rs), `acquire` at 73–172; `dispatch` at 175–218; [workspace](../../native/crates/omc-workspace/src/lib.rs), 95 | Admission-managed operations allow four active documents and one admitted operation per document, with bounded queues and weighted caller/document rotation. Some extension reads call workers directly; this is not a universal limit on all service activity. | Run one noisy document alongside other documents and compare per-client tail latency, rejection, and progress. A long full snapshot can occupy the same document admission lane as an interactive command; attribute paths that bypass this lane separately. |
| N15 | [Workers](../../native/crates/omc-workspace/src/worker.rs), `WorkerPool::call` and `run_document_worker` | Documents route to four process slots; a worker creates a serial actor per document. Process replies share a framed output channel. Local in-process mode is also available for tests. | Record worker mode and all worker PIDs. Do not describe four slots as exactly four documents of capacity or benchmark in-process mode as equivalent to the shipped service. Test large replies alongside small replies in the same process slot. |
| N16 | [Workspace](../../native/crates/omc-workspace/src/lib.rs), `read_call` at 545–555; [admission](../../native/crates/omc-workspace/src/admission.rs), 224–226; [jobs](../../native/crates/omc-workspace/src/jobs.rs), 303 and 522–524 | Metrics expose reservation and queue state. A snapshot read enters admission with a 4 KiB reservation; job reservations are estimates supplied by callers. | These counters are not observed process memory or a hard cap on snapshots, Skia surfaces, decoded pixels, JSON copies, or total heap. Sample OS memory independently. |
| N17 | [App](../../native/apps/omc-desktop/src/app.rs), snapshot insertion at 3708; close at 3734–3748; [workspace](../../native/crates/omc-workspace/src/lib.rs), `release_idle_document` at 250–278; [workers](../../native/crates/omc-workspace/src/worker.rs), `release` at 232–237 and external actor at 465–478 | Open desktop tabs retain full snapshots. Document release waits until session owners and scoped jobs no longer retain it. In external-worker mode, a successful close clears the actor's `DocumentEngine`; it does not terminate the process or remove the actor from its routing map. | Measure marginal memory per tab/document and post-close reclamation, separating document-engine state from retained actors/processes. A surviving worker PID alone does not prove a leak. Test one versus several windows, shared versus distinct assets, and active versus idle agent leases. |
| N18 | [Render](../../native/crates/omc-render/src/lib.rs), `paint_plain_rect` at 570–608; general painter at 611 onward | The simple-rectangle fast path checks a narrow property/style set and uses `quick_reject`; other visual features use the general painter. | A flat solid-rectangle benchmark is useful but favorable. Repeat with text, images, effects, masks, gradients, transforms, and offscreen complex groups. |
| N19 | [Render resources](../../native/crates/omc-render/src/resources.rs), `image_data` at 24–69 and `load_image` at 71–95; [renderer](../../native/crates/omc-render/src/lib.rs), map resource provider at 45–50 | Image access verifies the content hash, copies encoded bytes into Skia data, and creates an encoded image. The map provider returns an owned byte vector. | Measure provider reads, bytes copied/hashed, image construction, actual decode/upload, and cache reuse separately. Source-level image creation does not prove that Skia decodes every occurrence; capture backend evidence. |
| N20 | [Desktop paint](../../native/apps/omc-desktop/src/paint.rs), `draw` at 4061–4106; [Metal presenter](../../native/apps/omc-desktop/src/gpu_presenter.rs), `present` at 198–278 | The macOS GPU branch renders to a Metal drawable; fallback renders a raster surface and copies each row to softbuffer. Drawable acquisition is off the UI thread. | Match OS/backend/device scale in comparisons. Software tests cannot establish Metal performance, and a Vulkan dependency alone does not establish a Vulkan desktop presentation path. |
| N21 | [MCP mutations](../../native/crates/omc-mcp/src/mutations.rs), 213–270; [inspection](../../native/crates/omc-mcp/src/lib.rs), `inspect` at 429 | `update`, `edit_text`, and selected simple `edit_shapes` actions build an adapter snapshot from context and requested nodes. Other mutation paths obtain a full snapshot. `inspect` obtains a full snapshot before producing its requested view. | Classify workloads by actual adapter path. A small response or a limited tree depth does not prove bounded backend work. The scalar service probe selects a favorable partial-read path. |

The distinction in N21 is especially important for HTML creation. `insert_markup` in [mutations.rs](../../native/crates/omc-mcp/src/mutations.rs), 1210–1281, creates a semantic command for each imported node; ordinary drafts reject more than 100 semantic commands at lines 267–270. The limit applies to expanded commands, not simply the number of MCP calls. A large HTML fragment and a scalar update therefore need different latency, chunking, correctness, and token measurements.

The same adapter consumes imported resources and nodes, while the inspected function does not propagate `imported.content.metadata["css"]` or imported diagnostics. A targeted integration experiment must verify class-based stylesheet preservation through **the actual `write_html` route**, including readback and rendered appearance; a successful standalone HTML import test does not settle this question. This is a source-derived correctness risk, not a runtime-tested defect report. Compare only accepted outputs that preserve the required styles, and include repair attempts in their cost.

### 2.1 Token and output semantics at the native boundary

These are representation and routing observations, not measured token savings. Capture the raw MCP exchange, the client's actual model-facing projection, and provider usage separately.

| Risk or distinction | Verified source | Required measurement or quality check |
| --- | --- | --- |
| `get_tree` repeats node descriptions | [Legacy tree](../../native/crates/omc-mcp/src/legacy_read.rs), `legacy_tree` at 52–117, returns both nested `tree` and flat `nodes`. `Tree::walk` clones each row into the flat array at 163–165 before attaching nested children. Depth and a 400-node traversal cap bound the response but do not remove repeated fields. | Record raw bytes and actual projected text tokens for concise/detailed reads. Measure how much of the response is necessary for the requested edit. Do not automatically count both representations twice if the client chooses only one. |
| Screenshots can appear in several response fields | [Service response construction](../../native/apps/omc-service/src/main.rs), 759–775, serializes the full result to a text block, adds image content for supported `mimeType`/`base64` results, and also attaches `structuredContent` for object results. | Report wire/base64 bytes, client-retained text, image blocks and dimensions, and provider-billed usage. Whether encoded image data reaches the model as text, an image, both, or a deduplicated projection is client-dependent; raw envelope size is not token usage. |
| Pagination is not a subtree query | [Native `query_extension`](../../native/crates/omc-mcp/src/extensions.rs), 396–502, pins a revision and sends `revision`, raw-ID `after`, and `limit` to `query_nodes_at`. It caps each page at 200 requested nodes and truncates node payloads at 500 KiB; the worker request has no subtree/page selector. In contrast, [ordinary `inspect`](../../native/crates/omc-mcp/src/lib.rs), 429–430, first requests a full snapshot. | Compare time/bytes/tokens to locate the actual target, including all needed pages and retries. Do not call pagination a semantic filter, a document delta, or proof of constant backend cost. Test old-revision consistency and cursor release/expiry separately. |
| Tool schemas, dialect tools and command IDs are different counts | [Legacy schema source](../../native/crates/omc-mcp/src/schema.rs), 4–8, loads 50 unique entries from [`tools-v1.json`](../../native/crates/omc-mcp/schemas/tools-v1.json); [extension definitions](../../native/crates/omc-mcp/src/extensions.rs), 62–98, add nine; [router `tools`](../../native/crates/omc-mcp/src/lib.rs), 91–94, combines them. [Service `tools/list`](../../native/apps/omc-service/src/main.rs), 510–512, selects a separate FigCraft list. [FigCraft tools](../../native/crates/omc-mcp/src/figcraft.rs), 210 onward, expose wrappers such as `list_commands` and `run_command`; [the protocol wrapper](../../native/crates/omc-mcp/src/figcraft_protocol.rs), `figcraft_tools`, adds an event tool. | Record the actual dialect, `tools/list` response, client tool-selection/caching policy, and schema tokens sent on each model call. The README's 643 FigCraft command IDs are not 643 exposed MCP tools or proof of 643 schemas in every prompt. Count command-discovery responses when the agent requests them. |
| Short code may have lost reusable semantics | [Export `prepare`](../../native/crates/omc-export/src/code_context.rs), 5–175, resolves components; projected instances with `sourceComponentId` become frames at 131–133. Supported token/style references can remain CSS variables (`token_value`, 299–305), but variable definitions select the active/default mode at 16–26. Complex paint stacks/effects produce diagnostics at 92–129. [React export](../../native/crates/omc-export/src/code.rs), 33–61, explicitly emits static design output with no application behavior. | Grade visual fidelity, component reuse, overrides, token links/modes, responsiveness and behavior independently. Do not claim all tokens are flattened, or that static React export is a lossless application roundtrip. Any manual/agent reconstruction required to meet the task belongs in accepted-task tokens and time. |

For multi-document attribution, `query_extension` also holds the shared cursor mutex from line 397 through the synchronous worker call at 448–452 and response construction. This can serialize concurrent native-query calls across documents. The worker request bypasses workspace `read_call` admission after obtaining the starting metadata. Measure cursor-lock wait, worker wait, and page construction separately; do not assume all query latency is represented in admission metrics. This is a source-supported contention hypothesis, not a measured bottleneck.

## 3. Cache behavior and what it can prove

The implementation has useful retained rendering paths. Their existence is evidence of an optimization strategy, not a cross-product performance result.

| Cache | Actual behavior and limits | Required experiment |
| --- | --- | --- |
| [Scene cache](../../native/apps/omc-desktop/src/scene_cache.rs), 5–188 | One exact frame keyed by scene generation, viewport, device scale, camera and background; 32 MiB retained-image cap. GPU destinations retain a texture-backed snapshot. Invalid/subpixel physical bounds can select the direct path. | Count hit/miss/bypass and retained bytes. Separate unchanged-canvas overlay repaint, first miss, pan, zoom, resize and revision invalidation. Include retina-scale threshold crossings. |
| [Pan cache](../../native/apps/omc-desktop/src/pan_cache.rs), 14–17 and 130–311 | Background software raster with up to 128 pixels of overscan, a 24 MiB image budget, one queued/in-flight job, generation checks, and optional GPU upload when consuming the result. | Measure first-pan response, overscan refill latency, CPU raster and upload cost, stale-result rejection, cache coverage, and continuous pan beyond an already cached region. Report time until exact content appears after motion. |
| [Move cache](../../native/apps/omc-desktop/src/move_cache.rs), 7 and 32–112 | Retains stationary painter-order passes while painting moving content, capped at 64 MiB. Unsupported plans or excessive retained surfaces use the direct painter. | Compare first versus warmed drag, one versus interleaved multi-selection, masks and complex parent effects, plus drop-to-durable-to-exact-scene latency. |

The document-paint branch in [paint.rs](../../native/apps/omc-desktop/src/paint.rs), around 2735–2820, bypasses some caches for moving content, outlines, focused views, screenshots, and other display modes. A benchmark must state which mode is active. A stationary cache hit cannot stand in for continuously changing designs or a scene-build benchmark.

Each accepted new scene clears the caches. Repeat the interaction suite while another agent changes an unrelated layer, while text is edited, and while a token changes many instances. These cases test the useful lifetime of retained content under real work.

## 4. Existing measurement surfaces

### 4.1 Native service probe

[`native/tests/performance-smoke.mjs`](../../native/tests/performance-smoke.mjs) is correctly labeled a service regression probe, not W1–W7 qualification.

It creates a fresh temporary profile, imports one flat JSON page with up to 100,000 nodes, obtains a bounded node page, performs ten warm-up scalar updates and 100 timed updates to the same rectangle, and checks each response's `durable` status. It records import duration, input bytes, samples, median, p95, and maximum. The service runs as a separate process and uses an official SDK Streamable HTTP client.

The following limits matter when reusing it:

- The fixture is predominantly simple rectangles, with no image/text-heavy composition, deep hierarchy, substantial CSS rule set, component expansion, or long edit history.
- Import timing begins after process startup and MCP connection. It does not include application launch, catalog scanning, native window creation, first visible content, or first usable interaction.
- Async import completion is observed by polling every 100 ms. This adds observation granularity; it does not identify first editable content.
- Timed updates do not fetch and present the desktop's full snapshot. They measure a different completion boundary from a user-visible edit.
- The harness does not independently reopen the document to confirm each acknowledged change, inject a crash, measure resource peaks, collect LLM usage, or compare another product.
- It emits timing observations without a latency regression threshold. A completed probe is not a latency acceptance pass.
- It defaults to a debug binary and writes `build: "debug"` unconditionally, even if `OMC_SERVICE_BINARY` points elsewhere. A publication wrapper must independently record the actual binary hash, build profile, features, Rust/toolchain, and revision; do not treat this field as verified provenance.
- Its 100 measurements can support a small-run p95 observation but not a stable p99 claim. Its `medianMs` is the upper-middle sample (`ordered[50]`), not the midpoint definition used by some other scripts. Use one declared estimator in comparative reports.
- The probe deletes the temporary profile on exit. Collect an explicit manifest and the evidence required by the parent experiment before cleanup; never use a person's normal profile to keep evidence around.

### 4.2 Native cache microbenchmarks

[Scene-cache tests](../../native/apps/omc-desktop/src/scene_cache.rs), `measure_pan_redraw` at 492 and `measure_stationary_viewport` at 562, are ignored tests that must be selected explicitly. They use a synthetic 640-object scene and 30 timed draws. They also test pixel correspondence and repaint counts.

These measurements isolate useful raster/cache behavior. They do not exercise a real OS input path, service persistence, full snapshot reconstruction, the whole native UI, or hardware presentation. The pan test sleeps between preview frames and starts from a prepared overscan image; report both the first-fill result and warm redraw samples. Tiny fixed viewports and deterministic warm cache conditions must not be generalized to large retina windows.

[Metal presenter tests](../../native/apps/omc-desktop/src/gpu_presenter.rs) include a test requiring a working Metal device. A skipped/ignored device-dependent test is not GPU verification.

### 4.3 Existing desktop trace

`OMC_NATIVE_FRAME_TRACE` enables two source-supported traces:

- [App `draw_frame`](../../native/apps/omc-desktop/src/app.rs), 1078–1132: `input_to_submit_ms`, `draw_ms`, and camera values. `trace_input` retains one pending input timestamp until a draw succeeds; coalesced inputs are not a complete per-input distribution.
- [Metal `present`](../../native/apps/omc-desktop/src/gpu_presenter.rs), 230–275: drawable acquisition wait, wrapping, CPU paint submission, flush/submit, and command presentation/commit submission durations.

Neither trace measures the time at which a display actually shows the changed pixels. `present_ms` is time around scheduling/committing the drawable, not verified scanout/presentation latency. Do not relabel it as such. [Automation](../../native/apps/omc-desktop/src/app/automation.rs), 502–503, exposes the last draw duration and a frame counter; these are not frame-interval distributions or hardware FPS.

### 4.4 Workspace observability

The authenticated `workspace.metrics` RPC is dispatched in [service `main.rs`](../../native/apps/omc-service/src/main.rs), line 392. [Workspace metrics](../../native/crates/omc-workspace/src/lib.rs), 782–784, return admission state, background jobs, worker PIDs, and session count.

Current counters are:

- `admission.pendingAndActive`, `admission.activeDocuments`, `admission.reservedTransportBytes`;
- `jobs.active`, `jobs.queued`, `jobs.reservedBytes`, `jobs.activeLimit`, `jobs.retainedReceipts`;
- `workerPids`, `sessions`.

They help discover the complete process group and explain queue pressure. They do not provide latency histograms, actual heap/GPU usage, cache hit rates, per-document fairness, I/O volume, or scene work counts.

### 4.5 Legacy/Electron evidence

The following scripts remain useful within their stated scope, but are not native Rust evidence:

| Existing artifact | Actual scope | Do not infer |
| --- | --- | --- |
| [`scripts/benchmark-canvas.mjs`](../../scripts/benchmark-canvas.mjs) | JavaScript editing and SVG DOM work under jsdom; script explicitly excludes browser layout/paint, FPS, IPC and durable save | Native GUI speed or actual browser compositing speed |
| [`scripts/benchmark-document-core.mjs`](../../scripts/benchmark-document-core.mjs) | JavaScript import/asset persistence/Replica/storage phases and a same-process reopen, with scoped memory snapshots | Native reopen, GPU memory, whole process-group peak, or cold-disk startup |
| [`scripts/benchmark-editor.mjs`](../../scripts/benchmark-editor.mjs) | Official SDK stdio → Electron → renderer → durable commit path on the component-library fixture; ten timed edits after one warm-up | Cross-product results, native paths, or reliable extreme-tail percentiles |
| [`scripts/large-document-e2e.mjs`](../../scripts/large-document-e2e.mjs) and PR #12/#13 QA records | Historical Electron journeys with declared DOM, rAF, and trace observation boundaries | Current native performance or hardware presentation without the corresponding measurement |

Keep historical results attached to their own revision, fixture, OS, application path, and completion boundary. Never average historical Electron samples with new native results.

## 5. Instrumentation to add before making causal claims

Use structured events with a run ID, document ID, request/operation ID, revision, and monotonic timestamp from the emitting process. Do not assume monotonic clocks from different processes or machines can be directly subtracted. Use client round-trip duration for end-to-end service latency and trace correlation or a documented clock calibration for cross-process stages.

| Proposed span/counter | Source seam | Minimum fields | Interpretation |
| --- | --- | --- | --- |
| `desktop.request.enqueue/dequeue` | `Bridge::send` / receiver loop | Request kind, target document, queue occupancy, enqueue age | UI bridge queuing, including long file operations |
| `service.rpc.decode/dispatch/encode` | `rpc`, `dispatch_rpc`, response construction | Method, input/output bytes, result/error, session class | Transport/serialization overhead; record whether the result is already durable |
| `admission.wait/grant/release` | `Admission::acquire`, `dispatch`, `Permit::drop` | Caller/document/class, wait, hold time, active count, reservation, rejection | Distinguish queue waiting from engine execution and detect starvation |
| `worker.send/reply` and `actor.start/end` | Worker process call and actor dispatch | Action, process slot, queue occupancy, frame bytes, serialization duration | Worker IPC, shared pipe effects and per-document serialization |
| `engine.prepare/validate/commit` | `DocumentEngine::execute` | Changed nodes, command kind, prior operation counts, ancestry reads, replayed receipt | Actual mutation cost and idempotent replay cost |
| `storage.node_state/project/snapshot` | Store reads, `NodeState::project`, `project_snapshot` | SQL statements/rows, operation bytes, retained/live/tombstoned entities, ancestry steps | Separates document size, history size and hierarchy depth |
| `storage.commit/checkpoint` | `DocumentStore::commit`, explicit checkpoint | Transaction bytes, WAL frames/bytes, busy/error, durable revision | Disk-backed acknowledgement and checkpoint interference |
| `desktop.snapshot.receive/install` | Client `snapshot`, app `Response::Snapshot` | Wire bytes, parse time, typed conversion, changed/unchanged revision, retained tab count | Full-update overhead, including expensive unchanged polls |
| `scene.request/build/accept/discard` | Scene worker and `Event::Scene` | Requested/current revision, queue delay, component/style/layout/text/resource phases | Time until correct geometry becomes available; discarded work counts against resources |
| `scene.work` | Style/layout/component/scene paths | Total/styled/layout/visible nodes, rules and selector attempts, expanded nodes, depth, text glyphs/runs | Explains scaling without relying only on serialized file size |
| `cache.scene/pan/move` | Cache paint/clear methods | Hit/miss/bypass reason, retained bytes, refill/texture upload, stale results | Shows which interaction benefits from caching and when that benefit disappears |
| `render.resource` | Image provider, hash/copy/decode/upload seams | Unique hashes, occurrences, encoded/decoded bytes, cache outcome, timing | Separates shared assets from duplicates and CPU from GPU work |
| `frame.input/submit/present` | Input handler, `draw_frame`, platform feedback | Input sequence, coalescing, displayed revision/camera, backend and present feedback | Presentation requires actual platform feedback or calibrated external observation; unsupported fields remain null |
| `process.sample` | OS sampler using service/worker/desktop PIDs | RSS/physical footprint, CPU time, faults, I/O, GPU memory if available, thread/process count | Whole application resource use; reservation counters are supporting diagnostics only |

Do not log document text, image bytes, secrets, MCP credentials, or private paths in shareable metrics. Stable synthetic fixture IDs and content hashes suffice. A diagnostic trace that materially changes timing must be measured against an uninstrumented run; record trace overhead or restrict it to separate attribution runs.

## 6. Experiments that distinguish usefulness from a favorable demo

These local IDs are anchors for the benchmark plan and can be mapped to its canonical workload registry. They are proposed experiments, not claimed implementations or results.

| Experiment | Controlled variation | Primary measurements | Counterexample the experiment must allow |
| --- | --- | --- | --- |
| N-A: visible edit versus durable edit | Same one-node patch at 1k/10k/100k total nodes; GUI attached and headless; shallow/deep trees | Durable RPC, full snapshot, scene-ready, submit/present latency, bytes and peak memory | Engine write stays fast but desktop update grows with the whole document. |
| N-B: active-page isolation | Keep a 100-node visible page constant; add unrelated pages, CSS rules, metadata and components | Styled/indexed nodes, scene build, snapshot cost, active interaction p95 | Unrelated pages increase work despite a small viewport. |
| N-C: history aging | Identical final geometry with fresh state and 1k/10k/100k prior edits; concentrated and distributed history; retained tombstones | Node reads, snapshot/reopen, scalar edits, storage size, WAL and replay CPU | Equal node counts hide substantial history-dependent degradation. |
| N-D: retained-rendering lifetime | Static overlays, pan, zoom, first/warm drag, mixed content, live remote edits, 1×/2× device scale | Cache outcomes, frame intervals, exact-scene catch-up, CPU/GPU and memory | Smooth warm-cache motion does not survive frequent revisions or large retina surfaces. |
| N-E: several heavy documents | 1/5/10 genuinely distinct open documents; active UI plus four agent sessions; shared/distinct assets | Foreground p95, per-client progress, queue wait/rejections, whole-process-group peak, post-close memory | Worker or cache overhead overwhelms the benefit of avoiding a browser engine. |
| N-F: saved-library startup | 0/15/100 saved documents with independently varied sizes; empty/open startup; thumbnails enabled | Launch, catalog scan, thumbnail completion, first usable document, disk reads | Startup depends on saved library contents even when only one document is opened. |
| N-G: asset/effect pressure | Same geometry with repeated shared images, distinct images, text/fonts, masks, blurs and gradients | Hash/copy/decode/upload cost, cache behavior, render diagnostics, resource rejection | A simple rectangle win disappears on representative design content. |
| N-H: correctness after speed | Reopen, process kill around durable boundaries, Undo, export and four-replica convergence | Acknowledged content recovered, visible fidelity, semantic structure, operation attribution | A fast result is unusable because a required property or durable edit is lost. |

For N-E, distinguish documents open in the UI, leased only by an agent, and merely present in the catalog. Report foreground and background work separately. Also test a long read and a write to the same document, because admission serializes their worker access.

For N-D, measure both immediate preview latency and the time until the correct current revision and content are visible. A translated old raster can make motion feel responsive while new edge content is still being produced; both experiences matter.

For N-C, preserve the same supported document semantics and asset bytes across conditions. Record final visible-node count, retained-node count, operation count, catalog events, and storage bytes. Simply cloning one fresh document ten times does not test history or distinct-resource pressure.

## 7. Ranked bottleneck hypotheses

This is an investigation order based on source and the intended local-development workloads. It is not a measured attribution ranking.

1. **Whole-document reconstruction and delivery on the desktop update path.** The evidence is unusually direct: normal commands fetch full snapshots; idle polling does the same; projection enumerates retained entities. Start with N-A and N-B, including unchanged polling. A fast durable receipt can coexist with a slow or oversized display update.
2. **History-dependent replay and duplicated serialization.** Node reads reconstruct operation state, snapshots repeat that across the document, and JSON crosses worker/service/desktop boundaries. N-C determines whether long-lived projects behave materially worse than fresh fixtures.
3. **Global style/index work and component expansion during scene rebuilds.** The visible page does not bound every preparatory pass. N-B should separate page size, document size, CSS rule count, tree depth, and component projection.
4. **Cache invalidation and expensive mixed-content rendering.** Retained caches are real advantages for eligible frames, while new scenes clear them and complex content leaves the plain-rectangle fast path. N-D and N-G determine useful coverage and reveal resource shifts into the background pan worker or GPU upload.
5. **Resource multiplication across tabs, workers and images.** Desktop snapshots remain resident per tab; admission reservations do not represent total memory; image bytes can be copied and verified during rendering. N-E/N-G should measure complete process groups and distinct assets before claiming a smaller footprint.
6. **Library startup and thumbnail work.** Saved documents are visited during startup and thumbnail listing can reconstruct/render multiple documents. N-F tests whether the start/open benefit remains as the user's library grows.
7. **Pointer lookup and UI-side traversal.** Scene lookup and hit testing are linear, while some UI controls and layer preparation are rebuilt. Test pointer misses/dense overlap after the larger snapshot/scene costs are quantified; an isolated CPU trace should establish priority.

Potential strengths deserve the same discipline: incremental candidates and durable changed-node writes, shared typed document identity, off-thread scene preparation, bounded scheduling, and retained frame paths are useful architectural foundations. They become demonstrated advantages only when the full accepted task finishes correctly with lower measured cost, latency, or resource use under matched conditions.

## 8. Rules for interpreting a comparison

- Use the same required result and supported semantics. Failed imports, missing effects, stale previews, rejected requests and timeouts remain in the denominator.
- Separate human editing, deterministic tool replay, and an LLM completing a task. Renderer speed and LLM token usage are different measurements.
- Compare native release builds against real competitor builds on the same machine, OS, screen geometry, scale, fonts, power mode and network conditions. Keep a separate debug diagnostic lane.
- For memory, sample desktop, service, workers and attributable helpers together. Report process-group totals, peak/steady state, shared-memory accounting convention, and post-close behavior. On shared CPU/GPU-memory systems, avoid summing overlapping categories as independent physical memory.
- Use repeated runs and raw samples. Do not derive hardware FPS from a last-frame duration, average percentiles across runs, hide rejections, or treat a resource limit as a zero-cost completion.
- Keep presentation, durable save, first usable state, all-content readiness, and service response as distinct milestones. Name an unavailable metric explicitly instead of substituting a faster proxy.
- Existing correctness and recovery tests can supply assertions and fixture ideas, but their existence does not establish that this baseline passed a new run. Attach execution evidence to the exact tested revision before publishing results.

The native design can plausibly improve local responsiveness and controllability. This map deliberately identifies the paths that could falsify that expectation, so subsequent improvements and comparisons can be tied to observable user benefit.
