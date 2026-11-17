# OMC native field-relay resource diagnostic

Use the installed Oh My Canvas app and the same canonical 146-node LD03
field-relay fixture as the Penpot resource arm. Run on a single scheduled Mac
with a new private evidence directory outside version control. The native
service runs with an isolated temporary profile and a dynamically bound
loopback port. The desktop uses `--automation-background`. Both binaries are
fingerprinted, and native attachment and unfocused state are checked.

```sh
node tools/local-dev-bench/replays/omc-ld03-resource-arm.mjs \
  --fixture "$CANONICAL_LD03_FIELD_RELAY_JSON" --output "$NEW_PRIVATE_EVIDENCE"
```

Prepare, save and check the starting state before the 60-second ready baseline.
The sampled replay applies the accent and spacing updates through the native
variable route, checks durable save and independently reads the candidate in a
new session. Close the native document, release reader and writer leases, and
verify the editor has dropped it. Reopen in the same process tree and read it
back through a fresh session. The neutral grader independently checks all
objects and bindings. The resource roots remain the installed service and
background desktop plus observed descendants through the 30-second tail.
An empty active/queued job and admission snapshot is required to attest the
tail. A second check restarts the service after sampling and verifies storage
reopen separately.

The output retains before, candidate, document reopen and fresh-service
reopen states, the elapsed replay, counters used to attest the tail, and raw
sampler evidence. The state and timing come from a background native profile.
Physical display presentation, source pixel fidelity, and complete process
lifecycle observability have separate qualification requirements. The same
collector completeness markers apply even when a tail is attested. Keep
absolute observations and claim-eligible metrics distinct.

```sh
node tools/local-dev-bench/replays/omc-ld03-resource-arm.mjs \
  --fixture "$CANONICAL_LD03_FIELD_RELAY_JSON" --fixture-only
node --test tools/local-dev-bench/replays/omc-ld03-resource-arm.test.mjs
```
