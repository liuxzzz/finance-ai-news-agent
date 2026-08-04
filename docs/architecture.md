# 当前架构与目录说明

本文说明仓库**当前已经实现**的架构、运行流程，以及各目录和关键文件在工程中的作用。
面向生产环境的完整设计与后续演进方向见
[技术方案](./technical-design.md)。

## 1. 当前阶段

项目目前处于“可运行的工程骨架”阶段，已经具备：

- pnpm monorepo、统一 TypeScript 配置和质量检查命令；
- 基于 LangGraph.js 的三节点 Agent Graph；
- 框架无关的插件公共契约；
- AI SDK 模型、本地文件输出、MCP Client 和 PostgreSQL Pool 适配器骨架；
- 完全离线、无需模型密钥和外部服务的 Fixture Demo；
- PostgreSQL + pgvector 的本地基础设施配置。

目前尚未接入真实新闻来源、业务 Prompt、模型调用、数据库持久化和长期记忆。换句话说，
当前代码验证的是**模块边界和执行闭环**，不是可直接用于生产的新闻研究系统。

## 2. 总体架构

当前实现采用“CLI 负责组装、Core 负责编排、Plugin SDK 定义边界、Plugins
连接外部能力”的分层方式。

```mermaid
flowchart LR
    User[开发者 / 命令行] --> CLI[apps/cli]
    CLI --> Core[packages/core]
    CLI --> Output[plugins/output-file]

    Core --> Graph[LangGraph.js]
    Core -. 公共能力边界 .-> SDK[packages/plugin-sdk]
    Output --> SDK

    Model[plugins/model-ai-sdk] --> SDK
    Model --> AISDK[AI SDK]
    Source[plugins/source-mcp] --> MCP[MCP TypeScript SDK]
    Storage[plugins/storage-postgres] --> PG[PostgreSQL Driver]

    Source -. 尚未接入 Demo .-> CLI
    Model -. 尚未接入 Demo .-> CLI
    Storage -. 尚未接入 Demo .-> CLI
```

各层职责如下：

| 层级                  | 当前职责                                                | 不负责的内容                                 |
| --------------------- | ------------------------------------------------------- | -------------------------------------------- |
| `apps/cli`            | 命令解析、依赖组装、Fixture Handler、触发执行和输出制品 | Agent 图的结构、通用插件协议                 |
| `packages/core`       | Agent 状态、节点图、分支与修订循环                      | 具体模型厂商、MCP 传输、数据库驱动、输出渠道 |
| `packages/plugin-sdk` | 定义稳定、框架无关的外部能力接口和数据契约              | 任何第三方 SDK 的具体实现                    |
| `plugins/*`           | 将第三方 SDK 或本地能力适配到项目边界                   | 决定业务流程和 Agent 节点顺序                |
| `presets` / `prompts` | 预留业务主题、角色指令、栏目和评测配置                  | 通用运行时能力                               |
| `db` / `compose.yaml` | 提供本地 PostgreSQL + pgvector 环境                     | 当前 Demo 的状态保存；Demo 仍使用内存检查点  |

### 2.1 依赖方向

工程希望保持以下单向依赖：

```text
apps  ──────>  core  ──────>  plugin-sdk
  └────────────────────────>  plugins  ──────>  plugin-sdk / 第三方 SDK
```

关键约束：

- LangGraph 编排代码和类型只留在 `packages/core` 内，不进入 Plugin SDK；根包仅为 Studio 本地开发声明必要的运行时依赖；
- AI SDK、MCP SDK 和 PostgreSQL Driver 只出现在对应插件中；
- CLI 是当前的 Composition Root，负责选择并组装 Core 与插件；
- 插件不能决定 Agent 工作流，也不应依赖 Core 的内部实现；
- Core 和公共契约不绑定“金融 + AI”主题，领域配置最终应放入 Preset 和 Prompt。

当前 `source-mcp` 与 `storage-postgres` 仍是底层 Client/Pool 工厂，还没有实现 Plugin SDK
中的 `McpGateway` 或 `MemoryPort`；它们属于已建立依赖边界、尚未完成业务接线的骨架。

## 3. Agent Graph

`packages/core` 使用 LangGraph.js `StateGraph` 表达三个 AI 节点、补证分支和受限的修订循环。

```mermaid
flowchart LR
    Start([START]) --> Research
    Research --> CurateWrite[Curate & Write]
    CurateWrite --> Review
    Review --> Decision{Review 结果}
    Decision -- 补充证据 --> Research
    Decision -- 定向修订 --> CurateWrite
    Decision -- 通过或达到修订上限 --> End([END])
```

节点在当前 Demo 中的作用：

| 节点           | 输入关注点        | 输出到共享状态                        | 当前实现                            |
| -------------- | ----------------- | ------------------------------------- | ----------------------------------- |
| Research       | 研究主题          | `plan`、`evidence`                    | 生成固定计划和两条离线 Fixture 证据 |
| Curate & Write | 证据、Review 反馈 | `stories`、`draft`、`revisionCount`   | 聚合事件；首稿无来源，修订稿补来源  |
| Review         | 草稿与证据        | `approved`、`critique`、`reviewRoute` | 检查来源并选择补证或修订路线        |

Review 的条件分支规则是：

1. `approved === true` 时结束；
2. `revisionCount >= maxRevisions` 时也结束；
3. `reviewRoute === "research"` 时回到 Research 补充证据；
4. 否则回到 Curate & Write 定向修订。

因此，达到修订上限只表示流程停止继续修改，**不一定表示草稿已经通过**。调用方应继续读取
`approved` 判断最终质量状态。

当前 Fixture 因已有两条证据，会触发 Curate & Write 修订路线；Research 补证路线由单元测试
覆盖，真实模型接入后由 Review 的结构化输出决定。

## 4. 共享状态

所有节点通过 `AgentGraphState` 读写同一份结构化状态。

| 字段            | 作用                                               | 主要写入者     |
| --------------- | -------------------------------------------------- | -------------- |
| `runId`         | 一次运行的唯一标识，同时作为 LangGraph `thread_id` | CLI            |
| `topic`         | 本次研究主题                                       | CLI            |
| `maxRevisions`  | Review 拒绝后允许的最大修订次数                    | CLI            |
| `plan`          | 研究步骤                                           | Research       |
| `evidence`      | 带标题、URL 和摘录的证据                           | Research       |
| `stories`       | 聚合后的事件及其证据引用                           | Curate & Write |
| `draft`         | Markdown 简报草稿                                  | Curate & Write |
| `critique`      | 质量检查结论                                       | Review         |
| `approved`      | 当前草稿是否通过                                   | Review         |
| `reviewRoute`   | 未通过时选择 `research` 或 `revise`                | Review         |
| `revisionCount` | 已执行的修订次数                                   | Curate & Write |
| `trace`         | 节点执行轨迹；通过 reducer 追加而不是覆盖          | 所有节点       |

状态字段使用 Zod 描述，既提供 TypeScript 类型推导，也在图运行时约束状态形状。
除 `runId` 和 `topic` 外，其余字段都定义了默认值。

默认使用 LangGraph `MemorySaver` 保存图检查点，它只适合本地运行和测试。传入
`{ checkpoint: false }` 可以关闭检查点。PostgreSQL 当前尚未参与 Agent 状态持久化。

## 5. Demo 端到端流程

执行 `pnpm demo` 时，实际调用链如下：

```mermaid
sequenceDiagram
    participant Script as 根 package script
    participant CLI as apps/cli
    participant Core as packages/core
    participant Graph as LangGraph
    participant File as output-file

    Script->>Script: 构建全部 workspace package
    Script->>CLI: 执行 demo 命令
    CLI->>CLI: 生成 runId 和 Fixture Handlers
    CLI->>Core: createAgentGraph(handlers)
    Core->>Graph: 编译 StateGraph + MemorySaver
    CLI->>Graph: invoke(initialState, thread_id)
    Graph->>Graph: 三节点执行并完成一次定向修订
    Graph-->>CLI: 返回最终共享状态
    CLI->>CLI: 渲染 Markdown 制品
    CLI->>File: deliver(artifact)
    File-->>CLI: 返回 DeliveryReceipt
```

默认产物是根目录下的 `.artifacts/demo-digest.md`。可以通过 `AGENT_OUTPUT_PATH`
覆盖输出路径。该流程不会读取 `.env.example` 中的数据库配置，也不会调用模型、MCP
或外部网络。

## 6. Plugin SDK

`packages/plugin-sdk` 是 Core 与外部实现之间的稳定协议层，公共类型不暴露第三方框架类型。

| 契约             | 用途                                                        | 当前实现情况                                       |
| ---------------- | ----------------------------------------------------------- | -------------------------------------------------- |
| `PluginManifest` | 描述插件 ID、名称、版本、类型和 Core 兼容范围               | Model 与 File Output 已提供 Manifest               |
| `ModelProvider`  | 接收角色、系统提示和用户提示，返回文本、模型名和 token 用量 | `model-ai-sdk` 已适配 `generateText`，未接入 Demo  |
| `McpGateway`     | 列出允许的工具并执行结构化工具调用                          | 已定义接口；`source-mcp` 目前仅创建原始 MCP Client |
| `MemoryPort`     | 搜索记忆和提交记忆候选                                      | 已定义接口；暂无实现                               |
| `OutputPlugin`   | 发送已渲染制品并返回发送回执                                | `output-file` 已实现并用于 Demo                    |

`PluginKindSchema` 预留了 `model`、`embedding`、`source`、`storage` 和 `output`
五类插件，但当前还没有为每一类都提供完整接口和实现。

## 7. 目录结构与作用

```text
.
├── apps/
│   └── cli/                      # 命令行入口与当前 Composition Root
├── packages/
│   ├── core/                     # Agent 状态和 LangGraph 节点编排
│   └── plugin-sdk/               # 框架无关的公共插件契约
├── plugins/
│   ├── model-ai-sdk/             # AI SDK -> ModelProvider 适配器
│   ├── output-file/              # Markdown/文本制品写入本地文件
│   ├── source-mcp/               # 官方 MCP SDK Client 骨架
│   └── storage-postgres/         # PostgreSQL Pool 工厂骨架
├── db/
│   └── init/                     # 数据库容器首次启动时执行的初始化 SQL
├── docs/                         # 当前架构与目标技术方案
├── presets/
│   └── finance-ai/               # 金融与 AI 领域 Preset 占位
├── prompts/                      # 版本化 Agent Prompt 的预留位置
├── .env.example                  # 本地环境变量示例
├── compose.yaml                  # PostgreSQL + pgvector 本地服务
├── package.json                  # 根脚本、工具链版本与 Node/pnpm 约束
├── pnpm-workspace.yaml           # monorepo package 发现与依赖安装策略
├── tsconfig.base.json            # 所有 package 共用的严格 TS 编译配置
└── eslint.config.mjs             # 全仓库 ESLint 规则
```

### 7.1 `apps/cli`

- `src/index.ts`：可执行程序入口，解析 `demo` 命令并展示帮助信息；
- `src/demo.ts`：当前系统的组装入口，运行 Agent Graph、渲染 Markdown，并调用文件输出插件；
- `src/fixture-handlers.ts`：定义 Research、Curate & Write、Review 三个离线 Fixture Handler；
- `src/studio-graph.ts`：导出供 LangGraph Studio 加载的无本地 checkpointer Graph；
- `package.json`：声明 CLI 二进制名和对 Core、Plugin SDK、File Output 的依赖。

未来真实运行命令、配置加载、插件选择和依赖注入也应从这一层进入，避免把部署细节放进
Core。

### 7.2 `packages/core`

- `src/agent-state.ts`：定义 Evidence、Story 和 Agent Graph 的共享状态；
- `src/agent-graph.ts`：定义三节点顺序、Review 条件分支、修订上限和检查点策略；
- `src/index.ts`：Core 的公开导出面，调用方不需要引用内部文件；
- `src/agent-graph.test.ts`：验证定向修订、Research 补证、预算耗尽和执行轨迹。

Core 是当前最主要的业务运行模块，但节点的具体行为通过 `AgentNodeHandlers` 注入，因此图结构
与 Fixture/模型实现可以独立变化。

### 7.3 `packages/plugin-sdk`

- `src/index.ts`：集中定义插件 Manifest、模型、MCP、记忆和输出接口；
- 只依赖 Zod，不依赖 LangGraph、AI SDK、MCP SDK 或数据库驱动；
- 是第三方插件未来应该依赖的公共 package。

### 7.4 `plugins`

- `model-ai-sdk`：把 AI SDK 的 `LanguageModel` 包装成项目 `ModelProvider`，并统一返回
  模型名和 token 使用量；
- `output-file`：确保目标目录存在后写入 UTF-8 文件，是当前唯一接入执行闭环的插件；
- `source-mcp`：创建官方 MCP SDK `Client`，尚未实现连接传输、工具白名单和
  `McpGateway`；
- `storage-postgres`：创建 `pg.Pool`，尚未包含表结构、Repository 或 `MemoryPort`
  实现。

### 7.5 `db` 与 `compose.yaml`

`compose.yaml` 提供 PostgreSQL 17 + pgvector 容器，默认数据库为
`finance_ai_news`。`db/init/001_extensions.sql` 在数据库首次初始化时启用 `vector`
扩展。

当前没有业务表迁移，删除并重建数据卷才会重新执行 `db/init`。这些配置用于后续持久化开发，
不是运行 Fixture Demo 的前置条件。

### 7.6 `presets` 与 `prompts`

- `presets/finance-ai`：未来承载主题分类、栏目、来源建议、角色指令和回放评测；
- `prompts`：未来按角色和版本存放 Prompt；
- 两个目录目前只有说明文件，不参与构建或运行。

将领域内容放在这两个目录，可以让 Core 保持通用的信息研究能力，而不是把金融与 AI
规则硬编码进工作流。

### 7.7 根目录工程文件

| 文件                  | 作用                                                                        |
| --------------------- | --------------------------------------------------------------------------- |
| `package.json`        | 统一 build、typecheck、lint、format、test、demo 和完整 `check` 命令         |
| `pnpm-workspace.yaml` | 将 `apps/*`、`packages/*`、`plugins/*` 纳入 workspace                       |
| `tsconfig.base.json`  | 启用 NodeNext、严格类型、声明文件和 source map                              |
| `eslint.config.mjs`   | 统一 TS Lint，并禁止显式 `any`、要求 type-only import                       |
| `.env.example`        | 记录数据库、时区和制品目录的计划配置；Demo 仅使用可选的 `AGENT_OUTPUT_PATH` |
| `CONTRIBUTING.md`     | 本地开发、设计约束和 PR 要求                                                |
| `SECURITY.md`         | 安全问题报告方式                                                            |
| `LICENSE`             | Apache-2.0 许可证                                                           |

构建产物位于各 package 的 `dist/`，运行制品位于 `.artifacts/`。两者都不是源代码目录，
不应作为架构扩展点。

## 8. 当前完成度与目标架构的差距

| 能力                   | 当前状态                 | 下一步接线位置                                     |
| ---------------------- | ------------------------ | -------------------------------------------------- |
| 三节点编排与有限修订   | 已实现                   | 接入真实 `ModelProvider` Handler                   |
| 离线研究闭环           | 已实现                   | `apps/cli/src/demo.ts`                             |
| 本地文件输出           | 已实现                   | `plugins/output-file`                              |
| 真实模型调用           | 适配器已存在，未组装     | CLI/未来 Runtime 注入 `ModelProvider`              |
| MCP 新闻采集           | 仅 MCP Client 骨架       | `plugins/source-mcp` 实现 `McpGateway`/Source 契约 |
| PostgreSQL 持久化      | 仅 Pool 与 pgvector 环境 | `plugins/storage-postgres` + 数据库迁移            |
| 长期记忆               | 只有公共接口             | `MemoryPort` 与确定性 Memory Service 实现          |
| 业务 Prompt/Preset     | 目录占位                 | `prompts/`、`presets/finance-ai/`                  |
| 生产级幂等、审计、恢复 | 仅内存检查点             | 持久化 Runtime 与 Run/Stage 数据模型               |
| 飞书输出、评测与观测   | 未实现                   | 新插件和独立 eval/observability 模块               |

在继续开发时，应优先保持现有边界：Core 只表达流程与领域状态，第三方能力通过 Plugin SDK
接入，CLI/Runtime 负责组装，Preset 和 Prompt 负责领域差异。

### 8.1 节点与逻辑职责

当前三个 Handler 已与 MVP 运行边界一致，但内部仍保留六种逻辑职责作为 Prompt、Schema 和
评测标签：Research 合并 Planner 与 Researcher，Curate & Write 合并 Curator 与 Editor，
Review 承担 Critic；Memory Curator 不作为首期 AI 节点。

采集执行、标准化、精确去重、Schema 校验、持久化、发送和幂等继续由确定性代码负责。只有回放评测、
上下文限制、权限差异、预算或恢复边界证明有必要时，才把逻辑职责重新拆成更多 AI 节点。完整决策见
[技术方案](./technical-design.md#52-agent-runtimeai-节点与职责)。
