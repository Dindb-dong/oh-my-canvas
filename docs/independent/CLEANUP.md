# Bounded cleanup and code review

## Final local engineering approval

**Current status: runtime and local publication engineering review complete.** [Astra final review](ASTRA_FINAL_REVIEW.md) concludes **APPROVE**, architecture **WATCH**, with no open actionable blockers. The three accepted runtime defect groups were independently reproduced and their repairs verified. The screenshot privacy finding is closed by the reviewed exclusions/recapture. [Publication audit](PUBLICATION_AUDIT.md) records the bounded source/notice/history/privacy evidence; its earlier findings are closed by the final Astra candidate review.

The reviewed candidate contains **272 files  / 12,400,687 bytes**, digest `589595e5e7ec83880cd2eab0c293bc5da6b8eaf60fe0dc396bed8f907109eb14`. Every candidate payload hash, length and mode and all runtime-source comparisons were checked; private original Git history/remotes are absent from the new candidate and original private history remains preserved. Selected PNG privacy was directly reviewed. This digest identifies the reviewed candidate, not the final delivery export.

The final delivery export necessarily has a different digest because it includes the approved review and status documents. Parent will freshly verify its payload hashes/modes/readback and create an English initial commit in the new history with zero remotes. No circular final self-digest is embedded here. These are final local delivery steps, not unresolved engineering review findings. No remote upload occurred or is authorized by this review.

Current verification:339 editor tests/12 files, check/build,38 host tests,37 native UI,32 browser cases/830 assertions plus eight separate startup/cache assertions, actual 1,065-object library/16 previews/restart,four-peer TLS,four host lifecycle checks and359 package byte comparisons all pass within their recorded scopes. The current durable benchmark is median 515.6826245 ms / p95 603.409417 ms over ten samples. All 435 granular mappings remain group-backed with **zero individual 435-pass claims**. Engineering review is not legal clearance, proof of unexposed authorship, universal equivalence or upload approval.

Earlier pending/reopening entries below are historical checkpoints superseded by this final review closure.

Scope: current independently authored engine and task-owned host/build changes. This is the Ralph changed-file cleanup pass; restricted retired implementations are not cleanup templates.

## Plan and behavior lock

The fresh domain/browser/native suites lock the implemented behavior. Before changing lifecycle error handling, three fresh facade tests were added: normal teardown failure visibility, flush-failure precedence and failed-mount cleanup. The first fails on the original new facade because normal cleanup suppresses all errors; the other two pass.

Apply the smallest repairs in this order: preserve teardown failure evidence while continuing all releases; combine repeated imports from the same facade; rerun focused lifecycle checks and affected application/static checks. Avoid speculative abstraction or broad rewrites.

## Fallback inventory

- Facade resource cleanup: suppressing normal teardown failures is masking fallback behavior. Collect cleanup errors, finish releasing resources, and report an AggregateError on normal teardown; preserve the original error for failed flush/mount.
- Host queue catch after visible persistence error: grounded queue-recovery boundary. The failed durable operation is reported and oversized writes are rolled back; the queue remains available for later edits. Host/native regressions cover refusal and subsequent operations.
- Optional thumbnail/cursor failures: best-effort non-authoritative UI surfaces; authoritative document save/flush errors remain visible. These do not substitute a different document or rendering engine.
- Missing configured providers: explicit configured=false/empty records, with no claim of an available paid/cloud service. Covered by MCP tests.
- Legacy clipboard/plain textarea and viewport argument adapters: named interoperability boundaries using the same new services. Fresh tests cover normal and legacy/plain inputs; no inherited editor fallback is present.
- Font fallback/resource handling: native fallback diagnostics and explicit failed-resource states; failed export font embedding rejects. Browser font/export tests cover the boundary.

The general `Data` dictionaries retain opaque portable-file fields; they are an interoperability boundary rather than speculative domain abstractions. The UI uses the user-requested icon blue/sky/lavender palette. No dependency was added for cleanup.

## Completed cleanup and verification

The facade now continues releasing all owned resources and exposes normal teardown failures as AggregateError; failed flush/mount retains the original failure. The three fresh lifecycle cases cover normal teardown visibility, flush precedence and failed-mount cleanup. Repeated imports from the same facade were combined without a new dependency or parallel service implementation.

The imported-layout repair uses shared canonical geometry and existing inline-style reconciliation, rather than another layout path. Actual imported absolute drag/Undo/Redo, percentage resize and subtree movement pass, as do real-Replica concurrent x/y merge oracles. The shared native text-metric cache retains relative fragments, isolates mutable public results, keys font revision and geometry, invalidates on fonts/catalog/lifecycle changes, and is bounded to 4,096 entries / 8 MiB. Actual cache invalidation/eviction and repeated real-library rename measurements are recorded in the rendering review/profile.

Final source verification passed: 339 editor tests across 12 files, 38 host regressions, 37 native UI journeys, 32 browser cases / 830 assertions plus 8 performance/cache assertions, actual editable-library import/reopen, four host lifecycle checks and four-peer TLS. Durable SDK-to-fsync roundtrip median/p95: 515.683/603.409 ms. These scoped results lock the cleanup behavior without claiming every granular matrix entry separately tested. See [VERIFICATION.md](VERIFICATION.md) and its linked raw reports.

Final notice-bearing package readback passed 359 byte comparisons with zero mismatches; post-repack smoke passed at 2026-11-03T12:32:18.261Z. Fresh source comparison covered 447 files: zero code exact matches, zero sparse token-overlap leads, and six licensed font/text matches. Parent reports the 271-file snapshot preview passed check, 309 editor tests and build. This is scoped evidence, not authorship or legal clearance. Astra lock/font/SVG findings have focused/full source fixes and regression evidence; fresh final snapshot and Astra final approval remain pending. Final snapshot/private-data publication readback remains pending. No cleanup of shared resources, private history deletion or remote upload is implied.

## Final source findings and evidence scope

The latest current-source run passes **339 editor tests across 12 files**, `npm run check`, and **32 actual browser cases / 830 assertions**. The separate eight startup/cache assertions remain valid for unchanged production cache behavior; they are not a new final-source performance run. Fresh current-source host38/native37/library/four-peerTLS/host4 and rebuilt package smoke/359byte comparisons all pass. Only final snapshot/export readback and Astra approval remain pending.

Astra lock findings now have domain/UI ownership fixes and fresh regressions. Saved embedded fonts register centrally before initial loading/layout; an independently loaded actual FontFace oracle verifies initial/reopened sizing, with asset removal, Undo/Redo, projected add/remove, metric refresh, cancellation/failure/disposal coverage. The SVG fix shares one static-element policy between inert import and raw JSON/OMC scene export: SMIL URL-mutating nodes are rejected/removed while static unsupported graphics remain. Ten new formats regressions pass. In isolated actual browser frames, five trusted exported-link clicks after SMIL scheduling leave the sentinel at zero (`independent-render-results.json`, `svgSecurity`). This covers the reproduced attack and sampled lifecycle cases, not arbitrary active-markup equivalence or every font/platform.

No known runtime finding is left open in the recorded source checks. Final publication snapshot/source/private-data/dependency review and fresh Astra final approval remain release gates; no publication or legal-clearance claim follows from these checks.

## Final current-source integration closure

Fresh current-source verification passes: check, **339 editor tests / 12 files**, build, **38 host tests**, **37/37 native UI with zero errors**, actual 1,065-object library import/edit/restart with 170 variants/254 import bindings and 16 real previews/contained labels, four-peer TLS (12:31:21.712Z), and all four host lifecycle checks (12:32:06.994Z). Latest-source package smoke passed at 12:32:18.261Z and359 exact comparisons passed at 12:32:28.485Z with zero mismatches. ASAR SHA-256: `58d3167828105ebd7230ea0090aa3bf24331cdcf3e076b5cf90e369b03acbef6`.

The latest durable SDK-to-fsync benchmark at 12:33:19.265Z uses 10 measured samples after warmup: median **515.6826245ms**, nearest-rank p95 **603.409417ms**. Raw evidence is `docs/qa/editor-performance.json`; earlier benchmark values are superseded. Fresh source comparison covers 447 files with zero code exact matches, zero token-overlap leads and six licensed font/text matches. These remain scoped evidence, not authorship or legal clearance. Runtime closure is complete; only fresh final snapshot/export verification and Astra final approval remain pending. PUB gates remain pending parent closure; no publication/upload is claimed.
