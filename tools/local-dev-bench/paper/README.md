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

A fresh read of Paper Desktop 0.5.18 on the approved CAP canvas
returned no color or spacing tokens. It corroborated the response
envelopes, layer types, JSX code and computed styles used by the
capture route. Actual token records, token ID fields and preservation
of CSS references in JSX require a seeded production-tool probe.
The normalizer requires a stable native token ID in the token read,
a real reference in the raw JSX styles, and concrete effective values
from `get_computed_styles`. A plan or matching colors alone cannot
complete acceptance. Reconnects and token values cannot demonstrate
a normal document reopen. The adapter reports missing evidence and
retains the raw capture on normalization failure.

LD01 still needs a qualified asset readback. The observed Paper
`get_fill_image` tool returns resized or re-encoded JPEG and source URL
metadata. Recovering exact PNG bytes or the registered decoded
RGBA pixels requires a separate demonstrated read path. The font-family
lookup establishes availability, while actual glyph and clipping proof
requires rendering evidence.
