# 贡献指南

当前应用为 Rust 原生。使用 Rust 1.92.0 构建二进制。JavaScript 工具仅用于文档检查、MCP 测试和基准测试。

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

先构建原生服务与 CLI，再运行 SDK 测试。使用合成数据与隔离配置，以 `--automation-background` 隐藏且不聚焦地进行桌面 QA。不要使用用户默认配置。

保持修改范围清晰，记录相关测试、实际结果和验证缺口。Git 和 PR 使用英语，PR 保持草稿；未经明确请求不要合并或部署。保留许可证与来源声明，不要附加密钥、邀请或私人文档。

[English reference](../../CONTRIBUTING.md) · [Testing](../TESTING.md) · [Native guide](../../native/README.md) · [Security](../../SECURITY.md)
