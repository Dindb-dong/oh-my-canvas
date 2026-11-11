# Native attributed-operation profile

**Date:** 2026-11-11. **Status:** implemented as an initial native profile; release qualification remains incomplete.

## Context

The native specification requires author-selective assignment retractions, independent deletion tombstones, placement-aware rank adjustments and observed-character text operations. Those are application semantics. Naming a CRDT library does not establish them, and a generic library Undo stack is not evidence that these semantics hold.

The initial implementation uses project-owned immutable operation records under `omc.operations/1`, carried by `omc.sync/1`. This replaces the proposed Yrs adapter as the initial native implementation choice. It does not claim Yrs update encoding, legacy Yjs compatibility or compatibility with Electron collaboration protocol v3. Those protocols are rejected rather than guessed or silently coerced. The public application scope and required acceptance cases remain unchanged.

## Decision and implementation

- Scalar assignments retain their operation identity and `(Lamport, replica UUID, operation counter)` stamp. The greatest unretracted assignment wins. Undo records an attributed retraction rather than restoring an old whole-document snapshot.
- Parent and rank are one placement. A rank adjustment identifies the exact placement it observed. A concurrent winning move ignores adjustments for its former placement.
- Independent deletion records remain live until their own origin and author retract them. A foreign deletion therefore survives local Undo.
- Text is an ordered graph of immutable Unicode-scalar items. Each inserted run identifies a stable predecessor. Sibling insertions use a fixed descending operation-stamp order; all item identities survive deletion and retraction. API offsets remain UTF-16, and surrogate-splitting offsets reject.
- Text deletion and formatting name observed item identities. Concurrent foreign insertions are not deleted or retroactively formatted. Formatting attributes resolve independently. Undo of an insertion hides only that insertion's items, preserving foreign descendants.
- Relative selections retain left/right item anchors and the observed replacement set. Native IME can submit one `text.splice` after concurrent changes, or receive an explicit target/anchor conflict while preserving its local composition buffer.
- Four replicas store their own transactions and causal frontiers. Transactions preserve grouped operations; missing dependencies and incomplete fragments remain staged. Applied progress follows a local durable commit.
- Catalog fields use independently assigned `namespace/entity-id/field` keys. Comment attribution is bound to the authenticated context. Comment history and design history use separate channels.

The implementation lives in [`omc-sync`](../../../native/crates/omc-sync/src/lib.rs), [`omc-engine`](../../../native/crates/omc-engine/src/lib.rs), [`omc-protocol`](../../../native/crates/omc-protocol/src/lib.rs) and [`omc-storage`](../../../native/crates/omc-storage/src/lib.rs).

## Evidence and its limits

The executable cases include:

- A 24-case text matrix over ASCII, emoji, Hangul, combining marks, ZWJ sequences and bidirectional/newline text. Same-gap insertion, observed deletion, independent/conflicting marks and deletion Undo exercise each causally valid two-operation order.
- Four independent SQLite replicas with different authenticated author contexts, reversed delivery, duplicate delivery and semantic-content comparison.
- Concurrent placement cycles, independent tombstones, rank-rebalance versus move, foreign-author retraction rejection, revision-pinned reads and stable composition selections.
- A 200-process-kill database test: 40 trials at each of five transaction/receipt boundaries. A fresh authority verifies the durable decision and retries the same principal/key exactly once.

The kill test covers database operation/receipt boundaries. It does **not** complete the specification's wider asset-install, two-reader, checkpoint-registration, power-loss or platform recovery gate. The text matrix does not establish native grapheme navigation, paragraph-level formatting, native Korean IME delivery or the complete four-machine workload. Those require their owning integrations and evidence.

## Compatibility and remaining work

The operation profile is versioned separately from document schema, engine commands and portable packages. A new profile requires an explicit converter and closed-causal-cut validation. Original input remains available during conversion; no old invitation enables new-profile exchange automatically.

This first profile retains history rather than garbage-collecting causal identities. Complete shard checkpoint compaction, history capacity maintenance, bounded large-package transfer, cross-platform authentication/membership review and the full W1–W7 resource/performance suite remain required. The per-node log avoids scanning unrelated document nodes for a leaf edit, but a frequently edited node's retained history still needs measured maintenance. No production performance claim follows from the functional tests.

If a later qualified Yrs adapter preserves these semantics and improves measured behavior, it can replace the internal representation behind a new explicit profile/migration. Keep the same observable conflict, Undo, text, durability and resource requirements; changing the adapter is not permission to remove required behavior.

## Reproduction

```sh
cargo test --manifest-path native/Cargo.toml -p omc-model -p omc-protocol -p omc-sync -p omc-storage -p omc-engine
cargo test --manifest-path native/Cargo.toml -p omc-engine --features fault-injection --test recovery -- --nocapture
```

Fault injection is an opt-in build feature for test processes. Default installed builds do not execute its test-only pause points.
