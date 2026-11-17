# Local development benchmark pilot — 18 November 2026

This project-authored exploratory pilot publishes 78 indexed attempts across Oh My Canvas (OMC), Paper, Figma and Penpot. Collection took place on 17–18 November 2026, Korea Standard Time. The dataset retains retries, failures and OMC-only diagnostics. Its measurement source ends at `c0a63518b9f084b6ab18a52cb1a99698efbf3c75`.

OMC recorded shorter accepted completion times than Penpot in the measured LD02, prepared-start LD03 and two LD05 tasks. Observed reductions range from 21% to 55%. Provider token counts were close, with both small increases and decreases for OMC. OMC also recorded smaller sampled local memory peaks than Paper and Penpot in the selected LD02/LD03 attempts. CPU and memory accounting remained incomplete and used different process scopes.

These observations cover individual attempts on a shared host. The [registered protocol](../../README.md) requires more fixtures, repetitions, complete accounting and statistical qualification for broad comparative claims. This pilot changed collectors and execution routes during recovery and uses user-requested 60-second attempts. Confirmation and the original-duration workload matrix remain incomplete.

## Published data

- [All 78 indexed attempts in CSV](attempts.csv) retain conditions, statuses, actual wall times, accepted times, failure caps, provider usage completeness and resource boundaries.
- [Sanitized result records](attempts.json) include original-result SHA-256 identities, measured fields, available acceptance failures and per-attempt registration pins. Records are indexed by `attempt_id`.
- [Environment and model runtime](environment.json) preserve the initial host/app inventory and the prepared OMC LD03 runtime. Later per-attempt pins take precedence over the initial inventory.
- [LD02 prompt](ld02-prompt.txt) and [LD03 prompt](ld03-prompt.txt) identify the shared model tasks.

The public records exclude credentials, document/account identifiers, authenticated endpoints, private file paths and raw model/UI traces. Original-result hashes identify the retained source records. They do not reconstruct excluded bytes. The CSV's `selected_latest` field selects within a condition. Earlier model profiles and start conditions remain distinct rows.

## Model-assisted tasks

The local model was `qwen2.5:3b-instruct`, served by llama.cpp 0.7.0, build 11669 (`620d2225c`). The model blob SHA-256 was `5ee4f07cdb9beadbbb293e85803c569b01bd37ed059d2715faa7bb405f31caa6`, 1,929,903,008 bytes. The fast profile used two slots, a 65,536-token context and disabled idle-slot caching. Each current attempt had a 60-second outer limit and an 80,000 gross-token budget.

Successful guarded edits stop new main requests. All already admitted requests, including automatic title generation, must finish metering before the attempt completes. Native acceptance follows independently. Counts below include all admitted provider requests. Whole operator/coordination/UI agent tokens remain unobservable.

| Task | Product | Outcome | Accepted time (s) | Producer wall (s) | Gross provider tokens |
| --- | --- | --- | ---: | ---: | ---: |
| LD02 Conservation Atlas | OMC | PASS | 41.631 | 41.631 | 8,916 |
| LD02 Conservation Atlas | Paper | QUALITY_FAIL | — | 36.567 | 8,915 |
| LD02 Conservation Atlas | Figma | QUALITY_FAIL | — | 59.954 | 9,080 |
| LD02 Conservation Atlas | Penpot | PASS | 53.549 | 53.549 | 8,919 |
| LD03 Field Relay | OMC | PASS | 40.095 | 40.109 | 8,640 |
| LD03 Field Relay | Paper | QUALITY_FAIL | — | 29.177 | 8,575 |
| LD03 Field Relay | Figma | QUALITY_FAIL | — | 46.646 | 8,567 |
| LD03 Field Relay | Penpot | PASS | 50.800 | 51.233 | 8,578 |

All eight provider totals in this table are complete. The LD02 prompt SHA-256 is `39ccc59e77a0cb9f51489a22dac31345c739741b29db65ace60a37570a7ab236`. The LD03 prompt SHA-256 is `ba6ef5539243f1e0628726923a7f6a3a3c46e469de78e39611764691696e3558`. The published prompt bytes and per-attempt registration identify the exact content.

OMC seeds its LD02 document inside timing. The other LD02 products start prepared. LD03 OMC/Penpot use prepared-file descriptors, Paper uses the earlier verified clone and Figma uses the atomic-publication retry. Baseline checking, attachment and native lifecycle routes differ. Paper/Figma completed guarded edits but lacked all required geometry, reopen or independent duplicate/probe observations. Their QUALITY_FAIL rows retain a 60-second analysis cap. Their wall times describe ended failed attempts.

### Resource observations for the same model attempts

| Task | Product | Sampled peak footprint (MiB) | CPU observation (s) |
| --- | --- | ---: | ---: |
| LD02 | OMC | 2,784.4 | ≥14.972 partial |
| LD02 | Paper | 8,953.1 | ≥16.645 partial |
| LD02 | Figma | 5,705.6 | unavailable |
| LD02 | Penpot | 3,808.5 | 47.100 observed |
| LD03 | OMC | 2,813.1 | ≥16.186 partial |
| LD03 | Paper | 8,868.7 | unavailable |
| LD03 | Figma | 2,700.3 | ≥9.820 partial |
| LD03 | Penpot | 3,843.8 | ≥45.188 partial |

Every resource row is INCOMPLETE. The sampler adds macOS charged physical footprints without shared-page deduplication. Some resident desktop roots include unrelated open work, while other attempts observe only runner descendants. Newer deterministic Figma records include local MCP/client work and exclude hosted compute. Penpot Docker guest work, GPU/compositor activity, short-lived helpers and final process counters lack complete attribution. Thus sampled peaks describe the declared local process sets.

Some CPU counters regressed. Original totals remain null in those records. Supplemental lower bounds sum last-minus-first observations per process identity and field, excluding each anomalous identity/field entirely. Missing startup/final work remains omitted. Lower bounds and ordinary observed deltas remain separately labeled in CSV. The model process can dominate local footprint, so these peaks also reflect the model/client route.

## Deterministic adapter reference tasks

These adapters invoke zero generation-model calls. Complete operator/coordination/UI token usage remains unobservable. The table reports accepted time for PASS and actual producer wall time for ended failures. Every failed attempt retains its 60-second analysis cap in CSV.

| Task / family | OMC | Paper | Figma | Penpot |
| --- | --- | --- | --- | --- |
| LD01 Harbor Ops | PASS 0.982 s | QUALITY_FAIL 6.756 s | QUALITY_FAIL 15.358 s | PASS 29.498 s |
| LD01 Reading Room | PASS 0.965 s | QUALITY_FAIL 8.954 s | QUALITY_FAIL 13.340 s | PASS 27.177 s |
| LD03 Field Relay | PASS 8.811 s | unrun | unrun | PASS 26.396 s |
| LD03 Edition Grid | PASS 6.264 s | unrun | unrun | PASS 26.879 s |
| LD04 Street Market | PASS 0.947 s | QUALITY_FAIL 3.615 s | QUALITY_FAIL 6.740 s | QUALITY_FAIL 27.882 s |
| LD04 Lab Queue | PASS 0.836 s | QUALITY_FAIL 3.629 s | QUALITY_FAIL 6.764 s | unrun |
| LD05 Route Board | PASS 22.709 s | TIMEOUT 60.001 s | TIMEOUT 60.001 s | PASS 47.527 s |
| LD05 Supply Ledger | PASS 20.342 s | EXECUTION_FAIL 59.985 s | EXECUTION_FAIL 59.997 s | PASS 45.051 s |
| LD06 Metro Stories | QUALITY_FAIL 1.398 s | QUALITY_FAIL 5.813 s | EXECUTION_FAIL 20.771 s | QUALITY_FAIL 57.637 s |
| LD06 Garden Labels | QUALITY_FAIL 1.342 s | unrun | EXECUTION_FAIL 7.004 s | unrun |

LD01 PASS covers the common structural oracle. Exact font attribution and complete visual parity remain unqualified. LD04 competitors include actual geometry differences and missing lifecycle evidence. LD05 includes human/UI close-reopen handshakes and receipt publication within each 60-second window. Paper/Figma ended before all three required cycles were qualified. Deterministic timings depend on the implemented adapters and their workflow coverage.

LD06 OMC retained real assets, exact registered font bytes and saved/reopened observations. Full registered glyph certification and two clean-checkout source builds remained absent. Paper/Penpot also lacked required font/glyph/crop/handoff evidence. Figma Metro uploaded six initial and two replacement images, changed four text values and read back 26 native objects. Its official Education-plan MCP quota expired during final byte verification. Garden hit the same quota near the initial inspection. Those failures retain their execution status and actual quota cause.

## Diagnostics, retries and unfinished qualification

The CSV also retains 20 earlier OMC-only diagnostic cases, including two LD07 case-oracle passes, nine LD08 background-document/stream diagnostics, six LD09 service startup diagnostics and three LD11 recovery diagnostics. A fresh Penpot LD09 large/zero-distractor native-reopen case passed at 11.835 seconds. Its route differs from OMC startup and provides an unpaired observation.

Earlier LD03 default profiles timed out. The guarded-fast repair removed unrelated instructions and stopped extra main generation after an exact edit while retaining admitted title usage. Earlier guarded-fast OMC passed at 49.919 seconds, Paper failed at 29.177 seconds, Penpot timed out with incomplete title usage, and Figma produced an INVALID_RUN when an empty non-atomic candidate became visible. Later prepared-start/atomic-publication attempts remain separate records. Earlier LD06 execution errors and the later numeric screenshot-ID observer fix are also preserved.

LD10 was stopped by the user. Its interrupted foreground run recorded 913 operations, 679 verified and 234 failed, with no final long-run acceptance. Earlier hidden observations lacked actual presented-frame evidence. The D-REAL FIG import reached a nonfinite Kiwi float after the bounded-reader fix and failed on both tested routes. A subsequent provenance fix passed focused tests but was not rebuilt and rerun against D-REAL.

Full-duration W1–W7 qualification remains incomplete or deferred. W4/W5 have partial evidence and W7 has a subset. LD12 has companion-only observations. Missing family/comparator adapters include Paper/Figma LD03 Edition Grid, Penpot LD04 Lab Queue, Paper/Penpot LD06 Garden Labels and the cross-product LD07/LD08/LD11 matrix. LD02 has one canonical registered family. Figma live collection is quota-blocked. LD13 collaboration remains outside this measured panel.

## Reproduction and interpretation

Generate synthetic fixtures with `python3 tools/local-dev-bench/workloads/synthetic.py fixture LD03 --variant field-relay`. The [runner instructions](../../RUNNING.md) describe fresh manifests, 60-second admission, resource scopes and independent acceptance. The [adapter guides](../../../../tools/local-dev-bench/workloads/README.md) describe task schemas and product-specific setup. Use your own isolated synthetic files and credentials.

This publication contains sanitized measured result records, prompts and committed adapters. Authenticated setup state and operator-specific local model launchers remain private. An exact replay of the original operator sessions requires reconstructing that setup. Raw process samples and complete model/UI traces remain private. Supplemental CPU lower bounds are descriptive exports and cannot be recalculated from the published aggregate records alone.

The evidence supports bounded observations of accepted time, provider counts and local process samples. The proposed 25% token/RAM and 20% time/CPU material-improvement targets, success noninferiority and simultaneous confidence bounds in the protocol remain unqualified.

## Publication checks

The publication pass checked all 78 exported statuses, accepted/wall times, complete provider totals and sampled resource values against their result records, then checked local links, failure caps, prompt hashes and credential/private-path patterns.

`python3 -B -m unittest discover -s tools/local-dev-bench -p 'test_*.py'` passed 122 tests. The equivalent discovery in `tools/local-dev-bench/workloads` passed 26 tests. `node --test tools/local-dev-bench/*.test.mjs tools/local-dev-bench/*/*.test.mjs` passed 160 tests. `cargo test --manifest-path native/Cargo.toml --locked -p omc-import -p omc-mcp --lib --tests` passed 51 tests.

The desktop test run passed 45, failed two existing dock-layout assertions and ignored three hardware-dependent cases. The same two failures were present in the recorded baseline run. `cargo fmt --manifest-path native/Cargo.toml --all --check` failed on 25 files unchanged by this branch. These existing failures remain recorded. Runtime presentation, the full endurance protocol and cross-platform execution remain incomplete.
