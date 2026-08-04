# Finance & AI News Agent 实现计划与进度

> 更新日期：2026-08-04
> 当前阶段：每日 RSS → Agent → 飞书 MVP 已闭环，正在扩展语义记忆与专业来源
> 总体进度：约 92%

## 1. 阶段进度

| 阶段              | 主要交付物                                                   | 状态   | 进度 | 预计周期 |
| ----------------- | ------------------------------------------------------------ | ------ | ---: | -------: |
| P0 工程骨架       | Monorepo、三节点 Graph、Plugin SDK、Fixture Demo、CI、Studio | 已完成 | 100% |        - |
| P1 运行时与持久化 | Run/Stage 状态机、数据库迁移、幂等、恢复、审计               | 已完成 | 100% |        - |
| P2 AI 节点        | Prompt、结构化输出、真实模型、预算、回放评测                 | 已完成 | 100% |        - |
| P3 实时采集       | RSS/API Source、权限与预算、契约测试、金融/AI 来源           | 进行中 |  80% |     1 周 |
| P4 内容处理       | 标准化、去重、聚类、排序、证据引用、Digest                   | 已完成 | 100% |        - |
| P5 输出闭环       | 制品持久化、飞书发送、发送幂等、重发                         | 已完成 | 100% |        - |
| P6 记忆与质量     | pgvector、历史去重、事件进展、偏好与反馈                     | 进行中 |  70% |     1 周 |
| P7 生产化         | 调度、日志、Trace、告警、成本、安全与发布                    | 进行中 |  75% |     1 周 |

> 进度为基于当前代码完成度的阶段性估算，完成验收后更新。

## 2. 当前已完成

- [x] TypeScript + pnpm Monorepo
- [x] LangGraph 三节点及有限修订循环
- [x] Fixture 离线 Demo 与文件输出
- [x] Plugin SDK 基础接口
- [x] 模型、RSS、可选 MCP、PostgreSQL 适配器骨架
- [x] LangGraph Studio 本地调试入口
- [x] 单元测试、类型检查、Lint、格式检查与 CI
- [x] 技术方案和当前架构文档
- [x] 来源级成功/失败审计与原始 RSS 持久化
- [x] canonical URL、跨源去重、聚类、排序和来源均衡
- [x] 最近 7 天跨日精确去重
- [x] 审核后 Story 事件匹配、跨日进展时间线与幂等更新
- [x] 飞书自定义机器人真实发送和重复触发幂等验收
- [x] launchd 每日调度、失败退避、health/metrics 和 Docker Worker

## 3. 实施顺序

1. **收口工程骨架**：提交当前实现，补齐 Phase 0 基础回放样本。
2. **持久化 Runtime**：实现 Run/Stage、迁移、幂等、恢复和审计查询。
3. **AI 节点落地**：加入版本化 Prompt、结构化 Schema、真实模型和评测。
4. **实时采集**：完成 Source Gateway，并接入至少两个金融来源和两个 AI 来源。
5. **内容处理**：实现标准化、跨源去重、Story 聚类、排序与证据追踪。
6. **输出闭环**：先持久化制品，再通过飞书幂等发送和重发。
7. **记忆与生产化**：加入跨日记忆、监控、安全、调度与发布能力。

## 4. 已完成迭代

**目标：实现 PostgreSQL Run/Stage 持久化 Runtime。**

- [x] 建立数据库迁移机制
- [x] 创建 `runs`、`run_stages`、`artifacts`、`deliveries` 表
- [x] 实现 Run/Stage 状态迁移与运行锁
- [x] 支持重复触发幂等
- [x] 支持从最近成功阶段恢复
- [x] 增加运行状态和错误审计查询
- [x] 用 Fixture Graph 覆盖正常、失败恢复和重复触发测试

完成标准：同一期任务重复触发只产生一个逻辑 Run；节点失败后可以恢复执行，且不会重复生成或发送制品。

验收结果：单元测试覆盖正常运行、并发重复触发、Review 拒绝、失败恢复和发送重试；真实
PostgreSQL 验证确认相同 Run 可复用，失败节点从 durable checkpoint 恢复，且只产生一个 Delivery。

该 Runtime 现由下一节的结构化 AI 节点迭代消费。

## 5. 当前 AI 节点迭代

**目标：用真实 DeepSeek 模型验证结构化编辑与审核链路，同时保持 Research 可离线回放。**

- [x] 增加 `StructuredModelProvider` 公共契约
- [x] 使用官方 DeepSeek AI SDK Provider 和可配置 API 根地址
- [x] 实现版本化 Curate/Review Prompt
- [x] 使用严格 Zod Schema 校验模型输出
- [x] 禁止模型生成来源 URL，Markdown 链接由 Evidence 确定性渲染
- [x] 校验所有 Story、Review 对 Evidence ID 的引用
- [x] 支持空输出或非法结构的一次受限恢复调用
- [x] 记录模型请求数和 Token Usage
- [x] 增加 `run-ai` 持久化回放命令和离线契约测试
- [x] 使用本地 DeepSeek 凭据完成真实 API 冒烟测试
- [x] 增加持久化 Model Call Ledger，实现跨进程恢复的硬成本上限
- [x] 增加 DeepSeek Function Calling 公共契约和 AI SDK 适配
- [x] 保留白名单、参数校验、超时和结果大小限制的可选 MCP Gateway
- [x] 增加直接 RSS `run-live` 入口和离线契约测试
- [x] 接入 36氪、虎嗅、InfoQ RSS 并替换 `run-live` 的合成/MCP Evidence
- [x] 增加来源级失败审计
- [ ] 增加更多专业金融与 AI RSS/API 来源

完成标准：DeepSeek 对固定 Evidence 生成结构化 Stories，Review 能通过或定向修订；任意未知
Evidence ID 都被程序拒绝，最终制品的 URL 与输入 Evidence 完全一致，密钥不进入状态或审计数据。

2026-08-04 冒烟验收：真实 DeepSeek 回放 Run 一次执行成功，完成 2 次结构化模型请求；随后同一
Run 从 dry-run 恢复交付，并在第三次触发时直接幂等复用，模型请求数未增加。生成制品和运行审计
均未包含 API Key。

2026-08-04 Ledger 验收：迁移 `002_model_calls.sql` 后再次执行真实 DeepSeek 回放，数据库分别记录
`curate_write` 与 `review` 两条成功调用及各自 Token。随后 `run-live` 改为内部 RSS 工具，真实
拉取 36氪、虎嗅和 InfoQ Feed 并取得当日新闻；MCP 不再是核心新闻采集依赖。

2026-08-04 MVP 闭环验收：`003`–`006` 迁移记录来源执行、原始条目、标准化内容、标题指纹和 Story
事件时间线；跨日期
集成 Run 证明与前一日精确 URL/标题交集为 0，并在过滤后继续覆盖三个来源。飞书 Run 先 dry-run
持久化 5,672 字节制品，随后只执行 Delivery 并成功发送；第三次相同触发复用同一 Delivery，记录数和
attempt 均保持为 1。macOS `launchd` 每日任务已安装为北京时间 08:00。

事件记忆验收：两个跨日且标题措辞不同的报道被确定性匹配到同一事件，`updateCount=2`；重复保存
第二天更新后计数保持 2。真实 RSS + DeepSeek dry-run 生成 6 个审核后 stories，Runtime 的
`persist_memory` 阶段成功写入 6 个 Event 与 6 条 Update，再进入 Artifact 阶段。

## 6. MVP 里程碑

| 里程碑        | 完成条件                                            |
| ------------- | --------------------------------------------------- |
| M1 可恢复运行 | Run/Stage 持久化，支持幂等启动、失败恢复和审计      |
| M2 真实研究   | 三个 AI 节点使用真实模型，并通过基础回放评测        |
| M3 多源简报   | 至少两个金融来源和两个 AI 来源，每条内容可追溯      |
| M4 可发送闭环 | Digest 持久化并通过飞书幂等发送，支持重发           |
| M5 MVP 验收   | 连续稳定运行 7 天，无重复发送，单来源失败不阻断运行 |

预计 MVP 周期：7–9 周；完整生产化版本：10–13 周。
