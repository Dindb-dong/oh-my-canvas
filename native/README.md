# Native engine implementation

This workspace implements the architecture accepted in PR #14 in reviewable steps. The existing Electron application remains the default until the original native completion gates pass.

## Foundation

- `omc-model`: stable typed identifiers, ordered pages and nodes, authored properties, revision serialization, relative UTF-16 text positions.
- `omc-protocol`: validated semantic command envelopes, explicit document epochs and preconditions, durable receipt shape, RFC 8785 canonical request digests, duplicate JSON key rejection and request size limits.

The workspace requires Rust 1.92.0. Run `cargo test --manifest-path native/Cargo.toml --locked --workspace` and `cargo fmt --manifest-path native/Cargo.toml --all --check`.

This first increment defines contracts. It does not replace the runtime or claim the native release acceptance gates have passed.

## CRDT operations

Versioned attributed operations, stable text identities, selective retractions, and bounded fragment assembly.

## SQLite persistence

Bundled SQLite WAL/FULL storage, transactional receipts, retained entity versions, staging and recovery.
