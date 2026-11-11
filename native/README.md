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
