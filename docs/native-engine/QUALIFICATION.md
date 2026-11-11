# Native qualification and evidence guide

[Native overview](../NATIVE_ENGINE_PLAN.md) · [Capability matrix](CAPABILITY_MATRIX.md) · [Implementation guide](IMPLEMENTATION_GUIDE.md) · [Engine contracts](ENGINE_CONTRACTS.md) · [Storage and collaboration](STORAGE_AND_COLLABORATION.md) · [Rendering and interchange](RENDERING_AND_INTERCHANGE.md)

**Status, 2026-11-11:** this is a proposed acceptance procedure. No native workload below has been run. The current application, reference projects and Paper product claims are separate evidence sources. All initial native results are NOT_RUN; unmeasured values are null.

## Purpose and authority

This guide makes the final product claim falsifiable: native editing and agent access must remain usable with several heavy documents, four active collaborators, durable storage and the required semantic design features. A successful empty window, isolated renderer benchmark or tool discovery response cannot establish that claim.

The [capability matrix](CAPABILITY_MATRIX.md) owns the feature denominator, including all 50 existing MCP tools, required desktop/Paper workflows, HTML/CSS and FIG cases, and 30 reviewed native shader ports. The [engine contracts](ENGINE_CONTRACTS.md) own command/text/error semantics and protocol limits. The [storage contract](STORAGE_AND_COLLABORATION.md) owns durability, sharding, receipt, recovery and retention. The [implementation guide](IMPLEMENTATION_GUIDE.md#4-resource-defaults) owns resource budgets. This document measures those contracts; it does not introduce a competing wire format or reinterpret a staged acknowledgment as a completed edit.

Freeze the scenario manifest, generator version, thresholds, operation trace and hardware/software profile before a comparison. Any change creates a new qualification version. Report failures from the prior version rather than tuning them out of the result set.

## Reference profiles and controlled conditions

These are proposed machine classes, not descriptions of a machine on which this plan was tested.

| Profile | Proposed minimum class | Claim permitted |
| --- | --- | --- |
| native-standard / R16 | 8 physical CPU cores, 16 GiB RAM, SSD, supported native GPU/backend; 60 Hz display at 1440 × 900 logical pixels | Standard resource and combined-workload gates at the exact declared CPU/GPU/OS configuration |
| native-extended / R32 | Same declared CPU/display class, 32 GiB RAM, separately declared GPU/storage | Extended-budget result only; cannot replace an R16 result |
| correctness-ci | Declared virtual or physical CI configuration; software/offscreen rendering permitted where supported | Functional, recovery and deterministic-render cases only; no physical display or standard interactive-performance claim |

At M0 select concrete reference machines per supported platform and commit their manifests. Core count alone does not make different CPU generations or performance/efficiency core mixes equivalent. Record CPU model/topology, RAM, SSD/filesystem/free space, GPU model/driver/backend, display refresh/DPI, power/thermal settings, OS build, kernel where applicable, native toolchain/lockfile, font hashes and binary hash. Run on mains power without an unreported competing benchmark. Record background load instead of assuming it is absent.

W3 performance uses four separately provisioned clients, each meeting the declared profile, plus a workload coordinator. Four processes sharing one R16 machine are useful correctness tests but are a different contention profile. Record network topology, measured RTT distribution, throughput, jitter/loss and whether a relay is involved. The standard local-network profile requires measured p95 RTT at most 20 ms and at least 100 Mbit/s available link capacity. Network emulation settings and observed behavior are both evidence; an emulator setting alone is not a measurement.

The slow-network fault profile proposes 200 ms RTT, 20 ms jitter, 10 Mbit/s rate and 1% packet loss with a fixed seed, followed by a 20-second disconnection. It qualifies boundedness and recovery, not the standard low-latency claim. Do not subtract network time from a user-observed delay and present the remainder as the full experience.

### Repeats, samples and cache state

- W1, W2, W3 and W5 have a 60-second warmup followed by a 10-minute measured phase and a drain/correctness phase. Run at least three fresh-process repeats for each required fixture/resource/profile variant.
- W6 has three independent 60-minute measured runs after warmup. Memory sampling starts before process launch and continues through shutdown, including the warmup.
- Startup/import/reopen series have 30 independent samples per declared cache class, organized as three groups of ten. Record every sample, including failures/timeouts. These series are separate from warmed interaction measurements.
- Use deterministic operation seeds 101, 202 and 303 for the minimum repeats. Store the expanded operation schedule, target IDs, request bodies and expected outcomes, not just a seed whose generator may later change.
- Use nearest-rank percentiles, publish count/p50/p95/max and raw samples. Report p99 only with at least 1,000 relevant observations; otherwise label it unavailable and collect more samples if that percentile is a gate. Do not average per-run percentiles to hide a failing repeat.
- Measure frame intervals only within declared continuous interaction windows. Record idle time and page transitions separately. Failed calls, dropped input and retries remain in counters and traces; timeouts cannot disappear from the denominator.

Cache labels are exact experimental conditions:

| Cache class | Preparation and interpretation |
| --- | --- |
| First import | Fresh isolated application profile with no imported document/index/preview/decoded-resource cache; verified foreign source exists. Report OS file-cache state separately. |
| Process-cold reopen | Stop all application/service/worker processes, retain durable native working files and declared persistent caches, then launch again. OS page cache is uncontrolled unless separately verified; this is not automatically cold-disk I/O. |
| Warm reopen | Keep the document authority alive with an explicitly retained lease and declared resident shards; close/reopen the view. Record which resources remained resident. |
| Verified disk-cold | Dedicated reboot/cache-control procedure with evidence of the chosen OS/storage conditions. If unavailable, mark this class INCOMPLETE; do not relabel process-cold samples. |

Record application launch and document-open intervals independently. A timer beginning after the application starts cannot establish launch latency. A warm first-page preview is not the first editable authoritative page.

## Fixture manifest and reproducible input sets

The public harness must generate its own deterministic fixtures and require no paid account, personal document or private credential. Generated bytes, native conversion output and fonts receive SHA-256 manifests. The generator is proposed work; no generated hashes are supplied in this plan.

| Fixture ID | Required content | Purpose |
| --- | --- | --- |
| D-REAL | Full [existing FIG fixture](../../fixtures/design-files/README.md), 160,627,671 bytes, SHA-256 c7c4fdbe469ae451c9a3d3d384a2102fa08dfaa220a1277e2df17fc2146c5ee7 | Real import stress and structural regression; 46 pages, 39,363 objects including page roots, 160 referenced bitmap hashes are historical integrity checks, not a source-fidelity proof |
| D-NATIVE | Native working-file conversion of D-REAL produced by the candidate build; manifest records source/build/schema/epoch and all asset hashes | Reopen, partial residency, edit, collaboration and export without repeating foreign decode |
| D-100K | Deterministic 20-page document with exactly 5,000 objects per page including its root: 3,000 rectangles, 800 text nodes, 600 paths, 400 image placements and 199 layout/group containers per page | 100,000-object scaling with nontrivial semantics; nested structures include depth 24, flex/grid, clipping/masks and effects |
| D-RES-S | N independently identified heavy documents referencing the same immutable image/font bytes | Validates deduplication without confusing document identity with asset identity |
| D-RES-D | Same geometry/text count as D-RES-S, but each document has 160 distinct seeded 1024 × 1024 raster assets and a recorded distinct licensed font set | Exposes decoded-resource/cache pressure hidden by repeated copies of one design |
| D-SEM | Small reviewable HTML/CSS, vector, text, component, token, comment, folder, snapshot and shader fixtures, each with explicit structural and visual expectations | Feature/action denominator, corruption/recovery minimization and source-fidelity comparisons |

For D-100K, each path has 16 cubic segments and each text node has 128 Unicode scalars drawn from a fixed multilingual corpus with multiple style runs. A manifest fixes actual paragraph/run content, image placement references, layout topology, masks/effects and target IDs. No count changes are permitted between baseline and candidate. Every image/font is content-addressed; dimensions, encoded bytes and decoded-byte estimates are recorded. D-RES-D generates original image pixels from the seed; fonts are independently sourced with recorded permissions. It must not modify a font merely to manufacture a new hash without checking its license and embedding restrictions.

D-RES-S and D-RES-D each run at N = 5 and N = 10. One foreground document is D-NATIVE; the remaining documents use D-100K. All have distinct document identities. A pending foreign-import job may add one staging document; report that staging scope and its memory separately and include it in process totals. “Ten open documents” means ten actual document leases with addressable content and scheduled activity, not ten catalog rows or ten tabs pointing to the same authority.

### Source and redistribution records

For each third-party fixture, record source URL, acquisition date, source/version, byte hash, author/license or other permission evidence, attribution obligations, redistribution/embedding decision and any excluded assets. A repository license does not automatically cover a design's logos, stock images, fonts or bundled examples. Permission to import a user's document is not proof of permission to redistribute it publicly.

The existing FIG manifest identifies provenance and integrity; it is not a blanket legal conclusion about all contained material. The release maintainer must review public redistribution evidence before adding or republishing third-party bytes. If redistribution is unavailable or uncertain, publish an acquisition manifest and synthetic/minimal permitted replacements, and mark the unavailable real-fixture gate INCOMPLETE. Do not call the public real-fixture suite reproducible while depending on an undisclosed private file. Dependency licenses/notices, including shader adaptations, are evaluated in [Reference projects](REFERENCE_PROJECTS.md) and the existing [licensing documentation](../licensing/MIT_READINESS.md).

## Measurement lifecycle

Use monotonic clocks within each process and a run-wide trace correlation ID. Cross-machine ordering uses operation/transaction/causal IDs; do not compute millisecond propagation from unsynchronized wall clocks. Record clock synchronization error when using cross-host timestamps, or collect sender round-trip and receiver-local intervals separately.

| Event | Definition |
| --- | --- |
| input_received | Native OS event arrives at the application; also record injected-device time where available |
| command_submitted | User or MCP semantic operation is submitted with its request/operation ID |
| queued / preparing / accepted | Engine milestones from its contract; accepted is an ephemeral validated candidate/preview, not public completion |
| commit_started / commit_finished | Actual storage boundary around recoverable transaction commit |
| published | Canonical public revision becomes readable after the required durable boundary |
| response_received | Complete ordinary MCP success/error received by the client, including queue, serialization and transport |
| presented | Compositor/display presentation of the frame containing the correlated edit; distinguish submit, GPU completion and actual presentation |
| peer_staged / peer_applied | Separate remote byte staging and validated durable publication milestones |
| first_usable | First page has authoritative edit dependencies, hit testing/text ready for a successful command; a preview image does not qualify |
| viewport_ready | Requested viewport has resolved fonts/assets/layout/effects at its stated revision, or reports explicit missing-resource diagnostics |
| all_content_ready | Complete import/restore scope is validated and available under the contract, independently of residency |

Ordinary MCP writes count as completed only at their durable response. A job ticket, preview, accepted candidate or staged remote byte receipt is never substituted. An operation that commits but loses its response is measured as uncertain until lookup resolves it; its duplicate-key test then proves exactly one semantic effect. Do not stop the timing at an optimistic UI label.

For input-to-presentation, use supported native presentation feedback or calibrated external capture. If only event-loop or GPU-submit timestamps are available, name that metric accurately and mark the presentation metric INCOMPLETE. Report missed refreshes and input loss as well as frame intervals. The reciprocal of a scripted event interval is not a hardware FPS measurement.

## Scenario recipes

The proposed harness implements the exact schedules below through native input and real local MCP transports. Direct in-process calls may diagnose a failure but cannot replace the integration result. Every operation targets fixture-defined stable IDs; peer/session authors are distinct. Store tool schemas and capability negotiation with the run.

### W1 — One heavy document

Run D-REAL first-import and D-NATIVE reopen series, then repeat the interaction series on D-NATIVE and D-100K. On the first usable page, submit three independent small edits immediately while unrelated background restoration continues. A separate controlled case pauses unrelated-page loading for 30 seconds to prove those edits do not depend on it; a genuinely required component/font dependency must instead produce the documented wait/error.

After warmup, repeat ten 60-second cycles: 0–20 seconds anchored pan/zoom, 20–40 seconds continuous drag with a commit every second, 40–60 seconds rich-text insertion/deletion/range formatting and layer/page rename. Inject pointer motion at the display cadence and record what was delivered. Change to the next fixture page at each minute boundary; record that transition outside the continuous-motion distribution. Traverse every remaining page during the correctness phase.

One agent session runs two bounded reads per second and one independent small write per second on known resident content. Rotate get_context, get_styles and a subtree of at most 32 nodes; writes change one scalar/name or a short text range and have request bodies at most 4 KiB. Keep the agent's targets separate from the active drag/text target for the uncontended SLO distribution; record deliberate same-target conflicts separately in W4.

Verify durable readback, author Undo/Redo, complete export and fresh-process reopen. Do not defer the early edit until all pages load. Startup series and warmed distributions are published separately.

### W2 — Five and ten heavy documents with agents and jobs

Run four independent variants: N = 5/10 crossed with D-RES-S/D-RES-D. All N documents have live leases; each has an active target page and scheduled agent activity. Pin only declared query/gesture dependencies through normal resource admission, never bypass the global budget for the benchmark. Failure to admit the required active workload is a failed availability/resource case, not a reason to remove that document from the result.

The foreground view performs W1's 60-second cycle and switches to the next document every minute. Four agent sessions round-robin all N documents, each issuing five bounded reads and two small writes per second, with deterministic staggered offsets. Use the same bounded operation definition as W1 and different targets/authors. Log requested document identity and returned identity/revision on every response.

At measured seconds 30, 210 and 390, schedule a foreign import of D-REAL into one separate staging document. Close its completed temporary view/lease only after integrity and durable-readback checks; never discard a running operation to manufacture a low memory result. At seconds 60, 180, 300, 420 and 540, export another document's full portable content. At seconds 90, 210, 330, 450 and 570, request the storage harness's normal checkpoint policy on a third document. The checkpoint hook is proposed test instrumentation, not a claim of an existing MCP tool.

Normal admission limits apply to all jobs. Record queue delay, rejection, progress and cancellation; no job is launched outside the engine scheduler. Each scheduled job has a 300-second harness watchdog for a bounded run, independent of any tighter operation-specific limit. A watchdog expiry is FAIL, not a successful cancellation. After minute ten, stop new work and drain for up to 300 seconds, verify every admitted operation, then reopen all documents in a fresh authority. Peak memory includes the drain. Resident foreground operations must meet their gates while the background jobs run.

### W3 — Four actively editing collaborators

Run four independent native clients on the same D-NATIVE document, then the same D-100K document. Each client also holds enough independent heavy documents for total N = 5 and N = 10, with the shared/distinct resource variants recorded as in W2. All clients render or inspect their own view; no single process impersonates all four replicas in the performance claim.

During each measured minute, client A drags/resizes shapes, B types and formats rich text, C performs group/reorder/component edits, and D edits token/style/layout properties. Rotate roles every minute. Every client submits at least one actual content mutation per second during its active interval; continuous gestures supply display-cadence events with one semantic group per gesture. Merely sending cursor/presence traffic does not count as active editing.

Two local agent sessions per client each issue two bounded reads and one small write per second, spread across the shared and background documents. Local agents have separate authors from the GUI. The four clients' ordinary targets are initially disjoint to measure usable concurrent work; W4 supplies controlled conflicts. At seconds 120 and 360, run an export on each client's background document. At seconds 240 and 480, schedule a foreign import on two alternating clients. Record every client's performance, memory, durable responses, propagation distributions and queue lengths.

After new edits stop, allow at most 30 seconds on the standard network for all admitted ordinary operations and replication queues to settle. Compare canonical semantic digests, text/marks, ordering, component references, asset hashes and transaction membership on all clients. Include unloaded pages by querying/exporting authoritative state. Local cache order, replica counters and raw CRDT encoding bytes need not be identical; durable semantic state must be. A continuously growing queue or a client excluded from the final comparison fails the run.

### W4 — Conflicts, interruptions and recovery

Use D-SEM minimized cases and selected D-NATIVE/D-100K pages. Run each registered conflict/fault case with all three seeds and every relevant delivery-order permutation; repeat each crash injection boundary at least ten times. Preserve the exact operation transcript and failure location. Larger randomized/property tests may add coverage but do not replace these named cases.

Cover simultaneous scalar edits, same/different-parent moves, ancestor deletion, component-source updates with instance overrides, cross-shard page moves, same-text insert/delete/formatting, agent versus human Undo, and multiple authors editing different documents. Deliver duplicate, reordered and delayed transaction fragments; withhold a required shard and one asset; let one peer fall behind, disconnect for 20 seconds and rejoin under the slow-network profile. After connectivity returns and new writes stop, require convergence within a declared 60-second recovery deadline for the finite transcript. Operations expected to reject have their precise error/nonmutation oracle; unexpected rejection is a failure.

Kill the owning worker/process before commit, after durable commit but before response, after peer staging but before validation/publication, during checkpoint/compaction, and during export/portable-file replacement. Inject full-disk, read-only storage, truncated staged bytes, corrupt complete payloads and missing assets in isolated profiles. Recover according to the storage contract: acknowledged edits survive, uncommitted partial candidates do not become public, corruption is detected, and retained files/assets are not silently discarded. Process kill proves process-crash behavior; power-loss claims require a separate storage/power-failure experiment.

### W5 — Headless agents and collaboration

Launch the native service with no GUI/shell process. Verify the process/dependency graph and prohibit a hidden WebView/Chromium/text-measurement helper. Run N = 5/10, both resource variants, four agent sessions using W2's read/write rate and schedule, plus real imports, native layout queries, screenshots, all supported export formats and the additive token/comment/folder/code/snapshot/effect operations.

A screenshot/export must resolve actual fonts/resources at a pinned revision and match the same engine output in W7. Open one additional peer service and run collaboration; the four-service version reuses W3's semantic transcript without a display-performance claim. Explicit GUI-only operations return advertised unavailability, while required design commands continue to work. Closing a later GUI connection must not destroy an agent-owned document lease. End with durable reopen in a new service process and complete-content export.

### W6 — Resource endurance

For each resource variant at N = 5/10, repeat a 60-second loop for 60 minutes: traverse ten page targets, switch through all N document leases, perform 20 small edits, Undo/Redo ten own groups, request ten bounded screenshots, and open/close a temporary document. Every fifth minute run one import and one full export through ordinary job admission. Explicitly release completed snapshot/result leases when the protocol requires it; a separate case tests abandoned clients until expiry.

At minutes 15, 30, 45 and 60, stop issuing work, drain admitted jobs, wait for GPU fences and take a declared quiescent sample after a 30-second idle window. Do not call private cache-reset or allocator-trim functions solely for the measurement. Resume after the sample; the idle windows are reported separately from active time.

The run must satisfy resource admission ceilings and observed-RSS gates throughout. Between the minute-15 and minute-60 quiescent samples, unexplained retained managed CPU/GPU allocations must not grow by more than the greater of 5% of the earlier retained value or 64 MiB; retained leases/history permitted by policy must be itemized. This is a proposed leak-detection threshold, not permission to exceed the main ceilings. Report process-RSS trend and allocator/driver retention separately; a stable managed ledger alone does not prove stable total memory. A persistent unexplained upward trend requires investigation and blocks resource qualification.

### W7 — Compatibility, semantics, visual output and platforms

Run every MCP action/schema subcase, every REQUIRED UI/PAPER/RT/FIG row and all 30 SHADER rows from the capability matrix. Use D-SEM and representative real source frames with exact font/assets. Compare UI edits, equivalent MCP commands, headless output, portable export/reimport, working-file reopen and collaboration. Verify legacy OMC/Yjs conversion with explicit identity/epoch rules and mixed-version rejection; a new native file must not pretend to be a wire-compatible old room.

At minimum, test all admitted geometry/paint/layout/text/property enums, every export format and every shader parameter family. A fallback raster may qualify only a documented preserved-picture mode; it cannot pass an editable component/text/vector case. Unsupported required cases are FAIL. Missing licensed input/reference data is INCOMPLETE. Record malformed/unsupported input diagnostics and nonmutation rather than testing only favorable examples.

Run the packaged native platform journeys below on clean supported OS installations. W7 functional results do not satisfy W1–W3 interactive latency on a different OS/GPU; publish each platform/profile result separately.

## SLO gates and aggregation

These are acceptance targets, not measured achievements. The overview owns the headline targets; the workload scope here prevents an easy microbenchmark from replacing them.

| Gate | Required target | Scope and failure interpretation |
| --- | --- | --- |
| G-FRAME | Frame interval p95 ≤16.7 ms and p99 ≤33.3 ms at 60 Hz | Every client and required continuous pan/drag series in W1/W2/W3; at least 1,000 intervals; input/presentation/missed refreshes also reported |
| G-MCP | End-to-end p95 ≤100 ms | Already-resident bounded ordinary reads and small writes in W1/W2/W3/W5; writes include durable commit and complete response, not a ticket or preview |
| G-DUR | Submission-to-local-durable-ack p95 ≤500 ms | General small UI/MCP edits; a write in G-MCP must meet both gates, so 500 ms does not relax its stricter 100 ms response target |
| G-ISOLATION | Foreground gates remain satisfied during the scheduled other-document work | Compare active-job windows as well as the complete run; idle gaps cannot dilute the background-contention result |
| G-MEM | Managed allocation and observed peak targets in the implementation guide | Full application process set, standard W2/W3 five/ten-document variants, W5/W6 and declared GPU accounting; profile upgrades cannot erase a standard failure |
| G-OPEN | Separate first-usable, viewport-ready, first-durable-edit and all-content completion thresholds | Numeric native cold/warm limits must be registered at M0 before qualification; unset thresholds mean INCOMPLETE, even if timings are reported |
| G-COLLAB | Four editable clients, finite queues and correct bounded convergence | W3/W4; publish local/remote propagation p50/p95/p99 where sample counts permit; network profile is part of the claim |
| G-CORRECT | All applicable correctness and required capability cases PASS | Performance improvements cannot compensate for data loss, failed source semantics or an unavailable required feature |
| G-PLATFORM | All required clean-package, native input/accessibility and no-browser cases PASS | Separate Linux, Windows and macOS results; source compilation alone is insufficient |

Evaluate each repeat, client, fixture and resource variant separately. Every required result must pass; a pooled percentile or average cannot turn one failing client into PASS. Report intentional contention/stale-dependency cases separately from the resident uncontended distribution, while retaining their counts, expected errors and bounded completion. Unexpected timeouts, crashes, corruption, lost input and missing admitted operations are failures regardless of a favorable percentile.

### Peak CPU and GPU memory

Sample the complete process tree at least every 50 ms from before launch until all workers/services exit, with spawn/exit event tracking so short-lived import/export helpers are included. The sampled aggregate peak is the maximum of the simultaneous sum across processes, not the sum of each process's independent maximum. Report OS per-process high-water marks separately; they cannot reconstruct a simultaneous aggregate peak.

RSS/working-set sums may count shared mappings repeatedly. Where available, also report PSS/USS/private bytes, shared mappings and the collection method. Where the OS provides no equivalent metric, state the omission; do not manufacture a cross-platform total. A 50 ms sampler may miss shorter peaks, so describe it as a sampled lower bound on the true temporal peak unless finer event/accounting evidence covers allocations.

Record reservation/actual managed CPU bytes by category, native-library/runtime allocations that escape the ledger, mapped files, transport buffers, temporary import/export copies and peaks during load/checkpoint/recovery. GPU reporting includes textures, glyph atlases, intermediate effect surfaces, submission/fence retention and offscreen tiles. On unified-memory systems, identify overlap with CPU-visible allocations; do not add GPU bytes to RSS and call that physical RAM without evidence. Budget conformance is an engine admission property plus observed-process evidence, not a claim that the OS enforces a strict total hard cap.

## Correctness case registry

Each case contains positive, negative and recovery subcases as applicable. The contract documents define the expected state; these are required evidence obligations, not alternative conflict rules.

| ID | Required experiment and oracle | Owner |
| --- | --- | --- |
| CQ-DUR | Kill before/after actual commit and before response; every acknowledged transaction survives reopen, and no uncommitted candidate is public | Storage |
| CQ-IDEM | Resume a registered principal and replay identical key/body across reconnect/restart; reject different body, wrong/revoked resume credentials and unsafe legacy-session restart assumptions; exactly one semantic edit and original result/expiry semantics | Core + Storage |
| CQ-CANCEL | Cancel queued/computing/precommit work and race cancellation with commit; no false cancelled result for committed state, no leaked reservations | Core + Workspace |
| CQ-ATOMIC | Fail the final batch item and one required shard; all-or-none local/remote publication, including assets and Undo grouping | Core + Collaboration |
| CQ-REV | Stale page/generation/revision, reused aliases and deleted IDs; correct rejection with no mutation of another document | Agent + Core |
| CQ-LOAD | Pause unrelated restoration; loaded-page edit completes; missing genuine dependency is explicit; complete export includes evicted content | Storage + Core |
| CQ-MIG | Legacy/new file round trips, identity-preserving versus copy mode, interrupted migration and mixed-version room rejection | Interchange + Storage |
| CQ-CONV | Four active authors, duplicate/reordered delivery, partition/rejoin and deterministic semantic digest across all affected shards | Collaboration |
| CQ-CROSS | Cross-page move with component/style/asset dependencies; withhold fragment/shard and prove no partial visible publication | Collaboration + Core |
| CQ-TEXT-01 | Same-gap concurrent inserts, overlapping observed-range deletion and reordered delivery; retain both inserts and delete only observed characters | Text + Collaboration |
| CQ-TEXT-02 | Overlapping/disjoint formatting and paragraph split/merge; per-attribute conflict policy and inherited insertion marks match fixed golden result | Text + Collaboration |
| CQ-TEXT-03 | Korean native IME composition with remote insert/delete/target deletion; one commit or explicit recovery buffer, no stale whole-string overwrite | Text + Desktop |
| CQ-TEXT-04 | UTF-16 half-open API offsets versus UTF-8/scalars/graphemes, emoji/ZWJ/combining/Hangul/bidi; invalid surrogate boundaries reject | Text |
| CQ-UNDO | Author-selective scalar/path/text/mark/group Undo and Redo with foreign edits interleaved; no foreign character deletion or global-snapshot overwrite | Core + Collaboration |
| CQ-ASSET | Verify bytes/hash before referenced publication; missing/corrupt assets, history pins, removal/restore, and GC never remove reachable content | Assets + Storage |
| CQ-QUERY | Revision-pinned pagination under writes, expiry/eviction, output bounds and bounded SQLite reader lifetime | Agent + Storage |
| CQ-LIMIT | Exact boundary and one-over-limit requests/queues/resources, including complex imports/effects; explicit bounded failure and no partial edit | Workspace + Agent |
| CQ-FAULT | Disk-full/read-only/corrupt staging/checkpoint/worker-loss/restart; explicit failures and recoverable acknowledged state | Storage + Desktop |
| CQ-SCOPE | GUI focus/page changes and agent background work race; explicit document/session identities and independent leases remain correct | Workspace + Agent |
| CQ-EXT | Folders/archive, comments/resolve/orphaned anchors, tokens, snapshot, code and effect extensions: negotiated schema, authored state, reopen and offline merge | Workspace + Collaboration |
| CQ-RENDER | One canonical/layout revision drives hit tests, visible/native offscreen output and export; masks/text/parameters cannot come from stale projections | Render + Layout |
| CQ-NATIVE | Required editing/layout/text/render/export in service and desktop have no browser helper/dependency fallback | Desktop + Render |
| CQ-SCHEMA | Exact 50-tool discovery and all supported action/runtime-validation subcases; negotiated additive extensions do not silently alter old schemas | Agent |

For CQ-TEXT-01/02, pin replica IDs, starting text/item identities, operation causal history and expected sequence/marks. A final string comparison alone misses damaged formatting or unstable anchors. Include concurrent insertion inside a remotely deleted range, two inserts at the same gap, disjoint styles, conflicting values for one style, and text-node deletion during composition.

For CQ-UNDO, A inserts text, B inserts within/adjacent to it, C formats an overlapping range and D deletes another observed range. A's Undo removes only A's inserted items; B's text and independently applicable C/D effects remain according to the contract. Repeat for deletion restoration, marks, object moves and grouped multi-shard edits. Native v1 layer Undo is session-local as specified by the engine; restart tests verify durable content/operation recovery, not an invented persistent Undo-stack guarantee.

### Machine-readable correctness denominator

This valid JSON is initial registry data for a future checker, not a native test result. Every identifier must resolve to the table above; evidence references remain empty until the experiment actually runs.

~~~json
{
  "registry_version": "native-correctness/1",
  "status": "NOT_RUN",
  "cases": [
    {"id": "CQ-DUR", "status": "NOT_RUN", "evidence": []},
    {"id": "CQ-IDEM", "status": "NOT_RUN", "evidence": []},
    {"id": "CQ-CANCEL", "status": "NOT_RUN", "evidence": []},
    {"id": "CQ-ATOMIC", "status": "NOT_RUN", "evidence": []},
    {"id": "CQ-REV", "status": "NOT_RUN", "evidence": []},
    {"id": "CQ-LOAD", "status": "NOT_RUN", "evidence": []},
    {"id": "CQ-MIG", "status": "NOT_RUN", "evidence": []},
    {"id": "CQ-CONV", "status": "NOT_RUN", "evidence": []},
    {"id": "CQ-CROSS", "status": "NOT_RUN", "evidence": []},
    {"id": "CQ-TEXT-01", "status": "NOT_RUN", "evidence": []},
    {"id": "CQ-TEXT-02", "status": "NOT_RUN", "evidence": []},
    {"id": "CQ-TEXT-03", "status": "NOT_RUN", "evidence": []},
    {"id": "CQ-TEXT-04", "status": "NOT_RUN", "evidence": []},
    {"id": "CQ-UNDO", "status": "NOT_RUN", "evidence": []},
    {"id": "CQ-ASSET", "status": "NOT_RUN", "evidence": []},
    {"id": "CQ-QUERY", "status": "NOT_RUN", "evidence": []},
    {"id": "CQ-LIMIT", "status": "NOT_RUN", "evidence": []},
    {"id": "CQ-FAULT", "status": "NOT_RUN", "evidence": []},
    {"id": "CQ-SCOPE", "status": "NOT_RUN", "evidence": []},
    {"id": "CQ-EXT", "status": "NOT_RUN", "evidence": []},
    {"id": "CQ-RENDER", "status": "NOT_RUN", "evidence": []},
    {"id": "CQ-NATIVE", "status": "NOT_RUN", "evidence": []},
    {"id": "CQ-SCHEMA", "status": "NOT_RUN", "evidence": []}
  ]
}
~~~

## Fidelity oracles

Every visual fixture pins dimensions, scale/DPI, color space/alpha handling, font face bytes, backend/version, source revision and effect time/seed. Compare semantic structure before pixels: component/instance/override identity, authored layout/rules/tokens, exact text/runs, masks/clips and source mappings must be correct. Object counts and a high global image similarity score do not establish these properties.

Initial proposed tolerances for the same pinned font/layout profile are geometry displacement at most 0.25 logical pixel and flat-interior per-channel RGBA difference at most 2/255. Declare a narrow edge antialias band separately and publish its mask/error distribution; do not exclude whole text/effect regions as “edges.” Exact text content/run semantics and mask topology remain required. Platform/backend differences need named reviewed tolerances per case, not a blanket waiver.

Each shader has default/boundary parameter fixtures and fixed samples at time 0, 0.5 and 1.0 seconds, plus a 60-frame sequence at a declared 60 fps timebase. Pin seed and input assets; repeat renders on the same backend must agree under that shader's registered tolerance. Cross-backend numerical variation uses an explicit case-specific bound. Inspect discontinuities, alpha, animation timing and large-surface behavior; a single SSIM threshold for all 30 shaders cannot pass the catalog.

Reference browser/upstream rendering is allowed in external test tooling to produce or compare fixtures. It must not be linked, launched or required by the native application to open, edit, measure text, render, screenshot or export. Retain the reference-generation script and rights/provenance record with each golden asset.

## Packaged platform gates

All three platform families are required for the stated desktop replacement. M0 records the concrete minimum OS versions and architectures to support; an unspecified target is INCOMPLETE. Test every published architecture independently. A platform may be described as experimental while its gate is incomplete, but that is not a three-platform release claim.

| Platform | Native input/accessibility journey | Installation/integration journey |
| --- | --- | --- |
| macOS | Korean IME preedit/commit/cancel, dead keys, emoji/bidi, VoiceOver tree/actions and text ranges; mixed-DPI windows | Clean application bundle; declared signing/notarization/quarantine behavior; menus, file dialogs, clipboard, drag/drop, GPU restore and offline launch |
| Windows | Korean IME through actual OS input, emoji/surrogate handling, NVDA/UI Automation roles/actions/text selection; per-monitor DPI | Clean declared installer/package on supported architectures; signing/update/uninstall/profile behavior, file dialogs/clipboard, sleep/resume and GPU/device recovery |
| Linux | IBus and Fcitx5 Korean composition where advertised, Orca/AT-SPI semantics; keyboard/focus across canvas/inspector | Clean declared package; Wayland and X11 results separately, font discovery, dialogs/clipboard/drag-drop, GPU/backend and offline dependency availability |

Use real native keyboard/IME events and accessibility APIs. Assigning text directly through an internal setter or MCP proves text commands, not an OS composition journey. Record screen-reader versions and actual navigation/actions; an empty or mislabeled accessibility tree fails even if pixels look correct. Native controls and canvas text require separate focus/caret checks.

Run launch → import/open → select/drag → range edit/IME → Undo/Redo → durable save → quit/reopen → export → local MCP → collaborator rejoin on a clean installed package. Include denied file access, unavailable font, disconnected display/device recovery and profile upgrade/rollback behavior. An unsigned developer build may pass functional cases under that exact label; it does not establish signed/notarized distribution. Missing credentials/artifacts for a promised package are INCOMPLETE, not fabricated signing success.

Record package hash, manifest/dependency inventory, bundled notices, native runtime dependencies and process tree. No mandatory Electron, WebView2, WKWebView, CEF or hidden Chromium renderer may appear in the required editing path. The existence of an optional external capture producer does not relax this requirement.

## Evidence format

Publish a machine-readable result and compact human interpretation for each run, plus raw latency samples, operation receipts, process/memory trace, fixture/capability manifests and sanitized reproduction instructions. Use content hashes for attachments. Exclude credentials, invitations and private document content from public logs; use deterministic public fixtures for public evidence.

The example below intentionally contains no measured values. A future runner fills them from observations, not from the target column. Null is different from zero, and an empty error array in a NOT_RUN record is not evidence of no errors.

~~~json
{
  "schema": "native-qualification/1",
  "run_id": null,
  "status": "NOT_RUN",
  "scenario": "W3",
  "candidate": {
    "commit": null,
    "binary_sha256": null,
    "schema_version": null,
    "lockfile_sha256": null
  },
  "profile": {
    "name": "native-standard",
    "definition_status": "PROPOSED",
    "machine_manifest_sha256": null,
    "client_count": 4,
    "open_documents_per_client": 10,
    "resource_variant": "D-RES-D",
    "viewport_logical_px": [1440, 900],
    "refresh_hz": 60,
    "network_observations": null
  },
  "schedule": {
    "seed": 101,
    "warmup_seconds": 60,
    "measured_seconds": 600,
    "expanded_trace_sha256": null,
    "repeat_index": null
  },
  "fixtures": {
    "source_manifest_sha256": null,
    "native_manifest_sha256": null,
    "bytes_verified_this_run": false
  },
  "metrics": {
    "frame_interval_ms": {"n": 0, "p50": null, "p95": null, "p99": null, "max": null},
    "input_to_presentation_ms": null,
    "resident_mcp_durable_response_ms": {"n": 0, "p50": null, "p95": null, "p99": null, "max": null},
    "small_edit_durable_ack_ms": null,
    "peer_applied_ms": null,
    "sampled_aggregate_rss_peak_bytes": null,
    "managed_cpu_peak_bytes": null,
    "managed_gpu_peak_bytes": null,
    "gpu_rss_overlap_description": null,
    "convergence_ms": null
  },
  "gates": {
    "G-FRAME": "NOT_RUN",
    "G-MCP": "NOT_RUN",
    "G-DUR": "NOT_RUN",
    "G-MEM": "NOT_RUN",
    "G-COLLAB": "NOT_RUN",
    "G-CORRECT": "NOT_RUN"
  },
  "correctness_registry_sha256": null,
  "capability_evidence_manifest_sha256": null,
  "failure_count": null,
  "incomplete_reasons": [],
  "artifacts": [],
  "review": {"implementation_owner": null, "independent_reviewer": null}
}
~~~

For a completed run, the per-client/per-document/per-repeat records are mandatory; the example is only a compact envelope. Include attempted/succeeded/rejected/timed-out/cancelled/uncertain/resolved operation counts, peak queue length, all job outcomes and the mapping from authored operations to durable receipts. Include a registration hash for gate thresholds so a reader can identify post-run changes.

## Evidence status and release decisions

| Status | Exact meaning |
| --- | --- |
| NOT_RUN | No execution evidence for this candidate/case. A source-code declaration, plan or external product claim does not change this state. |
| INCOMPLETE | Execution/setup began, but a required prerequisite, threshold, sample count, platform, fixture, artifact or observation is missing. List the reason; this is not a pass. |
| FAIL | An observed result violates the registered contract/threshold, or an unexpected timeout/crash/data loss occurs. Missing later artifacts cannot erase an observed failure. |
| PASS | All registered subcases/assertions and required measurements ran at the exact candidate/profile, all thresholds passed, evidence is complete and independently reviewed. |

An unsupported required feature is FAIL once exercised, even if discovery accurately reports it unsupported. An explicitly deferred optional feature is recorded with its approved disposition; it is not counted as a passing required case. The classification is about the declared target, not blame for an unavailable third-party fixture.

For an aggregate release gate, FAIL dominates; otherwise any INCOMPLETE or NOT_RUN required row blocks PASS. Keep those missing states visible rather than replacing them with one optimistic percentage. A three-platform/native-Paper-workflow claim requires all mandatory catalog, semantics, combined-workload and platform rows. Partial releases must name the actually qualified subset and remaining failed/incomplete requirements.

## Commands and reproduction entry points

**Existing documentation check:** in a complete current checkout with locked Node dependencies installed, run node scripts/check-docs.mjs as described by the [implementation guide](IMPLEMENTATION_GUIDE.md#commands-that-exist-today). Existing Electron/FIG checks remain documented in [TESTING.md](../TESTING.md) and the fixture manifest; they do not run this native suite.

**Proposed future commands, not currently executable:** the native workspace and xtask runner do not exist at the planning revision. WP-01/WP-02 must implement the interfaces below, fixture generation, evidence writers and failure exit codes before they are advertised as working commands.

~~~sh
cargo run --manifest-path native/Cargo.toml -p xtask -- contracts
cargo run --manifest-path native/Cargo.toml -p xtask -- qualify --scenario W1 --profile native-standard
cargo run --manifest-path native/Cargo.toml -p xtask -- qualify --scenario W2 --profile native-standard
cargo run --manifest-path native/Cargo.toml -p xtask -- qualify --scenario W3 --profile native-standard
cargo run --manifest-path native/Cargo.toml -p xtask -- qualify --scenario W4 --profile correctness-ci
cargo run --manifest-path native/Cargo.toml -p xtask -- qualify --scenario W5 --profile native-standard
cargo run --manifest-path native/Cargo.toml -p xtask -- qualify --scenario W6 --profile native-standard
cargo run --manifest-path native/Cargo.toml -p xtask -- qualify --scenario W7 --profile native-standard
cargo run --manifest-path native/Cargo.toml -p xtask -- package --platform current
~~~

The future runner creates isolated profiles and writes complete artifacts under native/target/qualification/<run-id>/. It must never reuse a person's normal profile, silently overwrite golden images or tune thresholds. A proposed exit-code contract is 0 for PASS, 1 for observed FAIL and 2 for INCOMPLETE/setup failure; interrupted runs preserve partial evidence and cannot return PASS. Publish reviewed result summaries under docs/qa/native/ with source/build/fixture hashes. Until these commands and their evidence exist, the native status remains NOT_RUN.

