# Local background removal

The app bundles U²-Netp and ONNX Runtime Web. Images are processed locally in a
worker using the WASM CPU backend on macOS, Windows and Linux. There is no model
download or image upload at runtime. The lightweight 320 × 320 saliency model
can lose fine hair, translucent edges, or subjects with weak background contrast.
The exported PNG keeps the source pixel dimensions and existing transparency.

## Model provenance

- Authors: Xuebin Qin, Zichen Zhang, Chenyang Huang, Masood Dehghan, Osmar Zaiane,
  and Martin Jagersand, *U²-Net: Going Deeper with Nested U-Structure for Salient
  Object Detection*, Pattern Recognition 106 (2020), 107404.
- Upstream: <https://github.com/xuebinqin/U-2-Net>.
- Model license: Apache-2.0; see `u2netp-LICENSE.txt`. The upstream author confirms
  the released models follow the repository license in
  <https://github.com/xuebinqin/U-2-Net/issues/208>.
- ONNX conversion release: <https://github.com/danielgatis/rembg>.
- Byte-for-byte model mirror pinned to revision
  `25dee37ab19c5b6ad64ba6578eba63f1ae07720c`:
  <https://huggingface.co/edgetools/u2netp/tree/25dee37ab19c5b6ad64ba6578eba63f1ae07720c>.
- `u2netp.onnx`: 4,574,861 bytes, SHA-256
  `309c8469258dda742793dce0ebea8e6dd393174f89934733ecc8b14c76f4ddd8`.

`scripts/prepare-background-removal.mjs` checks the cached model and downloads
the pinned, checksum-verified file only when needed at build time. It copies the
WASM runtime from the locked npm package into the distribution. The model license
and this attribution accompany those assets. ONNX Runtime and dependency notices
are included in the generated npm runtime license inventory.
