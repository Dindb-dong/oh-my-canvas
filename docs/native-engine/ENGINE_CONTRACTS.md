# Native engine contracts

[Implementation guide](IMPLEMENTATION_GUIDE.md) · [Storage and collaboration](STORAGE_AND_COLLABORATION.md) · [Rendering and interchange](RENDERING_AND_INTERCHANGE.md) · [Capability matrix](CAPABILITY_MATRIX.md) · [Qualification](QUALIFICATION.md)

**Status:** proposed native protocol/schema v1; unimplemented. **Decision baseline:** 2026-11-11. MUST, MUST NOT and SHOULD are requirements on the future implementation, not descriptions of the current Electron application. Changing a normative default requires a versioned contract change and matching fixtures. The [overview](../NATIVE_ENGINE_PLAN.md) supplies product scope; this document defines observable engine behavior.

## 1. Ownership and crate boundaries

The document service is the only local writer for a document. UI, MCP, imports and peer merges use its validated interfaces. Public readers observe engine-owned immutable snapshots; they do not borrow a mutable CRDT transaction or inspect partially committed state.

| Proposed crate | Owns | Boundary rule |
| --- | --- | --- |
| `omc-model` | IDs, authored entities, schema, operation types and invariants | No window, filesystem, network or graphics dependency |
| `omc-protocol` | Versioned envelopes, capabilities, errors and limits | Generates/checks native IPC and MCP adapter schemas |
| `omc-engine` | Preparation, validation, short commit coordination, revisions and Undo | No renderer-owned document or DOM dependency |
| `omc-workspace` | Document leases, catalog, folders/archive, routing and fair admission | No workspace-wide lock during a document computation |
| `omc-storage`, `omc-assets` | Durable transactions, recovery, immutable resource bytes | No successful durability response before the storage contract completes |
| `omc-sync` | CRDT adapter, causality, transaction transfer and peer state | Remote input passes validation before publication |
| `omc-style`, `omc-text`, `omc-layout` | Derived cascade, shaping, text positions and layout | Inputs identify semantic revision, viewport and resource generation |
| `omc-scene`, `omc-render` | Display lists, hit data, screen/offscreen rendering | Cannot mutate authored entities |
| `omc-import`, `omc-export` | Interchange and snapshot packages | Same semantic commands/validation; no hidden browser |
| `omc-mcp`, `omc-desktop` | Transport adaptation and native presentation | Thin clients of the same engine |

The initial internal interface has five operations: `prepare(command, snapshot) -> Prepared`, `commit(prepared) -> DurableResult`, `query(query, snapshot) -> Page`, `submit_job(spec) -> JobId`, and `operation_status(key) -> Status`. `Prepared` contains the read/dependency set, write set, validated semantic delta, required assets and projected result. It cannot be constructed outside the engine. Commit rechecks its dependencies; stale preparation is rejected or re-prepared, never blindly installed.

## 2. Identity and canonical entities

IDs are immutable UUIDs with typed prefixes (`doc_`, `page_`, `node_`, `shard_`, `style_`, `token_`, `component_`, `thread_`, `comment_`, `folder_`). The suffix is 32 lowercase hexadecimal digits; user names and array positions are never IDs. External examples below use valid-shaped IDs. A new independent copy receives new document/node identities and remaps internal references; identity-preserving open does not. Imported source IDs are separate namespaced metadata.

`replicaId` identifies a durable local replica, `authorId` an authenticated human/agent principal, and `sessionId` its current connection. The service supplies author/session attribution; request bodies cannot impersonate them. `transactionId` is a UUID. Operation identity is `(replicaId, monotonically increasing counter)`; counters are allocated with the durable transaction. A shard's CRDT client identity is distinct from the author and MUST NOT be shared by concurrent writers.

| Entity | Authored, persisted content |
| --- | --- |
| Document/page | Title, stable root, page order, schema/epoch, source metadata and diagnostics |
| Node | Type, stable home shard, placement, geometry intent, content, authored styles, component links and overrides |
| Placement | One atomic value containing parent ID and sibling position; page membership is derived through ancestry |
| Style/token | Typed value or reference, namespace, mode, cascade intent and dependency edges |
| Component | Definition root, variants, typed properties, bindings and instance overrides |
| Text | Shared character sequence, paragraph boundaries, authored range marks and stable relative anchors |
| Asset | SHA-256, byte length, media type and original-resource metadata; not decoded pixels |
| Comment thread | Anchor, ordered replies, attributed body edits, resolved register and tombstones |
| Effect/shader | Reviewed registry ID/version, typed parameters and authored timeline; no executable code blob |

An anchor is a node-local point or a text-relative position, plus a fallback page/world point. Deleting its target leaves a visibly detached comment; it does not delete the discussion. Replies have immutable author identity. Body edits retain attribution; resolve/reopen uses the register policy below. Comments use separate Undo groups from layer edits. Comments and design entities replicate with the document.

Workspace folders, favorites, archive state and document leases belong to the local workspace catalog. Folder relocation/archive is outside layer Undo. Document title lives in the document catalog; workspace listings cache it. Folder organization is local unless a future negotiated feature explicitly synchronizes it. Archive hides a document without deleting data; permanent deletion is a separate operation requiring no active owners and a checked identity/generation.

Computed styles, layout boxes, resolved page membership, glyphs, spatial indexes, display lists and GPU handles are derived. They MUST NOT independently merge with authored values. Geometry uses finite `f64` values and explicit units; reject NaN/infinity. Rendering rounding cannot write back into authored dimensions. Coupled geometry, such as an orientation matrix and its rotation/flip interpretation, is one atomic authored value or derived from one representation.

Schema extensions are namespaced under `extensions`; known command fields reject unknown names. Preserve bounded unknown imported metadata without executing it. Required unknown schema features prevent writable open; read-only diagnostics must not imply full fidelity.

## 3. Revision and conflict model

A published local revision is `{epoch, sequence}`. Epoch is the native document generation UUID; sequence is an unsigned 64-bit decimal string. Sequence increases after each committed local or remote semantic transaction. It is local to a replica: equal sequence numbers on two machines do not imply equal state. Cross-peer comparison uses shard causal frontiers and a semantic digest over a specified scope.

Every document write MUST carry `targetEpoch`, independently of its precondition mode. Validate that epoch before deduplication, preparation or mutation, including `basis: "latest"` requests. The MCP adapter binds it from open/get-context and requires rebinding after migration; a delayed request cannot cross into a successor epoch. Workspace creation/lifecycle commands similarly target the workspace catalog generation.

Field versions identify winning authored operations. Native writes MUST additionally carry either a document revision, field/dependency versions, or explicit `basis: "latest"`. `latest` means capture the latest committed snapshot at admission, not ignore changes during preparation. A strict revision mismatch returns `stale_revision`; changed read dependencies return `conflict` with affected IDs/fields. Disjoint edits can commit despite unrelated document revisions when field/dependency preconditions remain valid. An effective placement version contains both its winning placement operation ID and applicable rank-adjustment operation ID (or null); order-sensitive preparation therefore detects rebalance as well as moves.

### Registers, placement and deletion

The native v1 scalar register is a set of assignment records and author-scoped retractions. Each assignment has `(lamport, replicaId, operationCounter)`, value and operation ID. Compare the tuple lexicographically, with numeric counters and bytewise UUID comparison; the greatest unretracted assignment wins. A sender increments Lamport time above all dependencies it observed. Wall-clock time is never the merge order. CRDT storage must preserve candidates needed for conflict resolution and Undo; a single overwritten SQL value is only a derived projection.

Placement is one such register. Siblings sort by position and then node ID. Position uses a 128-bit unsigned rank serialized as 32 hexadecimal digits; allocate the integer midpoint between adjacent ranks. Exhausted gaps trigger an explicit sibling-rank rebalance transaction against the observed parent-membership revision. A rebalance creates rank adjustments keyed to each node's exact observed winning placement operation ID; it does **not** assign a newer placement. An adjustment applies only while that placement operation is still the winner and its parent matches. Among adjustments for the same placement, the greatest adjustment stamp wins. A later or concurrent winning move therefore ignores the old adjustment and keeps its own parent/rank. Concurrent ranks may coincide; the node-ID tie breaker makes order deterministic. Report diagnostics when concurrent ordering changes defeat the author's intended relative placement.

Each delete adds an independently identified tombstone. A node remains hidden while any live tombstone exists. Undo retracts only the author's own tombstone. Concurrent edits to a deleted node remain recoverable but do not resurrect it. Concurrent valid placements can form a cycle: projection deterministically detaches the edge with the greatest winning placement stamp in each cycle to a document recovery root and reports `containment_repaired`. That virtual root/page uses reserved `recovery_root_`/`recovery_page_` IDs with suffix equal to the first 32 lowercase hex digits of SHA-256 over `UTF8("omc.recovery/1") || [0x0a] || UTF8(documentId) || [0x0a] || UTF8(epoch)` (byte concatenation). User/import-created IDs cannot use those prefixes. It needs no valid page ancestry and is presented whenever recovered content exists or no undeleted user page remains. It is derived, not a new authored page or a history mutation. A local command that knowingly creates a cycle is rejected.

| Concurrent case | Required converged outcome |
| --- | --- |
| A changes x; B changes fill | Both independent properties survive |
| A and B assign the same property | Greatest assignment stamp wins; losing value remains attributable |
| Two peers move one node to different parents | One winning atomic placement; no duplicate node |
| A rebalances siblings while B moves a child elsewhere | A's adjustment targets the old placement; B's winning move survives both delivery orders |
| A deletes while B edits | Hidden node retains B's content; explicit restore can reveal it |
| Two peers delete; A undoes | B's tombstone keeps the node hidden |
| A undoes its assignment after B overwrites it | Retract A's assignment; B remains unchanged |

## 4. Command envelope

This is the native service protocol, not a replacement for existing MCP tool arguments. JSON is the external representation. Binary IPC may encode the same validated values but must not change semantics.

```json
{
  "protocol": "omc.engine/1",
  "requestId": "req_13",
  "documentId": "doc_11111111111141118111111111111111",
  "targetEpoch": "b5350fee-ec53-4bed-880c-5ef71ade2363",
  "idempotencyKey": "d4c89fc6-4ba3-4c3a-b7f2-3f4788063b27",
  "preconditions": {
    "revision": {
      "epoch": "b5350fee-ec53-4bed-880c-5ef71ade2363",
      "sequence": "42"
    }
  },
  "undoGroup": "gesture_7",
  "deadlineMs": 5000,
  "command": {
    "type": "node.set",
    "nodeId": "node_22222222222242228222222222222222",
    "properties": {"name": "Primary button"}
  }
}
```

```json
{
  "requestId": "req_13",
  "status": "durable",
  "transactionId": "46f29f8c-1efd-42f2-aadc-ab7328da1d74",
  "revision": {
    "epoch": "b5350fee-ec53-4bed-880c-5ef71ade2363",
    "sequence": "43"
  },
  "replayed": false,
  "result": {"changedIds": ["node_22222222222242228222222222222222"]},
  "replication": {"appliedPeers": 0, "connectedPeers": 3}
}
```

The payload digest is SHA-256 of RFC 8785 JCS bytes for `{protocol, documentId, targetEpoch, command, preconditions, undoGroup}` after documented defaults are filled. It excludes transport request ID/deadline. JCS uses recursive UTF-16-code-unit property ordering, preserves array order and string Unicode without normalization, emits UTF-8, and uses its specified numeric serialization including negative zero as `0` [E4]. Reject duplicate keys, nonfinite numbers and lone surrogates before canonicalization. Large counters remain decimal strings. `omc-protocol` owns the serializer and golden digest fixtures; do not substitute locale/UTF-8 key sorting or arbitrary JSON pretty printing.

`batch` contains up to the limit below, targets one document and publishes all or none. Later operations may reference IDs created earlier in the batch. Validate the complete candidate overlay before mutation. A late failure discards the candidate and its temporary assets. Filesystem exports, workspace lifecycle, collaboration transport controls and long computations remain jobs/standalone operations, not nested batch commands. Multi-shard local atomicity is defined in the storage contract; cross-document atomicity is not implied.

### Command lifecycle

The lifecycle is `queued → preparing → accepted → committing → durable/published`, with terminal `rejected`, `cancelled` or `failed`. Accepted means a validated candidate or private preview exists; it is ephemeral, not a public revision or successful save. Native v1 ordinary write responses wait for the durable state. The GUI can display its local preview immediately with a pending indication.

Only successful SQLite commit advances the public snapshot and permits a success response. Where the qualification guide applies the resident small-MCP 100 ms target to a write, it measures the complete durable-response round trip, not an accepted preview or queued job; the separate 500 ms general durability target does not relax it. A response lost after commit does not roll back the edit. Replication is a separate per-peer status; zero applied peers does not invalidate local durability. Peer `staged` acknowledges stored bytes only, while `applied` acknowledges a validated, committed, published transaction.

Before the commit boundary, cancellation prevents mutation and cleans temporary reservations. Once the transaction has committed, cancellation returns `already_committed` and its result. An expired deadline while the outcome is uncertain returns the operation lookup key; the client must query rather than blindly retry with a new key. The engine must not claim cancellation merely because an HTTP connection closed.

### Idempotency across crash and reconnect

Cross-restart replay requires a provably stable principal. Native clients opt into negotiated `identity.resume/1`: after ordinary authenticated local transport setup, the service's control SDK registers a principal and returns a registration ID plus a cryptographically random 256-bit resume credential. Persist principal ID, profile, granted permission scope, credential hash and active/revoked state in the workspace database before returning it. The client stores the credential securely; it is not an agent-visible tool argument, document field or log value. Native desktop users can instead use the stable OS/profile-authenticated principal.

On a later session, present the registration ID/credential through the SDK's protected initialization metadata, in addition to normal transport authentication. Verify the hash and scope, then bind the session to that principal. Never derive identity from `clientInfo.name`, a supplied `authorId` or possession of the shared MCP transport bearer alone. Resume cannot enlarge permissions. Revocation/rotation invalidates the old credential without deleting committed receipts. Invalid resume proof fails authentication; it must not silently create a new principal and retry the write.

The resumable deduplication key is `(durable principal, documentId, targetEpoch, idempotencyKey)`, not transient session ID. Store payload digest, transaction ID, result revision and compact result in the same SQLite transaction as the edit. Repeating the same key/digest in the active epoch returns the original result with `replayed: true`, even after a process restart. A different digest returns `idempotency_conflict` before mutation. `operation_status` explicitly identifies its epoch and returns `committed`, `pending`, `not_found` or `expired`, with the original revision when known; it may read retained old-epoch receipts even though old-epoch writes are refused. Lookup requires the resumed principal or an explicitly authorized profile-owner read.

Legacy clients without this extension keep session-scoped agent identity and retry guarantees. Responses/capabilities declare `retryScope: "session"` versus `"durable_principal"`. A new legacy session cannot be promised cross-restart deduplication. Credential loss similarly creates no proof of the old identity: use authorized document/operation readback to resolve uncertainty before a deliberate new operation. Do not automatically replay the old key under a newly created principal. Resuming identity does not restore the session-local Undo stack.

Keep compact committed-key tombstones for the native epoch. Large result bodies may expire after the stated result retention; a tombstone still prevents reapplication and returns the original transaction plus `result_expired`. Native-epoch retirement changes the target generation; old keys must never silently run against its successor. Rejected/cancelled precommit attempts may retry the same key after correcting transient conditions only when their normalized payload remains identical.

## 5. Queries, jobs and errors

Queries specify document, scope, selected fields and requested revision or `latest`. Pagination uses an opaque authenticated cursor containing snapshot ID, query digest and last stable sort key. Page two reads the same snapshot as page one; do not silently paginate a changing tree. Expired/evicted snapshots return `snapshot_expired`, requiring restart. Layout queries add viewport, font/resource generation and fixed time sample. Results distinguish complete scope from unloaded/unavailable dependencies.

Materialize requested rows into bounded immutable chunks, then release database read transactions. A client cursor must not pin SQLite's WAL indefinitely. Snapshot/Undo memory follows the workspace budget; the engine can refuse another pin rather than exceed it. Ordinary reads remain available during an unrelated gesture; conflicting writes receive `busy` scoped to the document/node dependency, never all documents.

Jobs return `{jobId, state, progress, cancellationBoundary}`. States are queued, running, waiting_dependency, cancelling, cancelled, interrupted, failed and completed. Persist job intent/checkpoints only for explicitly resumable jobs. Restart changes an unresumable running job to interrupted; it does not repeat a partially applied import. Imports report committed pages and incomplete status. Exports pin a coherent revision and fail explicitly if their required scope is incomplete. Completed files/resources outlive their response URL only according to the reported retention/ownership contract.

| Error code | Client action |
| --- | --- |
| `invalid_argument`, `unsupported_feature` | Correct input or inspect capabilities; no mutation |
| `authentication_failed`, `principal_revoked` | Establish valid scoped identity; never fall back to a new author and auto-retry |
| `stale_revision`, `conflict` | Read current context and deliberately rebase |
| `busy`, `queue_full`, `resource_limit` | Honor retry metadata or reduce scope; no hidden partial success |
| `snapshot_expired`, `dependency_unavailable` | Re-query/reload identified scope |
| `idempotency_conflict`, `result_expired` | Inspect original operation; do not generate a duplicate automatically |
| `storage_unavailable`, `corrupt_state` | Preserve pending user state; display failure and recovery guidance |
| `cancelled`, `deadline_exceeded`, `outcome_unknown` | Use operation/job lookup when supplied |
| `protocol_mismatch`, `epoch_mismatch` | Upgrade or explicit migration; do not coerce state |

Errors carry code, bounded message, retryable boolean, request/operation IDs and structured affected fields. Logging must exclude document text, credentials and invitations by default. Validation failures do not publish partial results.

## 6. Rich text and concurrent editing

**Native final acceptance requires character/range coediting.** The current app's atomic rich-text property is a migration/intermediate behavior only. Whole-string replacement is an explicit destructive command with a strict revision check; ordinary typing must not use it.

Use a shared character sequence per text node, with stable paragraph boundary identities. Yrs `Text` is the initial adapter candidate. Configure UTF-16 indexing explicitly: documented Yrs defaults use byte offsets [E1, E2]. External MCP ranges remain UTF-16 half-open `[start,end)`; reject boundaries inside a surrogate pair. Native caret movement is grapheme-aware. Preserve exact input Unicode rather than normalizing it invisibly.

The text adapter exposes stable item ranges and relative positions. Persistent anchors include containing text identity, item/root position and left/right association. Convert a numeric API range to an observed item set at its validated revision. Deletion targets only those observed items, so a concurrent foreign insertion is not accidentally deleted by a shifted numeric range. Same-gap concurrent inserts preserve both runs in the pinned CRDT's deterministic item order. Golden fixtures fix the exact sequence for assigned test client IDs; receiving-order permutations must produce identical output.

Range formatting is a set of authored mark assignments over observed character-item intervals. Resolve each attribute independently using the register stamp from section 3: bold and color can merge, competing colors have one deterministic winner. Insertion explicitly carries the author's inherited caret attributes. A concurrent mark operation does not retroactively format characters it never observed. This finite policy avoids ambiguous expanding-range behavior; the UI can offer a later explicit range reformat. Paragraph split inserts a boundary; merge removes only the observed boundary. Conflicting paragraph attributes use the same register policy.

During IME composition, retain a local preview and stable start/end anchors; remote updates advance the committed snapshot. Commit the composition once, rebased through the anchors. If the target node is deleted or the anchor cannot resolve, cancel the replacement, preserve composed text in the local recovery buffer, and show a conflict. Never overwrite a remote paragraph with the stale precomposition string. Cursor/presence anchors are ephemeral, not durable edits.

### Undo and ordering

An Undo group is `(authorId, sessionGeneration, groupId)` with explicit command boundaries. Typing may coalesce within one text session; a pointer gesture is one group. Background import, remote merge, folders/archive and comments cannot consume layer Undo. The default menu undoes the latest eligible group by that author, not the global latest transaction.

For scalar assignments and tombstones, Undo adds retractions of its own operation IDs. For text insertions, remove only its inserted items; foreign items interleaved later survive. Undo of text deletion restores the authored deleted content at surviving relative anchors without deleting concurrent content. Restored content carries original formatting and new identities when resurrection is unavailable. Range-mark Undo retracts that author's mark assignment. Redo is a new attributed operation validated against the resulting state. A missing target yields explicit per-effect conflict/no-op diagnostics; grouped publication remains locally atomic.

Undo history is session-local in native v1, matching the existing reopen contract; operation history needed for merging/recovery remains durable. Persistence failure cannot leave a consumed Undo stack paired with unchanged disk state: keep the semantic group record until commit and reconstruct affected in-memory adapters on failure. Cross-shard Undo is coordinated by the engine, not assumed from one library stack. Yrs documents origin/group controls, but its manager alone is not the application contract [E3].

## 7. MCP compatibility and additive features

Preserve the 50 tools and supported argument/result behavior in the current [MCP map](../MCP_PARITY.md), with explicit document targeting, scoped aliases, safe file access, attributed Undo and transport authentication. Build adapters around semantic commands, not GUI automation. Port actual runtime validation as well as JSON schemas. `screenshot`, measurement and exports run headlessly; UI selection never silently chooses a different target.

New capabilities use negotiated extensions: `identity.resume/1`, `workspace.organization/1`, `comments/1`, `tokens/1`, `code.static/1`, `snapshot-package/1`, and `effects.registry/1`. They cover authenticated principal resumption, folders/archive, anchored discussions/resolve, token modes, static React/CSS/Tailwind output, semantic package ingestion and reviewed shader parameters/fixed-time rendering. They are **proposed additions**, not existing tools. `capabilities` returns extension versions and supported operations; unknown required extensions fail explicitly. The capability matrix freezes public tool names/schemas before each extension ships.

## 8. Proposed protocol defaults

This is the single source for protocol/admission limits. Resource-cache and process budgets belong to [the implementation guide](IMPLEMENTATION_GUIDE.md). All limits are negotiated/versioned downward where necessary; relaxing them requires tests.

| Name | Native v1 default |
| --- | --- |
| MCP request body | 1 MiB, before parsing |
| Ordinary same-document batch | 100 operations; 4 MiB normalized semantic payload after local resource resolution |
| Inline response body | 512 KiB; paginate or return a resource/job |
| Peer fragment payload | 256 KiB; framing overhead has a separate bounded parser limit |
| Ordinary transaction envelope | 4 MiB semantic payload; larger imports use staged jobs |
| Live query snapshots | 4 per session; 60-second idle expiry; earlier budget eviction reported |
| Ordinary queued writes | 16 per author/document; fair workspace admission may refuse earlier |
| Request deadline | 30 seconds default, 60 seconds maximum ordinary request; jobs are explicit |
| Large result-body retention | 24 hours or until explicitly released; compact committed-key records retained for epoch |
| Schema nesting | 64 levels; semantic tree/import depth separately validated |

## 9. Required adapter experiments and references

Before M1/M3 integration, run one finite text/CRDT adapter suite: 24 fixed cases spanning concurrent inserts/deletes/marks, surrogate pairs, paragraph splits, relative anchors, selective Undo and crash/replay, plus all delivery permutations for each two-operation case and seeded four-replica fuzzing. Pin exact dependency versions/features and preserve fixtures. If stable-item range targeting is unavailable through the pinned public API, add a narrow audited adapter/fork with the same tests; do not substitute whole-string conflict resolution or defer coediting past completion.

Extend the existing idempotency qualification case with principal resumption: lose a committed response, restart the service, authenticate the registered principal and replay exactly once. Negative subcases use the same client name with a different credential, a revoked credential, a different principal reusing the key, and a legacy session restart. They must neither impersonate the original author nor claim its replay guarantee. Public transcripts redact all resume secrets.

Yrs mutable transactions commit when dropped and require exclusive document access [E1]. Candidate validation therefore precedes mutation, and failed unpublished adapters must be discarded/rebuilt as the storage contract specifies. Never write an imaginary rollback around a dropped Yrs transaction. Version/client-ID compatibility and old-file migration are separately qualified; sharing a library family does not make native schemas wire-compatible.

Primary references checked 2026-11-11:

- **E1:** [Yrs shared types, transactions and encoding](https://docs.rs/yrs/latest/yrs/).
- **E2:** [Yrs document options](https://docs.rs/yrs/latest/yrs/doc/struct.Options.html) and [stable relative positions](https://docs.rs/yrs/latest/yrs/struct.StickyIndex.html).
- **E3:** [Yrs UndoManager](https://docs.rs/yrs/latest/yrs/undo/struct.UndoManager.html).
- **E4:** [RFC 8785: JSON Canonicalization Scheme](https://www.rfc-editor.org/rfc/rfc8785.html).

These sources establish library behavior. The schemas, defaults, register/formatting policies and application guarantees above are proposed Oh My Canvas decisions and require implementation evidence.
