# Native Layers evaluation

Draft head: `16826b5791904360075d6195b3297b4bf060e731`. All native windows used disposable macOS profiles with `--automation-background` and stayed unfocused. The screenshot sequence uses recorded frames from the synthetic selection flow.

## Native selection on the exact release build

REPRODUCED: the visible sidebar stayed pixel-identical for both offscreen selections.
PASS: 3 distinct sidebar positions during nested selection; separate stable position after selecting the standalone shape.

The nested selection kept the canvas child selected and revealed the collapsed outer frame. The standalone selection revealed its own row. See the captured images.

## Native wheel handler with synthetic input

PASS: fractional offsets 0.25, 4.5, 3.75 at 2x; header ignores scroll; ends clamp at 0 and 636.0
PASS: mouse-wheel line eased through [0.0, 6.25, 15.89, 22.61, 26.84, 29.05, 29.88, 29.98, 30.0, 30.0, 30.0] px

A disposable build routed synthetic wheel input into the existing native handler. The two linked Python files document the injector and assertions. The exact release build and installed app omit the injector. Physical input devices were not exercised.

## Release checks

- `cargo build --release --locked -p omc-desktop` passed.
- `cargo test --release --locked -p omc-desktop` reported 42 passes, 3 ignored, and 2 failures. Both failures reproduced on the base in a `dock_` test run: `figcraft_chrome::tests::full_dock_keeps_figcraft_cell_and_caret_spacing` and `paint::tests::dock_tools_fit_compact_and_standard_windows`. With those two skipped, 42 passed and 3 were ignored.
- `git diff --check` and the changed-file rustfmt check passed. Repository Actions are disabled. Windows and Linux were not run.
