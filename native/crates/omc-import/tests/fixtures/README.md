# Native foreign-format fixtures

`editable-fig.base64` stores an independently authored three-node binary input as Base64, encoded with the MIT-licensed `kiwi-schema` 0.5.0 encoder and raw DEFLATE. Its schema is checked in as `editable-fig.kiwi`. It contains one page, a red rectangle and Unicode text. It contains no third-party design asset.

The Rust import test reads the binary through the production archive/chunk/schema/message/conversion path. The encoder is test fixture preparation only; importing and rendering do not use Node.js, a browser or a generated JavaScript decoder.

This small fixture checks the wire format and conversion. It does not replace the large FIG compatibility and fidelity qualification described in the native engine plan.
