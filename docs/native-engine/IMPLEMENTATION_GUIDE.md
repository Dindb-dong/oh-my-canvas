# Native implementation guide

[Plan and reading order](../NATIVE_ENGINE_PLAN.md) · [Engine contracts](ENGINE_CONTRACTS.md) · [Rendering](RENDERING_AND_INTERCHANGE.md) · [Qualification](QUALIFICATION.md)

**Specification status:** proposed native version 1, 2026-11-11. The paths, crates, native commands and defaults below are implementation requirements, not a claim that those artifacts already exist. The current application remains the Electron implementation described in [ARCHITECTURE.md](../ARCHITECTURE.md).

## 1. How a contributor uses this specification

Start with the plan's N1–N8 outcomes, then the [capability matrix](CAPABILITY_MATRIX.md). Select a work package from section 6, read its owning contract, and implement its tests and observable behavior together. A new contributor must not need the original chat, an unpublished agent plan or access to a particular person's computer.

This document owns module boundaries, work ordering, process scheduling, resource defaults and the release procedure. [ENGINE_CONTRACTS.md](ENGINE_CONTRACTS.md) owns canonical data, commands and API limits. [STORAGE_AND_COLLABORATION.md](STORAGE_AND_COLLABORATION.md) owns durable state and replication. [RENDERING_AND_INTERCHANGE.md](RENDERING_AND_INTERCHANGE.md) owns visual semantics. [QUALIFICATION.md](QUALIFICATION.md) owns measurement and PASS/FAIL rules. The [reference catalog](REFERENCE_PROJECTS.md) provides upstream evidence, not additional product requirements.

An implementation PR must name its work-package and capability IDs, changed contract versions, actual commands run, evidence paths and remaining unsupported cases. Update this specification when an implementation changes a normative decision. Do not leave contradictory versions in separate documents. Before marking a package complete, provide a trace from requirement → implementation symbol/module → executable scenario → saved result.

Terms used throughout:

| Term | Meaning |
| --- | --- |
| Required | A release gate; a partial implementation cannot silently remove it |
| Default | The concrete initial implementation choice; changing it requires a recorded decision and the affected tests |
| Candidate | A dependency under a bounded integration experiment; its name is not evidence of compatibility |
| Planned | No native implementation or successful native test is asserted |
| Durable | The validated commit survives the documented local crash/restart model |
| Complete export | Every required node/resource in the requested revision and scope is accounted for; viewport culling cannot remove content |

## 2. Repository and module boundaries

Create a Rust workspace under `native/`. Keep the existing runtime usable until M6; its readers and independently authored behavior are migration inputs. Rust package names below are the proposed stable module names. Split or combine physical crates only when the dependency and ownership boundaries remain explicit.

| Proposed path/package | Owns | Allowed dependencies and boundary rule |
| --- | --- | --- |
| `native/crates/omc-model` | IDs, authored entities, styles, component/text records, property types | Pure data; no filesystem, network, Yrs, GPU or window handles |
| `native/crates/omc-protocol` | Versioned command/query/result schemas and generated adapter bindings | Model types; no access to live mutable documents |
| `native/crates/omc-engine` | Validation, semantic transactions, revision snapshots, dependency indexes and Undo | Model/protocol; narrow storage/sync ports; no UI callback |
| `native/crates/omc-storage` | SQLite schema/migrations, journals, checkpoints, durable receipts and recovery | Storage/model codecs; one writer per document; no renderer |
| `native/crates/omc-sync` | Shards, CRDT adapter, transaction envelopes, anti-entropy and presence | Engine merge port and storage; never directly mutate a UI tree |
| `native/crates/omc-assets` | Verified immutable bytes, local resource capabilities, decode/cache accounting | Model/storage ports; no arbitrary URL or path access from document content |
| `native/crates/omc-style` | Native parser adapters, cascade, tokens, computed-style provenance | Authored model and resource descriptors; no browser |
| `native/crates/omc-text` | Font resolution, shaping, line breaking, caret/selection and text metrics | Immutable styled text and pinned font environment |
| `native/crates/omc-layout` | Box layout, intrinsic measurement and dirty dependency propagation | Style/text/model snapshots; no storage writes |
| `native/crates/omc-scene` | Display lists, bounds, hit testing, snapping and damage regions | Layout and visual properties; no canonical authoring state |
| `native/crates/omc-render` | Skia screen/offscreen adapters, compositing, surfaces and GPU accounting | Scene/text/assets; no document edits or MCP transport |
| `native/crates/omc-import` | HTML/SVG/FIG/Sketch/legacy decoders and semantic conversion | Produces validated candidate commands/resources through the engine |
| `native/crates/omc-export` | HTML/CSS/static React/Tailwind, SVG/PDF/raster/native packages | Pins a revision; shares layout/rendering; cannot depend on a selected tab |
| `native/crates/omc-workspace` | Document ownership, folder/catalog commands, scheduler and global budgets | Engine/storage/sync/job interfaces; launches bounded workers |
| `native/crates/omc-mcp` | MCP transport, sessions, capability negotiation and tool adapters | Protocol/workspace API; no separate implementation of editor semantics |
| `native/apps/omc-service` | Background workspace service and worker modes | Composition root for headless use; no native window is necessary |
| `native/apps/omc-desktop` | Windows, controls, focus, viewport, IME and accessibility | Protocol client plus read-only layout/scene/render components |
| `native/apps/omc-cli` | Explicit service/MCP/export/diagnostic entry points | Same protocol; no competing document writer |
| `native/tools/xtask` | Fixtures, protocol transcripts, fault injection, qualification and packaging | Test-only orchestration; cannot be required by an installed editor |

The engine publishes engine-owned immutable snapshots. A Yrs read transaction, SQLite connection or UI object must not escape as a public snapshot. Keep serialization and storage representations distinct from public commands so migrations do not silently change the MCP schema.

The desktop may derive layout/render caches from revisioned snapshots using the same Rust libraries as headless rendering. It must not become a second authoring authority. The service can answer semantic queries without starting a GPU; a layout/screenshot request lazily schedules the required native resources.

### Initial dependency decisions

Use winit with project-owned native controls and the shared Skia drawing adapter as the initial desktop composition. WP-01 makes a provisional framework choice from build/adapter feasibility; a GPUI alternative becomes final only after the complete controls, accessibility and GPU-sharing gate in WP-12/DEP-06, without a second incompatible canvas pipeline. Native Skia is the starting renderer, including a CPU offscreen path for machines without a suitable GPU. Software output is qualified separately from hardware interaction targets.

Evaluate the exact Blitz/Stylo/Taffy/Parley composition in the [reference experiments](REFERENCE_PROJECTS.md). Keep stable project-owned style/layout/text interfaces. A failed dependency experiment changes an adapter or implementation choice; it cannot remove required CSS/text semantics, reintroduce a WebView or turn supported editable content into an undisclosed bitmap.

WP-01 must commit `rust-toolchain.toml`, `Cargo.lock`, feature flags and platform prerequisites together with the smallest successful native build. Select actual mutually compatible releases/revisions, not a collection of independently newest crates. Record compiler/MSRV, native C/C++ build tools, Skia binary/source provenance and reproducible offline-build inputs. Upstream reading pins in the reference catalog are not a tested dependency lock.

## 3. Process model and scheduling

The workspace service owns the profile catalog and discovers/launches document workers. Acquire an OS-backed exclusive profile ownership lock before publishing its authenticated local endpoint. A second GUI or CLI connects to that service. PID files alone are insufficient ownership proof. Unix-domain sockets or Windows named pipes may carry internal traffic; retain authenticated loopback MCP as its separate public adapter.

The initial standard profile permits up to four document worker processes and two concurrent expensive compute jobs. A worker may host multiple independent document actors. This bounds process overhead for ten open documents; it does not authorize one document's synchronous parser to run on another document's actor loop. Run expensive decode, geometry, checkpoint preparation and imported-source validation in the bounded compute pool. Assign heavy documents to separate workers when practical. On worker failure, recover only its assigned documents from durable state and return a typed recovering status; the broker and other workers remain available.

All CPU pools share one concurrency budget. Initially permit at most `max(1, available_parallelism - 2)` CPU-heavy tasks across the workspace, further capped by the two-heavy-job default. Do not create that many threads independently in each document. The UI/input path and service routing must not await a long compute task synchronously.

Each document has a short serialized commit path, while reads use immutable committed snapshots. Reserve resources and prepare candidates outside that path. Recheck dependencies before committing. A writer does not wait for GUI painting or acknowledgments from every peer. Storage and remote-merge rules are in [the persistence contract](STORAGE_AND_COLLABORATION.md).

### Fair queues and backpressure

Use weighted deficit round-robin across document and authenticated author/session. Work class weights start at interactive `8`, durability/remote-apply `4`, background `1`; charge by measured work or conservative estimates, not simply request count. Give each nonempty eligible queue service within each scheduling round. Yield resumable preparation after a 2 ms CPU slice; move non-yielding library calls to compute workers. This is a scheduler policy, not a claim that an OS or GPU guarantees a 2 ms dispatch interval.

Default admission bounds are 32 pending commands per caller, 128 per document and 256 workspace-wide, plus 16 queued expensive jobs. All bounds apply together, including the engine contract's tighter per-author/document limit and payload-byte limits; a count-only queue is not a memory bound. Reserve a small bounded control lane for cancellation, health, resource release and commit receipts. Full queues return a typed retryable busy response with progress/retry guidance; do not buffer unbounded requests in a transport library.

Do not silently retry a write after an uncertain commit. Recover its durable idempotency receipt or return the contract's uncertainty/recovery response. Cancellation drains queued work and releases reservations; once a command commits, cancellation only stops any remaining optional downstream work.

### Ownership and shutdown

Owners are explicit GUI views, MCP sessions, collaboration sessions and jobs. Closing one tab releases its view/cache ownership. It does not close another client's document or stop a collaborative session. A zero-owner document checkpoints if needed and becomes evictable; a timeout is not permission to drop unsaved work.

An explicit quit stops admission, cancels uncommitted jobs, drains bounded commits and reports unresolved recovery work. The interactive UI shows documents whose durable shutdown failed. A hung worker can be terminated after its state is reported; restart then follows the same journal recovery path as a crash. Do not display Stored for a job merely accepted into a queue.

## 4. Resource defaults

These are proposed defaults for the standard 16 GiB qualification profile, not measured usage or an OS-enforced memory limit. The workspace coordinator reserves managed bytes before allocating and releases them on completion/eviction. A standard-profile PASS must satisfy both these admission rules and observed memory gates in [QUALIFICATION.md](QUALIFICATION.md).

| Budget | Standard default | Behavior |
| --- | --- | --- |
| Managed CPU memory | Pressure at 1,536 MiB; admission ceiling 2,048 MiB | Reclaim/evict at pressure; refuse or queue work whose reservation cannot fit |
| Aggregate managed GPU memory | 512 MiB across visible and offscreen jobs | Reuse/evict resources; constrain export tiles and effect surfaces |
| Observed aggregate process RSS | Peak target ≤4,096 MiB in standard combined workloads | Measure actual processes; report shared-memory overcount and untracked-library allocations separately |
| Document workers | At most 4 | Multiple actors per worker; explicit heavy-job isolation |
| Expensive compute jobs | At most 2 active, 16 queued | Fair admission; byte/time limits and cancellation |
| Background derived-cache share | At most 25% of managed CPU/GPU budgets during foreground pressure | Background preparation yields resources before foreground eviction |

The GPU budget is not added blindly to RSS on unified-memory systems. Report GPU allocations and CPU accounting separately, including whether shared backing is double-counted. A managed allocation ceiling does not prove total process RSS is capped: native libraries, stacks and drivers need measurement and instrumentation.

Initial CPU allocation shares below sum to 2,048 MiB. They are borrowable reservations under the global ceiling, not a requirement to preallocate them or deny a document unused memory.

| Managed resource | Initial share |
| --- | ---: |
| Resident canonical/CRDT shards | 768 MiB |
| Pinned revisions and materialized Undo/read state | 256 MiB |
| Decoded images | 384 MiB |
| Font/text caches | 128 MiB |
| Layout, scene and spatial indexes | 192 MiB |
| Compute intermediates | 128 MiB |
| Transport buffers | 64 MiB |
| Workspace indexes and control reservations | 128 MiB |

Durable operation/CRDT history and retained inverse payloads live on disk according to the storage retention policy. User-visible Undo stacks are session-local in native v1 as specified by the engine contract; evicting a materialization preserves the current session's retained dependencies and does not delete durable history. Track reservations for temporary copies and in-flight GPU submissions until their fences complete. Deduplicate by immutable content identity and compatible decode parameters, not only by a user-facing asset name.

Under pressure: cancel obsolete speculative preparation; evict unpinned derived caches; release cold durable shards; pause background jobs; finally refuse new reservations with a precise limit response. Never evict unsaved state, forget an unacknowledged write, flatten components or reduce export fidelity to fit a hidden limit. If a non-streamable source exceeds the safe import reservation, fail the job explicitly without changing its destination document.

The extended 32 GiB profile may use 4,096 MiB managed CPU and 1,024 MiB managed GPU, with an 8,192 MiB observed-RSS peak target. Its results are a separate profile and cannot satisfy a standard-profile claim. Changes to these defaults require a documented reason and repeated combined-workload evidence; tuning a budget after seeing a failing result must be visible in the report.

## 5. Build, test and contributor entry points

### Commands that exist today

In a normal complete checkout, follow [CONTRIBUTING.md](../../CONTRIBUTING.md), install the locked Node dependencies with `npm ci`, then run `node scripts/check-docs.mjs` for this documentation set. Current Electron verification commands remain in [TESTING.md](../TESTING.md). A documentation check is not a native engine test.

### Proposed native command surface

**The commands in this block do not exist at the planning revision.** WP-01/WP-02 must implement and document them before another package relies on them. They are the acceptance interface for the future Rust workspace, not instructions to claim a successful build now.

```sh
cargo fmt --manifest-path native/Cargo.toml --all -- --check
cargo clippy --manifest-path native/Cargo.toml --workspace --all-targets --locked -- -D warnings
cargo test --manifest-path native/Cargo.toml --workspace --locked
cargo run --manifest-path native/Cargo.toml -p xtask -- contracts
cargo run --manifest-path native/Cargo.toml -p xtask -- qualify --scenario W2 --profile native-standard
cargo run --manifest-path native/Cargo.toml -p xtask -- qualify --scenario W3 --profile native-standard
cargo run --manifest-path native/Cargo.toml -p xtask -- package --platform current
```

`xtask contracts` must validate checked-in schema versions, command examples, text offset conversions and compatibility transcripts. Qualification commands create isolated profiles and write machine-readable results under `native/target/qualification/<run-id>/`. They fail with a nonzero exit status for a failed gate and distinguish missing prerequisites/incomplete runs from passing results. They must not touch a user's normal profile or require a private credential for public synthetic fixtures.

Public release evidence belongs in a reviewed `docs/qa/native/` result set with exact source/build IDs and sanitized attachments. Detailed private/debug traces remain excluded. A contributor should be able to reproduce the standard synthetic suite from the repository and documented public dependencies. Rights-controlled third-party fixtures have a separate acquisition manifest and are never silently bundled into a public package.

### Three layers of verification

1. **Per-change checks:** the changed protocol/model algorithm, persistence boundary or renderer feature. Examples are a stale-precondition rejection, a recovered durable receipt, an IME range transform or a mask compositing case. Do not substitute tests that simply restate a mocked implementation.
2. **Integration gates:** real local MCP transports, native service/desktop processes, actual files, four peer processes and shared engine output. Test the real boundary where a regression can occur.
3. **Qualification:** reproducible combined workloads and packaging runs in [QUALIFICATION.md](QUALIFICATION.md). A headless unit test cannot establish input latency, a browser screenshot cannot establish native output, and a warm preview cannot establish recovery.

## 6. Work packages and dependency order

Every row below is planned. Package IDs are stable references, not reserved PR numbers. A package may take several focused PRs. The owner column identifies the responsible module/domain; maintainers assign people when work begins.

| Package / milestone | Owner and concrete deliverables | Depends on | Exit evidence |
| --- | --- | --- | --- |
| WP-01 / M0 | Build: Rust workspace, locked dependency feasibility spike, native window and offscreen surface, licensing/build manifest | This specification | Native build on first target; provisional adapters compile and ownership boundaries are feasible; no browser dependency in target graph |
| WP-02 / M0 | Protocol/test: versioned schemas, golden command transcripts, fixture generator and `xtask` skeleton | WP-01 | Invalid/unknown fields and versions reject; documented examples execute; public synthetic suite is reproducible |
| WP-03 / M1 | Model/engine: IDs, typed entities, stable home shards, property/dependency indexes, revision snapshots and small commands | WP-02 | Leaf edit, reparent and validation cases; unchanged unrelated entities retain identity; stale writes reject atomically |
| WP-04 / M1 | Storage/assets: per-document database, immutable resources, durable receipts, migrations and recovery | WP-03 | Crash at each commit boundary; received/staged bytes never masquerade as committed edits; old inputs retained |
| WP-05 / M1 | Workspace/service: ownership leases, worker routing, bounded queues, folder/catalog operations, lifecycle | WP-03, WP-04 | Two real documents through no-GUI service; worker restart isolates impact; close/quit ownership cases |
| WP-06 / M1 | MCP: current tool schema inventory, authenticated local transports, sessions/author attribution, first adapters | WP-02, WP-05 | Real SDK clients create/read/edit/Undo/save/reopen two documents; no hidden view; retries/cancellation verified |
| WP-07 / M2 | Style/layout/text: versioned property/value registry and HTML/CSS profile, provenance, native shaping, fonts and dirty propagation | WP-03; chosen WP-01 adapters | Responsive reference fixtures; rich-text offsets and metrics; every required syntax/value family mapped to cases; no browser measurement |
| WP-08 / M2 | Scene/render: native primitives, text/images, bounds, hit/snap, masks/effects, screen/offscreen cache budget | WP-07 | Canonical real-page fixture from WP-02, native drag/selection/text; screen/hit/screenshot agreement; asset readiness diagnostics |
| WP-09 / M2 | Import/export: first native HTML/SVG/legacy path and pinned-revision screenshot/export jobs | WP-04, WP-07, WP-08 | Semantic HTML round trip and complete offscreen export; unrelated UI/MCP stays responsive |
| WP-10 / M3 | Shards/sync: independent residency, causal transactions, bounded asset/state transfer and anti-entropy | WP-03, WP-04, WP-05 | Loaded-page durable edit without unrelated restoration; interrupted multi-shard receive/restart; four active replicas |
| WP-11 / M3 | Text/Undo/comments: character/range coediting, marks, relative anchors, author retractions, grouped Undo and threads | WP-07, WP-10 | Concurrent text/format/IME/delete/Undo cases; resolved/orphaned comment anchors converge |
| WP-12 / M4 | Desktop: full tools/panels, components/styles/tokens, native controls, keyboard/clipboard/IME/accessibility | WP-05, WP-08, WP-11 | All required desktop rows in capability matrix have real native interaction evidence |
| WP-13 / M4 | Interchange: FIG/Sketch fidelity, migration, semantic code export, fonts/images, portable packaging | WP-09, WP-10, WP-12 | Source-feature fixtures and legacy files survive supported round trips; loss diagnostics and recovery verified |
| WP-14 / M4 | Effects: reviewed shader ports, parameters, deterministic time/seed sampling and animation-frame export | WP-08, WP-09 | Required shader catalog visual/parameter cases and bounded native playback; no WebGL/DOM wrapper |
| WP-15 / M4 | MCP/workspace: complete 50-tool migration plus versioned additive folder/comment/export capabilities | WP-06, WP-11–WP-14 | Each tool/action has GUI-free transport evidence and semantic parity; no tool-count-only completion |
| WP-16 / M5 | Performance: global budgets, fairness, cache eviction, incremental work and full W1–W7 runs | WP-10–WP-15 | Five/ten heavy documents plus four editors and MCP meet declared profile gates; no unreported failures |
| WP-17 / M5 | Platform/build: macOS, Windows and Linux packages, native dependencies, accessibility and offline smoke | WP-12–WP-16 | Per-platform installation/launch/edit/save/reopen/MCP evidence; platform-specific gaps remain visible |
| WP-18 / M6 | Release/migration: native default, reversible user-data conversion, documentation, dependency/provenance audit | WP-16, WP-17 | Complete required capability ledger and qualified release candidate; no required Chromium/WebView execution path |

WP-07/WP-08 and WP-04/WP-06 can proceed in parallel after the protocol/model boundary is stable. Replication and text invariants shape WP-03 immediately; postponing their design until the end of M3 would invalidate the data model. Do not let native controls become a prerequisite for headless MCP, or let a fast renderer bypass durable storage integration.

WP-01 performs build/adapter feasibility only. Complete dependency experiments require the owning packages: DEP-01/02/03/04 close with WP-07–WP-09; DEP-05 with WP-08/WP-09; DEP-06 with WP-12; DEP-08 with WP-10/WP-11; DEP-09 with WP-14. DEP-07 is required only if the alternative Vello renderer is selected. This ordering avoids making the initial build depend on a completed collaboration engine or effect catalog. No provisional dependency choice becomes final capability evidence until its full experiment passes.

WP-08 initially consumes a canonical fixture rather than depending on an importer that has not landed. WP-08 and WP-09 jointly close the actual foreign-imported-page integration case before M2 completes.

### First complete native journey

Use a real imported page plus a small synthetic control document. Through the desktop, select a text/frame, drag, edit text, rename, Undo, save, close and reopen. Through a separate MCP client, inspect and edit the other document, then request a screenshot and export. Record exact revisions and a durable receipt. Kill the service after a completed save and verify both documents in a fresh process. The journey passes only when it uses the native storage, engine, layout and renderer together.

This is the M1/M2 integration checkpoint. It does not close missing component, shader, collaboration, source-fidelity or platform rows.

## 7. Decisions and change control

The initial defaults are concrete enough to begin implementation. Only dependency suitability and measured operating envelopes remain experiments. Each experiment in the [reference catalog](REFERENCE_PROJECTS.md) has an input, a pass criterion and a fallback. Record one result per candidate with a source revision, test code and observed failure; do not leave a permanent “evaluate later” placeholder on the critical path.

| Decision | Default to implement | When change is allowed |
| --- | --- | --- |
| Desktop host | winit, project-owned controls, shared native rendering | WP-01 proves an alternative meets the same control/accessibility/GPU boundary |
| Graphics | Native Skia, first macOS GPU candidate Metal, qualified CPU offscreen path | Required features and complete workload evidence demonstrate a better adapter |
| CSS/text | Project-owned semantic interfaces around qualified native parsing/cascade/layout/text components | Adapter replacement preserves the versioned support profile and output contract |
| Persistence | Per-document SQLite WAL with explicit durable commits and immutable asset store | Recovery, independent residency and receipt semantics remain at least as strong |
| Replication | Sharded authored data; selected Yrs adapter subject to actual encoding/schema tests | A reviewed protocol/data migration preserves required offline and Undo behavior |
| Rich text | Native character/range coediting with relative anchors and concurrent formatting | Feature requirements are preserved; old atomic text is only an intermediate compatibility path |
| Resource policy | Section 4 standard/extended profiles | A recorded profile revision plus rerun of affected workloads |

For a change, add a maintained decision record under `docs/native-engine/decisions/` when that directory is created. Include status/date, requirement IDs, alternatives, measured evidence, chosen option, compatibility/migration, implementation pointers and rollback. The old and new choices must not both appear as active defaults. Library choice changes do not require reapproving the already accepted full native scope.

## 8. Migration and release procedure

1. **Inventory before conversion.** Identify source format/schema, external resources, collaboration identity and current recoverable checkpoint. Refuse ambiguous or unsupported input explicitly.
2. **Write a separate native destination.** Preserve the original and checksums. Import canonical data/resources and record conversion diagnostics. Do not reuse a source profile lock as an invitation to modify its only copy.
3. **Verify the destination.** Reopen in a fresh native process, compare supported semantics/assets and render representative frames. Test normal and interrupted migration, not only an in-memory conversion.
4. **Offer explicit activation.** Switch the selected profile/document to native only after verification. Preserve a documented route to open/export the original. Do not claim arbitrary edits made in a new schema can be reversed into an older schema losslessly.
5. **Qualify collaboration.** Native protocol peers negotiate the declared version. Mixed legacy/native peers either use a separately tested bridge or receive an actionable incompatibility response. Old invitations cannot silently select a new protocol.
6. **Package each supported platform.** Include the locked runtime dependencies, license/notice manifest, migrations and local MCP binary. Verify packaged behavior without a development checkout, network access or a preinstalled Node runtime.
7. **Publish evidence with the release candidate.** Record exact tested commit/package hashes, capability coverage, workload reports, known limitations and recovery instructions. A documentation merge or passing unit suite is not release qualification.

The release gate includes native windows/controls, text/IME/accessibility, foreign and legacy formats, required code export, all required MCP actions, multiple documents, four-person collaboration and memory/recovery behavior. If any required row is not qualified, label the build as an incomplete preview and list those rows. A preview may be useful; it must not be described as the completed Paper replacement.

## 9. Open-source publication standard

Keep this specification in English with portable repository links, descriptive diagrams, a dated capability baseline and primary-source links. Explain new concepts before relying on them: a shard is an independently loadable state unit, a revision is a coherent published state, and a receipt identifies a durable command result. Do not depend on internal planning documents to explain a public protocol.

Before a public release, verify the repository's own license, every chosen dependency and vendored modification, required notices, font/fixture redistribution permissions and binary build provenance. A project's root license does not automatically license every bundled asset. Follow [licensing readiness](../licensing/MIT_READINESS.md), [dependency records](../licensing/DEPENDENCIES.md) and [implementation provenance](../independent/PROVENANCE.md). The reference catalog records observed upstream terms; it is not a blanket compatibility or legal approval.

Provide synthetic reproducible fixtures for public tests. Keep private canvas contents, tokens, invitations, machine paths and live profile data out of screenshots, traces, examples and issue attachments. Document how contributors obtain optional third-party fixtures under their applicable terms and how to run the public suite without them.

The completed developer documentation must include actual installation/build commands, platform prerequisites, configuration defaults, protocol examples, schema migration policy, error/recovery guidance, a contribution workflow and a limitations table tied to evidence. Replace every proposed command/path above with a link to the implementation as its work package lands. That is the handoff from this specification to a maintainable open-source project.
