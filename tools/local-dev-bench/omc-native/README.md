# Native stage diagnostics

The probe uses the installed release service and optionally opens the synthetic document in an unfocused background desktop. It uses a temporary profile and removes it after stopping the task-owned processes. Use `OMC_BENCH_BIN_DIR` to select a different directory containing `omc-service` and `omc-desktop`. The report includes binary and fixture SHA-256 values.

```sh
node --test tools/local-dev-bench/omc-native/fixture.test.mjs
node tools/local-dev-bench/omc-native/native-probe.mjs --experiment N-A --nodes 1000 --depth 1 --desktop headless
node tools/local-dev-bench/omc-native/native-probe.mjs --experiment N-B --nodes 10000 --depth 1 --desktop attached --css-rules 1000
```

N-A supports 1,000, 10,000 and 100,000 total document nodes, depths 1 and 32, and headless or attached mode. Every case moves the same rectangle one unit per sample. N-B uses the same 100 authored nodes on the active page and adds unrelated pages of up to 1,000 authored nodes each. Use `--nodes 100` for its one-page baseline of 101 total nodes. Total counts include page roots and respect the 100,000-node import ceiling. Vary `--css-rules` independently from 0 through 1,000. Each generated rule uses a selector that matches none of the authored nodes. `--samples` defaults to 5. `--fixture-only` generates and checks the fixture without starting a product.

Each sample records a verified durable receipt, an unconditional full snapshot after the edit, a conditional snapshot using the previous revision, then a conditional read at the current revision. The latter returns null. The three reads run in that order and their cache state may differ. RPC timings are client-wall-clock boundaries and report body bytes, request-to-body time and client decode/parse time. Setup and import have separate boundaries. Use the outer benchmark collector for peak memory and CPU, including any measurement of the startup and validation overhead.

The current installed binary path does not expose revision-linked scene readiness, frame submission or frame presentation for this edit. N-B leaves styled and indexed counts, active interaction, unrelated metadata payloads and components unmeasured. These service-path diagnostics do not qualify the full native experiments.
