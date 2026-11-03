# Independent engine verification

Runtime implementation and local publication engineering review are complete. The [Astra final review](ASTRA_FINAL_REVIEW.md) concludes **APPROVE**, architectural status **WATCH**, with no open actionable blockers. The accepted lock, saved-font and exported-SVG defects were repaired and independently reproduced successfully; the screenshot privacy finding was also closed. This is scoped engineering approval, not legal clearance or authorization to upload.

## Current evidence

| Scope | Final result | Evidence |
| --- | --- | --- |
| Editor domain/session/facade | 339 tests across 12 files; check and build pass | `editor/__tests__/`; lane reports; parent final run |
| Host regressions | 38 tests pass | `tests/`; parent final run |
| Native UI | 37/37 pass, zero errors | [report](../qa/independent-ui/report.json) |
| Browser layout/render/export | 32 cases / 830 assertions pass; eight separate startup/cache assertions | [review](../qa/independent-render-review.md), [results](../qa/independent-render-results.json), [profile](../qa/independent-render-library-profile-optimized.json) |
| Editable library | Actual 1,065-object import, 170 variants / 254 bindings, editable instance/property/variant/source propagation and process restart; 16 actual previews and contained labels before/after reopen | [report](../qa/independent-library-e2e/report.json) |
| Host lifecycle | Four checks pass, including native gesture receiving incoming TLS projection, durable commit and author Undo preserving remote edit | [report, 12:32:06.994Z](../qa/independent-host-result.json) |
| Four-peer TLS | Actual Electron peers pass edits, Undo, images, SDK stdio, exports, offline rejoin, durable reopen and portable merge | [report, 12:31:21.712Z](../qa/e2e-result.json) |
| Latest-source macOS arm64 package | Smoke pass at 12:32:18.261Z; 359 byte comparisons, zero mismatches at 12:32:28.485Z | [smoke](../qa/packaged-result.json), [provenance](../qa/package-provenance.json) |

Package ASAR SHA-256: `58d3167828105ebd7230ea0090aa3bf24331cdcf3e076b5cf90e369b03acbef6`. The eight startup/cache assertions are distinct from the 830 functional assertions and predate final security additions; production cache behavior was unchanged. Earlier private-engine results do not verify this source. The historical regression barrier is recorded separately in [implementation-complete.md](implementation-complete.md).

## Durable performance

The actual official SDK stdio → Electron → renderer → commit/fsync → response benchmark used the 1,065-object library, one warmup and ten measured samples. At 12:33:19.265Z, median was **515.6826245 ms** and nearest-rank p95 **603.409417 ms**. [Raw measurements](../qa/editor-performance.json) supersede earlier benchmark values. Renderer-only cache timings are a different measurement.

## Independent review and publication boundary

The final reviewer checked the **272-file / 12,400,687-byte** candidate, digest `589595e5e7ec83880cd2eab0c293bc5da6b8eaf60fe0dc396bed8f907109eb14`, including every payload hash/size/mode, runtime-source agreement, history/remote exclusion and selected PNG privacy. [PUBLICATION_AUDIT.md](PUBLICATION_AUDIT.md) supplies the bounded audit context. The fresh comparison covered 447 files: zero code exact matches, zero token-overlap leads and six licensed font/text matches. Source exposure and limitations remain explicit in [PROVENANCE.md](PROVENANCE.md).

The final delivery export has a different digest because it includes approved review/status documents. Its `PUBLICATION_MANIFEST.json` supplies that separate payload digest; this document embeds no circular final self-hash. Parent performs fresh final payload/hash/mode readback and an English initial commit in new history with zero remotes. These are local delivery steps; engineering review gates are closed. The private original history is preserved. No upload has occurred or is authorized by review approval.

## Evidence limits

All 31 groups / 435 granular mappings use scoped group evidence, with **zero individual 435-feature pass claims**. Unit boundaries include explicit view/font/durability doubles; actual browser/native/SDK/TLS/disk evidence is identified separately. The SVG reproduction includes five trusted exported-link clicks after SMIL scheduling, with sentinel zero. Saved-font geometry uses an independent actual FontFace oracle; neither case proves every possible active-markup/font combination.

Native dialog choices use a test adapter while actual IPC/encoding/disk operations execute. Loopback peers do not establish internet/NAT reachability. Windows/Linux, signing/notarization, real power loss and physical IME/touch devices remain unverified. Architecture WATCH reflects broad opaque data and large UI/lifecycle surfaces needing continued targeted regression coverage; it is not an open blocker. Source comparison, notices and successful tests do not establish authorship, unexposed clean-room independence, universal equivalence or legal clearance.
