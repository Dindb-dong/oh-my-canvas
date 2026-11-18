# Local MCP connection and recovery

The native application provides stdio MCP through `omc-cli`. Choose **MCP → Copy MCP configuration** in the desktop, then register the generated configuration with your client. It registers one OMC server with the installed CLI and selected profile. The app does not silently change global client settings.

## Documents and pages

Start with `list_documents`, `open_document` or `create_document`, then `get_context`. Mutations require an explicit `documentId`; the visible tab is never an implicit target. Background agents can use separate documents while the user continues editing. A human transaction can return `busy`; retry when it finishes. Each author has separate Undo ownership.

Use the default OMC endpoint for design authoring, inspection, assets, and review. The optional FigCraft-compatible endpoint serves clients using its command protocol. Use each running server’s `tools/list` as the schema authority. See [capability and targeting contracts](MCP_PARITY.md).

## Native design workflows

- Use `workspace` with `design_starters` to discover bundled editable designs. Pass a `starterId` to `create_document` to start from one.
- Use named `batch` steps and backward references in layer-ID inputs to create related editable layers in one undoable edit.
- Use `edit_shapes` with `action: "appearance"` for indexed paint and effect stack edits. Use `measure` for spacing and container margins on the current page.
- Use `edit_text` to attach editable text to a copy of a curve, `shape_builder` to inspect and edit vector regions, and `guides` for indexed ruler guides. Use `data_fill` to produce editable copies of a template from rows.
- Use `board` for sticky notes, bound connectors, tables and editable mind maps. Use `prototype` for flows, interaction graphs, deterministic playback and slide order with a shared component layout. For an attached desktop, open the document with `focus: true` before using `show_preview` or `present`.
- Use `native_comments` with `list_threads` and `get_thread` for filtered and paginated review threads. Use `changes` for a document-scoped cursor and `native_handoff` for scoped code, annotations and resource links.
- Use `native_tokens` to author collections, modes and typed aliases, then inspect the effective value on a layer. Use `component` for editable slots and instance swaps, and `libraries` to publish and refresh a local design library.
- Use `document_assets` with `inspect_original` or `download_original` for original bytes associated with a document asset or image layer. Read downloads in bounded chunks with `native_result` in the same session.
- Use `export_document` with PDF `pdfFrameIds` to export one page per frame in the requested order, including frames on different canvas pages.
- Use `capture_web` to bring the selected browser element into a new editable canvas. Use `import_document` with `web-capture` for an existing capture bundle, or `figcraft` with an archive file path. Export Android Vector Drawable using `format: "xml"`.
- Use `native_motion` for keyframes, PNG samples and editable procedural stripes. Local MP4 export requires FFmpeg with `libx264`. Check the tool’s capabilities before requesting an encode.
- Use `native_plugins` for local Wasm plugins. A run targets an explicit document and layer subtree. Plugin manifests, resource limits and document validation apply to each run.

## Capture a browser selection

1. In Chromium's extensions page, enable Developer mode and load the repository's [browser capture extension](../browser-capture/) as an unpacked extension.
2. Run `omc-cli --profile YOUR_PROFILE --browser-capture-connection` with the same CLI and profile as your MCP configuration. Paste its output into the extension's options and save the connection. The pairing is private and applies to the current OMC service and browser session. Re-pair after either restarts.
3. On the page you want to capture, click **Oh My Canvas Browser Capture** in the browser toolbar, then click an element. The outline follows the element under the pointer. Escape cancels the selection.
4. Call `capture_web` once from the default OMC MCP with an optional `title`. It reads the element's live rendered state, returns a new document ID and conversion diagnostics, and consumes the selection. Inspect and edit the layers with `get_tree` and the usual OMC tools.

The extension sends the selected element over the local connection when the tool requests it. Form values, private subtrees, cross-origin frames and other unsupported content are excluded by the capture producer. Select again to capture another state. Selection expires after two minutes and requires the same page element to remain present.

## Credentials and registration

Stdio connects to the authenticated local service for the chosen profile. Treat profile descriptors, credentials and invitations as private. Never forward local MCP ports or attach profile files to bug reports. See [security](../SECURITY.md).

For older Streamable HTTP clients, the native service supports an optional pinned-certificate HTTPS listener. It is not the default desktop stdio path. Setup, port selection and persistent token/certificate handling are documented in the [native guide](../native/README.md). Never disable certificate verification to fix a connection.

## Sessions, cancellation, and uncertain results

Reconnect and read the current document context after a restart. If a request loses its response, inspect the durable result or document before repeating a mutation. Cancellation after commit cannot undo a durable edit. Do not assume a transport disconnect rolled back the operation.

## Local checks

Build the native service and CLI, install locked test tooling, then run `npm run test:native`. Services use temporary isolated profiles. See [testing](TESTING.md).
