# Figma LD02 conservation-atlas

The plan targets the committed conservation-atlas fixture in an approved,
fresh Figma Design test file. It seeds ten pages of native Figma frames,
vertical Auto Layout stations, editable text and rectangles. The measured
agent should receive only the supplied public brief and the prepared file.
The deterministic `original.edit` and `copy.edit` requests support replay,
using the station's visible name and receipt code for discovery.

```sh
python3 tools/local-dev-bench/workloads/synthetic.py fixture LD02 \
  --variant conservation-atlas > "$FIXTURE"
node tools/local-dev-bench/figma/ld02-atlas.mjs plan \
  "$FIXTURE" "$ORIGINAL_FILE_KEY" "$COPY_FILE_KEY" > "$PLAN"
```

The original and verification copy use distinct approved file keys. The copy
must start at the fixture baseline. Create a normally duplicated editor
file while the original is still in the baseline state, or use the approved
deterministic seed on a separate fresh file and confirm its exact baseline.
Use `-` as the copy key to prepare the original alone, then generate the plan
again with the true copy key. The sandbox plan is private grading and
fixture-administration input.

1. Start the official Figma MCP session. Inspect the target before dispatch,
   then create the ten pages and seed each empty page in the original.
2. Observe that the working page is open with selection cleared and collect
   `before`. Keep the three actual writes from the measured attempt in
   `edit_trace`. A deterministic replay emits this trace directly. Agent
   attempts require complete write instrumentation, including extra writes
   across product operations.
3. Save normally, capture `candidate`, then close and reopen through the
   editor and capture `reopened` on the same file key. Retain editor action
   evidence and actual close/open timestamps.
4. Verify `copy_before` on the isolated copy with selection cleared, apply
   the same edits, retain `copy_edit_trace`, and capture `copy_edited`.
   Perform native Undo and Redo in the same editor history session, capturing
   `copy_undo` before starting Redo and `copy_redo` after Redo. Reread the
   original into `after_probe_original`.

Each phase is an object `{inventory, pages}` containing unaltered official
MCP response envelopes. `pages` is the 20 native node batches, independent
of their response order. The two write traces are arrays of MCP envelopes
returning `{document_id, page_id, writes}` with native IDs and actual
`field`, `from`, and `to` values. Preserve raw editor evidence alongside
`editor_lifecycle`:

```text
editor_lifecycle.reopen = { document_id, closed_at, reopened_at }
editor_lifecycle.copy_history = [{ document_id, action: "undo", at }, ...,
                                 { document_id, action: "redo", at }, ...]
```

Use true ISO timestamps and record all Undo and Redo operations in order.
The normalizer independently resolves native IDs, paths, parentage, and
page scope, and verifies consistency of the supplied editor records. An
observer must attest to the actual editor events. A remote read cannot
establish normal editor reopen or a native history operation.

```sh
node tools/local-dev-bench/figma/ld02-atlas.mjs normalize \
  "$FIXTURE" "$OBSERVATIONS" > "$NORMALIZED"
python3 tools/local-dev-bench/workloads/synthetic.py grade LD02 \
  "$NORMALIZED" --variant conservation-atlas
node --test tools/local-dev-bench/figma/ld02-atlas.test.mjs
```

The mocked runtime covers written geometry, 1,000 native-like IDs across ten
pages, scoped writes and false history evidence. The live probe only checked
read-side API availability. Figma remote MCP has no `triggerRedo` method.
The live atlas run, editor save/reopen, and the ability to undo and redo the
chosen write from an actual editor history session remain to be qualified.
