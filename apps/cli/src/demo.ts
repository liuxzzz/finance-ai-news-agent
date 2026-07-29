import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import {
  createAgentGraph,
  type AgentGraphStateValue,
  type AgentRoleHandlers,
} from "@finance-ai-news-agent/core";
import { FileOutputPlugin } from "@finance-ai-news-agent/output-file";
import type { RenderedArtifact } from "@finance-ai-news-agent/plugin-sdk";

const fixtureHandlers: AgentRoleHandlers = {
  planner: (state) => ({
    plan: [`研究「${state.topic}」的重要进展`, "收集至少两个演示来源"],
    trace: ["planner"],
  }),

  researcher: () => ({
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
    trace: ["researcher"],
  }),

  curator: (state) => ({
    stories: [
      {
        id: "fixture-story",
        headline: `${state.topic}：演示事件`,
        whyItMatters: "验证 Agent Graph、证据传递和插件输出能够协同工作。",
        evidenceIds: state.evidence.map((item) => item.id),
      },
    ],
    trace: ["curator"],
  }),

  editor: (state) => {
    const isRevision = state.draft.length > 0;
    const sourceLines = state.evidence.map((item) => `- [${item.title}](${item.url})`).join("\n");

    return {
      draft: [
        `## ${state.stories[0]?.headline ?? state.topic}`,
        "",
        state.stories[0]?.whyItMatters ?? "Demo story",
        "",
        ...(isRevision ? ["[已校验]", "", "### 来源", sourceLines] : []),
      ].join("\n"),
      revisionCount: isRevision ? state.revisionCount + 1 : state.revisionCount,
      trace: ["editor"],
    };
  },

  critic: (state) => {
    const approved = state.draft.includes("[已校验]");

    return {
      approved,
      critique: approved ? "引用完整，Demo 通过。" : "缺少显式来源，请 Editor 修订。",
      trace: ["critic"],
    };
  },

  memoryCurator: (state) => ({
    memoryCandidates: state.stories.map((story) => `${story.headline}: ${story.whyItMatters}`),
    trace: ["memory_curator"],
  }),
};

function renderDemoDigest(state: AgentGraphStateValue): string {
  return [
    "# Finance & AI News Agent — Fixture Demo",
    "",
    `- Run ID: \`${state.runId}\``,
    `- Topic: ${state.topic}`,
    `- Approved: ${state.approved ? "yes" : "no"}`,
    `- Revisions: ${state.revisionCount}`,
    "",
    state.draft,
    "",
    "### Agent Trace",
    "",
    state.trace.map((node) => `- ${node}`).join("\n"),
    "",
    "> 本文件完全由离线 Fixture 生成，没有调用模型、MCP 或外部平台。",
    "",
  ].join("\n");
}

export async function runDemo(): Promise<void> {
  const runId = randomUUID();
  const graph = createAgentGraph(fixtureHandlers);
  const state = await graph.invoke(
    {
      runId,
      topic: "Finance & AI",
      maxRevisions: 1,
    },
    {
      configurable: {
        thread_id: runId,
      },
    },
  );

  const defaultOutputPath = resolve(
    process.env.INIT_CWD ?? process.cwd(),
    ".artifacts/demo-digest.md",
  );
  const outputPath = process.env.AGENT_OUTPUT_PATH ?? defaultOutputPath;
  const output = new FileOutputPlugin(outputPath);
  const artifact: RenderedArtifact = {
    id: runId,
    mediaType: "text/markdown",
    content: renderDemoDigest(state),
  };
  const receipt = await output.deliver(artifact);

  process.stdout.write(
    [
      "Fixture demo completed.",
      `Artifact: ${receipt.target}`,
      `Trace: ${state.trace.join(" -> ")}`,
      "",
    ].join("\n"),
  );
}
