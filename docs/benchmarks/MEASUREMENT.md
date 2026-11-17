# Measurement and collector contract

**Protocol:** `omc-local-dev/1`

**Status:** specification; new collectors and comparative results **NOT_RUN**. Event names below describe required instrumentation, not telemetry already emitted by the application.

This contract defines what each number means, where observation starts and ends, and when a number is too incomplete to support a claim. Read it with [WORKLOADS.md](WORKLOADS.md), [ANALYSIS_PLAN.md](ANALYSIS_PLAN.md), and the source-backed [IMPLEMENTATION_MAP.md](IMPLEMENTATION_MAP.md). The latter identifies existing signals and the gaps to implement.

## 1. Required measurement layers

| Layer | Collect | What it can establish |
| --- | --- | --- |
| External agent | Every model request, actual usage, model-bound input, tool output projection, retries, subagents and compaction | Metered external-agent expenditure for an accepted task |
| Product boundary | Client request/response, input events, visible result, save indication, exported artifact | Cross-product user-observable latency and correctness |
| OMC internals | Queue, worker, storage, snapshot, scene, layout, cache and submission spans | Attribution of OMC cost; not unobservable competitor stages |
| Local OS | Process membership, physical-footprint/RSS accounting, CPU time, I/O, faults, network and optional GPU/energy | Declared local-device resource demand |
| Acceptance | Semantic assertions, visual evidence, source build/behavior, normal reopen and specific recovery checks | Whether a result is actually usable |

Use the same external endpoint for primary product comparisons. OMC's internally durable receipt can explain its behavior, but an undocumented competitor tool acknowledgement must not be labeled the same storage guarantee. A service-only result and an attached desktop result are distinct profiles.

## 2. Environment and launch identity

The first proposed comparison platform is one supported macOS machine on which all three desktop products run. Record its exact model, CPU/GPU, physical memory, OS/build, storage and free space, display/refresh rate/backing scale, power connection/mode, thermal state, and installed fonts. A 16 GiB machine with a 60 Hz display and 1440 x 900 logical viewport is a useful initial target, not evidence that testing occurred on that machine. Repeat on another resource class only as a separately registered cohort.

Use OMC release binaries and record the actual backend. The inspected build supports a Metal desktop path on macOS and a software fallback; a compiled feature or installed GPU does not establish which path ran. Product installation, sign-in, initial indexing and shader setup are recorded separately from a ready-session task. New task-specific assets, document conversion, mapping, and repair remain in task cost.

Existing commands that can prepare an OMC release build are:

```sh
cd native
cargo build --locked --release \
  -p omc-service -p omc-cli -p omc-desktop
```

Running from `native/` selects its pinned Rust toolchain through rustup; a root-level `--manifest-path` alone does not select the nested toolchain file. Use the platform prerequisites and save the compiler/target, flags, executable hashes, clean source commit, enabled features, launch arguments, profile path identity, actual renderer, and tool-schema hash. Verify the actual connected service and worker executable hashes, not only sibling files: the desktop can reuse an already-ready service descriptor before launching a sibling service. Root `npm start` is the Electron path and does not identify a native run. Use disposable benchmark profiles, never a user's working design library.

The existing native service probe may be reused as a diagnostic starting point with an explicit `OMC_SERVICE_BINARY`; its hardcoded `build: "debug"` output is not verified provenance. It does not collect the complete metrics below. This specification does not add a `benchmark-all` command or claim that the comparison can already be run with one command.

## 3. Clocks and event boundaries

Use a monotonic clock for elapsed time and a UTC wall timestamp for provenance. Every event identifies its clock domain, process instance, run, request/operation, document, and revision when available. PID alone is insufficient because it can be reused.

Do not subtract arbitrary timestamps from different processes or machines. Collect client round trips on one clock; use a shared verified host clock, trace clock calibration, or request/response synchronization with a recorded error bound for cross-process phases. Report clock error and acquisition/capture quantization next to small latency differences.

### Event vocabulary

| Event | Exact boundary |
| --- | --- |
| `attempt.start` | The task brief and permitted starting resources become available to the agent; sampling is already active |
| `model.request` / `model.response` | Complete request submitted / response completed, with provider request ID and usage reconciliation state |
| `tool.request` / `tool.response` | Agent client sends the tool call / receives its final response or async receipt |
| `tool.job.complete` | An async job's actual terminal result is observed; retain polling interval and all polls |
| `input.injected` / `input.received` | Deterministic OS input emitted / app receives it, where instrumentation is possible |
| `admission.granted` | OMC's document operation leaves the admission queue; an internal-only stage |
| `storage.acknowledged` | A result with explicitly recorded durability semantics is emitted; distinguish durable receipt, save indicator and ordinary tool return |
| `snapshot.installed` | Desktop has installed the intended revision, not merely received some bytes |
| `scene.accepted` | The intended scene revision is accepted for rendering; record discarded/stale scene work separately |
| `frame.submitted` | CPU work has queued the frame/presentation; not proof that pixels were displayed |
| `frame.presented` | Platform presentation feedback or calibrated external observation confirms the relevant visible change |
| `candidate.ready` | Candidate artifact is persisted and all prescribed active developer verification has finished; immutable evidence is captured |
| `candidate.accepted` | Independent acceptance checks approve that specific candidate; the approval may occur later |
| `attempt.stop` | Success, deadline/budget exhaustion, or terminal failure; preserve actual time and all consumed work |
| `tail.complete` | Registered post-task observation completes; pending work and process lifetime are recorded |

For successful attempts, verified completion time is `candidate.ready - attempt.start` for the first candidate later accepted by the independent oracle. Active developer verification, including builds/tests and feedback used for repair, occurs before `candidate.ready` and is timed. All async work necessary for the required persisted design, visible output, source, assets and export must also finish before readiness; a queued export or pending required save cannot be moved into an uncounted tail. If required work finishes later, move readiness to that later time and apply the original deadline. Offline blinded grading delay is benchmark administration and is not added. If a candidate fails, its timestamp is not a completion; a later repaired candidate may qualify within the same deadline. Preserve every submitted candidate to prevent retrospective selection.

The failure-aware primary time endpoint assigns the registered task deadline to an unsuccessful valid attempt. This is an analysis quantity, not a fabricated observed duration. Store actual elapsed time, acceptance time if observed, deadline, and failure reason separately. See [verified completion time](ANALYSIS_PLAN.md#verified-completion-time).

### Latency metrics

| Metric | Definition | Required label/caveat |
| --- | --- | --- |
| Tool round trip | `tool.response - tool.request` on client clock | Async receipt and completed job are separate |
| Durable edit round trip | Request to receipt with known durable semantics | OMC-internal guarantee unless a comparator has the same established contract |
| Agent edit to visible change | Client edit request to correct changed pixels | Includes service/network, polling, reconstruction, layout and presentation |
| Input to preview | Input to first responsive visual feedback | May use a cached preview; verify that it corresponds to the intended interaction |
| Input to exact content | Input to correct current-revision content | Report alongside preview; stale or missing edge content is not exact |
| First usable open | Launch/open request to first accepted edit on correctly loaded content | A window or spinner does not count |
| Accepted task time | Defined above, including ordinary repair and active verification | Publish failure-aware endpoint and actual elapsed distributions |

OMC's existing `OMC_NATIVE_FRAME_TRACE` reports `input_to_submit_ms` and draw/submission details. Its pending timestamp can coalesce inputs; it is not a complete per-input latency distribution. Automation's last draw duration is not hardware FPS. Internal render/presentation-submit timing must retain those names until actual display observation exists.

## 4. Model usage and tool payloads

The provider's per-request accounting is authoritative. Maintain a request ledger with normalized mutually exclusive uncached input, cache-read input, cache-write input, and total output categories. Input/output totals may already contain image or reasoning subtotals. Save the original usage object and a versioned normalization rule; never add overlapping fields twice. [ANALYSIS_PLAN.md](ANALYSIS_PLAN.md#6-token-accounting) defines the exact equations.

Count the complete task: instructions, schemas, loaded skills, documentation, prompts, repeated history, tool results, screenshots, errors, retries, generated code, compaction, helper/subagent models, and billed cancelled calls where exposed. A tool result never sent to a model has transport cost but no model-input tokens. Provider metering not yet returned remains `null` until reconciled.

### Capture the actual client projection

For every tool result, distinguish:

1. Raw transport envelope and byte count.
2. Text/structured/image content emitted by the server.
3. The exact subset/transformation retained by the client.
4. The actual input submitted on the next model request, including history replay.

For OMC, specifically check the nested `tree` plus flat `nodes` response and screenshot values present in text/structured/image representations. Their source representation can duplicate bytes; only the actual client projection establishes whether those duplicates consume model input. Do not assume that all client SDKs forward every field or that image base64 automatically becomes ordinary text tokens.

Log product, actual MCP dialect, schemas discovered, schemas loaded into the prompt, tool names, request IDs, request/response byte counts, model-visible content hashes, attachment dimensions/media types, pagination, truncation, and retry reason. Tool definitions, command IDs inside one tool, and low-level native commands are different counts.

### Diagnostic efficiency measures

| Metric | Definition and interpretation |
| --- | --- |
| Total processed tokens | Sum of normalized input plus output over all attributed provider calls |
| Tokens per accepted result | Fixed-weight all-attempt token spend divided by acceptance rate; includes valid failed attempts |
| Model-visible context bytes | Exact UTF-8 text plus separately recorded image attachments after client projection; bytes are not tokens |
| Context-to-edit amplification | Model-visible design/context bytes divided by logical bytes of the required target delta; report both raw quantities and declare zero-delta cases undefined |
| Unrelated context fraction | Fixture-tagged irrelevant node/text content divided by classified model-visible design content; estimated attribution, not authoritative billing |
| Duplication fraction | Repeated normalized node/property content in one projected result, plus repeated context across calls reported separately |
| Tool/model round trips | Counts of network tool calls and model turns; separately count commands within batches and queries/pages |
| Repair work | Calls, tokens and wall time after a failed acceptance/validation check, including failed imports and rework |
| Setup amortization | Full session spend including initial tools/library/cache setup, plus declared subsequent tasks; never discard the first task |

Token attribution by instruction/schema/design/error category is useful but may be approximate because tokenizer boundaries and provider framing are not additive across arbitrary slices. Reconcile the total with provider usage and label attribution estimates. Do not substitute characters/4, tool credits, a screenshot byte count, or the final HTML token count for complete task usage.

Freeze provider pricing and billing categories only when making a monetary claim. Report token counts, actual metered model charges, product credits/licenses, and human time separately. Unobservable internal product AI remains `NOT_OBSERVABLE`; a narrower external-agent claim must explicitly say so.

## 5. Local resource boundary

Maintain a dynamic process registry keyed by PID plus start time/executable identity. Discover descendants and independently launched helpers; continue tracking after reparenting. Save joins/exits and final accounting. OMC's workspace metrics expose worker PIDs but are only one discovery source.

| Boundary | Include | Usage |
| --- | --- | --- |
| Product process set | Desktop, renderer/GPU/helper processes, service, all workers, local MCP bridge/CLI, required product-specific capture/export adapters | Primary local product footprint/CPU |
| Complete local workflow | Product set plus external agent/client and task-specific build/preview/capture processes | End-to-end local development demand |
| Companion development workload | Fixed IDE/extensions/language server/build/server used by LD12 | Report separately and in complete-workflow totals |
| Host/system | Memory pressure, compression/swap, shared compositor, total power and other uncontrollable services | System impact; attribution limits explicitly stated |

Use a dedicated browser profile/instance for browser arms so unrelated tabs cannot leak into or out of the accounting boundary. If the OS compositor, GPU daemon, or another shared process cannot be apportioned reliably, report it separately and measure a matched whole-machine condition. Do not invent a percentage of a shared process to make the product subtotal smaller.

The complete-workflow boundary is the **union** of process-instance identities in its constituent sets. Count each process once, even if a capture adapter appears in both a product-specific list and a workflow role. Role subtotals can overlap only when explicitly labeled; never sum overlapping subtotals as if they were disjoint.

Cloud servers are outside the local boundary. Report their service/network effects where observable and leave their compute/resource use unknown. Local resource reduction does not establish lower global compute or energy.

## 6. Memory, CPU, GPU, and I/O

### Memory

On macOS, use an OS-supported physical-footprint measure consistently for every process and calibrate against Instruments/VM Tracker. Apple distinguishes footprint from allocations and resident memory; compressed/swapped dirty memory is charged at its original size, and allocation instrumentation can omit some private Metal resources. Do not substitute a language heap counter or a single Activity Monitor screenshot. [M1]

Define `m_i(t)` as the chosen OS-charged physical footprint for process instance `i`. For the frozen product boundary `P(t)`:

```text
M(t)        = sum(i in P(t), m_i(t))
M_peak      = max(observed t in the registered window, M(t))
M_mean      = time_integral(M(t)) / observed_window_seconds
M_byte_sec  = time_integral(M(t))
```

This is a simultaneous sum under the named OS accounting convention, not a claim of perfectly de-duplicated physical pages. Do not sum each PID's independent lifetime high-water mark: their peaks may occur at different times. Report raw per-process samples, aggregate values, shared-memory limitations, compression/swap, and the exact collector API/version.

The confirmatory footprint estimand is the fixed-weight mean of per-replay `M_peak` for complete, equivalent deterministic work, as specified in the analysis plan. Also report largest observed peak, time-average/byte-seconds, idle residency, and post-close retention. A lower peak from a crash, rejected task, absent assets, an undeclared deviation from the registered renderer/backend, or unfinished required work is not eligible evidence of resource efficiency. Legitimate backend differences between correctly registered product profiles are part of the comparison, not automatic invalidations.

On Linux, `smaps_rollup`/PSS can support a separately labeled proportional-residency analysis; kernel documentation distinguishes PSS, RSS and shared mappings. Do not pool Linux PSS with macOS physical footprint or relabel a sum of RSS as unique physical RAM. [M3] Virtual address-space size is not a RAM-usage metric.

Track GPU allocations and resident device memory where supported, but preserve ownership and overlap. On unified-memory hardware, adding GPU allocation bytes to an OS footprint may double-count the same storage. Report separate overlapping categories unless the collector can prove disjoint accounting. Record backend, drawable/backing dimensions, image decoded pixels, and texture/cache residency.

### CPU and scheduling

Use cumulative user plus system CPU time across every process instance, including short-lived helpers and exited workers. Take interval deltas without adding already inclusive child counters again. Report CPU-seconds per complete task, per accepted result where defined, per idle minute, and the whole-workflow total. CPU percentage is a supporting time series whose normalization (one core versus machine capacity) must be stated.

Record queue wait, runnable/blocked time where available, wakeups/context switches, and UI-thread stalls. OMC admission reservations and queue counts are explanatory signals, not actual CPU/memory usage or a complete resource cap.

### I/O, network and energy

Record logical and physical disk I/O separately where the OS exposes them, database/WAL/profile size before and after, checkpoint duration, page faults, asset transfer and export bytes. Buffered writes and durable completion are different observations. Preserve the product's supported durability configuration.

For network, capture product-attributable sent/received bytes, request count, endpoint class, RTT/timeout/error, and online/offline scenario without recording credentials. Distinguish localhost IPC from remote service and asset traffic. Do not call a workflow local-only merely because its MCP endpoint is localhost.

Energy is optional until a valid whole-machine meter or calibrated platform counter exists. Record joules over fixed useful work, idle baseline as a separate observation, power/thermal state, battery/AC conditions, and calibration. Lower CPU time or memory is not proof of lower energy. A noisy baseline subtraction must retain uncertainty and never become a fabricated zero.

## 7. Sampling and observation windows

Use a target 50 ms cadence for lightweight resource counters, recording actual sample timestamps, duration, and gaps. Expensive mapping/GPU/stack capture may require a lower rate or a separate attribution run. Calibrate overhead before selecting the final cadence. A sampled peak is a lower bound on an unobserved continuous-time peak; disclose sampling resolution.

The collector must track process lifecycle between samples so a short-lived child cannot vanish from CPU/I/O accounting. If final counters are unavailable, mark those dimensions incomplete. Preserve negative/reset-counter anomalies as errors rather than silently clipping them into plausible totals.

Default windows are:

| Phase | Window | Reporting |
| --- | --- | --- |
| Pre-task baseline | 60 s in a declared ready/idle state | Full absolute baseline; no automatic subtraction from primary peak |
| Task | `attempt.start` through stop/accepted candidate | Agent-task resources, including wait/repair |
| Deterministic replay | Full fixed input/work sequence and required completion | Primary resource comparison window; same useful work for every product |
| Tail | At least 30 s after completed required work, longer if registered housekeeping remains | Resource retention, cleanup and background housekeeping; required saves/exports belong before readiness |
| Post-close | 60 s and 5 min after document close | Retained memory, worker lifetime, leaked or intentionally retained resources |
| Idle | 10 min without prescribed input | CPU/minute, footprint, wakeups, polling and network |

Freeze the maximum tail deadline during pilot. Primary replay footprint includes the full replay and its observation tail; a product that leaves registered finite jobs pending at the deadline has an incomplete replay, not a favorable shorter window. A normal persistent service or idle poll is recorded, not mistaken for an unfinished task. Required work discovered during the tail moves the candidate's readiness/completion boundary as described above. Task and replay resource results are different estimands and must retain their window labels. Startup resource peaks are a separate lifecycle condition; do not hide them inside a pre-warmed steady-state claim.

Use balanced product order and a stable power/thermal state. Record any interference. Resource arms run in isolation except intentional LD08/LD12 contention. Do not simultaneously benchmark competing products on the same machine.

## 8. Interaction and presentation evidence

Use platform presentation feedback or a calibrated external capture that identifies the intended visual change and input event on a common clock. A high-speed camera/capture with an input marker can bound end-to-end visible latency; record frame rate, scanout/refresh effects, detection rule, and uncertainty. Ordinary screen recording or screenshot polling has its own sampling latency and does not automatically identify physical presentation.

When presentation cannot be observed, report `input_to_submit`, `input_to_capture`, or another accurate name with completeness/observability flags. Do not use a faster internal proxy under the label `input_to_visible`.

Register event eligibility and input coalescing before execution. Publish injected, received, matched, coalesced and unmatched action counts. Valid continuous-pointer coalescing may use a declared latest-input rule, but discrete clicks/edits must not disappear from latency and correctness accounting. Unmatched required actions retain their registered timeout/failure outcome, not a missing fast sample. Verify final camera, selection, content and revision; matched-only latency distributions must be labeled and accompanied by the missing-action denominator.

For continuous eligible motion only, report presented-frame intervals, latency p50/p95/p99, long gaps, and missed refresh opportunities using the observed display period `P`. A registered diagnostic estimator is `max(0, floor(interval / P) - 1)` missed opportunities per adjacent presented frame, with a calibrated timing tolerance. The missed-refresh fraction is `sum(missed_opportunities) / (eligible_intervals + sum(missed_opportunities))`; retain its raw numerator/denominator. Report refresh-rate changes; do not apply this calculation to intentionally idle/on-demand frames or sum unrelated UI/window frames.

Define a hitch as a gap greater than 100 ms during the eligible continuous-motion window and publish hitches/minute plus the gap distribution. This is a proposed reporting convention, not a universal perception threshold. At least 1,000 eligible observations are required to publish an empirical p99, and uncertainty remains clustered by independent fixture. Use one declared quantile convention; default is linear interpolation at index `(n - 1) * p` on sorted values. Never average run-level p95 values and call that the pooled p95.

Compare solo versus background-work interaction as paired LD08 runs. Report the registered p95 slowdown ratio, absolute latency gates, background job progress and acceptance together. Smooth foreground frames bought by starvation of required background work do not pass.

## 9. Data records and completeness

Store newline-delimited event/request/resource records with a versioned schema. The following are logical records to implement, not existing files generated by this documentation:

| Record | Required fields |
| --- | --- |
| Campaign manifest | Protocol/analysis commit, chosen claim family, independent-unit definition, weights, sample-size rationale, schedule seed, product/model/collector identities, hardware and cache conditions |
| Fixture manifest | Source-family/variant/workload ID, immutable hashes, logical/native size, history/assets/fonts, start state, oracle revision, allowed adapters and budgets |
| Attempt record | Campaign/run/paired-block IDs, product profile, source family, repetition, execution mode (`agent_only`, `registered_operator_steps`, `assisted_rescue`), active human time/actions, start/stop/ready times, actual and capped time, execution status, acceptance evidence, reason, per-metric completeness |
| Model request | Request/parent/agent IDs, provider/model/settings, timestamps, raw usage, normalized mutually exclusive usage, cache details, price revision, billed/reconciled status |
| Tool call | Tool/server/schema/dialect, target document/revision, request/result status, wire bytes, projection hash, text/image metadata, actual next-model submission link, async-job linkage |
| Product event | Clock domain, process instance, correlated request/operation/revision, event name, monotonic timestamp, queue/cache/stage counters where available |
| Resource sample | Timestamp and acquisition duration, process registry revision, per-process counters, accounting kind, aggregate totals, CPU/I/O lifecycle deltas, host pressure, missing fields |
| Acceptance | Candidate hash/time, individual gates and reasons, build/behavior/reopen evidence, blinded-review records if applicable, severe violation flag |

Execution outcomes are defined in [COMPETITOR_BASELINES.md](COMPETITOR_BASELINES.md#6-outcome-classification). Completeness is independent for each metric: `COMPLETE`, `INCOMPLETE`, or `NOT_OBSERVABLE`. A correct task can PASS while its token collector is incomplete, but cannot support a complete token claim. `NOT_RUN` leaves result numbers null; measured zero must have evidence.

Illustrative **unexecuted** attempt record:

```json
{
  "schema_version": "omc-local-dev/1",
  "run_id": "example-not-run",
  "workload_id": "LD02",
  "source_family_id": "registration-required",
  "product_profile": "omc-native",
  "execution_status": "NOT_RUN",
  "fixture_sha256": null,
  "observed_wall_ms": null,
  "accepted_ready_ms": null,
  "analysis_capped_time_ms": null,
  "provider_input_tokens": null,
  "provider_output_tokens": null,
  "physical_footprint_peak_bytes": null,
  "cpu_seconds": null,
  "measurement_completeness": {
    "tokens": "INCOMPLETE",
    "time": "INCOMPLETE",
    "physical_footprint": "INCOMPLETE",
    "presentation": "INCOMPLETE"
  },
  "evidence": []
}
```

The registration must replace placeholders before execution. Persist raw ledger references and hashes beside aggregates; an aggregate-only report is not reproducible. Units are explicit: bytes/MiB (2^20 bytes), seconds/milliseconds, logical pixels/backing pixels, and provider tokens.

## 10. Collector qualification and execution recipe

Before scored runs, qualify the collector on controlled known work:

1. Reconcile normalized model usage with the raw provider object, including cached input, reasoning subsets, images, retries, cancellation and multiple agents. Test missing-field handling; unknown is not zero.
2. Exercise tool envelopes containing text, structured and image content and prove what reaches the next model request. Verify schema loading, history replay and truncation behavior.
3. Spawn a known short-lived child, allocate/release a known memory workload, and run CPU/I/O work. Validate process discovery and units against an independent OS tool. Compare instrumented and uninstrumented replay; record overhead and uncertainty.
4. Calibrate clock domains and visible-change detection. Establish whether each frame metric is submission, capture, platform presentation or external physical observation.
5. Inject incorrect content, unrelated deletion, lost component identity, source-handler loss and missing assets into evaluator fixtures. Confirm that the oracle rejects them. Establish the review/adjudication rule before seeing product results.
6. Exercise a timeout, product crash, missing usage, invalid fixture and late async job. Confirm status, cost retention, deadlines and metric eligibility match the analysis plan.

Then execute the following registered sequence for each paired block:

1. Verify hashes/versions, prerequisite access, tool inventory, fixture starting state and cache class; save the manifest.
2. Start all collectors, discover required processes, observe the baseline, and launch the task or fixed replay on the assigned product.
3. Save requests/events/resources continuously. Enforce time/token limits, allow only registered repairs, and retain every candidate/failure.
4. Persist the candidate, complete active developer checks, record readiness, stop the attempt, and collect required tail work. Keep resource replay windows distinct from offline grading.
5. Evaluate acceptance, normal reopen and required source behavior from immutable evidence. Reconcile usage and completeness. Never repair the recorded artifact during grading.
6. Close/clean up only the disposable task profile as registered; retain evidence. Run the other products in the counterbalanced order with equivalent starting state.
7. Produce raw tables and confidence analysis from the frozen script. Publish all registered outcomes and exclusions, including runs that prevent a claim.

Missing collectors, unavailable product access or unimplemented workload adapters are execution prerequisites to finish later. They do not make a source audit a benchmark result.

## 11. Delivery order for the benchmark implementation

| Priority | Implementation deliverable | First useful proof |
| --- | --- | --- |
| P0 | Common task manifest, capability probes, independent semantic oracle | LD02 and LD05 can distinguish valid output from cheap wrong output |
| P0 | Complete provider ledger and actual model-bound projection capture | Token totals reconcile without duplicate/missing categories |
| P0 | Dynamic process sampler and external request/visible timeline | Whole-product resources and user-visible latency have honest boundaries |
| P1 | OMC request/snapshot/scene/storage/cache spans from the source map | Can attribute a slow visible edit to reconstruction, layout, queuing or render work |
| P1 | Generated mixed-content/history/reuse fixtures and strongest supported competitor adapters | Matched useful work across products and scaling conditions |
| P1 | Disjoint pilot, analysis implementation and preregistration | Feasible budgets and a defensible confirmation sample size |
| P2 | Expanded resource/contention/offline/collaboration campaigns | Bounded claims beyond first-create/scoped-edit behavior |

The strongest early study pairs LD02's precise edit with LD05's repeated local source workflow. These expose the proposed advantage and its major risks: excessive context, full-document updates, visual/source drift, and repair costs. LD01 alone is insufficient evidence of sustained local-development usefulness.

## 12. Primary measurement references

Accessed 2026-11-17; freeze the applicable documentation/API version with the collector implementation.

- **M1:** [Apple: Analyzing the memory usage of your Metal app](https://developer.apple.com/documentation/xcode/analyzing-the-memory-usage-of-your-metal-app). Footprint, resident memory, allocations and Metal resource coverage are distinct.
- **M2:** [Apple: Recording performance data](https://developer.apple.com/documentation/os/recording-performance-data). Correlated signpost IDs and intervals support per-operation attribution; adding them is implementation work.
- **M3:** [Linux kernel: The /proc filesystem](https://docs.kernel.org/filesystems/proc.html). Process accounting, `smaps`/`smaps_rollup`, shared/proportional residency, CPU and I/O counters have specific semantics.
- **M4:** [Existing native qualification contract](../native-engine/QUALIFICATION.md). Preserve its release gates, machine/fixture identities and distinction between targets and measured results.
- **M5:** [Source implementation map](IMPLEMENTATION_MAP.md). Pinned evidence for actual OMC paths, existing probes and missing instrumentation.

Provider-specific accounting references and current product capability sources are in the analysis and competitor documents. This protocol defines proposed estimators and targets; those choices are not claims made by Apple, the Linux project or a competing product.
