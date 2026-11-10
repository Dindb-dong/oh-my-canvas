# Getting started

[English README](../README.md) · [한국어](../README-ko.md) · [日本語](../README-ja.md) · [简体中文](../README-zh-CN.md)

This technical guide is maintained in English. Read [LICENSE](../LICENSE) and [third-party notices](../THIRD_PARTY_NOTICES.md) before modifying or distributing the source.

## Install and run

From an existing checkout, use Node.js 22.12+ and npm:

```sh
cd /path/to/oh-my-canvas
npm ci
npm run build
npm start
```

`npm ci` downloads dependencies and the Electron runtime. The built app bundles fonts and vector WASM; routine local editing does not need a font CDN, authentication server, or paid API. No built-in AI service is bundled. Your MCP client's access and billing remain separate.

For source development, `npm run dev` starts the local renderer/dev workflow. For an app bundle:

```sh
npm run package
# Or build the macOS ZIP and bundle:
npm run dist:mac
```

Use a real `node_modules` directory when packaging. A symlink into another worktree can make electron-builder omit indirect dependencies. Builds use `--publish never`; they do not publish a release. The verified bundle is macOS arm64, `release/mac-arm64/Oh My Canvas.app`. Windows/Linux targets exist but have not been executed. The macOS build is unsigned and not notarized.

On the configured development Mac, the app is installed in `/Applications/Oh My Canvas.app`. This path describes the local installation, not a public download.

## First canvas

Create a canvas from the library or choose **Explore a sample** when no document exists. Use the bottom toolbar for drawing and text, the left panel for layers/pages/Assets, and the right Design panel for properties and per-layer export settings.

Open the included [Component Library](design/system/component-library.omc) through **Open file**. Duplicate it before using it as a new project, then add pages for your screens. It has 14 component families, 170 variants, two composed mains, and five actual nested instances. **Components → Assets** inserts a linked instance. Main changes propagate while instance overrides remain; Reset restores source values and Detach ends the link. See the [component contract](design/components-implementation.md).

## Save, recover, and back up

Documents live in the platform's application-data directory:

| Platform | Default document directory |
| --- | --- |
| macOS | `~/Library/Application Support/oh-my-canvas/documents/` |
| Windows | `%APPDATA%/oh-my-canvas/documents/` |
| Linux | `~/.config/oh-my-canvas/documents/` |

Edits flow through the local CRDT and serialized atomic file writes. Requests complete after fsync; the UI shows persistence errors instead of treating failed storage as success. Each document keeps one previous `.bak` file. If the primary cannot be read, the store attempts the backup and marks the document as recovered. Export a new portable copy after recovery. This mechanism has tests; actual power-cut and disk-failure injection have not been performed.

**Export → Oh My Canvas** creates an editable `.omc` backup with embedded assets and CRDT history. Portable backups belong in a location you control. A duplicate is a new document ID with the current content and fresh history; it does not keep participating in the original document's collaboration session.

Undo/Redo stacks are session-local and are not restored when a document is reopened. Saved CRDT history supports merging; it does not serialize the Undo/Redo stacks. Undo/Redo changes are saved before the operation completes.

Do not use another participant's local replica as your only backup. Deleting a document removes this computer's primary and backup after confirmation; other participants' replicas remain.

## Import design files

Open `.fig` (Figma Design) or `.sketch` (Sketch 43+) using **Import**, or place them through the editor's asset picker or drag and drop. Document import retains all pages; placement inserts the layers of every page into the current page. MCP `import_document` accepts `format:"fig"` or `format:"sketch"` with an explicit absolute `filePath`.

Conversion runs locally in a bounded desktop worker. Frames/groups, basic shapes, vector paths, text and embedded PNG/JPEG/GIF/WebP images remain editable. Design-file input is limited to 256 MiB and expanded archives to 512 MiB. Imported design libraries use the large-document budget below. Repeated bitmap bytes are stored once and referenced by layers; only the active page prepares its image resources. Files exceeding these limits are rejected without modifying the current canvas.

Compatibility is partial: component/symbol links and overrides, variables, mixed text formatting, effects, unsupported paints, masks and complex transforms may differ. Import warnings are shown and saved in document metadata. Auto layout uses saved positions. Install the original fonts for matching typography. Pixel-perfect parity with a particular source file requires testing that actual file; general format support does not establish it.

## Export formats

| Route | Output |
| --- | --- |
| Top Export → Oh My Canvas | Full editable `.omc` with merge state |
| Top Export → Canvas JSON | JSON interchange representation |
| Top Export → SVG | First selected layer, or the first top-level layer on the current page; measured text wrapping and embedded images |
| Top Export → PNG | First selected layer, or the first top-level layer on the current page; preview may be downscaled |
| Design panel → Export | Per-layer PNG, JPG, WebP, SVG, or PDF settings |

Design exports use an explicit native save dialog. Cancel leaves the export unsaved; write failures are displayed and can be retried. PDF export in the layer panel is raster-backed rather than a fully vector PDF.

## Capacity and file versions

Ordinary canvases retain a 16 MiB document/state budget and 20,000 shapes. Imported design libraries opt into 256 MiB for the document and encoded CRDT state, with 100,000 shapes. Both profiles allow up to 100 pages. Portable files and network envelopes are bounded to 384 MiB. These are validation limits, not a performance guarantee: rendering is page-specific, but document validation, collaboration and edits still involve the complete document. A single complex page can take seconds to open.

Large embedded images consume the document budget. Resize assets before placing them. If accumulated history is too large, duplicate the current document to start new history. Invalid or oversized local/remote edits and Undo/Redo are checked before live mutation.

The writer emits `.omc` v2 for ordinary states and v3 (gzip-compressed state) above 16 MiB, and reads v1/v2/v3. Older apps cannot open v3 files. Large-library listings validate the envelope; full CRDT validation happens when opening the document. Existing files are not a license to open a new v2 document in an old app. Keep portable backups when upgrading and update all collaborators to the same current protocol. Unknown versions and malformed metadata are rejected. A damaged saved file is isolated in the library rather than breaking the entire list.

## Local MCP

1. Open a document in the editor.
2. Click **MCP → Copy configuration**.
3. Register that JSON in your MCP client. Keep the application and document open.
4. Start with `get_context` and `get_guide` before editing.

The default configuration connects directly to the app-owned Streamable HTTP URL at `https://127.0.0.1:47831/mcp`. Privately supply the persistent bearer through the client's `OMC_MCP_TOKEN` environment; GUI clients must actually inherit it. The client must trust this profile's public TLS certificate before sending its bearer; the app does not configure OS trust. No secret appears in the copied configuration. See [credential setup, profiles, restart recovery, and stdio rollback](MCP.md).

The app does not automatically modify global client settings. A chat that loaded its tools before registration may need a new chat to discover them. Legacy bundled stdio remains available during rollout; installed users do not need a separate Node runtime for that path.

There are 19 tools. Every HTTP session and legacy stdio process has a separate author identity. Component actions run outside `batch`; use returned selection aliases after switching variants. During a live user text/scrub transaction, agent writes and agent Undo return `busy`; reads remain available. After timeout or restart, read back the document before deciding whether another mutation is needed. Never automatically replay an uncertain write. See [troubleshooting](TROUBLESHOOTING.md#mcp) and [security](../SECURITY.md).

<a id="collaboration"></a>

## Collaboration

**Verified scope:** four separate Electron processes on one Mac using actual TLS. External internet/NAT reachability has not been verified. These instructions describe the feature's requirements, not a completed external-network test.

1. Open a document. Choose **Collaborate → Host a canvas**.
2. Use port `0` for an available local port, or an explicit collaboration port if preparing a manual network route.
3. Start hosting and enter an address teammates can actually reach.
4. Create an invitation and share it privately with trusted editors.
5. Up to three teammates choose **Join a canvas** and paste the invitation. A fifth total participant is refused.

On a LAN, use an appropriate local address. Public-internet use may require manually forwarding the collaboration port to the host and entering the public address/external port. CGNAT, firewalls, double NAT, or routing restrictions may prevent this. The app does not discover public reachability, open router ports, run a relay/TURN service, or elect a host automatically. No public endpoint has been configured for this local checkout.

Invitations carry the session secret and pinned host certificate. Anyone with a valid invitation can edit. Ending hosting invalidates the session invitation; read-only roles and per-person revocation are not implemented. **Never forward the MCP bridge port.**

Each participant stores a local replica. Disconnection triggers reconnect attempts; edits made offline merge when the same session becomes reachable again. Leaving does not delete the local copy. If the host leaves, a former guest can host their saved replica and share a new invitation. Automatic host migration is not implemented.

Different shape properties merge through Yjs; conflicting edits to the same property converge by its rules. Text content is a rich-text property, not a character-level CRDT. Split simultaneous writing across separate text layers. Canonical geometry is rebuilt after merging to keep rendered bounds consistent.

## Next steps

[Architecture](ARCHITECTURE.md) · [Testing](TESTING.md) · [Troubleshooting](TROUBLESHOOTING.md) · [Contributing](../CONTRIBUTING.md)
