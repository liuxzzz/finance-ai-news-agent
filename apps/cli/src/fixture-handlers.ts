import type { AgentNodeHandlers } from "@finance-ai-news-agent/core";

export const fixtureHandlers: AgentNodeHandlers = {
  research: (state) => ({
    plan: [`研究「${state.topic}」的重要进展`, "收集至少两个演示来源"],
    evidence: [
      {
        id: "fixture-ai",
        title: "Fixture: AI Agent 工程进展",
        url: "https://example.com/ai-agent",
        excerpt: "这是离线 Fixture，不会访问真实网络。",
      },
      {
        id: "fixture-finance",
        title: "Fixture: 金融市场信息",
        url: "https://example.com/finance",
        excerpt: "这是第二条离线 Fixture，用于展示多来源证据。",
      },
    ],
    trace: ["research"],
  }),

  curateWrite: (state) => {
    const stories = [
      {
        id: "fixture-story",
        headline: `${state.topic}：演示事件`,
        whyItMatters: "验证 Agent Graph、证据传递和插件输出能够协同工作。",
        evidenceIds: state.evidence.map((item) => item.id),
      },
    ];
    const isRevision = state.draft.length > 0;
    const sourceLines = state.evidence.map((item) => `- [${item.title}](${item.url})`).join("\n");

    return {
      stories,
      draft: [
        `## ${stories[0]?.headline ?? state.topic}`,
        "",
        stories[0]?.whyItMatters ?? "Demo story",
        "",
        ...(isRevision ? ["[已校验]", "", "### 来源", sourceLines] : []),
      ].join("\n"),
      revisionCount: isRevision ? state.revisionCount + 1 : state.revisionCount,
      trace: ["curate_write"],
    };
  },

  review: (state) => {
    const approved = state.draft.includes("[已校验]");

    return {
      approved,
      reviewRoute: state.evidence.length > 0 ? "revise" : "research",
      critique: approved ? "引用完整，Demo 通过。" : "缺少显式来源，请修订简报。",
      trace: ["review"],
    };
  },
};
