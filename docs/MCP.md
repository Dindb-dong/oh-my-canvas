# Local MCP connection and recovery

The app owns the HTTPS endpoint `https://127.0.0.1:47831/mcp` during normal operation. It uses the installed official SDK's **2025-11-25 protocol family**, including initialize and session IDs. It does not claim support for the later sessionless protocol. There are 19 tools; start with `get_context` and `get_guide`.

Open a canvas and keep the app running. **MCP → Copy configuration** provides URL configuration without embedding the secret. The app never rewrites global client settings. A failed MCP startup leaves local editing available; inspect the connection dialog rather than forwarding a port or disabling authentication. A port conflict never falls back to a random port during normal operation or terminates another process.

For isolated development and test profiles, `--profile=/absolute/profile` uses an ephemeral port. `--mcp-port=0` explicitly selects an ephemeral port; `--mcp-port=47832` selects a separate fixed port. `--mcp-disabled` runs the editor without MCP. Use the URL shown by that profile, rather than assuming the normal port.

## Credentials and registration

Each profile has a private `mcp-token` file in its application-data directory. It contains a persistent bearer token, is mode 0600, and survives app restarts. `mcp-runtime.json` is a disposable private descriptor containing the active port, token, and public certificate path for legacy clients. Never share either file or include their contents in logs, screenshots, commits, or issue reports. The normal macOS data directory is `~/Library/Application Support/oh-my-canvas`.

The profile also keeps a persistent self-signed TLS identity. Its public `mcp-cert.pem` path is available in the connection dialog; the private key and certificate are stored together in private `mcp-identity.json` (0600). Never copy or share that identity file. Before supplying a bearer, configure the client to trust that specific certificate from the profile's public certificate file using its supported certificate-store or pinning mechanism. Never establish trust by downloading a certificate from the listening port. The app does not install OS certificate trust. Never disable TLS verification (`NODE_TLS_REJECT_UNAUTHORIZED=0`, `--insecure`, or equivalent) or send the bearer over plain HTTP: a different process occupying the same port must fail certificate verification before receiving it. The token, certificate, and private key persist across restarts. Newly generated certificates last 365 days; invalid or expired identity files stop MCP startup rather than silently replacing client trust. Renewing an identity requires explicitly updating the client's trusted certificate. Protect the private key like the token; the public certificate itself is not a bearer secret.

For the repository's Node SDK consumers, `createMcpFetch(cert)` from `core/mcp-fetch.mjs` supplies a fetch implementation pinned to the profile certificate. Pass it as the official SDK HTTP transport's `fetch` option. Legacy bundled stdio also verifies this certificate. An independently launched Codex GUI's certificate-trust and credential-inheritance path remains unverified; retain a working registration until both are confirmed. The registration below assumes certificate trust has already been configured.

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

Every initialized HTTP session receives a separate server-generated agent, even when clients have identical names or JSON-RPC request IDs. Aliases, Undo ownership, and idempotency keys belong to that agent. DELETE, idle expiry, and successful app shutdown end the session. If saving prevents a native close, the app resumes the same session with its aliases, Undo ownership, and completed replay-cache entries intact. A new document mount also replaces the dispatcher. Reconnect with `get_context`; discard old aliases and Undo expectations. A new session may assign `n1` to a different object.

Explicit SDK cancellation stops queued work and font preparation before mutation. Disconnecting a socket is not an explicit cancellation. A write that already applied is not automatically undone when its response is cancelled or lost. Success responses continue to wait for durable persistence.

After a timeout, lost response, or restart, read the current document before deciding whether to issue another write. Never automatically replay `create_board`, `duplicate`, `write_html`, or `undo`. The optional `oh-my-canvas/idempotency-key` metadata deduplicates matching calls only within the live agent's bounded in-memory cache (500 entries / 8 MiB). It does not provide exactly-once behavior across session termination, document replacement, eviction, or app restart.

## Stdio rollout and rollback

The bundled CLI and authenticated `/rpc` endpoint remain for existing clients and compatibility checks. This is stdio compatibility, not the old HTTP+SSE transport. The installed CLI uses Electron's Node mode, so the installed app does not require a separate Node installation.

Before changing a working client registration, privately save only that entry. Register the HTTP URL, connect to a synthetic document, and verify initialize/list/call, durable readback, and reconnection after app restart. Confirm that a new HTTP connection creates no stdio relay. If a client cannot supply HTTP credentials, restore that saved stdio entry without modifying other MCP registrations. The app's internal `mcp-info` action with `{transport:'stdio'}` still returns the legacy registration used by compatibility scripts.

Existing stdio processes are not automatically killed. End their client connections or restart the client normally. This transport change neither modifies nor disables any external plugin updater, and it makes no disk-reclamation guarantee.

## Local checks

After building, `node scripts/mcp-http-e2e.mjs` launches an isolated real Electron profile and exercises official SDK sessions over certificate-pinned HTTPS, tools, author isolation, failed-close cache preservation, durable readback, and restart invalidation. `node scripts/packaged-smoke.mjs` checks both certificate-pinned HTTPS and the bundled stdio CLI in the packaged app. These checks do not establish certificate trust or credential inheritance by an independently launched Codex GUI.
