# Troubleshooting

## App does not start

Build `omc-desktop`, `omc-service` and `omc-cli` together with the pinned Rust toolchain. Keep the binaries together. Root npm commands only run development checks. See [getting started](GETTING_STARTED.md).

## MCP cannot connect

Copy the stdio configuration from the intended native profile and check that its CLI path exists. Verify the client is using that same profile and dialect. Reconnect after updating cached tool schemas. For optional legacy HTTPS, use the profile's pinned public certificate and private bearer as described in the [native guide](../native/README.md); do not disable TLS checks or expose MCP on a public interface.

## Agent edits appear in another canvas

Supply the intended `documentId` to every document mutation and refresh `get_context` after opening or restarting. Background documents do not follow the visible tab. A `busy` response means an active user transaction must finish before retrying.

## Save or import fails

Preserve the original profile and input. Review the exact error and conversion diagnostics before retrying in an isolated profile. Do not delete databases or overwrite the only backup. Earlier Yjs files and native history packages are different formats; consult [migration and export](MCP_PARITY.md#files-and-repeatable-output).

## Collaboration cannot connect

The host must be directly reachable. Native rooms do not provide automatic NAT traversal or relay services. Check the invitation privately and use a supported protocol on every peer. A local four-process test does not prove internet reachability.

## Report a problem

Include source revision, OS, steps, expected and actual behavior, and a minimal synthetic input. Exclude tokens, profile descriptors, private keys, invitations and personal designs. See [contributing](../CONTRIBUTING.md), [security](../SECURITY.md), and [testing](TESTING.md).
