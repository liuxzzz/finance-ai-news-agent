import { createHash } from "node:crypto";

import {
  FINANCE_AI_PROMPT_VERSIONS,
  LangGraphAgentWorkflow,
  RunExecutor,
  createAgentGraph,
  createModelAgentHandlers,
  type AgentGraphStateValue,
} from "@finance-ai-news-agent/core";
import { createDeepSeekModelProvider } from "@finance-ai-news-agent/model-ai-sdk";
import { FileOutputPlugin } from "@finance-ai-news-agent/output-file";
import type { RunRecord } from "@finance-ai-news-agent/plugin-sdk";
import {
  PostgresRuntimeStore,
  createPostgresCheckpointer,
  createPostgresPool,
} from "@finance-ai-news-agent/storage-postgres";

import { replayResearch } from "./replay-research.js";
import {
  parseRunOptions,
  projectRoot,
  requireDatabaseUrl,
  resolvePersistentOutputPath,
} from "./runtime-command.js";

export const DEFAULT_DEEPSEEK_BASE_URL = "https://api.deepseek.com";
export const DEFAULT_DEEPSEEK_MODEL = "deepseek-v4-flash";
export const DEEPSEEK_THINKING_MODE = "disabled" as const;
export const STRUCTURED_OUTPUT_ATTEMPTS = 2;
export const MODEL_PROVIDER_MAX_RETRIES = 0;

export interface DeepSeekRuntimeConfig {
  apiKey: string;
  baseURL: string;
  model: string;
}

export async function runPersistentAiReplay(args: string[]): Promise<void> {
  const options = parseRunOptions(args, { edition: "ai-replay-v1" });
  const deepSeekConfig = resolveDeepSeekRuntimeConfig(process.env);
  const pool = createPostgresPool({ connectionString: requireDatabaseUrl() });

  try {
    const checkpointer = await createPostgresCheckpointer(pool);
    const store = new PostgresRuntimeStore(pool);
    const model = createDeepSeekModelProvider({
      ...deepSeekConfig,
      thinkingMode: DEEPSEEK_THINKING_MODE,
    });
    const handlers = createModelAgentHandlers({
      model,
      research: replayResearch,
      structuredOutputAttempts: STRUCTURED_OUTPUT_ATTEMPTS,
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
        content: renderAiReplayDigest(state, run),
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
        mode: "ai-replay",
        researchPreset: "synthetic-replay-v1",
      },
      promptVersions: { ...FINANCE_AI_PROMPT_VERSIONS },
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
        `Artifact: ${result.artifact?.id ?? "none"}`,
        `Delivery: ${result.delivery?.status ?? (options.dryRun ? "skipped" : "none")}`,
        "",
      ].join("\n"),
    );
  } finally {
    await pool.end();
  }
}

export function resolveDeepSeekRuntimeConfig(
  environment: Readonly<Record<string, string | undefined>>,
): DeepSeekRuntimeConfig {
  const apiKey = requireEnvironmentValue(environment, "DEEPSEEK_API_KEY");
  const model = environment.DEEPSEEK_MODEL?.trim() || DEFAULT_DEEPSEEK_MODEL;
  const baseURL = (environment.DEEPSEEK_BASE_URL?.trim() || DEFAULT_DEEPSEEK_BASE_URL).replace(
    /\/+$/,
    "",
  );
  let parsed: URL;

  try {
    parsed = new URL(baseURL);
  } catch {
    throw new Error("DEEPSEEK_BASE_URL must be a valid HTTP(S) API root URL.");
  }

  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLoopback(parsed))) {
    throw new Error(
      "DEEPSEEK_BASE_URL must use HTTPS; HTTP is allowed only for a local loopback test server.",
    );
  }

  if (
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    parsed.search.length > 0 ||
    parsed.hash.length > 0
  ) {
    throw new Error(
      "DEEPSEEK_BASE_URL must not contain credentials, query parameters, or fragments.",
    );
  }

  if (parsed.pathname.replace(/\/+$/, "").endsWith("/chat/completions")) {
    throw new Error("DEEPSEEK_BASE_URL must be the API root; remove the /chat/completions suffix.");
  }

  if (hasUnsafeModelCharacter(model)) {
    throw new Error("DEEPSEEK_MODEL must be a single model identifier without whitespace.");
  }

  return { apiKey, baseURL, model };
}

export function createDeepSeekModelSnapshot(config: DeepSeekRuntimeConfig) {
  return {
    provider: "deepseek",
    model: config.model,
    adapter: "ai-sdk",
    adapterVersion: "0.0.0",
    thinkingMode: DEEPSEEK_THINKING_MODE,
    structuredOutput: "json_object+zod",
    structuredOutputAttempts: STRUCTURED_OUTPUT_ATTEMPTS,
    providerMaxRetries: MODEL_PROVIDER_MAX_RETRIES,
    endpointFingerprint: createHash("sha256").update(config.baseURL).digest("hex").slice(0, 16),
  };
}

export function renderAiReplayDigest(state: AgentGraphStateValue, run: RunRecord): string {
  return [
    "# Finance & AI News Agent — DeepSeek Replay",
    "",
    `- Run ID: \`${run.id}\``,
    `- Topic: ${state.topic}`,
    `- Approved: ${state.approved ? "yes" : "no"}`,
    `- Revisions: ${state.revisionCount}`,
    `- Model requests: ${state.modelUsage.requests}`,
    `- Model tokens: ${state.modelUsage.totalTokens}`,
    "",
    state.draft,
    "",
    "### Agent Trace",
    "",
    state.trace.map((node) => `- ${node}`).join("\n"),
    "",
    "> 本次运行调用真实 DeepSeek 模型，但 Research 使用合成回放证据；结果不能视为实时新闻。",
    "",
  ].join("\n");
}

function requireEnvironmentValue(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
): string {
  const value = environment[name]?.trim();

  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required for run-ai. Set it locally; never paste it into chat.`);
  }

  return value;
}

function isLoopback(url: URL): boolean {
  return url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
}

function hasUnsafeModelCharacter(model: string): boolean {
  return [...model].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 32 || codePoint === 127);
  });
}
