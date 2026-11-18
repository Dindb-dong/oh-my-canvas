# Implementation contract

Oh My Canvas runs as a Rust-native desktop, local document service and MCP CLI. The former Electron application, web renderer, JavaScript document engine and their build/test paths have been removed.

- Keep document authority and durable writes in the service/engine, outside the presentation layer.
- Validate external inputs, identities, revisions, referenced assets and file destinations before publication.
- Preserve attributed Undo, idempotent receipts, recovery and document isolation across clients.
- Use Skia-native rendering and native text/layout services; do not introduce a browser runtime for app rendering.
- Keep local MCP and invited collaboration as separate authenticated network boundaries.
- Preserve supported older file-format conversion in the Rust importer and test it using explicit fixtures.
- Run desktop QA with an isolated profile and `--automation-background`; never use the user's normal profile.

[Architecture](docs/ARCHITECTURE.md) · [Native workspace](native/README.md) · [Tool and format contracts](docs/MCP_PARITY.md) · [Qualification](docs/native-engine/QUALIFICATION.md)
