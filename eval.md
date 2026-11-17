# Exact-head evaluation

Source commit: 34cda8b9b2e827f8fccb26b36dcaf830071bb933

All native interactive checks used temporary macOS profiles and automation background mode. Screenshots and recordings show only synthetic fixtures.

| Path | Result |
|---|---|
| Release build | Pass. Built the macOS service, desktop and CLI. |
| Regression checks | Pass. 30 tests in model, import, layout and scene. |
| Native resize gesture | Pass. Dragged a source frame from 160 to 240 units and asserted that the rendered child expanded. |
| Grid reflow | Pass. Synthetic fixed and fractional tracks resized as expected. |
| Component propagation | Pass. The source paint changed in the linked instance. The explicit Electron array override kept its local paint. |
| Effects | Pass. Verified drop-shadow pixels and the imported offset. |
| Background migration rehearsal | Pass. 26 canvases, 24,815 existing layer IDs, 287 main definitions, 490 layer links, 183 variant declarations and 346 shadow layers. All thumbnails rendered and three editors opened. The checked source files and their backups retained their hashes. |
| Home | Pass. 24 thumbnails, fractional scroll and paging, search, star, folders, Trash/restore, and open. |
| Whole-workspace rustfmt | Existing failure. All 25 reported paths also differ from rustfmt on the base branch. |
| Hosted CI / other OSes | Not run. GitHub Actions are disabled for this repository. Linux and Windows were not exercised. |

The initial independent review blocked on array overrides, the nested component extension, centered content in fill-sized parents, and inherited layout. Those cases were fixed and re-evaluated. See the independent review alongside this report.

Checked by: cargo build --release --locked -p omc-service -p omc-desktop -p omc-cli; cargo test --release --locked -p omc-model -p omc-import -p omc-layout -p omc-scene; git diff --check.

The GIFs are frame samples from actual native screenshots captured during the tested flows. Legacy authored-instance variant replacement, source-child reordering, and exact equivalence of arbitrary effect stacks were not exercised.
