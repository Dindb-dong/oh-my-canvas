# Local publication snapshot policy

This policy defines a fail-closed **local source snapshot**, separate from the private working repository. The exporter does not grant rights, establish independent authorship, or declare the application release-ready. The source provenance, dependency notices, synthetic-data eligibility and fresh verification still require review.

The implementation is [prepare-publication.mjs](../../scripts/prepare-publication.mjs). Creating a snapshot or initializing Git does not upload anything. This task leaves export execution and any new initial commit to the parent after review.

## Inputs and staging boundary

Only stage-zero regular files recorded in the repository index are candidates. Fresh task files must be intentionally staged before an export; ignored/untracked files are never discovered by filesystem recursion. Each candidate's working bytes must equal the staged Git blob hash. Unmerged entries, unstaged differences in an eligible file, symlinks, nonregular files, paths escaping the checkout and oversized inputs cause refusal.

The parent must review staged contents and source ownership first. The exporter never stages files, switches branches, resets changes, reads commit objects for old content, clones a repository or copies Git metadata/history. It uses only local Git inventory/object-format commands and the installed original host document decoder.

## Allowlist and exclusions

| Area | Default policy |
| --- | --- |
| Root | Named README translations, LICENSE/notices, design/implementation/contribution/security documentation, package and lock file, entry HTML, TypeScript/Vite/Vitest configuration and Git ignore/attributes files |
| Application | Staged regular files in `core`, `electron`, `cli`, `src`, `editor`, `tests`, `scripts` |
| Assets and notices | Staged `assets`, `licenses`, `fixtures`, `.github`; exactly `build/icon.png`, `public/app-icon.png`, and the two bundled-font license texts under `public/fonts` |
| Current documentation | Eligible Markdown/JSON/HTML under `docs`, including independent contracts, provenance, feature matrix, checkpoint, lane reports and this policy |
| Synthetic portable documents | Exactly `docs/design/system/component-library.omc` and `docs/design/oh-my-canvas-ui-kit.omc`, after decoding and fresh-history reseeding |
| QA evidence | All `docs/qa` content excluded unless its **exact staged path** is explicitly supplied using repeated `--allow-evidence` arguments |
| Private comparison/planning | `docs/licensing/source-provenance.json`, `docs/independent/source-comparison.json`, private `PLAN.md`, `implementation-state.json`, and the private source-comparison script excluded |

Hard exclusions override the allowlist: Git/agent/runtime state, worktrees, temporary work, inherited vendor/apps trees, dependencies, bundles/packages, profiles/user data, secrets/credential directories, environment files, private-key/certificate-container extensions, logs, backups and temporary files. An evidence argument cannot override a hard exclusion or reintroduce a private comparison artifact.

Per-file input is bounded at 64 MiB and the source snapshot at 512 MiB. These are protective export limits, not application document capacities. The application decoder independently enforces its existing portable document/state capacities.

The exporter rejects text containing machine-specific absolute home paths and known private-key/access-token patterns, printing the file and category without matched secret values. This is an additional guard, not a complete secret or privacy audit. Embedded images/fonts and synthetic document contents still need human provenance and privacy review.

## Evidence and documentation links

Old screenshots and QA JSON are not accepted automatically. Explicit `--allow-evidence` means that the parent reviewed that exact staged file as fresh evidence or an eligible historical report. A historical Markdown report must clearly identify its old implementation/date and must not be represented as proof of the replacement engine. An old screenshot does not become fresh evidence by changing its filename.

Every included Markdown local link, image target, HTML `href`/`src` and reference-link definition must resolve within the included snapshot; Markdown fragment anchors must exist. Directory links are allowed only when that directory has included files. Absolute machine links and path escapes are rejected. Network links are not fetched or verified.

The exporter does **not** silently rewrite Markdown, remove references or invent substitute evidence. Excluded old screenshots/comparison JSON can therefore make the preflight fail. The parent must update the owning documentation to a public-safe, accurate current report or explicitly permit reviewed evidence. Historical licensing summaries may remain if they clearly describe their limited baseline, omit private machine paths/comparison artifacts and link only to included material.

## Synthetic `.omc` history removal

A portable `.omc` file may contain deleted records in its prior Yjs state. Byte-copying it would preserve that history even if the visible document looked synthetic.

For the two explicitly eligible files the exporter:

1. Calls the original host `decodeFile`, validates the materialized current document and keeps its existing document ID/title.
2. Constructs a new empty original `Replica`, assigns a client ID derived deterministically from the document ID/current-content hash, and seeds only the validated current flattened fields in one seed transaction.
3. Calls `encodeFile` for a fresh v2 envelope. Its `updatedAt` is replaced with the original stable date, then creation date or a fixed epoch; the old thumbnail is omitted because it is derived visual evidence.
4. Decodes the new bytes again and checks deep document equality, ID/title equality, and empty Undo/Redo stacks. Source and result hashes, current-document hash and state-byte counts are recorded in the manifest.

No previous CRDT update bytes, deleted records, Undo/Redo stack or old thumbnail enter the new replica. Existing source files remain unchanged. The decoder treats the portable file as data: no fixture generator, HTML script, template expression or source payload from the document is evaluated. This history reset does not remove visible sensitive content; the current synthetic document remains subject to review.

## Output identity and verification

`--out` must name a **nonexisting directory outside the checkout**, with an existing parent. Symlinked parent paths are resolved before this check. The exporter never overwrites or merges into an earlier output.

Files are processed in a fixed lexical order. Untransformed file bytes are copied exactly; `.omc` bytes follow the deterministic reseeding above. Every source is hashed before preflight and rechecked before writing, every destination is reopened and SHA-256 checked, and the manifest is written last and read back. The output manifest records relative paths, output mode/size/hash, source hash, transformation details, explicit evidence and stable source/snapshot digests. It contains no source checkout path, remote URL or private commit history.

`PUBLICATION_MANIFEST.json` lists copied payload files; it does not list itself recursively. The exporter prints the manifest hash separately. Filesystem timestamps are not part of content identity. A failure after output creation leaves `PUBLICATION_INCOMPLETE.txt`; that directory must not be treated as a completed snapshot or published.

Optional `--init-git` initializes an empty local repository with templates disabled **after** successful content/hash verification. It performs no add, commit, remote configuration or network operation. The parent must review the manifest before choosing to initialize a new repository or make its own initial commit. Do not carry private repository history into that repository.

## Commands after parent review

First inspect staging and run the read-only preflight:

```sh
git status --short
node scripts/prepare-publication.mjs --check
```

Reviewed QA files require exact opt-ins on both preflight and export:

```sh
node scripts/prepare-publication.mjs --check \
  --allow-evidence docs/qa/independent-render-results.json \
  --allow-evidence docs/qa/independent-render-gallery.png
```

After the preflight passes, choose a new sibling output directory. For example, from the source checkout:

```sh
node scripts/prepare-publication.mjs --out ../oh-my-canvas-public-source \
  --allow-evidence docs/qa/independent-render-results.json \
  --allow-evidence docs/qa/independent-render-gallery.png
```

The example evidence names are not an assertion that their current bytes have passed final review. Do not execute this export until the parent has approved those staged files and resolved all documentation links, remaining verification and publication gates.

### Verbatim upstream notices

Project-authored Markdown must resolve its local links inside the snapshot. The sole exception is Markdown under `licenses/native/texts/` whose **exact copied bytes and byte length match an entry in [the native manifest](../../licenses/native/manifest.json)**. That entry must also provide an HTTPS `sourceUrl` and the original `upstreamPath`; these pinned upstream routes are the canonical context for its relative links (such as upstream README/source siblings).

The exemption is checked only after the notice hash and origin route have been verified. A missing manifest, missing entry, modified notice, wrong byte count or absent upstream route fails preflight. It does not exempt project-authored licensing documentation, `licenses/native/README.md`, arbitrary added Markdown or source/privacy checks. Preserve upstream notice bytes exactly; do not rewrite their links or download whole upstream trees merely to satisfy the project's local-link checker. The exporter performs no network requests to those upstream routes.

## Focused exporter regression evidence

The fresh [publication exporter tests](../../tests/publication-export.test.mjs) cover allowlist/private-path/token gates, included project links and anchors, verified upstream notice exemptions and tamper failures, actual preserved notice checksums, deterministic fresh-history `.omc` encoding with deleted historical content absent, source-buffer preservation, and refusal to overwrite an existing output directory. Run `node --test tests/publication-export.test.mjs`. The focused run passed 8/8 tests; it creates no source snapshot and cleans its one task-owned temporary gate directory. These checks do not replace the full staged-tree preflight, manifest review or release gates.

Generated production font binaries and CanvasKit WASM are omitted from the source snapshot and ignored after a build. `npm run build` recreates them from the locked, audited packages. The application bundle still includes and verifies those runtime resources and their notices. The five licensed test-fixture font inputs remain included.
