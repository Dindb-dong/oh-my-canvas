# OMC N-G and LD06 image pressure

```sh
node --test tools/local-dev-bench/omc-native/asset-pressure.test.mjs
node tools/local-dev-bench/omc-native/asset-pressure.mjs --condition distinct --fixture-only
node tools/local-dev-bench/omc-native/asset-pressure.mjs --condition shared --size 1mp --artifact-dir /path/to/evidence
node tools/local-dev-bench/omc-native/asset-pressure.mjs --condition distinct --size 1mp --artifact-dir /path/to/evidence
node tools/local-dev-bench/omc-native/asset-pressure.mjs --condition shared --size 2mp
node tools/local-dev-bench/omc-native/asset-pressure.mjs --condition distinct --size 2mp
```

Each run starts an installed OMC service in an independent disposable headless profile. Both conditions place twenty images with identical aspect ratio and geometry. The shared arm ingests one PNG and places it twenty times. The distinct arm ingests twenty PNGs with the same intrinsic size and different quadrant colors. The two-megapixel arm uses 1600 × 1250 pixels per source. The lower-size arm uses 1152 × 900 pixels per source. All inputs are compressible opaque RGBA. This diagnostic covers image residency pressure under a fixed small export viewport.

The report records ingest and placement round trips and durable revision increments, verifies all twenty image references and coordinates, and reads each stored native asset byte-for-byte after exporting. The first and two repeated native PNG exports are timed separately. Each accepted export is checked against 80 expected interior pixels and the repeated pixel hashes must agree. Optional PNG evidence does not overwrite existing files.

A render reservation rejection is recorded as `rejected-budget` with exit code 2, including the exact runtime error and source readback. An accepted image atlas exits 0. Use external sampling for CPU and RAM. Headless exports do not supply independently attributed hash/copy/decode intervals, cache events, GPU upload/completion, physical presentation, or evidence for masks, blurs, gradients, and fonts.
