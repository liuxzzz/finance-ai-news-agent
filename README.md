# Finance & AI News Agent

一个 AI-first、面向开源的信息研究 Agent。目标是每天从 RSS 与可配置数据源研究金融与 AI
领域的信息，完成整理、简报输出和记忆沉淀。

当前仓库已具备可运行的每日简报闭环：36氪、虎嗅和 InfoQ RSS 实时采集、跨源与跨日去重、
DeepSeek 编辑审核、事件进展时间线、PostgreSQL Runtime、Artifact 持久化、飞书机器人幂等发送、
每日调度和运维检查。

## 项目原则

- **AI-first**：AI 负责研究、事件判断、写作和校验；确定性运行时负责权限、状态与副作用。
- **开源优先**：核心可自行托管，模型、新闻来源、存储和输出渠道均可替换。
- **本地可开发**：无需模型密钥或平台账号即可运行 Demo 和测试。
- **评测驱动**：模型、Prompt、工具和记忆策略的变化需要通过回放评测验证。

## 技术组合

- Agent 编排：[LangGraph.js](https://github.com/langchain-ai/langgraphjs)
- 数据 Schema：Zod
- 实时来源：`rss-parser` + 可替换 Source Plugin
- 可选外部工具：官方 MCP TypeScript SDK 适配器
- 模型适配：项目 `ModelProvider` + 可选 AI SDK Adapter
- 状态与长期记忆：PostgreSQL + pgvector
- Workspace：TypeScript + pnpm

LangGraph 编排代码和类型只存在于 `packages/core` 内部；根包仅为 Studio 本地开发声明运行时
依赖。Plugin SDK 不暴露 LangGraph、AI SDK、RSS Parser、MCP SDK 或数据库驱动的类型。

## 快速开始

要求 Node.js 22+ 和 pnpm 11+。

```bash
pnpm install
pnpm demo
```

Demo 将执行以下离线三节点图：

```text
Research → Curate & Write → Review
   ↑             ↑           |
   └── 补证 ─────┴── 修订 ────┘
```

三个节点承载研究规划、证据收集、事件判断、编辑和校验职责，Review 可以要求补证或定向修订。

生成结果位于 `.artifacts/demo-digest.md`。整个过程只使用 Fixture，不访问模型、MCP、
数据库或外部网络。

### LangGraph Studio

运行本地 Agent Server 并在浏览器中打开 LangGraph Studio：

```bash
pnpm studio
```

选择 `finance_ai_news` Graph，使用以下输入即可运行 Fixture 工作流：

```json
{
  "runId": "studio-demo-001",
  "topic": "Finance & AI",
  "maxRevisions": 1
}
```

Studio 会显示 Graph 结构、节点执行轨迹以及每一步的状态变化。本地 Studio Graph 仍使用
Fixture Handler，不会访问模型、MCP、数据库或外部网络。

### 持久化 Runtime

启动 PostgreSQL、执行迁移，然后运行使用 Fixture Handler 的持久化工作流：

```bash
docker compose up -d postgres
export DATABASE_URL=postgresql://agent:agent@localhost:5432/finance_ai_news
pnpm db:migrate
pnpm run:fixture -- --report-date 2026-08-04 --edition daily
```

再次使用相同的 `tenant + report-date + edition` 触发时会复用同一个逻辑 Run。失败后执行相同
命令会从持久化的 Run/Stage 和 LangGraph checkpoint 恢复。`--dry-run` 会持久化制品但跳过发送；
随后用相同参数移除 `--dry-run`，会发送已有制品而不会重新执行 Agent Graph。

CLI 还支持 `status <run-id>` 查询 Run、Stage、Model Call 和 Delivery 审计记录。当前 `run` 命令仍使用
Fixture Handler，目的是验证 Runtime，且不需要任何模型密钥。

### DeepSeek AI 回放

`run-ai` 使用真实 DeepSeek 模型执行结构化编辑和审核节点；Research 暂时读取仓库内的合成
回放证据，以便先独立验证 Prompt、Schema、引用和恢复机制。它不会采集实时新闻。

不要在聊天、命令参数或 Git 文件中粘贴 API Key。复制被 Git 忽略的本地配置文件，并只在
自己的编辑器中填写：

```bash
cp .env.example .env.local
# 在本机编辑 .env.local，填写 DEEPSEEK_API_KEY；不要提交该文件

pnpm db:migrate
pnpm run:ai -- --report-date 2026-08-04 --edition ai-replay-v1 --dry-run
```

`DEEPSEEK_BASE_URL` 必须是 API 根地址，不能包含 `/chat/completions`。默认模型可通过
`DEEPSEEK_MODEL` 替换。结构化输出使用 AI SDK `Output.object` 和 Zod 校验；模型只能引用输入
Evidence 的 ID，最终 Markdown 中的来源 URL 由程序从 Evidence 确定性生成。根命令会自动读取
可选的 `.env.local`；已经在 shell 中导出的环境变量也仍然可用。

模型适配器关闭了隐藏的 HTTP 自动重试；每次结构化输出最多额外进行一次显式恢复调用。模型请求在
发送前会原子写入 PostgreSQL `model_calls`，成功或失败后再记录模型、finish reason 和 Token。
进程中断留下的 `running` 调用也会占用预算，因此恢复后不会绕过每个 Run 的硬请求上限。

### DeepSeek + RSS 实时研究

`run-live` 使用 DeepSeek Function Calling 选择内部只读 `search_news` 工具。工具直接读取配置的
RSS Feed，按关键词相关度与发布时间选取新闻，再转换成受 Schema 保护的 Evidence；不需要 MCP
Server。默认 Feed 是 36氪、虎嗅和 InfoQ：

```bash
# 可在被 Git 忽略的 .env.local 中覆盖；多个 Feed 使用英文逗号分隔
RSS_FEED_URLS=https://36kr.com/feed,https://rss.huxiu.com/,https://www.infoq.cn/feed
RSS_TIMEOUT_MS=5000
RSS_MAX_TOOL_CALLS=1
RSS_MAX_ITEM_AGE_HOURS=48
RSS_MAX_EXCERPT_CHARS=600
RSS_MAX_EVIDENCE=12
RSS_MAX_CANDIDATE_EVIDENCE=24
HISTORY_DEDUP_LOOKBACK_DAYS=7
STORY_EVENT_LOOKBACK_DAYS=30

pnpm db:migrate
pnpm run:live -- --report-date 2026-08-04 --edition daily --dry-run
```

Feed 必须使用 HTTPS，本地 loopback 测试可以使用 HTTP。模型只能传入 `query` 与 `limit`，不能
指定任意 URL。每个来源的成功、失败和原始条目分别写入 `source_runs` 与 `raw_source_items`；候选
内容会清理追踪参数、生成内容指纹、跨源聚类，并与最近 7 天成功 Run 比较后再均衡选取。审核通过的
stories 会在独立的可恢复阶段与最近 30 天事件匹配，形成首次出现、最近更新和更新次数时间线。RSS
条目会被转换成以下结构后才可进入 Agent Evidence：

```json
{
  "items": [
    {
      "id": "stable-source-id",
      "title": "Source title",
      "url": "https://source.example/article",
      "excerpt": "Evidence excerpt",
      "source": "Feed name",
      "sourceId": "configured-feed-id",
      "publishedAt": "2026-08-04T12:39:20.000Z"
    }
  ]
}
```

### 飞书机器人推送

在飞书群中添加“自定义机器人”，把 Webhook 只写入被 Git 忽略的本地密钥文件：

```bash
cp .env.example .env.local
touch .env.feishu.local
# 使用本机编辑器写入以下变量，不要把真实地址粘贴到代码、文档或 Git：
# AGENT_OUTPUT_CHANNEL=feishu
# FEISHU_BOT_WEBHOOK_URL=<your-webhook>
```

推荐先生成制品，再发送同一个 Run：

```bash
pnpm run:live -- --edition daily --dry-run
pnpm run:live -- --edition daily
```

第二条命令只发送已经审核和持久化的 Artifact，不会重新调用模型。之后再次执行相同命令会复用
成功的 Delivery。飞书文本请求在发送前执行 20KB 限制、UTF-8、URL 和响应码校验；Webhook 不会
进入 Run 配置、日志、回执或数据库。

### 每日自动运行

macOS 可以安装一个外部 `launchd` 任务，默认每天本地时间 08:00 运行：

```bash
pnpm schedule -- install --hour 8 --minute 0
pnpm schedule -- status
```

自动脚本会先构建和迁移，再用固定 `daily` edition 执行实时 Run。失败最多重试 3 次并指数退避；
重试耗尽后会向同一个飞书机器人发送不含错误详情和密钥的失败告警。数据库 Run 锁、唯一身份和
Delivery Key 共同阻止调度器重复触发造成重复发送。卸载使用
`pnpm schedule -- uninstall`。

容器化的一次性 Worker 可使用：

```bash
docker compose --profile worker run --rm agent
```

生产环境应由云调度器按日触发这个短生命周期 Worker，而不是在应用进程里维护定时器。

### 运维检查

```bash
pnpm health
pnpm metrics -- --days 7
node --env-file-if-exists=.env.local --env-file-if-exists=.env.feishu.local \
  apps/cli/dist/index.js status <run-id>
```

`status` 默认只输出脱敏摘要；追加 `--json` 才读取完整审计数据。

## Workspace

```text
apps/
  cli/                   CLI 与离线 Demo
packages/
  core/                  LangGraph Agent Graph 与确定性 Runtime
  plugin-sdk/            框架无关的公开插件接口
plugins/
  model-ai-sdk/          AI SDK ModelProvider Adapter
  output-file/           本地 Markdown 输出
  output-feishu/         飞书自定义机器人输出、签名与 20KB 门禁
  source-rss/            RSS 实时拉取、排序与 Evidence 标准化
  source-mcp/            可选 MCP Client 适配器（不在默认实时链路）
  storage-postgres/      Run/Stage Repository、迁移与 LangGraph checkpoint
presets/
  finance-ai/            Finance & AI 官方 Preset 占位
db/init/                 pgvector 首次初始化
db/migrations/           版本化业务迁移
docs/                    技术方案
```

## 常用命令

```bash
pnpm demo          # 构建并执行离线 Demo
pnpm db:migrate    # 执行 PostgreSQL 版本化迁移
pnpm run:fixture   # 执行/恢复持久化 Fixture Run
pnpm run:ai       # 使用真实 DeepSeek 模型和合成回放证据
pnpm run:live     # 使用 DeepSeek Function Calling 和实时 RSS Evidence
pnpm schedule     # 安装、检查或卸载每天自动任务
pnpm health       # 检查数据库迁移和生产配置
pnpm metrics      # 查看 Run、来源、模型和发送指标
pnpm studio        # 启动本地 Agent Server 和 Studio
pnpm build         # 构建所有 workspace packages
pnpm typecheck     # TypeScript 类型检查
pnpm test          # 单元测试
pnpm lint          # ESLint
pnpm format:check  # Prettier 检查
pnpm check         # 完整 CI 检查
```

## 当前状态

- [x] pnpm workspace 与 TypeScript 工程配置
- [x] LangGraph 三节点 Fixture Demo Graph
- [x] 框架无关的 Plugin SDK
- [x] RSS、可选 MCP、AI SDK、PostgreSQL、文件输出适配器
- [x] PostgreSQL + pgvector 本地环境
- [x] Run/Stage/Artifact/Delivery 持久化 Runtime
- [x] 重复触发幂等、失败恢复、发布门禁和审计查询
- [x] PostgreSQL LangGraph durable checkpoint
- [x] DeepSeek 结构化编辑/审核、版本化 Prompt 和回放模式
- [x] 持久化 Model Call Ledger 与跨进程硬请求预算
- [x] DeepSeek Function Calling、RSS 实时采集和 `run-live` 入口
- [x] 原始来源审计、标准化、跨源去重、聚类与来源均衡
- [x] 最近 7 天历史去重和可追溯内容持久化
- [x] 审核后 Story 事件匹配、跨日进展时间线和幂等更新
- [x] 飞书机器人真实发送、20KB 门禁和 Runtime 发送幂等
- [x] macOS 每日调度、失败退避、健康检查和运行指标
- [x] Docker 一次性 Worker 部署入口
- [x] 单元测试与 CI
- [x] 36氪、虎嗅和 InfoQ RSS 真实网络拉取冒烟验收
- [ ] 扩展更多专业金融/AI RSS/API 来源
- [ ] 向量语义检索、用户偏好、反馈和在线评测基线

当前代码分层、运行流程和目录职责见
[当前架构与目录说明](docs/architecture.md)；完整目标方案见
[技术方案](docs/technical-design.md)。

## 贡献

参见 [CONTRIBUTING.md](CONTRIBUTING.md) 和 [SECURITY.md](SECURITY.md)。

## License

Apache-2.0
