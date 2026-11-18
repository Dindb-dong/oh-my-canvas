# Local MCP connection and recovery

The native application provides stdio MCP through `omc-cli`. Choose **MCP → Copy MCP configuration** in the desktop, then register the generated configuration with your client. It names the installed CLI and selected profile. The app does not silently change global client settings.

## Documents and pages

Start with `list_documents`, `open_document` or `create_document`, then `get_context`. Mutations require an explicit `documentId`; the visible tab is never an implicit target. Background agents can use separate documents while the user continues editing. A human transaction can return `busy`; retry when it finishes. Each author has separate Undo ownership.

Use the default OMC endpoint for design authoring, inspection, assets, and review. The optional FigCraft-compatible endpoint serves clients using its command protocol. Use each running server’s `tools/list` as the schema authority. See [capability and targeting contracts](MCP_PARITY.md).

## Native design workflows

- Use named `batch` steps and backward references in layer-ID inputs to create related editable layers in one undoable edit.
- Use `edit_shapes` with `action: "appearance"` for indexed paint and effect stack edits. Use `measure` for spacing and container margins on the current page.
- Use `board` for editable sticky notes and connectors whose endpoints follow their target layers. Use `prototype` to set a flow start and simple click navigation.
- Use `native_comments` with `list_threads` and `get_thread` for filtered and paginated review threads.
- Use `native_tokens` with `action: "inspect"` to read a token’s authored value, mode and effective value in a layer’s context. Use `list_collections` and `set_scope_mode` to choose a collection mode for a page or frame.
- Use `document_assets` with `inspect_original` or `download_original` for original bytes associated with a document asset or image layer. Read downloads in bounded chunks with `native_result` in the same session.
- Use `export_document` with PDF `pdfFrameIds` to export one page per frame in the requested order, including frames on different canvas pages.
- Use `native_plugins` for local Wasm plugins. A run targets an explicit document and layer subtree. Plugin manifests, resource limits and document validation apply to each run.

## Credentials and registration

Stdio connects to the authenticated local service for the chosen profile. Treat profile descriptors, credentials and invitations as private. Never forward local MCP ports or attach profile files to bug reports. See [security](../SECURITY.md).

For older Streamable HTTP clients, the native service supports an optional pinned-certificate HTTPS listener. It is not the default desktop stdio path. Setup, port selection and persistent token/certificate handling are documented in the [native guide](../native/README.md). Never disable certificate verification to fix a connection.

## Sessions, cancellation, and uncertain results

Reconnect and read the current document context after a restart. If a request loses its response, inspect the durable result or document before repeating a mutation. Cancellation after commit cannot undo a durable edit. Do not assume a transport disconnect rolled back the operation.

## Local checks

Build the native service and CLI, install locked test tooling, then run `npm run test:native`. Services use temporary isolated profiles. See [testing](TESTING.md).
