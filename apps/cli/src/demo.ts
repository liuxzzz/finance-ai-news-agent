import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { createAgentGraph, type AgentGraphStateValue } from "@finance-ai-news-agent/core";
import { FileOutputPlugin } from "@finance-ai-news-agent/output-file";
import type { RenderedArtifact } from "@finance-ai-news-agent/plugin-sdk";

import { fixtureHandlers } from "./fixture-handlers.js";

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
