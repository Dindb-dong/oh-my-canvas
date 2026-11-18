# Local MCP connection and recovery

The native application provides stdio MCP through `omc-cli`. Choose **MCP → Copy MCP configuration** in the desktop, then register the generated configuration with your client. It names the installed CLI and selected profile. The app does not silently change global client settings.

## Documents and pages

Start with `list_documents`, `open_document` or `create_document`, then `get_context`. Mutations require an explicit `documentId`; the visible tab is never an implicit target. Background agents can use separate documents while the user continues editing. A human transaction can return `busy`; retry when it finishes. Each author has separate Undo ownership.

The OMC dialect has 59 tools: 50 shared operations and 9 native extensions. The separate FigCraft-compatible dialect has 19 tools with 643 command IDs. Use each running server's `tools/list` as the schema authority. See [capability and targeting contracts](MCP_PARITY.md).

## Credentials and registration

Stdio connects to the authenticated local service for the chosen profile. Treat profile descriptors, credentials and invitations as private. Never forward local MCP ports or attach profile files to bug reports. See [security](../SECURITY.md).

For older Streamable HTTP clients, the native service supports an optional pinned-certificate HTTPS listener. It is not the default desktop stdio path. Setup, port selection and persistent token/certificate handling are documented in the [native guide](../native/README.md). Never disable certificate verification to fix a connection.

## Sessions, cancellation, and uncertain results

Reconnect and read the current document context after a restart. If a request loses its response, inspect the durable result or document before repeating a mutation. Cancellation after commit cannot undo a durable edit. Do not assume a transport disconnect rolled back the operation.

## Local checks

Build the native service and CLI, install locked test tooling, then run `npm run test:native`. Services use temporary isolated profiles. See [testing](TESTING.md).
