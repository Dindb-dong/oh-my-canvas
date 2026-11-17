# Synthetic workload specifications

These fixtures describe useful design work in product-independent terms. Each
variant is a separately authored source family for fixture development. The
current set supplies two variants each for LD01, LD03, LD04, LD06, and LD07.
Confirmatory sample size and per-product capability require separate evidence.

```sh
python3 tools/local-dev-bench/workloads/synthetic.py fixture LD01 \
  --variant harbor-ops --assets-dir /path/to/new-assets
python3 tools/local-dev-bench/workloads/synthetic.py fixture LD03 \
  --variant edition-grid
python3 tools/local-dev-bench/workloads/synthetic.py brief LD04 \
  --variant lab-queue --registration /path/to/private-width.json
python3 tools/local-dev-bench/workloads/synthetic.py fixture LD06 \
  --variant metro-stories --font-file /path/to/licensed-font.otf \
  --font-license OFL-1.1 --assets-dir /path/to/new-assets
python3 tools/local-dev-bench/workloads/synthetic.py grade LD01 \
  /path/to/observations.json --variant harbor-ops
python3 tools/local-dev-bench/workloads/synthetic.py brief LD07 \
  --variant transit-departures
python3 tools/local-dev-bench/workloads/synthetic.py grade LD07 \
  /path/to/observations.json --variant transit-departures \
  --symptom-screenshot /path/to/retained/symptom.png
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

LD04 variants `street-market` and `lab-queue` use separate card content,
constraints and nesting. Use a private registration file with an intermediate
integer `width` strictly between 390 and 1440, excluding 768, and a random
`nonce` of at least 16 characters. Lock the `withheld_width_commitment`
from the `brief` output before the run. Keep the registration file and the
`fixture` output private. Use the same registration file with `grade`.
A fixture generated with the built-in demonstration width cannot pass.
The native wrap contract uses one connected frame and common width-driven
min/basis/max, row order, gap, content height and overflow rules.

LD06 variants `metro-stories` and `garden-labels` provide distinct six-card
designs, the supplied JSON content, six initial PNG assets, and two image
replacements. Two separately named initial assets share identical bytes and
stay shared through the edit. Select an openly redistributable
single-font `.otf` or `.ttf` that covers the listed Latin and Korean
characters. Supply both the file and its license identifier before grading.
The validator reads the family and required Unicode mappings from the
font and pins the exact file digest. The actual import, resolved glyph runs,
fallback, and code handoff require product evidence. [OpenType cmap](https://learn.microsoft.com/en-us/typography/opentype/spec/cmap)

Pass the same font
file and license to `grade`. A fixture without a registered font is usable
for preparation and cannot pass.

## Capture contract

An independent observer reads the actual product state and emits these
snapshots in its JSON evidence:

- `before` records the starting document.
- `candidate` records the submitted persisted design.
- `reopened` records the candidate after the normal close and reopen path.
- `probe` records the isolated verification copy after the registered edits for LD01, LD03 and LD04.
- `after_probe_original` rereads that original to detect unintended changes.
- `probe_actions` records the actions actually performed on that copy in order.
- `loaded` records the initial import before the two prescribed updates for LD06.

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


For LD04 also capture the locked `withheld_width_commitment` and ordered
`width_observations` snapshots. Each snapshot has the observed `width`.
The independent copy resizes to 768, 390, the withheld width, then 1440.
All four observations and `probe` must carry the same native object IDs and
document ID. The original candidate is reopened at 1440 and reread unchanged
after the copy verification. Derive `fully_visible`, `overflow_x`, and
layout properties from the actual UI and native constraints.

For LD06 each `loaded`, `candidate` and `reopened` snapshot includes
`glyph_render: {font_sha256, rendered}`. Here `rendered` is the sorted
set of required characters proven to use the expected face in glyph runs.
Each imported text's
`font_sha256` is the observed resolved face. For images, `crop_source_px`
is x, y, width, height in the original asset pixel space before scaling.

The LD06 `handoff` observation includes a source `commit` and a
`source_tree_sha256` of the immutable input, plus two `builds` of separate
clean checkouts. Each build includes unique `checkout_id`, the observed
`commit`, `source_tree_sha256`, `clean_checkout`, process `exit_code`,
`external_requests`, `glyph_render`, and a `rendered` map of observed
content and assets keyed by logical IDs. Record rendered fields from the
fixture and `provenance: bundled|embedded` for reproducible local assets.
Do not include requests to the test app itself in `external_requests`. Any
dependency outside the clean local test server must appear there, including
private-local URLs that happen to work on the setup machine. Preserve source
commit, build logs, browser readbacks, and asset resolution proof alongside
the normalized observation. Product import, browser capture, font installation
and code export require product adapters.

## LD07 defect preparation and diagnosis

`transit-departures` and `clinic-check-in` are separate diagnostic fixtures.
Seed the private `expected` snapshot as a healthy editable document. Apply its
two ordered `injections` through native properties and verify the resulting
document against `start`. The injected or repaired property is identified by
`collection`, `key` and `field`, with `from` and `to` giving the expected prior
and resulting values. The logical key for a binding identifies the associated
style. The helper `ld07.apply_operations(snapshot, operations)` applies the
same mutations and resolves resulting positions and style fills for fixture
validation. Seed native layout and style relationships in the product.

Outside the timed attempt, reopen the prepared corrupt file and capture its
visible state as `symptom.png` from that product at the registered viewport.
Use the viewport crop without tool overlays, annotate nothing, and retain the
original PNG and its SHA-256 alongside the independent `before` readback.
Verify by visual inspection that the captured fault and the nearby object are
visible. Give the measured agent the `brief` output, the captured PNG, and
the editable document. Keep private manifests, the fixture checkout and the
observer's results outside the workspace visible to that agent. Use a fresh
corrupt document for each attempt. A capture generated from source geometry
is suitable for a harness test only.

The observer records `symptom_capture` with the PNG's `sha256`, pixel `width`
and `height`, corresponding `document_id`, and `phase` equal to `before`.
The grader verifies the retained PNG's identity and uses native readbacks
for geometry and style acceptance. The observer validates capture content.
`diagnoses` records each root cause reported by the agent using `collection`,
`key`, `field`, and `from`. `repair_actions` records measured edit operations
using the same fields plus `to`. Map native changes to their logical targets
and retain the underlying edit trace. Two accepted operations may be
performed in either order. Native positions and resolved fills that
update automatically belong in the candidate snapshot. Measure the two
repairs together with their diagnosis. Confirm both survive a normal reopen
and compare the complete logical node and style sets and IDs to detect
replacement or changes to unrelated content.

Record UTF-8 or binary response byte counts from raw model-visible reads,
classified by scope as scoped, whole-file, or unknown. Also record the number
of tool screenshots requested after timing starts, false diagnoses and write
attempts, and preserve trace references that explain those counts. The
initial symptom image is setup evidence delivered with the prompt. Report
accepted elapsed time and all observed agent usage with missing or
unattributable counters marked unknown. LD07 defaults to a 900-second and
120,000-token cap and is outside the primary six-family panel.
