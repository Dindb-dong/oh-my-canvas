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

Build or bundle `omc-cli` and `omc-service` beside `omc-desktop`. **MCP → Copy MCP configuration** produces two stdio entries for the current native profile. The OMC entry uses the existing tool schemas. The separate `--dialect figcraft` entry exposes the 643 command IDs from FigCraft v0.17.0. Headless workflows include native layer and text editing, catalog data, component operations, document branches and versions, exports, and metered Wasm plugins. Window and pointer commands use an attached desktop. The copied config contains executable and profile paths only.

FigCraft v1 archive interchange supports the portable subset of layers and document properties. Use a separate native `.omc` destination when saving OMC-only catalog data from an imported FigCraft file. See [MCP parity](../docs/MCP_PARITY.md) for native history packages and Electron document migration.

For MCP image background removal, run `node scripts/prepare-background-removal.mjs --native native/target/debug` from the repository root. For a packaged build, pass the service binary’s directory or the macOS `Contents/Resources` directory. The script stages the verified model and its license notices. `OMC_BACKGROUND_MODEL` can point to the same verified file. `image` reports `background_model_unavailable` for background removal if the file is absent or fails verification. Original restoration uses the document’s stored asset.

For legacy Streamable HTTP clients, launch the native service with `--legacy-mcp-port 47831`, or set `OMC_LEGACY_MCP_PORT=47831` in the environment of a desktop or CLI process starting the service. Use `0` for an independent test listener. Read the active port and certificate path from `mcp-runtime.json` in the selected profile. The endpoint is `https://127.0.0.1:<port>/mcp` with the existing profile's pinned `mcp-cert.pem` and `mcp-token-v2` bearer. A profile with an existing TLS identity reuses it. The port must be free. The installed Electron app and native service should use separate ports and profiles when run together. The native listener supports v2 Streamable HTTP. Legacy relay discovery with an embedded token requires fresh credentials.

The legacy `get_path` and `edit_path` tools inspect and edit native vectors in world coordinates, including node moves, splits, handles, contours, endpoint joins, and polygon/star regeneration. Editable Bézier geometry is retained in the native document. Page and top-level frame guides appear on the native canvas when rulers are enabled. The FigCraft dialect can edit guides, layout grids, and per-layer export settings and keep them in FigCraft v1 archives.

**Collaborate** hosts a native room on a specific interface and creates a pinned TLS invitation. Hosts and guests retain durable native replicas after leaving. Local rooms support up to four participants, an 8 MiB message limit, and up to 3 MiB of referenced assets per message.

The FigCraft MCP dialect also supports online publishing and joining through a FigCraft server. `pref.publishServer` sets the default endpoint, and `collab.share` generates edit, view, and comment links. Online links and file ownership survive a local service restart. `collab.stop` revokes the shared links while keeping the published file. Online collaboration uses the portable FigCraft document subset. If reconnection encounters conflicting changes, the existing local document remains available beside the server document.

The native MCP suite exercises both stdio dialects, legacy HTTPS across a service restart, native TLS rooms, and collaboration with an isolated official FigCraft server. For automated desktop checks on macOS, supply a temporary profile and `--automation-background` to keep test windows hidden and preserve foreground focus.

## MCP masks

`edit_shapes` with `action: "mask"` groups fixed-position native siblings and uses `maskId` as the source, or the first requested layer if omitted. Alpha is the default. Luminance and vector modes are available, with vector coverage limited to rectangles, ellipses, and paths without children. Mask creation rejects layout-driven reparenting and selections under locked or hidden layers. `action: "unmask"` releases the mask while preserving the group and its children. Both actions use the native Undo history.
