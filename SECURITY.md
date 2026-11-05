# Security and private reports

[README](README.md) · [Architecture](docs/ARCHITECTURE.md) · [Contributing](CONTRIBUTING.md)

## Report privately

This local checkout does not configure a public security-reporting endpoint or a monitored security email address. For a suspected vulnerability, contact the maintainer through an already established trusted channel and agree on a private way to share the minimal reproduction. Do not open a public issue containing exploit details, private files, invitations or credentials. If a future GitHub repository enables private vulnerability reporting, use that repository's actual reporting interface; this document does not claim it is enabled today.

There is no promised response deadline, bounty, or blanket third-party testing authorization. Reproduce against your own synthetic documents and isolated profiles. Do not probe other users, routers, production services, or machines without authorization.

## Trust model

- The local user controls the computer, application data, and MCP clients. Registered local agents can read and modify the open document.
- Invited collaborators are trusted editors. The invitation is a bearer secret with document/host information and a pinned certificate. Read-only roles, per-member revocation and protection from malicious invited editors are not implemented.
- The app is not a mutually untrusted multi-tenant server. TLS protects the network connection; it does not give a participant a narrower editing role.

## Boundaries to preserve

| Boundary | Current behavior |
| --- | --- |
| Renderer | Context isolation, sandbox, no Node integration, restrictive asset/CSP routing, denied navigation/windows/permissions/downloads |
| IPC | Main verifies the sender and exposes an action allowlist through preload; native exports validate file data before a user-selected save |
| MCP | Loopback-only authenticated HTTP/legacy bridge, persistent private token (0600), exact Host/port and Origin checks, runtime file mode 0600, per-session HTTP agents and separate stdio author IDs |
| Collaboration | Separate TLS listener, certificate pinning, private invitation, maximum host plus three guests, protocol version checks |
| Documents | Size/schema/metadata validation and speculative CRDT validation before live changes; serialized atomic persistence and recovery backup |

Do not forward the MCP bridge port or weaken token, Origin, sender, or TLS checks to solve a connection problem. A collaboration listener intentionally accepts invited remote participants when the user hosts; it is not the MCP endpoint. The app does not configure a public network route or router rule.

HTTP authentication is checked before protocol/session routing for every method. The listener rejects browser Origins and IPv6, bounds request bodies, active requests and sessions, and expires idle sessions. The persistent token survives app restarts; it is separate from the disposable runtime descriptor. Treat the bearer as local editing authority. These controls do not isolate malicious processes running as the same OS user. If credentials are exposed, stop the app, replace its token and update the client privately; never put the token in logs or reports.

## Redact before sharing

Never attach `mcp-token`, `mcp-runtime.json`, invitation text/QR codes, authorization headers, tokens, private app-data directories, customer designs or personal identifiers. A `.omc` file includes retained CRDT history: deleting visible text may not remove it from history. Create a new synthetic document for a report instead of assuming a redacted canvas is safe. Screenshots must also exclude private configuration fields and collaborator identities.

## Scope of verification

The [current verification record](docs/independent/VERIFICATION.md) identifies the independent engine's tested local authentication, storage, TLS, author isolation, Undo and export boundaries, along with current open work. It is scoped evidence, not an exhaustive security audit or a guarantee about every dependency and hostile input. Earlier private-engine reports do not establish current coverage. External internet/NAT, real power-cut/disk-failure injection and Windows/Linux execution remain unverified. The local macOS build is unsigned and not notarized.

Keep original license and provenance notices. This policy grants no new software license; see [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
