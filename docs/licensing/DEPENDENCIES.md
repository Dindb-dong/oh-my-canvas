# External dependency inventory

## Direct dependencies

Resolved versions from the lockfile and installed package metadata; ranges in package.json may differ.

| Package | Version | Role | Declared license |
| --- | --- | --- | --- |
| `@fontsource-variable/ibm-plex-sans` | 5.3.0 | Runtime | OFL-1.1 |
| `@fontsource-variable/noto-sans-kr` | 5.3.1 | Runtime | OFL-1.1 |
| `@fontsource/noto-color-emoji` | 5.3.2 | Development | OFL-1.1 |
| `@modelcontextprotocol/sdk` | 1.32.2 | Runtime | MIT |
| `@types/node` | 24.19.2 | Development | MIT |
| `canvaskit-wasm` | 0.42.0 | Runtime | BSD-3-Clause |
| `electron` | 45.2.1 | Development | MIT |
| `electron-builder` | 26.18.0 | Development | MIT |
| `esbuild` | 0.25.12 | Development | MIT |
| `jsdom` | 28.1.0 | Development | MIT |
| `playwright` | 1.64.1 | Development | Apache-2.0 |
| `selfsigned` | 3.0.1 | Runtime | MIT |
| `typescript` | 5.9.3 | Development | Apache-2.0 |
| `vite` | 7.3.7 | Development | MIT |
| `vitest` | 4.1.12 | Development | MIT |
| `ws` | 8.22.1 | Runtime | MIT |
| `yjs` | 13.6.33 | Runtime | MIT |

## Counts and interpretation

- Direct runtime dependencies: **7**; direct development dependencies: **10**.
- Lockfile package locations: **546**, representing **500 distinct name/version pairs**. This includes platform-specific optional packages and duplicate/nested versions.
- Non-dev lockfile locations: **105**; development-only locations: **441**. This classification is npm metadata, not a measurement of the tree-shaken JS bundle.
- Locally installed locations: **470**; all **105** non-dev locations are installed and have a top-level license/notice text. Optional packages for other platforms account for many absent development entries.
- Electron is declared as a development dependency but its runtime is shipped with the application. Chromium/Node and their native libraries are outside the npm package count.
- Package results belong to the exact built artifact. The [current verification record](../independent/VERIFICATION.md) records the passing current local package smoke and exact-byte provenance checks; the existing installed app has not been replaced by this task.

| Runtime lock metadata | Package locations |
| --- | ---: |
| MIT | 90 |
| ISC | 8 |
| BSD-3-Clause | 4 |
| BSD-2-Clause | 1 |
| OFL-1.1 fonts | 2 |
| BSD-3-Clause OR GPL-2.0 | 1 |

The last row is `node-forge@1.4.2`. Its shipped LICENSE explicitly permits the BSD alternative; this project selects **BSD-3-Clause**, preserving its complete notice. The presence of “GPL” in that alternative expression does not mean a mandatory GPL-only runtime dependency was found.

The full development inventory also includes Apache-2.0, BlueOak-1.0.0, Python-2.0, CC0, MIT-0, 0BSD and WTFPL alternatives. These retain their terms. Neither a permissive npm metadata expression nor the absence of an unknown field proves all bundled native code has been cleared for release.

## Evidence and regeneration

- [Machine-readable inventory](dependencies.json): every lockfile location, exact version, declared/installed license, optional/dev flags and available notice-file hashes.
- [Runtime license texts](../../THIRD_PARTY_LICENSES.txt): complete top-level license/notice texts from all 105 installed non-dev package locations, unchanged.
- `node scripts/license-inventory.mjs` regenerates both files locally. It rejects missing runtime notice evidence or installed/locked version drift.
- `npm run build` additionally writes the consolidated npm notices and byte-identical Electron MIT/Chromium notices into `dist/licenses/`, which is included by the existing `dist/**` packaging rule. This does not publish or authorize release.
- `node --test tests/license-artifacts.test.mjs` verifies those generated distribution notices against their installed originals and all runtime inventory entries.

## Fonts and non-npm assets

The app bundles IBM Plex Sans and Noto Sans KR via Fontsource, under OFL-1.1; `public/fonts/` retains their licenses. Test fixtures contain five unchanged Pretendard/Noto Sans KR font files, with source URLs/hashes in the [trimmed manifest](../../fixtures/fonts/font-manifest.json) and the [fixture notices](../../fixtures/fonts/THIRD_PARTY_FONT_NOTICES.md). Noto Color Emoji comes from a development package with its own OFL license. OFL font terms remain applicable; fonts are not relicensed to MIT.

The icon was supplied by the user and edited for transparency. On 2026-11-03 the user confirmed they directly created/generated it and permit public redistribution. The design-system documents and HTML authoring sources are project-authored synthetic content retained as editable compatibility fixtures. Current editor, collaboration, MCP and document-browser screenshots were regenerated with the independent engine. The actual full-library workflow and its 16 previews passed; detailed limits remain in the [verification record](../independent/VERIFICATION.md). Eligible visual assets do not relicense retired implementation code.

## Release gaps

1. The inherited implementation has been retired from the intended source tree. The [publication guidance](MIT_READINESS.md) explains the boundary; current authoring evidence is in [independent provenance](../independent/PROVENANCE.md).
2. CanvasKit's native notices are now collected against the pinned 0.42.0 source recipe and actual binary hash in [licenses/native](../../licenses/native/README.md). The collection preserves known obligations as a conservative superset; it does not prove a bit-for-bit reproduced binary or exact linked-object inventory.
3. Electron's supplied `LICENSES.chromium.html` is copied intact for review/distribution. Its numerous native components are not reclassified as MIT and are not counted as npm packages. Their specific source/notice obligations still apply.
4. The current package passed smoke and provenance checks with no byte mismatches. Its native notices, audited WASM, fonts, Electron notices and current source/build bytes were checked. This is artifact evidence, not exhaustive native legal clearance. The installed `.app` has not been replaced; signing/notarization and the clean publication snapshot remain outside the completed package checks.

The independent renderer no longer imports `rbush`; its direct dependency and unused `quickselect` transitive dependency were removed from the lockfile without installing additional packages. Counts above describe the current graph, not the historical pre-replacement graph.

The vendored Tabler Icons v3.50.0 subset is a separate MIT-licensed asset dependency, not an npm dependency. See [source, hashes and license](../../editor/ui/icons/tabler/README.md).
