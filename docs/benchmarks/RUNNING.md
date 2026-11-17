# Running local-development benchmark attempts

The runners under `tools/local-dev-bench/` collect monotonic attempt time,
usage records, and optional macOS process samples. They preserve evidence from
failed attempts. The included LD02 adapters replay a synthetic edit for
qualification. Qualifying the primary product study still requires the
registered fixtures, supported routes, independent acceptance checks, and
matched measurement boundaries defined by [the protocol](README.md).

## Attempt input and output

Use Python 3 and supply one JSON manifest for each attempt:

```json
{
  "attempt_id": "ld02-pilot-omc-001",
  "product": "omc-native",
  "workload": "LD02",
  "argv": ["node", "tools/local-dev-bench/replays/omc-ld02.mjs"],
  "timeout_seconds": 600,
  "sample_resources": true
}
```

Run commands from the repository root. Each attempt has a new private output
directory. Keep actual product data and model traces in local evidence,
separate from the tracked manifests and scripts.

```sh
python3 tools/local-dev-bench/run_attempt.py attempt.json /path/to/new-attempt
python3 tools/local-dev-bench/run_suite.py --jobs 2 --output /path/to/new-suite first.json second.json
```

The suite preserves manifest order as the queue order and retains each child
outcome. Attempts with resource sampling require `--jobs 1`. Parallel runs
measure the declared contention condition and can include throttling, queueing,
and shared host load. Isolated resource measurements require actively checking
that other products and unrelated work are absent or recording the interference.
Predeclare the order and cache state before scored trials.

For an accepted attempt, the task writes the immutable artifact or its evidence
to the path in `OMC_BENCH_CANDIDATE` and completes active checks before exit.
Register an independent `acceptance_argv` to grade that artifact. The runner
checks that the artifact is preserved during grading. Time spent in independent
grading is outside candidate readiness. A successful replay without a grader
is recorded as a diagnostic and has no accepted completion time.

Set `usage_path` to `"stdout"` for Codex JSONL output, or to the name of a
separate usage ledger under the attempt directory. Use the provider's metering
for claims about model usage. Codex turn summaries are useful for calibration.
For local request-level evidence, set `CODEX_ROLLOUT_TRACE_ROOT` to a private
directory and reduce the resulting trace using the binary that recorded it.
Point `usage_path` at the reduced JSON file under the attempt directory or
process it independently with `usage.summarize_usage`. Keep the full trace
private. Reconcile raw usage and check payload coverage before making a token
claim. Missing usage or resource observations stay unknown.

When resource sampling is enabled, pass extra product roots through
`resource_root_pids` when they pre-exist the adapter. A root restricts which
processes can be followed. Include independently started helpers explicitly,
and record what can be attributed to the Docker VM, guest stack, compositor,
and browser. macOS physical footprint reports the OS-charged bytes of sampled
processes. The sampler cannot observe every process that starts and exits
between samples. Optional `resource_tail_seconds` extends the observation
window beyond command exit when declared roots remain alive. It does not
change completion time. Shared and guest measurements retain their own
boundaries.

## LD02 engine diagnostics

The common synthetic fixture contains 10 pages with 100 logical card elements
per page. Target discovery and the same three property edits run against the
installed product interfaces. Keep engine diagnostic results separate from
model-assisted completion and from resource comparisons.

- Run the OMC adapter with the installed native service and background desktop.
  The adapter creates and removes a task-owned profile.
- Supply the previously authorized synthetic Paper file explicitly. New
  diagnostic pages are created for each replay.
- For Figma, generate the Plugin API call payloads and dispatch them through the
  official remote MCP against a synthetic test file. A separate scoped remote
  read verifies the result.
- Run Penpot against a task-owned loopback deployment and use an isolated
  headless browser. Include the local stack boundary when collecting resources.

```sh
node tools/local-dev-bench/replays/ld02-fixture.mjs
node tools/local-dev-bench/replays/omc-ld02.mjs
PAPER_BENCH_FILE_ID=synthetic-id PAPER_BENCH_FILE_NAME='Exact synthetic file title' \
  node tools/local-dev-bench/replays/paper-ld02.mjs
node tools/local-dev-bench/figma-ld02.mjs plan fresh-trial-id
node tools/local-dev-bench/figma-ld02.mjs verify fresh-trial-id edit.json readback.json
node tools/local-dev-bench/penpot-ld02.mjs http://localhost:19001
```

Use a new `PAPER_BENCH_RUN_ID` with `--seed-only` to prepare a baseline
for a later agent run. Use the same ID with `--verify-only` for its scoped
readback. For protected-scope evidence, retain `--snapshot-before` before
the attempt and `--snapshot-after` after the supported reopen. Use
`paper-ld02.mjs --compare BEFORE.json AFTER.json` to compare the target
identities and protected subtree hashes. Capture normal editor close/reopen
and the Undo/Redo check on a test copy separately.

The Figma plan contains the inspection, page creation, page seeding,
edit, and readback calls. Bind those payloads to the approved file and
session at dispatch. Code that starts from this fixture still needs a
complete acceptance adapter for a scored attempt.

For a model-assisted OMC diagnostic, use `omc-ld02.mjs --agent` as the
attempt command and set `usage_path` to `"agent.jsonl"`. The adapter scopes
the child model client to the task-owned MCP listener and records its turn
events. The client is subject to its MCP approval policy. Record blocked
tool calls and any spent usage. The agent diagnostic verifies the edited
snapshot and service rebind when edits succeed. Agent-session history needs
separate Undo/Redo evidence.

The approval and storage rules for profile isolation still apply to local test
runs. Reuse installed tools and existing container images.

## Qualification checks

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tools/local-dev-bench
node tools/local-dev-bench/figma-ld02.mjs --self-test
node tools/local-dev-bench/penpot-ld02.mjs --self-test
```

Start with a known synthetic command, acceptance failure, timeout, missing usage,
and an allocation with a known size. See [the collector
contract](MEASUREMENT.md#10-collector-qualification-and-execution-recipe) for
the remaining lifecycle, overhead, clock and failure checks.
