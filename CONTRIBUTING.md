# Contributing to Oh My Canvas

Oh My Canvas is a Rust-native app. Make focused changes using existing model, service, renderer and UI patterns. Keep unrelated edits and private user data out of commits.

## Local development

Use Rustup with Rust 1.92.0. From the repository root:

```sh
cd native
cargo build --locked -p omc-desktop -p omc-service -p omc-cli
./target/debug/omc-desktop
```

For JavaScript test and benchmark tooling, use Node.js 22.12+:

```sh
npm ci --ignore-scripts
npm run check
npm test
npm run test:native
```

Build the native service and CLI before `test:native`. These npm commands do not build, launch or package an Electron application. See [testing](docs/TESTING.md) for crate-level checks, optional integration requirements and evidence limits.

## Implementation and verification

1. Reproduce the problem with synthetic data and trace all affected callers.
2. Make the smallest complete change. Preserve input validation, durable writes, ownership, Undo and error handling.
3. Run the smallest relevant test first, then broader checks when shared contracts change. Record actual results, skips and failures.
4. Keep internal plans and local evidence under the primary checkout's ignored `internal/docs/`. Maintained public documentation must not link there.
5. Review the diff for private data and unrelated changes. Write English Git/GitHub artifacts with commit subjects such as `fix: preserve document ownership`.
6. Create PRs as drafts. Begin the body with the evaluation table, give actual check commands and runtime evidence where applicable, list remaining gaps, and retain the required author line. Do not merge or deploy without explicit authorization.

## Native desktop QA

Use a task-owned profile and `omc-desktop --profile <isolated-directory> --automation-background`. Keep the window hidden and unfocused, seed only synthetic data and stop task-owned processes afterward. Never test against the user's default profile. Foreground interaction requires explicit permission. Use real runtime screenshots for visual changes; headless service results do not verify presentation.

## Reports, privacy and rights

Use the [bug form](.github/ISSUE_TEMPLATE/bug_report.yml) or [feature form](.github/ISSUE_TEMPLATE/feature_request.yml). Include revision, OS, reproduction steps and expected/actual behavior. Submit only a minimal synthetic fixture and redacted logs. Exclude private keys, authorization tokens, profile descriptors, invitations and personal canvases. Removing visible content does not reliably scrub retained history. Follow [security](SECURITY.md) for private reports.

Contribute only material you have permission to provide. The [MIT license](LICENSE) covers eligible project work; preserve [third-party notices](THIRD_PARTY_NOTICES.md). Do not reintroduce retired company source or copied tests. No additional CLA is required here.

## Documentation and translations

Keep all four README languages consistent on commands, tool counts and measured claims. Explain product behavior rather than task history. Historical verification records describe their own source revisions and do not certify the current app. Keep local links and images portable and run `npm run check`.

[Architecture](docs/ARCHITECTURE.md) · [Native guide](native/README.md) · [Testing](docs/TESTING.md) · [한국어](docs/contributing/ko.md) · [日本語](docs/contributing/ja.md) · [简体中文](docs/contributing/zh-CN.md)
