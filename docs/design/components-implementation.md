# Reusable components implementation

## Implementation and authoring inputs

The independent component implementation lives in `editor/components/`, with UI, command, document, and MCP integration in the adjacent `editor/` modules. Its required scope includes main components, live instances, grouped overrides, variants, text/boolean/instance-swap properties, local Assets, and the editable design-system document. The earlier inherited algorithms and copied tests are retired. See the [implementation provenance](../independent/PROVENANCE.md) and [component lane authoring record](../../editor/components/IMPLEMENTATION.md).

The [behavior contract](../independent/behavior-contract.md) records compatibility requirements. Public [Penpot variants](https://help.penpot.app/user-guide/design-systems/variants/) and [design-system documentation](https://help.penpot.app/user-guide/design-systems/) provide behavioral vocabulary; they are not a source-code license grant. Planning source exposure is documented in the provenance record, and the project makes no unexposed clean-room claim.

## Supported workflows and verification scope

- Select a frame or layers → Create component (context menu, Assets, or ⌥⌘K).
- Open the header's Components button → Assets. Click or drag a local component to insert a linked instance.
- Select mains → Combine as variants. Names such as `Size=Small, State=Hover` become explicit variant axes.
- Select a main → Add variant. The new main retains nested instances and property definitions, gets a unique variant value and joins the set. Rename its axes/values in the Design panel.
- Edit an instance's variant, text, visibility or swap properties in the Design panel. Main changes propagate while instance overrides remain. Reset restores source values; Detach stops following the source.
- Compound component commands publish one live edit, including property updates to multiple layers, so collaboration and Undo have the same boundary as local editing.
- Components and properties survive .omc export, local reopen and TLS collaboration.

## MCP

`components` lists records, source ids, properties and variant axes (200 records per page, with nextOffset). `component` performs create, add_variant, combine, instance, variant, property, bind, edit_property, remove_property, set_property, reset and detach. Each action is validated on an isolated draft and commits once. It is intentionally called outside `batch`.

Use ids/aliases for shapes; use returned componentId/property ids for records. Instance coordinates are world-space centers. A variant switch may replace the instance root: use the returned `selection` alias for subsequent calls. Boolean property values are the strings `true` and `false`. A property can only bind an eligible descendant of its own main. Invalid calls preserve the live document and history.

## Detailed library

`system/manifest.json` and the HTML authoring sources describe 170 variants across 14 families, plus two composed mains containing five actual nested instances. The source generator `scripts/create-design-system.mjs` builds them through the public MCP, exposes text/visibility properties and combines each family into a real variant set. `--prepare` creates source artifacts only. `--resume` resumes a partially generated, saved document using its component ids without duplicating finished families.

The app document is **Oh My Canvas Component Library**. Duplicate it for a project and add pages for screens; Assets can reuse local components from every page. The portable `.omc` is retained as an editable synthetic compatibility fixture, together with its HTML authoring sources and manifest. The original smaller UI Kit is preserved separately. These assets originated before the engine replacement and remain eligible synthetic data. Full-library acceptance and performance remain open in the [current verification record](../independent/VERIFICATION.md); the data and manifest alone do not establish that result.

## Verification

See the [current verification record](../independent/VERIFICATION.md) for fresh independent-engine results and open work. The four-client Electron/TLS acceptance passed its synthetic collaboration, Undo, image, export and reopen journey. That result does not establish complete component-library acceptance: the full 170-variant library's performance journey remains open.

Required component checks include property ownership, variant failure handling, atomic Undo, no partial mutation on failure, Assets insertion, override/reset, Add variant followed by native Undo, TLS propagation, detach, and portable save/reopen. Run the relevant commands in [TESTING.md](../TESTING.md) and record the actual results. Earlier private-engine review reports and generated-library verification counts are retained only in private history; they do not transfer approval to this implementation.
