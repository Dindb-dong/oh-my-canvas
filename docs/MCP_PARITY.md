# MCP capability map

The desktop app exposes 50 tools: 37 editor tools and 13 workspace tools. Existing tools keep their names. `workspace({action:"capabilities"})` returns the actual catalog, targeting requirements, file limits and platform availability for the running build. Reconnect clients that cache an older tool list after updating the app.

MCP exposes semantic operations: creating a path replaces drawing gestures, a typed value replaces an inspector dialog, and a returned payload replaces a clipboard export. It does not need to click a toolbar or open a picker to do the underlying work. The public schemas returned by `tools/list` are authoritative for arguments.

| App capability | MCP operation |
|---|---|
| Canvas library, search, favorites and sorting | `list_documents`, `preferences` |
| Blank/sample creation, open, click-title rename, duplicate | `create_document` (`sample` optional), `open_document`, `rename_document`, `duplicate_document` |
| Save, close/release, focus, library and deletion | `save_document`, `workspace`, `delete_document` |
| Pages and page guides | `page` list/create/rename/duplicate/delete/reorder/update; `select_page` |
| All drawing primitives, freehand, paths, text and images | `create_shape`, `write_html`, `write_svg` |
| Full native inspector values and removal | `edit_shapes` patch; nullable allowed fields remove values |
| Group/frame/ungroup, mask/unmask, ordering | `edit_shapes` |
| Align, distribute, tidy, flip, translate, resize, rotate | `edit_shapes`, using world coordinates and tree-aware transforms |
| Flex/grid, tracks, sizing, constraints, grid cells, frame guides/grids | Native `properties` and `edit_shapes` layout |
| Rich text runs, paragraph/list formatting and find/replace | `edit_text`; detailed `get_tree` returns native properties |
| Path nodes, handles, contours, join/merge and polygon/star primitives | `get_path`, `edit_path` with a fresh revision |
| Boolean operations and source-preserving outlines | `boolean`, `outline` |
| Image crop/fit/adjustments, background removal/restoration | Native image properties and `image` |
| Components, variants, axes, typed properties and instances | `components`, `component`, including action `axes` |
| Shared styles, usage, apply/detach | `styles` |
| Linked library import/update/enable/unlink/export/instances | `libraries` |
| Local image/SVG/font import, listing and placement | `document_assets`, `import_resource` |
| Optional provider search and font catalog | Existing `assets`, `fonts`; no hosted provider is implied |
| Cut/copy/paste/here/in-place/replace and property transfer | `clipboard`, with private agent state or explicit payload |
| Agent Undo/Redo | `undo`, `redo`; never consumes another author's history |
| Selection, tool, viewport, fit, outlines, rulers, grids, snapping | `view` |
| Search, rendered inspection and diagnostics | `find`, `get_context`, `get_tree`, `get_styles`, `get_html`, `screenshot` |
| Native document and interchange import/export | `import_document`, `export_document` |
| SVG/PNG/JPG/WebP/PDF/HTML/JSON layer export | `export_selection`; native `exportSettings` stores presets |
| Collaboration host/invite/join/leave/status/cursor | `collaboration`, explicitly targeted to a document |
| Display name and grid/list preference | `preferences` |
| Public connection configuration, limits and about information | `workspace` connection/capabilities/about |
| Window visibility/fullscreen/hide others, saved quit | `workspace` window/quit; platform availability is reported |
| Screen color picker | `workspace` sample_color at explicit screen coordinates; requires supported screen access |

Expanding a layer tree, opening an Assets tab, showing a quick-action popup or presenting a file dialog are presentation affordances. Their data operations are directly available above. Developer tools remain restricted to an app launched with `--debug-ui`. Screen sampling never silently bypasses OS permissions. Quitting acknowledges a scheduled save-and-quit; a save error keeps the app open.

## Targeting and history

Choose a stable document ID with `list_documents` and `open_document`/`create_document`. Document edits require explicit `documentId`; mixed editor families conservatively require it for their reads too. No call falls back to the visible tab. New pages still belong to one named canvas; switching a page invalidates already queued page-scoped writes. Refresh `get_context` after a runtime restart.

Layer IDs can be raw IDs, this agent's page-scoped aliases, or unique `@data-ref` values. Native property patches cannot change internal identity/topology. Locked or hidden ancestors prevent editing. Clear a layer's own lock/hidden flag in a separate operation before editing it.

Native content/resource writes remain attributed, undoable document transactions. Private clipboard payloads can transfer content between documents with remapped IDs; unsupported external component/style links detach while retaining appearance. Text ranges are UTF-16 offsets with an exclusive end; a supplied `revision` refuses a stale edit. Rich-text range formatting preserves unaffected runs and paragraphs.

`batch` supports at most 100 validated synchronous operations: existing HTML/update/move/duplicate/delete/board writes plus native shapes/text/styles/libraries and asset place/remove. Asset ingestion, vector computations, page switching, filesystem, collaboration and app controls remain standalone. A failed late operation rolls back the candidate; cancellation after a commit does not undo completed work.

Closing with `workspace({action:"close",documentId})` saves and releases this caller by default. `release:false` retains its binding. Other owners remain active. Deletion requires `expectedTitle` and refuses agents, collaboration and pending work. Workspace/file changes are outside layer Undo.

## Files and repeatable output

`import_document` accepts exactly one inline payload or explicit absolute local `filePath`. JSON, Figma `.fig`, and Sketch `.sketch` imports create independent canvases. The binary design formats require `filePath`; conversion warnings are returned. OMC defaults to identity-preserving merge, refusing an in-use target; `mode:"copy"` creates an independent canvas. `focus` defaults to false. `import_resource` ingests a local image/SVG/font/library; place the returned asset separately.

`export_selection` returns typed UTF-8 or base64 content. `export_document` returns base64 or writes an explicit path. Layer export IDs are explicit, or omitted desktop export scope is the entire active page; human selection never chooses the output. Raster/PDF export requires one explicit layer when a page contains multiple roots. Full OMC preserves the editable document, embedded assets and merge history.

The MCP request limit stays 1 MiB. Large files use paths, not larger requests: OMC input is bounded to 384 MiB; design-file input to 256 MiB, resources to the document budget, filesystem export to 100 MiB, and desktop inline output to 512 KiB. Public selection export has a separate bounded inline limit. Existing output files are preserved unless `overwrite:true`; default creation is race-safe. Protected app/profile destinations and non-regular/symlink files are rejected. No global MCP client configuration or credentials are rewritten.

See [connection, sessions, cancellation and recovery](MCP.md) for transport setup and retry semantics. The isolated runtime journey is `node scripts/ultimate-mcp-e2e.mjs` after `npm run build`; it uses synthetic profiles and real HTTPS/stdio calls.
