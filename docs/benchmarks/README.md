# Local Development Benchmark Protocol

**Protocol:** `omc-local-dev/1`

**Design date:** 2026-11-17

**Status:** proposed measurement protocol; comparative results **NOT_RUN**

**Inspected OMC source:** [`ad7a58d147d1987589e147fb92b51155118b90a5`](https://github.com/Dindb-dong/oh-my-canvas/commit/ad7a58d147d1987589e147fb92b51155118b90a5)

## 1. Decision this benchmark supports

Determine when Oh My Canvas (OMC) is more useful than Paper or Figma for a developer who creates interfaces with an external AI agent, edits them visually, and continues development in a local repository. The candidate advantages are lower model usage, shorter time to an accepted result, lower local resource use, responsive foreground editing during background agent work, and reliable ownership of editable files.

These are hypotheses, not established product results. HTML/CSS authoring can change the amount of information an agent reads and writes. Rust and native rendering can change runtime behavior. Neither architectural choice establishes a comparative advantage without task-level evidence.

The intended eventual statement has a bounded form:

> On the preregistered local UI-development workload, with the declared model, product versions, machine, network, and acceptance criteria, OMC used X% fewer provider-accounted model tokens per accepted completion and Y% less peak aggregate physical footprint than [one named comparator], while satisfying the registered success and quality gates.

Do not replace this statement with an unqualified claim that OMC is always faster, uses fewer tokens, or consumes fewer resources than every alternative.

## 2. Reading and implementation order

This directory specifies a study and the remaining collector work. The [runner guide](RUNNING.md) documents attempt capture, scheduling, and deterministic diagnostics. The confirmatory comparison still requires qualified collectors and scored workloads.

| Document | Read it to answer |
| --- | --- |
| [Workloads and acceptance](WORKLOADS.md) | Which exact tasks, fixtures, budgets and quality checks represent local development? |
| [Measurement and collector contract](MEASUREMENT.md) | What counts as a token, visible edit, complete process boundary, resource peak or accepted completion? |
| [Statistical analysis and claim policy](ANALYSIS_PLAN.md) | How are failures, uncertainty, sample size and two-competitor claims handled? |
| [Competitor baselines](COMPETITOR_BASELINES.md) | Which current Paper/Figma workflows must be allowed, and how is capability/access established? |
| [Native implementation map](IMPLEMENTATION_MAP.md) | Which source paths support each hypothesis, and which bottlenecks and existing-harness gaps should be measured? |

A study must implement and freeze the complete set; the overview alone is not an executable experiment. The source map and competitor review are completed documentation. Fixture generation, cross-product adapters, new collectors, acceptance automation, pilot and confirmation are future implementation/execution work. No comparative measurements accompany this protocol.

The existing [native qualification guide](../native-engine/QUALIFICATION.md) remains authoritative for native release qualification W1-W7 and correctness obligations. This protocol adds **cross-product local-development comparisons**. It neither marks the older qualification complete nor weakens its gates. Its own result set starts at NOT_RUN. Existing benchmark scripts are diagnostic starting points, not comparative evidence.

## 3. Product arms and scope

| Arm | What runs | Role |
| --- | --- | --- |
| OMC-native | Release-built native desktop, native service, workers, declared MCP dialect and transport | Primary candidate |
| Paper-desktop | Current stable Paper desktop and its supported MCP integration | Primary comparator |
| Figma-desktop | Current stable Figma desktop with the supported official remote MCP write workflow (`figma-remote` integration profile) | Primary comparator |
| OMC-Electron | The existing Electron application from a pinned commit | Internal regression/control arm; never silently substituted for native |
| Figma-browser | Dedicated browser profile with the same design and official MCP workflow | Optional separately reported deployment arm |
| Penpot | Pinned hosted/self-hosted version and renderer mode | Optional open-source reference; not required for the Paper/Figma claim |

At the inspected revision, root `npm start` launches Electron. Native desktop/service/CLI code exists, but the native README retains completion gates. Record the actual launched executable, build profile, binary hash, renderer/backend, process membership, MCP dialect, and tool-schema digest. A test accidentally exercising Electron cannot substantiate a native claim.

Keep three experimental tracks separate:

1. **Product track:** the best documented, supported workflow of each product, with the same external model and accepted outcome. Permit native batching, scripts, component reuse, HTML ingestion, and normal tool discovery. Count all agent-visible work.
2. **Representation track:** controlled creation/edit/read recipes that compare declarative markup, patches, component references, or script execution. This diagnoses the interface and cannot by itself establish the full product claim.
3. **Engine track:** deterministic replay without an LLM. This isolates layout, rendering, storage, transport, and resource behavior. It cannot be described as a model-token benchmark.

Figma's official write tools and Paper's background multi-file work must be included in the baseline. Do not compare optimized OMC bulk operations against artificially one-property-per-call competitors. Do not require proprietary products to expose an internal timer they do not provide: use the same external observable endpoint for the primary comparison.

## 4. Decision scorecard

The following effect sizes are **proposed practical targets**, not observations or statistically guaranteed outcomes. They must be accepted and frozen before confirmatory collection. The analysis specification defines estimators, uncertainty, family weights, failure treatment, and simultaneous comparisons.

| Claim | Primary quantity | Proposed material improvement | Mandatory accompanying gate |
| --- | --- | --- | --- |
| Lower model usage | All-attempt provider-accounted token spend per accepted completion, with input/output components also reported | At least 25% lower against each claimed comparator | Equal acceptance contract; success non-inferiority; no missing token accounting |
| Faster agent-assisted completion | Workload-weighted capped verified completion time: accepted elapsed time on success, registered deadline otherwise | At least 20% lower | Actual elapsed time reported separately; failure cannot look like a fast completion |
| Lower local RAM demand | Fixed-weight mean of per-replay peaks of simultaneous aggregate physical footprint for the declared product process set | At least 25% lower | Equivalent complete replay, cache state, visible quality and residency; valid OS accounting |
| Lower local CPU work | Aggregate user + system CPU-seconds over the same task/window | At least 20% lower, secondary | Compare energy and sustained activity separately; do not use CPU percentage alone |
| Smooth interaction | Input-to-visible-change latency, missed-refresh fraction, hitch rate | Meet registered absolute interaction targets and avoid material regression | Actual presentation evidence or explicitly weaker measurement label |
| Foreground isolation | Change in foreground latency/resources during another document's work | Meet absolute foreground gates and registered slowdown margin | Real independent documents and active agent jobs, with no omitted pending work |
| Reliable local workflow | Accepted completion, source semantics, durable recovery, offline capability and human repair | Correctness gates pass; performance gains cannot offset data loss | Report unsupported workflows and unavailable observation separately |

An aggregate marketing claim combining tokens, speed, and memory requires **all named endpoints** to pass against **both named competitors** at the registered quality and success level. A token win with a memory regression is a token win, not overall dominance. Report trade-offs as a vector; no opaque weighted product score is allowed.

For the requested tokens + time + memory claim, preregister the expanded eight-statement family: success noninferiority and each of the three savings endpoints against each comparator. The specified conservative multiplicity correction uses 99.375% one-sided bounds. The observed OMC success target is at least 95%, with a paired success-difference lower bound above -5 percentage points and no severe correctness violation. The observed target alone does not prove population reliability. The analysis plan also defines a narrower four-statement token-only study; it cannot substitute for the expanded family after outcomes are known.

Local footprint measures user-device demand, not total cloud compute or total energy. A remote competitor may offload substantial work. State that boundary instead of describing local memory figures as end-to-end computational efficiency.

## 5. Workload families

| ID | Family | Main question |
| --- | --- | --- |
| LD01 | Create a dashboard | How much model work produces an accepted editable interface? |
| LD02 | Make a scoped edit in a large document | Does irrelevant content increase context and latency? |
| LD03 | Change a shared component/style | Is reuse preserved while all intended instances change? |
| LD04 | Adapt a responsive layout | Does the layout behave correctly at unseen widths? |
| LD05 | Repeat code-to-canvas-to-code changes | Do visual edits preserve useful source semantics? |
| LD06 | Work with local assets, fonts and content | What is the full developer effort including transfer/setup? |
| LD07 | Diagnose and repair defects | How much context and rework does inspection require? |
| LD08 | Concurrent documents and foreground editing | Do background agent tasks interfere with the user? |
| LD09 | Startup, import and reopen | When is the first authoritative edit possible? |
| LD10 | Interaction and idle resource use | What does the user see, and what does the idle app cost? |
| LD11 | Save, offline work and recovery | Do accepted edits survive a controlled failure? |
| LD12 | Compete with ordinary local development | How does the design tool affect builds and an active IDE workload? |
| LD13 | Four-person collaboration | Optional extension to the original product goal; network scope is explicit |

LD01-LD06 form the primary AI panel with equal family weights. LD07-LD13 test diagnostic, scaling, capacity and operational claims separately. Capability gaps remain visible in the denominator specified by the analysis plan; a convenient common subset must not silently replace the original workflow population.

Every task has a product-independent brief and acceptance contract. Equivalent output means equivalent editable behavior, not identical internal node counts or identical source syntax. Generated fixtures control visible geometry, content, assets, component relationships, layout rules, and expected changes. Native file encodings and internal overhead are measured outcomes.

## 6. Execution stages and stop conditions

### Stage A — Freeze scope and probe capability

Record product/version/plan/MCP modes; build and binary identities; model/version/settings; access constraints; hardware; display; network; asset/font hashes; task briefs; schemas; scoring tolerances; operation and timeout budgets. Probe every required workflow without tuning against the held-out test variants. Classify supported, partially supported, unsupported, and unobservable cases before comparative timing.

### Stage B — Build and calibrate collectors

Implement the model-call ledger, exact model-bound tool projection capture, process-set resource sampler, event timeline, deterministic input replay, quality oracle, and result validator. Verify event semantics and overhead using an independent clock or capture where possible. Collector absence yields INCOMPLETE, never zero usage or a PASS.

### Stage C — Pilot

Use separate pilot fixtures to expose broken tasks, collector bias, rate limits, evaluator disagreement, and variance. A starting pilot is two variants per primary family with two repetitions per product. Pilot data are excluded from confirmatory claims. Use the observed variance and desired interval precision/power to finalize the sampling plan; a small pilot does not guarantee sufficient power.

### Stage D — Preregister and run confirmation

Commit the complete protocol, task manifests and hashes, analysis implementation, sample-size rule, thresholds, ordered product schedule, and exclusions before viewing confirmatory outcomes. A feasibility/descriptive planning allocation is eight independently authored source fixtures per primary family and three repetitions per product: 48 independent fixtures, 144 attempts per product, 432 attempts for OMC/Paper/Figma. Copies, alternate colors and sizes of one source template do not become independent fixtures. This allocation becomes confirmatory only if the preregistered power/precision analysis supports it; success noninferiority can require substantially more independent fixtures.

Balance product order on the same hardware and task instance. Keep app/document/OS/model cache conditions distinct. Freeze app updates for a block; if SaaS changes are observed, version the study block and rerun affected comparisons instead of mixing them silently.

### Stage E — Publish bounded findings

Publish all planned variants, statuses, raw denominators, resource boundaries, failures, traces, acceptance evidence, confidence intervals, and exclusions. Provide a reproducible report recipe. Keep measurements distinct from targets and from source-inspection hypotheses. Include remaining bottlenecks even if the headline endpoint improves.

Stop a specific run on its registered time/resource/error limit; retain the partial accounting and failed outcome. Stop and repair a corrupted collector, broken fixture, or destructive test isolation before further collection. Such repairs create a new protocol/collector version and are not permission to discard unfavorable valid runs.

## 7. Immediate implementation priorities

1. Observe the complete edit path: request, queue, storage receipt, full/partial snapshot refresh, layout, render submission, and externally visible change.
2. Measure what the model actually receives, including schema loading, duplicate text/structured tool output, images, and retry history.
3. Separate targeted-node mutations from whole-snapshot reads, markup insertion, component projection, and export.
4. Sample all local processes and declared GPU accounting during real multi-document workloads, including the idle periods between edits.
5. Validate round-trip semantics and recovery before making a cost or latency claim.

The implementation map ties these priorities to actual source paths and existing tests. Any optimization suggested there requires its own implementation and verification; this documentation does not change runtime behavior.

## 8. Evidence and maintenance rules

- Source findings are pinned to the inspected commit; new product builds get a new source identity and capability probe.
- External product documentation is dated and linked in the baseline specification; observed capabilities and schema hashes take precedence over stale marketing copy.
- Numeric result fields remain null or absent with NOT_RUN/INCOMPLETE status until measured. Zero is a measured number, not a missing-data marker.
- Store private task notes outside tracked product documentation. Public reports must link only to publishable evidence with reproducible acquisition instructions.
- Never publish authentication headers, account cookies, private design content, or private source repositories in traces. Use the registered synthetic/local fixture repository for the public study.
- A successful unit test, a code inspection, a service-only timing, or an existing historical report is not a cross-product result.
