# Integration code review

Scope: the independently authored editor, its owned desktop/CRDT/MCP integration, build/package boundary and local publication exporter. This review does not inspect restricted retired source as an implementation template, prove legal independence, or claim exhaustive security analysis.

## Findings repaired before independent final review

- The host now retains the durable document baseline separately from an active visual preview. Actual incoming TLS edits followed by a native gesture commit and author Undo preserve both authors correctly.
- Navigation is exclusive across flush/open/mount. Bootstrap normalization validates nonce, document identity and revision, retries changed authoritative bases, persists before acknowledgement and creates no phantom Undo entry.
- Teardown attempts every release and reports failures while preserving earlier flush/mount errors. New lifecycle regressions lock this behavior.
- Imported CSS geometry shares canonical model geometry; native imported drag, percentage resizing and concurrent x/y merge are exercised separately. Native text measurement uses one bounded, invalidated cache.
- Assets use actual renderer-owned source previews. The real editable component library survives import, instance/property/variant/source propagation and fresh-process reopen.
- Package staging copies real locked runtime dependencies rather than a worktree node_modules symlink. Exact source/resource/notice readback and the packaged official-SDK MCP edit are separate checks.
- Publication export admits reviewed staged regular files only, validates links and notice hashes, rejects private paths/tokens and reseeds the two synthetic OMC documents into fresh CRDT history. Original private Git history remains preserved outside the new source repository.

## Independent final review follow-up

The fresh requested Astra review found additional lock handling, persisted user-font initialization and active SVG export issues. All three defect groups are repaired: 18 command and two mounted Find regressions, ten format regressions, and actual saved-font/reopen/asset-lifecycle and exported-link activation checks pass. The reviewer independently reran the original failing font and SVG scenarios successfully. The final current-source full run passes 339 editor tests, 38 host tests, 37 native UI cases, 32 browser cases/830 assertions, the actual library restart, four-peer TLS and all four host lifecycle checks. The rebuilt package smoke and 359 exact-byte comparisons pass. The independent final verdict is **APPROVE / architecture WATCH**, with no remaining blocking findings; see [ASTRA_FINAL_REVIEW.md](ASTRA_FINAL_REVIEW.md). The reviewer verified the 272-file post-fix source candidate and fresh runtime/package evidence. This integration record is supplementary to that review.

## Verification scope

See [VERIFICATION.md](VERIFICATION.md) for actual suite counts, browser/native/SDK/TLS/disk results and platform limits. Evidence is grouped by behavior; 435 granular requirement records are not 435 individually executed assertions. Public internet/NAT reachability, Windows/Linux execution, signing/notarization, physical input devices and power loss are outside the verified local macOS scope. No remote upload occurred.
