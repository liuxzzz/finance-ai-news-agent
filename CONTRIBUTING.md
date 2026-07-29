# Contributing

感谢你参与 Finance & AI News Agent。

## 本地开发

```bash
pnpm install
pnpm check
pnpm demo
```

Demo 必须在没有模型密钥、平台账号和外部服务的环境中可运行。

## 设计约束

- Core 保持领域和供应商中立；
- 外部模型、MCP、存储和输出能力通过 Plugin SDK 接入；
- 不在公共接口中暴露第三方框架类型；
- AI 行为变更需要同时增加或更新评测；
- 外部内容按不可信输入处理，工具执行必须经过确定性权限边界。

## Pull Request

1. 保持变更聚焦，并说明动机和兼容性影响；
2. 添加相应测试或 Fixture；
3. 确认 `pnpm check` 通过；
4. 对公共接口变更补充文档；
5. Commit 使用清晰的祈使句描述。

项目计划使用 Developer Certificate of Origin。提交贡献即表示你有权按照项目许可证提供该贡献；正式启用 DCO Bot 后，Commit 需要带 `Signed-off-by`。
