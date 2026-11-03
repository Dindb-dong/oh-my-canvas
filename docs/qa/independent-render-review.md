# Independent renderer regression evidence

Implementation barrier: `f86e063`. All tests in this report were independently authored and executed after that barrier. No inherited editor test bodies were read or imported. The run uses the installed Playwright Electron driver, installed esbuild, actual Chromium DOM/Canvas/font/image decoders, and installed Poppler. No dependency was installed and no default application profile was opened.

## Result

- **32 cases, 830 assertions, 0 failures, 0 browser page errors.**
- A real minimized Electron BrowserWindow completed settled image capture in **1,560 ms** at 380 × 280 pixels.
- Actual Electron screen pixels and self-contained exported PNG pixels matched exactly in the captured board: mean absolute channel error **0**, large-difference pixels **0**, missing text-ink pixels **0**. Separate thresholds exist for antialiasing variation and missing geometry; this run did not consume either tolerance.
- PNG, JPEG, WebP and embedded PDF JPEG were decoded with actual Chromium image decoders. Poppler independently parsed and rendered the PDF: one page, PDF 1.4, 380 × 280 points, no JavaScript; its decoded colored interior pixel was `[30, 98, 57, 255]` against expected `[29, 98, 56, 255]`.
- Actual trusted preload → main-process `export-file` → atomic disk writer paths passed success, cancellation and a task-owned `ENOTDIR` failure. The dialog choice was intercepted to make the destination deterministic; the real host validation, IPC and disk writer were used. Saved disk bytes equal the generated PNG bytes.

The detailed machine result, bundled-harness SHA-256 and CanvasKit WASM SHA-256 are in `independent-render-results.json`.

## Coverage and independent oracles

| Requirement | Exercised behavior | Oracle |
| --- | --- | --- |
| LAY-01 | 48 flex direction/justify/wrap combinations; baseline, nested hug/fill/min/max, repeated reflow | Native CSS flex boxes and native inline baseline marker; independently calculated nested-size identities |
| LAY-02, GEO-01 | Fixed and automatic grid tracks, spans/cell alignment, percentages, ordinary/rotated resize constraints, rotated layout | Native CSS grid boxes; explicit numeric anchors; trigonometric world-center expectations |
| TEXT-01, TEXT-03 | Mixed rich runs, multiple native lines, CJK, emoji graphemes, list/paragraph spacing, loaded fonts, leading trim, truncation | Native text measurement and line positions; exact emitted SVG fragment baselines; actual screen/export ink comparison |
| AST-01 | Unicode-range lazy loads, available numeric variable-font weights, deduplication, unknown-family warning, font embedding | Real FontFace status and fetched font bytes; absent-family fixture; no truthy `document.fonts.check` substitute |
| PAINT-01 | Ordered translucent paints, solid/linear/radial/angular/diamond, all 16 blend modes, inside/outside strokes, dash gaps, endpoint geometry, independent corners, drop/inner/backdrop effects | Known interior raster colors; native Canvas compositing for all blend modes; actual spatially different gradient pixels |
| PAINT-02 | Alpha/luminance/vector masks, disabled mask, text glyph counter, nested group silhouette, independent legacy rectangle clip, image contain/crop/tile/desaturation | Known covered/uncovered raster pixels and glyph/group gaps; image source with independently colored halves |
| VEC-02 | All four Boolean operators and canonical output verbs; live operand recomputation and changed export bounds | Analytic overlapping rectangles and native tight bounds; actual exported image size after operand movement |
| EXP-01 | SVG parse, image formats/scale/fixed bounds, PDF world units/xref, real page decode, overview/slicing | XML parser, native image decoders, byte offsets, Poppler page parser/renderer; explicit pixel/dimension expectations |
| EXP-02 | Awaited save adapter plus actual desktop IPC/write, cancellation/error | Actual file bytes and rejected host disk operation in owned temporary directory |
| UI-01 | Renderer hotpath and disposal | Element identity preserved across hover/selection/viewport; render-notification count; removed owned measurement/stage nodes |

## Regressions found and fixed

1. **CanvasKit module/binary mismatch:** the package root JavaScript loader was paired with the full WASM asset, producing an invalid WebAssembly function-table address during real Boolean operations. The independent adapter now imports the package's `full` entry to match the shipped full WASM. All analytic Boolean cases now pass.
2. **Pattern content coordinates:** image and angular/diamond pattern content used world positions inside an already translated pattern tile. Content now starts in tile-local coordinates. Real image contain/crop/tile and gradient pixel checks pass.
3. **Flex overflow and reversed axes:** negative free-space distributed fallback, singleton reversed `space-between`, and wrapped single-line cross extents disagreed with native CSS. The complete 48-case native comparison passes after correction.
4. **Constraint alias:** canonical `leftAndRight` was overridden by the geometry helper's own-field precedence. The B reconciliation proxy normalizes the canonical own fields. The A owner separately corrected the shared helper aliases and ordinary group default paints; the final suite exercises those real changes without masking group fills in the fixture.

Earlier pre-barrier static corrections to independent rectangle clipping, measured baseline alignment, reversed line grouping and text/group vector masks are recorded in `editor/render/IMPLEMENTATION.md` and have actual dynamic cases in this run.

## Reproduction

```sh
node scripts/independent-render-e2e.mjs
```

Electron needs execution outside this environment's restricted process sandbox. The runner creates and removes an exact task-owned `omc-independent-render-*` profile directory. It does not install the application, replace `/Applications/Oh My Canvas.app`, touch an existing profile, open network services beyond the app's existing local MCP bridge, or upload anything. Screenshot/export evidence is written only under the `docs/qa/independent-render*` prefix.

Static checks also pass:

```sh
./node_modules/.bin/tsc --noEmit --strict --skipLibCheck --target ES2022 --module ESNext --moduleResolution Bundler --allowJs --lib DOM,DOM.Iterable,ESNext editor/__tests__/render-browser.ts
node --check scripts/independent-render-e2e.mjs
```

## Evidence files and remaining bounds

- `independent-render-results.json`: per-case results, requirements, timing, native disk checks, Poppler result, source fingerprints.
- `independent-render-gallery.png`: actual Electron viewport.
- `independent-render-screen-board.png`: actual CSS-scale board capture used for pixel comparison.
- `independent-render-scene.svg`, `independent-render-export.png/.jpeg/.webp/.pdf`: real generated files.
- `independent-render-native-save.png`: bytes read back after actual main-process native-save IPC.
- `independent-render-pdf-decoded.png`: actual Poppler page rasterization.

This suite does not by itself validate UI text IME/caret/history, every inspector interaction, actual collaboration, install/package provenance or the inherited application's visual equivalence. Those are assigned to other lanes/parent acceptance work. The gallery tests prove screen/export agreement for the included font/image/paint scene, not every possible operating-system font, Unicode sequence or numerical parameter combination. Angular/diamond 256-pixel sampling, corner smoothing approximation and native raster antialiasing remain explicitly documented rendering choices. No claim of an unexposed clean room or legal clearance is made.

## Actual 1,065-object library startup performance

The eligible `docs/design/system/component-library.omc` was decoded as data and mounted through the same public facade. It contains 222 frames, 571 fixed text layers, 272 rectangles, 172 component mains, and 10,109 mounted DOM nodes. Phase timing found a real font-subset selection defect: the previous matcher split and parsed every Unicode interval again for every character, even on already loaded faces. The fix compiles intervals once at registration and checks only sorted unique code points with numeric searches. It does not preload extra fonts.

| Phase | Captured before fix | After fix |
| --- | ---: | ---: |
| Font `ensure` on actual serialized text corpus | 51,428.8 ms | 26.6 ms |
| Initial layout | 274.3 ms | 189.7 ms |
| Renderer construction | 161.9 ms | 99.0 ms |
| Renderer settled | 56,898.0 ms | 42.7 ms |
| Complete public facade mount | 109,584.7 ms | 573.9 ms |

The actual corpus has 92,713 UTF-16 code units but only 91 unique Unicode code points. An independently authored straightforward interval oracle expects exactly **13 of 125 font faces**. Actual embedded loaded-face CSS contains exactly those 13 faces. Four benchmark assertions pass: expected/actual subset equality, fewer than all registered slices loaded, font ensure below 2.5 seconds, and full facade mount below 5 seconds. These four assertions are additional to the **32-case / 830-assertion** functional suite. The functional suite was rerun after the optimization with all 830 passing and bounded background capture completing in 1,560 ms.

`independent-render-library-profile.json` preserves the captured pre-fix trace. `independent-render-library-profile-optimized.json` contains the optimized trace and four passing assertions. Future profile runs write only the optimized filename so they cannot overwrite the original trace.

```sh
node scripts/independent-render-e2e.mjs --library-profile
```

The phase hook is an optional diagnostics callback passed through the existing options bag. No test-specific production global or eager-font bypass was introduced. The full native import/Assets journey is separately owned by the component acceptance lane.

## Shared source-scene Assets previews

`view.thumbnailSvg(pageId, mainId)` now uses the same native text-fragment measurement and scene writer for a read-only subtree from any page. It loads only requested text fonts, resolves Boolean geometry, fits the actual source bounds, and returns inline SVG without per-tile font byte payloads. Generated definition IDs have a thumbnail-specific namespace so gradients/clips/masks cannot collide with the active canvas or another source thumbnail. The cache is bounded to 200 source entries and invalidates with source data/font revision.

The additional dynamic case verifies actual cross-page glyphs/paint, parsed SVG bounds, disjoint definition IDs, rendered inline glyph width, no embedded font payload, and unchanged active page, selection, document and durable edit count. Shared browser text measurement lives in `editor/render/text.ts`; no UI copy of geometry/paint/text rendering was introduced. This brings the current functional suite to **32 cases / 830 assertions**, with the separate four-assertion 1,065-object benchmark still passing after the refactor. Native Assets interaction and label containment are additionally checked by the UI/component lanes.


## Final imported-geometry and metric-cache regression

The actual service regression first reproduced imported absolute HTML drag snapping from requested (345,320) back to CSS (300,300). `applyLayout` now treats canonical world geometry as authoritative and updates existing CSS anchors in parent-local content coordinates. Responsive percentages apply on parent-size changes and derive their ratios from canonical geometry before resizing. Generic projections cannot replay stale pixel CSS over a drag or a concurrent field merge. A new two-real-Replica case concurrently edits X and Y of a percent-positioned child, exchanges actual CRDT states, receives both projections, renames, and resizes the parent; both coordinates and both later percentage offsets remain correct. The earlier synthetic percentage fixture was corrected to have coherent canonical X=52 for a parent X=20,width=320 and left=10%.

A shared native metric cache keys actual text HTML, measurement kind, width/height and font revision. It stores relative scene fragments so movement reuses typography, clones public metric results, and retains at most 4,096 entries / 8 MiB including UTF-16 key bytes and metric payload estimates. Catalog additions, newly loaded faces before `ensure` returns, destruction, and FontFaceSet loadingdone/loadingerror invalidate measurements. Actual browser checks cover text/width invalidation, actual font loading, mutable-result isolation, hit counts, and large-key eviction. No new dependency or facade test-only API was added.

Latest full suite: **32 cases / 830 assertions**, zero failures/page errors, minimized capture 1,560 ms. Separate actual 1,065-object profile: **8 assertions**, 25.4 ms font ensure (same 13/125 faces), 47.4 ms initial layout, 341.3 ms facade mount. Five public-service rename samples were 342.6, 212.6, 229.8, 242.9, 260.3 ms (median242.9). First reconciliation introduced276 new metric keys; each subsequent rename had **3,596 cache hits and zero misses**, with scene text measurement approximately1 ms. This service-only result is not the parent's durable MCP roundtrip benchmark (pre-cache median741 ms/p95804 ms); final host measurement belongs to integration. All raw timing samples are retained in `independent-render-library-profile-optimized.json`.


## Saved font and exported SVG follow-up

Latest actual browser run: **32 cases / 830 assertions**, zero failures/page errors, background capture16ms. The separate large-library benchmark retains **8 passing assertions**. Saved embedded font assets now register centrally before initial font loading/layout. A real independently loaded FontFace oracle verifies initial auto width/height and reopened dimensions; asset removal, Undo/Redo, projected add/remove, immediate scene metric refresh, prepared import ownership, cancelled preflight, failed-font diagnostics and final disposal are covered. The focused lifecycle disposal suite passes **3/3**.

The shared SVG sanitizer fix belongs to E. B's actual browser case rejects five active SMIL import variants, exports raw SVG shapes without active nodes, and preserves five green static link rectangles. The runner mounts the exported source in real browser frames, waits for SMIL scheduling and performs five trusted Playwright link clicks, recreating the frame after each harmless hash navigation. The parent sentinel remains **0**. `independent-render-results.json` records `svgSecurity.linksClicked=5` and `sentinel=0`; this is actual activation evidence in addition to parsed-source assertions.
