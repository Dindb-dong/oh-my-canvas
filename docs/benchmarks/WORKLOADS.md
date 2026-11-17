# Workloads and acceptance contracts

**Protocol:** `omc-local-dev/1`

**Status:** proposed fixtures and experiments; comparative execution **NOT_RUN**. The fixture generator, product adapters, quality evaluator, and cross-product runner described here still need implementation. Numerical budgets and tolerances are proposed defaults to calibrate on a disjoint pilot and freeze before confirmation.

Read the [overview](README.md), [measurement contract](MEASUREMENT.md), [analysis plan](ANALYSIS_PLAN.md), [competitor configuration](COMPETITOR_BASELINES.md), and [source map](IMPLEMENTATION_MAP.md) together. This file owns workload IDs and acceptance rules. N-A through N-H in the source map are diagnostic experiments, not competing workload IDs.

## 1. Population and experimental units

The primary population is developers using the same external agent to create an editable UI, make precise visual changes, and carry the result into a local source repository. It is not every graphic-design task, all enterprise Figma use, or all possible HTML/CSS/React applications.

LD01-LD06 are equally weighted primary strata. Start planning with eight independently authored source specifications per stratum and three attempts per product per specification. That is 48 independent source fixtures and 144 attempts per product for one primary condition. Use the pilot-based sample-size decision in the analysis plan before confirmation; these counts do not guarantee adequate statistical power. Alternate colors, seeds, widths, asset sets, and copies of one template remain dependent variants of that source fixture.

Keep primary, scaling, and coverage questions distinct:

| Suite | Purpose | Membership rule |
| --- | --- | --- |
| Primary developer workflow | Accepted task, complete agent expenditure, verified completion time | LD01-LD06, fixed family weights and a preregistered common-capability population |
| Capability coverage | Which parts of the intended workflow the installed product can perform | Every registered task and extension, including unsupported cases; publish the original population and exclusion reasons |
| Deterministic runtime replay | Local resources and interaction under equal prescribed work | LD08-LD12 and equivalent replays of primary tasks; independent of model decisions |
| Scaling/diagnosis | Identify why time, context, resources, or failure rate change | Registered size/history/resource sweeps; exploratory unless separately powered and registered |
| Collaboration extension | Four-person behavior and convergence | LD13; separate machines/network and claim scope |

Freeze capability membership using the CAP probes before comparative outcomes. A supported adapter or agent-assisted source merge may satisfy a workflow; its complete cost is part of that profile. A workflow that a product cannot perform remains visible as `UNSUPPORTED` coverage. Do not invent a completion time for it, call it a free result, or silently rename the reduced shared suite as the original population. If a primary family has no shared supported tasks, the proposed six-family headline cannot be made; register and name a narrower claim.

## 2. Fixture contract

Each source specification must contain the following before conversion to product files:

- Exact visible strings, logical objects, layout relationships, editable properties, reuse relationships, intended overrides, and protected unrelated content.
- Asset/font files and licenses, content hashes, intrinsic dimensions, glyph set, and expected color profile.
- Starting local repository and lockfile hashes when applicable, build/preview commands, protected behavior tests, and allowed generated regions.
- Viewports and device scale, initial selection/camera/page, requested edit sequence, expected terminal state, and save/reopen obligations.
- Critical semantic assertions, geometric tolerances, visual masks, optional subjective rubric, and the same oracle revision for all products.
- Logical task size plus observed native representation size. Do not force products into identical node encodings or count every imported wrapper as extra useful work.
- A provenance identifier linking dependent variants to their originating specification, random seed where applicable, and an immutable archive hash.

Keep three representations: the product-independent specification, each product's native starting file, and the local application/source repository. Native files are disposable test copies. Validate each starting state against the common specification before scoring. Adapter output is not automatically authoritative ground truth.

Use generated or redistributable fixtures for the public comparison. The existing native qualification guide includes a large real `.fig` fixture; use it only in a separately permitted import study with its original provenance. Its presence in a repository or a Git LFS pointer is not proof that the complete asset is available or publishable.

### Size and stress axes

The primary panel uses ordinary web UI sizes. The following sweeps are separate conditions, not extra independent samples:

| Axis | Proposed values | Hold fixed / purpose |
| --- | --- | --- |
| Logical authored objects | 100, 1,000, 10,000, 100,000 | Mixed-content composition; the largest sizes are capacity/scaling tests |
| Visible working set | 100 objects on one page | Add unrelated pages/objects to isolate global work from viewport work |
| Tree depth | 3, 10, 30 | Keep final visible content and object count comparable |
| Stylesheet complexity | 0, 10, 100, 500 rules; simple versus descendant selectors | Separate source-route capability from style cost |
| Reuse | 0%, 50%, 90% repeated instances | Report authored objects and expanded/projected objects separately |
| Prior edit history | Fresh, 1k, 10k, 100k operations | Same final visible state; concentrated hot-node and distributed history |
| Retained deleted entities | 0, 1k, 10k | Same live state; report real product history/tombstone observability |
| Asset residency | Shared hashes versus distinct hashes | Same displayed geometry; encoded bytes, decoded pixels, unique resources |
| UI-open documents | 1, 5, 10 | Distinct documents, not repeated tabs of one file |
| Background document work | 0, 1, 4 concurrent job streams | Distinct target documents; record transport sessions/leases/tabs separately |
| Saved library | 0, 15, 100 documents | Startup/catalog cost independent of open-document count |
| Display scale | 1x and 2x | Same logical viewport; report real backing-pixel dimensions |

For products with hidden operation logs, create equal *user-level edit histories* through supported interfaces and record the operations performed. Do not claim equal internal log lengths. OMC-only counters can explain the result but cannot fill missing competitor internals.

## 3. Shared quality rules

Acceptance is a conjunction of required checks, not an average in which a pretty screenshot offsets broken behavior.

1. **Content and editability:** every required string and object is present; text, shapes, and required component properties can be independently changed. A screenshot or opaque code layer does not satisfy editable-layer requirements.
2. **Layout:** required containment, order, alignment, spacing, wrapping, clipping, and responsive relationships hold. Proposed core tolerance is 2 logical pixels for specified geometric anchors and spacing, measured at the same logical viewport; doubled backing resolution does not double the logical tolerance. Fixture-specific typography and raster tolerances must be frozen after pilot calibration.
3. **Typography and visuals:** correct font, weight, required glyphs, no unintended overflow or missing assets. Expected line count and wrapping are explicit where they matter. A small antialiasing mask may be registered; missing glyphs, wrong text, missing effects, or layout shifts cannot be masked away. Pixel/SSIM-style differences are diagnostics, not the sole acceptance rule.
4. **Preservation:** unrelated objects, content, and required identities remain unchanged. Check semantic manifests rather than raw proprietary file-byte equality. A target edit that replaces the whole document and destroys reuse or history fails when those are protected.
5. **Reuse:** shared changes propagate to all required references while intentional local overrides remain. Equivalent native components/variables or supported reference mechanisms are allowed; independent copies that happen to look identical do not satisfy a shared-identity task.
6. **Local source:** when requested, a clean checkout builds and displays the correct result; specified interaction, state, accessibility, and source contracts survive. Exact source text is protected only where explicitly required. Otherwise, compare behavior/AST relationships and separately report unnecessary churn.
7. **Persistence:** the result is saved through the supported workflow and verified after a normal close/reopen, with required identities and editability intact. Process-crash and offline guarantees are tested separately in LD11.

Give the agent the acceptance requirements and ordinary feedback it would receive during development. Freeze hidden variants and anti-cheating checks. Any check used to guide repair is part of the active task budget and usage; independent blinded adjudication is benchmark administration. The fixture manifest must identify active developer checks versus independent duplicate grading. Required user-workflow operations such as source build/reopen cannot move outside the timed task for only one product. Persist the candidate and timestamp it before adjudication, and retain failed candidates. The measurement contract defines completion time.

For optional subjective design assessment, use two independent reviewers blinded to product, a fixed 0-2 rubric per declared criterion, and third-reviewer adjudication of disagreements. Such scores are diagnostic by default. To make them acceptance gates, register the exact per-criterion thresholds and aggregation rule in each fixture, equally for every product, before confirmation. A primary core task should mostly use objective checks. An unvalidated LLM aesthetic score cannot establish the main result.

## 4. Primary tasks and budgets

Default budgets apply to a complete attempt, including preparation that is task-specific, normal agent repairs, saves, active verification, and all model calls. Authentication and product installation are preflight; their setup cost is reported separately. The pilot may change budgets for all products in a class, followed by a new frozen registration.

| ID | Task | Wall-time cap | Provider-accounted token cap | Primary condition |
| --- | --- | ---: | ---: | --- |
| LD01 | Create an editable dashboard | 900 s | 120,000 | New file; no prepared design system |
| LD02 | Make a precise scoped edit | 600 s | 80,000 | Prepared 1,000-object file with 100-object working page |
| LD03 | Change shared style behavior | 900 s | 120,000 | Equivalent prepared token/reference system; native component identity is an extension |
| LD04 | Adapt a responsive layout | 900 s | 120,000 | Flex-style core; three required widths plus withheld intermediate width |
| LD05 | Complete three design/code cycles | 1,800 s | 240,000 | Supplied running local repository; source behavior retained |
| LD06 | Integrate local assets, font and content | 900 s | 120,000 | New task assets available only in the fixture folder at start |

Caps are ceilings, not expected consumption or performance goals. Enforce the token cap using cumulative provider usage and the provider's output controls. A final-call overshoot is retained in full and yields `TIMEOUT_BUDGET`, even if the output is correct; it is not forgiven retrospectively. Stop dispatching new work at a limit, cancel outstanding work where supported, reconcile usage from all in-flight/subagent requests, and retain all charges. An earlier candidate cannot rescue an attempt that exceeded its total token budget. There is no artificial one-operation-per-call rule. Batching and concise reads are allowed equally.

Normal tool/model repair is allowed within the cap. Register transient API retry/backoff policy before running; elapsed delay and billed requests remain counted. Distinguish scheduled fixture operations, required supported product-specific manual steps, and discretionary rescue. The primary developer-workflow profile permits predeclared required manual steps, with their actual elapsed/active-human time and action count included and reported; call such a result assisted, not autonomous. Compare the same logical instruction contract, not necessarily the same clicks. A separate autonomous cohort forbids those manual steps. Discretionary operator correction is a rescue outcome and cannot silently become a primary PASS.

### LD01 — New editable dashboard

**Brief:** create a dashboard from exact content, supplied assets, and a layout contract. Include navigation, header, four metric cards, a filter row, a data table, and a details panel. Use approximately 80-150 logical elements; different source fixtures change information structure and relationships, not merely colors. The first result must be saved and editable.

**Start:** empty product file, common base fonts installed, asset folder and brief available to the agent. Source discovery, tool discovery, code generation, chunking/import, screenshot checks, repairs, and save are in the measured attempt. No pre-generated product-specific answer.

**Acceptance:** required content and geometry; independent edit of two text values and one spacing property; correct images; no flattened screen; reopen with the same editable structure. A brief verification edit is performed on a copy and must not alter the accepted artifact.

**Record:** total input/output tokens, calls, repairs, command count after expansion, final native objects, model-bound bytes/images, first visible candidate, first accepted persisted candidate, and task resources. Contrast no-prepared versus prepared libraries only as separately labeled cohorts.

### LD02 — Scoped edit among distractors

**Brief:** locate a named section from a semantic description, change one text value, one gap, and one radius or color, and preserve all unrelated content. The prompt gives the semantic target but not an internal node ID; normal lookup cost belongs in the task.

**Start:** 1,000 logical objects across ten pages, including a 100-object working page and near-name distractors. Initial selection is cleared. The target and unaffected neighbor oracle are frozen.

**Acceptance:** exactly the intended change; no wrong-file, wrong-page, duplicate replacement, or unrelated style propagation; required stable identities retained; Undo/Redo restores/reapplies the edit on a test copy; final state survives normal reopen.

**Extensions:** 100/10k/100k objects with the same working page; fresh versus aged history; target ID already known as an explicitly cheaper diagnostic case. Fit resource/latency versus total objects and history separately. Do not substitute this known-ID microcase for the discovery-inclusive primary task.

### LD03 — Shared style changes and component extension

**Primary brief:** update a shared accent and spacing value across 40 references; preserve four local overrides and one unrelated family with a similar appearance. The shared core requires persistent value references (such as tokens/variables), not native component/variant objects. Record the exact supported property types and binding behavior during capability probes.

**Start:** equivalent supported token/reference semantics prepared in every eligible product. Publish setup actions and cost separately; a no-prepared version includes all library creation in its own larger registered budget.

**Primary acceptance:** all intended references update, exceptions remain, bindings remain shared after reopen, and another token change propagates without editing each object. If a product cannot represent even this shared-value contract, report coverage and narrow the registered suite. Independent lookalike copies do not pass.

**Native-component extension:** additionally change the structure/padding of a reusable card/button master and a variant/property mapping used by the local source example. Require stable native instance/master identity, correct overrides and repeat propagation. Probe eligibility separately; a shared-token core PASS cannot establish this stronger component-preservation claim.

**Record:** actual model/tool work, changed logical objects, command count, affected versus rebuilt objects where observable, propagation latency, and any source mapping repair. Component expansion in a renderer, shared values, native design components, and reusable production component identity are different properties.

### LD04 — Responsive adaptation

**Brief:** convert a supplied desktop layout to a responsive arrangement at 1440, 768, and 390 logical pixels. A withheld intermediate width, selected and hashed in advance, tests the stated behavior rather than three static screen copies.

**Core contract:** width-driven flex wrapping, gap, min/max width, content-driven height, and overflow, using rules that do not require media-query breakpoint switching. The required UI remains a connected editable layout with its native constraints; resizing the parent must cause the expected reflow without a manual per-width edit. Final browser code must satisfy the same relationships if the task requests code handoff.

**Acceptance:** correct order, no unintended horizontal overflow, readable content, required spacing, and genuine reflow at all widths. Duplicating three unrelated artboards does not satisfy a connected-responsive-layout requirement.

**Capability variants:** breakpoint-specific direction/visibility changes, Grid, complex selectors, pseudo-states, dynamic content, and application logic are separately probed and registered. Do not silently require the complete web platform of a constrained design-CSS dialect. Do not remove an unsupported advanced case from the coverage table.

### LD05 — Three code-to-canvas-to-code cycles

**Brief:** start with a small running local application containing a reusable card, local assets, an event handler, form state, a conditional list, and keyboard-accessible controls. Bring the relevant UI into editable design layers and apply three prescribed design changes, returning each change to the existing source repository.

| Cycle | Design change | Source change retained between cycles |
| --- | --- | --- |
| 1 | Card spacing, radius, and heading typography | Existing click handler and accessible labels |
| 2 | Responsive arrangement and a shared color | Added form validation/state behavior and a visible validation message |
| 3 | Local image/content substitution and one source-component variant appearance | Added conditional-list behavior with a visible extra item and the earlier source edits |

The source-side changes are supplied as fixed patches at the scheduled cycle boundaries for every product. At **every** cycle: apply the scheduled source patch, build/render the specified application state, refresh or re-import the relevant canvas through the product's supported route, verify that the new source-visible state reached editable layers, make the prescribed design edit, merge it back into the existing source, and validate. Importing once and making three downstream design merges does not satisfy three round trips. Never reset to a fresh generated export between cycles.

Permit the external agent to merge exported code/context into the repository; all discovery, refresh/capture, merging, repair, and active build/test time counts. In the primary contract, retained component reuse means the **source repository's** component boundaries and props. The canvas must remain independently editable, but native master/instance identity is a separately probed extension. This measures useful development workflow without assuming any product automatically understands arbitrary React.

**Acceptance after every cycle:** application build; exact interaction tests; protected function behavior and required source boundaries; correct UI at all registered widths; new visible source changes reflected on the canvas; no lost assets; independently editable canvas content; intended source-code reuse; saved artifact and repository commit/diff. Native canvas component identity is required only in the named extension. A final screenshot alone cannot pass.

**Record:** cumulative token/time cost, per-cycle accepted result, human interventions, AST/semantic preservation, affected files, diff churn, unintended deletions, instance-to-source identity drift, and clean-checkout reproducibility. Separate automatic preservation from successful agent repair. Report full three-cycle success, not only the easiest first cycle.

### LD06 — Local assets, fonts, and content

**Brief:** add six fixture images, a fixture font with a registered Latin/Korean glyph set, and a JSON content set to an existing editable design, then update two images and two content entries and produce the required local code handoff. Include one repeated image hash and distinct images of comparable displayed size.

**Start:** common base product prerequisites are installed, but new task assets are only in a local folder. Required upload, font registration, permitted origin configuration, inlining, capture, and transfer are counted. Each route must preserve asset quality and all expected glyphs. No broad security-control changes are part of a supported baseline.

**Acceptance:** correct image/content identity, aspect ratio and crop, glyph rendering, independent editability, no missing private-local URLs in a clean checkout, and reproducible code/assets. Confirm which asset bytes are embedded, referenced, or still dependent on a service.

**Extensions:** 20 repeated uses of one 2-megapixel image versus 20 distinct 2-megapixel images; larger decoded-pixel pressure. These are resource conditions, not extra independent source families.

## 5. Diagnostic and operational tasks

### LD07 — Defect diagnosis and repair

Inject two deterministic defects into an otherwise valid fixture: one incorrect wrapping/layout relation and one wrong shared style/asset. Provide the symptom and a screenshot, not the answer. Include a misleading nearby object. Require identification and a minimal correct repair without altering unrelated content. Record scoped-read versus whole-file payload, screenshot count, false diagnoses, repairs, accepted time, and total model usage. Default cap: 900 s and 120,000 tokens. Report separately from the primary six-family panel unless added before registration.

### LD08 — Background documents and foreground isolation

Keep a 1,000-object foreground document under deterministic pan/zoom/select/edit interaction. Run prescribed agent-tool replays in other genuinely distinct documents, first with one and then four concurrent job streams, each targeting a distinct document. Connections, transport sessions, native leases, authentication sessions and UI tabs are configuration metadata, not the unit of useful concurrency. Test 1/5/10 UI-open documents and separately documents targeted only by background jobs. Use a fixed useful workload per stream, including one large read and a batch write; do not compare one product with an idle background queue to another still doing work.

Freeze the input/operation sequence, operation count, offered arrival schedule, semantic wait barriers and deadlines before the run. Use open-loop scheduling for the registered contention load and explicit completion barriers where a later operation depends on an earlier result. Report both offered and completed work. No unregistered adaptive throttling may give a slow product fewer edits or jobs.

Measure solo and concurrent foreground p50/p95/p99, job completion and progress, pending jobs, rejection, correct target file, simultaneous resources, and reclamation after close. Proposed foreground gate at 60 Hz: input-to-visible p95 <= 50 ms and p99 <= 100 ms, plus p95 concurrent/solo <= 1.25. These are new comparison targets, not replacements for the native release qualification gates. Report actual presentation evidence and stricter existing qualification outcomes separately. A stalled job or wrong-file edit fails the scenario even when foreground animation is smooth.

### LD09 — Startup, import, and reopen

Separate process launch, first window, first content, fully correct assets/fonts, first accepted edit, and normal reopen. Cross 0/15/100 saved-library entries with a single opened document; use a small and a large document. Include a class-styled HTML route, an equivalent prepared native-file open, and explicit format-import cases; do not compare an OMC native-file open against a competitor conversion without labeling the task difference.

Record process-cold/OS-cache-observed and warm-open conditions separately. Default exploratory schedule: 30 launches in three blocks of ten per registered condition, balanced product order. Repeated launches of one fixture do not create 30 independent designs. First-install, shader warm-up, or first-login work is its own setup record.

### LD10 — Interaction, mixed content, and idle

Use equal visible scenes with text, images, gradients, clipping/masks, effects where commonly supported, and reusable objects. Retain a simple solid-rectangle scene as a favorable diagnostic control. Include stationary overlay redraw, first and warm pan, sustained pan beyond cached coverage, zoom, single/multiple selection, first/warm drag, text edit, and external agent changes during interaction.

Run a fixed 10-minute input schedule three times per condition, keeping per-event traces and clustering by source fixture. Freeze exact action counts, arrival times, semantic barriers and completion deadlines as in LD08. A delayed product must still finish the registered useful actions; unfinished actions are recorded failures, not silently skipped to end on time. Measure both responsive preview and time to exact current-revision content; a translated old raster is not the final correct image. Collect at least 1,000 eligible events before reporting an empirical p99; this still does not make those events independent study units.

Follow with ten minutes of no-input idle, then close documents and observe for 60 seconds and five minutes. Report CPU-seconds/minute, wakeups where available, resource baseline/peak/retention, polling traffic, persistent workers, and any deferred jobs. State whether focus, window visibility, power mode, and background throttling were the same.

### LD11 — Save, network interruption, and recovery

Use disposable profiles and fixture files. Perform a registered edit sequence, retain the acknowledged revision/hash, and verify normal reopen. Separately interrupt (a) before a save acknowledgement, (b) after an observable acknowledgement, and (c) during background work. Use supported process termination for crash recovery; label OS/power-loss durability untested unless a dedicated rig actually exercises it. A closed GUI while a service keeps saving is not a full-process crash.

For an internal durable receipt, verify every acknowledged required edit after reopening. For a proprietary save/status indication, record its documented semantics and observed recovery; do not claim it equals an fsync boundary. Detect silent rollback, corruption, missing assets, and broken identity. Default engineering stress: 30 interruptions per registered phase on disposable data, separate from statistical proof of a rare failure rate.

Test four separately named network conditions from the baseline document: online local development, design-service interruption with model access retained, fully offline deterministic replay, and cold offline opening. A remote model's inability to run offline is not a native renderer failure. Count reconnect/retry work and verify the final result after reconnection. Never describe cached-session continuation as proof of cold offline support.

### LD12 — Local development contention

Run a pinned local repository's build/test workload and a scripted IDE workload with its fixed extensions, project index, and language-server state. Use the same development-server request schedule and dependency cache for each product. Measure the development baseline without a design tool, with the tool idle, and during the same deterministic design edits.

Report build/test wall time and CPU-seconds, preview response latency, IDE edit-to-diagnostic latency where observable, design foreground latency, system memory pressure/compression/swap, and whole-machine energy if a valid meter exists. Keep the fixed companion workload outside the product process subtotal but include it in the complete local-workflow boundary. A reduction in design-tool memory matters most if it improves these user-visible outcomes; do not infer that improvement from memory alone.

Proposed exploratory schedule: ten balanced paired blocks per source project, with thermal/battery state recorded and a quiet stabilization criterion before each block. Generalization across projects requires independent projects, not repeated builds of one repository.

### LD13 — Optional four-person collaboration

Use four declared machines/clients with equal deterministic edit assignments, simultaneous and conflicting edits, disconnect/reconnect, and asset changes. Measure per-user visible latency, remote convergence, edit attribution, conflict resolution, lost/duplicated operations, and per-device plus declared server resources. Clock synchronization uncertainty must be recorded; local round-trip timings are safer than uncalibrated cross-machine subtraction.

This extends the original qualification goal. Passing single-machine multi-document LD08 does not establish four-person collaboration. Cloud/server resources and entitlements must be visible in the scope, even when their physical compute cannot be observed.

## 6. Controlled ablations

Use ablations to explain mechanisms after functional parity is established. They are proposed implementations, not currently available benchmark switches.

| Question | Change one factor | Hold fixed | Diagnostic outcomes |
| --- | --- | --- | --- |
| Does compact context save tokens? | Whole-tree versus scoped/projection response policy | Renderer, model, task, source semantics | Provider usage, model-bound bytes, repairs, acceptance |
| Does HTML reduce authoring work? | Markup versus structured mutation/script input | Renderer, final accepted state, allowed batching | Generated tokens, calls, expanded commands, import failures |
| Does renderer/runtime choice help? | Native versus a matched runtime path | Deterministic edits, output semantics, assets, display, durability | CPU, local footprint, visible latency, acceptance |
| Does incremental delivery matter? | Full snapshot versus a correct incremental update implementation | Same revision sequence and rendering quality | Bytes, projection/parse time, redraw, memory peak |
| Do caches help typical work? | Cache configuration or eligible interaction class | Output correctness and input sequence | Preview/exact latency, hit rate, invalidation, retained bytes |

Native-versus-Electron product builds differ in more than language. Unless the ablation truly holds the other factors fixed, describe the observed build difference rather than attributing it solely to Rust. A repaired or optimized future build must have its own immutable identity and fresh paired results.

## 7. Minimum evidence per attempt

Publish the frozen manifest, starting-state hash, exact task prompt, product/profile identity, attempt ID, execution status, separate measurement-completeness status, all model/request ledgers, elapsed timeline, resource samples, final artifact hash, and acceptance checks with reasons. Include source diffs/build evidence for code tasks and reopen/recovery evidence where required.

Keep full failed attempts and excluded infrastructure records. Only a preregistered invalid-run condition can remove an attempt from inference. Do not turn a product crash, large-response rejection, class-style loss, or source-code damage into a collector exclusion. See the analysis plan for failed-attempt expenditure, deadline assignment, coverage, and uncertainty.

No generated fixture, collector, capability probe, or comparative execution is claimed complete by this specification. The first runnable milestone is a small end-to-end LD02/LD05 pilot with complete ledgers and trustworthy acceptance, followed by the full disjoint pilot and preregistered confirmation.
