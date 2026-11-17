# Penpot LD09 prepared native-file probe

This probe covers the prepared native-file route. Generate a fixture
specification for one case with:

```sh
node tools/local-dev-bench/penpot/ld09.mjs plan small 0
node tools/local-dev-bench/penpot/ld09.mjs plan small 15
node tools/local-dev-bench/penpot/ld09.mjs plan large 100
node --test tools/local-dev-bench/penpot/ld09.test.mjs
```

The size and catalog dimensions are independent. Use the small, zero-distractor
case to qualify the probe before running planned scale cases. Populate the
distractor files in the isolated project and leave them closed for the probe.
The file under test is in addition to the distractor count. Keep the observed
saved-project inventory with the preparation record. The probe checks the
declared catalog names and count, and verifies the opened file live by native
IDs and object count. Catalog verification is part of fixture setup.

To prepare one registered case on an already running task-owned Penpot
stack, pass a new private directory outside version control:

```sh
node tools/local-dev-bench/penpot/seed-small.mjs http://localhost:19001 /private/evidence/new-ld09-small-0
node tools/local-dev-bench/penpot/seed.mjs http://localhost:19001 /private/evidence/new-ld09-small-15 small 15
node tools/local-dev-bench/penpot/seed.mjs http://localhost:19001 /private/evidence/new-ld09-large-100 large 100
```

The seeder creates a fresh synthetic account and its private Drafts project in
headless Chrome. It creates distractors sequentially, with one saved native
tile per file, then creates and verifies the native target after normal reopen.
The large page contains 249 additional four-object cards so the target and
distractors total 1,000 native objects on one page. It seeds these extra cards
in batches of up to 25 boards. The Project Files UI supplies the full observed
saved-name order, newest modification first, including the target. Keep seed
time separate from lifecycle timing. Larger catalogs may need several minutes
of preparation because each file is created and saved through Penpot.

The output directory contains `prepared.json`, `storage-state.json`, and
`mcp-endpoint.txt`. Keep all three private and remove the short-lived auth
files when the run is complete. The generated cases use simple native solid
shapes and carry no image/font readiness registration. To register a prepared
case with observable assets, use the same names, IDs and native object counts
in its fixture manifest. The
fixture manifest has these fields:

- `size` and `savedLibraryEntries` from the plan
- `origin`, the task-owned HTTP loopback Penpot origin
- `workspaceUrl`, the exact prepared URL, including the native file and page IDs
- `fileId`, `pageId`, `textId`, the guarded native fixture identities
- `savedCatalog`, the observed isolated project's saved names, including the target
- `catalogOrder` and `catalogUrl`, the seeder's observed order and exact Project
  Files URL. Manually prepared older manifests may omit these two fields.
- Optional `assetFont` with `assetPaths` mapping known same-origin `/assets/` image
  response paths to SHA-256 digests, and exact `fontFamily` and native `fontId`
  for the editable caption

Provide `PENPOT_BENCH_STORAGE_STATE` as the path to private Playwright storage
state from the synthetic account and `PENPOT_BENCH_MCP_URL` as that account's
private local MCP endpoint. Register these commands with the attempt runner
using a fresh prepared target for each repetition:

```json
{
  "argv": ["node", "tools/local-dev-bench/penpot/ld09.mjs", "run", "PRIVATE_PREPARED.json"],
  "acceptance_argv": ["node", "tools/local-dev-bench/penpot/ld09.mjs", "accept", "PRIVATE_PREPARED.json"]
}
```

The lifecycle clock starts at the headless browser launch request. Browser
readiness includes creating the fresh authenticated context. First native
content is the named layer becoming visible in Penpot's Layers panel. Chrome
headless provides no first-visible-OS-window observation. The optional image
hash and loaded browser font checkpoint measures available resources, and the
native readback also checks the caption's font ID. Canvas pixels and fallback
glyph rendering require a separate presentation quality check. Missing
renderer evidence does not establish full LD09 qualification.

The warm reopen closes and reopens the single workspace page in the same
browser context. A separate native read verifies the saved caption on the
same file, page and shape. The save response watcher records an optional HTTP
observation. Host/OS caches are uncontrolled. This route has no import
conversion, HTML ingestion, first-login timing, or large-case runtime evidence.

## LD03 field-relay native token probe

The deterministic adapter prepares the canonical 40-card field-relay scene
using editable Penpot boards and text. Penpot's local token set binds native
color to fill and spacing to vertical row gap. The two target token edits
leave the four local overrides and four archive cards in place. The adapter
closes and reopens the original, duplicates it using the Penpot dashboard,
performs the second token edit on the distinct copy, and rereads the original.

Generate and run the fixture against a disposable task-owned loopback stack:

```sh
python3 tools/local-dev-bench/workloads/synthetic.py fixture LD03 --variant field-relay > "$FIXTURE"
OMC_BENCH_CANDIDATE="$EVIDENCE" node tools/local-dev-bench/penpot/ld03.mjs http://localhost:19001 "$FIXTURE"
python3 tools/local-dev-bench/workloads/synthetic.py grade LD03 "$EVIDENCE" --variant field-relay
node --test tools/local-dev-bench/penpot/ld03.test.mjs
```

With the attempt runner, use the probe as the producer and the common
`synthetic.py grade LD03` command as the independent acceptance command.
The producer reports setup, two-token edit readback and normal reopen
timings on its internal clock. The runner's completion includes duplicate
and verification actions. This probe measures native editable properties,
token IDs and bindings. It does not measure visual raster presentation,
model-assisted work or the native component extension.
