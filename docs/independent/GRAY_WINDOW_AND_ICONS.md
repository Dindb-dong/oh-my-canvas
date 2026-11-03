# Native window dimming and interface icons

## Diagnosis and scope

The reported screenshot has a uniform gray veil over the entire native canvas window. An isolated macOS run reproduced that native compositor effect: opening the editor's renderer-owned file input changed `BrowserWindow.isEnabled()` from true to false and white native-window pixels from RGB 255 to RGB 204. There was no HTML modal, inert root, opacity or filter change. Reloading the renderer while that picker remained pending retained the disabled, dimmed window. A renderer screenshot alone misses this effect.

Normal cancellation of an Electron open dialog, including cancellation through Go to Folder, restored the window correctly. The exact action preceding the user's original screenshot is unknown; this investigation establishes a reproducible native-sheet mechanism, not proof of that original action or a general Electron defect.

## Changes

- Main-process file selection uses application-modal dialogs without attaching a sheet to the canvas. This removes the reproduced gray/disabled canvas state while a picker is pending, including across renderer reload.
- One owner guards all open/save dialogs against concurrent prompts, releasing ownership on cancellation and native errors. No forced `setEnabled(true)`, opacity reset, timer or restart workaround is used.
- All four desktop editor picker routes (asset placement, image placement, image paint, component-library import) use a typed injected host picker. Only supported, bounded, user-selected basename/bytes cross IPC; renderer-supplied filesystem paths are not accepted.
- Browser usage retains attached file-input selection, with change/cancel/abort cleanup. Editor destruction and page changes discard late picker results. Image paint preserves the originally selected target.
- Toolbars, layers, inspectors and app controls use the shared Tabler Icons v3.50.0 MIT subset. Original SVGs, license, pinned commit and hashes are retained. Lucide is removed from the package and lockfile. Keyboard shortcut characters remain text, and the supplied app brand logo is unchanged.

## Regression evidence

- Host tests: 40/40, including dialog ownership/cancel/error and asset bounds.
- Editor tests: 353/353 across 14 files, including five icon and eight file-picker regressions.
- Existing Electron UI suite: 37/37, including actual tool actions, image/font placement and exports. Deterministic native-selection adapters are used in that broad suite; it does not establish the native appearance.
- [Real macOS dialog regression](../qa/native-dialogs/report.json): nine native captures cover initial canvas, asset dialog open, renderer reload while open, cancellation, two import/cancel cycles and a usable canvas. Every captured canvas remains enabled with white RGB 255. The test uses actual OS dialogs and native window captures without filechooser interception.
- Packaged smoke and [current-byte package comparison](../qa/package-provenance.json) verify the delivered build, bundled MCP, retained native notices, exact Tabler license/manifest and absence of the removed icon package.

These checks cover this macOS environment. Native appearance on other operating systems and every possible macOS focus/accessibility combination remain unverified. Existing compact outer app chrome can overflow at narrow widths; this change does not redesign that layout.
