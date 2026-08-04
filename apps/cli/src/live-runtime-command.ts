import { createHash } from "node:crypto";

import {
  LangGraphAgentWorkflow,
  RunExecutor,
  createAgentGraph,
  createModelAgentHandlers,
  createToolCallingResearchProvider,
  type AgentGraphStateValue,
} from "@finance-ai-news-agent/core";
import { createDeepSeekModelProvider } from "@finance-ai-news-agent/model-ai-sdk";
import { FileOutputPlugin } from "@finance-ai-news-agent/output-file";
import type { RunRecord } from "@finance-ai-news-agent/plugin-sdk";
import {
  createLazyStreamableHttpMcpGateway,
  validateMcpServerUrl,
} from "@finance-ai-news-agent/source-mcp";
import {
  PostgresRuntimeStore,
  createPostgresCheckpointer,
  createPostgresPool,
} from "@finance-ai-news-agent/storage-postgres";

import {
  DEEPSEEK_THINKING_MODE,
  MAX_MODEL_REQUESTS_PER_RUN,
  STRUCTURED_OUTPUT_ATTEMPTS,
  createDeepSeekModelSnapshot,
  resolveDeepSeekRuntimeConfig,
} from "./ai-runtime-command.js";
import {
  parseRunOptions,
  projectRoot,
  requireDatabaseUrl,
  resolvePersistentOutputPath,
} from "./runtime-command.js";

export interface LiveResearchConfig {
  serverUrl: string;
  allowedTools: string[];
  bearerToken?: string;
  maxToolCalls: number;
}

export async function runPersistentAiLive(args: string[]): Promise<void> {
  const options = parseRunOptions(args, { edition: "ai-live-v1" });
  const deepSeekConfig = resolveDeepSeekRuntimeConfig(process.env);
  const researchConfig = resolveLiveResearchConfig(process.env);
  const pool = createPostgresPool({ connectionString: requireDatabaseUrl() });
  let closeGateway: (() => Promise<void>) | undefined;

  try {
    const connected = createLazyStreamableHttpMcpGateway({
      serverUrl: researchConfig.serverUrl,
      allowedTools: researchConfig.allowedTools,
      ...(researchConfig.bearerToken === undefined
        ? {}
        : { bearerToken: researchConfig.bearerToken }),
    });
    closeGateway = connected.close;
    const checkpointer = await createPostgresCheckpointer(pool);
    const store = new PostgresRuntimeStore(pool);
    const model = createDeepSeekModelProvider({
      ...deepSeekConfig,
      thinkingMode: DEEPSEEK_THINKING_MODE,
    });
    const research = createToolCallingResearchProvider({
      model,
      gateway: connected.gateway,
      modelCallLedger: store,
      maxModelRequests: MAX_MODEL_REQUESTS_PER_RUN,
      maxToolCalls: researchConfig.maxToolCalls,
    });
    const handlers = createModelAgentHandlers({
      model,
      research,
      modelCallLedger: store,
      structuredOutputAttempts: STRUCTURED_OUTPUT_ATTEMPTS,
      maxModelRequests: MAX_MODEL_REQUESTS_PER_RUN,
    });
    const graph = createAgentGraph(handlers, { checkpointer });
    const outputPath = resolvePersistentOutputPath(
      projectRoot(),
      process.env.AGENT_OUTPUT_DIR ?? ".artifacts",
      options.tenantId,
      options.reportDate,
      options.edition,
    );
    const output = new FileOutputPlugin(outputPath);
    const runtime = new RunExecutor({
      store,
      workflow: new LangGraphAgentWorkflow(graph),
      renderArtifact: (state, run) => ({
        mediaType: "text/markdown",
        content: renderLiveDigest(state, run),
      }),
      output,
      deliveryTarget: outputPath,
    });
    const result = await runtime.execute({
      tenantId: options.tenantId,
      reportDate: options.reportDate,
      edition: options.edition,
      topic: options.topic,
      maxRevisions: options.maxRevisions,
      dryRun: options.dryRun,
      configSnapshot: {
        timezone: options.timezone,
        mode: "ai-live",
        researchPreset: "mcp-function-calling-v1",
        mcpEndpointFingerprint: createHash("sha256")
          .update(researchConfig.serverUrl)
          .digest("hex")
          .slice(0, 16),
        allowedTools: researchConfig.allowedTools,
        maxToolCalls: researchConfig.maxToolCalls,
      },
      promptVersions: {
        research: "finance-ai-tool-research@1",
        curateWrite: "finance-ai-curate-write@1",
        review: "finance-ai-review@1",
        renderer: "finance-ai-markdown@1",
      },
      modelSnapshot: createDeepSeekModelSnapshot(deepSeekConfig),
    });

    process.stdout.write(
      [
        `Run: ${result.run.id}`,
        `Status: ${result.run.status}`,
        `Disposition: ${result.disposition}`,
        `Attempts: ${result.run.attemptCount}`,
        `Model requests: ${result.state?.modelUsage.requests ?? 0}`,
        `Model tokens: ${result.state?.modelUsage.totalTokens ?? 0}`,
        `Evidence: ${result.state?.evidence.length ?? 0}`,
        `Artifact: ${result.artifact?.id ?? "none"}`,
        `Delivery: ${result.delivery?.status ?? (options.dryRun ? "skipped" : "none")}`,
        "",
      ].join("\n"),
    );
  } finally {
    try {
      await closeGateway?.();
    } finally {
      await pool.end();
    }
  }
}

export function resolveLiveResearchConfig(
  environment: Readonly<Record<string, string | undefined>>,
): LiveResearchConfig {
  const serverUrl = validateMcpServerUrl(required(environment, "MCP_SERVER_URL")).toString();
  const allowedTools = required(environment, "MCP_ALLOWED_TOOLS")
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0);

  if (
    allowedTools.length === 0 ||
    allowedTools.length > 32 ||
    new Set(allowedTools).size !== allowedTools.length
  ) {
    throw new Error("MCP_ALLOWED_TOOLS must contain 1 to 32 unique comma-separated tool names.");
  }

  for (const name of allowedTools) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) {
      throw new Error(`MCP_ALLOWED_TOOLS contains an invalid tool name: ${name}.`);
    }
  }

  const maxToolCallsText = environment.MCP_MAX_TOOL_CALLS?.trim() || "4";
  const maxToolCalls = Number(maxToolCallsText);

  if (
    !/^\d+$/.test(maxToolCallsText) ||
    !Number.isSafeInteger(maxToolCalls) ||
    maxToolCalls <= 0 ||
    maxToolCalls > 16
  ) {
    throw new Error("MCP_MAX_TOOL_CALLS must be an integer from 1 to 16.");
  }

  const bearerToken = environment.MCP_BEARER_TOKEN?.trim();
  return {
    serverUrl,
    allowedTools,
    ...(bearerToken === undefined || bearerToken.length === 0 ? {} : { bearerToken }),
    maxToolCalls,
  };
}

function renderLiveDigest(state: AgentGraphStateValue, run: RunRecord): string {
  return [
    "# Finance & AI News Agent — Live MCP Research",
    "",
    `- Run ID: \`${run.id}\``,
    `- Topic: ${state.topic}`,
    `- Approved: ${state.approved ? "yes" : "no"}`,
    `- Evidence: ${state.evidence.length}`,
    `- Model requests: ${state.modelUsage.requests}`,
    `- Model tokens: ${state.modelUsage.totalTokens}`,
    "",
    state.draft,
    "",
    "### Agent Trace",
    "",
    state.trace.map((node) => `- ${node}`).join("\n"),
    "",
    "> Research 使用配置的 MCP 白名单工具；每条链接来自通过 Schema 校验的工具 Evidence。",
    "",
  ].join("\n");
}

function required(environment: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = environment[name]?.trim();

  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required for run-live.`);
  }

  return value;
}
