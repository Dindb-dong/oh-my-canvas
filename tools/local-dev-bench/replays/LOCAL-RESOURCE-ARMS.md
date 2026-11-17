# Local process windows for competitor replays

Use the same registered ready fixture, guarded deterministic work, and separate
acceptance for every replay. Before starting the clock, establish the active
fixture, renderer, profile and process boundary. Track one product arm per Mac
at a time, with counterbalanced arm order and recorded power and thermal state.
The default windows use a 60-second ready baseline, actual replay through its
verified completion, and at least 30 seconds of tail, with a registered maximum
tail. Keep baseline footprint absolute. The primary sampled footprint spans
replay and tail. Track idle and post-close as separate conditions.

## Observable boundaries

| Profile | Local resource boundary | Additional evidence and gaps |
| --- | --- | --- |
| Paper Desktop with local HTTP MCP | The verified loopback listener owner and its Paper renderer, GPU and helper descendants. Include a separately launched first-party bridge only if the route uses one. | The approved synthetic file identifies the replay target. An existing shared app instance yields whole-app diagnostics. For an isolated product arm, establish that unrelated files and work did not share the root. Hosted persistence work and other off-machine compute are unobservable locally. [Paper MCP](https://paper.design/docs/mcp) |
| Figma Design with official remote MCP | An attributable, isolated local client can be measured separately where one exists. The remote tool endpoint has no local product-server PID. | Opening the same file in Figma Desktop adds a distinct local editor workload. An editor-window observation requires a pinned task profile, actual renderer activity for the test file, and its own protocol. The desktop-read tool set and remote write route remain separate profiles. [Figma MCP introduction](https://developers.figma.com/docs/figma-mcp-server/) |
| Self-hosted Penpot with WebGL or legacy renderer | One task-owned, headless browser profile with the registered renderer plus renderer/GPU helpers and any independent host bridge used by the route. | Pin the editor tab, synthetic account, Compose project, image digests and renderer evidence. Guest frontend/backend/MCP, persistence, cache and exporter services require a separate Linux-accounted guest panel. A shared Docker Desktop VM contains other work and cannot be attributed to Penpot. [Penpot MCP](https://help.penpot.dev/mcp/) |

For Penpot, enumerate the exact running container IDs from the task-owned
Compose project and sample all required services through the Linux guest's
container statistics or cgroup interface. Record raw counters, inclusion rules,
guest timestamps and acquisition gaps. For cgroup v2, track container charged
memory, CPU and I/O separately, with cgroup identity and contiguous intervals.
If using Docker CLI memory, label it as the reported cache-adjusted value.
Docker CLI and Engine API memory have different definitions. Physical footprint
of macOS Chrome, Linux guest memory, and host Docker VM footprint overlap or use
different accounting. Report separate series and keep unrelated guest services
out of the app result. Product startup, browser profile preparation, immutable
fixture seeding and container pulls occur before the ready baseline. A Penpot
adapter that launches its own browser must open the phase collector after the
editor is ready and identify the dedicated Chrome process from that launch.
Watching the adapter PID from before startup would measure a different window.
[Docker container stats](https://docs.docker.com/reference/cli/docker/container/stats/)

## Run an external ready replay

`local-resource-arm.mjs` binds an explicit, already ready product root set to
the existing phase collector. It introduces no browser profile, login, process
discovery by application name, installation or remote routing. Determine fresh
PIDs and verify their profile/role before enrollment. Keep only producer tools
from the registered adapter in the replay command. Do not pass credentials or
account tokens on argv.

The Paper example uses the provisioned test canvas and already seeded LD02
fixture. Verify the listener owner and populate the pinned Paper environment
variables before running it. Setup and snapshot-based acceptance are separate
from this wrapper. Use a new private output directory outside version control.

```sh
lsof -nP -iTCP:29979 -sTCP:LISTEN
node tools/local-dev-bench/replays/local-resource-arm.mjs \
  --scope 'Paper Desktop shared-process diagnostic' \
  --root-pid "$PAPER_PID" --output "$NEW_PRIVATE_ARM" -- \
  node tools/local-dev-bench/replays/paper-ld02.mjs --edit-seeded
```

A successful deterministic replay exits zero only after required readback.
The wrapper then observes the registered tail. For a completed tail, supply
`--tail-check` with an executable that verifies whether registered finite
jobs are settled for this product and target. A missing or failed check leaves
tail incomplete. When a remote product does not expose the check, keep the raw
phase diagnostic. The wrapper neither grades equivalence nor upgrades the
sampler's metric completeness.

The output contains the enrolled root PIDs and process identities, the
replay argv digest, command duration and phase markers in `arm.json`. The
`product-resources` subdirectory contains raw samples and the collector's
phase/primary summary. A phase-complete result still has the collector's
measurement limitations. Independent process lifecycle evidence is required
before claiming complete scope. Keep failed or partial phase records and
continue remaining scheduled arms serially.
