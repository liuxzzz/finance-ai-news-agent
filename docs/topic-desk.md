# 专题追踪与简报工作台

工作台用来维护关注专题，并从现有 RSS 采集链路生成可回看的简报。它和每日 `run-live` 共用
`RssNewsGateway`、证据标准化和结构化简报渲染，但专题配置与运行记录单独保存。

## 运行

需要本机 PostgreSQL 和 `DATABASE_URL`。服务启动时会执行 `db/migrations`，包括
`008_topic_desk.sql`。已有迁移不会被改写。

```bash
export DATABASE_URL=postgresql://agent:agent@127.0.0.1:5432/finance_ai_news
pnpm topic-desk -- serve --host 127.0.0.1 --port 4173
```

只接受 `127.0.0.1`、`localhost` 和 `::1`。默认模式是 `TOPIC_DESK_MODE=e2e`：

- 简报模型固定为 `local-stub/topic-desk-stub@1`
- 即使环境里有 `DEEPSEEK_API_KEY`，也不会调用它
- 不读取飞书 Webhook，不发送通知
- 导出的 Markdown 写入 `TOPIC_DESK_EXPORT_DIR`，默认 `.artifacts/topic-desk/<topic-id>/<run-id>.md`

页面可以新建或编辑专题。必要配置是名称、1 到 8 个关键词、1 到 8 个来源，以及时间窗口。
来源可以勾选内置目录，也可以填写 `id|url|名称`。HTTP 只允许回环地址，其它地址必须是 HTTPS。

生成简报时，服务会：

1. 写入一条 `running` 运行记录；
2. 用专题关键词调用 `search_news`，并保留每个来源的 `available`、`empty`、`filtered` 或 `request_failed`；
3. 丢掉标题和摘录都不含关键词的条目；
4. 用现有规范化逻辑做跨源去重，并与该专题回看窗口内已经写过的指纹比较；
5. 只有仍有新证据时才调用简报模型；
6. 保存简报、证据和导出文件。

同一专题同时只能有一条 `running` 记录。失败记录会留下来，下一次生成是新的运行。

## 本地验收夹具

端到端测试不访问外网模型或真实 Feed。它在 `127.0.0.1` 上提供 RSS，使用独立数据库，并注入：

```bash
TOPIC_DESK_STUB_FAILURES=1
```

这个计数只在 e2e 模式生效，让本地 stub 按次数失败，用来验证失败记录和后续恢复。它不是线上模型的故障。

PostgreSQL 不可达时，迁移测试和端到端测试会跳过。设置 `TOPIC_DESK_REQUIRE_POSTGRES=1` 后，连不上数据库会直接失败。GitHub Actions 会启动 PostgreSQL，并设置该变量，因此这两项测试在 CI 中必须执行。

## 局限

- 默认验收使用本地 stub。stub 只逐条整理已采集证据，不生成新的事实。
- `TOPIC_DESK_MODE=live` 且 `TOPIC_DESK_ALLOW_LIVE_MODEL=1` 时才会组装 DeepSeek structured provider。这条路径没有用真实密钥跑过。
- 工作台不写入每日 `runs` / `source_runs`，因此 `status` 和 `metrics` 不统计专题运行。
- 没有接飞书，也没有调度器。
- 真实 36氪、虎嗅、InfoQ 和其它目录 Feed 没有在这次专题流程里拉取。
