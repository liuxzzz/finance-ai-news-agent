import type { ResearchProvider } from "@finance-ai-news-agent/core";

/**
 * Deterministic evidence used to evaluate real model prompts without coupling P2 to live news APIs.
 * The examples are synthetic and must never be presented as current news.
 */
export const replayResearch: ResearchProvider = (state) => ({
  schemaVersion: "research.v1",
  plan: [
    `从固定回放样本中整理「${state.topic}」的重要事件`,
    "合并重复来源并保留每条结论的证据引用",
    "检查摘要是否严格受给定摘录支持",
  ],
  modelUsage: { requests: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  evidence: [
    {
      id: "replay-ai-infra-1",
      title: "Synthetic replay: AI infrastructure release",
      url: "https://example.com/replay/ai-infrastructure",
      excerpt:
        "A fictional infrastructure vendor released a lower-cost inference service and reported that the new tier targets latency-sensitive enterprise workloads.",
    },
    {
      id: "replay-ai-infra-2",
      title: "Synthetic replay: enterprise adoption response",
      url: "https://example.com/replay/enterprise-adoption",
      excerpt:
        "A separate fictional industry survey found that buyers rank predictable inference cost and deployment controls above peak benchmark performance.",
    },
    {
      id: "replay-market-1",
      title: "Synthetic replay: financing conditions",
      url: "https://example.com/replay/financing-conditions",
      excerpt:
        "A fictional market note said infrastructure companies with recurring revenue retained better access to financing than businesses dependent on one-time hardware sales.",
    },
    {
      id: "replay-policy-1",
      title: "Synthetic replay: disclosure proposal",
      url: "https://example.com/replay/disclosure-proposal",
      excerpt:
        "A fictional policy consultation proposed standardized disclosure of model evaluation scope, energy assumptions, and material deployment limitations.",
    },
  ],
});
