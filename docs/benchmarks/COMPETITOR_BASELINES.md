# Competitor Baselines for the Design-to-Code Benchmark

**Status:** benchmark specification; no comparative performance or token results have been collected by this document.

**Public-source review date:** 2026-11-17 (Asia/Seoul). Recheck capabilities before an execution campaign. The canonical workload definitions belong in [WORKLOADS.md](WORKLOADS.md); this document defines the eligible product configurations and how to interpret their results.

## 1. Comparison boundary

The primary comparison is oh-my-canvas, Paper, and Figma performing the same user-visible development tasks. Penpot is an optional control, reported separately unless the campaign explicitly includes it in every applicable workload.

Use each product's supported, efficient workflow. Do not force Figma to create one rectangle per tool call, make Paper repeatedly resend a complete document, or prevent a product from using reusable components, references, scripting, or selective reads that its public interface supports. Conversely, do not silently substitute a screenshot or an embedded application for editable design layers.

Keep three questions separate:

1. **Representation and tool efficiency:** how much model-visible context and generated content are required for a correct result?
2. **Interactive runtime performance:** how quickly does the application load, render, edit, save, and recover a document?
3. **Development workflow cost:** how much agent work, human work, adaptation, and source-code repair are required across repeated design/code changes?

A Rust renderer does not directly reduce the token count of an unchanged request and response. An HTML/CSS interface may reduce translation or repair work, but that is a hypothesis to test. Paper already documents HTML/CSS authoring and read/write MCP, and Penpot has a Rust/WASM renderer. These facts must not be presented as unique oh-my-canvas capabilities. [P1, N2]

## 2. Eligible execution profiles

| Profile | Required execution configuration | Eligible workflows | Boundaries to preserve |
| --- | --- | --- | --- |
| `omc-native` | Exact repository commit, release build, explicit renderer/backend, document format version, MCP schema and actual launch command | Implemented native editor and MCP paths that pass capability probes | A design document or compiled binary does not prove the intended renderer ran. Record process/backend evidence. An Electron compatibility path is a separate profile, never silently substituted. |
| `paper-desktop` | Installed Paper Desktop version, installed CLI version, first-party MCP integration, exact tool inventory, account entitlement, Snapshot version if used | HTML/CSS creation, supported granular edits/reads, token operations, selected code export, live UI capture | Desktop/local MCP does not by itself establish local-only document persistence, an offline guarantee, or source-code round-trip fidelity. |
| `figma-remote` | Remote MCP at `https://mcp.figma.com/mcp`, supported client, pinned first-party skills, edit access, suitable plan/seat, file/layer URLs | HTML import, native design-system edits, live UI capture, selective design context, Code Connect | Remote and desktop MCP expose different capabilities. Use the remote profile for the full comparison. Distinguish native design layers, plain imported layers, and code layers. |
| `figma-desktop-read` | Exact Figma Desktop build, local MCP endpoint, appropriate seat, recorded selection | Optional local read/selection latency control | Do not use this narrower profile as evidence that Figma cannot write through MCP. Do not merge its results with the remote profile. |
| `penpot-webgl` | Exact self-hosted release/image digest or SaaS timestamp; renderer flag explicitly enabled; browser/GPU configuration; MCP version | Optional programmable-design and renderer control | Record whether WebGL Beta is actually active. Browser-hosted WASM and native desktop execution are distinct environments. |
| `penpot-legacy` | Same configuration as the Penpot control, with legacy renderer explicitly selected | Optional renderer ablation | Keep renderer variants separate and use matching documents. |

For Figma, a Professional plan with a Full seat and edit access is a suitable baseline that avoids deliberately testing a restricted account. Record the actual entitlement rather than assuming access from the account name. The official introduction recommends the remote server and distinguishes its broader tool set from desktop MCP. [F1]

### 2.1 Paper configuration and current limits

Paper's official MCP supports reading and writing design files. The current setup uses its Desktop application and CLI; an older localhost HTTP endpoint is also documented. Freeze the transport actually used. Paper's statement that HTML/CSS improves agent accuracy, speed, and token efficiency is a vendor claim, not a benchmark result for this project. [P1]

Paper offers two materially different ways to bring existing UI into the canvas:

- **HTML paste/import:** the public documentation specifies inline styles, dropping class names and ignoring selector-applied styles. It also describes transformations such as converting inputs into frames with text children. It supports an existing-node clone element. [P2]
- **Rendered-site capture:** Paper Snapshot brings a browser-rendered page into editable layers. The first-party local-image guide requires the development server to permit the Paper origin where necessary. This route must be available in a local-development comparison rather than judging the entire product by raw HTML paste alone. [P3, P4]

Preserve the original class-based source fixture. If a route needs inlining, asset packaging, or capture, record that adapter and its time/output. Do not rewrite the canonical fixture to hide a route's limitations. A capture that looks correct does not demonstrate preservation of class names, selectors, component identities, or source locations.

The 2026-08 build log documents multiple Desktop tabs and agent work in background files. The 2026-10 log documents rich text. The paste documentation still contains an older rich-text limitation, so that paragraph must not be used to declare rich text unsupported. Background-file support is documented, while its reliability and scale remain test questions. [P3]

Paper's token documentation describes CSS-variable-style tokens and notes that tokens copied between files do not automatically follow changes in the originating file. It lists reusable theme classes and multiple theme modes as roadmap items. Probe the installed release instead of inferring implementation from a roadmap or from general HTML/CSS support. [P5]

Selected React CSS/Tailwind copying is documented. Arbitrary React project import, fully linked production components, complete source preservation, and a fully offline workflow are not established by that export feature. Record those capabilities as `unknown` until an applicable primary-source statement or runtime probe establishes their status. [P3, P6]

### 2.2 Figma routes must be separated

| Route | Suitable task | Required interpretation |
| --- | --- | --- |
| `html_to_figma` | Turn a static HTML document into editable design layers | Documented input is self-contained HTML with CSS/images included; external links are not fetched. Output is plain layers, without design-system component/variable connections. The documented limits are 50 MB and up to 20 chosen frames per call. [F2] |
| `use_figma` | Build or update native frames, components, variants, variables, and layout | Executes Plugin API code. Permit loops, batching, component reuse, and concise returned summaries. Use the first-party `figma-use` skill. [F3] |
| `generate_figma_design` | Bring a running local application and its captured states onto the canvas | Capture and source implementation remain separate artifacts. Capture does not preserve component-library identity; the current guide separately documents matching-variable binding when a library is supplied. [F4] |
| `get_metadata` / `get_design_context` | Locate and inspect the relevant portion of a design | Permit lightweight discovery followed by scoped detail. Do not require whole-file extraction. [F2] |
| Code Connect | Reuse existing production component APIs/snippets in implementation work | Configure the actual mappings and record their setup cost. Mapping snippets and properties does not prove automatic two-way source synchronization. [F5] |
| `send_code_to_figma` | Import a local project into Figma Make or a code layer | The official documentation explicitly distinguishes this from creating design layers. Keep this route in a separate interactive-code track; it cannot satisfy a task requiring independently editable native design objects. [F2] |

Figma's write-to-canvas documentation lists separate asset upload, account-available fonts, and manually published components for completing Code Connect mappings. [F3] For ready-session tasks, preload the same licensed common base assets/fonts in every product and record that setup. For ingestion workloads such as LD06, leave new task assets/fonts in the specified local fixture folder until the measured start; upload, registration, and conversion are part of that task. Do not count an avoidable failure of a declared preflight prerequisite as a renderer failure, or move required ingestion work out of the timed task.

At review time, the developer write guide and help-center FAQ disagree about the output-size limit for a tool call: 48,000 UTF-8 bytes versus 20 KB. Preserve both source observations, inspect the live schema, and use a disposable-file boundary probe if the limit matters. Do not select whichever number favors one product. [F3, F6]

Figma supports some offline editing of already loaded content and local snapshots, but its official guide excludes opening unloaded files/pages and multiplayer while offline. A local-copy export is therefore not evidence of a complete offline editing workflow. Report preloaded-session continuation and cold offline opening separately. [F7, F8]

### 2.3 Optional Penpot control

The official MCP provides code execution through the Plugin API and supports separate connections/session IDs for multiple browser tabs. Permit a script to search, modify, and summarize many shapes rather than forcing per-shape tool calls. Record the session ID used for each request and the browser's inactive-tab policy. [N1]

Penpot's documented renderer is a Rust crate compiled to WASM using Skia. The current help page describes optional WebGL Beta, off by default, available since 2.16. A campaign must record the actual release and active renderer; repository implementation and deployed default behavior are different evidence. [N2, N3]

Self-hosting supports controlled infrastructure and air-gapped deployment, but it is not equivalent to a single-process native local-file editor. Freeze the whole self-hosted stack and its resources when measuring it. [N4]

## 3. Capability probes before scored runs

Run probes in synthetic, disposable files. Save the request, response, tool schema, build information, and evidence of the resulting state. A documentation claim starts as `documented`; it becomes `observed_supported` only after a successful probe. Unsupported claims should identify their scope: input route, API, product edition, runtime profile, or entire product.

| Probe | Minimum operation and evidence | Why it matters |
| --- | --- | --- |
| `CAP-01` Identity and transport | Record server identity, full tools/resources inventory, transport, account entitlement, file target, and a read result | Prevents testing Figma desktop as if it were remote, or the wrong document/session |
| `CAP-02` Editable creation | Create a frame, text, and shape; edit each independently; inspect resulting structure | Separates editable objects from images or opaque code layers |
| `CAP-03` HTML/CSS routes | Import inline HTML and class/stylesheet HTML through each applicable route; retain class/source evidence | Distinguishes direct source support from visual capture or normalized import |
| `CAP-04` Local assets and fonts | Load a local fixture image and bundled font through the supported workflow; verify bytes and rendered glyphs | Exposes upload/CORS/font setup separately from agent reasoning |
| `CAP-05` Scoped reads | Ask for one known subtree and a small property set in a larger file | Establishes actual response size, pagination, and any forced broad retrieval |
| `CAP-06` Small mutation | Change one text value and one spacing value, then read back the target and unaffected neighbors | Establishes patch granularity and guards against destructive replacement |
| `CAP-07` Reuse semantics | Update a shared token and a component/reference with one local override | Distinguishes shared identity from independently cloned lookalikes |
| `CAP-08` Source recovery | Export selected code/assets, reopen it in the fixture repository, and inspect identifiers/references | Establishes which structure survives before round-trip scoring |
| `CAP-09` Multiple files | Target two files by stable identifiers while another tab is foreground; verify the exact receiving file | Detects focus/session dependence and wrong-document writes |
| `CAP-10` Save and reopen | Save, close, reopen, and verify content plus editability and stable references | Separates a transient visible result from a durable document |
| `CAP-11` Network loss | Continue a preloaded session, then separately attempt cold offline opening | Separates resilient continuation from a supported full offline workflow |
| `CAP-12` Limits and error behavior | Use a bounded payload near a relevant documented limit; capture validation/error and unchanged-state evidence | Establishes actual current constraints without treating a limit as a performance number |

Only run a limit probe when a canonical workload approaches that limit. Normal preflight should use small fixtures. Do not change global security controls, broadly expose a development server, or introduce undocumented APIs to make one profile pass.

## 4. Fair workflow selection

### Shared outcome, supported route

For an end-to-end task, provide the same source repository, content, assets, viewports, and requested result. Let each profile use its best documented route that can satisfy the outcome. Record all conversion and adaptation steps. For example, Paper may use Snapshot for a class-styled running application, while Figma may use live capture or self-contained HTML conversion.

For a representation microbenchmark, provide the same logical input at the defined tool boundary and label it as a microbenchmark. Do not combine its cheaper pre-adapted input with an end-to-end competitor result that includes source discovery and packaging.

### Components and production source

Maintain two fixtures when reuse is relevant:

- **No prepared design system:** setup begins from the same source assets and specifications. Creating mappings/components is timed and charged to the run.
- **Prepared design system:** equivalent tokens, component identities, variants, and source mappings are prepared for each supported product. Report that initial setup separately and reuse the same frozen setup across repetitions.

A product without the required native identity semantics is not forced to fake them using independent copies. Record capability coverage separately. A supported manual or agent-assisted repair path may be measured as a separately named workflow, including its full cost.

In repeated design/code cycles, retain hand-written source edits, event handlers, state, component boundaries, and tests between cycles. Do not reset the codebase to a clean generated export each time. Use AST/semantic checks where appropriate; exact text equality is only required for an explicitly protected region. Formatting changes alone are not functional regressions, but unnecessary source churn is still measured.

### Human actions and hidden product work

Use the same prescribed design changes and verify the same outcome for every product. Log manual clicks, publishing, authentication, setup, and cleanup separately from model/tool time. Keep required manual work in the end-to-end total instead of omitting it.

Record external model usage, tool payloads, and any product-side AI credit consumption separately. If a proprietary service performs unobservable model work, give that cost scope measurement status `NOT_OBSERVABLE`; do not report the visible external-model tokens as the product's complete AI cost. Figma documents a difference between initial project import and later Make prompting/changes. [F2]

## 5. Freeze manifest and execution prerequisites

Every campaign needs a manifest containing:

| Area | Required fields |
| --- | --- |
| Benchmark definition | Contract commit, workload ID/revision, fixture hashes, semantic expected-state manifest, viewport set, quality-gate revision |
| oh-my-canvas | Commit SHA, dirty-state check, build profile, compiler/target, enabled features, launch command, actual renderer/backend, document schema |
| Installed products | App/CLI/extension versions, installation artifact hash if available, OS package identity, enabled experimental flags |
| Hosted services | Start/end timestamps, visible build/version identifiers, endpoint, region where exposed, tool inventory/schema hash, plan/seat |
| Agent | Exact model identifier/version, harness version, system instructions, reasoning setting, decoding settings, context policy, tool loading policy |
| Skills and adapters | First-party skill repository commit/hash, adapter code hash, any generated inlining/capture/export scripts |
| Runtime | Machine model, CPU/GPU/RAM, OS, power mode, display scale, browser version, browser flags, available storage |
| Assets | Font files/version hashes, image hashes, source sizes, asset hosting/CORS policy, upload/preload state |
| Network and cache | Online/offline scenario, target endpoints affected, measured connection conditions, asset/browser/document cache state |
| State | New or reused conversation, document revision, prepared library mappings, foreground/background state, MCP session/document identifiers |

A hosted service generally cannot be pinned like a local executable. Capture its observed schema/build information and run paired product trials within a short, declared window. If exposed capabilities or behavior change, split the campaign into version blocks rather than pretending the original service is reproducible. Unknown server versions remain explicitly unknown.

Before timing, confirm authentication, edit permissions, the intended MCP tools, matching common base fonts/assets, a working local application, and a valid save/reopen path. Task-specific assets whose ingestion is part of a workload remain unregistered until its declared start. Freeze acceptable product-specific adapters after an unscored pilot. Do not improve only one product's adapter after seeing scored results; publish an adapter revision and rerun the affected comparison.

Disable unrelated background work consistently. If a browser must keep a tab active for a supported MCP workflow, document that requirement and measure the corresponding profile. A separate background-stress case can then test behavior outside that foreground setup.

## 6. Outcome classification

Execution outcome and measurement completeness are independent axes. Passing the task does not establish that every cost or latency field was observed. Store the execution outcome once per attempt and a completeness status for each reported metric and scope, following the [measurement contract](MEASUREMENT.md).

### 6.1 Execution outcome

| Outcome | Definition | Reporting rule |
| --- | --- | --- |
| `PASS` | Completed within the declared budget and passed every required quality gate | Report the accepted artifacts and each metric's independent completeness status |
| `QUALITY_FAIL` | Produced a result but missed a required correctness, editability, source-preservation, or visual gate | Retain all attempt costs and failed-gate evidence |
| `EXECUTION_FAIL` | A supported operation failed during valid execution, including wrong-file writes or lost state | Retain costs; identify the failed operation and recovery outcome |
| `TIMEOUT_BUDGET` | A valid run exhausted its predeclared time, token, or attempt budget | Record actual elapsed time and consumed cost; unobserved time to an accepted result is right-censored at the cutoff. Apply the registered deadline only to the separately defined primary analysis endpoint. |
| `UNSUPPORTED` | The frozen profile lacks a capability required by the task | Report coverage and the exact missing capability; do not assign zero cost or a fabricated slow time |
| `ACCESS_BLOCKED` | Account, plan, permission, or authentication prevents testing | Report setup/access blockage, not product capability failure |
| `ENVIRONMENT_BLOCKED` | Required fonts, assets, server configuration, hardware, or integration prerequisites are unavailable | Resolve before scoring, or report untested with evidence |
| `SERVICE_UNAVAILABLE` | Hosted outage or unavailable service prevents starting or completing work | Before valid start: record preflight availability. After valid start: retain the scored attempt, spent cost, and failure in its denominator. Apply the predeclared retry policy. |
| `INVALID_RUN` | A narrowly preregistered experiment-invalidating event, such as fixture contamination or a broken measurement harness | Preserve the record and spent cost, explain the outcome-independent exclusion, and rerun the complete matched block under the registered rule |
| `NOT_RUN` | No execution was attempted | Leave all result fields empty; do not infer a pass or failure |

Predeclare which tasks belong to the shared-capability score and which measure product coverage. Report both. Silently deleting unsupported tasks makes a narrow product look unusually efficient; treating unsupported behavior as a measured timeout distorts latency. Neither is acceptable.

Once a scored run starts under valid prerequisites, repair attempts remain part of its cost. A later successful retry does not erase the first run. Distinguish a failure to finish from a completed design that violates quality gates.

The [primary completion-time analysis](ANALYSIS_PLAN.md#verified-completion-time) assigns the registered task deadline to a valid attempt without an accepted result. This is an explicit analysis value, not an observed completion duration. Preserve actual elapsed time, cutoff reason, and accepted-result status alongside it; never fill the raw duration field with the deadline when the attempt stopped earlier. Successful-run-only latency is diagnostic and cannot replace the failure-inclusive primary endpoint.

### 6.2 Measurement completeness

| Status | Definition for the named metric/scope | Permitted reporting |
| --- | --- | --- |
| `COMPLETE` | All required observations for that metric and its declared scope were captured and reconciled | Publish that scoped measurement and use it in eligible comparisons, subject to the analysis and quality gates |
| `INCOMPLETE` | Some required observations are missing, truncated, unreconciled, or lost | Report observed values and defensible bounds as partial evidence; do not assert a complete total, overall metric advantage, or aggregate that treats missing values as zero |
| `NOT_OBSERVABLE` | The product/provider does not expose the required quantity in the tested workflow | Keep the quantity `null`, describe the boundary, and restrict claims to separately complete observable scopes |

For example, an attempt may be `PASS` with `external_agent_tokens: INCOMPLETE` and `wall_time: COMPLETE`. Its successful artifact and observed duration remain reportable, but it cannot support a complete token-total or token-saving claim. Another run may have `external_agent_tokens: COMPLETE` and `total_product_ai_tokens: NOT_OBSERVABLE`; only the explicitly scoped external-agent claim is eligible. Do not discard the task outcome or silently remove its attempt slot from the success denominator because metering is incomplete. The [analysis plan](ANALYSIS_PLAN.md) determines whether bounds or incomplete ledgers prevent a campaign-level claim.

### 6.3 Availability before and after a valid start

Register a preflight availability protocol separately if service availability is itself a research question: define observation windows, attempted starts, retry intervals, and its own denominator. An unavailable service discovered before a valid task start belongs to that record and does not become a zero-time task result.

After valid start, an outage, expired authorization, product crash, or ordinary tool failure remains part of the attempt's operational outcome, cost, and success denominator. Such events are not reclassified as preflight blockers or experiment-invalidating harness failures. Record when the event occurred and whether the retry policy recovered; repeated attempts cannot erase it. Deliberate network interruptions are part of their registered workload and must be analyzed as such.

## 7. Network and offline interpretation

Use distinct scenarios rather than a single offline flag:

1. **Online local development:** source and development server are local; product and model services remain reachable.
2. **Design-service interruption:** block only the declared product-service endpoints while preserving the model connection, then measure supported continuation/recovery.
3. **Fully offline deterministic replay:** execute prescribed local edits or replay already-generated operations without requiring a remote model. Measure editor/tool behavior, not remote model availability.
4. **Cold offline opening:** restart the application and open a previously saved fixture without network access. Keep this separate from a preloaded-session test.

A localhost MCP endpoint does not prove documents or assets stay local. A cached canvas does not prove cold offline opening. A self-hosted web application may work inside a disconnected network while still depending on a server. Record observed network requests and persistence boundaries without inferring undocumented guarantees.

Paper's complete offline behavior remains unestablished in this public-source review. Figma documents partial offline continuation and exclusions. Penpot documents air-gapped self-hosting. These are different capability statements and require different probes. [P1, F7, N4]

## 8. Workload design suggestions

These suggestions inform the canonical workload file; they are not a second source of workload IDs or acceptance thresholds.

| Candidate task | Controlled input | Required evidence |
| --- | --- | --- |
| Static screen creation | Exact content/assets and layout specification | Independently editable text/shapes, correct layout, saved document |
| Class-styled UI ingestion | Frozen HTML/CSS source with repeated classes | Visual result plus retained/lost selectors, class names, and source structure; adapter log |
| Running local application capture | Same local route and three scripted UI states | Correct captured states and accurate editable content; no claim that capture preserves application logic |
| Scoped inspection | Known target subtree in a larger document | Correct target data, response size, excluded irrelevant data |
| Small design patch | Text and spacing changes in one section | Target updated; neighbors, identifiers, and unrelated source behavior preserved |
| Shared token update | Repeated elements plus deliberate local overrides | Correct propagation and preserved exceptions |
| Existing component reuse | Equivalent prepared library/source mappings | Instance identity, variant/prop behavior, implementation reuse |
| Responsive edit | Same component at three widths and an intermediate width | Layout behavior at all widths, not just three matching screenshots |
| Repeated design/code cycles | Local repository with protected behavior and scheduled source edits | Build/test results, cumulative fidelity, source churn, identity drift, repair effort after every cycle |
| Background multi-file edit | Same set of open files and deterministic target schedule | Correct target file, completion while another file is foreground, resource/latency evidence |
| Save/reopen and interruption | Saved fixture, known edit sequence, declared interruption | Durability, recovery, and distinction between preloaded continuation and cold opening |
| Clean-checkout code handoff | Final design and an empty target checkout with a frozen toolchain | Reproducible build, asset completeness, behavior gates, and disclosed remaining service dependencies |

## 9. Public source register

All sources below are first-party product documentation, product changelogs, or repositories maintained by the product. All were accessed on **2026-11-17**. They establish documented capabilities, not benchmark measurements. Recheck links and preserve an excerpt or content hash with each execution campaign.

| ID | Source | Supported use and caveat |
| --- | --- | --- |
| P1 | [Paper MCP](https://paper.design/docs/mcp) | Read/write integration, Desktop/CLI setup, transport, and vendor token-efficiency claim |
| P2 | [Paper: Paste from HTML](https://paper.design/docs/paste/html) | Import normalization, inline-style restriction, clone element; rich-text paragraph conflicts with newer changelog |
| P3 | [Paper Build Log](https://paper.design/build-log) | Dated releases including background tabs, rich text, selected code copying, and MCP file operations |
| P4 | [Paper Snapshot with local images](https://paper.design/docs/support/snapshot-local-images) | First-party local-development capture prerequisites and origin-specific CORS configuration |
| P5 | [Paper Tokens](https://paper.design/docs/tokens) | Shared-value behavior, cross-file copy limitations, and documented roadmap items |
| P6 | [Paper Roadmap](https://paper.design/roadmap) | Planned/in-progress component and code integration; roadmap is not runtime proof |
| F1 | [Figma MCP introduction](https://developers.figma.com/docs/figma-mcp-server/) | Remote versus desktop profile and access boundaries |
| F2 | [Figma MCP tools and prompts](https://developers.figma.com/docs/figma-mcp-server/tools-and-prompts/) | Tool routes, HTML constraints, scoped reads, code-layer distinction, and import/Make credit distinction |
| F3 | [Figma: Write to canvas](https://developers.figma.com/docs/figma-mcp-server/write-to-canvas/) | Native design operations, skills, assets/fonts, publication requirements, beta limitations |
| F4 | [Figma: Code to canvas](https://developers.figma.com/docs/figma-mcp-server/code-to-canvas/) | Running-application capture, editable-layer output, library distinction, matching-variable behavior |
| F5 | [Figma Code Connect](https://help.figma.com/hc/en-us/articles/23920389749655-Code-Connect) | Production component/property mapping and MCP context; not proof of automatic source synchronization |
| F6 | [Figma MCP FAQs](https://help.figma.com/hc/en-us/articles/39252411778583-Figma-MCP-server-FAQs) | Entitlements and current limitations; output-size text conflicts with F3 |
| F7 | [Figma offline capabilities](https://help.figma.com/hc/en-us/articles/360040328553-What-can-I-do-offline-in-Figma) | Preloaded-session continuation, autosave, and offline exclusions |
| F8 | [Figma local file copies](https://help.figma.com/hc/en-us/articles/8403626871063-Save-a-local-copy-of-files) | Snapshot export/reimport behavior and loss of original identity/history links |
| N1 | [Penpot MCP](https://help.penpot.dev/mcp/) | Code execution, local/remote modes, multiple sessions, active-tab requirements |
| N2 | [Penpot WASM renderer source](https://github.com/penpot/penpot/blob/develop/render-wasm/README.md) | Rust/WASM/Skia implementation; development branch is not a deployed-version guarantee |
| N3 | [Penpot WebGL troubleshooting](https://help.penpot.dev/user-guide/first-steps/troubleshooting-webgl/) | Optional renderer Beta, default state, environment requirements |
| N4 | [Penpot self-hosting](https://penpot.app/self-host) | Deployment options including disconnected infrastructure; distinct from a native local-file application |
