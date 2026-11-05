# Troubleshooting

[README](../README.md) · [Getting started](GETTING_STARTED.md) · [Safe reporting](../SECURITY.md)

Use a copy of your document while investigating. Include the app version/source commit, OS/architecture, a minimal synthetic reproduction, and the exact error. Never include private invitations, tokens, `mcp-runtime.json`, customer designs, or unsanitized `.omc` history in a public report.

<a id="mcp"></a>

## An agent cannot connect or edit

- Launch the app and open a document in the editor. A library-only screen has no active editable canvas.
- Re-copy **MCP → Copy configuration** from this app/profile. The default is the app-owned HTTPS URL; supply the private bearer in the client environment. Check [MCP credentials and rollback](MCP.md), particularly GUI environment inheritance. Rebuild a source checkout before using its bundled CLI.
- Trust the profile's specific public TLS certificate through the client's supported trust or pinning mechanism. The app does not install OS trust. Never disable certificate verification or downgrade to plain HTTP; a port impostor must not receive the bearer. Codex GUI trust setup remains unverified.
- An older pre-TLS stdio relay reports an invalid runtime after migration. Restart that client connection with the current bundled relay. The version-2 descriptor intentionally contains no token, and the old exposed token is replaced by the separate private `mcp-token-v2` credential; do not restore an old descriptor or downgrade to HTTP.
- The installed app uses its own Electron Node mode; a separate Node runtime is unnecessary. Keep the quoted executable path intact if it contains spaces.
- Refresh the MCP client connection after installing a new binary. An already-open Codex chat may need a new chat to discover newly registered tools.
- `busy` while typing/scrubbing is expected. Finish that user transaction, then retry the write. Read tools remain available.
- Separate HTTP sessions and stdio processes have separate author identities. Undo cannot revert another agent's or the user's latest step. A restart or document replacement discards aliases; start with a fresh `get_context`. Read back an uncertain write before making another mutation.
- Variant switching can replace the instance root; use the returned selection alias for subsequent calls. Component actions are outside `batch`.
- An invalid or expired TLS identity leaves MCP unavailable. Restore the profile's original private identity files, or explicitly renew the identity and update the client's certificate trust. Do not replace a certificate from an unverified listening port.
- A port conflict leaves editing available and MCP unavailable. Close the conflicting server normally or launch this profile with a separate explicit `--mcp-port`; do not terminate unrelated processes.
- Do not forward the MCP port, remove authentication, or change certificate checks to work around a connection error.

## A teammate cannot join

All participants need the current protocol v2. Old invitations are rejected; create a new invitation from the updated host. The host must remain running and reachable. Ending hosting invalidates the invitation. There are four total slots, including the host; a fifth connection is refused.

The same-machine four-client flow is tested. External internet/NAT has not been tested here. On another machine, verify the collaboration address is reachable from that machine. An automatically displayed local address may belong to the wrong interface or VPN. Public internet, double NAT, CGNAT, firewalls, and router rules may block access. A port-forward rule, where appropriate, must target the collaboration port—not MCP. The app does not create those rules, supply a relay, or guarantee a network route.

Do not disable TLS verification or publish an invitation for someone to test. Ask a trusted participant to join privately. If the host is gone, a participant can rehost their saved replica with a new invitation.

## A save or import fails

A malformed or oversized file is rejected before import. New files use `.omc` v2; v1 remains readable. Opening an older portable copy merges with newer local history rather than erasing it.

A document or CRDT state is limited to 16 MiB; the file/wire envelope is limited to 24 MiB. Reduce embedded assets or duplicate a readable current document to start fresh history. A duplicate has a new document ID and is separate from the existing collaboration room.

For recovery, keep the original file and its `.bak` before attempting manual changes. The store tries a valid backup and marks recovery. Export a separate portable copy after recovery. An unreadable file appears as a damaged document rather than breaking the whole library. Do not use Delete as a repair operation: it removes this device's primary and backup.

## An export is cancelled or fails

Check the native save dialog. Cancel intentionally produces no file. Choose a writable destination; a failed per-layer write shows an inline error and can be retried. SVG uses the renderer's measured layout; PNG may be a downscaled preview. Per-layer PDF is raster-backed. Report a synthetic document if measured text or geometry differs from the export.

## Build or package issues

Use the lockfile with `npm ci`, Node 22.12+, and `npm run build`. A network connection is needed to install dependencies/Electron initially. Build before running E2E or source MCP. Packaging from a `node_modules` symlink can omit indirect dependencies; use the checkout's real installed directory.

macOS arm64 is the verified target. A configured Windows/Linux target is not evidence that it has been tested. This personal macOS build is unsigned/unnotarized; the repository has no published installer or automatic updater. Do not bypass operating-system security prompts as a generic troubleshooting step.

## Report it

Use the [bug form](../.github/ISSUE_TEMPLATE/bug_report.yml) as a checklist. If no remote issue tracker exists, save a local report and share it through an already trusted maintainer channel. Follow [CONTRIBUTING.md](../CONTRIBUTING.md); do not invent a release URL or send private project files to a public tracker.
