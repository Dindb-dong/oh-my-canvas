# Synthetic workload specifications

These fixtures describe useful design work in product-independent terms. Each
variant is a separately authored source family for fixture development. The
first batch supplies two variants per workload. It does not establish a
confirmatory sample size or capability across the products.

```sh
python3 tools/local-dev-bench/workloads/synthetic.py fixture LD01 \
  --variant harbor-ops --assets-dir /path/to/new-assets
python3 tools/local-dev-bench/workloads/synthetic.py fixture LD03 \
  --variant edition-grid
python3 tools/local-dev-bench/workloads/synthetic.py grade LD01 \
  /path/to/observations.json --variant harbor-ops
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tools/local-dev-bench/workloads
```

LD01 variants `harbor-ops` and `reading-room` have different navigation
structures, column sets, record counts, and details placement. Both start with
an empty document. A source specification describes the canvas, layer
relationships, exact strings, allowed logical geometry, and two generated
uncompressed PNG assets. The original PNG and decoded top-to-bottom RGBA
hashes are included in each manifest. Before scored use, freeze the actual
installed Inter font bytes and prove equivalent rendering and no clipping.

LD03 variants `field-relay` and `edition-grid` have different department
groupings and board structures. Each starts with forty cards in the target
shared style family, four property-level overrides on those cards, and a
separate visually similar family. One registered mutation changes the
shared accent and another changes the shared spacing on a verification copy.
The product adapter must prove editable persistent style bindings before
registering the profile. The native component extension is not covered.

## Capture contract

An independent observer reads the actual product state and emits these
snapshots in its JSON evidence:

- `before` records the starting document.
- `candidate` records the submitted persisted design.
- `reopened` records the candidate after the normal close and reopen path.
- `probe` records the isolated verification copy after the registered edits.
- `after_probe_original` rereads the original to detect unintended changes.
- `probe_actions` records the actions actually performed on the copy in order.

Each snapshot has `document_id`, `nodes`, and `styles`. The last two are
arrays keyed by the fixture's logical `key`. All nodes and styles carry their
observed `native_id`. Nodes carry actual `editable`, `kind`, `parent`
(logical key or null), and the property fields present in the fixture.
Bounds are absolute logical coordinates in the order x, y, width, height.
For style-bound nodes, `bindings` maps each property to the native style ID
observed in that snapshot. A product's wrapper layers can be normalized away
only when they add no visible or editable content. Extra logical content must
surface in the normalized snapshot.

The checker compares expected fields, full logical node sets, independent
editability, native identity continuity, and changed values. Snapshots of a
verification copy can use different native IDs but must still resolve each
binding to that copy's observed style ID. A raster may be re-encoded if its
decoded pixels match the required RGBA hash. Evidence adapters must record
the true reads, actions, and persistence boundaries. Do not pass their
grader-only data or generated expected snapshots to the measured model.
The semantic checker does not implement native UI capture, compare raster
clipping, or generate evidence from an app on its own.
