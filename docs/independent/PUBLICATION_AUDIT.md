# Local publication preview: dependency, asset and privacy review

Reviewed on 2026-11-03. This is a bounded read-only review of the first 271-file local publication preview, not approval of a later export or a legal-clearance opinion. No download, external service, restricted-source inspection, package build, installation or upload was performed for this review. Only this report was authored in the integration tree.

The reviewed `PUBLICATION_MANIFEST.json` records snapshot digest `2bb7b164bf1793ae953574b589f92c42ff526bc630c8dd42479a1d7558150d56` and source digest `da39f1dfb2974e5c9cab3e00ebe8e7e4359f4b161be4a67826e6a0628fe6bbe5`. These identify this preview, not the final snapshot after pending source fixes and evidence cleanup. See the [publication policy](publication-policy.md) and [current verification record](VERIFICATION.md).

## Initial-preview result and historical follow-up

The first preview's manifest payload hashes, regular-file modes, dependency/notice evidence, licensed fonts, icon consistency and fresh-history synthetic documents passed the checks below. Its screenshot issue prevented treating that exact preview as a finished public deliverable. The table is a historical finding record: the final review-candidate follow-up at the end of this report closes the screenshot and clean-candidate findings.

| Item | Observed result | Final-export action |
| --- | --- | --- |
| MCP configuration screenshot | The preview's `docs/qa/mcp.png` visibly contains machine-specific home/worktree paths in the configuration textarea. Text scanners cannot inspect this PNG content. No bearer token was visible in the inspected viewport. | The parent confirmed removal of this unlinked image from the final evidence allowlist. Verify that the final manifest omits it; this preview still includes it. |
| Collaboration screenshot | `docs/qa/collaboration.png` shows the machine's actual default display name for the host and peers. The view shows a loopback endpoint, not an invitation token or QR code. | The parent is regenerating real screenshots with isolated synthetic Host/Peer names before launch. Review the new capture before including it; do not treat a filename change as privacy cleanup. |
| Export-error screenshot | The inspected native UI error image contains a task-owned macOS temporary-path fingerprint. It contains no inspected home path or credential. | Decide whether that environment detail is appropriate for the final selected evidence, or recapture the real error using a portable synthetic destination. |
| Check-generated files | The preview working directory has a temporary `node_modules` symlink and 305 unmanifested generated files: 179 under `dist/`, 126 under `public/`. They are not part of the reviewed payload. | Perform a fresh allowlisted export after checks. Never copy this checked working directory wholesale or include the temporary dependency link/build outputs. |
| Source fixes and review | Additional source cleanup, final independent review and the final export are outside this preview audit. | Re-run final manifest/privacy/notice validation after the fixes and evidence recapture. No approval of the current public history is implied. |

The parent has acknowledged the screenshot findings and planned the indicated allowlist/capture changes. This report does not claim those future artifacts have already been checked.

## Manifest and new-history boundary

Direct checks of all 271 listed payload files found:

- **12,836,648 bytes**, with every SHA-256, byte length and recorded file mode matching the manifest.
- Every listed payload is a regular file; no listed symlink, dependency directory, compiled distribution, release, inherited vendor/apps tree, credential directory or private Git state was present.
- Recomputed snapshot digest matches the manifest. The manifest itself is generated metadata and is not one of its own file records.
- The initialized Git directory contained only its configuration and HEAD files, no object files or commits, and no remote section. This is a new unborn branch, not a copy of the original private history.
- Production font binaries and CanvasKit WASM are absent from the manifest, as intended; the build recreates them from locked packages. Their subsequently generated working files are outside the source payload.

The original private repository and its history were not copied or searched by this review. A final initial commit must come only from the reviewed new snapshot. These observations do not authorize publication or imply a future export has identical contents.

## Dependencies and notices

The preview's package metadata, lockfile and [dependency inventory](../licensing/DEPENDENCIES.md) agree:

| Inventory | Count |
| --- | ---: |
| Direct runtime dependencies | 8 |
| Direct development dependencies | 10 |
| Lockfile package locations | 547 |
| Distinct package name/version pairs | 501 |
| Non-development locations | 106 |
| Development-only locations | 441 |
| Locally installed locations in the recorded environment | 471 |

Using the parent's temporary dependency link for read-only inspection, all 106 runtime package versions matched the lockfile. Every recorded top-level runtime license/notice file matched its stored hash and size. The [consolidated runtime texts](../../THIRD_PARTY_LICENSES.txt) and inventory remain part of the source payload. This is lockfile/location evidence, not a count of tree-shaken application dependencies.

The runtime metadata categories are MIT (90 locations), ISC (8), BSD-3-Clause (4), BSD-2-Clause (1), OFL-1.1 (2), and BSD-3-Clause OR GPL-2.0 (1). The project selects node-forge's permitted BSD alternative and preserves its notice. Those expressions do not replace the actual upstream terms or turn third-party works into MIT project code.

The [native notice manifest](../../licenses/native/manifest.json) preserves 38 recorded notice/evidence files across 17 logical native/toolchain component groups. All 38 hashes and byte lengths matched in this preview. The bundle includes the complete collected ICU notice, FreeType FTL selection and credit, JPEG credit, WebP patent notice, Wuffs copyright/license, Emscripten/system-library texts and embedded Noto Mono OFL text. This is the existing conservative source-mapped collection, not an exact linked-object SBOM, reproducible-build attestation or universal legal-compliance claim.

Electron's development-dependency classification does not remove its distribution obligations. The build copies the installed Electron MIT and full Chromium notices into the application alongside npm/native notices; [package provenance checks](../../scripts/check-package-provenance.mjs) must be rerun against the final app. The source snapshot alone is not an application bundle or proof of its final contents.

## Fonts, icon and synthetic assets

All five unmodified [fixture font files](../../fixtures/fonts/font-manifest.json) matched their recorded hashes and sizes; their 13 face records reuse those five binaries. The [font notices](../../fixtures/fonts/THIRD_PARTY_FONT_NOTICES.md), full OFL text, source URLs and reserved-name notices are retained. Application font notices are present under `public/fonts/`; installed Fontsource and runtime distribution obligations remain separate from the project MIT license.

Both icon copies are identical, SHA-256 `8fb9514372409500286b416a48756f7ec2bc837c757ac4e6584901f92196e583`. The user confirmed that they created/generated the icon and permit public redistribution. This review relies on that explicit confirmation rather than inferring rights from the bitmap.

The two portable design documents were decoded through the existing host decoder. Their source bytes match the manifest's source hashes; their recorded source-document hashes match; the exported current documents are semantically equal to their source documents. Object-key order may change on decode, so a newly serialized decoded object is not a substitute for the recorded source-document digest.

| Synthetic portable document | Current shapes | Components | Fresh state fields/structs | Original deleted structs → exported |
| --- | ---: | ---: | ---: | ---: |
| UI Kit | 48 | 0 | 630 | 186 → 0 |
| Component Library | 1,065 | 172 | 14,862 | 989 → 0 |

Both exports use portable format v2, have exactly one fresh Yjs client, no deleted structs, no overwritten-field chains, no stored thumbnail, and a field/struct count equal to the flattened current document. The UI Kit's original five clients were reduced to one. These checks support current-content reseeding rather than carrying the original edit history into the snapshot; they do not claim that every possible document encoder is history-free.

The decoded contents contain synthetic UI labels and geometry. Recursive inspection found no external URL hosts, embedded data-URI images/other payloads, private home paths, contact records, the checked student identifier, private-key headers or common cloud/GitHub/API-key patterns. Current hidden fields and component data were included in this inspection rather than considering only visible layers.

## Privacy checks and limits

Text-pattern scanning covered all manifest-listed textual files for private home paths, private-key headers and common credential patterns. It returned no matches. Email addresses found in licensing material are upstream attribution/contact notices; the remaining lockfile email is package metadata. The root MIT copyright holder is intentionally public attribution. Such names and notices must not be removed indiscriminately as if they were leaked credentials.

Direct visual review covered the actual Assets-library image, collaboration, MCP configuration, packaged-app, populated library, four-peer, native export-error and rendering-gallery images. It found the screenshot issues above. This was a bounded visual sample, not OCR/exhaustive inspection of every pixel, image codec, PDF metadata field or possible encoded secret in all 42 selected evidence paths. Binary-format and credential-pattern coverage is necessarily limited.

Final inclusion still requires the source owner to review eligible synthetic assets, the recaptured privacy-clean evidence and any new source changes. Source comparisons and passing tests are useful evidence, not proof of ownership, absence of all restricted material, universal notice completeness or legal clearance. The [provenance ledger](PROVENANCE.md) and upstream licenses continue to define the recorded boundary.

## Privacy remediation update — fresh four-client capture

After the initial preview review, the parent removed `docs/qa/mcp.png` and the unlinked `docs/qa/independent-ui/desktop-export-error.png` from the intended public evidence allowlist. These images may remain private local evidence; they must not appear in the final public manifest. This records the parent's selection change, not a claim that the final export has already been inspected.

The actual four-client Electron/TLS acceptance was rerun after the final font/cache and sanitizer fixes and passed with no renderer errors. The new `e2e-result.json` records completion at `2026-11-03T12:31:21.712Z`. Each isolated test profile received synthetic participant names before application launch. No raster editing or masking was used to manufacture the result.

Direct visual inspection of the regenerated collaboration and four-peer PNGs confirms synthetic **Host**, **Peer 1**, **Peer 2**, and **Peer 3** identities (and synthetic peer layer labels), without the previous default account name. The collaboration view shows only a loopback endpoint; no home/worktree path, invitation bearer string, token or QR code is visible in the inspected images. This resolves the identified privacy issue in these current captures, within the limits of visual inspection.

| Recaptured evidence | SHA-256 inspected |
| --- | --- |
| `docs/qa/collaboration.png` | 632fea0e5501b61416eefdbbcf39b916dc7783644c189b6aa0bf444707703f07 |
| `docs/qa/four-peers.png` | 5cdb8f7b5c1d507ff1bb27bf5da9c4899454d2eea98aeb39cd10241e780f8dd5 |

Final publication still requires the parent to verify the new export's manifest against these recaptured hashes, confirm both excluded images are absent, and exclude temporary dependency/build outputs. The first-preview manifest/digest and dependency/OMC checks above remain specific to that earlier candidate. A final independent review and final manifest audit must be recorded after their actual completion; this update does not grant legal clearance or approve an unexamined final snapshot.

## Final review-candidate closure

The completed [independent engineering review](ASTRA_FINAL_REVIEW.md) records **APPROVE**, with architectural status **WATCH**. All accepted runtime defect groups and the publication screenshot finding were closed in the reviewed candidate; no remaining actionable blocker was established within that scope. WATCH preserves the stated architectural/coverage limits rather than an unresolved accepted defect.

The reviewer independently checked the refreshed **272-file / 12,400,687-byte** source candidate: all recorded SHA-256 values, sizes and regular-file modes matched; the recomputed digest matched; portable links and the text/privacy guard passed. No forbidden vendor/apps/runtime/history path, dependency link, generated distribution, release directory or unmanifested payload was found. The new Git history had zero commits and no remotes. Both synthetic portable documents retained the reviewed fresh-history transformations.

The final reviewed manifest omitted the MCP configuration screenshot and native export-error screenshot. The reviewer directly inspected the real regenerated collaboration capture and verified synthetic Host/Peer names without an invitation token. The earlier default-name/path-bearing PNG findings are therefore **closed for the reviewed candidate**, and the first-preview table above is historical evidence rather than an outstanding publication defect.

Runtime source was frozen at the reviewed implementation checkpoint; the candidate's engine and host files matched the integration tree. Adding this completed review and synchronized status documentation produces a new final-export digest. The parent will read back that final source deliverable against its own updated manifest; this report intentionally does not claim a self-referential digest or silently substitute the earlier candidate digest for it.

Approval is bounded engineering/source-deliverable evidence. It does not authorize upload, grant rights over private company history, prove universal functional equivalence or establish legal clearance. Upstream terms, platform/network limits and the conservative native-notice scope remain in force. No original private history has been uploaded.
