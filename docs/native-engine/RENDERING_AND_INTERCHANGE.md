# Native rendering and interchange contract

[Plan](../NATIVE_ENGINE_PLAN.md) · [Engine contracts](ENGINE_CONTRACTS.md) · [Reference projects](REFERENCE_PROJECTS.md) · [Capability matrix](CAPABILITY_MATRIX.md) · [Qualification](QUALIFICATION.md)

**Status:** proposed native version 1, unimplemented. This document specifies the required editable-design profile and the algorithms/interfaces an implementation must supply. It does not claim general browser compatibility or native performance already measured. Every required feature has UI, MCP and output obligations; a raster screenshot alone does not establish editable fidelity.

## 1. Shared pipeline and ownership

Use one authored model and one native layout contract for the desktop, headless queries and exports. An internal Rust tree used to adapt CSS/layout libraries is permitted. An operating-system WebView, Chromium process, browser DOM measurement element or JavaScript rendering runtime is not part of the required production path.

| Stage | Input | Output and cache identity |
| --- | --- | --- |
| Parse/convert | Explicit input bytes, source kind, import profile and verified resources | Candidate authored nodes/rules, stable source map and diagnostics |
| Style | Authored properties/rules/tokens, ancestor context, viewport state | Computed properties with winning-source provenance and dependency versions |
| Text | Styled Unicode runs, paragraph rules, width constraints, pinned font environment | Glyph/cluster runs, line metrics, caret/selection maps and font diagnostics |
| Layout | Styled entities, text/replaced-element measurements and containing constraints | Logical boxes, overflow and dependency edges |
| Scene | Coherent layout, transforms, ordered appearance and clip/effect dependencies | Display list, paint/ink bounds, spatial index and damage regions |
| Render | Display list, resource generation, camera/output scale, time sample and color profile | Native pixels/vector operations and resource/presentation metrics |

A layout snapshot identifies semantic epoch/revision, viewport, font/resource generation, layout-profile version and animation time. Individual caches use their actual dependency fingerprints so an unrelated document edit does not invalidate every glyph. A published scene may reuse unchanged cached results only when their dependencies are valid for its snapshot. Do not combine an old text layout with a new transform without recording that coherent relationship.

The GUI may keep presenting its last coherent frame while background preparation runs, with a visible loading/pending state where relevant. A screenshot or measurement request identifies the requested revision and waits for that revision's necessary preparation or returns an explicit dependency/limit error. It cannot quietly return whichever pixels happen to be on screen.

## 2. Editable HTML/CSS profile

Call the initial profile `omc.design-css/1`. Include it in import/export metadata and capability negotiation. CSS syntax accepted by an underlying parser is not automatically supported design behavior. The [CSS cascade](https://www.w3.org/TR/css-cascade-5/), [flexbox](https://www.w3.org/TR/css-flexbox-1/), [grid](https://www.w3.org/TR/css-grid-2/) and [text](https://www.w3.org/TR/css-text-3/) specifications are reference semantics for the supported features; this project owns the finite support profile and conversion diagnostics.

| Family | Required native completion behavior | Explicit boundary |
| --- | --- | --- |
| Structure | Nested semantic containers, headings, paragraphs, lists, spans, images, links and editable SVG mapping | Link destination is metadata; importing a link does not navigate or fetch it |
| Form/snapshot content | Editable visual representation of labels, controls, tables and overlapping content in supported snapshot packages | Native design objects represent captured appearance/structure; no embedded website scripting engine |
| Selectors/cascade | Type, class, ID, descendant/child, simple attribute selectors, `:root`, first/last/nth-child, specificity, source order, inheritance and `!important` | Import declares unsupported selectors/pseudo-elements; UI control hover/focus is separate from arbitrary web application behavior |
| Rules/source | Inline declarations and author style rules with stable rule IDs; preserved namespaced source metadata | Active scripts, event-handler attributes and network stylesheet imports do not execute |
| Variables/tokens | CSS custom properties, references, fallback and cycle/invalid-value diagnostics; typed design tokens/modes | Computed values do not replace the stored reference silently |
| Units/sizing | px, percent, em/rem, viewport units, auto, min/max constraints and supported `calc`/`min`/`max`/`clamp` expressions | Percent/intrinsic dependence remains in the model rather than being frozen to one viewport |
| Box layout | Block/inline design content, padding/margins/borders, box sizing, flex directions/wrap/alignment/gaps, grid tracks/spans/placement | Float, multi-column fragmentation, subgrid and paged-media layout are outside profile 1 unless added with fixtures |
| Positioning | Relative/absolute authored positioning, transforms/origin, stacking order, overflow/clip | Fixed/sticky content is imported only through an explicit captured-viewport conversion with a diagnostic; no silent equivalence to scrolling browser behavior |
| Responsive rules | Width-based min/max media conditions with explicit artboard viewport, responsive flex/grid and inherited variables | Arbitrary media/device/container queries require a negotiated profile extension |
| Typography | Rich inline styles, paragraph/list behavior, bidi, shaping, fallback, decorations, wrapping and selection | Source font absence is a diagnostic; substituted text is not labeled visually verified |
| Appearance | Multiple fills/strokes, gradients, image sizing/crop, opacity, masks, supported blend modes, shadows and blur | Source values outside supported ranges/algorithms are diagnosed, never silently discarded |
| Excluded active content | Preserve bounded inert source metadata and report unsupported interactive constructs | No arbitrary JS, remote iframe, browser plugin or general web application execution |

Table imports must preserve rows/cells/spans as editable structure. If the parser cannot implement an HTML table sizing rule, it may offer an explicit conversion to a grid using captured constraints. Report that conversion and its responsive limits; an unchanged table round-trip test cannot pass on a converted grid without the declared policy. A source requiring an excluded feature returns `unsupported_feature` in strict mode. Permissive inspection retains source metadata plus diagnostics; it does not establish full fidelity or close that capability.

WP-07 must turn this profile into a versioned property/value registry, proposed at `native/spec/design-css-v1.json`. For every property, selector, function and appearance value, record accepted grammar, units/ranges, initial value, inheritance, authored-to-computed rule, invalidation cause, import/export conversion, diagnostic policy and fixture IDs. Include every current C7 property/enum from the capability matrix and every required family above; an adapter cannot redefine “supported” to silently shrink that set. The `calc`, `min`, `max` and `clamp` entries must enumerate their admitted typed arithmetic and nesting rules. Blend-mode coverage includes normal, multiply, screen, overlay, darken, lighten, color-dodge, color-burn, hard-light, soft-light, difference, exclusion, hue, saturation, color and luminosity, with individual compositing fixtures. Design-specific values that lack an equivalent CSS expression retain their authored value and require an explicit export conversion/diagnostic.

### Import algorithm

1. Identify source kind, declared profile and base resource capabilities. Parse within the input/job limits; no input token can grant filesystem or network authority.
2. Build a candidate semantic tree with stable node and source IDs. Decode images/fonts through the shared asset service, preserving original bytes and metadata.
3. Normalize supported authored properties while retaining units, rules, variable/component references and source locations. Keep unknown metadata bounded and inert.
4. Run semantic/dependency validation, compute required initial style/layout, and collect diagnostics by node/property/source location.
5. Commit through the same engine command path as a UI edit. A progressive foreign import creates a new incomplete document and publishes validated page groups. Native snapshot/package replacement validates the complete candidate and activates its root atomically with the required generation/ownership checks; it never publishes a half-replaced existing document. Follow the storage contract for both modes.
6. Return imported IDs, committed revision, profile and diagnostics. A successful import response is not a claim that every source feature was supported; strict fidelity mode fails on any required unsupported feature.

An implementation must provide both strict and diagnostic inspection modes. Tests pin the mode. Do not improve benchmark numbers by excluding unsupported nodes from counts or turning errors into unreported warnings.

### Visual edits preserve authored intent

| User action | Authored change |
| --- | --- |
| Reorder a child in flex/grid | Change placement/order or explicit cell assignment; retain layout mode |
| Edit a gap/padding | Change that property on its owning container/rule |
| Resize a fixed-size box | Set explicit width/height in the chosen units |
| Resize a fill/hug box | Use an explicit sizing-mode command; report any conversion to fixed sizing |
| Edit a token-linked value | Choose token edit, local override or detach; expose which operation occurred |
| Change a component instance | Store an override against stable definition IDs; do not rewrite the definition unintentionally |
| Remove auto layout/reparent | Preserve the requested world geometry by an explicit transform/constraint conversion |

Inspection returns authored value, computed value, source rule/token/override and viewport where relevant. Export uses authored relationships, not a collection of rectangles measured at one screen size. Round-trip acceptance includes 1440, 768 and 390 logical-pixel artboards, reorder, text replacement, token change and component override before export/reimport.

## 3. Incremental style, layout and components

Maintain reverse indexes for parent/child, style selector/ancestor dependency, token usage, font/text usage, component instance/definition and asset usage. A mutation produces a changed-entity/property set and conservative invalidation causes.

| Change | Minimum necessary invalidation |
| --- | --- |
| Pure camera pan/zoom | Visibility, scale-dependent resource choice and overlay; authored box layout remains valid |
| Leaf fill/opacity | Paint and affected compositing/ink bounds |
| Local translation | World transforms, spatial entries, old/new damage; parent layout only if authored flow constraints changed |
| Text or font metrics | Shaping/lines, intrinsic sizes and dependent ancestors/siblings |
| Container width/gap/flow | Its layout dependency closure and dependent child positions |
| Selector/ancestor/token | Indexed users plus inherited/style-dependent descendants |
| Component definition | Referencing instances and their affected overrides/derived descendants |
| Mask/backdrop/effect | Its full required paint/dependency group, including relevant backdrop |

Propagate intrinsic-size invalidation toward the nearest independently constrained ancestor; propagate changed constraints downward. Stop only when cached output and dependency fingerprints prove the next boundary unchanged. If the adapter cannot prove locality, schedule the conservative closure outside the input thread. Do not assume that an offscreen node has no layout effect.

Build deterministic tests that compare incremental results with a fresh uncached calculation after each mutation. Record visited nodes, layout calls and allocations, not only elapsed time. A leaf edit must not unconditionally clone a page index or rebuild every component instance.

Components remain definitions plus instances and override maps. Resolve a requested instance lazily using stable definition-relative IDs and cache the result by definition/override generations. Nested definitions have explicit dependency edges and cycle detection. Changed definitions invalidate all users logically without eagerly materializing every hidden page. An export or inspection loads the required closure and reports unresolved libraries; it cannot omit them because no view is open.

## 4. Text, fonts and native input

Use the canonical character/range model in [ENGINE_CONTRACTS.md](ENGINE_CONTRACTS.md). Text layout is derived from exact Unicode runs, paragraph styles, width constraints and a versioned font environment. Store grapheme/cluster mappings separately from UTF-16 API offsets. The cursor must not move into a surrogate pair or the middle of a user-visible cluster.

Font identity includes content hash, face index, variation axes and relevant feature settings. Font family names alone are insufficient. Resolve local/embedded fonts through an explicit ordered fallback policy and record every substitution. Keep font availability and layout generation in cache keys. Required outline conversion uses the actual supported face and reports unavailable/synthetic faces before changing the source.

Shape a paragraph into glyph/cluster runs with bidi order, compute line breaking from its constraints, and derive caret/selection geometry from those same runs. The renderer draws the supplied positions instead of independently remeasuring text. Export preserves those positions or uses the declared font/text representation; it cannot choose a second line-breaking algorithm.

Native controls and the canvas must support Korean IME, composition candidate placement, selection, clipboard, word/line navigation, RTL mixed with LTR, emoji, combining sequences and variable/fallback fonts. Place IME candidate windows in OS screen coordinates using the actual window scale/position. Preserve composition text on a conflicting remote delete as specified by the engine contract. Tests include two windows on displays with different DPI.

Expose an accessibility tree for the native controls and selected/visible design content. Labels, values, roles, focus and actions must identify the same stable entities as the engine. Avoid creating an accessibility object for every node in every unopened page; virtualized children must still be navigable on demand. Keyboard and screen-reader actions call semantic commands rather than mutating a widget's private copy.

## 5. Coordinates, scene and interaction

Use logical design pixels for authored geometry. Store affine transforms with an explicit convention: `[a,b,c,d,e,f]` maps a column point to `x' = a*x + c*y + e`, `y' = b*x + d*y + f`; a child's world transform is `parent_world * child_local`. Output pixels are `device_scale * camera * world * point`. Page origin, crop/export origin and selection overlay transforms are separate named inputs.

Hit testing inverts that same transformation chain. Singular transforms produce an explicit non-invertible result and safe fallback selection behavior, not NaNs. Use high-precision world calculations and a floating viewport/tile origin when converting to GPU coordinates. Validate large dimensions and scale against the backend's qualified range; do not silently clamp canonical geometry to make a draw succeed. Tests include rotated/flipped ancestors, fractional zoom, negative positions and high-DPI windows.

Paint order follows authored sibling placement and supported stacking contexts. Build a retained display list with explicit save/restore, transform, clip, mask, isolated group, primitive/text/image and effect operations. A display-list record refers to immutable resources and stable semantic IDs. Compute separate geometry, stroke and ink bounds; filters, shadows and masks can enlarge or constrain them.

Use spatial candidates followed by exact geometry/clip tests. Hidden or locked ancestors affect edit eligibility consistently across GUI and MCP. Hit-test ordering, snapping, marquee and keyboard traversal must match the declared visual/editor behavior in the capability matrix. An axis-aligned bounding box alone is not a correct hit test for a rotated path or masked child.

Damage is the union of old and new affected ink/dependency bounds. Culling removes safe paint work after layout dependencies are satisfied. Unknown filter/backdrop bounds use a conservative group fallback. Layer-tree and Assets panels virtualize rows/previews separately from scene culling. A hidden row is not a deleted entity or a missing export object.

### Gestures and remote edits

At pointer-down, capture the affected IDs, authored field versions, pointer origin and local gesture preview. Pointer moves update transient native state and dirty display data; they do not serialize a whole page or await disk/IPC each frame. Commit a semantic operation at the gesture boundary using those preconditions. Optional collaborative previews are ephemeral and coalesced.

If a remote edit changes an unrelated property, preserve it when committing. If it changes the gesture's required parent/transform/constraint basis, rebase only through a documented operation transform; otherwise cancel the stale commit, show the current state and retain a recoverable intended delta. Never overwrite a newer remote transform with the entire pointer-down snapshot. Escape cancels the preview without adding an Undo group; a successful gesture is one author-owned group.

## 6. Paths, appearance and effects

Retain editable path segments, contours, fill rule and handle modes. Boolean operations preserve ordered source operands and definition semantics; flatten/outline are explicit commands with source retention and Undo behavior from the capability matrix. Run expensive geometry outside the writer/input path, then verify source versions before installing the result. A failed boolean or missing-font outline leaves the sources unchanged.

Support the existing paint/stroke/gradient/image controls and mask/blend families individually. Keep source opacity separate from group opacity, and vector, alpha and luminance masks distinct. The [compositing reference](https://www.w3.org/TR/compositing-1/) defines the underlying group/blend vocabulary; implementation tests must cover nested groups and backdrop dependencies rather than comparing isolated rectangles only.

Color values retain declared color space and alpha. The standard comparison/export profile is sRGB with explicit premultiplied-alpha handling; converting wider-gamut content emits the configured color-conversion diagnostic and retains original authored color metadata. A Display-P3 output mode must declare its profile and pass separate color-managed tests before being advertised. Do not compare untagged screenshots from different displays as if their byte values were the same color measurement.

Decode resources at an appropriate scale and retain original bytes. Cache keys include hash, decode/color parameters and generation. Surface, texture and glyph allocations participate in the global budget even while GPU work is in flight. GPU device loss invalidates derived resources, preserves authored state and retries through a qualified backend or returns a precise rendering failure. It does not reopen the document in a hidden browser.

### Reviewed shader registry and motion

The exact dated 30-effect reference inventory and required coverage are in [CAPABILITY_MATRIX.md](CAPABILITY_MATRIX.md); the pinned source and license records are in [REFERENCE_PROJECTS.md](REFERENCE_PROJECTS.md). Port reviewed algorithms to the qualified native backend, initially Skia/SkSL where suitable. The browser mounting wrapper is not a native implementation.

An effect record has registry ID, algorithm version, typed parameters, resource hashes, seed and optional authored time/speed controls. Maintain parameter ranges/defaults and coordinate/color conventions per effect. Save and replicate these fields; compiled shader objects and wall-clock frames are derived. An unknown algorithm/version produces a diagnostic and explicit unsupported result in strict output mode. No arbitrary source string from a document is compiled/executed as trusted GPU or JavaScript code.

Playback uses a monotonic local presentation clock with explicit pause/seek/start-time controls. Rendering an export or MCP screenshot accepts an explicit time sample; it never depends on how many UI frames happened to be drawn. The baseline animated output is a numbered image sequence plus a manifest containing timestamps, dimensions, frame hashes and effect/profile versions. Compressed video is a separately qualified codec adapter. General website/prototype scripting and arbitrary third-party JS/Three.js/Lottie execution are outside this native profile.

Native effect tests use fixed seed, source images, resolution and uniforms, including time 0, 500 and 1000 ms for animated effects. Compare full-surface and tiled output, transparent edges, repeated export and pause/seek. Each effect declares its visual tolerance and maximum supported surface/parameter workload. A global image-similarity average cannot hide one missing effect or a clipped shadow.

## 7. Offscreen rendering and export

Every export request declares document/page or explicit nodes/region, revision, format, viewport/output dimensions, scale, time sample, color policy and font/resource policy. Human selection is not an implicit agent scope. An explicit capability query reports supported combinations and limits.

1. Pin the semantic revision and dependency manifest; acquire bounded resource/snapshot reservations.
2. Resolve required components, fonts, images and effects independently of visible UI. If a dependency is unavailable, fail strict output with its ID and cause rather than exporting a blank substitute.
3. Derive layout/scene using the shared libraries and output profile. Plan render groups/tiles respecting effect and backdrop dependencies.
4. Render to a temporary destination. Raster tiles include sufficient effect halos, then crop to their inner output regions. If a filter cannot be tiled equivalently under its bounds, reserve a valid full group or return `resource_limit`; silently cutting its blur is forbidden.
5. Encode and verify the requested output; atomically publish the file/result manifest. Preserve an existing destination unless explicit overwrite was authorized. Cancellation before publication removes the partial output; completed output remains addressable through job status.
6. Release pins, temporary resources and GPU fences. Return produced revision, dimensions, profile, diagnostics and hash/path/resource reference as applicable.

| Output | Required representation and fidelity rule |
| --- | --- |
| Native portable document | Complete editable authored state, required resources, version/identity/retention metadata and checksums; independently verified open |
| HTML/CSS | Meaningful semantic elements/layout, authored units/tokens/rules, supported rich text, stable source mapping and local asset references |
| Static React CSS/Tailwind | Deterministic static component/tree output; retain constraints and tokens; escaping and unsupported-code diagnostics; no claim to reconstruct application logic |
| SVG | Editable supported vectors/text/images; explicit font policy; rasterize unsupported vector effect regions only under a declared policy with diagnostics |
| PDF | Declared page geometry/units, resource/font policy and matching layout; report any text/effect conversion |
| PNG/JPEG/WebP | Declared dimensions/scale/alpha/color handling; complete requested region; lossy encoding settings explicit |
| Animation sequence | Complete requested frame/time range and manifest; no silently skipped frame |

Keep a stable export map from design IDs to emitted source elements/components where the output can carry it. Reimport uses that map only in an explicit update mode with identity/precondition checks; a normal copy import generates independent identities. Escaping, normalized property order and deterministic asset naming must produce reproducible code for unchanged input. Export warnings identify the exact node/property and chosen fallback.

## 8. FIG, Sketch, SVG and legacy migration

The current independently authored importer in [design-file.ts](../../editor/formats/design-file.ts), [format evidence](../DESIGN_FILE_IMPORT.md) and [real fixture manifest](../../fixtures/design-files/README.md) are implementation inputs. Port documented behavior and independently licensed algorithms; do not claim the entire source format is specified merely because the existing decoder imports the fixture.

Split native work into archive validation/decompression, source graph decode, reference/index construction, semantic conversion, asset ingestion, page/shard publication and layout. Measure each phase. Shared source graph work may precede any complete page; bounded worker execution preserves input responsiveness but does not make that cost disappear. Spill/index intermediate data when valid, or reject a source that cannot fit the declared safe reservation.

Retain source IDs and explicit mappings for nodes, component definitions/instances, overrides/variants, variables, transforms, paths, mixed text, font identities, masks, blends and effects. The conversion report distinguishes exact supported mapping, declared approximation, retained unknown metadata and rejected feature. A design with unsupported component semantics cannot pass the component round-trip gate just because its visible children were copied.

The destination's independently loadable native representation is separate from the original archive. Saving an edited loaded page uses the native store and cannot require reparsing the foreign file. A cached image/preview is never authoritative editable content. Preserve incomplete-import state and already committed page identities on cancellation/restart; do not advertise an interrupted document as fully imported.

Legacy OMC migration follows [STORAGE_AND_COLLABORATION.md](STORAGE_AND_COLLABORATION.md). Keep source-format readers explicit, preserve recoverable originals and test both identity-preserving and independent-copy behavior. The first native writer must not emit an old format/version identifier for a new incompatible encoding.

## 9. Diagnostics and acceptance cases

Every conversion/layout/render diagnostic has a stable code, severity, source/node/property location, original construct, implemented action and whether strict fidelity was lost. Resource/font diagnostics include identity and readiness without embedding private file contents. Surface diagnostics consistently in GUI import results, MCP structured output and exported manifests.

| Case | Required observation |
| --- | --- |
| HTML responsive round trip | Width changes, gap edit, token edit and reorder preserve the intended constraints and stable update mapping |
| Nested masks/effects | Correct compositing/ink bounds across screen, offscreen, tiles and export; no culling loss |
| Rich text/font change | Same line metrics, selection/hit geometry and export positions for the pinned font/profile; substitutions visible |
| Component update | Existing instance overrides remain distinct; hidden-page users update on demand; complete export resolves them |
| Gesture plus remote move | Conflict or documented rebase without stale-snapshot overwrite; one correct Undo group |
| Huge export under pressure | Other documents remain interactive; complete result or explicit limit/cancellation, never truncated successful output |
| Native shader animation | Saved/replicated parameters reproduce each sampled frame and image-sequence manifest |
| Legacy/foreign import | Supported semantics and hashes survive reopen; approximation/unsupported source cases remain visible |
| Native input/accessibility | Keyboard, IME and accessibility actions target the same semantic IDs on every qualified platform |

Use the full [qualification protocol](QUALIFICATION.md), including uncached/incremental comparisons and per-feature visual tolerances. Initial same-profile geometry tolerance is 0.25 logical pixels; flat-interior 8-bit channel tolerance is 2/255. Edge antialiasing, color management, text hinting and shader floating-point differences require separately declared tolerances and semantic checks. A broad image score cannot turn a missing line, mask, glyph, layer or resource into PASS.
