# Penpot field-relay resource diagnostic

Run after preparing the task-owned pinned Penpot Compose project and confirming
the registered fixture and single-arm Mac schedule. No foreground window is
needed. The command uses the already running stack and creates a disposable
synthetic account and design file. Use a new private evidence path. It never
enrolls the Docker Desktop VM or other Compose projects.

```sh
docker_host=$(docker context inspect desktop-linux --format '{{.Endpoints.docker.Host}}')
case "$docker_host" in
  unix:///*) docker_socket=${docker_host#unix://} ;;
  *) printf '%s\n' 'Use the local Docker Desktop Unix socket' >&2; exit 1 ;;
esac

node tools/local-dev-bench/replays/penpot-resource-arm.mjs \
  --socket "$docker_socket" --project "$TASK_PENPOT_COMPOSE_PROJECT" \
  --origin "$TASK_PENPOT_LOOPBACK_ORIGIN" \
  --fixture "$CANONICAL_LD03_FIELD_RELAY_JSON" --output "$NEW_PRIVATE_EVIDENCE"
```

The project name must use the task-owned `omc-perf-penpot` prefix and the
origin must use the selected frontend's published loopback port. It requires
Linux cgroup v2. The registered guest roles for native token editing and
reopen are frontend, backend, PostgreSQL, Valkey and MCP. Exporter, admin
console and mail are visible separately as excluded project services if
started. This replay sends no export request. All required roles must exist
as single running containers. Record exact IDs, image content IDs, start
times and restart counts, and verify them again when sampling ends.

After the isolated editor opens, the adapter seeds the canonical LD03 scene,
waits for a save, and reopens and verifies the starting state. Sampling then
covers at least 60 seconds of the ready baseline, the scoped two-token edit
and propagation, save-backed close/reopen and independent native-value and
identity readbacks, and at least 30 seconds of observation. The same dedicated
Chrome process tree persists across the document reopen. Pending-work
verification is unavailable, so the tail cannot supply a primary resource
endpoint. Native headless timing and semantic readback do not establish
actual display presentation, raster equivalence or the active renderer.
Fixture preparation and cleanup are outside the measured windows.

- `host-browser/` uses the 50 ms macOS process-tree collector. It contains
  raw physical-footprint observations with the collector's completeness
  markers. The Chrome root comes from the task's Playwright browser handle.
- `guest-containers.jsonl` retains raw Linux Engine one-shot stats with Node
  monotonic request brackets and Engine read timestamps. The preferred
  period is 1,000 ms. The charged-memory aggregate uses only complete
  acquisition rounds within both the configured 250 ms guest read skew and
  250 ms host acquisition duration. Each guest phase uses safely enclosed
  command-bracket intervals. It excludes boundary-crossing acquisitions.
  Cumulative guest CPU deltas are observed between the first and last
  eligible measurements on the same container. Cache-adjusted bytes are
  recorded per service separately when Docker supplies the cgroup field.
  [Docker Engine container stats](https://docs.docker.com/reference/api/engine/version/v1.51/#tag/Container/operation/ContainerStats)
- `arm.json` records setup scope, verified replay execution and distinct host
  and guest summaries. Failed or incomplete phases retain raw observations.
  The two memory accounting systems stay separate. The machine's shared
  Docker virtualization manages these same guest services and is outside
  both scoped panels.

Provisioning and cleanup of the dedicated Compose project remain with the
caller. Preserve unrelated Docker services and volumes.

```sh
node --check tools/local-dev-bench/replays/penpot-resource-arm.mjs
node --test tools/local-dev-bench/replays/penpot-guest-resources.test.mjs
```
