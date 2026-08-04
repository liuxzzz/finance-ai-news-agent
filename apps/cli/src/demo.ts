import { resolve } from "node:path";

import {
  createAgentGraph,
  InMemoryRuntimeStore,
  LangGraphAgentWorkflow,
  RunExecutor,
  type AgentGraphStateValue,
} from "@finance-ai-news-agent/core";
import { FileOutputPlugin } from "@finance-ai-news-agent/output-file";
import type { RunRecord } from "@finance-ai-news-agent/plugin-sdk";

import { fixtureHandlers } from "./fixture-handlers.js";

export function renderDemoDigest(state: AgentGraphStateValue, run: RunRecord): string {
  return [
    "# Finance & AI News Agent — Fixture Demo",
    "",
    `- Run ID: \`${run.id}\``,
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
  const defaultOutputPath = resolve(
    process.env.INIT_CWD ?? process.cwd(),
    ".artifacts/demo-digest.md",
  );
  const outputPath = process.env.AGENT_OUTPUT_PATH ?? defaultOutputPath;
  const output = new FileOutputPlugin(outputPath);
  const graph = createAgentGraph(fixtureHandlers);
  const runtime = new RunExecutor({
    store: new InMemoryRuntimeStore(),
    workflow: new LangGraphAgentWorkflow(graph),
    renderArtifact: (state, run) => ({
      mediaType: "text/markdown",
      content: renderDemoDigest(state, run),
    }),
    output,
    deliveryTarget: outputPath,
  });
  const result = await runtime.execute({
    tenantId: "fixture",
    reportDate: new Date().toISOString().slice(0, 10),
    edition: "demo",
    topic: "Finance & AI",
    maxRevisions: 1,
  });

  process.stdout.write(
    [
      "Fixture demo completed.",
      `Run: ${result.run.id} (${result.run.status})`,
      `Artifact: ${result.delivery?.target ?? outputPath}`,
      `Trace: ${result.state?.trace.join(" -> ") ?? "unavailable"}`,
      "",
    ].join("\n"),
  );
}
