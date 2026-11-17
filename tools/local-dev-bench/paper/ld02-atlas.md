# Offline LD02 atlas adapter

`ld02-atlas.mjs` emits the planned ten page-creation requests and four
HTML fragments per page. The plan contains the private starting layer
content. Keep it outside the measured agent workspace. The trackable
unit is 100 editable nodes per page. New page roots and their native
IDs must be observed through `get_basic_info` before inserting the
four zone fragments through `write_html`.

```sh
python3 tools/local-dev-bench/workloads/synthetic.py fixture LD02 \
  --variant conservation-atlas > "$FIXTURE"
node tools/local-dev-bench/paper/ld02-atlas.mjs \
  "$FIXTURE" "$APPROVED_FILE" "$RUN_ID" > "$PRIVATE_PLAN"
node --test tools/local-dev-bench/paper/ld02-atlas.test.mjs
```

Pass a file-scoped Paper MCP reader such as `withPaper` to
`discoverAtlasEdit` and `captureAtlas`. Discovery performs two exact
text queries on each registered page and confirms both matches share
the same editable station. It emits the text request and the two
native CSS property writes. The installed importer produces a childless
editable Paper Frame for the filled rounded marker. The adapter maps it
to the neutral rectangle, retains `native_type: Frame`, and requires
native fill and radius readback. The installed inventory has no direct
rectangle-creation command.
The observer traverses each actual layer
tree and captures computed styles in batches of 25. The protected
comparison checks the full normalized content and IDs, with the
three edited fields and their expected downstream layout movement
matched separately by the neutral oracle.

The source document must show an empty `get_selection` response
before measuring the edit. Missing native geometry is preserved as
`null` with named rows in `missingBounds`. Qualifying the run needs
independent bounds for inactive-page flow children and the original
normal reopen. The neutral copy history requires a distinct document
ID, a full matching starting state, native Undo and Redo with correct
counts, and preserved copy IDs from start through Redo. Paper's
`create_file(cloneFileId)` has separate-file evidence from LD03.
The installed MCP lacks close-file and native Undo/Redo tools. The
adapter has no live command mode. Live atlas ingestion and history
remain unmeasured.
