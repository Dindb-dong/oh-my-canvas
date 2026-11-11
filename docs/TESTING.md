# Testing and verification

[README](../README.md) · [Contributing](../CONTRIBUTING.md) · [Historical independent-engine verification](independent/VERIFICATION.md)

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

The core suite uses real loopback TLS/HTTPS sockets. An environment that prohibits socket listening must permit isolated local test sockets; do not count an `EPERM` run as a passing network test. Existing dependencies include the Electron/Playwright test runner; no separate browser download is required.

`node scripts/check-docs.mjs` checks repository links, anchors, images, shared README commands, issue-form YAML and SVG assets without starting the app or accessing the network.

## Choose checks by change

| Change | Start here | Add when relevant |
| --- | --- | --- |
| README, translations, issue/PR forms | `node scripts/check-docs.mjs`; rendered preview | No application rebuild for prose-only changes |
| Document, commands and geometry | `npx vitest run editor/__tests__/foundation.document.test.ts editor/__tests__/foundation.commands.test.ts editor/__tests__/foundation.geometry.test.ts` | `node --test tests/replica.test.mjs tests/storage.test.mjs`; actual save/reopen |
| Collaboration, bootstrap and protocol | `node --test tests/collaboration.test.mjs tests/bootstrap.test.mjs` | `npm run test:e2e`; `node scripts/independent-host-e2e.mjs` |
| Document tabs and background MCP | `node --test tests/document-manager.test.mjs`; `npx vitest run editor/__tests__/mcp.test.ts` | `node scripts/multi-document-e2e.mjs`; `node scripts/workspace-mcp-e2e.mjs`; `node scripts/mcp-http-e2e.mjs` |
| MCP and author isolation | `node --test tests/mcp.test.mjs`; `npx vitest run editor/__tests__/mcp.test.ts` | `node scripts/mcp-http-e2e.mjs`; retained stdio `node scripts/independent-host-e2e.mjs` |
| Text, gestures, clipboard and Undo | `npx vitest run editor/__tests__/ui-text-session.test.ts editor/__tests__/ui-canvas-geometry.test.ts editor/__tests__/ui-clipboard-atomic.test.ts` | `node scripts/independent-ui-e2e.mjs` |
| Components, variants, styles and libraries | `npx vitest run editor/__tests__/components.test.ts editor/__tests__/styles-library.test.ts` | `node scripts/independent-ui-e2e.mjs`; `node scripts/independent-library-e2e.mjs` |
| Rendering, formats and native exports | `npx vitest run editor/__tests__/formats.test.ts`; `node --test tests/export-file.test.mjs` | `node scripts/independent-render-e2e.mjs` |
| Complete desktop journey | `npm run build` | `npm run test:e2e`; the four `independent-*-e2e.mjs` scripts above |
| Packaging | `npm run build`; `node scripts/package-local.mjs` | `node scripts/packaged-smoke.mjs`; `node scripts/check-package-provenance.mjs` |

Build before renderer/HTTP/stdio E2E. The focused commands above are entry points, not a replacement for a broader run after changing a shared contract. E2E scripts may refresh tracked screenshots and JSON evidence in `docs/qa`; inspect the diff and retain only intentional evidence changes. They create and clean up their own temporary profiles. Automated Electron launches set `OMC_TEST_BACKGROUND=1`; with an isolated profile the app creates hidden windows and suppresses Dock activation before startup. Do not remove this flag or run tests against an older executable that does not honor it. `npm run dev` remains a normal visible development launch.

The HTTP smoke intentionally obstructs its temporary profile's `documents` path to test a failed native close. Its expected `EEXIST`/`ENOTDIR` save error is injected and followed by directory restoration and same-session replay/alias/Undo checks; it does not touch a real user profile.

### Packaging and installed profiles

`node scripts/package-local.mjs` copies the current source/build and locked runtime dependencies into task-owned `work/package-stage` as real files, then uses the already installed Electron runtime and electron-builder to write the local `release/` directory. It performs no dependency installation, publication, signing or installed-app replacement. `--prepare-only` stops after staging. Build first; the helper does not compile the editor.

Use `node scripts/packaged-smoke.mjs` to test that fresh local package, certificate-pinned HTTPS endpoint and bundled stdio CLI with an isolated temporary profile, then `node scripts/check-package-provenance.mjs` for current-byte checks of source/build assets, native notices, WASM, fonts, Electron notices and the standalone CLI. The provenance check also rejects retired vendor/apps/fallback paths in the ASAR index; it does not inspect compiled-code ASTs or establish legal clearance. Packaging directly through a shared `node_modules` symlink can omit runtime packages; the staging helper avoids that problem.

Installed authoring helpers additionally require `OMC_DOCUMENT_ID` and explicitly bind that exact canvas without focusing it. Never run them as part of a source regression.

Legacy `--installed` modes and default-profile scripts are not the current independent-engine acceptance route. Some target an existing `/Applications/Oh My Canvas.app` and its active document. Keep them outside routine checks; an installation check requires explicit scope and a review of its profile/data behavior. Do not replace the installed application or edit global MCP configuration merely to run a source regression.

## What a useful regression proves

- **Geometry:** actual editor-generated geometry remains consistent after concurrent X/Y, move/resize, rotation, flip and path changes. Check render bounds, not only scalar properties.
- **Undo:** explicit current author and user transaction survive the editor → IPC → replica connection. Cancellation does not resurrect an empty layer. Agents cannot mutate inside a live user transaction.
- **MCP:** official SDK HTTP clients with identical names retain separate sessions/authors; one cannot Undo the other's work. Check a port impostor cannot receive a bearer, persistent credentials/certificate and the same HTTPS URL after restart, failed-close replay/alias/Undo preservation, stale-session rejection, cancellation before mutation, and durable readback. Retain two-process stdio coverage for rollout compatibility.
- **Document isolation:** use one profile with two documents, two identically named clients, and a shared transport. Switch UI tabs during explicit-ID writes. Assert no cross-document changes, retained typing, background screenshot pixels/fonts, close keepalive, renderer-generation recovery, forged IPC rejection, and durable restart readback. `scripts/desktop-test-pages.mjs` resolves an exact document ID and runtime generation; the first window is only the application shell.
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

### Editing and SVG update benchmark

```sh
node scripts/benchmark-canvas.mjs
node scripts/benchmark-canvas.mjs --baseline=/absolute/path/to/baseline-checkout --nodes=1000 --samples=12
```

This reproducible Node/jsdom benchmark measures a committed single-layer move and a synchronous burst of eight gesture previews followed by a commit. It runs the editor's document reconciliation and validation, SVG generation and DOM updates, then reads the final scene to include any queued work. Each revision runs in a separate process with three warm-up samples. Output includes median/p95 durations, SVG update counts, DOM insertions/removals and whether edited and untouched elements retain their identity. Each workload also checks final geometry and Undo/Redo.

The fixture contains rectangles only. Results do not measure native browser layout/paint, FPS, physical input timing, text shaping, image decoding, Electron IPC or durable saving. The eight-preview workload measures event coalescing within one JavaScript turn; it is not an eight-frame drag. Run the native render, UI and library journeys above before accepting visual or desktop performance claims. Use `--output=/path/to/report.json` to retain a report; the benchmark does not write generated files by default.

### Large design-file journey

Retrieve the real source with Git LFS and build the candidate before the native journey:

```sh
git lfs pull --include=fixtures/design-files/iOS-and-iPadOS-27.fig
npm run build
node scripts/large-document-e2e.mjs --source /absolute/path/to/iOS-and-iPadOS-27.fig --output /absolute/path/to/evidence --label candidate
node scripts/viewport-motion-e2e.mjs --output /absolute/path/to/viewport-evidence --label candidate
node --expose-gc scripts/benchmark-document-core.mjs --file=/absolute/path/to/iOS-and-iPadOS-27.fig --output=/absolute/path/to/core-result.json
```

On Linux with no desktop display, prefix the native command with `xvfb-run --auto-servernum`. The core benchmark needs no display. It imports once, records a first rename and five subsequent renames, closes the source replica, and reopens once; it does not measure native rendering or IPC. The documented fixture hash and size are in [Design-file import](DESIGN_FILE_IMPORT.md).

For a native comparison, run the same `large-document-e2e.mjs` script from each checkout's working directory after building it. Use `--legacy-loading` for the pinned PR #12 reference, which predates progressive opening. The runner resolves that checkout's Electron executable and uses fresh temporary profiles. The current journey separates first-editable/first-paint from all-pages completion, edits the first page through the actual inspector during loading, and checks that early edits remain after the background work completes. Cached reopen repeats that split and rejects a premature durable save indication. It also checks the complete 46-page source, image-hash closure and missing-image response, UI rename paint and durable acknowledgment, complete MCP rename, Examples page entry, pan/hover without document writes, a single-leaf drag, JSON/SVG/OMC export and fresh-process/fresh-profile round trips. Reopen and round-trip checks compare page IDs/order, per-page object counts, names, original bitmap hash sets and the moved shape's coordinates. Automated input frame intervals include Playwright scheduling; they are not GPU-only frame times. Cover is already selected on import, so its selection check is not a page-switch benchmark. A screenshot alone does not establish fidelity to the original Figma frames.

The viewport-motion journey compares screenshots from the translated SVG surface and the direct renderer at the same logical camera, then checks hit testing and world/screen coordinate round trips. Its fixture includes clips, masks, shadows, blur, text, bitmap assets and blending. Integer/fractional pan, zoom, overscan exit, resize and the root-blend fallback receive separate paired captures. Published pixel tolerances permit edge antialiasing differences; this is an engine regression oracle, not original-source reproduction. Live SVG `viewBox` describes the prepared overscan surface, so camera measurements use the editor's logical viewport.

After the 90-event pan sample finishes, a separate six-event CDP trace attributes the renderer's remaining work. It has a 30-second budget, an 8-MiB trace buffer and a 32-MiB streamed-data cap. `phases.panTrace` records explicit unavailable/incomplete status when necessary. Its exclusive main-thread intervals partition the marked window; inclusive event/callback rows overlap, other renderer threads run concurrently, and GPU-process work is outside that attribution. Tracing is excluded from the original pan sample.

The `Large document validation` workflow runs the candidate checks, native journey and viewport oracle on pushes to the performance branches. A manual dispatch can enable `compare_reference` to run the pinned PR #12 runtime afterward on the same runner and harness. Candidate JSON results, screenshots and logs are retained before that optional comparison, and reference failures remain recorded separately. A Node-side watchdog limits each complete native journey to ten minutes by default (`--journey-timeout` accepts milliseconds), records the pending check before work begins and terminates only the test's owned Electron child on expiration. CI caps the candidate step at twelve minutes. The optional reference has an explicit twenty-minute journey budget and twenty-two-minute step cap. Neither harness waiting nor CI changes the application's worker or renderer initialization deadlines. The runner makes only its isolated test window visible to the virtual display so Chromium can paint; normal background acceptance scripts remain hidden.

## Current large-document verification

Runtime commit `cf9f18433924a7d581c815be5df9bfb96505cd75` passed 257 Node tests, 843 editor tests and all 17 native large-document checks in the [2026-11-11 workflow](https://github.com/Dindb-dong/oh-my-canvas/actions/runs/42949164362). Syntax/type checks, documentation checks and production build passed. The complete original source had its Git LFS byte count and SHA-256 verified. Zero renderer exceptions were recorded. All seven viewport pixel/hit-test cases passed their published tolerances. The later documentation commit only records the tested runtime's evidence.

The first imported page was editable at 7.169 s and reached the first-paint milestone at 7.346 s; all 46 pages completed at 41.370 s. Cached reopen reached first paint at 0.773 s and all-pages completion at 13.380 s. This paint milestone follows two animation frames with a one-second fallback; it does not wait for every image/font to finish decoding. Real inspector edits made with only one page loaded survived background delivery. Each initially showed `Saving…`; after the first later Stored indicator observation, a follow-up host snapshot separately verified the durable ACK and edited value. During cached reopen, the indicator observation waited 5.504 s after the edit. This is not isolated fsync timing, and first paint must not be reported as durable save or full restoration.

The 90-event pan sample recorded a 16.7 ms frame-interval p95 and 16.8 ms maximum, with 0 long tasks and no document writes. The 24-step drag recorded an 83.4 ms p95 and 183.4 ms maximum, with 113.3 ms from release to durable save. These include software rendering and driver scheduling. Full import still took 41.37 s; the historical PR #12 observation was 38.89 s. The runs used separate CI instances, and only the progressive journey included an early edit and cooperative pauses. No controlled same-machine speedup ratio is established.

Regression tests also cover the first tiny edit after a terminal import-diagnostics projection: it must not traverse untouched page shapes, and rejecting an incoming host constraint must leave document/selection/live-gesture state intact. Both incremental projections and full snapshots exercise the host validation boundary before publication.

Measurement scopes, remaining loading/drag costs, memory snapshots and fidelity limits are in [Design-file import](DESIGN_FILE_IMPORT.md#progressive-native-validation) and the [sanitized PR #13 evidence](qa/pr13-large-document-evaluation.json). The optional cache may be unavailable or unsuitable, and full main-process Yjs hydration still occurs; tests must exercise fallback and verify that early edits stay pending until authority validation and fsync. Passing preservation assertions does not establish perfect original Figma visuals or a total-RAM ceiling.

For the preceding PR #12 runtime, `cfa052c8d08aa368017314f3ba08f50a36fd2e47` passed 189 Node tests, 823 editor tests and all 17 native checks in the [2026-11-10 workflow](https://github.com/Dindb-dong/oh-my-canvas/actions/runs/42869423111). Its [separate historical measurements](DESIGN_FILE_IMPORT.md#native-validation-cfa052c8) remain attributable to that source and runner.

## Historical independent-engine verification, 2026-11-03

The historical source passed 340 editor tests across 12 files and 38 host tests. Its native UI acceptance passed 37/37 cases with zero renderer errors. Rendering coverage included 32 scenarios and 830 assertions, plus eight large-fixture/cache assertions. Its real library, four-client Electron/TLS plus official SDK/offline/export journey, packaged-app smoke and package-provenance checks passed. These results apply to the 2026-11-03 source, not the PR #12 storage, protocol or rendering changes; current large-document results are recorded in [Design-file import](DESIGN_FILE_IMPORT.md).

On the actual 1,065-object document, durable MCP edits measured a **515.683 ms median** and **603.409 ms p95**, from ten warmed samples after one warm-up. The recorded startup comparison was **341.3 ms** versus **109,584.7 ms** in the measured baseline. These are local measurements for the tested fixture, source and environment; they are not a universal latency guarantee. Do not combine startup time with the durable MCP response interval.

The [historical verification record](independent/VERIFICATION.md) owns that evidence and its limits. Its [final independent engineering review](independent/ASTRA_FINAL_REVIEW.md) recorded **APPROVE**, with architectural status **WATCH**, for the earlier 272-file candidate. That candidate passed its hash, size, mode and privacy checks. These historical results do not mean every feature record has an individual test and are not an approval of later changes. Source comparison and tests do not prove legal clearance.

`npm run test:editor` targets independently authored tests under `editor/__tests__/`. Inherited editor tests and the cross-package Konva reference suite are retired. Earlier audit reports remain in private Git history and are excluded from the clean publication snapshot. Their counts and approvals do not verify current code. The [behavior contract](independent/behavior-contract.md) defines the full required scope.

External internet/NAT or long-running unstable networks, real power loss/disk-failure injection, Windows/Linux execution, signing/notarization, and physical-device IME/touch behavior are not established by these macOS runs. Local four-client success proves the tested protocol flow, not public reachability. Recheck the actual source and package after relevant changes.
