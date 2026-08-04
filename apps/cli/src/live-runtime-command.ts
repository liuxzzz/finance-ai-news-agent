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
import { FeishuWebhookOutputPlugin } from "@finance-ai-news-agent/output-feishu";
import { FileOutputPlugin } from "@finance-ai-news-agent/output-file";
import type { RunRecord } from "@finance-ai-news-agent/plugin-sdk";
import { RssNewsGateway, validateRssFeedUrl } from "@finance-ai-news-agent/source-rss";
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
  feedUrls: string[];
  timeoutMs: number;
  maxToolCalls: number;
  maxItemAgeHours: number;
  maxExcerptChars: number;
  maxEvidence: number;
  maxCandidateEvidence: number;
  historyLookbackDays: number;
}

export const DEFAULT_RSS_FEED_URLS = [
  "https://36kr.com/feed",
  "https://rss.huxiu.com/",
  "https://www.infoq.cn/feed",
] as const;

export type AgentOutputChannel = "file" | "feishu";

export async function runPersistentAiLive(args: string[]): Promise<void> {
  const options = parseRunOptions(args, { edition: "daily" });
  const deepSeekConfig = resolveDeepSeekRuntimeConfig(process.env);
  const researchConfig = resolveLiveResearchConfig(process.env);
  const pool = createPostgresPool({ connectionString: requireDatabaseUrl() });

  try {
    const checkpointer = await createPostgresCheckpointer(pool);
    const store = new PostgresRuntimeStore(pool);
    const gateway = new RssNewsGateway({
      feeds: researchConfig.feedUrls.map((url, index) => ({
        id: `feed-${index + 1}`,
        url,
      })),
      timeoutMs: researchConfig.timeoutMs,
      maxItemAgeHours: researchConfig.maxItemAgeHours,
      maxExcerptChars: researchConfig.maxExcerptChars,
      minimumResultCount: researchConfig.maxCandidateEvidence,
      sourceAudit: store,
    });
    const model = createDeepSeekModelProvider({
      ...deepSeekConfig,
      thinkingMode: DEEPSEEK_THINKING_MODE,
    });
    const research = createToolCallingResearchProvider({
      model,
      gateway,
      modelCallLedger: store,
      contentStore: store,
      maxModelRequests: MAX_MODEL_REQUESTS_PER_RUN,
      maxToolCalls: researchConfig.maxToolCalls,
      maxEvidence: researchConfig.maxEvidence,
      maxCandidateEvidence: researchConfig.maxCandidateEvidence,
      historyLookbackDays: researchConfig.historyLookbackDays,
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
    const outputChannel = resolveOutputChannel(process.env);
    const feishuWebhookUrl = process.env.FEISHU_BOT_WEBHOOK_URL?.trim();
    const output =
      outputChannel === "file"
        ? new FileOutputPlugin(outputPath)
        : new FeishuWebhookOutputPlugin({
            webhookUrl: feishuWebhookUrl!,
            ...(process.env.FEISHU_BOT_SIGNING_SECRET === undefined
              ? {}
              : { signingSecret: process.env.FEISHU_BOT_SIGNING_SECRET }),
          });
    const deliveryTarget = output instanceof FeishuWebhookOutputPlugin ? output.target : outputPath;
    const runtime = new RunExecutor({
      store,
      workflow: new LangGraphAgentWorkflow(graph),
      renderArtifact: (state, run) => ({
        mediaType: "text/markdown",
        content: renderLiveDigest(state, run),
      }),
      output,
      deliveryTarget,
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
        researchPreset: "rss-function-calling-v1",
        rssFeedFingerprint: createHash("sha256")
          .update(researchConfig.feedUrls.join("\n"))
          .digest("hex")
          .slice(0, 16),
        rssFeedCount: researchConfig.feedUrls.length,
        rssTimeoutMs: researchConfig.timeoutMs,
        rssMaxItemAgeHours: researchConfig.maxItemAgeHours,
        rssMaxExcerptChars: researchConfig.maxExcerptChars,
        rssMaxEvidence: researchConfig.maxEvidence,
        rssMaxCandidateEvidence: researchConfig.maxCandidateEvidence,
        historyLookbackDays: researchConfig.historyLookbackDays,
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
    await pool.end();
  }
}

export function resolveOutputChannel(
  environment: Readonly<Record<string, string | undefined>>,
): AgentOutputChannel {
  const configured = environment.AGENT_OUTPUT_CHANNEL?.trim().toLocaleLowerCase("en-US");
  const webhook = environment.FEISHU_BOT_WEBHOOK_URL?.trim();
  const channel =
    configured === undefined || configured.length === 0
      ? webhook
        ? "feishu"
        : "file"
      : configured;

  if (channel !== "file" && channel !== "feishu") {
    throw new Error("AGENT_OUTPUT_CHANNEL must be file or feishu.");
  }

  if (channel === "feishu" && (webhook === undefined || webhook.length === 0)) {
    throw new Error("FEISHU_BOT_WEBHOOK_URL is required when AGENT_OUTPUT_CHANNEL=feishu.");
  }

  return channel;
}

export function resolveLiveResearchConfig(
  environment: Readonly<Record<string, string | undefined>>,
): LiveResearchConfig {
  const feedUrls = (environment.RSS_FEED_URLS?.trim() || DEFAULT_RSS_FEED_URLS.join(","))
    .split(",")
    .map((url) => url.trim())
    .filter((url) => url.length > 0)
    .map((url) => validateRssFeedUrl(url).toString());

  if (feedUrls.length === 0 || feedUrls.length > 16 || new Set(feedUrls).size !== feedUrls.length) {
    throw new Error("RSS_FEED_URLS must contain 1 to 16 unique comma-separated feed URLs.");
  }

  const timeoutText = environment.RSS_TIMEOUT_MS?.trim() || "5000";
  const timeoutMs = Number(timeoutText);

  if (
    !/^\d+$/.test(timeoutText) ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 500 ||
    timeoutMs > 30_000
  ) {
    throw new Error("RSS_TIMEOUT_MS must be an integer from 500 to 30000.");
  }

  const maxToolCallsText = environment.RSS_MAX_TOOL_CALLS?.trim() || "1";
  const maxToolCalls = Number(maxToolCallsText);

  if (
    !/^\d+$/.test(maxToolCallsText) ||
    !Number.isSafeInteger(maxToolCalls) ||
    maxToolCalls <= 0 ||
    maxToolCalls > 16
  ) {
    throw new Error("RSS_MAX_TOOL_CALLS must be an integer from 1 to 16.");
  }

  const maxItemAgeHours = numericEnvironmentValue(
    environment,
    "RSS_MAX_ITEM_AGE_HOURS",
    48,
    1,
    168,
  );
  const maxExcerptChars = numericEnvironmentValue(
    environment,
    "RSS_MAX_EXCERPT_CHARS",
    600,
    100,
    4_000,
  );
  const maxEvidence = numericEnvironmentValue(environment, "RSS_MAX_EVIDENCE", 12, 1, 24);
  const maxCandidateEvidence = numericEnvironmentValue(
    environment,
    "RSS_MAX_CANDIDATE_EVIDENCE",
    Math.min(24, maxEvidence * 2),
    maxEvidence,
    24,
  );
  const historyLookbackDays = numericEnvironmentValue(
    environment,
    "HISTORY_DEDUP_LOOKBACK_DAYS",
    7,
    1,
    365,
  );

  return {
    feedUrls,
    timeoutMs,
    maxToolCalls,
    maxItemAgeHours,
    maxExcerptChars,
    maxEvidence,
    maxCandidateEvidence,
    historyLookbackDays,
  };
}

function numericEnvironmentValue(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const text = environment[name]?.trim() || String(fallback);
  const value = Number(text);

  if (!/^\d+$/.test(text) || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}.`);
  }

  return value;
}

function renderLiveDigest(state: AgentGraphStateValue, run: RunRecord): string {
  return [
    "# Finance & AI News Agent — Live RSS Research",
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
    "> Research 通过内部只读工具直接抓取配置的 RSS；每条链接均来自通过 Schema 校验的 Feed Evidence。",
    "",
  ].join("\n");
}
