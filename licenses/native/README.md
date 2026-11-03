# CanvasKit native dependency notices

This directory accompanies the unmodified **canvaskit-wasm 0.42.0** full WASM binary. These third-party works retain their own licenses; the application license does not replace them.

This software is based in part on the work of the FreeType Team (https://freetype.org). FreeType is used under the FreeType License (FTL) option, preserved in `texts/freetype--docs__FTL.TXT`, together with the additional notices referenced by its `LICENSE.TXT`.

This software is based in part on the work of the Independent JPEG Group.

Wuffs: Copyright 2017 The Wuffs Authors. The complete Apache License 2.0 and the actual pinned source copyright header are preserved here. WebP's additional patent grant is preserved alongside its copyright license.

Embedded Noto Mono Regular, Version 1.00: Copyright 2007 Google Inc. All Rights Reserved. The embedded font remains under SIL Open Font License 1.1; its complete text is preserved in `texts/noto-mono--OFL-1.1.txt`.

## Evidence and scope

`manifest.json` records exact file hashes, byte lengths, upstream URLs, pinned dependency revisions, transformations, and the audited WASM hash. Pinned Skia DEPS, CanvasKit build configuration, and the retrieval log are retained under `provenance/`. Upstream files were fetched as data only. No upstream build script was run.

The retained collection covers Skia/skcms; ICU's **complete** Unicode-3.0 license and ICU third-party notices; HarfBuzz; Brotli; libpng; WebP; Wuffs; FreeType and the extra BDF/PCF/hash/gzip notices referenced in its license-selection file; libjpeg-turbo; Chromium's zlib; Emscripten; musl; libc++; libc++abi; compiler-rt; and the embedded Noto Mono font. The Emscripten 4.0.7 system library texts are a conservative toolchain notice set. WOFF2 support in the pinned FreeType source uses its FTL-covered decoder and Brotli; it is not evidence of separately linking Google's standalone WOFF2 library.

This is a conservative notice **superset**, not an exact linked-object or tree-shaken symbol inventory. The package version and WASM checksum identify the distributed artifact. The Skia release tag/DEPS and upstream build configuration provide a source-version mapping; they do not cryptographically establish that npm's WASM was reproducibly built from precisely those sources and flags. Embedded Noto metadata is directly observed in the WASM. Individual inclusion of every other candidate component and every ICU dictionary is not proven by these notice files.

Remaining verification limits: the npm artifact has no complete object-level SBOM/build attestation here; optional build variants and compiler runtime object selection were not independently rebuilt. Future changes to the binary, Skia source mapping, compiler SDK, or optional features require another native notice review. This collection is not a legal-clearance assertion. Separate npm, Electron/Chromium, and application-font notices are handled elsewhere in the distribution.

## Offline distribution

`scripts/native-license-notices.mjs` exports `writeNativeNotices(directory)`. It validates the installed package version, full WASM byte length and SHA-256, and every preserved notice/evidence file, then copies this directory's manifest and recorded files into `<directory>/native/`. A mismatched binary or modified notice fails packaging and requests a new audit. Packaging performs no network requests.

The retrieval log includes unsuccessful candidate paths (for example the old skcms path and FreeType's non-existent `docs/LICENSE.TXT`) so that corrected paths are traceable. Such failures are not placeholder notices: the actual skcms license and root FreeType `LICENSE.TXT` are included. The Wuffs mirror has no root `NOTICE` at the pinned revision; the upstream license and copyright header are included instead.
