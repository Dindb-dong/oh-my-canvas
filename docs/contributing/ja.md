# 貢献ガイド

現在のアプリはRustネイティブです。Rust 1.92.0でバイナリをビルドします。JavaScriptツールは文書検証、MCPテスト、ベンチマーク専用です。

```sh
cd native
cargo build --locked -p omc-desktop -p omc-service -p omc-cli
./target/debug/omc-desktop
```

```sh
npm ci --ignore-scripts
npm run check
npm test
npm run test:native
```

SDKテスト前にネイティブサービスとCLIをビルドしてください。合成データと隔離プロファイルを使い、デスクトップQAは`--automation-background`で非表示・非フォーカスのまま実行します。通常のユーザープロファイルを使わないでください。

変更を小さく保ち、関連テストと実際の結果・未検証項目を記録します。GitとPRは英語、PRはドラフトにします。明示的な依頼なしにマージ・デプロイしないでください。ライセンスを保持し、秘密・招待・個人文書を添付しないでください。

[English reference](../../CONTRIBUTING.md) · [Testing](../TESTING.md) · [Native guide](../../native/README.md) · [Security](../../SECURITY.md)
