# Project provenance and third-party notices

The current project implementation under `editor/`, together with eligible original desktop host work, is independently authored project source under the root MIT license. Authoring inputs and planning source exposure are recorded in [PROVENANCE.md](docs/independent/PROVENANCE.md). The old inherited editor, paint helper, synthetic helper and copied tests are retired from the intended publication tree. This does not relicense historical company source, and the private Git history must not be uploaded as the new public history.

## External software

Dependencies retain their own notices and terms. The [inventory](docs/licensing/DEPENDENCIES.md) lists exact versions, categories and hashes. Complete top-level npm runtime license/notice texts are preserved in [THIRD_PARTY_LICENSES.txt](THIRD_PARTY_LICENSES.txt). `node-forge` is used under its permitted BSD-3-Clause alternative. MIT is the project implementation license, not a statement that every bundled work uses MIT.

Electron's MIT notice and complete `LICENSES.chromium.html` are copied unchanged into `dist/licenses/`. Native dependencies of the separately bundled CanvasKit WASM have a version/hash-pinned [notice collection](licenses/native/README.md), including ICU, FreeType, JPEG, WebP, Emscripten and embedded OFL Noto Mono. The build verifies the audited WASM and notice-file hashes before copying these notices. The collection is a conservative source-mapped superset, not a claim of a cryptographically reproduced binary or exact link-object SBOM.

Tabler Icons v3.50.0 (MIT), pinned to commit `6904efd245391ad396df17654738f52f6da8c40e`, supplies the editor and app interface icons. The [vendored subset](editor/ui/icons/tabler/README.md) preserves unmodified upstream SVGs, full copyright/license text, source URLs and SHA-256 hashes. The distribution includes its license and manifest in `dist/licenses/tabler-icons/`. This replaces the former Lucide dependency; the app brand logo is unchanged.

The native editor adapts code from [FigCraft v0.17.0](https://github.com/storytold/figcraft/tree/5bc71c1a2c860adc106801751faf45920e2e46c9/crates/ui-egui/src) under the [upstream MIT license](docs/licensing/figcraft-LICENSE-MIT.txt). Sources include `canvas/render.rs` for overscan, `tabs.rs` for tab sizing and overflow, `toolbar.rs`, `panels/layers.rs` and `icons/draw.rs` for the dock, rail and glyphs, and `widgets.rs`, `panels/right.rs`, `panels/layout_panel.rs`, `panels/paints.rs` and `panels/typography/fields.rs` for the inspector.

## Fonts and assets

The native Design inspector embeds Inter Regular from the [craft-fonts revision used by FigCraft v0.17.0](https://github.com/storytold/craft-fonts/tree/37827adc41fd165f9a9234ac40f94dbad353aa69/fonts/inter), with its [OFL 1.1 license](native/apps/omc-desktop/fonts/OFL.txt).

Runtime IBM Plex Sans and Noto Sans KR remain OFL-1.1 with license copies in `public/fonts/`. The five unchanged Pretendard/Noto Sans KR test-fixture files retain [their notices](fixtures/fonts/THIRD_PARTY_FONT_NOTICES.md), full OFL text, source URLs and hashes. Noto Color Emoji comes from its OFL-licensed development package. Font rights are not replaced by the project MIT grant.

The user confirmed on 2026-11-03 that the supplied app icon was directly created/generated and may be publicly redistributed. Project design-system data was authored for this app. Current screenshots show the independent engine, including the real component library and rendered Assets previews; earlier private-baseline screenshots are not current verification evidence.

## Publication and evidence boundary

The [MIT publication guidance](docs/licensing/MIT_READINESS.md) describes eligible project source, retained upstream terms, recorded source exposure and the separate clean-history snapshot. The current package passed smoke and provenance checks, including native notice hashes and exact current bytes. Those checks do not prove legal clearance, exhaustive source independence or a reproducible native build.

This repository starts from the reviewed independent snapshot and has a separate Git history. The retired company-source repository and its history are not included. The first hosted repository is private. See the recorded independent review and source manifest for the actual scope; this is not legal clearance. Consult the [current verification record](docs/independent/VERIFICATION.md) for the actual functional evidence and remaining limits.
