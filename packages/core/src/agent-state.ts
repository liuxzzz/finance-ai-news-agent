import { ReducedValue, StateSchema } from "@langchain/langgraph";
import { z } from "zod";

export const AgentEntityIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);

export const EvidenceSchema = z
  .object({
    id: AgentEntityIdSchema,
    title: z.string().min(1).max(300),
    url: z
      .string()
      .url()
      .refine(
        isSafeEvidenceUrl,
        "Evidence URLs must be safe HTTP(S) URLs without credentials or control characters.",
      ),
    excerpt: z.string().min(1).max(4000),
    source: z.string().min(1).max(120).optional(),
    sourceId: z.string().min(1).max(64).optional(),
    publishedAt: z
      .string()
      .refine(
        (value) => Number.isFinite(Date.parse(value)),
        "publishedAt must be a valid date-time.",
      )
      .optional(),
    canonicalUrl: z
      .string()
      .url()
      .refine(isSafeEvidenceUrl, "canonicalUrl must be a safe HTTP(S) URL.")
      .optional(),
    fingerprint: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    titleFingerprint: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    clusterId: AgentEntityIdSchema.optional(),
  })
  .strict();

export type Evidence = z.infer<typeof EvidenceSchema>;

export const StorySchema = z
  .object({
    id: AgentEntityIdSchema,
    headline: z.string().min(1),
    whyItMatters: z.string().min(1),
    evidenceIds: z.array(AgentEntityIdSchema),
  })
  .strict();

export type Story = z.infer<typeof StorySchema>;

export const ReviewRouteSchema = z.enum(["research", "revise"]);

export type ReviewRoute = z.infer<typeof ReviewRouteSchema>;

export const ModelUsageSchema = z.object({
  requests: z.number().int().nonnegative().default(0),
  inputTokens: z.number().int().nonnegative().default(0),
  outputTokens: z.number().int().nonnegative().default(0),
  totalTokens: z.number().int().nonnegative().default(0),
});

export type ModelUsage = z.infer<typeof ModelUsageSchema>;

export const AgentGraphStateValueSchema = z.object({
  runId: z.string(),
  topic: z.string(),
  maxRevisions: z.number().int().nonnegative().default(1),
  plan: z.array(z.string()).default(() => []),
  evidence: z.array(EvidenceSchema).default(() => []),
  stories: z.array(StorySchema).default(() => []),
  draft: z.string().default(""),
  critique: z.string().default(""),
  approved: z.boolean().default(false),
  reviewRoute: ReviewRouteSchema.default("revise"),
  revisionCount: z.number().int().nonnegative().default(0),
  modelUsage: ModelUsageSchema.default(() => ({
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
  })),
  trace: z.array(z.string()).default(() => []),
});

export const AgentGraphState = new StateSchema({
  runId: AgentGraphStateValueSchema.shape.runId,
  topic: AgentGraphStateValueSchema.shape.topic,
  maxRevisions: AgentGraphStateValueSchema.shape.maxRevisions,
  plan: AgentGraphStateValueSchema.shape.plan,
  evidence: AgentGraphStateValueSchema.shape.evidence,
  stories: AgentGraphStateValueSchema.shape.stories,
  draft: AgentGraphStateValueSchema.shape.draft,
  critique: AgentGraphStateValueSchema.shape.critique,
  approved: AgentGraphStateValueSchema.shape.approved,
  reviewRoute: AgentGraphStateValueSchema.shape.reviewRoute,
  revisionCount: AgentGraphStateValueSchema.shape.revisionCount,
  modelUsage: new ReducedValue(AgentGraphStateValueSchema.shape.modelUsage, {
    reducer: (current, update) => ({
      requests: current.requests + update.requests,
      inputTokens: current.inputTokens + update.inputTokens,
      outputTokens: current.outputTokens + update.outputTokens,
      totalTokens: current.totalTokens + update.totalTokens,
    }),
  }),
  trace: new ReducedValue(AgentGraphStateValueSchema.shape.trace, {
    reducer: (current, update) => current.concat(update),
  }),
});

export type AgentGraphStateValue = typeof AgentGraphState.State;
export type AgentGraphStateUpdate = typeof AgentGraphState.Update;

export function isSafeEvidenceUrl(value: string): boolean {
  let parsed: URL;

  try {
    parsed = new URL(value);
  } catch {
    return false;
  }

  return (
    (parsed.protocol === "https:" || parsed.protocol === "http:") &&
    parsed.username.length === 0 &&
    parsed.password.length === 0 &&
    !/[<>\s]/.test(value) &&
    !Array.from(value).some((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f);
    })
  );
}
