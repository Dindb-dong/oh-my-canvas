# Statistical analysis and claim policy

Status: proposed protocol. This document specifies future measurements; it does
not report a completed benchmark, an established saving, or a shipping-capability
claim. Every numeric acceptance threshold below is a proposed target that must
be frozen before confirmatory trials.

Read this with [the benchmark overview](README.md),
[the workload specification](WORKLOADS.md), and
[the measurement contract](MEASUREMENT.md). Those documents define fixtures,
implementation boundaries, and instrumentation; this one defines estimands,
accounting, uncertainty, and what the results permit us to say.

## 1. Questions and comparison tracks

The primary agent comparison asks whether the tested oh-my-canvas build uses
materially fewer external-agent tokens to deliver accepted results than each of
two separately evaluated competitors: **Figma** and **Paper**. It must also meet
the task-quality gate and the prespecified success-rate gate.

This is a pair of comparisons, not a ranking inferred from architecture.
Penpot can be included descriptively or as a separately registered comparison.
Adding it to the confirmatory claim family requires changing the registration
and multiplicity policy before collecting confirmatory outcomes.

Keep the following tracks separate:

| Track | What it can establish | What it cannot establish |
| --- | --- | --- |
| External-agent product comparison | Outcome, metered agent usage, and user-visible latency with each product's supported workflow | That Rust, HTML, or a particular renderer caused a difference |
| Deterministic product interaction replay | Local resource use and interaction latency for the registered task and product configuration | An LLM-token advantage or total cloud-plus-client compute consumption |
| Controlled oh-my-canvas ablation | The effect of one changed renderer, document representation, or context protocol under controlled conditions | A performance claim against an unmeasured competing product |
| Capability and fidelity assessment | Whether required operations and round trips work | A speed or cost advantage when they do not work |

A future implementation is ineligible for a measured comparison until the
registered build actually performs the workload. An unsupported feature is not
a zero-cost successful run. Keep capability exclusions visible in the coverage
table, even when they are outside the common-capability comparison.

## 2. Register and freeze the experiment

Create a dated, versioned registration before the confirmatory run. It must
identify:

- The immutable oh-my-canvas commit, product versions/build IDs where available,
  OS, hardware, display settings, and release/debug configuration.
- Model provider, exact model identifier or snapshot, reasoning/effort setting,
  sampling configuration, context limits, agent harness version, tool discovery
  policy, history compaction policy, and all prompts and skills.
- Official tool schemas and instructions as observed at setup, their hashes,
  applicable permissions/plan, and any adapter code. Record that a hosted
  product may change even when a desktop build does not.
- Fixture-family IDs, provenance, task categories, variants, sizes, repetition
  counts, fixed analysis weights, and acceptance checks.
- Which tasks belong to the common-capability suite and which are product
  coverage tests; settle this before observing comparative results.
- Per-task-class wall-time and model-usage budgets, retry policy, stop conditions,
  cache conditions, run order, concurrency, and allowed preparation.
- Primary endpoints, competitor comparisons, practical thresholds, success
  noninferiority margin, confidence procedure, sample-size rationale, exclusions,
  and all planned subgroup analyses.
- The frozen unit prices, billing rules, currency, access date, and any fees
  included in the monetary calculation. Do not silently apply today's rates to
  yesterday's run.

Use disjoint pilot and confirmatory fixtures if the pilot informs prompts,
tooling, budgets, or acceptance thresholds. A protocol change after confirmation
starts creates a new experiment version. Retain the old outcomes and explain the
change; do not quietly restart until the desired result appears.

## 3. Fair baseline configuration

Give every product the same external model and the same task requirements,
assets, fonts, target viewports, acceptance criteria, and class-specific budgets.
Use each product's strongest supported, documented workflow. Equal tasks do not
require identical low-level commands.

In particular:

- Figma's current official remote MCP can run Plugin API code through
  `use_figma`, including native editable content. It also has HTML import.
  Do not force it into a separate tool round trip for every property or node.
- Paper's official MCP reads and writes its HTML/CSS-based canvas. Its existing
  compact reads and targeted updates are part of the baseline, not optimizations
  reserved for oh-my-canvas.
- Permit native batching, loops, component reuse, variables/styles, subtree
  reads, official guides, and screenshot tools when available. Record the
  actual tool inventory rather than assuming historical capabilities.
- Allocate the same preparation/tuning budget to each product. Freeze all
  configurations before confirmation. Tools and skills may differ in length;
  their actual model-visible cost remains part of the result.
- Do not give oh-my-canvas a bespoke compression, caching, or scripting adapter
  while denying an equivalent supported workflow to competitors. If an adapter
  is part of the tested product, name it and include its setup and runtime costs.
- Use supplied common assets for the primary suite. Unmetered built-in image or
  text generation introduces another model and makes total-token comparisons
  incomplete. Such workflows need a separately named end-to-end product track.

Randomize or counterbalance product order within matched fixture blocks. Run
resource comparisons in isolation; do not let one application compete with a
different product or background benchmark for CPU, memory, GPU, or bandwidth.
The agent runs may be scheduled differently only if that does not change the
registered resource or provider-rate conditions.

## 4. Experimental unit and weighting

The independent sampling unit is an **independently authored source-fixture
family**:
an originating design/content/layout specification. Repeated attempts, resized
copies, alternate colors, repeated drag frames, and variants generated from that
same source are dependent observations within that family.

A workload-family label such as `LD02` (local edit) is a stratum, not evidence
that its many copied fixtures are independent. If six templates generate thousands of
variants, the experiment still has only six independent source families for
generalization beyond those templates.

Pair products on the same family, task, starting state, and repetition block.
Pairing does not imply that a model seed produces identical stochastic behavior
across different tool schemas. Save seeds where supported and record sampling
settings without assuming determinism.

Freeze the primary workload distribution. The initial primary panel is
`LD01`-`LD06`, with equal weight per workload family, equal weight per independent
source-fixture family within that workload,
equal weight per registered variant within the family, and equal weight per
repetition. A usage-weighted distribution is also valid when justified before
the run. Do not weight categories by whichever product happens to finish more
runs.

Let `j` index registered attempt slots after flattening this hierarchy. Let
`w_j >= 0` be their fixed weights, with `sum_j w_j = 1`. The same weights apply
to every product. The unweighted raw totals and every category's results must
also be published so a macro average cannot conceal poor coverage.

## 5. Acceptance and failure definitions

For product `a` and attempt `j`, define `Y_aj = 1` only when it meets the
registered time/token-budget rule and submits a persisted, immutable candidate
at `candidate.ready` before the task deadline that subsequently passes every
critical acceptance check. Independent offline grading may occur after that
deadline; any active checks, feedback, or repairs needed to produce the candidate
remain inside the attempt's budget. Otherwise `Y_aj = 0`. The agent saying
"done," a successful tool return, or a plausible screenshot is insufficient
evidence of acceptance.

The workload contract must specify applicable checks for:

- Exact required content and the requested structural/layout relationships.
- Real editability of required objects; a flattened screenshot does not satisfy
  a task that requires editable text, components, or shapes.
- Preservation of unrelated content, object identity where required, and
  expected undo/redo behavior.
- Required viewport behavior, font availability, text overflow, clipping, and
  image fidelity.
- Source export/build/render and source-to-canvas-to-source behavior when the
  task explicitly requires them.
- Persistence and reopening when those are part of the task.

Freeze fixture-specific visual tolerances and masks before the run. There is no
single universal pixel-difference threshold that fairly captures typography,
layout, and raster assets across engines. Automated metrics are evidence, not
permission to ignore missing content or semantic breakage. Use blinded human
review for subjective criteria, with a fixed rubric and adjudication rule; an
LLM judge alone must not decide the primary acceptance outcome.

Record separate failure reasons: unsupported operation, incorrect result,
timeout/budget exhaustion, application crash, tool/protocol failure, model/API
failure, or invalid experiment infrastructure. Partial-quality scores may be
reported diagnostically but cannot turn a critical failure into a pass.

Prespecify a zero-tolerance list for severe correctness violations, such as
unrelated data loss, silent corruption, or a false durability acknowledgement.
Any such violation vetoes an overall efficiency claim covering that workload,
even if the aggregate success rate is high. It remains useful to report the
measured resource and usage numbers, explicitly conditioned on the failed
correctness gate.

After an attempt starts, normal retries, repairs, crashes, and timeouts remain
in its cost and success denominator. A new attempt cannot replace a failure.
Only a narrowly preregistered experiment-invalidating event, such as a broken
measurement harness, may exclude a block. Preserve its record and spent cost,
explain the exclusion independently of outcome, and rerun the complete matched
block under the registered rule. An application crash is not a harness failure.

## 6. Token accounting

The authoritative usage source is the provider's per-request metering, reconciled
against billing where available. Character counts, JSON bytes, and tokenizing
the final generated HTML are diagnostics; they are not total task usage.

For each model request `q`, normalize the provider's actual fields into mutually
exclusive quantities when that provider exposes them:

```text
U_q = uncached input tokens
R_q = cache-read input tokens
W_q = cache-write input tokens, split by charged class/TTL if needed
O_q = all output tokens reported by the provider
I_q = U_q + R_q + W_q
T_q = I_q + O_q
```

Some providers report input totals that already include cached tokens; others
report separate categories. Some report reasoning tokens as a subset of output
tokens. Implement and document a provider-specific normalization rather than
adding all usage fields together. Never add reasoning or image subtotals again
when they already occur in `I_q` or `O_q`.

For attempt `j`, `T_aj = sum_q T_q` over **all** requests attributable to that
attempt. Count history again each time it is processed as input; this measures
actual processed tokens, not the unique text written during the session.

The ledger must cover:

- System/developer instructions, user prompts, tool schemas/descriptions, loaded
  skills, documentation, tool-discovery calls, and history summaries.
- Model-generated tool arguments, code, analysis/reasoning usage as reported,
  and final output.
- Every model-visible tool response, including errors, retries, metadata,
  screenshots, and source or node-tree reads.
- Repeated conversation history, compaction calls, and any subagent or helper
  model calls initiated as part of solving the task.
- Billed requests interrupted by timeouts or cancellation, when the provider
  reports them.

Maintain separate fields for tool-response bytes, screenshots and image sizes,
tool calls, and native operations. These diagnose causes but are not additional
token quantities. A tool result that is never submitted to a model contributes
wire bytes but no model-input tokens. A hundred operations inside one script
are not comparable to a hundred separate model/tool turns.

Record unknown or unavailable usage as `null`, not zero. Mark any attempt with
unreconciled usage and report a defensible bound if one exists. Do not publish a
complete cost/token claim from an unknown amount of missing usage. A product's
unreported internal model calls must be disclosed; the narrow claim remains
"metered external-agent tokens," not total AI computation.

### Cache conditions

App startup, document cache, shader/GPU cache, operating-system file cache, and
provider prompt cache are different conditions. Resetting a process or opening
a new chat does not establish a cold provider cache. Record the actual observed
cache-read/write counts and the policy used to isolate or warm prefixes.

Register cold-start and reuse-session cohorts separately. Include the initial
cache write and setup in a reuse session's total; do not discard the expensive
first task and report only warmed follow-ups. Report both processed tokens and
monetary cost, since a cached input token is still processed usage but may have
a different price. A stable schema or prefix can improve cost without reducing
the processed-token count.

## 7. Monetary accounting

For frozen per-token prices `p`, the metered model cost is:

```text
C_model,q = p_U,q * U_q + p_R,q * R_q
          + sum_c(p_W,q,c * W_q,c) + p_O,q * O_q
C_aj = sum_q(C_model,q + separately billed model/tool fees_q)
```

Use rates per token, or divide by one million when the saved price table uses
rates per million tokens. Apply the provider's context-tier, service-tier,
batch, cache-duration, and other billing rules correctly. Do not infer dollars
from total tokens multiplied by a single blended rate.

Report subscription/license cost, cloud hosting, local electricity, setup time,
and paid product-specific actions separately unless the registration explicitly
defines an amortization scenario. A free beta or prepaid subscription does not
make the underlying task consume zero tokens. Credits from different vendors
are not interchangeable units.

Independent offline scoring expense is a separate benchmark-administration
cost. Any scoring/inspection returned to the agent to guide further work is part
of the active task and counts toward its budget and spend.

## 8. Primary estimands

For product `a`, use all registered valid attempt slots:

```text
p_hat_a       = sum_j(w_j * Y_aj)             # accepted-completion rate
mean_tokens_a = sum_j(w_j * T_aj)             # all-attempt token expenditure
mean_cost_a   = sum_j(w_j * C_aj)             # all-attempt metered expenditure
A_tokens_a    = mean_tokens_a / p_hat_a
A_cost_a      = mean_cost_a / p_hat_a
```

`A_tokens` and `A_cost` are the workload-weighted amortized expenditure per
accepted result across registered attempts, including failures. They are not
the conditional mean among successful runs and are not a promise about retrying
one particular task until it succeeds. If `p_hat_a = 0`, the corresponding
quantity is infinite, not zero or omitted.

For each baseline `b` in `{Figma, Paper}`:

```text
Delta_p_b = p_hat_OMC - p_hat_b
R_tokens_b = A_tokens_OMC / A_tokens_b
R_cost_b   = A_cost_OMC   / A_cost_b
```

The token ratio is the primary efficiency endpoint. Always display it beside
both products' success rates, all-attempt mean usage, and unweighted raw totals.
The actual-cost ratio is a separate endpoint: a token advantage does not
automatically establish a dollar advantage.

If a baseline has no accepted results, report that failure and the coverage
limitation; do not turn an undefined or zero-looking ratio into an unlimited
efficiency claim. Report successful-run-only and both-products-successful
comparisons as diagnostic subsets, with their denominators. They cannot replace
the failure-inclusive primary analysis.

Failure inclusion does not make two different accepted subsets identical. A
product that declines unusually expensive tasks can still have a favorable
amortized ratio while meeting an aggregate success margin. Publish task-class
success and the paired outcome table (both pass / OMC only / baseline only /
both fail), enforce every registered capability and severe-correctness gate,
and scope the conclusion to the accepted-result estimand. Do not describe it as
the cost of fulfilling every request. That stronger estimand requires a
separately registered retry/fallback policy with its real expenditure; do not
invent a cost for unperformed repairs or silently omit difficult tasks.

### Verified completion time

Let `B_j` be the registered time budget for an attempt's task class. Define
`V_aj` as `candidate.ready - attempt.start` for the first explicitly submitted,
persisted candidate later accepted by the registered independent oracle, using
the measurement contract's monotonic clock and active-verification boundary.
Do not substitute the later offline-grading timestamp or retrospectively infer
an earlier ready time from an intermediate screenshot. For the primary capped
completion-time endpoint use:

```text
L_aj = V_aj  if the attempt succeeds by B_j
L_aj = B_j   otherwise
mean_L_a = sum_j(w_j * L_aj)
R_time_b = mean_L_OMC / mean_L_b
```

This is a restricted time-to-accepted-result measure. An early incorrect stop
does not become a fast completion. Also publish actual wall time consumed,
timeouts, and accepted-run latency distributions. Keep time budgets identical
within paired task classes; changing the budget changes the estimand.

### Resource endpoint used by the expanded claim family

For each registered deterministic replay, let `P_aj` be the peak over time of
the **simultaneously aggregated physical footprint** of product `a`'s declared
local process set. It is not the sum of each process's separately timed peak.
The measurement contract determines the valid platform counters and sampling.
Freeze a resource-panel fixture distribution and its weights before running it;
it need not be identical to the agent panel, but the report must name both.

```text
M_a = sum_j(w_resource,j * P_aj)
R_memory_b = M_OMC / M_b
```

Thus the registered aggregate memory claim concerns the workload-weighted mean
of per-replay peaks, not the single best run or an unspecified global maximum.
Publish per-family peaks and tail summaries alongside it. Every replay entering
this panel must execute the equivalent full work and pass correctness. An early
crash or an unsupported operation cannot enter as a low-memory success. Keep
its partial measurements and failure status; an incomplete required replay
blocks the corresponding memory claim instead of creating a survivor-only
resource subset. A corrected build requires a new registered comparison.

## 9. Confidence intervals and dependence

Use a paired, stratified cluster bootstrap for the registered estimands:

1. Within each task-category stratum, resample independent fixture families.
2. Carry every product, variant, size, and repeated attempt from the sampled
   family together, preserving its matched block.
3. Recompute the fixed workload-weighted estimands and ratios for each draw.
4. Use at least 10,000 bootstrap draws for reproducible numerical estimation,
   with a saved random seed and the registered interval method.

Do not bootstrap individual API calls, frames, drag events, or stochastic
reruns as independent families. Thousands of draws improve numerical precision
of the bootstrap, not the amount of independent evidence. If multiple families
share a template or dependency that can correlate their outcomes, cluster at
that higher level. Runs sharing a noisy execution block should be counterbalanced
and examined with an appropriate block sensitivity analysis.

Sparse binary failures, very few independent clusters, or bootstrap draws with
zero accepted results can make ratio intervals unstable or unbounded. Keep
those draws, report the problem, and withhold the inferential claim. If all
families pass, a naive empirical bootstrap can produce a misleading zero-width
success interval. Do not use it as proof of perfect reliability or sufficient
noninferiority precision.

Select a **success-inference profile** before confirmation. The following
distribution-free profile is a fully specified conservative option, not the
only permitted inferential route. It uses a weighted Hoeffding bound over
independent source-fixture families, rather than a potentially degenerate
bootstrap bound. Let `v_k` be each family's fixed analysis weight
after aggregating its internal attempts/variants, with `sum_k v_k = 1`. Let
`D_k` be the paired difference of the two family-average success rates, so
`D_k` is in `[-1, 1]`. At one-sided error probability `alpha_star`:

```text
LCB_success_difference = max(-1, Delta_p_hat
  - sqrt(2 * sum_k(v_k^2) * ln(1 / alpha_star)))

LCB_absolute_success = max(0, p_hat
  - sqrt(0.5 * sum_k(v_k^2) * ln(1 / alpha_star)))
```

These bounds require independent sampled source families; they make no
independence assumption about repeats within a family. They can be very wide,
and the example 48-family budget generally cannot establish a five-point
noninferiority margin with this conservative procedure.

A **model-based or exact paired profile** is also permitted and may be more
practical. For example, a prespecified hierarchical binary-outcome model can
represent shared fixture difficulty, product-by-fixture variation, and repeated
attempts, then estimate the same workload-weighted marginal success difference.
Before using that profile, commit the complete estimator and interval algorithm,
link/distribution and random-effect assumptions, regularization if any, treatment
of all-pass or all-fail cells, simulation code, coverage checks, and sensitivity
to misspecification. An exact paired procedure must likewise state how it
handles strata and dependent repeats. Naming a model without implementing and
calibrating its interval is insufficient. Do not use an unclustered binomial
analysis merely because it yields narrower bounds.

The registration chooses one profile and a sample size justified for it.
Pilot/descriptive work may use neither and report no formal noninferiority or
confirmed efficiency claim. Do not switch methods after seeing confirmatory
outcomes, select the narrowest interval, or treat a descriptive allocation as
confirmatory by renaming it. An inconclusive result is preferable to false
precision.

Use cluster-level pilot simulation to assess interval coverage and power under
the anticipated dependence and failure rates. A binomial interval that treats
all repeated attempts as independent is inappropriate when family effects are
present. Report counts of independent families and attempts separately.

## 10. Multiplicity and confirmatory claim gates

Choose one of the following claim families in the registration. The global
family-wise error budget is 5%, and the default correction is Bonferroni over
the listed one-sided statements. This controls the registered family when each
constituent bound has its stated coverage; clustering, sparse outcomes, and
coverage calibration from Section 9 still apply.

| Registered family | One-sided statements for each baseline | Total statements for Figma and Paper | Per-statement error | Required one-sided confidence |
| --- | --- | --- | --- | --- |
| Initial token-only | Success noninferiority; practical token saving | `2 * 2 = 4` | `0.05 / 4 = 0.0125` | 98.75% |
| Expanded tokens + time + memory | Success noninferiority; practical token saving; practical verified-time saving; practical physical-footprint saving | `2 * 4 = 8` | `0.05 / 8 = 0.00625` | 99.375% |

The expanded family adds `H0: R_time_b >= 0.80` versus
`H1: R_time_b < 0.80` and `H0: R_memory_b >= 0.75` versus
`H1: R_memory_b < 0.75` for **each** baseline. Its overall claim requires all
eight adjusted statements plus the absolute observed-success target and hard
correctness/coverage gates. The agent success bound is counted once per
baseline; the deterministic replay's complete correctness gate is mandatory
and is not silently converted into a statistical success claim.

If the expanded family was registered, any partial token-only claim must retain
the expanded adjusted bounds. Do not switch to the four-statement correction
after time or memory results disappoint. Conversely, measurements of time or
memory alongside a registered token-only study remain descriptive until a
separate confirmatory family is registered.

Let `LCB` and `UCB` below be those registered multiplicity-adjusted bounds.

| Proposed claim | Required evidence before making it |
| --- | --- |
| Meets the observed success target | `p_hat_OMC >= 0.95`; this is a sample threshold, not proof that population success is at least 95% |
| Success is noninferior to baseline `b` within five percentage points | `LCB(Delta_p_b) > -0.05`, in addition to the absolute observed target and critical quality gates |
| Uses at least 25% fewer metered external-agent tokens per accepted result than `b` | Success gates above pass and `UCB(R_tokens_b) <= 0.75` |
| Uses fewer tokens, without a 25% materiality claim | Success gates pass and `UCB(R_tokens_b) < 1.00`; state that the proposed 25% target was not established if its bound exceeds 0.75 |

The primary practical token hypotheses are `H0: R_tokens_b >= 0.75` versus
`H1: R_tokens_b < 0.75`. The success hypotheses are `H0: Delta_p_b <= -0.05`
versus `H1: Delta_p_b > -0.05`. Passing a test of no difference is not evidence
of equivalence or noninferiority. A point estimate meeting a threshold while
its interval crosses the threshold is not a confirmed claim.

Show unadjusted 95% intervals descriptively if useful, but label them and do not
substitute them for adjusted claim bounds. CPU or monetary-cost claims against
both competitors add two statements each: adding CPU to the expanded family
gives `m = 10` and 99.5% one-sided bounds; adding both CPU and cost gives
`m = 12` and approximately 99.5833% one-sided bounds. An inferred absolute OMC
success-rate claim on the same agent population adds one shared statement, not
one per competitor. Additional independent model/cache cohorts or competitors
require their additional statements to be counted. Fix the complete list and
use `alpha_star = 0.05 / m`, or register a valid hierarchical gatekeeping
procedure, before running the study. Do not apply a smaller correction to
post-hoc claims.

Proposed additional practical thresholds, **not measured findings**, are:

| Endpoint | Proposed ratio threshold | Scope and condition |
| --- | --- | --- |
| Verified capped completion time | `<= 0.80` | At least 20% lower; use Section 8's failure-aware endpoint and the same success/quality gates |
| Aggregate peak physical footprint | `<= 0.75` | At least 25% lower for a defined local process boundary and equivalent correct replay; the measurement contract must define aggregation |
| CPU-seconds | `<= 0.80` | Secondary: at least 20% lower for the same completed deterministic work and process boundary |
| Metered monetary cost | Register before testing | Do not derive a claimed saving from the token threshold alone |

To make an absolute reliability claim, separately register an absolute lower
confidence-bound target, such as `LCB(p_OMC) >= 0.90`. The 95% observed target by
itself does not establish that statement. It is acceptable for a small benchmark
to provide useful descriptive results without enough precision for this claim.

## 11. Pilot, sample size, and stopping

An executable starting pilot is two independently authored source-fixture
families per primary workload (`LD01`-`LD06`), with two attempts per product per
designated task. This is 12 independent fixtures and 24 attempts per product
before extra sizes or cache
conditions. It is for validating instrumentation, failure modes, variance, and
budgets, not a publication-ready proof of savings.

A possible initial feasibility/descriptive allocation is eight independently authored
source-fixture families per primary workload, with three attempts per product
per designated primary task: 48 independent fixtures, 144 attempts per product,
and 432 attempts for oh-my-canvas, Paper, and Figma before additional sizes or
cache conditions. **These counts are planning examples, not an approved
confirmatory sample size, a statistical guarantee, or a sufficient sample-size
rule.** They can become a confirmatory allocation only if the preregistered
power/precision analysis justifies that count for the chosen inferential profile
and claim family before its outcomes are observed. Repetitions improve estimates
within a family but cannot replace independently authored families.

Use the pilot to estimate paired family variance, success discordance,
within-family dependence, and plausible effect sizes. Simulate the registered
analysis and choose the fixed family count needed for the desired precision and
at least 80% power, preferably 90%, under explicitly stated assumptions. Assess
the probability of satisfying the complete registered joint claim gates, not
only the easiest endpoint in isolation. An expanded eight-statement claim can
require more data than a token-only claim. Include
scenarios less favorable than the noisy pilot estimate. Establishing a five-point
success noninferiority margin may require far more families than demonstrating
a large token difference, particularly when failure information is sparse.

If the required budget is unavailable, narrow the claim or report uncertainty;
do not increase the margin after seeing the result. Fix the confirmatory sample
size before starting, or preregister a valid sequential design with its stopping
and error-control rules. Repeatedly checking ordinary confidence intervals and
stopping on the first favorable one is prohibited.

## 12. Resource and architectural attribution limits

Report the local process boundary: application, renderer, GPU/helper processes,
MCP bridge, and every local service required for the workload. Exclude a shared
agent process only when it is separately measured and identically accounted for
in every condition. Follow the measurement contract for shared-memory
accounting: summing RSS can count the same physical pages more than once and is
not automatically an aggregate physical-footprint measurement.

Hosted Figma/Paper services are outside local process measurement. A result
about local memory or CPU cannot establish lower total computing resources
across a cloud-plus-client system. Report network and service latency separately
where observable; unknown server resources remain unknown.

For a claim that Rust caused a benefit, hold document semantics, assets,
commands, output protocol, and acceptance criteria fixed while changing only
the renderer. Deterministic command replay measures renderer/runtime effects.
For a claim that compact context reduced tokens, keep the renderer fixed and
compare the context protocols. For HTML versus scene-graph authoring, keep the
renderer and supported semantics fixed and compare input contracts. A product
comparison alone cannot identify any of these causal effects.

Same model-visible requests and responses produce the same token accounting
regardless of renderer language. A faster or more faithful renderer can change
the number of interactive repair cycles; measure that as a separate mediated
effect rather than attributing all observed token differences to Rust.

## 13. Required report and permitted wording

Publish the frozen registration, environment/build manifest, tool/schema hashes,
fixture manifests, all attempt records, acceptance outcomes and reasons,
normalized usage with completeness flags, and analysis code. Retain raw evidence
with appropriate handling of credentials or private source content. Reports
must not link to repository-local ignored notes as if readers can access them.

Include:

- Per-product success, raw counts, independent family counts, all-attempt spend,
  amortized spend per accepted result, and adjusted comparison bounds.
- Category/size/cache-condition results and every severe regression, alongside
  the fixed-weight aggregate. Register subgroup claims separately or label them
  exploratory.
- Failed, excluded, interrupted, and unknown-metering runs; actual expenditure
  from excluded experiment-infrastructure runs as a separate ledger.
- Model-token and monetary results separately; local resource and overall task
  latency results separately.
- Task coverage and unavailable capabilities, with explanations established
  before outcome-based selection.

Acceptable conclusion: "On the registered web-layout suite, using model X and
versions A/B, oh-my-canvas met the prespecified success gate and the adjusted
upper bound on its token-per-accepted-result ratio versus Paper was Z."

Unacceptable conclusions include "Rust saves 25% of tokens," "HTML is always
cheaper," or "oh-my-canvas is faster than Figma" based on only a favorable
subgroup, successful attempts, unimplemented capabilities, or an unrelated
microbenchmark. Do not compress token cost, editing quality, compatibility,
resource use, and collaboration into a universal dominance score.

## References for baseline and accounting behavior

Consulted 2026-11-17. Recheck and snapshot the relevant official documentation
when an experiment is registered; these pages and hosted tools can change.

- [Figma: Write to canvas](https://developers.figma.com/docs/figma-mcp-server/write-to-canvas/)
  documents native editing through Plugin API code.
- [Figma: Tools and prompts](https://developers.figma.com/docs/figma-mcp-server/tools-and-prompts/)
  documents HTML import, targeted metadata/context reads, and other current
  tool capabilities.
- [Paper: MCP](https://paper.design/docs/mcp) documents its official agent
  connection and read/write workflow. Its general token-efficiency statement is
  a vendor assertion, not a substitute for this experiment.
- [Claude: Token counting](https://platform.claude.com/docs/en/build-with-claude/token-counting)
  distinguishes supported preflight counting from actual request usage and
  includes tools and images in the accounting discussion.
- [Claude: Prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)
  documents cached prefixes and separate cache-read/write accounting. Every
  other provider needs its own verified normalization and pricing adapter.
