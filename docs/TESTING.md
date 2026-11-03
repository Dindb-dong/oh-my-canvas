# Testing and verification

[README](../README.md) · [Contributing](../CONTRIBUTING.md) · [Current verification](independent/VERIFICATION.md)

Run the smallest relevant check first. Use synthetic files and isolated temporary profiles. Normal development does not require Docker, cloud credentials, a production database, or an external host.

## Commands

```sh
npm ci
npm run check
npm test
npm run test:editor
npm run build
npm run test:e2e
```

`check` runs JavaScript syntax checks and `tsc`. The TypeScript configuration does not enable comprehensive `checkJs` checking for the app's JS/MJS modules; core/runtime tests remain necessary. There is no `npm run lint` command in this repository.

The core suite uses real loopback TLS/HTTP sockets. An environment that prohibits socket listening must permit isolated local test sockets; do not count an `EPERM` run as a passing network test. Existing dependencies include the Electron/Playwright test runner; no separate browser download is required.

`node scripts/check-docs.mjs` checks repository links, anchors, images, shared README commands, issue-form YAML and SVG assets without starting the app or accessing the network.

## Choose checks by change

| Change | Start here | Add when relevant |
| --- | --- | --- |
| README, translations, issue/PR forms | `node scripts/check-docs.mjs`; rendered preview | No application rebuild for prose-only changes |
| Document, commands and geometry | `npx vitest run editor/__tests__/foundation.document.test.ts editor/__tests__/foundation.commands.test.ts editor/__tests__/foundation.geometry.test.ts` | `node --test tests/replica.test.mjs tests/storage.test.mjs`; actual save/reopen |
| Collaboration, bootstrap and protocol | `node --test tests/collaboration.test.mjs tests/bootstrap.test.mjs` | `npm run test:e2e`; `node scripts/independent-host-e2e.mjs` |
| MCP and author isolation | `node --test tests/mcp.test.mjs`; `npx vitest run editor/__tests__/mcp.test.ts` | `node scripts/independent-host-e2e.mjs` |
| Text, gestures, clipboard and Undo | `npx vitest run editor/__tests__/ui-text-session.test.ts editor/__tests__/ui-canvas-geometry.test.ts editor/__tests__/ui-clipboard-atomic.test.ts` | `node scripts/independent-ui-e2e.mjs` |
| Components, variants, styles and libraries | `npx vitest run editor/__tests__/components.test.ts editor/__tests__/styles-library.test.ts` | `node scripts/independent-ui-e2e.mjs`; `node scripts/independent-library-e2e.mjs` |
| Rendering, formats and native exports | `npx vitest run editor/__tests__/formats.test.ts`; `node --test tests/export-file.test.mjs` | `node scripts/independent-render-e2e.mjs` |
| Complete desktop journey | `npm run build` | `npm run test:e2e`; the four `independent-*-e2e.mjs` scripts above |
| Packaging | `npm run build`; `node scripts/package-local.mjs` | `node scripts/packaged-smoke.mjs`; `node scripts/check-package-provenance.mjs` |

Build before renderer/stdio E2E. The focused commands above are entry points, not a replacement for a broader run after changing a shared contract. E2E scripts may refresh tracked screenshots and JSON evidence in `docs/qa`; inspect the diff and retain only intentional evidence changes. They create and clean up their own temporary profiles.

### Packaging and installed profiles

`node scripts/package-local.mjs` copies the current source/build and locked runtime dependencies into task-owned `work/package-stage` as real files, then uses the already installed Electron runtime and electron-builder to write the local `release/` directory. It performs no dependency installation, publication, signing or installed-app replacement. `--prepare-only` stops after staging. Build first; the helper does not compile the editor.

Use `node scripts/packaged-smoke.mjs` to test that fresh local package with an isolated temporary profile, then `node scripts/check-package-provenance.mjs` for current-byte checks of source/build assets, native notices, WASM, fonts, Electron notices and the standalone CLI. The provenance check also rejects retired vendor/apps/fallback paths in the ASAR index; it does not inspect compiled-code ASTs or establish legal clearance. Packaging directly through a shared `node_modules` symlink can omit runtime packages; the staging helper avoids that problem.

Legacy `--installed` modes and default-profile scripts are not the current independent-engine acceptance route. Some target an existing `/Applications/Oh My Canvas.app` and its active document. Keep them outside routine checks; an installation check requires explicit scope and a review of its profile/data behavior. Do not replace the installed application or edit global MCP configuration merely to run a source regression.

## What a useful regression proves

- **Geometry:** actual editor-generated geometry remains consistent after concurrent X/Y, move/resize, rotation, flip and path changes. Check render bounds, not only scalar properties.
- **Undo:** explicit current author and user transaction survive the editor → IPC → replica connection. Cancellation does not resurrect an empty layer. Agents cannot mutate inside a live user transaction.
- **MCP:** two actual stdio processes retain separate authors; one cannot Undo the other's work.
- **Export:** compare wrapped SVG text to measured lines. Click both native export routes; verify a real file, cancellation, and a visible write error.
- **Import/storage:** reject malformed metadata before overwrite; list/reopen with damaged files and valid backups. Oversized edits must leave live state unchanged.
- **Validation cache:** repeated remote replacements do not retain irrelevant old payloads until a false capacity failure; local Undo still works afterward.

## Full-library performance

```sh
npm run build
node scripts/independent-library-e2e.mjs
```

This journey opens the real synthetic component-library fixture through the desktop host, exercises component workflows, and checks durable state with a task-owned temporary profile. The current 1,065-object document passed preservation of 170 variants and 254 property bindings, all 16 actual source previews and label containment on initial open/reopen, component/property/variant/source-edit workflows, and durable fresh-process reopen. Its staged timestamps and report under `docs/qa/independent-library-e2e/` identify where a timeout or failure occurs. A timeout is a failed acceptance, not a passing performance result. Preserve the actual outcome and fixture/source identity in the [verification record](independent/VERIFICATION.md).

Smaller synthetic tests do not substitute for the complete library journey. Measure on an idle machine and distinguish rendering, agent/IPC response, and durable save time when recording additional benchmarks. Earlier private-engine benchmark numbers do not establish current latency or a hard service-level guarantee.

## Current evidence and limits

The final current-source run passed 340 editor tests across 12 files and 38 host tests. Actual native UI acceptance passed 37/37 cases with zero renderer errors. Rendering coverage includes 32 scenarios and 830 assertions, plus eight large-fixture/cache assertions. The real library, four-client Electron/TLS plus official SDK/offline/export journey, packaged-app smoke and package-provenance checks passed; the current provenance report has no mismatches.

On the actual 1,065-object document, durable MCP edits measured a **515.683 ms median** and **603.409 ms p95**, from ten warmed samples after one warm-up. The recorded startup comparison was **341.3 ms** versus **109,584.7 ms** in the measured baseline. These are local measurements for the tested fixture, source and environment; they are not a universal latency guarantee. Do not combine startup time with the durable MCP response interval.

The [current verification record](independent/VERIFICATION.md) owns the detailed evidence and limits. The [final independent engineering review](independent/ASTRA_FINAL_REVIEW.md) is **APPROVE**, with architectural status **WATCH**. The reviewed 272-file clean-history candidate passed its hash, size, mode and privacy checks. Final delivery adds the completed review/status documents and reads back the resulting source export by its updated manifest. These results do not mean every feature record has an individual test. Source comparison and tests do not prove legal clearance.

`npm run test:editor` targets independently authored tests under `editor/__tests__/`. Inherited editor tests and the cross-package Konva reference suite are retired. Earlier audit reports remain in private Git history and are excluded from the clean publication snapshot. Their counts and approvals do not verify current code. The [behavior contract](independent/behavior-contract.md) defines the full required scope.

External internet/NAT or long-running unstable networks, real power loss/disk-failure injection, Windows/Linux execution, signing/notarization, and physical-device IME/touch behavior are not established by these macOS runs. Local four-client success proves the tested protocol flow, not public reachability. Recheck the actual source and package after relevant changes.
