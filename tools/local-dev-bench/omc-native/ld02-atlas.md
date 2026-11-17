# OMC conservation-atlas replay

```sh
python3 tools/local-dev-bench/workloads/synthetic.py fixture LD02 --variant conservation-atlas > /path/to/fixture.json
node --test tools/local-dev-bench/omc-native/ld02-atlas.test.mjs
node tools/local-dev-bench/omc-native/ld02-atlas.mjs --fixture /path/to/fixture.json --fixture-only
node tools/local-dev-bench/omc-native/ld02-atlas.mjs --fixture /path/to/fixture.json > /path/to/observations.json
python3 tools/local-dev-bench/workloads/synthetic.py grade LD02 /path/to/observations.json --variant conservation-atlas
```

The deterministic replay uses the installed service and an isolated unfocused desktop. It prepares the canonical ten-page, 1,000-object fixture with authored vertical layouts and editable text. It observes clear starting desktop selection for the original and the separate native duplicate. Discovery reads actual native state and identifies the target by exact station name and receipt. The three changes are one durable batch. Setup, discovery, save, normal service restart, full-state readbacks and copy Undo/Redo are recorded separately.

The adapter reads every page at the captured revision with the native layout diagnostic tree. Stable identities, authored content and hierarchy are normalized from the independent native snapshot. Per-object bounds come from renderer layout diagnostics. Extra clipping and overflow observations remain in each captured phase. The common grader determines acceptance. Visible frame presentation, model usage and resource sampling are outside the replay.
