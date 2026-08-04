# Finance & AI News Agent

一个 AI-first、面向开源的信息研究 Agent。目标是每天通过 MCP 研究金融与 AI
领域的信息，完成整理、简报输出和记忆沉淀。

当前仓库已经具备可恢复的运行骨架：包含角色编排、持久化 Runtime、插件接口和离线
Fixture Demo；真实新闻采集、Prompt 和业务规则仍待接入。

## 项目原则

- **AI-first**：AI 负责研究、事件判断、写作和校验；确定性运行时负责权限、状态与副作用。
- **开源优先**：核心可自行托管，模型、MCP、存储和输出渠道均可替换。
- **本地可开发**：无需模型密钥或平台账号即可运行 Demo 和测试。
- **评测驱动**：模型、Prompt、工具和记忆策略的变化需要通过回放评测验证。

## 技术组合

- Agent 编排：[LangGraph.js](https://github.com/langchain-ai/langgraphjs)
- 数据 Schema：Zod
- MCP：官方 TypeScript SDK
- 模型适配：项目 `ModelProvider` + 可选 AI SDK Adapter
- 状态与长期记忆：PostgreSQL + pgvector
- Workspace：TypeScript + pnpm

LangGraph 编排代码和类型只存在于 `packages/core` 内部；根包仅为 Studio 本地开发声明运行时
依赖。Plugin SDK 不暴露 LangGraph、AI SDK、MCP SDK 或数据库驱动的类型。

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

### DeepSeek + MCP 实时研究

`run-live` 使用 DeepSeek Function Calling 选择 MCP 白名单工具。模型只决定调用的工具和参数；
实际执行、参数校验、超时和结果大小限制由 Runtime/Gateway 控制。配置一个 Streamable HTTP MCP
服务后运行：

```bash
# 仅在被 Git 忽略的 .env.local 中配置
MCP_SERVER_URL=https://your-mcp-server.example/mcp
MCP_ALLOWED_TOOLS=search_news,fetch_article
MCP_BEARER_TOKEN=your-local-token
MCP_MAX_TOOL_CALLS=4

pnpm db:migrate
pnpm run:live -- --report-date 2026-08-04 --edition ai-live-v1 --dry-run
```

远程 MCP 必须使用 HTTPS，本地 loopback 开发服务可以使用 HTTP。Gateway 默认拒绝未列入
`MCP_ALLOWED_TOOLS` 的工具，并使用工具声明的 JSON Schema 在调用前校验参数。新闻工具需要返回
以下结构化结果，URL 才能进入 Agent Evidence：

```json
{
  "items": [
    {
      "id": "stable-source-id",
      "title": "Source title",
      "url": "https://source.example/article",
      "excerpt": "Evidence excerpt"
    }
  ]
}
```

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
  source-mcp/            MCP Client、白名单 Gateway 与 HTTP 连接
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
pnpm run:live     # 使用 DeepSeek Function Calling 和 MCP Evidence
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
- [x] MCP、AI SDK、PostgreSQL、文件输出适配器骨架
- [x] PostgreSQL + pgvector 本地环境
- [x] Run/Stage/Artifact/Delivery 持久化 Runtime
- [x] 重复触发幂等、失败恢复、发布门禁和审计查询
- [x] PostgreSQL LangGraph durable checkpoint
- [x] DeepSeek 结构化编辑/审核、版本化 Prompt 和回放模式
- [x] 持久化 Model Call Ledger 与跨进程硬请求预算
- [x] DeepSeek Function Calling、受控 MCP Gateway 和 `run-live` 入口
- [x] 单元测试与 CI
- [ ] 配置并验收真实 MCP 新闻来源和飞书输出
- [ ] 在线评测基线与长期记忆实现

当前代码分层、运行流程和目录职责见
[当前架构与目录说明](docs/architecture.md)；完整目标方案见
[技术方案](docs/technical-design.md)。

## 贡献

参见 [CONTRIBUTING.md](CONTRIBUTING.md) 和 [SECURITY.md](SECURITY.md)。

## License

Apache-2.0
