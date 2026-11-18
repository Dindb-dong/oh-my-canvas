# Getting started

## Install and run

Use Rustup and the pinned Rust 1.92.0 toolchain. From this checkout:

```sh
cd native
cargo build --locked --release -p omc-desktop -p omc-service -p omc-cli
./target/release/omc-desktop
```

Keep the three binaries together so the desktop can start its service. The app runtime does not require Node.js. Root npm commands are development checks, not application launch or packaging commands. Native packaging and cross-platform qualification remain incomplete.

## First canvas

Create or open a canvas from the local library. Draw with native tools or use **Paste HTML** to turn supported HTML/CSS into editable layers. Organize pages, components, shared styles and tokens, then inspect or export the result.

## Save, recover, and back up

Documents and assets belong to the selected local profile. Native metadata and history live under `native-v1/`; keep the entire profile together for a closed-app backup. Export a portable document for interchange. Do not delete databases or replace a profile to resolve an unexplained save error. Keep the original and reproduce using an isolated copy.

Native editable snapshots and history packages preserve different information. Older Electron/Yjs files are not native history packages. Keep original backups and use an existing canvas JSON export for editable-content migration. Review conversion diagnostics. See [files and repeatable output](MCP_PARITY.md#files-and-repeatable-output).

## Local MCP

Use **MCP → Copy MCP configuration** to register this profile's stdio CLI. Choose a document explicitly for each agent. See [MCP setup](MCP.md) and [tool contracts](MCP_PARITY.md).

## Collaboration

Host a native TLS room and privately share its pinned-certificate invitation. Up to four participants keep local replicas. The host must be reachable; there is no automatic NAT traversal, relay or host migration. External-network and four-hardware-peer qualification remain incomplete. Optional FigCraft server publishing is a separate online route. See the [native guide](../native/README.md).

## Next steps

[README](../README.md) · [Architecture](ARCHITECTURE.md) · [Troubleshooting](TROUBLESHOOTING.md) · [Testing](TESTING.md)
