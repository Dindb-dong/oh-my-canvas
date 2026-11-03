# Components, styles, assets and library implementation

Authoring inputs: `editor/contracts.ts`, `docs/independent/contracts.md`, `PLAN.md`, `PROVENANCE.md`, `parity-manifest.json`, the independently worded `behavior-contract.md`, native `structuredClone`/Map/Set APIs, and the independently authored document/geometry lane. No restricted editor/canvas source, old test bodies, other Leviosa sources or old component generator was read, copied, translated or used as a template by this worker. The overall project is source-exposed through its planning participants; this is not a clean-room or legal-clearance claim.

Eligible interoperability data inspected: `docs/design/system/component-library.omc`, decoded read-only with the original host's `core/storage.mjs` and `Replica.document`. The data contains 1065 editable objects, 14 variant sets with 170 variants, two composed mains, and five non-main linked instance roots. Its serialized `characters` overrides and visibility/text bindings informed compatibility, without reading its generator.

The ponytail skill was used for minimal dependency-free implementation and direct static checking. Its recommendation for immediate regression checks is superseded by the user's explicit implementation-before-regression phase gate.

## Public API

- `createComponentService(editor).run(action,args)` returns `{selection,componentId?,property?,variantSetId?,pageId?}`. All durable edits use one `Editor.transact` and join an enclosing transaction. Callers apply returned selection/page; the service emits no independent selection event.
- `list(query='',offset=0)` returns `{components,total,nextOffset}` with a page size of 200. Disabled linked libraries are excluded from the asset catalog while existing instances remain usable.
- `reconcileComponents(before,draft)` is a pure candidate hook with no event/history side effects.
- `duplicateComponentMain(doc,page,id,{parentId?,dx?,dy?})` returns a linked clone or undefined for ordinary shapes. It performs no transaction and is injected into document commands by the integration lead.
- `createStyleService(editor)`: `create(type,name,value,description?)`, `update(id,patch)`, `rename(id,name)`, `remove(id)`, `apply(id,ids,kind?)`, `detach(ids,kind?)`, `list(query?)`, `users(id)`, `run(action,args)`, `reconcile`.
- `createAssetService(editor)`: `list(query?)`, `insert(componentId,options)`, `addFile(metadata)`, `remove(id)`, `place(id,options)`, `libraries`.
- `normalizeLibraries(doc)` hydrates persisted offline snapshots before first projection; `reconcileLibraries(before,draft)` handles newly introduced snapshots before component reconciliation.
- `createLibraryService(editor)`: `list()`, `add(snapshot)`, `enable(id,enabled)`, `remove(id)`, `update(id,snapshot)`, `insert(libraryId,componentId,options)`.

## Feature mapping

All statuses below mean implemented and statically checked; runtime verification intentionally awaits the lead's implementation-complete barrier.

| Requirement | Implementation |
| --- | --- |
| CMP-01 create main from one/many selected shapes | `index.ts` create action; `model.ts` frame and shared document factory/tree helpers |
| CMP-01 linked instance across pages and optional parent/world placement | instance action; `model.ts` cloneTree |
| CMP-01 duplicate/copy main becomes linked instance | exported duplicateComponentMain; integration via A commands |
| CMP-01 source field, child insertion/deletion/reorder propagation | `reconcile.ts` syncInstance with stable source-to-instance mapping |
| CMP-01 ordinary field overrides, separate characters/text formatting | overrideChanges, mergeContent; paragraph/run content retained independently |
| CMP-01 root movement remains spatial and translates descendants | source-relative placement; override detection subtracts enclosing instance movement |
| CMP-01 nested source dependencies and source mappings | topological reconciliation and per-component componentSourceIds; inherited nested overrides preserved |
| CMP-01 reset all | reset action restores source values and inherited nested overrides in the same transaction |
| CMP-01 detach, source deletion | detachComponent removes outer linkage and retains eligible nested component instances |
| CMP-01 dependency cycles rejected | model.validateComponents before/after reconciliation; errors roll back candidate |
| CMP-02 combine variant-set frame | combine action; frame.isVariantSet and component.variantSetId |
| CMP-02 add variant keeps nested instances and property definitions | add_variant action; cloneTree; copied property definitions |
| CMP-02 equal axes, unique name/value combinations | model.validateVariants invoked by actions and reconciliation, including inspector JSON edits |
| CMP-02 switch by component ID or axis/name/value | variant action; remapVariant matches compatible layer paths and retains overrides/property values |
| CMP-02 returned selection/page | run result is explicit and no service-side selection event |
| CMP-02 text/boolean/swap definition create/edit/remove | property, edit_property, remove_property; boolean string validation |
| CMP-02 bind existing or new property to owned eligible descendant | bind action checks tree ownership, nested boundaries, text/swap target capability |
| CMP-02 main defaults and instance overrides | set_property, applyProperties; componentProperties plus propertyValues read compatibility |
| CMP-02 removal removes stale bindings/values across pages | remove_property action |
| CMP-02 failure atomicity and one operation | all actions mutate one isolated Editor.transact candidate; no standalone history events |
| CMP-03 14-family editable data preserved | original document data inspected, never flattened/regenerated; all model fields retained |
| CMP-03 200-record search/pagination and stable IDs | list; read-only queries do not regenerate records |
| CMP-03 one tile per variant set; insert first variant | asset.list groups sets; asset.insert resolves set ID to first live variant |
| UI-01 Assets page/slash grouping metadata | asset.list supplies pageId/pageName/path/variants; UI owns presentation |
| AST-01 local asset metadata, search, image/SVG placement | assets service addFile/list/place/remove; font loading remains font-catalog responsibility |
| AST-01 paint/text/effect create/apply/edit/rename/description | styles service; canonical paints/text/effects persisted |
| AST-01 remove/detach preserve resolved appearance | style refs removed while resolved fields remain |
| AST-01 style references across pages and rich text runs | reconcileStyles + users; textStyleId/fillStyleId independently handled |
| AST-01 updates retain explicit per-user field overrides | previous resolved values are compared by field; one service transaction |
| AST-01 slash style groups | slash-delimited style names preserved for UI grouping |
| AST-01 persisted offline library snapshots | createLibraryService stores snapshot and editable source page with mapped stable IDs |
| AST-01 enable/disable keeps used instances/styles | enable changes availability only; imported resolved definitions remain |
| AST-01 compatible update with override preservation | update checks existing property ID/type compatibility, imports source/style revisions in one transaction |
| AST-01 unlink retains used local content | remove removes link metadata and retains editable definitions/style values |
| AST-01 paid/cloud provider availability | none invented; only actual supplied local metadata/snapshots are advertised |

## Validation and remaining work

Strict TypeScript checking of these entry points passes with ES2022/ESNext/Bundler and DOM libraries. No regression tests were authored or executed by this worker before the implementation-complete gate. There are no intentional stubs, disabled required options, old-runtime fallbacks or knowingly omitted assigned features.

Runtime acceptance remains unverified: nested instance editing/reset/detach, cross-page source edits and variant/property changes, library compatibility/update/disable, real Assets/inspector interactions, supplied document rendering/reopen, and one-operation host Undo/Redo must be exercised after the lead opens the regression phase. Static implementation does not establish runtime parity. Renderer/font/clipboard resource caches belong to their respective lanes, and no independent resource cache is introduced here.

## Static integration review after initial handoff

Reviewed only the new `editor/index.ts`, UI/inspector/clipboard, MCP and command call sites. Nested component transactions correctly read the active candidate through `Editor.doc`; facade initial library normalization and library→component→style→layout hook order are wired. Command source IDs, pagination and result selection/page handling agree with the service contracts.

Fixed in this lane after that review:

- Disabled library component IDs cannot bypass catalog availability through direct instance insertion; disabled library styles stay listed when used on actual document pages.
- Applying paint styles to text updates each run's independent paint reference/resolved fills.
- Text/effect style application only changes its defined formatting/effect fields. A UI-created text style containing an initial run's `text`, paint or opaque fields therefore cannot overwrite characters or unrelated paint.

Reported to owners for resolution before the implementation-complete checkpoint:

- UI inspector must distinguish `isMain` from `isInstanceRoot`, because eligible legacy mains carry both flags; main variant/property controls would otherwise be hidden and instance-only operations exposed.
- UI component result wrappers must apply returned `pageId` before `selection`.
- MCP affected-shape scanning must account for a component result on another page. The MCP owner confirmed a page-aware result/alias/measurement change.
- UI style/asset/library operations invoked during an active text session must finish that session or use its local formatting path before opening a new transaction.

No runtime/regression tests were authored or run for this review.

## Post-barrier fresh regression evidence

The parent explicitly opened regression authoring/execution at barrier commit `f86e063`. After that checkpoint this lane independently authored `editor/__tests__/components.test.ts` (18 cases) and `editor/__tests__/styles-library.test.ts` (12 cases). Fixtures are new synthetic two-page documents and a two-variant offline snapshot; no inherited test body, customer document, source generator or network service was used. The files run in the repository's node Vitest environment with no production endpoints or external writes.

Command: `vitest run editor/__tests__/components.test.ts editor/__tests__/styles-library.test.ts` using the installed binary. Result: **2 files passed, 30 tests passed**. Strict TypeScript checks including both tests and D entry points also pass.

Fresh regression failures exposed and fixed these D-owned defects:

1. Splitting equal-style rich-text runs was incorrectly treated as a typography override, blocking later source formatting. Override detection now compares normalized adjacent run-style signatures independently of characters.
2. A swap to a component containing the edited main entered synchronization before cycle rejection. Source graph validation now runs before that synchronization.
3. Direct edits to bound nested text were overwritten by an inherited property dictionary. Bound values now update the owning main default or instance value before source reconciliation.
4. Outer reset retained local text because inherited override flags protected it during source copying. Reset first copies the source, then restores inherited override/property metadata.
5. First add-variant discarded existing/name-encoded axes and rejected a compatible named variant. Initial set creation now retains/infer those axes.
6. Legacy `propertyValues` lost unrelated values on a single-property update and were not remapped during variant switching/detach. Writes migrate existing values; variant remapping and detach handle both representations.

Directly exercised matrix records (model/service scope):

- `DOC-03.isolated-candidate`.
- `CMP-01.create`, `instance`, `duplicate-main`, `source-fields`, `source-tree`, `characters-override`, `text-style-override`, `root-position`, `nested-maps`, `nested-inherited`, `reset`, `detach`, `source-delete`, `cycle-reject`.
- `CMP-02.combine`, `add-variant`, `axes`, `combination-unique`, `switch`, `variant-override-remap`, `returned-page-selection`, `property-text`, `property-boolean`, `property-swap`, `property-create`, `property-edit`, `property-remove`, `property-bind`, `property-set`, `single-operation`. Cross-main ownership rejection is exercised for `property-ownership`; every possible nested ownership boundary is not claimed covered.
- `CMP-03.pagination`, `stable-records`, `tile-family`, `insert-first` on synthetic fixtures.
- `AST-01.local-metadata`, `local-placement`, `style-paint`, `style-text`, `style-effect`, `style-crud`, `style-detach`, `style-users`, `style-ref-independence`, `style-update`, `style-slash`, `library-snapshot`, `library-hydrate`, `library-enable`, `library-update`, `library-unlink` at document/service level.
- Local single-operation/undo portions of `HIST-01.compound-operation` and `nested-join`; host/IPC/author history is not covered by these node tests.

Remaining evidence gaps: the actual 14-family/170-variant supplied document has only data-inspection evidence in this lane; its visual/edit/reopen journey remains required. These node tests do not establish actual Assets/inspector interactions, native rich-text input/IME, image/font decoding or resource disposal, PDF/raster output, cross-process persistence/author-isolated Undo, MCP transport, TLS participants, or publication clearance. No cross-lane source defect was exposed by these targeted D tests; independent integration and real-application checks remain the parent's responsibility. No commits or uploads were made.

An additional E-authored MCP regression exposed a nested swap binding bug: synchronizing the inner component deleted the binding owned by its outer component. A new D domain case now covers changing the main's swap default, inserting the outer instance, overriding only that instance, and repeated frame↔leaf swaps. Root synchronization retains outer-owned bindings; leaf sources remove obsolete container child lists; source/component changes no longer create false field overrides. The targeted D suites plus E's complete MCP file passed **117/117** at this checkpoint (31 D cases, 86 E cases). No E test was edited.

The same swap regression was extended to preserve a user-edited descendant after a leaf→frame swap and an unrelated source edit. This exposed outer synchronization treating swapped descendants as obsolete outer-source children and recreating them. Reconciliation now recognizes explicit nested source ownership: it retains that component's subtree/IDs/overrides, applies outer position/binding updates, and delegates the retained subtree's source changes to its own component. The extended case and all D/MCP targets still pass **117/117**; strict TypeScript passes. Real-library browser evidence remains separately recorded under `docs/qa/independent-library-e2e.md`.


## Final actual-library desktop evidence

The final parent-launched combined-build journey passed on **2026-11-03 12:07:01.645–12:07:14.341 UTC** (12.696 seconds), after the D nested-swap and B/C cache/thumbnail/label fixes. Evidence: `docs/qa/independent-library-e2e/report.json`, the four final PNGs in that directory, `docs/qa/independent-library-e2e.md`, and `work/independent/library-final.log`.

The native main-process import retained **1065 objects, 172 mains/components, 170 variants, 14 variant sets, five nested instances and 254 valid bindings**. Actual Assets insertion produced a ten-object composition with two nested instances and a linked Button variant. Inspector property editing (`QA canvas`), variant switching and source-main width editing (132→149) propagated while retaining the text override. After saving, closing Electron and reopening in a fresh process, the document retained **1079 objects, 172 mains, 170 variants, 14 sets, nine nested instances and 260 valid bindings**, including those edits. No renderer page errors, console errors or unhandled harness rejections were recorded.

All **16 real source-rendered previews and 16 contained family labels passed twice**, after import and after restart. Direct inspection of all four final screenshots confirmed actual thumbnail content, readable visible family labels, property/variant state, the main width and reopened state. DOM measurements cover all tiles, including lower rows: tile client/scroll widths 106/106 and label client/scroll widths 86/86; the two long composed-main names wrap within two lines. The earlier generic-preview and overflowing-label findings are closed; this journey has no open visual blocker.

This supersedes the earlier actual-library data-only/unverified statements above. It supplies real-application evidence for the supplied-library portions of `CMP-03`, representative `CMP-01` propagation, `CMP-02` property/variant editing and cross-process persistence. The separate 117-case D/MCP pass remains the domain/transport evidence. Every possible variant/property combination, native IME, unrelated exports, multi-author history/TLS and publication clearance remain separate scopes; this run makes no claim about them. Only documentation was changed for this final evidence handoff; no production changes or commits were made.
