# Retained Electron implementation

The native desktop, service and CLI live in [`native/`](../native/README.md). Use the native build and launch commands in the [root README](../README.md#quick-start) for that application.

This directory is still referenced by the root `package.json`: `npm start` launches `electron/main.mjs`, and the npm build/package scripts stage the Electron application. Host tests and migration fixtures also depend on these modules. This is a compatibility/development path, not unused native runtime code. Removing it requires retiring or migrating those callers together.

Electron `.omc` files contain Yjs history. Native uses its own document/history formats. Keep the original backup and export canvas JSON from Electron to import editable content into native; this does not transfer the Yjs operation history. See [file migration](../docs/MCP_PARITY.md#files-and-repeatable-output).
