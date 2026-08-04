import { createHash, randomUUID } from "node:crypto";

import {
  StructuredModelOutputError,
  type ModelCallRecord,
  type RuntimeStore,
  type SerializedError,
  type StructuredModelProvider,
  type StructuredModelRequest,
  type StructuredModelResponse,
} from "@finance-ai-news-agent/plugin-sdk";

import type { AgentNodeHandlers } from "./agent-graph.js";
import {
  isSafeEvidenceUrl,
  type AgentGraphStateValue,
  type Evidence,
  type ModelUsage,
  type Story,
} from "./agent-state.js";
import { CURATE_WRITE_PROMPT_V1, REVIEW_PROMPT_V1 } from "./finance-ai-prompts.js";
import {
  ResearchNodeOutputSchema,
  curateWriteOutputSchemaForEvidence,
  reviewOutputSchemaForState,
  type CurateWriteOutput,
  type ResearchNodeOutput,
  type ReviewOutput,
} from "./model-node-output.js";

export type ResearchProvider = (
  state: AgentGraphStateValue,
) => ResearchNodeOutput | Promise<ResearchNodeOutput>;

export interface CreateModelAgentHandlersOptions {
  model: StructuredModelProvider;
  research: ResearchProvider;
  modelCallLedger?: ModelCallLedger;
  structuredOutputAttempts?: number;
  timeoutMs?: number;
  maxModelRequests?: number;
  now?: () => Date;
  generateId?: () => string;
}

export type ModelCallLedger = Pick<
  RuntimeStore,
  "startModelCall" | "completeModelCall" | "failModelCall"
>;

export class ModelRequestBudgetExceededError extends Error {
  override readonly name = "ModelRequestBudgetExceededError";
}

export function createModelAgentHandlers(
  options: CreateModelAgentHandlersOptions,
): AgentNodeHandlers {
  const structuredOutputAttempts = requirePositiveInteger(
    options.structuredOutputAttempts ?? 2,
    "structuredOutputAttempts",
  );
  const timeoutMs = requirePositiveInteger(options.timeoutMs ?? 60_000, "timeoutMs");
  const maxModelRequests = requirePositiveInteger(
    options.maxModelRequests ?? 8,
    "maxModelRequests",
  );
  const now = options.now ?? (() => new Date());
  const generateId = options.generateId ?? randomUUID;

  return {
    research: async (state) => {
      const output = ResearchNodeOutputSchema.parse(await options.research(state));

      return {
        plan: output.plan,
        evidence: output.evidence,
        modelUsage: output.modelUsage,
        trace: ["research"],
      };
    },

    curateWrite: async (state) => {
      const revisionCount = state.draft.length > 0 ? state.revisionCount + 1 : state.revisionCount;

      if (state.evidence.length === 0) {
        return {
          stories: [],
          draft: "",
          revisionCount,
          trace: ["curate_write"],
        };
      }

      const attempts = remainingAttempts(state, maxModelRequests, structuredOutputAttempts);
      const evidenceIds = new Set(state.evidence.map((evidence) => evidence.id));
      const generated = await generateWithRecovery({
        provider: options.model,
        ledger: options.modelCallLedger,
        runId: state.runId,
        maxModelRequests,
        now,
        generateId,
        attempts,
        request: {
          role: "curate_write",
          system: CURATE_WRITE_PROMPT_V1.system,
          prompt: CURATE_WRITE_PROMPT_V1.renderUser(state),
          schema: curateWriteOutputSchemaForEvidence(evidenceIds),
          schemaName: "finance_ai_curate_write_v1",
          schemaDescription: "Evidence-grounded Finance and AI digest stories.",
          maxOutputTokens: CURATE_WRITE_PROMPT_V1.maxOutputTokens,
          temperature: CURATE_WRITE_PROMPT_V1.temperature,
          timeoutMs,
          // Keep one logical model request equal to one HTTP request for auditable budgets.
          maxRetries: 0,
        },
      });
      const stories = mapStories(generated.response.value);

      return {
        stories,
        draft: renderCuratedDraft(state.topic, generated.response.value, state.evidence),
        revisionCount,
        modelUsage: modelUsage(generated),
        trace: ["curate_write"],
      };
    },

    review: async (state) => {
      if (state.evidence.length === 0 || state.stories.length === 0 || state.draft.length === 0) {
        return {
          approved: false,
          reviewRoute: "research",
          critique: "没有可审核的证据化内容，需要补充研究来源。",
          trace: ["review"],
        };
      }

      assertStoryReferences(state.stories, state.evidence);
      const attempts = remainingAttempts(state, maxModelRequests, structuredOutputAttempts);
      const generated = await generateWithRecovery({
        provider: options.model,
        ledger: options.modelCallLedger,
        runId: state.runId,
        maxModelRequests,
        now,
        generateId,
        attempts,
        request: {
          role: "review",
          system: REVIEW_PROMPT_V1.system,
          prompt: REVIEW_PROMPT_V1.renderUser(state),
          schema: reviewOutputSchemaForState(
            new Set(state.stories.map((story) => story.id)),
            new Set(state.evidence.map((evidence) => evidence.id)),
          ),
          schemaName: "finance_ai_review_v1",
          schemaDescription: "A grounded editorial decision with actionable review issues.",
          maxOutputTokens: REVIEW_PROMPT_V1.maxOutputTokens,
          temperature: REVIEW_PROMPT_V1.temperature,
          timeoutMs,
          // Runtime recovery handles transport failures; hidden provider retries would undercount.
          maxRetries: 0,
        },
      });
      const review = generated.response.value;

      return {
        approved: review.decision === "approve",
        reviewRoute: review.decision === "research" ? "research" : "revise",
        critique: renderCritique(review),
        modelUsage: modelUsage(generated),
        trace: ["review"],
      };
    },
  };
}

export function renderCuratedDraft(
  topic: string,
  output: CurateWriteOutput,
  evidence: Evidence[],
): string {
  const evidenceById = new Map(evidence.map((item) => [item.id, item]));
  const lines = [`# ${escapeMarkdownText(topic)}`, ""];

  for (const story of output.stories) {
    lines.push(`## ${escapeMarkdownText(story.headline)}`, "");
    lines.push(escapeMarkdownText(story.summary), "");
    lines.push(`**为什么重要：** ${escapeMarkdownText(story.whyItMatters)}`, "");
    lines.push("**来源：**");

    for (const evidenceId of story.evidenceIds) {
      const source = evidenceById.get(evidenceId);

      if (source === undefined) {
        throw new Error(`Cannot render unknown evidence ID ${evidenceId}.`);
      }

      assertSafeSourceUrl(source.url);
      lines.push(`- [${escapeMarkdownText(source.title)}](<${source.url}>) \`${source.id}\``);
    }

    lines.push("");
  }

  return lines.join("\n").trimEnd();
}

interface GenerateWithRecoveryOptions<OUTPUT> {
  provider: StructuredModelProvider;
  ledger: ModelCallLedger | undefined;
  runId: string;
  maxModelRequests: number;
  now: () => Date;
  generateId: () => string;
  request: StructuredModelRequest<OUTPUT>;
  attempts: number;
}

interface GeneratedWithAttempts<OUTPUT> {
  response: StructuredModelResponse<OUTPUT>;
  attempts: number;
  usage: ModelUsageTotals;
}

interface ModelUsageTotals {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

async function generateWithRecovery<OUTPUT>(
  options: GenerateWithRecoveryOptions<OUTPUT>,
): Promise<GeneratedWithAttempts<OUTPUT>> {
  const originalPrompt = options.request.prompt;
  let usage = emptyUsage();

  for (let attempt = 1; attempt <= options.attempts; attempt += 1) {
    const prompt =
      attempt === 1
        ? originalPrompt
        : [
            originalPrompt,
            "",
            "RECOVERY_INSTRUCTION:",
            "上一次响应为空、被截断、不是有效 JSON，或没有通过 Schema/引用校验。",
            "请重新生成完整 JSON 对象；不得解释错误，不得沿用未知 ID。",
          ].join("\n");
    const call = await startDurableModelCall(options, prompt);

    try {
      const response = await options.provider.generateStructured({
        ...options.request,
        prompt,
      });

      await completeDurableModelCall(options, call, response);
      usage = addUsage(usage, response.usage);
      return { response, attempts: attempt, usage };
    } catch (error) {
      await failDurableModelCall(options, call, error);

      if (error instanceof StructuredModelOutputError) {
        usage = addUsage(usage, error.usage);
      }

      if (!(error instanceof StructuredModelOutputError) || attempt === options.attempts) {
        throw error;
      }
    }
  }

  throw new Error("Structured generation exhausted without returning a result.");
}

async function startDurableModelCall<OUTPUT>(
  options: GenerateWithRecoveryOptions<OUTPUT>,
  prompt: string,
): Promise<ModelCallRecord | null> {
  if (options.ledger === undefined) {
    return null;
  }

  const startedAt = options.now().toISOString();
  const reservation = await options.ledger.startModelCall({
    id: options.generateId(),
    runId: options.runId,
    role: options.request.role,
    providerId: options.provider.manifest.id,
    requestHash: modelRequestHash(options.request, prompt),
    maxRequests: options.maxModelRequests,
    startedAt,
  });

  if (!reservation.accepted) {
    throw new ModelRequestBudgetExceededError(
      `The run exhausted its durable model request budget of ${options.maxModelRequests} ` +
        `(${reservation.usedRequests} requests already reserved).`,
    );
  }

  return reservation.call;
}

async function completeDurableModelCall<OUTPUT>(
  options: GenerateWithRecoveryOptions<OUTPUT>,
  call: ModelCallRecord | null,
  response: StructuredModelResponse<OUTPUT>,
): Promise<void> {
  if (options.ledger === undefined || call === null) {
    return;
  }

  const usage = usageTotals(response.usage);
  await options.ledger.completeModelCall({
    callId: call.id,
    model: response.model,
    finishReason: response.finishReason,
    ...usage,
    finishedAt: options.now().toISOString(),
  });
}

async function failDurableModelCall<OUTPUT>(
  options: GenerateWithRecoveryOptions<OUTPUT>,
  call: ModelCallRecord | null,
  error: unknown,
): Promise<void> {
  if (options.ledger === undefined || call === null) {
    return;
  }

  const usage = usageTotals(error instanceof StructuredModelOutputError ? error.usage : undefined);

  try {
    await options.ledger.failModelCall({
      callId: call.id,
      error: serializeModelError(error),
      ...usage,
      finishedAt: options.now().toISOString(),
    });
  } catch (ledgerError) {
    throw new AggregateError(
      [error, ledgerError],
      `Model call ${call.id} failed and its durable ledger could not be finalized.`,
      { cause: ledgerError },
    );
  }
}

function modelRequestHash<OUTPUT>(request: StructuredModelRequest<OUTPUT>, prompt: string): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        role: request.role,
        system: request.system,
        prompt,
        schemaName: request.schemaName,
        schemaDescription: request.schemaDescription ?? null,
        maxOutputTokens: request.maxOutputTokens ?? null,
        temperature: request.temperature ?? null,
        timeoutMs: request.timeoutMs ?? null,
        maxRetries: request.maxRetries ?? null,
      }),
    )
    .digest("hex");
}

function usageTotals(
  usage:
    | {
        inputTokens?: number;
        outputTokens?: number;
        totalTokens?: number;
      }
    | undefined,
): ModelUsageTotals {
  const inputTokens = usage?.inputTokens ?? 0;
  const outputTokens = usage?.outputTokens ?? 0;
  return {
    inputTokens,
    outputTokens,
    totalTokens: usage?.totalTokens ?? inputTokens + outputTokens,
  };
}

function serializeModelError(error: unknown): SerializedError {
  return {
    name: error instanceof Error ? error.name : "Error",
    message: error instanceof Error ? error.message : String(error),
  };
}

function remainingAttempts(
  state: AgentGraphStateValue,
  maxModelRequests: number,
  structuredOutputAttempts: number,
): number {
  const remaining = maxModelRequests - state.modelUsage.requests;

  if (remaining <= 0) {
    throw new ModelRequestBudgetExceededError(
      `The run exhausted its model request budget of ${maxModelRequests}.`,
    );
  }

  return Math.min(remaining, structuredOutputAttempts);
}

function mapStories(output: CurateWriteOutput): Story[] {
  return output.stories.map((story) => ({
    id: story.id,
    headline: story.headline,
    whyItMatters: story.whyItMatters,
    evidenceIds: story.evidenceIds,
  }));
}

function modelUsage<OUTPUT>(generated: GeneratedWithAttempts<OUTPUT>): ModelUsage {
  return {
    requests: generated.attempts,
    ...generated.usage,
  };
}

function emptyUsage(): ModelUsageTotals {
  return { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
}

function addUsage(
  current: ModelUsageTotals,
  next:
    | {
        inputTokens?: number;
        outputTokens?: number;
        totalTokens?: number;
      }
    | undefined,
): ModelUsageTotals {
  const inputTokens = next?.inputTokens ?? 0;
  const outputTokens = next?.outputTokens ?? 0;

  return {
    inputTokens: current.inputTokens + inputTokens,
    outputTokens: current.outputTokens + outputTokens,
    totalTokens: current.totalTokens + (next?.totalTokens ?? inputTokens + outputTokens),
  };
}

function assertStoryReferences(stories: Story[], evidence: Evidence[]): void {
  const evidenceIds = new Set(evidence.map((item) => item.id));

  for (const story of stories) {
    if (story.evidenceIds.length === 0) {
      throw new Error(`Story ${story.id} has no evidence references.`);
    }

    for (const evidenceId of story.evidenceIds) {
      if (!evidenceIds.has(evidenceId)) {
        throw new Error(`Story ${story.id} references unknown evidence ${evidenceId}.`);
      }
    }
  }
}

function renderCritique(review: ReviewOutput): string {
  return [
    review.summary,
    ...review.issues.map(
      (issue) =>
        `[${issue.severity}/${issue.code}] ${issue.message}；要求：${issue.requiredChange}`,
    ),
    ...review.missingEvidenceQueries.map((query) => `补证查询：${query}`),
  ].join("\n");
}

function assertSafeSourceUrl(url: string): void {
  if (!isSafeEvidenceUrl(url)) {
    throw new Error("Evidence URL is not a safe HTTP(S) source URL.");
  }
}

function escapeMarkdownText(value: string): string {
  return value
    .replaceAll(/\s+/g, " ")
    .trim()
    .replaceAll(/([\\`*_[\]<>])/g, "\\$1");
}

function requirePositiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }

  return value;
}
