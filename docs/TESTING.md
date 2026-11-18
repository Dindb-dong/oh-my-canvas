# Testing and verification

Use synthetic inputs and isolated temporary profiles. Run the smallest relevant local check first. Headless contract tests do not prove native window presentation, full file fidelity or cross-platform release readiness.

## JavaScript development tooling

Node.js 22.12+ is needed for SDK tests, document checks and benchmark adapters, not for the app runtime.

```sh
npm ci --ignore-scripts
npm run check
npm test
```

`check` checks JavaScript syntax and repository documentation links, images, examples and translations. `test` runs the benchmark adapter unit tests using Node's test runner. No Electron installation or web-editor build is involved.

## Native contracts

```sh
cd native
cargo fmt --all --check
cargo test --locked --workspace
cargo build --locked -p omc-service -p omc-cli -p omc-desktop
cd ..
npm run test:native
```

`test:native` runs the native MCP integration suites with two concurrent files. They start isolated local services and remove their temporary profiles. `OMC_SERVICE_BINARY` and `OMC_CLI_BINARY` may select matching prebuilt binaries; report their source revision and do not describe that run as a current-source rebuild. `OMC_TEST_SDK_ROOT` selects an external SDK installation when required. The image suite requires `OMC_BACKGROUND_MODEL` pointing to the pinned U²-Netp file. Prepare it with `node scripts/prepare-background-removal.mjs --native <task-owned-runtime-directory>` and set `OMC_BACKGROUND_MODEL=<task-owned-runtime-directory>/background-removal/u2netp.onnx` for `test:native`. Optional external server and desktop checks may skip; report the actual result.

## Desktop QA

Launch a task-owned desktop with `--profile <isolated-directory> --automation-background`. Use `--smoke-exit-ms 2000 --screenshot <output.png>` for a bounded screenshot check. Keep the window hidden and unfocused and stop task-owned services afterward. Do not use the installed default profile or activate a test window. Foreground QA needs explicit permission.

## Choose by affected contract

| Change | Relevant checks |
| --- | --- |
| README and development commands | `npm run check` |
| Model, protocol, persistence, Undo | Focused Rust crate tests, then native SDK save/reopen tests |
| MCP and legacy HTTPS | `native/tests/mcp.e2e.mjs` and related native SDK suites |
| Older document conversion | `omc-import` crate tests and `native/tests/mcp-replica-import.e2e.mjs` |
| Rendering and interaction | Rust render/desktop tests and isolated background desktop QA |
| Benchmark adapters | `npm test` and Python tests for the changed adapters |

Keep local evidence under the primary checkout's ignored `internal/docs/`. Retained documents under `docs/independent/` and `docs/qa/` describe historical runs and do not certify the current native build.

[Native verification](../native/README.md#local-verification) · [Qualification](native-engine/QUALIFICATION.md) · [Benchmark protocol](benchmarks/README.md)
