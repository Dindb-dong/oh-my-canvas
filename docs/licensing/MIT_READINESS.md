# MIT publication guidance

The root [MIT license](../../LICENSE) applies to eligible independently authored Oh My Canvas implementation and contributions. The active engine is under `editor/`; the previously inherited company implementation, paint helper, and copied tests are retired from the intended publication tree. The license does not grant rights over that retired source or the original private Git history.

No source, history, or package has been uploaded. Current verification status and unresolved acceptance work are recorded in [VERIFICATION.md](../independent/VERIFICATION.md), separately from the question of who can grant a license.

## What the license covers

| Material | Treatment |
| --- | --- |
| Eligible original host, engine, documentation, scripts and new tests | Root MIT terms, with the applicable copyright notice retained |
| Third-party npm packages | Their own license and notice terms; see the [dependency inventory](DEPENDENCIES.md) and [runtime notice texts](../../THIRD_PARTY_LICENSES.txt) |
| CanvasKit, its candidate native dependencies and embedded Noto Mono font | Version/hash-pinned [native notices](../../licenses/native/README.md), including the required FreeType and JPEG credits |
| Electron, Chromium and bundled native components | Supplied Electron MIT and complete Chromium notices copied into the distribution |
| Application and test fonts | Original OFL terms, copyright notices and reserved names; see the [fixture manifest](../../fixtures/fonts/font-manifest.json) and [font notices](../../fixtures/fonts/THIRD_PARTY_FONT_NOTICES.md) |
| User-supplied application icon | The user confirmed on 2026-11-03 that they created/generated it and permit public redistribution |
| Synthetic design-system documents and HTML sources | Project-authored compatibility data, retained with their eligible embedded assets; full-library runtime acceptance is tracked separately |
| Retired company source and original private Git history | Excluded; the MIT grant does not relicense them |

A permissive dependency expression does not replace its actual license text. `node-forge` offers a BSD alternative, which this project selects and preserves. The inventory does not identify a mandatory GPL-only npm runtime dependency, but npm metadata alone cannot establish compliance for every precompiled native component.

## Authoring evidence and its limits

The [provenance ledger](../independent/PROVENANCE.md) records implementation inputs and source exposure. Planning participants inspected the previous implementation. This is therefore not described as an unexposed clean-room effort. Workers were required to implement from recorded behavior and integration contracts rather than copying, translating, renaming or mechanically transforming restricted source.

A fresh local comparison against the two inspected source checkouts found six exact matches: the common OFL text and five unchanged licensed font binaries. It reported no source-code exact matches or token-overlap candidates at its thresholds. That is limited evidence from the scanned working files, not proof of independent authorship, complete historical coverage, contractual ownership, or legal clearance. The private comparison records are excluded from the publication snapshot.

Passing tests establish the tested behavior, not copyright ownership. An MIT grant must come from a party entitled to grant it. Appropriately licensed external materials retain their own terms even when the surrounding application uses MIT.

## Prepare the exact publication tree

Use the [local publication policy](../independent/publication-policy.md) and its allowlisted exporter. It creates a separate local source snapshot from reviewed staged files; it does not upload anything or copy private Git metadata.

Before treating that snapshot as ready:

1. Review every selected source, test, document and asset against the authoring ledger. Preserve upstream notices and confirm that no retired implementation or copied test has returned.
2. Include current verification evidence and resolve documentation links only to files selected for the snapshot. Earlier private-engine audit reports, screenshots and approval counts remain in private history rather than serving as current evidence.
3. Inspect synthetic portable documents, their embedded assets and their newly seeded history. Removing a visible layer does not scrub an old CRDT history.
4. Verify the final source, build, notices and package together. Check the [current result and open-work record](../independent/VERIFICATION.md); a passing smaller journey does not imply full-library acceptance or final independent-review approval.
5. Initialize new Git history only in the reviewed separate snapshot. Never upload the original private history, old branches, refs or worktree metadata. Removing restricted files from the current tree does not remove them from earlier commits.

See [architecture and replacement boundaries](REPLACEMENT.md) for the maintained source layout. The root license, provenance ledger, upstream notices and actual publication contents must stay consistent as the application changes.
