# Obsolete Electron application source

The current Oh My Canvas application is the Rust native desktop, service and CLI in [`native/`](../native/README.md). It does not run this Electron application.

The root `package.json` still points `npm start` and the old npm build/package scripts at this directory. Older JavaScript host tests also import its modules. These are unmigrated repository references, not evidence that Electron is required by the current app or supported as a second runtime. Retiring this source requires cleaning up those references together.

For older document formats, see [file migration](../docs/MCP_PARITY.md#files-and-repeatable-output).
