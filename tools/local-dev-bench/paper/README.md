# Paper LD03 adapter

The adapter emits offline Paper MCP requests for fixture bindings and
token edits. It captures an independently read native board into the
shared workload format. Prepare the fixture board and editable layers
in the approved synthetic file before running the plan. The plan uses
`create_tokens`, `update_styles` with `var(--name)`, and `set_tokens`.
The Paper Desktop tool listing and guide advertise these operations
for design token values including colors and spacing.
[Paper MCP](https://paper.design/docs/mcp) and [Paper tokens](https://paper.design/docs/tokens)

```sh
python3 tools/local-dev-bench/workloads/synthetic.py fixture LD03 \
  --variant field-relay > "$FIXTURE"
node tools/local-dev-bench/paper/ld03.mjs plan "$FIXTURE" "$ORIGINAL_SCOPE" > "$PLAN"
node tools/local-dev-bench/paper/ld03.mjs capture "$FIXTURE" "$ORIGINAL_SCOPE" > "$BEFORE"
node --test tools/local-dev-bench/paper/ld03.test.mjs
```

Each scope file carries `fileId`, `fileName`, `pageId`, `boardId`,
a fresh token `prefix` beginning with `omc-ld03-`, and a `nodes` map
from each logical fixture key to its observed Paper node ID. Use distinct
approved disposable files for the original and its verification copy.
Use the same token prefix if the copy operation preserves the token names.
`plan` emits requests for the observer to run through the approved MCP
session. No requests are sent in plan mode. `capture` uses the existing
loopback HTTP connection by default and only sends read requests. It
checks the file name, file response headers, page ID and board ID
before traversing the board and reading the four scoped tokens.

1. Prepare the native board, apply `setup`, validate both tool
   responses and capture its `before` state.
2. Run the timed edit from the registered agent brief or the
   deterministic `candidate` request. Capture `candidate`, then
   independently observe a normal close and reopen and capture `reopened`.
3. Create a genuine separate verification copy. Retain its document
   identity and captured IDs. Use the copy scope with `plan` to emit
   its `probe` request and make only that token update. Capture `probe`,
   then read the original again for `after_probe_original`.
4. Assemble the `snapshot` fields under those five phase names. Add
   `probe_actions` as the logical `set_style` keys and observed new
   values from the successful probe response and subsequent readback.
   Retain raw captures, tool responses and save/reopen evidence separately.
   Run the neutral `synthetic.py grade LD03` command on the assembled JSON.

Paper Desktop 0.5.18 returned token records containing `name`, `type`,
and `value`. Paper identifies each token by its exact full CSS variable
name. The same name appears in the mutation selector and native
references. The grading identity uses the document ID and this key.
Opaque token IDs are unavailable in this route.

Paper's JSX and computed styles both retained the `var(...)`
references. The observer needs independent effective values to
qualify these references. The field-relay seeder has a 1× JPEG route.
It checks card fill colors from solid interior RGB medians and
calibrates second-line text position against both local gap overrides.
The raster tolerances are 5 levels per RGB channel and 1 px for gap.
This route requires `ffmpeg` and `ffprobe`, and is specific to the
fixed field-relay geometry. Preserve the exact raw capture and the
corresponding screenshot from the same stable board state.

```sh
node tools/local-dev-bench/paper/ld03.mjs screenshot \
  "$FIXTURE" "$SCOPE" "$BOARD_JPEG" > "$SCREENSHOT_METADATA"
python3 tools/local-dev-bench/paper/ld03-raster.py \
  "$FIXTURE" "$SCOPE" "$CAPTURE" "$BOARD_JPEG" > "$RASTER"
node tools/local-dev-bench/paper/ld03.mjs normalize \
  "$FIXTURE" "$SCOPE" "$CAPTURE" "$RASTER" > "$SNAPSHOT"
```

`capture` retains the raw observation on normalization failure.
When it reports missing rendered values, use that raw observation
as `$CAPTURE` in the raster workflow to produce `$SNAPSHOT`. A
reconnect still needs separate evidence of normal document reopen.

LD01 still needs a qualified asset readback. The observed Paper
`get_fill_image` tool returns resized or re-encoded JPEG and source URL
metadata. Recovering exact PNG bytes or the registered decoded
RGBA pixels requires a separate demonstrated read path. The font-family
lookup establishes availability, while actual glyph and clipping proof
requires rendering evidence.

## Seed a field-relay preflight

Generate the neutral `field-relay` fixture before setup. Use the approved
CAP file record as `$APPROVED_FILE`, containing its `fileId` and `name`.
Choose a new lowercase run ID of 8–32 characters. The dry run emits the
planned page, token prefix and native HTML fragments without connecting.

```sh
node tools/local-dev-bench/paper/ld03-seed.mjs plan \
  "$FIXTURE" "$APPROVED_FILE" "$RUN_ID" > "$SEED_PLAN"
node tools/local-dev-bench/paper/ld03-seed.mjs seed \
  "$FIXTURE" "$APPROVED_FILE" "$RUN_ID" > "$SEED_RESULT"
```

The seeder confirms the approved file name and control board before
writing, checks that the run page name and token prefixes are unused,
and creates a new page with one artboard. It inserts the title and
each section separately, reads the resulting Paper IDs and text, then
creates four file-level tokens under the run prefix and binds their
own card layers. Preflight work belongs outside the timed edit.
`$SEED_RESULT` contains `scope`, `setupTrace`, `before` and, on
incomplete setup, `blocker`. Extract the `scope` object for future
`ld03.mjs plan` and `capture` commands. Reuse that scope for the
post-edit capture. Keep the setup trace and both capture outputs in the
private evidence directory. A partial run retains its new page and
IDs for inspection. To retry after a partial run, choose a fresh run ID.

The seeding mocks exercise the generated inline fragments, structural
readback, native ID drift checks and scoped token setup. Run the screenshot and raster qualification against each phase whose
computed styles contain token references.
