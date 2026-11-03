# Tabler control icon subset

This directory vendors **62 outline SVGs** from official Tabler Icons **v3.50.0**, immutable commit `6904efd245391ad396df17654738f52f6da8c40e`. Each original SVG and the complete upstream MIT `LICENSE` remain byte-for-byte unchanged. `manifest.json` records each exact public source URL, byte length and SHA-256, plus the generated runtime hash.

Official release: <https://github.com/tabler/tabler-icons/releases/tag/v3.50.0>.

`fetch.py` fetches only this named subset and the license from the pinned official GitHub source. `generate.py` verifies the original hashes and writes `runtime.js`; it strips source metadata comments from the inline representation, retains path geometry, and sets only root presentation/accessibility attributes at use: 18px default size, 1.75 stroke width, currentColor inherited from upstream, decorative `aria-hidden`, `focusable=false`, and a shared class/data attribute. The editor's drawing tools display at 20px through CSS.

Runtime callers:

- `editor/ui/icons.ts`: creates a trusted decorative SVG node.
- `editor/ui/dom.ts`: shared icon-only and icon-plus-label button helpers; enclosing controls retain names, title, events and state.
- `src/icons.js`: uses this same small runtime for outer application chrome, with no icon package dependency.

Builds bundle the checked-in runtime through Vite; no network or generator execution is required. Distribution must retain the complete upstream `LICENSE` and this provenance manifest in third-party notices/source artifacts. The parent integration lane owns package/notice copying. No application brand icon is changed.

This subset was selected from official public Tabler source. No company implementation, inherited editor code, icon tracing or reference-image extraction was used. Existing keyboard modifier hints, degree symbols and typography sample text remain text.

Regeneration:

```sh
python3 editor/ui/icons/tabler/fetch.py
python3 editor/ui/icons/tabler/generate.py
```

The text tool and text-layer badge use `letter-t`; the Pen tool uses `ballpen`, while the freehand Pencil tool retains `pencil`. Path layers retain the Bézier geometry icon.
