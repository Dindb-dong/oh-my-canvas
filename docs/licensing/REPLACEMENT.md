# Independent engine and maintained boundaries

Oh My Canvas now uses the independently authored `editor/` implementation behind the existing desktop host. The earlier inherited implementation, helper and copied tests are excluded from the intended publication source. Authorization to relicense the company source was unavailable; replacing that source does not change the rights in the original private history.

The required behavior remains the full [feature contract](../independent/behavior-contract.md). This architecture is not permission to narrow the scope when a workflow is difficult or slow. Current results and unresolved acceptance work belong in [VERIFICATION.md](../independent/VERIFICATION.md).

## Desktop integration

`src/main.js` imports the public facade from `editor/index.ts`:

| Surface | Responsibility |
| --- | --- |
| `mountEditor` | Mount/dispose the editor, document and selection access, transactions, focus, tools, inspector, Assets and host callbacks |
| `importCanvasJson` / `exportCanvasJson` | Interoperable document conversion and validation, preserving eligible assets and component data |
| `installLvMcp` | Agent dispatch, reads/mutations, author identity, transaction exclusion and component semantics |
| `screenToWorld` / `worldToScreen` | Coordinate conversion for interaction and remote presence |

The build bundles `editor/mcp/defs.ts` for the CLI. Host and MCP tests target the independent definition surface. The `core/`, `electron/`, `cli/` and `src/` modules retain their desktop persistence, collaboration, IPC and library responsibilities; see the [architecture guide](../ARCHITECTURE.md).

## Engine responsibilities

| Boundary | Current modules | Required behavior |
| --- | --- | --- |
| Document and commands | `editor/document`, `commands`, `geometry` | Pages/layers, stable IDs, transforms, hierarchy, selection, paths, constraints, atomic edits and Undo/Redo |
| Rendering, typography and layout | `editor/render`, `fonts`, `layout` | DOM/SVG display, local fonts/images, measured text, flex/grid layout, zoom, masks and Boolean paths |
| Interaction and workspace | `editor/interaction`, `ui` | Pointer/keyboard tools, text/path editing, clipboard, menus, inspectors, accessibility, focus and cancellation |
| Components, assets and styles | `editor/components`, `assets`, `styles` | Main/instance propagation, overrides/reset, detach, variants, properties, nesting, local libraries and reusable styles |
| Formats, export and MCP | `editor/formats`, `export`, `mcp` | Canvas/HTML/SVG conversion, image/document exports, native save/cancel/error handling and all 19 agent tools |
| New regressions and synthetic data | `editor/__tests__`, `tests`, eligible fixtures | Direct evidence at implementation and host boundaries, without republishing inherited test bodies |

OFL font files remain unchanged licensed third-party materials with copyright notices, source URLs and hashes. Runtime libraries and their native dependencies likewise keep their own terms. Rewriting permissively licensed upstream code solely to make it look different is unnecessary; preserving its actual obligations is necessary.

## Authoring and review rules

Record each module group's inputs and source exposure in the [provenance ledger](../independent/PROVENANCE.md) and its implementation report. Public data and tool names may be retained for interoperability. Do not copy, mechanically translate, rename or reformat restricted implementation and label it independent. Planning participants had source exposure, so the project makes no unexposed clean-room claim.

Review compatibility through independently authored fixtures and actual journeys: editing, typography, paths, layout, styles, component overrides/variants/nesting, portable files, native exports, local persistence/recovery, author-isolated Undo, MCP and four-client collaboration. A source-comparison result or a passing test suite does not establish legal ownership or universal behavioral equivalence. Full-library performance and final review remain separate acceptance requirements until their actual results are recorded.

## Publication boundary

The [MIT publication guidance](MIT_READINESS.md) explains eligible project code and upstream terms. The [snapshot policy](../independent/publication-policy.md) defines the separate allowlisted local export, synthetic-history reseeding and fresh evidence selection. Private comparison/planning artifacts and old audit reports remain outside that clean source history.

Never upload the original private Git history, even when the current working tree no longer contains restricted files. New history must begin in the separately reviewed snapshot. Neither a new MIT file nor a local export authorizes remote publication; this task has performed no upload.
