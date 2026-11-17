# Native stage diagnostics

For the acknowledged-edit recovery qualification, run
`node tools/local-dev-bench/omc-native/native-probe.mjs --experiment N-H`.
The headless case uses a new profile and its own POSIX service group. It
checks durable Undo/Redo, then terminates the group immediately after a new
durable receipt, reopens the original document, retries the exact request
under the same task-local principal, and checks PNG export. No system,
power, pre-acknowledgment, network, or replica fault is injected in this case.

The probe uses the installed release service and optionally opens the synthetic document in an unfocused background desktop. It uses a temporary profile and removes it after stopping the task-owned processes. Use `OMC_BENCH_BIN_DIR` to select a different directory containing `omc-service` and `omc-desktop`. The report includes binary and fixture SHA-256 values.

```sh
node --test tools/local-dev-bench/omc-native/fixture.test.mjs
node tools/local-dev-bench/omc-native/native-probe.mjs --experiment N-A --nodes 1000 --depth 1 --desktop headless
node tools/local-dev-bench/omc-native/native-probe.mjs --experiment N-B --nodes 10000 --depth 1 --desktop attached --css-rules 1000
```

N-A supports 1,000, 10,000 and 100,000 total document nodes, depths 1 and 32, and headless or attached mode. Every case moves the same rectangle one unit per sample. N-B uses the same 100 authored nodes on the active page and adds unrelated pages of up to 1,000 authored nodes each. Use `--nodes 100` for its one-page baseline of 101 total nodes. Total counts include page roots and respect the 100,000-node import ceiling. Vary `--css-rules` independently from 0 through 1,000. Each generated rule uses a selector that matches none of the authored nodes. `--samples` defaults to 5. `--fixture-only` generates and checks the fixture without starting a product.

Each sample records a verified durable receipt, an unconditional full snapshot after the edit, a conditional snapshot using the previous revision, then a conditional read at the current revision. The latter returns null. The three reads run in that order and their cache state may differ. RPC timings are client-wall-clock boundaries and report body bytes, request-to-body time and client decode/parse time. Setup and import have separate boundaries. Use the outer benchmark collector for peak memory and CPU, including any measurement of the startup and validation overhead.

The current installed binary path does not expose revision-linked scene readiness, frame submission or frame presentation for this edit. N-B leaves styled and indexed counts, active interaction, unrelated metadata payloads and components unmeasured. These service-path diagnostics do not qualify the full native experiments.

## History aging

```sh
node tools/local-dev-bench/omc-native/native-probe.mjs --experiment N-C --samples 2
node tools/local-dev-bench/omc-native/native-probe.mjs --experiment N-C --history-edits 1000 --history-shape concentrated --samples 2
node tools/local-dev-bench/omc-native/native-probe.mjs --experiment N-C --history-edits 1000 --history-shape distributed --samples 2
```

N-C uses one headless 1,440 × 900 frame with 16 named rectangles under fresh isolated profiles. The default control performs zero prior edits. Opt in to an even prior-edit count up to 100,000. Concentrated aging applies every two-edit pair to the first rectangle. Distributed aging rotates whole pairs across the sixteen rectangles. Each pair moves one rectangle one unit on the x axis and restores its authored coordinate. Every prior edit gets an acknowledged durable response that advances the same epoch by exactly one sequence. Full page, metadata, and node state must equal the imported control before and after reopening.

Each condition gracefully shuts down and restarts its own service with the retained profile. The service descriptor, open/snapshot RPC, native bounded-query RPC, timed scalar edits and restorations have separate records. The query reads the complete small fixture, including all prior targets. Each measured scalar edit is restored before the next sample. Storage snapshots report logical SQLite/WAL file sizes at the recorded boundaries. The OS file cache is uncontrolled. The probe leaves tombstone retention and attributed replay CPU unmeasured.

## Background viewport rendering

```sh
node --test tools/local-dev-bench/omc-native/rendering.test.mjs
node tools/local-dev-bench/omc-native/native-probe.mjs --experiment N-D --samples 2
```

N-D defaults to the 1,000-node fixture in an isolated unfocused desktop. It uses the FigCraft MCP viewport automation and verifies each pan and zoom step, the return to the original camera, and the unchanged document snapshot. It records client round trips and desktop draw counters. The trace is enabled for this diagnostic. If emitted during the command window, the Metal CPU phases cover drawable acquisition, surface wrap, canvas paint, flush/submit and present command submission. These phase records have no per-command identifiers. An empty trace or unchanged draw count leaves actual submit/presentation latency unobserved.

Three separate timed PNG captures observe the offscreen window raster path at repeated static and zoomed camera states, including PNG encoding and MCP transport. This path bypasses retained gesture caches. The run leaves cache outcomes, visible/physical frame presentation, GPU completion, native OS gesture timing, drag, mixed-content/remote-edit pressure and scale variants unmeasured.

## Distinct-document contention

```sh
node --test tools/local-dev-bench/omc-native/contention.test.mjs
node tools/local-dev-bench/omc-native/native-probe.mjs --experiment N-E --ui-docs 1 --background-streams 0 --samples 2
node tools/local-dev-bench/omc-native/native-probe.mjs --experiment LD08 --ui-docs 5 --background-streams 4 --samples 2
```

N-E and LD08 use the same diagnostic. Run with 1, 5 or 10 independently imported UI-open documents and 0, 1 or 4 background-only streams on additional distinct documents. Each document has 1,000 nodes. The isolated desktop stays unfocused. The schedule offers foreground selection, pan/zoom and durable scalar edits at fixed offsets. The camera and edit steps have completion barriers, so dispatch can lag the offered time. Each background stream offers a full read at 0ms and an independent two-node batch at 10ms against its own document and session. Those operations can overlap. Every offer has a 5-second deadline and its status stays in the report.

Report fields include scheduled/actual offer, dispatch and completion times, the drain after the last offer, per-client outcomes and terminal checks of every distinct document. Runtime admission/workers are sampled before work, after work, at close and after a 250ms post-close window. Raw offer-to-completion times are client timings. Use the outer collector for process-group resources. Asset residency, server-internal per-request queue wait and physical presentation remain unmeasured.

## Durable recovery

`node tools/local-dev-bench/omc-native/native-probe.mjs --experiment N-H`
kills the isolated service group after the application receives a durable
receipt. Add `--drop-receipt` to kill after response headers reach the
transport and discard the body without delivering the receipt to the caller.
Both verify the recovered full snapshot and exact idempotent replay under the
same durable principal. The lost-receipt fault observes a specific
post-commit transport boundary. Pre-commit, power failure and replication need
separate checks.

Add `--crash-import` instead to wait for a deterministic 100,000-node native
import to report an active job phase and then kill its isolated service group.
The fresh service must reopen the unchanged original 1,000-node document and
contain no second document. This fault observes job state at the client; it
does not directly trace the exact storage commit boundary.
