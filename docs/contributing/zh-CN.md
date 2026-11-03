# 参与 Oh My Canvas

[English](../../CONTRIBUTING.md) · [한국어](ko.md) · [日本語](ja.md) · **简体中文**

你可以通过可复现的错误报告、翻译改进、组件修正或范围明确的代码修改来帮助项目。

> **请确认许可证与来源。** 独立编写的项目代码采用 [MIT 许可证](../../LICENSE)，外部材料保留各自的条款。仅提交你有权授权的材料，并保留[第三方声明](../../THIRD_PARTY_NOTICES.md)。请勿重新引入已移除的公司代码或复制的测试。本指南不引入新的 CLA 或权利转让要求。

## 选择贡献类型

| 类型 | 请提供 |
| --- | --- |
| 错误修复 | 最小合成示例、预期与实际结果、回归测试 |
| 界面改进 | 真实的修改前后截图、键盘与焦点行为、相关窗口尺寸检查 |
| 组件与 variant | 主组件和实例、override、Undo、保存与重新打开检查 |
| 文档与翻译 | 有效链接、准确命令、各语言一致的数值与限制 |
| 较大功能 | 实现前先说明具体问题、使用场景、范围、替代方案和代价 |

项目目前在本地维护，没有配置公开远程仓库。Issue 和 PR 模板为未来托管准备。在此之前，可使用相同格式编写本地报告或审查说明。请勿假设已有公开问题追踪、发布页或自动 CI。

## 本地环境

准备已获使用许可的检出目录、Node.js **22.12 或更高版本**及 npm，在仓库根目录执行：

```sh
npm ci
npm run build
npm start
```

开发时可以使用 `npm run dev`。新的本地验收在 macOS arm64 上运行，[当前验证记录](../independent/VERIFICATION.md) 区分已通过检查与未完成工作。Windows/Linux 执行尚未验证，打包应用的 MCP CLI 不需要另行安装 Node。

请使用合成文档和独立测试配置，避免以重要画布的唯一副本作为测试数据。在测试保存或格式变更前，先导出 `.omc` 备份。可参阅[入门指南](../GETTING_STARTED.md)和[架构说明](../ARCHITECTURE.md)。

## 修改与审查流程

1. 从约定的基准提交创建分支，例如 `fix/text-undo`、`feat/component-property` 或 `docs/chinese-readme`，保留无关工作。
2. 先复现问题并检查调用路径，复用已有编辑器、存储或界面模式。
3. 控制修改范围，使其便于一次审查；重要行为应添加回归测试。面向用户的行为或兼容性变化也要更新文档。
4. 运行受影响的检查，如实注明未执行的检查。
5. 检查 diff，排除个人文档、机密、生成文件及无关修改。使用清晰的英文提交标题，例如 `fix: preserve text session undo`。
6. 使用 [PR 模板](../../.github/PULL_REQUEST_TEMPLATE.md)准备 PR 或本地审查说明。未经维护者批准，不要合并、公开或部署。

## 选择相关检查

常规检查在本地执行，无需准备 Docker。

```sh
npm run check
npm test
npm run test:editor
```

修改应用集成时，先构建，再选择相关的真实 Electron 检查：

```sh
npm run build
npm run test:e2e
node scripts/independent-host-e2e.mjs
node scripts/independent-ui-e2e.mjs
node scripts/independent-render-e2e.mjs
node scripts/independent-library-e2e.mjs
```

这些是独立的验收脚本，请根据修改范围选择，并记录实际命令与结果。脚本使用临时配置启动真实应用；部分会更新 `docs/qa/` 的截图和结果，请检查后再提交。在沙箱中，loopback/TLS 和 Electron 启动可能需要宿主正常的执行授权。

修改打包流程时，先构建，再使用本地暂存工具。工具将锁定的运行时依赖作为真实文件复制到任务专用目录，并复用已安装的 Electron。直接通过指向其他 worktree 的 `node_modules` 符号链接打包可能遗漏依赖。

```sh
npm run build
node scripts/package-local.mjs
node scripts/packaged-smoke.mjs
```

这些命令只生成并检查本地产物，不会发布或替换已安装应用。不要为无关检查修改现有应用或全局 MCP 配置。旧 `--installed` 及默认配置目录脚本不是当前独立引擎的验收流程，仅用于另行获准并审查的安装验证。

仅修改文档时，请运行 `node scripts/check-docs.mjs`，并检查渲染后的图片与翻译；通常无需完整重建应用。参阅[测试指南](../TESTING.md)、[故障排查](../TROUBLESHOOTING.md)和[验证记录](../independent/VERIFICATION.md)。历史测试数量只是当时的记录。

## 必须保持的行为

- 保存应保持原子写入、备份恢复、修改真实状态前的验证与容量限制。
- 协作应保持状态收敛、参与者独立 Undo、坐标一致性和人数限制。同一台 Mac 上的四客户端 TLS 检查不能证明外部互联网或 NAT 可达性。
- MCP 应保持 loopback 绑定、认证及 Origin/Host 检查。**不要转发 MCP 端口。** 用户编辑文本或拖动数值时仍可读取，修改请求在事务结束前返回 `busy`。
- 写入格式及协作协议为 v2，仍可读取 v1 文档。应测试兼容性，并明确拒绝不兼容的参与者，而不是静默混用。
- 未经明确的产品决策，不应引入遥测、远程素材、账户或付费服务依赖。

## 错误报告与功能建议

请使用[错误表单](../../.github/ISSUE_TEMPLATE/bug_report.yml)，写明应用或源码提交、OS 与架构、准确步骤、预期和实际行为。如相关，也请记录保存与重新打开、Undo、主机和参与者数量、连接状态。

只附上最小合成画布及已脱敏的截图、日志。不要上传客户设计、个人记录、凭据、会话邀请、令牌、`mcp-runtime.json` 或整个用户数据文件夹。邀请可授予编辑权限，`.omc` 包含内嵌素材和合并历史；删除可见图层并不保证历史内容也被清除。请在新的合成文档中复现。

安全问题请参阅[安全说明](../../SECURITY.md)，使用已与维护者约定的私密渠道。不要在公开 Issue 中披露秘密、敏感文档或针对他人系统的攻击内容。不要假设已有专用报告邮箱或响应时限。

[功能表单](../../.github/ISSUE_TEMPLATE/feature_request.yml)应描述问题、最小可用的解决行为、替代方案，以及对存储、协作、MCP、权限和网络的影响。审查前不要承诺实现或发布日期。

## 翻译与审查

命令和共同技术事实以英文 README 和[英文贡献指南](../../CONTRIBUTING.md)为基准。修改前提条件、数值、文件格式、限制或已验证平台时，请同步检查相关的四种语言。保留实际的英文 UI 标签、工具名、API 和命令，只翻译说明。

使用相对链接、仓库内图片与有意义的替代文本，确保离线检出也可阅读。截图应展示真实应用，不要展示不存在的功能或私人文档。审查时应具体、尊重地讨论行为、证据和代码，而不是针对个人。
