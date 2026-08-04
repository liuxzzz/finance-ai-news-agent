# Finance & AI News Agent

一个 AI-first、面向开源的信息研究 Agent。目标是每天通过 MCP 研究金融与 AI
领域的信息，完成整理、简报输出和记忆沉淀。

当前仓库是可运行的工程骨架：只包含角色编排、插件接口和离线 Fixture
Demo，不包含真实新闻采集、Prompt 或业务规则。

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

如需启动预留的 PostgreSQL + pgvector：

```bash
docker compose up -d postgres
```

## Workspace

```text
apps/
  cli/                   CLI 与离线 Demo
packages/
  core/                  LangGraph Agent Graph
  plugin-sdk/            框架无关的公开插件接口
plugins/
  model-ai-sdk/          AI SDK ModelProvider Adapter
  output-file/           本地 Markdown 输出
  source-mcp/            官方 MCP SDK Client 骨架
  storage-postgres/      PostgreSQL Pool 骨架
presets/
  finance-ai/            Finance & AI 官方 Preset 占位
db/init/                 pgvector 初始化
docs/                    技术方案
```

## 常用命令

```bash
pnpm demo          # 构建并执行离线 Demo
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
- [x] 单元测试与 CI
- [ ] 真实模型、MCP 来源和飞书配置
- [ ] 业务 Prompt、评测集、数据表与记忆实现

当前代码分层、运行流程和目录职责见
[当前架构与目录说明](docs/architecture.md)；完整目标方案见
[技术方案](docs/technical-design.md)。

## 贡献

参见 [CONTRIBUTING.md](CONTRIBUTING.md) 和 [SECURITY.md](SECURITY.md)。

## License

Apache-2.0
