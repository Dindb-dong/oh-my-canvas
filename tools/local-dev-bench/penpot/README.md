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

Prepare a disposable local Penpot account and project. Create the target file
and one page with the plan's exact names. Create a top-level board named
`LD09 lifecycle board` with a text child named `LD09 editable caption` containing
`Library status: awaiting review`. Put the registered native object count on that
page and keep the other content fixed across equivalent repetitions. Keep the
fixture file private, with these fields:

- `size` and `savedLibraryEntries` from the plan
- `origin`, the task-owned HTTP loopback Penpot origin
- `workspaceUrl`, the exact prepared URL, including the native file and page IDs
- `fileId`, `pageId`, `textId`, the guarded native fixture identities
- `savedCatalog`, the observed isolated project's saved names, including the target
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
