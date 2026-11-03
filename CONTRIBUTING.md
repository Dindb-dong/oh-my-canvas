# Contributing to Oh My Canvas

**English** · [한국어](docs/contributing/ko.md) · [日本語](docs/contributing/ja.md) · [简体中文](docs/contributing/zh-CN.md)

Help make a dependable design studio: report a reproducible bug, improve a translation, refine a component, or propose a focused code change.

> **License and provenance.** Original project contributions are under the [MIT license](LICENSE); external materials retain their own terms. Submit only work you can license, preserve [third-party notices](THIRD_PARTY_NOTICES.md), and do not reintroduce retired company source or copied tests. No new CLA or rights assignment is introduced here.

## Choose a contribution

| Contribution | Include |
| --- | --- |
| Bug fix | Small synthetic reproduction, expected/actual result, regression test |
| UI change | Before/after screenshots, keyboard/focus behavior, relevant viewport checks |
| Component or variant | Source/instance behavior, overrides, Undo and persistence checks |
| Documentation or translation | Working links, accurate commands and matching limits in all affected languages |
| Larger feature | Problem, concrete use case, scope and tradeoffs before implementation |

The repository is currently maintained locally and has no configured public remote. The issue and PR templates are ready for a future hosted repository. Until then, use the same forms as local Markdown reports or handoff notes; do not assume a public issue tracker, releases page or automatic CI exists.

## Set up locally

Use Node.js **22.12+**, npm and a Git checkout you are authorized to use. From the repository root:

```sh
npm ci
npm run build
npm start
```

`npm run dev` runs the local development workflow. Fresh local acceptance runs use macOS arm64; the [current verification record](docs/independent/VERIFICATION.md) distinguishes passed checks from open work. Windows/Linux execution remains unverified. Packaged desktop users do not need a separate Node installation for the bundled MCP CLI.

See the [getting started](docs/GETTING_STARTED.md) and [architecture](docs/ARCHITECTURE.md) guides. Use synthetic documents and separate test profiles. Never use your only copy of an important canvas as a fixture. Export a portable `.omc` backup before testing storage or format changes.

## Make one focused change

1. Start a branch such as `fix/text-undo`, `feat/component-property`, or `docs/japanese-readme` from the agreed base commit. Preserve unrelated work.
2. Reproduce the problem before changing code. Trace callers and reuse the existing editor, storage or UI pattern.
3. Keep the change within one reviewable responsibility. Add a regression test for non-trivial behavior; document user-visible changes and compatibility limits.
4. Run the checks that exercise the affected path. Do not describe an unrun check as passing.
5. Review the diff for personal documents, secrets, generated artifacts and unrelated edits. Commit with a clear English subject, for example `fix: preserve text session undo`.
6. Prepare the PR or local review note using the [PR template](.github/PULL_REQUEST_TEMPLATE.md). Ask for review; do not merge or publish without the maintainer's approval.

## Verify the right behavior

Run ordinary checks locally; no Docker setup is required for this workflow.

```sh
npm run check          # JavaScript syntax and TypeScript
npm test               # Replica, persistence, TLS and MCP boundaries
npm run test:editor    # Editor regressions
```

For changes to app integration, build first and run the relevant actual Electron checks:

```sh
npm run build
npm run test:e2e
node scripts/independent-host-e2e.mjs
node scripts/independent-ui-e2e.mjs
node scripts/independent-render-e2e.mjs
node scripts/independent-library-e2e.mjs
```

These are separate acceptance scripts; select the ones affected by the change and record exactly what ran. They launch real Electron processes with temporary profiles. Some refresh screenshots/results under `docs/qa/`; inspect those changes instead of committing them blindly. On a sandboxed host, local TLS/loopback and Electron startup may need the host's normal execution permission.

For packaging changes, build first, then use the local staging helper. It copies locked runtime dependencies as real files into task-owned staging and reuses the installed Electron runtime; packaging directly through an inter-worktree `node_modules` symlink can omit dependencies:

```sh
npm run build
node scripts/package-local.mjs
node scripts/packaged-smoke.mjs
```

These commands create and check local artifacts without publishing or replacing the installed app. Do not modify an installed app or global MCP settings for unrelated verification. Legacy `--installed` and default-profile scripts are not the current independent-engine acceptance workflow; use them only for a separately authorized, reviewed installation check.

For documentation-only changes, run `node scripts/check-docs.mjs` and review rendered images and translations; a full app rebuild is normally unnecessary. See the [testing guide](docs/TESTING.md), [troubleshooting](docs/TROUBLESHOOTING.md), and [verification record](docs/independent/VERIFICATION.md) for tested scope and known gaps; historical test counts are evidence snapshots, not permanent badges.

## Preserve the important contracts

- **Local data:** edits must remain durable and recoverable. Keep atomic writes, validation before live mutation, backup recovery and explicit size limits.
- **Collaboration:** preserve convergence, peer-specific Undo, coherent geometry and session capacity. The verified four-client test is local TLS; it does not prove external internet/NAT reachability.
- **MCP:** keep the bridge on loopback with its authentication and Origin/Host checks. Never port-forward MCP. During a user text edit or scrub, reads remain available and mutations return `busy` until the transaction ends.
- **Formats:** the writer and collaboration protocol use v2; v1 files remain readable. Test compatibility and reject incompatible peers explicitly rather than silently mixing representations.
- **Privacy:** no telemetry, remote assets, account dependency or paid-service dependency should appear without an explicit product decision.

## Report a bug

Use the [bug form](.github/ISSUE_TEMPLATE/bug_report.yml). Give the app/source commit, OS and architecture, precise steps, expected behavior and actual behavior. For data or collaboration issues, include save/reopen, Undo and connection state when relevant.

Attach only a minimal synthetic canvas and redacted screenshots/logs. **Do not attach** real customer designs, personal records, credentials, session invitations, tokens, `mcp-runtime.json`, or a full user-data folder. An invitation grants editing access; a portable `.omc` includes embedded assets and merge history. Removing a visible layer is not a reliable way to scrub its prior content. Recreate the reproduction in a new synthetic document.

For a suspected security problem, follow [SECURITY.md](SECURITY.md). Do not put secrets, a live exploit against someone else's system, or sensitive document contents into a public issue. Use a private channel already agreed with the maintainer. This repository does not currently advertise a dedicated security-report address or response SLA.

## Propose a feature

Use the [feature form](.github/ISSUE_TEMPLATE/feature_request.yml). Describe the problem and the smallest behavior that solves it. Include alternatives, design evidence where relevant, and any effect on local storage, collaboration, MCP, permissions or network use. Do not promise a release date or implementation before review.

## Keep translations aligned

The English README and this guide are the reference text for commands and shared technical facts. Keep the Korean, Japanese and Simplified Chinese versions consistent when changing prerequisites, counts, file formats, limits or verified platforms. Preserve the actual English UI labels, tool names and commands so users can find them in the app. Localize explanations rather than changing API names.

Use relative links and repository-owned images so the documents work in an offline checkout as well as on a future Git host. Add descriptive alt text. Screenshots should show the actual app, not a fabricated capability or private user document.

## Review checklist

- [ ] The change solves a concrete problem and preserves unrelated work.
- [ ] Relevant checks ran; results and remaining gaps are stated.
- [ ] A behavioral fix has a meaningful regression check.
- [ ] UI changes include real screenshots and keyboard/focus verification where relevant.
- [ ] Documentation and affected translations match actual behavior.
- [ ] No private data, secrets, session invitations or generated private files are included.
- [ ] Existing license and attribution notices remain intact.

Be specific and respectful in reviews: discuss the behavior, evidence and code rather than the person. Small fixes and careful bug reports are useful contributions.
