# Full editable component library: desktop regression

Harness: `scripts/independent-library-e2e.mjs`. Fresh Playwright/Electron coverage authored after barrier `f86e063`; no inherited test body was reused. It uses installed dependencies and the parent's shared `dist`, and never builds, uploads, edits the original fixture or installs over the user's application. The native dialog's selected filename is the only import override: the actual Open-file button, main-process decoder, editor, IPC persistence and disk store execute normally.

## Behavioral result

**Passed** on the parent-launched run from **2026-11-03 12:07:01.645–12:07:14.341 UTC** (12.696 seconds). `independent-library-e2e/report.json` records stages, identifiers, counts and screenshots. No uncaught renderer errors, console errors or unhandled harness rejections were recorded.

- Imported the actual eligible `.omc` through the native desktop path: **1065 objects, 172 mains, 170 variants, 14 sets, five nested instances**, with **254 valid bindings** and no missing property references.
- Actual Assets UI exposed **16 component tiles**: 14 variant families plus two composed mains. All 16 had real source-rendered SVG previews and contained family labels both after import and after process restart (32 tile audits).
- Inserted a composed main through Assets: ten editable objects including two nested instances. Inserted a linked variant through Assets.
- Changed a text property and variant through the actual inspector. The property value survived variant-property ID remapping.
- Selected the variant's source main in Layers and changed width through its inspector from 132 to **149**. The inserted instance updated while retaining its text override.
- Navigated home to finish pending commits, independently decoded the profile's saved `.omc`, closed the first Electron process, relaunched with the same isolated profile and reopened through the document library.
- Reopened document retained **172 mains, 170 variants, 14 sets**, the two new component instances (**1079 objects, nine nested instances**) and **260 valid bindings**; property/variant/source-width changes persisted.

Four real screenshots were inspected directly:

1. [Imported Assets library](independent-library-e2e/01-assets-library.png).
2. [Instance property and variant](independent-library-e2e/02-instance-property-variant.png).
3. [UI main edit](independent-library-e2e/03-main-edit-propagation.png).
4. [Fresh-process reopen](independent-library-e2e/04-reopened-library.png).

This final parent-launched run used the combined shared build after the D swapped-subtree fix and B/C font-cache, inline-thumbnail and label-containment fixes. The inspector override was `QA canvas`. The launch log is `work/independent/library-final.log`.

## Visual findings and scope limits

The four final screenshots show actual component thumbnails and readable family names in the visible Assets rows, the selected `QA canvas` variant, the source main at width 149, and the persisted instance after reopening. No open visual blocker was found in this journey. The full 16-tile DOM audit additionally covers the lower rows outside the screenshots' visible sidebar: every tile had a real preview, tile scroll width equaled its 106-pixel client width, and label scroll width equaled its 86-pixel client width. `Workspace toolbar` and `Create canvas dialog` each wrapped onto two contained lines with normal whitespace and the two-line clamp. These checks passed again after restart.

Earlier screenshot review exposed generic diamond placeholders and overflowing first-variant axis labels. B/C replaced them with source-rendered thumbnails and family names, then corrected inherited button `white-space: nowrap`. The unchanged strong containment assertions now pass. Historical failure artifacts `visual-overflow-before-fix.json`, `visual-overflow-before-fix.png` and `before-thumbnail-fix.png` remain separate from the four final screenshots.

The first run timed out waiting for readiness. B diagnosed repeated Unicode-range selection work, implemented the measured font-cache fix, and the final real journey completed in 12.696 seconds without raising the readiness timeout. B's independent phase profile is `independent-render-library-profile-optimized.json`.

Data-only inspection found 222 frames, 571 fixed-size text layers, 272 rectangles, 15 layout records, no image/shadow/blur fields and 7634 rich characters. Decoding itself completed in under one second.

This journey verifies an actual editable library import and representative composition/variant/property/source/persistence interactions. It does not click every possible variant/property combination, establish native IME/touch/clipboard behavior, verify unrelated render/export formats, exercise multi-author Undo/TLS participants or close publication/license gates. Those remain separate evidence routes.

Temporary profiles are task-owned. The harness removes them after process exit, caps screenshot/close waits and has a five-minute whole-run watchdog that only terminates its own Electron process. An initial sandbox launch failure left an older profile; its exact path was handed to the parent for process-ownership checking before deletion. No original application/user profile was used.
