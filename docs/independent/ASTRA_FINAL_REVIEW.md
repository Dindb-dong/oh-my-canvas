# Independent engine: final engineering review

Review date: 2026-11-03. Requested reviewer: GPT-6 Astra, high reasoning. This review uses the local `code-review` workflow; no source or evidence was uploaded. The reviewer did not read retired restricted implementation or its tests.

**Verdict: APPROVE. Architectural status: WATCH.** All three accepted runtime defect groups and the publication screenshot finding are closed in the reviewed candidate. No remaining actionable blocker was established. Approval covers the inspected engineering/source-deliverable scope; it is not a legal-clearance opinion or authorization to upload. Runtime source was frozen at `771a8de`, and every candidate `editor/`, `core/`, `electron/`, `src/` and `cli/` file matched the reviewed integration tree.

## Scope and method

The review inspected the new `editor/` implementation, retained host boundaries under `core/`, `electron/`, `src/` and `cli/`, build/export policy, current tests and reports, dependency/native notices, and the separately exported source preview. Review emphasis was transaction/preview/remote projection correctness, lock enforcement, font/layout lifecycle, safe import/export, actual editable component data, and separation from private source/history.

The reviewer read the behavior and provenance contracts, inspected substantive implementation paths, reproduced candidates locally, and checked fixes against the original failing scenario. The review is bounded rather than an exhaustive line-by-line security assessment or universal rendering equivalence proof. The 31 groups / 435 granular mappings remain scoped group evidence, not 435 individually asserted passes.

## Accepted findings and closure evidence

### R1 — P2: command and Find mutations bypassed layer/ancestor locks

**ACCEPT; repaired and independently verified.** The original opacity and remove-layout command bodies iterated all selected records after checking only that some editable selection existed. In the reviewer's direct execution, selecting a locked frame and an unlocked frame then running `layer.opacity-5` changed both to 0.5; `layout.remove` removed both layouts. Locked layers are selectable in the layer tree. Explicit rename/path targets and Find replacement had related gaps; Find checked only the layer's own lock.

The repaired [command registry, lines 147–162 and 204–222](../../editor/commands/index.ts#L204) uses actual editable targets for opacity/layout/rename/path changes, preserves own unlock/unhide behavior, and checks ancestor state while processing lock/hide changes. [Find replacement, lines 1153–1158](../../editor/ui/index.ts#L1153) now calls the same ancestor-aware `isEditable` predicate. The reviewer independently ran the focused command and inspector/Find suites: **108 tests passed across two files**, including mixed own/ancestor locks, explicit targets, asynchronous rename, Replace/Replace All and Undo. See [command regressions](../../editor/__tests__/foundation.commands.test.ts) and [UI lock regressions](../../editor/__tests__/ui-inspector-locking.test.ts).

### R2 — P2: saved fonts were registered after first layout

**ACCEPT; repaired and independently verified.** The facade originally measured the document before `mountWorkspace` registered saved font assets. A real isolated Electron reproduction persisted an IBM Plex font under a synthetic family name and opened auto-sized text. After mount/flush, geometry was **618.765625 × 48**, while reapplying layout after the font loaded produced **648.125 × 51**. A bootstrap could therefore persist fallback-font geometry and the next edit could change layout unexpectedly.

The [facade, lines 35–56](../../editor/index.ts#L35) now registers asset fonts before its first ensure/layout pass and observes document-asset changes. The [font catalog, lines 20–64](../../editor/fonts/index.ts#L20) separates permanent and document-owned faces, synchronizes projected assets, and prepares local imports before the transaction with cleanup on failure. The [clipboard path](../../editor/interaction/clipboard.ts) uses that preparation boundary rather than permanently registering an uncommitted asset. The reviewer reran the real Electron scenario: initial and post-load reflow geometry both equal **648.125 × 51**. Live projection/Undo/Redo coverage is separately recorded by the rendering suite.

### R3 — P2: preserved SVG animation reactivated an unsafe link on export

**ACCEPT; repaired and independently verified.** A preserved unsupported SVG `switch` could contain an anchor and SMIL animation that changed its `href` to a JavaScript URL after sanitization. The reviewer passed this through the actual importer and scene serializer, opened the resulting SVG in a separate sandboxed browser document without the application's CSP, and clicked the link. A harmless in-memory sentinel changed to 1. The application CSP narrowed the in-app impact but did not protect a separately consumed exported SVG.

The [markup policy, lines 11–20](../../editor/formats/markup.ts#L11) and [raw SVG scene sanitizer, lines 463–492](../../editor/render/scene.ts#L463) now share the static-element and resource-URL policy. Import rejects SMIL mutation elements, including namespaced forms; raw JSON/OMC picture rendering strips them before screen/export serialization, while ordinary static unsupported pictures remain supported. The reviewer independently reran both routes: the import is rejected, direct raw-picture output contains no animation, and clicking the exported anchor in a separate sandboxed document leaves the sentinel unset and `href` equal to `#`. See [format regressions](../../editor/__tests__/formats.test.ts) and [browser regressions](../../editor/__tests__/render-browser.ts).

### R4 — P2: an eligible screenshot exposed private machine paths

**ACCEPT; repaired and independently verified.** The first publication preview's MCP screenshot visibly contained absolute home/worktree paths, and its collaboration screenshot retained the real machine's default display name. Text scanners did not detect the PNG content. The reviewer verified that the final 272-file manifest omits both the MCP and native export-error images and directly inspected the regenerated collaboration image: its participants are the synthetic Host and Peer names, with no invitation token displayed. The separate [publication audit](PUBLICATION_AUDIT.md) records the earlier preview and its bounded audit scope.

## Architecture and feature assessment

The replacement has explicit model, transaction, geometry, layout/render, component/style, interchange, interaction and host boundaries. The host remains the durable CRDT authority; local previews rebase against incoming projections and commit through the same persisted operation path. Commands, prepared clipboard imports and MCP writes share isolated transactions rather than an inherited fallback implementation. The component workflows operate on editable source/instance records, not screenshots substituted for document objects.

**Architectural status: WATCH.** No architectural blocker was established in the reviewed paths. The wide opaque `Data` contract, substantial UI module and sampled feature evidence warrant continued targeted regression coverage, especially at lifecycle boundaries such as those found here. A full-library replay and group-level matrix cannot prove every font, variant, rendering combination or individual granular requirement. These are limits on the claims, not grounds to invent a missing feature without evidence.

## Source, license and publication boundary

The process is correctly described as a source-exposed replacement: planning participants saw the retired implementation, while implementation lane non-exposure is recorded as worker-reported evidence. The [provenance ledger](PROVENANCE.md) does not claim an unexposed clean room or legal certainty. Retained host authorship, new implementation provenance and similarity comparisons are separate evidence categories. The fresh comparison reported no code exact matches or sparse overlap leads; it excludes private history and has explicit thresholds, so it cannot establish legal independence.

The final local review candidate was independently checked by this reviewer: all **272 manifest-listed files / 12,400,687 bytes** matched their SHA-256 values, byte lengths and regular-file modes. No forbidden vendor/apps/runtime/history path was listed; no dependency, generated distribution or release directory was present. Git had **zero commits and no remotes**. Both synthetic OMC records retained the reviewed fresh-history transformations. The independently recomputed snapshot digest is `589595e5e7ec83880cd2eab0c293bc5da6b8eaf60fe0dc396bed8f907109eb14`. Portable documentation-link validation and the text/privacy guard passed for **202 textual files**. This records the inspected candidate; adding this completed review and final status documentation produces a different final-export digest, which the parent must record without silently changing runtime source or copying private history.

The inspected dependency routes preserve complete collected npm notices, application/fixture OFL terms, Electron/Chromium notices and the hash-pinned CanvasKit native notice collection. That native collection is documented as a conservative superset rather than an exact linked-object SBOM or reproducible-build attestation. The root MIT license does not relicense third-party works or retired company implementation. Icon redistribution relies on the user's explicit authorization. The [publication audit](PUBLICATION_AUDIT.md), [dependency inventory](../licensing/DEPENDENCIES.md), [native manifest](../../licenses/native/manifest.json), and [package byte checker](../../scripts/check-package-provenance.mjs) provide distinct evidence.

This review neither authorizes remote publication nor grants rights over unavailable company code. No remote upload, installation over the existing application, or private-history deletion occurred in this review.

## Final evidence checkpoint

The reviewer inspected the refreshed raw reports in the final candidate and independently reproduced the repaired defects as described above. The parent supplied the final full regression/static/build run; those aggregate runs are distinguished from the reviewer's own focused execution.

| Evidence | Final observed result |
| --- | --- |
| Parent full editor/host run | 339 editor tests and 38 host tests passed; syntax, strict TypeScript and build passed |
| Reviewer's focused lock run | 108 tests across command and inspector/Find suites passed |
| Actual native UI report | 37 passed; no page errors; refreshed 2026-11-03 12:31:33 UTC |
| Actual browser report | 32 cases / 830 assertions passed, no failures/page errors, including saved-font reopen/projection ownership and SVG export safety; minimized/background capture passed |
| Additional metric-cache evidence | Eight performance/cache assertions; bounded reuse/invalidation evidence remains separate from the browser case count |
| Actual four-peer TLS report | Passed, four clients and 10 recorded checks; no renderer errors; refreshed 12:31:21 UTC |
| Host lifecycle report | Four checks passed, including local preview plus incoming remote projection, durable commit and author Undo; refreshed 12:32:06 UTC |
| Actual editable-library report | Passed import/edit/source propagation/fresh-process reopen, 170 variants / 254 import bindings and 16 actual previews; no page errors; refreshed 12:32:18 UTC |
| Packaged app smoke | Passed six checks against the final local macOS arm64 app; refreshed 12:32:18 UTC |
| Package provenance | 359 exact-byte comparisons, zero mismatches, passed; refreshed 12:32:28 UTC |
| Final review-candidate manifest | 272 files; hashes/sizes/modes and recomputed digest match; portable links/text guard pass; private screenshots excluded |

The package report identifies ASAR SHA-256 `58d3167828105ebd7230ea0090aa3bf24331cdcf3e076b5cf90e369b03acbef6`. The current durable official-SDK-to-commit/fsync benchmark reports 10 measured edits after warmup, median **515.683 ms**, nearest-rank p95 **603.409 ms**; it is separate from renderer-only cache timing. Raw reports and scope notes are linked from [VERIFICATION.md](VERIFICATION.md).

**REJECT as unsupported conclusions:** that a no-match similarity scan proves independent authorship; that 435 matrix entries were all individually asserted; that loopback peers establish internet/NAT reachability; or that permissive npm metadata clears every native distribution obligation. None is used to justify this approval.

**DEFER as stated coverage limits, not unresolved accepted defects:** Windows/Linux execution, external internet/NAT, signing/notarization, physical-device IME/touch, real power loss, an exact native linked-object SBOM/reproducible-build attestation, and exhaustive legal clearance. The final export should include this completed report and synchronized gate-status documentation, then be read back by its own manifest. No further runtime repair is requested by this review.
