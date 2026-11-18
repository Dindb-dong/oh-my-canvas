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
| Native desktop | Native windows and Skia presentation; no browser renderer, preload bridge or Node integration |
| Local service | Authenticated loopback routing, validated commands and explicit document/session ownership |
| MCP | Native stdio CLI; optional legacy HTTPS uses a pinned profile certificate and private bearer |
| Collaboration | Separate TLS listener, pinned invitations, native room limit of four participants |
| Documents | Schema/size/revision validation before publication; transactional SQLite writes and durable receipts |

Do not forward the MCP bridge port or weaken token, Origin, sender, or TLS checks to solve a connection problem. A collaboration listener intentionally accepts invited remote participants when the user hosts; it is not the MCP endpoint. The app does not configure a public network route or router rule.

TLS authenticates the persistent profile identity before HTTP bearer credentials are sent. Clients must trust that specific public certificate; disabling TLS verification or downgrading to HTTP exposes the bearer to a port impostor. The app does not install OS trust. The private TLS key stays in private app data and must never appear in diagnostics. Codex GUI certificate trust remains unverified.

The default stdio route and optional legacy HTTPS listener are separate transport configurations of the native service. Keep their private profile state private. If a credential is exposed, stop the affected service and renew it through a reviewed profile-specific procedure; never publish credentials in logs or reports. These controls do not isolate malicious processes running as the same OS user.

## Redact before sharing

Never attach private TLS key files, `mcp-token-v2`, obsolete `mcp-token`, `mcp-runtime.json`, invitation text/QR codes, authorization headers, tokens, private app-data directories, customer designs or personal identifiers. A `.omc` file includes retained CRDT history: deleting visible text may not remove it from history. Create a new synthetic document for a report instead of assuming a redacted canvas is safe. Screenshots must also exclude private configuration fields and collaborator identities.

## Scope of verification

The [native guide](native/README.md), [qualification record](docs/native-engine/QUALIFICATION.md), and [testing guide](docs/TESTING.md) describe current verification entry points and gaps. Historical Electron-engine records do not establish native coverage. Tests are scoped evidence, not an exhaustive security audit. External internet/NAT, real power-cut/disk-failure behavior and cross-platform execution require their own qualification.

Keep original license and provenance notices. This policy grants no new software license; see [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
