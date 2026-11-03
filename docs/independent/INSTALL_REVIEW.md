# Installed projection refresh: follow-up review

Reviewed 2026-11-03 with the requested GPT-6 Astra high review workflow. **Verdict: APPROVE. Architectural status: CLEAR for this bounded change.** No actionable finding remains in the one-line runtime change or its added regression. The broader limits in [the earlier final review](ASTRA_FINAL_REVIEW.md) remain unchanged.

## Scope and conclusion

This read-only code review covers the event condition at [editor/ui/index.ts:1422](../../editor/ui/index.ts#L1422) and the projected insertion/rename/removal regression at [ui-inspector-locking.test.ts:209](../../editor/__tests__/ui-inspector-locking.test.ts#L209). Only this review document was authored. Retired restricted sources were not accessed; no unrelated audit or runtime edits were performed.

The parent reproduced an installed MCP create/read/Undo sequence in which the authoritative host and editor document were restored, but the layer tree retained the removed record. The cause agrees with the actual code: [receiveDocument at line 350](../../editor/document/index.ts#L350) emits both `projection: true` and `deltas: true`, while the old UI condition rejected every event containing `deltas`.

The new condition preserves the viewport/hover exclusions and allows `projection` to override the preview-delta exclusion:

| Event | Layer-panel refresh after the change |
| --- | --- |
| Durable document change without preview deltas | Yes, unchanged |
| Received document projection with deltas | Yes, fixes the stale tree |
| Local gesture preview with deltas and no projection | No, unchanged |
| Viewport-only or hover-only update | No, unchanged |

The projection already updates and prunes the document before emitting the event. `renderLeft` reads that current document and builds the panel; its render path does not synchronously emit another editor mutation, selection or viewport event. Interactive callbacks are registered rather than invoked during rendering. The existing destruction and focused-input guards remain in place. No new reentrant mutation or repeated rendering loop was identified. Remote document projections now incur the intended panel rebuild; this does not move ordinary pointer previews, hover or viewport changes onto that path. No new large-document benchmark was performed for this follow-up.

The regression uses the real Editor and mounted workspace with existing view/font service doubles. It receives a renamed layer and a new layer, verifies the rendered names, then receives a removal and verifies that only the removed name disappears. It requires no selection change to trigger the refresh. The parent reports that it failed before the repair; the reviewer independently executed the repaired file and observed **6/6 tests passing**. `git diff --check` also passed for both changed files.

## Verification boundary

- Reviewer execution: focused UI/locking/projection file, 6 tests passed.
- Parent-reported full run: 340 editor tests across 12 files, strict checks and build passed.
- Read-back of the refreshed [native UI report](../qa/independent-ui/report.json): 37 passed, zero failed, zero page errors, not interrupted; timestamp 2026-11-03 12:59:24 UTC.

**ACCEPT and closed:** the stale layer-tree projection defect. **REJECT:** treating all delta events as disposable previews; received projections use the same flag and require panel refresh. **DEFER:** final rebuilt/installed artifact identity and the installed MCP create/Undo readback are delivery checks owned by the parent and were not independently executed by this follow-up reviewer. This is source-change approval, not a claim that those subsequent installation checks have already passed.
