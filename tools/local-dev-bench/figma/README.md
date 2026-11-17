# Figma LD01 and LD03 adapter

The offline plan emits JavaScript payloads for the official remote
`use_figma` tool. It uses a dedicated single-page synthetic Figma Design file.
LD01 creates native frames and text, a horizontal auto-layout filter row,
and rectangle image fills using the original PNG bytes. LD03 prepares native
local color and number variables, binds native paint colors and auto-layout
item spacing, and changes those two variables in place.

Fixture preparation and deterministic replay use fixed inputs. For an agent
attempt, keep the replay code and grader data outside the measured input.
LD01 starts with the neutral brief and generated assets. LD03 can start
with the prebound setup, with preparation cost recorded separately.

## Prepare and capture

```sh
python3 tools/local-dev-bench/workloads/synthetic.py fixture LD01 \
  --variant harbor-ops --assets-dir "$ASSET_DIR" > "$FIXTURE"
node tools/local-dev-bench/figma/adapter.mjs plan \
  "$FIXTURE" "$ORIGINAL_FILE_KEY" - "$ASSET_DIR" > "$PLAN"
```

For LD03, substitute the workload and variant and omit the asset directory.
The dash defers binding the verification copy. Generate the plan again with
the actual approved copy key after duplicating the candidate.

1. Start an official MCP file session with the original file key. For LD03
   run `setup` once on a new single-page file.
2. Run the `before` capture and the `candidate` replay. Save normally and
   capture the submitted candidate. Observe normal close/reopen and take the
   independent `reopened` capture.
3. Use Figma's normal Duplicate action to create a separate verification
   copy. Generate the plan with its file key. Run `probe` on that file,
   observe the result there, then rerun `after_probe_original` on the
   original. Retain the probe result and measured manual actions.
4. Save each capture as `{header, nodes, images}`, copying the unmodified
   MCP response envelopes with node/image batches in arrays. Save all five
   captures in one JSON object under the phase names from the plan. Add
   `probe_actions` with the MCP response envelope for `probe`.

```sh
node tools/local-dev-bench/figma/adapter.mjs normalize \
  "$FIXTURE" "$CAPTURES" > "$NORMALIZED"
python3 tools/local-dev-bench/workloads/synthetic.py grade LD01 \
  "$NORMALIZED" --variant harbor-ops
node --test tools/local-dev-bench/figma/adapter.test.mjs
```

Use the official tool session for every read and mutation. Capture each
phase during a stable document state. If the returned layer count exceeds
the planned node batches, treat the captured phase as incomplete. The
normalizer rejects mixed document/page captures, an incomplete image or node
capture, and a probe whose observed IDs do not match the verification copy.

## Qualification boundaries

The mocks exercise the generated JavaScript, both source families per
workload, and the canonical semantic grader. The connected official remote
session was checked without live document writes. Actual file creation,
bindings and propagation, render quality, remote payload limits, normal
editor save/reopen, and the duplicate-file workflow need live evidence. The
copy must be a genuine duplicate. The test mock uses a separate in-memory
fixture to exercise ID isolation.

LD01 requires installed Inter bytes, screenshot and clipping checks. The
adapter maps a stored PNG to its registered RGBA hash after proving exact
asset byte identity. If Figma re-encodes an image, this route requires an
independent decode and comparison before it can accept the image. LD03
captures the shared-value core. Native component extensions and hosted
server resource measurements lie outside these adapters.
