# Local MCP connection and recovery

The app owns the HTTPS endpoint `https://127.0.0.1:47831/mcp` during normal operation. It uses the installed official SDK's **2025-11-25 protocol family**, including initialize and session IDs. It does not claim support for the later sessionless protocol. The desktop catalog has 31 tools. Start with `list_documents`, choose a document, then read `get_context` and `get_guide`. The reusable embedded editor exposes 26 editor tools.

Keep the app running; document discovery and creation work even in an empty library. **MCP → Copy configuration** provides URL configuration without embedding the secret. The app never rewrites global client settings. A failed MCP startup leaves local editing available; inspect the connection dialog rather than forwarding a port or disabling authentication. A port conflict never falls back to a random port during normal operation or terminates another process.

For isolated development and test profiles, `--profile=/absolute/profile` uses an ephemeral port. `--mcp-port=0` explicitly selects an ephemeral port; `--mcp-port=47832` selects a separate fixed port. `--mcp-disabled` runs the editor without MCP. Use the URL shown by that profile, rather than assuming the normal port.

## Documents and pages

The desktop library belongs to the current app profile. It is not a filesystem browser. Document IDs are stable library IDs, distinct from page IDs and session-local layer aliases.

| Tool | Arguments | Behavior |
|---|---|---|
| `list_documents` | `query?`, `offset?`, `limit?` | Return matching metadata, `total`, `nextOffset`, `activeDocument` and `view`. Default page size 50, maximum 100. No thumbnail or document payload. |
| `create_document` | `title?` | Create, persist and open a blank canvas. |
| `open_document` | `id` | Finish pending edits, load a stored canvas and return document identity with refreshed context. |
| `rename_document` | `id`, `title` | Persist a name without changing the open canvas. Works on active and inactive documents. |
| `duplicate_document` | `id`, `title?` | Copy and open a canvas, preserving the source. |
| `select_page` | `id` | Select an existing page and return refreshed context. No page creation/deletion. |

Titles are trimmed, nonempty strings of at most 120 characters. Unknown properties, invalid IDs and out-of-range pagination fail validation. Reads work from the library; layer tools require an open editor. Lifecycle success waits for persistence and editor initialization. New/copy/navigation cannot run over an active user gesture or dialog. Use the existing local title metadata; renaming does not rename a portable export or synchronize titles between collaborators.

Example sequence: `list_documents({query:"Product"})` → `open_document({id:"<document ID>"})` → `get_context()` → `select_page({id:"<page ID>"})`. Use the resulting context before editing. `rename_document({id:"<document ID>",title:"Product exploration"})` also works for an inactive canvas.

**Current concurrency limit:** the desktop still has one globally open editor. Opening a document changes that editor and ends other sessions. It does not yet provide simultaneous document tabs or per-repository session binding. Use separate isolated app profiles for concurrent independent work until those are implemented; switching documents is not a multi-document workflow.

Document deletion, arbitrary file-path import/export, profile switching and collaboration invitations are not MCP tools. The library rename entry is **Actions → Rename canvas**; an open canvas also has a visible **Rename** control and **File → Rename canvas**.

## Credentials and registration

Each profile has a private `mcp-token-v2` file in its application-data directory. It contains a persistent bearer token, is mode 0600, and survives app restarts. `mcp-runtime.json` is a disposable version-2 descriptor containing the active endpoint and public certificate path; it contains no token. Credentials stay in the separate private token file. Do not share token files or private profile diagnostics, or include their contents in logs, screenshots, commits, or issue reports. The normal macOS data directory is `~/Library/Application Support/oh-my-canvas`.

The profile also keeps a persistent self-signed TLS identity. Its public `mcp-cert.pem` path is available in the connection dialog; the private key and certificate are stored together in private `mcp-identity.json` (0600). Never copy or share that identity file. Before supplying a bearer, configure the client to trust that specific certificate from the profile's public certificate file using its supported certificate-store or pinning mechanism. Never establish trust by downloading a certificate from the listening port. The app does not install OS certificate trust. Never disable TLS verification (`NODE_TLS_REJECT_UNAUTHORIZED=0`, `--insecure`, or equivalent) or send the bearer over plain HTTP: a different process occupying the same port must fail certificate verification before receiving it. The token, certificate, and private key persist across restarts. Newly generated certificates last 365 days; invalid or expired identity files stop MCP startup rather than silently replacing client trust. Renewing an identity requires explicitly updating the client's trusted certificate. Protect the private key like the token; the public certificate itself is not a bearer secret.

For the repository's Node SDK consumers, `createMcpFetch(cert)` from `core/mcp-fetch.mjs` supplies a fetch implementation pinned to the profile certificate. Pass it as the official SDK HTTP transport's `fetch` option. The newly bundled stdio relay also verifies this certificate and connects through the official SDK HTTP client, forwarding explicit request cancellation. An independently launched Codex GUI's certificate-trust and credential-inheritance path remains unverified; retain a working registration until both are confirmed. The registration below assumes certificate trust has already been configured.

Set `OMC_MCP_TOKEN` privately in the environment inherited by the MCP client. A shell export alone does not establish that a GUI-launched client inherited it. Confirm the actual GUI connection and app restart behavior before retiring an existing working registration. No client setup command below reads or prints the token.

```sh
codex mcp add oh-my-canvas \
  --url https://127.0.0.1:47831/mcp \
  --bearer-token-env-var OMC_MCP_TOKEN
```

Equivalent Codex configuration:

```toml
[mcp_servers.oh-my-canvas]
url = "https://127.0.0.1:47831/mcp"
bearer_token_env_var = "OMC_MCP_TOKEN"
```

Use the HTTP registration on its own. Do not combine `command`, `args`, `ELECTRON_RUN_AS_NODE`, or stdio `env` with this entry. A client with protected static-header support may instead supply the bearer privately, subject to that client's secret-storage behavior. This app does not configure the client's credential store.

## Sessions, cancellation, and uncertain results

Every initialized HTTP session receives a separate server-generated agent, even when clients have identical names or JSON-RPC request IDs. Aliases, Undo ownership, and idempotency keys belong to that agent. DELETE, idle expiry, and successful app shutdown end the session. If saving prevents a native close, the app resumes the same session with its aliases, Undo ownership, and completed replay-cache entries intact. Manual document replacement ends existing MCP sessions. Agent-driven `open_document`, `create_document`, and `duplicate_document` preserve the initiating connection and cancel other pending requests and sessions. Each new document mount replaces the editor dispatcher: discard old layer aliases and Undo expectations, and use the returned context. Ordinary editor requests are stamped with their admitted document ID and reject stale arrivals. A new editor can assign `n1` to a different object.

Explicit SDK cancellation stops queued work and font preparation before mutation. Disconnecting a socket is not an explicit cancellation. A write that already applied is not automatically undone when its response is cancelled or lost. Success responses continue to wait for durable persistence.

After a timeout, lost response, or restart, read the current document before deciding whether to issue another write. Never automatically replay `create_board`, `duplicate`, `write_html`, or `undo`. The optional `oh-my-canvas/idempotency-key` metadata deduplicates matching calls only within the live agent's bounded in-memory cache (500 entries / 8 MiB for editor operations). Workspace mutations keep a separate cache across editor replacement, bounded to 100 entries / 1 MiB across live agents. It does not provide exactly-once behavior across session termination, eviction, or app restart; editor-layer replay entries are also lost on document replacement.

## Stdio rollout and rollback

The newly bundled CLI remains as stdio compatibility for clients that need it. It uses the official SDK HTTP client internally and the same authenticated HTTPS `/mcp` sessions, including cancellation; it does not use a separate `/rpc` tool-execution path. This is stdio compatibility, not the old HTTP+SSE transport. The installed CLI uses Electron's Node mode, so the installed app does not require a separate Node installation.

Older pre-TLS relays already running in a client cannot safely consume the version-2 descriptor: it deliberately omits their expected token, so they fail closed with an invalid-runtime error. Stop those connections and restart the client with the newly bundled relay. Migration creates a separate private `mcp-token-v2` credential; any older `mcp-token` is retained as obsolete data and is no longer accepted as the HTTPS bearer, even if the old runtime descriptor was already removed. There is no HTTP downgrade or old-descriptor fallback.

Before changing a working client registration, privately save only that entry. Register the HTTP URL, connect to a synthetic document, and verify initialize/list/call, durable readback, and reconnection after app restart. Confirm that a new HTTP connection creates no stdio relay. If a client cannot supply HTTP credentials, restore that saved entry using the current bundled stdio relay without modifying other MCP registrations; a pre-TLS relay must still be restarted. The app's internal `mcp-info` action with `{transport:'stdio'}` still returns the legacy registration used by compatibility scripts.

Existing stdio processes are not automatically killed. End their client connections or restart the client normally. This transport change neither modifies nor disables any external plugin updater, and it makes no disk-reclamation guarantee.

## Local checks

After building, `node scripts/workspace-mcp-e2e.mjs` checks empty-library discovery, document lifecycle, session isolation, rename UI and restart persistence using a synthetic profile. `node scripts/mcp-http-e2e.mjs` launches an isolated real Electron profile and exercises official SDK sessions over certificate-pinned HTTPS, tools, author isolation, failed-close cache preservation, durable readback, and restart invalidation. `node scripts/packaged-smoke.mjs` checks both certificate-pinned HTTPS and the bundled stdio CLI in the packaged app. Automated Electron checks opt into `OMC_TEST_BACKGROUND=1` with isolated `--profile` directories. The main process suppresses Dock activation and creates the window hidden before loading it; normal development launch is unchanged. The failed-close fixture intentionally replaces its temporary `documents` directory with a file and expects a filesystem error such as `EEXIST` or `ENOTDIR`, then restores the directory. That error is test injection in a synthetic profile, not evidence of a user-profile save failure.

These checks do not establish certificate trust or credential inheritance by an independently launched Codex GUI.
