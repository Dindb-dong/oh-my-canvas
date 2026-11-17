# Native layer selection evaluation

Draft head: `8b1d96acb66c7d21f913819796975f89282ac915`. All native windows used disposable macOS profiles with `--automation-background` and stayed unfocused. The GIF shows sampled screenshots of the synthetic fixture.

## Exact release build

REPRODUCED: selecting a child in an already-visible collapsed frame leaves the old sidebar pixel-identical.
PASS: the already-visible outer frame animated to the top and gained a blue outline. One idle interval after the standalone click, its selected row was at the top.

The test compares sidebar pixels before and after selection, checks multiple rendered positions and the settled frame outline, and checks that the standalone selected row reaches the top after an idle interval. The canvas child stays selected.

## Native mouse event path

PASS: the already-visible outer frame animated to the top and gained a blue outline. One idle interval after the standalone click, its selected row was at the top.

A disposable build routed clicks through native `CursorMoved` and `MouseInput` events. It dispatched exactly two clicks. The injector was excluded from the exact release build. To reproduce the event-only check, run the attached injector on `native/apps/omc-desktop/src/app.rs` and route the final desktop automation dispatch in `app/windows.rs` through `user_event(event_loop, Event::Automation(job, reply))` for the disposable build. Run the attached `eval.py <desktop-binary> draft-events` against that build.

## Release checks

- `cargo build --release --locked -p omc-desktop` passed.
- `cargo test --release --locked -p omc-desktop` reported 42 passes, 3 ignored, and two existing dock assertions also present on the base. With those skipped, 42 passed and 3 were ignored.
- Changed-file rustfmt and `git diff --check` passed. Repository Actions are disabled. Physical input, Windows and Linux were not exercised.
