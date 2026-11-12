# Native engine implementation

This workspace implements the architecture accepted in PR #14 in reviewable steps. The existing Electron application remains the default until the original native completion gates pass.

## Local verification

Use these commands to verify the native workspace locally while GitHub Actions is paused. From the repository root, use the existing locked Node dependencies, or install them with `npm ci --ignore-scripts` if you only need the MCP test client. Use Node.js 22 or newer and Rustup. The toolchain file in `native/` pins Rust 1.92.0.

```sh
cd native
cargo fmt --all --check
cargo test --locked --workspace
cargo build --locked -p omc-service -p omc-cli -p omc-desktop
node tests/mcp.e2e.mjs
```

The MCP suite starts native processes on loopback and removes its temporary profiles on exit. For desktop changes, also run `omc-desktop --profile <temporary-directory> --smoke-exit-ms 2000 --screenshot <output.png>` using the binary in `target/debug/` and inspect the image. Record the OS, commands and results in the PR. Platform packaging and workload qualification are tracked in the [native qualification guide](../docs/native-engine/QUALIFICATION.md).

## Foundation

- `omc-model`: stable typed identifiers, ordered pages and nodes, authored properties, revision serialization, relative UTF-16 text positions.
- `omc-protocol`: validated semantic command envelopes, explicit document epochs and preconditions, durable receipt shape, RFC 8785 canonical request digests, duplicate JSON key rejection and request size limits.

## CRDT operations

Versioned attributed operations, stable text identities, selective retractions, and bounded fragment assembly.

## SQLite persistence

Bundled SQLite WAL/FULL storage, transactional receipts, retained entity versions, staging and recovery.

## Document authority

Validated atomic commands, durable idempotency, scoped Undo, immutable query cuts and independent replica delivery.

## MCP connection and collaboration preview

Build or bundle `omc-cli` and `omc-service` beside `omc-desktop`. In the desktop app, **MCP → Copy MCP configuration** produces two stdio entries for the current native profile. The OMC entry uses the existing tool schemas. The FigCraft entry selects the separate `--dialect figcraft` route, whose `list_commands` reports the implemented commands. It currently covers document listing and creation, core editable layer creation and properties, session selection, atomic referenced node batches, inspection, raster/vector output, and author undo/redo. Desktop automation, file and plugin compatibility, and the complete FigCraft registry still require implementation. The copied config contains executable and profile paths only.

**Collaborate** hosts an opt-in native room on a specific interface. The local-device option is useful for testing with a separate profile. Copy the room invitation and choose **Join from clipboard** in the second app. The link grants edit access until hosting stops. The room uses its own TLS identity and credentials, separate from local MCP. Hosts and guests retain their own durable native replicas after leaving. The preview supports up to four participants, a bounded 8 MiB room message, and up to 3 MiB of referenced assets per message. Rejoining a live room within the same service process can exchange offline edits. Older Electron and FigCraft invite formats are incompatible with native rooms.

The native MCP end-to-end suite exercises both stdio dialects, batch rollback, shared document readback, and a real TLS room between independent service profiles. Preview status still applies to cross-machine qualification, transport restart/resume, and legacy action coverage.

## MCP masks

`edit_shapes` with `action: "mask"` groups fixed-position native siblings and uses `maskId` as the source, or the first requested layer if omitted. Alpha is the default. Luminance and vector modes are available, with vector coverage limited to rectangles, ellipses, and paths without children. Mask creation rejects layout-driven reparenting and selections under locked or hidden layers. `action: "unmask"` releases the mask while preserving the group and its children. Both actions use the native Undo history.
