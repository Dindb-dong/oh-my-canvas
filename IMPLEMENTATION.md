# Implementation contract

Local repository only. No git remote, telemetry, paid API, authentication service, cloud database or auto-publishing.

1. Use the independently authored editor/ document, geometry, components, renderer, interaction, formats and MCP services in a sandboxed Electron renderer. Retired company code and copied tests are excluded from the publication source.
2. Store native documents and CRDT updates atomically on disk; library, import/export, recovery, local assets and fonts work offline.
3. Local MCP uses the official SDK over stdio; a loopback-only authenticated bridge reaches the visible editor, never a LAN-facing MCP port.
4. Collaboration uses pinned-certificate TLS WebSockets, host + 3 guests, secret invite, reconnect, persistent local replicas and field-level Yjs merge. Presence/cursors are ephemeral. Collaboration and MCP use separate credentials/ports.
5. Unified limits: 16 MiB current document and CRDT history, 24 MiB wire/file envelope. Validate speculative patches, remote merges and Undo/Redo before live mutation. Concurrent last-page deletion projects one deterministic root-only recovery canvas.
6. Tests cover convergence, deletion/order repair, undo isolation, persistence recovery, network authentication, fifth-peer refusal, reconnect and assets. Electron E2E uses actual renderer and four separate processes.
7. Build a local macOS app, inspect runtime screenshots, run relevant editor tests, obtain GPT-6 Astra high review and fix actionable findings.

No promise of universal NAT traversal: the host must be reachable. Guests keep working offline and can rehost a replica. Character-by-character simultaneous rich-text editing is outside the first version: rich-text content is an atomic shape property with deterministic conflict resolution.
