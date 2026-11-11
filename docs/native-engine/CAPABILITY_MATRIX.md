# Native capability and workflow matrix

[Native overview](../NATIVE_ENGINE_PLAN.md) · [Implementation guide](IMPLEMENTATION_GUIDE.md) · [Engine contracts](ENGINE_CONTRACTS.md) · [Reference projects](REFERENCE_PROJECTS.md) · [Qualification](QUALIFICATION.md)

**Inventory date:** 2026-11-11.  
**Pinned current application:** [71ca902d8a0903b8aae87a7a61b8231147b848f0](https://github.com/Dindb-dong/oh-my-canvas/tree/71ca902d8a0903b8aae87a7a61b8231147b848f0), the documentation checkpoint following PR #13.  
**Native status:** every native row below is planned and unqualified. This document establishes a denominator; it does not report a native implementation or a successful migration.

## 1. Status, evidence and ownership

The three evidence classes are deliberately separate:

| Label | Meaning |
| --- | --- |
| Current implementation | A current Oh My Canvas schema/adapter or documented behavior exists at the pinned revision. This documentation change has not rerun its runtime tests. Known limitations remain part of the current observation. |
| Native required | Required behavior in the accepted native product. Its initial status is NOT_RUN, even where current JavaScript code implements a similar feature. |
| External reference | A dated Paper product/documentation claim, not an Oh My Canvas capability or a native test result. Source conflicts are recorded below. |

A declaration in tools/list proves discovery, not correct execution. Each MCP row needs a successful call, a bounded invalid-input case, the appropriate persisted/readback assertion and its attribution/cancellation behavior. Each supported action and enum variant is a separate subcase. A family cannot receive PASS by exercising only its first action. Current numerical limits are compatibility inputs; native changes follow the versioned contracts rather than silently changing an existing schema.

Owners below are implementation responsibilities, not assigned people:

| Owner | Owns implementation and candidate evidence |
| --- | --- |
| Workspace | Catalog, documents, folders, lifetimes, preferences and job routing |
| Core | Canonical commands, geometry, page structure, dependency validation and author Undo |
| Agent | MCP discovery/schema adapters, targeting, errors, idempotency and real-transport tests |
| Layout | Authored/computed style, constraints, HTML/CSS semantics and layout |
| Text | Rich text, shaping, offsets, composition, text collaboration and caret/selection |
| Render | Native display lists, effects, screen/offscreen output and resource accounting |
| Assets | Original assets, fonts, image operations and content references |
| Interchange | HTML/SVG/FIG/Sketch/snapshot conversion, portable files and code export |
| Storage | Recoverable commit, migration, restart and retained-state correctness |
| Collaboration | Four-peer merge, presence, cross-shard publication, reconnect and history |
| Desktop | Native controls, input, accessibility, dialogs and packaged platforms |
| QA | Independent reproduction, evidence completeness and release-gate adjudication |

The implementation owner supplies evidence; QA verifies it. An evidence record has a stable case ID, tested commit/build, fixture hashes, operation arguments, expected result, actual result, revision/readback and artifact references. Empty evidence references mean NOT_RUN, not PASS. [Qualification](QUALIFICATION.md#evidence-status-and-release-decisions) defines PASS, FAIL, INCOMPLETE and NOT_RUN.

## 2. Pinned sources and current boundaries

- **C1:** [Editor and workspace tool declarations](https://github.com/Dindb-dong/oh-my-canvas/blob/71ca902d8a0903b8aae87a7a61b8231147b848f0/editor/mcp/defs.ts).
- **C2:** [Automation tool declarations and action enums](https://github.com/Dindb-dong/oh-my-canvas/blob/71ca902d8a0903b8aae87a7a61b8231147b848f0/editor/mcp/automation-defs.ts).
- **C3:** [Current MCP capability map](https://github.com/Dindb-dong/oh-my-canvas/blob/71ca902d8a0903b8aae87a7a61b8231147b848f0/docs/MCP_PARITY.md) and [transport/recovery contract](https://github.com/Dindb-dong/oh-my-canvas/blob/71ca902d8a0903b8aae87a7a61b8231147b848f0/docs/MCP.md).
- **C4:** [Editor command dispatch](https://github.com/Dindb-dong/oh-my-canvas/blob/71ca902d8a0903b8aae87a7a61b8231147b848f0/editor/mcp/index.ts), [semantic operations](https://github.com/Dindb-dong/oh-my-canvas/blob/71ca902d8a0903b8aae87a7a61b8231147b848f0/editor/mcp/operations.ts) and [workspace adapters](https://github.com/Dindb-dong/oh-my-canvas/blob/71ca902d8a0903b8aae87a7a61b8231147b848f0/electron/workspace-tools.mjs).
- **C5:** [Source-observed feature inventory](https://github.com/Dindb-dong/oh-my-canvas/blob/71ca902d8a0903b8aae87a7a61b8231147b848f0/docs/independent/behavior-contract.md). This is a historical discovery source, not current capacity/protocol authority or fresh parity evidence.
- **C6:** [Current large-document behavior and limitations](https://github.com/Dindb-dong/oh-my-canvas/blob/71ca902d8a0903b8aae87a7a61b8231147b848f0/docs/DESIGN_FILE_IMPORT.md) and [PR #13 measurements](https://github.com/Dindb-dong/oh-my-canvas/blob/71ca902d8a0903b8aae87a7a61b8231147b848f0/docs/qa/pr13-large-document-evaluation.json).
- **C7:** [Current native property schema](https://github.com/Dindb-dong/oh-my-canvas/blob/71ca902d8a0903b8aae87a7a61b8231147b848f0/editor/mcp/properties.ts), [commands](https://github.com/Dindb-dong/oh-my-canvas/blob/71ca902d8a0903b8aae87a7a61b8231147b848f0/editor/commands/index.ts), [UI](https://github.com/Dindb-dong/oh-my-canvas/blob/71ca902d8a0903b8aae87a7a61b8231147b848f0/editor/ui/index.ts) and [text editing](https://github.com/Dindb-dong/oh-my-canvas/blob/71ca902d8a0903b8aae87a7a61b8231147b848f0/editor/interaction/text.ts).
- **C8:** [Current importer](https://github.com/Dindb-dong/oh-my-canvas/blob/71ca902d8a0903b8aae87a7a61b8231147b848f0/editor/formats/design-file.ts), [HTML conversion](https://github.com/Dindb-dong/oh-my-canvas/blob/71ca902d8a0903b8aae87a7a61b8231147b848f0/editor/formats/html.ts) and [export services](https://github.com/Dindb-dong/oh-my-canvas/blob/71ca902d8a0903b8aae87a7a61b8231147b848f0/editor/export/index.ts).

C1 defines 26 editor tools and five workspace tools. C2 adds 11 editor and eight workspace tools: **37 editor + 13 workspace = 50 distinct current tool names**. The following IDs remain stable even if rows are reordered. New extension tools receive new IDs; they do not renumber or silently replace this catalog.

## 3. Exact current MCP catalog and native obligations

All rows are current exposed contracts from C1/C2, with implementation locations C4. All native statuses are NOT_RUN. Evidence identifiers are MC followed by the row ID, for example MC-MCP-01. Successful write cases additionally run the applicable correctness cases in [Qualification](QUALIFICATION.md#correctness-case-registry).

### 3.1 Inspection, original editing and component tools: C1

| ID | Current tool | Capability and required action coverage | Native exit assertion | Owner |
| --- | --- | --- | --- | --- |
| MCP-01 | get_context | Document/page identity, revision, viewport, selection and boards | Explicit background document returns its own generation/revision without changing GUI focus; no GUI is required | Agent + Core |
| MCP-02 | select_page | Page selection by raw page ID | Session page changes; stale page aliases and queued page writes reject; unrelated sessions remain usable | Agent + Core |
| MCP-03 | get_tree | Ordered hierarchy; concise/detailed; depth and truncation | Stable IDs/order and requested fields agree with canonical snapshot; bounded output declares truncation | Agent + Core |
| MCP-04 | get_html | Editable HTML for a layer | Images and semantic layout survive export/reimport; output identifies source revision and supported conversion losses | Interchange + Layout |
| MCP-05 | get_styles | Computed CSS, requested keys, multiple IDs | Computed results agree with layout; native provenance extension identifies authored rule/token rather than fabricating browser values | Layout + Agent |
| MCP-06 | find | Text, kind, name and subtree filters | Bounded matches agree with canonical content, including unloaded-page scope/completeness when requested by the native version | Agent + Core |
| MCP-07 | screenshot | Layer/page; overview and numbered slice | Native offscreen output uses pinned document/page/region/revision and font readiness; no hidden window or browser | Render + Agent |
| MCP-08 | write_html | Before/after/first/last/replace insertion | Supported HTML creates editable stable nodes; malformed/unsupported input follows diagnostics policy; replace is atomic | Interchange + Core |
| MCP-09 | write_svg | Editable SVG insertion and supported picture preservation | Editable geometry remains editable; preserved unsupported content is identified; no partial insertion on failure | Interchange + Render |
| MCP-10 | get_path | World-space cubic segments, node indices and revision | Geometry and handle metadata match renderer/hit tests; returned revision protects subsequent editing | Core + Agent |
| MCP-11 | edit_path | move_nodes, insert_node, delete_nodes, set_handle, convert_node, close, open, join, merge, primitive | Every action covers open/multiple contours and stale-index rejection; polygon/star regeneration retains valid geometry | Core |
| MCP-12 | boolean | union, subtract, intersect, exclude, flatten | Operand order, hidden source preservation and editable result match the command contract; asynchronous stale work cannot commit | Core + Render |
| MCP-13 | outline | stroke and text | Actual font/stroke constraints checked before commit; source retained; native outline and Undo preserve supported appearance | Core + Text |
| MCP-14 | image | remove_background and restore | Local image operation preserves original/hash, cancellation and author Undo; optional model availability is explicit | Assets |
| MCP-15 | update | CSS declarations, text and supported attributes; property removal | Changes retain authored semantics and identity; invalid value rollback; explicit policy for stale or unsupported input | Layout + Core |
| MCP-16 | move | Before/after/first/last reparent/reorder | Parent/rank update preserves declared geometry/layout intent and rejects cycles/locked ancestors | Core |
| MCP-17 | duplicate | Subtree copy and relative placement | Fresh IDs and correctly remapped internal references; independent copy survives save/reopen and collaboration | Core |
| MCP-18 | delete | Bounded multi-layer removal with descendants | Atomic deletion, reference repair and author Undo retain foreign edits/resources required by history | Core + Storage |
| MCP-19 | batch | Every allowed synchronous write and late-operation failure | One bounded semantic transaction and author group; failed final item publishes nothing; unsupported async jobs reject | Core + Agent |
| MCP-20 | create_board | Width, optional height/name, placement and content sizing | Correct board placement and hug sizing using native layout; semantic HTML export retains flow | Layout + Core |
| MCP-21 | assets | Configured local/optional provider search; brand/upload/stock filters | Unconfigured provider returns explicit empty/unavailable result; no invented stock records or required hosted service | Assets + Agent |
| MCP-22 | get_guide | html, layout, text, review, components, vector, image, workspace | Returned guides match native build/schema/capability limits; retired DOM instructions do not remain operational advice | Agent |
| MCP-23 | undo | Agent-owned latest eligible operation | Undo never consumes another author/group; cross-page and text effects satisfy selective Undo cases | Core + Collaboration |
| MCP-24 | components | Search and paginated component listing | Results include stable definition IDs, correct availability and explicit pagination across unloaded dependencies | Core |
| MCP-25 | component | create, add_variant, combine, instance, variant, property, edit_property, remove_property, bind, set_property, reset, detach, axes | Each action covers nested instances, source/override distinction, typed bindings and invalid ownership rollback | Core + Layout |
| MCP-26 | fonts | Family catalog and filtered lookup | Native catalog identifies actual faces/availability; fallback and imported font provenance are available separately | Text + Assets |

### 3.2 Additional editor tools: C2

| ID | Current tool | Capability and required action coverage | Native exit assertion | Owner |
| --- | --- | --- | --- | --- |
| MCP-27 | page | list, create, rename, duplicate, delete, reorder, update guides | At least one page retained; copies remap identities; loaded-page save does not wait for unrelated restore | Core + Storage |
| MCP-28 | create_shape | frame, group, rect, ellipse, polygon, star, line, arrow, pencil, pen, path, text, image, svg | Every type is editable, inspectable, persisted and exported; canonical geometry validates before publication | Core |
| MCP-29 | edit_shapes | patch, group, ungroup, frame, mask, unmask, align, distribute, tidy, order, flip, translate, resize, rotate, layout | Every action and C7 supported property has a valid and invalid/locked case; no hidden human-selection dependency | Core + Layout |
| MCP-30 | edit_text | replace, range_style, paragraph_style, find_replace | UTF-16 API boundary, unaffected runs, concurrent character/range behavior, IME anchors and Undo satisfy native text contract | Text + Collaboration |
| MCP-31 | styles | list, get, create, update, duplicate, delete, apply, detach, users | Paint/text/effect style users update across pages; detachment preserves value; shared and local edits remain distinct | Layout + Core |
| MCP-32 | libraries | list, get, add, update, enable, remove, insert, export | Offline snapshots persist; compatible update retains overrides; disabled/unlinked library behavior is explicit | Core + Interchange |
| MCP-33 | document_assets | list, add, remove, place; image/SVG/font | Asset reference publication follows verified persistence; collisions/removal/Undo do not lose referenced bytes | Assets + Storage |
| MCP-34 | clipboard | copy, cut, paste, copy_properties, paste_properties; normal/in_place/replace modes and explicit placement coordinates | Agent-private payloads and cross-document ID remapping work; no unintended system clipboard read | Core + Assets |
| MCP-35 | view | get, set, select, tool, fit; viewport/display flags | Headless view state is an explicit session/view resource; GUI selection/focus is changed only by targeted view intent | Desktop + Agent |
| MCP-36 | export_selection | svg, png, jpg, webp, pdf, json, html; scale/bounds/quality | Same canonical revision and native text layout; culling never omits requested content; output limits explicit | Render + Interchange |
| MCP-37 | redo | Agent-owned redo | Does not replay another author's history or restore obsolete whole-page state; invalidated redo is explicit | Core + Collaboration |

### 3.3 Workspace tools: C1 and C2

| ID | Current tool | Capability and required action coverage | Native exit assertion | Owner |
| --- | --- | --- | --- | --- |
| MCP-38 | list_documents | Search, starred filter, sort, offset and limit | Metadata listing does not materialize every heavy document; stable IDs and bounded pagination | Workspace |
| MCP-39 | open_document | Bind existing document; focus false/true | Independent leases and background open; early usable page has authoritative dependencies; no selected-tab routing | Workspace + Storage |
| MCP-40 | create_document | Blank or sample; title/focus | Creates a durable independent identity with correct ownership; headless creation succeeds | Workspace + Storage |
| MCP-41 | rename_document | Explicit ID and validated title | Catalog update without unrelated document loading or view switch; durable readback | Workspace + Storage |
| MCP-42 | duplicate_document | Flush/copy/bind, optional title/focus | Independent new identity and complete required resources; failure retains original; clear heavy-job progress | Workspace + Interchange |
| MCP-43 | workspace | state, focus, close, show_library, connection, about, window, quit, capabilities, sample_color | Capability subresults expose actual platform/headless availability; close releases only intended owner; quit observes durability | Workspace + Desktop |
| MCP-44 | preferences | get/set display name, view, document favorite | Profile/catalog changes persist, remain outside layer Undo and do not expose credentials | Workspace |
| MCP-45 | save_document | Flush explicit document | Response maps to verified recoverable commit; peer staging or preview is never reported as saved | Storage + Agent |
| MCP-46 | delete_document | Explicit ID and expectedTitle | Refuses in-use/owned/pending document; mismatch is nonmutating; races cannot delete a newly rebound document | Workspace + Storage |
| MCP-47 | import_document | OMC/JSON/FIG/Sketch; merge/copy; payload/filePath/focus | Native job reports phase/completeness and source losses; legacy identity choice explicit; original never overwritten implicitly | Interchange + Storage |
| MCP-48 | export_document | OMC/JSON/SVG/PNG/JPG/WebP/PDF/HTML; output file/payload | Coherent full scope despite eviction; existing file protection and atomic final output; no complete label for partial import | Interchange + Storage |
| MCP-49 | import_resource | Local image/SVG/font/library file | Bounded typed file access, actual content validation, hash persistence and explicit asset placement | Assets + Interchange |
| MCP-50 | collaboration | status, host, invite, join, leave, cursor | Four active clients, version compatibility, bounded asset transfer, presence and reconnect; no GUI requirement | Collaboration + Agent |

Tool-specific enum lists above come from the pinned schemas, not a new protocol definition. In particular current clipboard modes are validated against C2, and workspace window control uses the declared position/display/fullscreen/visibility/devTools fields and reported platform capabilities. Future jobs, comments, folders, tokens and motion controls use negotiated additive/versioned extensions defined in [Engine contracts](ENGINE_CONTRACTS.md); they are not falsely counted among these 50 tools.

### 3.4 Machine-readable catalog denominator

The JSON below is valid registry data for a future coverage checker. It is not an implemented native API response. The two arrays must contain exactly the declared 37/13 names, with no duplicates or omissions; each must map to one table ID above.

~~~json
{
  "registry_version": "native-capabilities/1",
  "reference_revision": "71ca902d8a0903b8aae87a7a61b8231147b848f0",
  "native_status": "NOT_RUN",
  "editor_tools": [
    "get_context", "select_page", "get_tree", "get_html", "get_styles", "find",
    "screenshot", "write_html", "write_svg", "get_path", "edit_path", "boolean",
    "outline", "image", "update", "move", "duplicate", "delete", "batch",
    "create_board", "assets", "get_guide", "undo", "components", "component",
    "fonts", "page", "create_shape", "edit_shapes", "edit_text", "styles",
    "libraries", "document_assets", "clipboard", "view", "export_selection", "redo"
  ],
  "workspace_tools": [
    "list_documents", "open_document", "create_document", "rename_document",
    "duplicate_document", "workspace", "preferences", "save_document",
    "delete_document", "import_document", "export_document", "import_resource",
    "collaboration"
  ],
  "required_evidence_per_tool": [
    "discovery", "valid_action_cases", "invalid_nonmutation",
    "targeting_and_revision", "persistence_if_mutating",
    "author_undo_if_content_mutating", "headless_result", "bounded_output"
  ],
  "native_evidence": []
}
~~~

## 4. Desktop and document feature denominator

Every listed subfeature is required unless a row explicitly identifies a platform adaptation or an external integration. A row's evidence must list each subfeature separately; a single family-level screenshot cannot pass it. C5 supplies historical discovery detail; C7/C8 and C3 resolve current supported properties and stale limits. C5's old byte budgets and transport descriptions are not copied into the native contract.

| ID | Required subfeatures and behavior | Current observation | Native evidence and owner |
| --- | --- | --- | --- |
| UI-01 | Library listing/search/favorites/sort; blank/sample create; rename/duplicate; tab/window open/focus/close; independent session owners; saved quit | Existing workspace/MCP adapters; native absent | W2/W5; MCP-38..46; Workspace + Desktop |
| UI-02 | Move, frame, rect, ellipse, polygon, star, line, arrow, pencil, pen, text tools; last-tool choice; drag preview/cancel; no ghost shapes | Current drawing/command families C5/C7 | One draw/edit/cancel/export case per tool; Core + Desktop |
| UI-03 | Hover/handles; click, marquee, multiple selection; all/none/inverse/children/parent/sibling/matching; locked/hidden ancestor rules | Current C5/C7 | Occluded/nested/locked scenes, keyboard and pointer selection agree; Core + Desktop |
| UI-04 | Wheel/space pan, anchored zoom, fit all/selection, 100%, next/previous board/page; remembered per-page camera; resize/HiDPI; touch pan/pinch where platform supports it | Current viewport family; platform tests scoped | W1/W2 camera and coordinate oracle; Desktop + Render |
| UI-05 | Group/ungroup/frame; reparent/order; align/distribute/tidy; flip/rotate/resize; rename/lock/hide; duplicate/delete | Current commands and MCP-16..18/29 | Nested transforms and layout intent, source restoration after Undo; Core |
| UI-06 | Layer tree expand/collapse, drag reorder/nesting, inline rename, filters; pages CRUD/reorder; virtualized lists; hidden content remains addressable | Current editor panels; baseline does not implement new folder/comment families | W2 tree responsiveness and canonical readback; Desktop |
| UI-07 | Flex direction/wrap/justify/cross/baseline/align-content; gaps/per-side padding; fixed/hug/fill and min/max; absolute children; nested layout | Current design layout, not full browser CSS parity | UI edit/MCP edit/export/reimport at three widths; Layout |
| UI-08 | Grid tracks, row/column gaps, cells/spans/alignment; responsive sizing; constraint left/right/both/center/scale and vertical counterparts | Current design grid/constraints; native CSS semantics must be separately qualified | Intrinsic text/image + nested-grid fixture and exported behavior; Layout |
| UI-09 | Ordered multiple fills/strokes; solid and supported gradient types/stops/opacity; image fill; individual radii/smoothing; per-side strokes; cap/join/dash/alignment/end decorations | Current property schema C7 | Every admitted paint/stroke enum and property round-trip; Render + Core |
| UI-10 | Opacity, every admitted blend mode, drop/inner shadow, layer/background blur; hidden/disabled effects; effect order and oversized surfaces | Current DOM/SVG implementation with documented fallback costs | Effect dependency/occlusion cases, screen/offscreen parity, budget limits; Render |
| UI-11 | Alpha/vector/luminance masks; mask source paint semantics; clipping frames and legacy rectangular clips; nested transforms | Current feature family; FIG mapping incomplete | Mask-specific structural and pixel assertions with hidden sources; Render + Interchange |
| UI-12 | Open/closed straight/cubic paths; multiple contours; node selection/move/insert/delete; handles and modes; join/merge; primitive polygon/star regeneration; snapping | Current vector commands C1/C7 | Each MCP-10/11 action plus pointer equivalent and stale rejection; Core |
| UI-13 | Non-destructive booleans; ordered subtraction; flatten with retained sources; supported stroke/text outlines; clear unsupported-case rejection | Current CanvasKit geometry helpers and fontkit outline path | Native geometry comparisons, editable output and one author Undo; Core + Text |
| UI-14 | Rich spans/paragraphs; bold/italic/underline; highlight; lists/nesting/indent/spacing; range formatting; find/replace; truncate/max lines; fixed/auto text sizing | Current rich text editing; current collaborative content is atomic | CQ-TEXT cases; Text |
| UI-15 | Family/face/weight/size/features/variations; line/letter spacing; horizontal/vertical alignment; case/decoration; CJK wrapping; actual face and fallback diagnostics | Current browser text layout; full native stack planned | Pinned-font multilingual corpus, caret/line/export agreement; Text |
| UI-16 | Native Korean IME preedit/commit/cancel; composition selection; dead keys; emoji/combining text; bidi navigation; clipboard; focus and scroll caret visibility | Current DOM composition path; no native evidence | macOS, Windows, Linux OS-input journeys and CQ-TEXT-03; Text + Desktop |
| UI-17 | Character/range same-text coediting; concurrent formatting; relative cursors/composition anchors; author-specific text Undo | Current atomic text is not this capability | Four peers retain concurrent inserts and independent marks; CQ-TEXT-01..04; Text + Collaboration |
| UI-18 | Local paint/text/effect shared styles; groups/names/descriptions; apply/detach/users; independent run references; mixed-value inspector | Current MCP-31 and style service | Cross-page users, deletion/detachment and concurrent independent edits; Layout + Core |
| UI-19 | Components, nested instances, source mappings, overrides/reset/detach; source updates; instance spatial move; property ownership | Current component service and MCP-24/25 | Existing library plus targeted nested override fixture after cold reopen; Core |
| UI-20 | Variant sets/axes; add/combine/switch; text/boolean/swap typed properties; binding/edit/remove; main descendant ownership | Current component property schema | Every MCP-25 action, failed mutation rollback and grouped Undo; Core |
| UI-21 | Linked component/style snapshots; version/enable/update/unlink; offline render; override-preserving update; snapshot import/export | Current MCP-32; no required hosted library service | Offline and newer-library update with missing dependency diagnostics; Core + Interchange |
| UI-22 | Image fill/fit/contain/cover/crop/tile, color adjustments; local background removal/restore; original retention; multiple local file placement | Current assets/image service; model availability remains explicit | Original hashes, crop geometry, cancel and Undo; Assets |
| UI-23 | Font/image/SVG asset add/list/place/remove; asset collisions and hashing; font picker/search/recent/fallback; optional provider absence | Current local resources; no paid provider supplied | MC-MCP-21/26/33/49; resources retained through eviction/history; Assets |
| UI-24 | Native cut/copy/paste in place/here/replace; property transfer; cross-document remapping; SVG/raster/plain text ingress | Current private-agent and UI clipboard contracts | UI clipboard is explicit; agent clipboard remains private; Core + Desktop |
| UI-25 | Page/frame guides, square/column/row grids, snapping and pixel/grid toggles; ruler drag/move/remove; export excludes editor overlays | Current design guidance family | Native snapping/hit coordinate oracle and clean export; Core + Desktop |
| UI-26 | PNG/JPG/WebP/SVG/PDF/HTML/JSON export, per-layer presets/suffix/scale/fixed width/height, copy PNG/SVG, complete portable OMC | Current export families; current formats have their own limitations | Format-specific artifact decode + semantics/content checks, not extension-only checks; Interchange + Render |
| UI-27 | HTML/CSS semantic input/inspection/visual edit/export/reimport; stable IDs, tokens, responsive rules, source/computed-style provenance | Current inline-style conversion is narrower; native authored CSS is a required extension | RT-01..08 below and W7; Layout + Interchange |
| UI-28 | FIG/Sketch source semantics: components/instances/overrides, variables, effects, masks, mixed text, transforms, booleans, blend modes, fonts | Current C8 explicitly loses several of these | Structural + source-frame oracle per feature; unsupported required cases block parity; Interchange |
| UI-29 | Legacy OMC readers and identity/copy modes; new working files; progressive import; partial residency; meaningful loading/incomplete states | Current progressive cache and monolithic Y.Doc differ from native target | W1/W4/W7; CQ-DUR/CQ-MIG/CQ-LOAD; Storage |
| UI-30 | Four-user presence/cursors, meaningful concurrent edits, author Undo/Redo, disconnect/rejoin, slow peers and host-loss behavior | Current collaboration exists; heavy four-peer native qualification pending | W3/W4 with all clients active and source convergence; Collaboration |
| UI-31 | Menus, context actions, quick-action search/hints, shortcuts, numeric scrub/increment, mixed inspectors, narrow-window panels and focus cleanup | Current desktop/DOM affordances | Native workflows with keyboard only plus pointer; avoid shortcut hijacking text input; Desktop |
| UI-32 | Accessibility tree, roles/names/actions, focus/selection, text offsets/caret/IME state and screen-reader navigation | Existing DOM labels are not native accessibility qualification | VoiceOver/NVDA/Orca journeys and platform accessibility inspection; Desktop + Text |
| UI-33 | Native file dialogs, drag/drop, system clipboard, menus, color sampling, window controls and supported unavailable states | Current Electron integration; OS restrictions remain | Clean installed package per OS, permission-denial cases and headless capability reporting; Desktop |
| UI-34 | Workspace-wide resource ceilings, independent document work, cancellable background jobs, headless GUI-free inspection/render/export | Current performance limits C6; final native architecture is new | W2/W3/W5/W6 and dependency inspection; Workspace + Render + QA |
| UI-35 | Folders/subfolders, move/archive/restore and agent operations; comments/threads/resolve with stable anchors and author attribution | New local-equivalent product families, absent from current 50-tool catalog | Versioned extensions + persistence/collaboration/Undo-domain assertions; Workspace + Collaboration |
| UI-36 | Built-in reviewed shader/effect registry, editable parameters, native deterministic time sampling/playback and frozen-time export | New native requirement; no arbitrary browser or script renderer | Fixed-seed/time output, resource limit and remote parameter convergence; Render |
| UI-37 | Editable captured-page/snapshot package ingestion; static React CSS and Tailwind export; local semantic token management | New or expanded native requirements | Agent-to-edit-to-code round-trip with no required browser runtime; Interchange + Layout |

## 5. Dated Paper replacement workflow inventory

This is the agreed **local design-and-agent replacement inventory**, not a claim that all Paper cloud services or all future roadmap ideas are already implemented. Native-required rows below cannot be silently excluded to call the replacement complete.

External evidence checked on 2026-11-11: [MCP documentation](https://paper.design/docs/mcp), [HTML paste](https://paper.design/docs/paste/html), [tokens](https://paper.design/docs/tokens), [build log](https://paper.design/build-log), [roadmap](https://paper.design/roadmap), [SVG editing](https://paper.design/docs/svg) and [Figma paste](https://paper.design/docs/paste/figma).

**Source conflict:** the HTML paste page still contains a no-rich-text statement, while the dated October 2026 build log announces rich text. Use the build log to establish product availability and keep paste-translation behavior a separate test. The older MCP selected-file wording also does not override the August multi-file/background-agent release entry. Source pages are evidence of claims; native parity still requires our own cases.

| ID | Workflow | External evidence scope | Native disposition and required evidence |
| --- | --- | --- | --- |
| PAPER-01 | Agent writes HTML, inspects hierarchy/styles/screenshots and edits meaningful layers | Official MCP and paste workflows | REQUIRED; MCP-01..09/15/19, UI-27, RT-01..08; offline headless and GUI produce equivalent semantics |
| PAPER-02 | Design-to-code and code-to-design loop | Official MCP guide; build log describes React CSS/Tailwind copy | REQUIRED; editable HTML/CSS plus static React CSS/Tailwind export with token/layout references; no promise to reconstruct arbitrary application logic |
| PAPER-03 | Typography and rich text edited by a person or agent | October 2026 build log | REQUIRED; UI-14..17; native final includes character/range coediting beyond a single atomic text property |
| PAPER-04 | Reusable CSS tokens shared with source code | Token documentation and dated UI release entry | REQUIRED; create/update/apply/detach/copy tokens; preserve references and provenance across layout/export/collaboration |
| PAPER-05 | Multiple files/tabs and background agents; file/folder operations | August/October 2026 build-log entries | REQUIRED; UI-01/34/35 plus W2/W5; local folders/archive are additive capabilities, not implied by current list_documents |
| PAPER-06 | Comments and resolution during collaborative work | August 2026 build log | REQUIRED local equivalent; stable node/range or page-region anchors, thread/resolve state, author attribution, agent operations and offline merge |
| PAPER-07 | SVG/path editing and FIG design ingestion | Official SVG/Figma docs | REQUIRED; UI-12/13/28; native target retains existing local capabilities even where Paper documents import losses |
| PAPER-08 | Web content capture becomes editable design | Official Snapshot workflow and roadmap | REQUIRED semantic snapshot-package importer; browser capture extension is an OPTIONAL external producer, never a hidden layout/screenshot runtime in the native app |
| PAPER-09 | Shader/effect assets with controllable motion | Official shader ecosystem/build-log entries; not proof of a general prototype engine | REQUIRED native built-in reviewed registry, parameters, deterministic time/playback and still/frame-sequence output; no copied unlicensed shader implementation |
| PAPER-10 | Frame and document export | Current local export set and external code/PDF workflow | REQUIRED UI-26/37; animated encoders have an explicit capability state below, not a fake static result named MP4 |
| PAPER-11 | Images supplied/generated by agents and real-data refresh | Official MCP workflow | ADAPTED: agents may import permitted bytes or update semantic data through MCP. No paid/cloud image model, credentials or hosted account is required by this product |
| PAPER-12 | Local collaboration with people and agents | Accepted product requirement; reference team collaboration is not a network-topology promise | REQUIRED four active peers and distinct agent authors under W3/W4; no implied hosted relay, public links or automatic internet reachability |

### Explicit boundaries for extensions and deferred functions

The new extension domains, schema version and feature negotiation are defined by [Engine contracts](ENGINE_CONTRACTS.md). They must expose folders/archive, comment operations, token operations, semantic snapshot ingestion, code export and motion controls to agents as well as the UI. Discovery reports them independently of the preserved 50-tool compatibility catalog.

- Required motion output is a still at a declared time and a deterministic ordered frame sequence with timebase, dimensions and asset hashes. GPU-dependent randomness must not change saved output across repeats of the supported reference backend.
- MP4/WebM/GIF or other encoded animation containers are DEFERRED until a named codec/license/backend and frame-timing qualification are accepted. Discovery must report unavailable; a static image or silently dropped animation is not equivalent. This disposition limits the replacement claim to the declared workflow inventory.
- Arbitrary JavaScript execution, arbitrary Three.js/WebGL islands, general browser navigation, live DOM APIs, arbitrary React runtime components and Lottie/Rive/YouTube embeds are OUT OF SCOPE for this native design engine version. The official Paper roadmap itself distinguishes shipped capabilities from future integrations; this plan does not turn every roadmap item into an implicit existing feature.
- General interactive prototyping/state-machine simulation and unrestricted timeline authoring are separate product extensions. Native effects' deterministic time sampling does not establish those features.
- Hosted billing/accounts/CDN, public anonymous sharing and model-provider subscriptions are external services, not required native dependencies. A future optional integration cannot become a silent fallback for required offline editing.
- Archive/restore is a workspace operation, comments have their own authored history and content edits retain layer/text Undo. Deleting a design node must not silently retarget or erase its comment thread; anchors have an explicit orphaned/resolved state according to the engine contract.

Any change from REQUIRED to DEFERRED/OUT OF SCOPE needs an explicit product decision and a new inventory version. A native release may describe implemented subsets while required rows remain; it may not describe this inventory as complete.

## 6. HTML/CSS and source-fidelity case denominator

These cases test semantic meaning and native output together. The renderer/style specification defines the supported syntax and diagnostics; this table supplies evidence, not a second CSS parser or wire contract.

| ID | Input and operation | Required assertion |
| --- | --- | --- |
| RT-01 | Nested HTML containing class/inline declarations, stable metadata, text, SVG and image references; import, edit one child, export, reimport | Supported nodes and relationships persist; only intentionally changed properties differ; stable source mapping survives in identity-preserving mode |
| RT-02 | Flex parent, three differently sized children, gap/padding/min/max and intrinsic text; reorder and resize via UI and MCP | Authored flow/gap constraints remain; no accidental absolute-coordinate flattening; hit geometry matches layout |
| RT-03 | Grid with intrinsic tracks, spans and constrained image/text; alter track and child width | Supported track/cell semantics persist in code export and reimport; absent unsupported constructs are reported before faithful-import claims |
| RT-04 | Artboards at 1440, 768 and 390 logical pixels using authored responsive rules | Layout adapts at declared breakpoints; code retains rules rather than three unrelated absolute snapshots |
| RT-05 | CSS variables/tokens, inheritance and shared-rule versus local override | Token/rule identity survives; computed inspection reports winner/provenance; editing one override does not mutate all class users |
| RT-06 | Mixed Korean/Latin/emoji/combining/bidi text with multiple styles and actual embedded font faces | String/run semantics, line boxes, glyph placement, caret mapping and screen/export agree within declared tolerance |
| RT-07 | Unsupported CSS, missing fonts/assets, script/event handlers and unavailable external content | Deterministic errors or retained explicit diagnostics; no executable imported code and no unsupported feature silently marked faithful |
| RT-08 | UI edit then MCP edit then HTML/CSS/static React export; reconnect and repeat with stable IDs | No wholesale delete/recreate; revision/source mapping and author Undo remain meaningful; semantic result survives new-profile reopen |
| FIG-01 | Components/instances/variants/overrides and cross-page source references | Definition/instance distinction and override behavior preserved; detached-source approximation cannot pass required semantic fidelity |
| FIG-02 | Variables/tokens, effects, masks/blends, booleans and nested affine transforms | Supported source fields map to editable native semantics; visual oracle covers interaction of features, not isolated shape count |
| FIG-03 | Mixed text styles, line breaks, baseline/fallback, missing face and variable fonts | Actual font identity recorded; covered frames compare against source; substitution is explicit and does not pass exact-fidelity cases |
| FIG-04 | Full original fixture and representative smaller licensed fixtures; export/reimport/evict/reload | Page IDs/order/counts, content fields and original asset hashes retained; full-content export cannot omit nonresident pages |

The large FIG's 46 pages, 39,363 objects and 160 bitmap hashes are an integrity oracle from C6, not proof of FIG-01..03. Required fidelity failures remain failures even if import completes faster.

## 7. Required native shader catalog

UI-36 and PAPER-09 require all 30 shader modules exported by the reviewed [Paper Shaders index](https://github.com/paper-design/shaders/blob/e7003a2d4e6e932e30b8fa11ec1239e6ea48e16a/packages/shaders/src/index.ts), package version 0.0.82, commit e7003a2d4e6e932e30b8fa11ec1239e6ea48e16a. These are reference algorithms/parameter contracts for reviewed native ports, not a requirement to run the upstream JavaScript/WebGL mounting code. [Reference projects](REFERENCE_PROJECTS.md) records dependency and license evaluation.

Every row initially has native status NOT_RUN and owner Render + QA. Its evidence ID is SH followed by the row ID. Each needs named parameter bounds, default and boundary fixtures, every admitted image/mask input, fixed time/seed samples, native interactive preview, deterministic still and ordered frame-sequence export, saved/reopened parameter identity, remote parameter convergence, cancellation and resource-limit cases. A versioned registry maps the upstream name and parameter version to the native implementation. Dropping a parameter or replacing the effect with a bitmap is an explicit failing capability case.

| ID | Upstream shader module | Native status |
| --- | --- | --- |
| SHADER-01 | color-panels | NOT_RUN |
| SHADER-02 | dithering | NOT_RUN |
| SHADER-03 | dot-grid | NOT_RUN |
| SHADER-04 | dot-orbit | NOT_RUN |
| SHADER-05 | fluted-glass | NOT_RUN |
| SHADER-06 | gem-smoke | NOT_RUN |
| SHADER-07 | god-rays | NOT_RUN |
| SHADER-08 | grain-gradient | NOT_RUN |
| SHADER-09 | halftone-cmyk | NOT_RUN |
| SHADER-10 | halftone-dots | NOT_RUN |
| SHADER-11 | heatmap | NOT_RUN |
| SHADER-12 | image-dithering | NOT_RUN |
| SHADER-13 | lens-distortion | NOT_RUN |
| SHADER-14 | liquid-metal | NOT_RUN |
| SHADER-15 | mesh-gradient | NOT_RUN |
| SHADER-16 | metaballs | NOT_RUN |
| SHADER-17 | neuro-noise | NOT_RUN |
| SHADER-18 | paper-texture | NOT_RUN |
| SHADER-19 | perlin-noise | NOT_RUN |
| SHADER-20 | pulsing-border | NOT_RUN |
| SHADER-21 | simplex-noise | NOT_RUN |
| SHADER-22 | smoke-ring | NOT_RUN |
| SHADER-23 | spiral | NOT_RUN |
| SHADER-24 | static-mesh-gradient | NOT_RUN |
| SHADER-25 | static-radial-gradient | NOT_RUN |
| SHADER-26 | swirl | NOT_RUN |
| SHADER-27 | voronoi | NOT_RUN |
| SHADER-28 | warp | NOT_RUN |
| SHADER-29 | water | NOT_RUN |
| SHADER-30 | waves | NOT_RUN |

Reference captures use the pinned upstream code only in external test tooling. Production native output must come from the native renderer with explicit time and deterministic seed inputs. Each shader has its own approved numerical/image tolerance, keyed by backend/profile and parameter fixture; a single global similarity score cannot qualify the catalog. The structural and geometry rules in [Qualification](QUALIFICATION.md#fidelity-oracles) also apply. Required frame-sequence output is distinct from the optional compressed-video encoders described above.

Incorporating or adapting upstream material requires its [Apache-2.0 license](https://github.com/paper-design/shaders/blob/e7003a2d4e6e932e30b8fa11ec1239e6ea48e16a/LICENSE), applicable [NOTICE](https://github.com/paper-design/shaders/blob/e7003a2d4e6e932e30b8fa11ec1239e6ea48e16a/NOTICE), source/version provenance and modification record. A publicly accessible source or example image is not by itself permission to redistribute every associated asset; fixture provenance is checked separately.

## 8. Completion rule and evidence ownership

For each MCP-XX row, MC-MCP-XX evidence enumerates every supported action, schema boundary and relevant negative case. For each UI/PAPER/RT/FIG row, evidence lists its independent subcases, UI/MCP equivalents where applicable, and persisted/collaborative/export results. New native extensions have their own registered cases; old tool count is never used as their substitute.

A completion review requires:

1. All 50 catalog names accounted for, all action subcases identified, every schema compatibility change recorded.
2. Every REQUIRED UI/PAPER/RT/FIG/SHADER row supported by fresh native results at the candidate revision.
3. Correctness, combined workloads and platform gates in [Qualification](QUALIFICATION.md), including native IME/accessibility and headless execution.
4. No hidden required WebView/Chromium path; reference-browser tests are external test machinery only.
5. Current-app evidence, Paper source claims and native observations remain separately labeled in published results.

The registry is implementation-ready scope, not an assertion of completed functionality. Native status remains NOT_RUN until actual evidence is attached.

