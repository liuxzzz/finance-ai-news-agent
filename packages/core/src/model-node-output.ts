import { z } from "zod";

import { EvidenceSchema, ModelUsageSchema } from "./agent-state.js";

const StableIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);

const PlainTextSchema = z
  .string()
  .min(1)
  .refine((value) => !/https?:\/\//i.test(value), "Model-generated URLs are not allowed.");

export const ResearchNodeOutputSchema = z
  .object({
    schemaVersion: z.literal("research.v1"),
    plan: z.array(z.string().min(1).max(200)).min(1).max(6),
    evidence: z.array(EvidenceSchema).max(24),
    modelUsage: ModelUsageSchema.default(() => ({
      requests: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    })),
  })
  .strict()
  .superRefine((value, context) => {
    addDuplicateIssues(
      value.evidence.map((evidence) => evidence.id),
      "evidence IDs",
      context,
    );
  });

export type ResearchNodeOutput = z.infer<typeof ResearchNodeOutputSchema>;

export const CuratedStoryOutputSchema = z
  .object({
    id: StableIdSchema,
    category: z.enum(["ai", "markets", "companies", "policy", "research", "other"]),
    headline: PlainTextSchema.max(100),
    summary: PlainTextSchema.max(420),
    whyItMatters: PlainTextSchema.max(240),
    evidenceIds: z.array(StableIdSchema).min(1).max(5),
  })
  .strict();

export const CurateWriteOutputSchema = z
  .object({
    schemaVersion: z.literal("curate_write.v1"),
    stories: z.array(CuratedStoryOutputSchema).min(1).max(6),
  })
  .strict()
  .superRefine((value, context) => {
    addDuplicateIssues(
      value.stories.map((story) => story.id),
      "stories",
      context,
    );

    const headlines = value.stories.map((story) =>
      story.headline.trim().toLocaleLowerCase("zh-CN"),
    );
    addDuplicateIssues(headlines, "headlines", context);

    for (const [storyIndex, story] of value.stories.entries()) {
      addDuplicateIssues(story.evidenceIds, `stories.${storyIndex}.evidenceIds`, context);
    }
  });

export type CurateWriteOutput = z.infer<typeof CurateWriteOutputSchema>;

export const ReviewIssueSchema = z
  .object({
    id: StableIdSchema,
    severity: z.enum(["blocker", "major", "minor"]),
    code: z.enum([
      "unsupported_claim",
      "citation_mismatch",
      "missing_evidence",
      "material_omission",
      "duplicate_story",
      "stale_evidence",
      "misleading_headline",
      "poor_relevance",
      "format",
      "language",
    ]),
    action: z.enum(["research", "revise"]),
    storyId: StableIdSchema.nullable(),
    evidenceIds: z.array(StableIdSchema).max(5),
    message: z.string().min(1).max(300),
    requiredChange: z.string().min(1).max(300),
  })
  .strict();

export const ReviewOutputSchema = z
  .object({
    schemaVersion: z.literal("review.v1"),
    decision: z.enum(["approve", "research", "revise"]),
    summary: z.string().min(1).max(500),
    issues: z.array(ReviewIssueSchema).max(12),
    missingEvidenceQueries: z.array(z.string().min(1).max(160)).max(5),
  })
  .strict()
  .superRefine((value, context) => {
    addDuplicateIssues(
      value.issues.map((issue) => issue.id),
      "issues",
      context,
    );

    const materialIssues = value.issues.filter((issue) => issue.severity !== "minor");

    if (
      value.decision === "approve" &&
      (materialIssues.length > 0 || value.missingEvidenceQueries.length > 0)
    ) {
      context.addIssue({
        code: "custom",
        message: "An approved review cannot contain material issues or missing-evidence queries.",
      });
    }

    if (
      value.decision === "research" &&
      !value.issues.some((issue) => issue.action === "research" && issue.severity !== "minor")
    ) {
      context.addIssue({
        code: "custom",
        message: "A research decision requires a material research issue.",
      });
    }

    if (value.decision === "revise") {
      if (value.issues.length === 0) {
        context.addIssue({
          code: "custom",
          message: "A revise decision requires at least one issue.",
        });
      }

      if (value.issues.some((issue) => issue.action !== "revise")) {
        context.addIssue({
          code: "custom",
          message: "A revise decision cannot contain research actions.",
        });
      }
    }
  });

export type ReviewOutput = z.infer<typeof ReviewOutputSchema>;

export function curateWriteOutputSchemaForEvidence(evidenceIds: ReadonlySet<string>) {
  return CurateWriteOutputSchema.superRefine((value, context) => {
    for (const [storyIndex, story] of value.stories.entries()) {
      for (const [evidenceIndex, evidenceId] of story.evidenceIds.entries()) {
        if (!evidenceIds.has(evidenceId)) {
          context.addIssue({
            code: "custom",
            message: `Unknown evidence ID: ${evidenceId}`,
            path: ["stories", storyIndex, "evidenceIds", evidenceIndex],
          });
        }
      }
    }
  });
}

export function reviewOutputSchemaForState(
  storyIds: ReadonlySet<string>,
  evidenceIds: ReadonlySet<string>,
) {
  return ReviewOutputSchema.superRefine((value, context) => {
    for (const [issueIndex, issue] of value.issues.entries()) {
      if (issue.storyId !== null && !storyIds.has(issue.storyId)) {
        context.addIssue({
          code: "custom",
          message: `Unknown story ID: ${issue.storyId}`,
          path: ["issues", issueIndex, "storyId"],
        });
      }

      for (const [evidenceIndex, evidenceId] of issue.evidenceIds.entries()) {
        if (!evidenceIds.has(evidenceId)) {
          context.addIssue({
            code: "custom",
            message: `Unknown evidence ID: ${evidenceId}`,
            path: ["issues", issueIndex, "evidenceIds", evidenceIndex],
          });
        }
      }
    }
  });
}

function addDuplicateIssues(values: string[], field: string, context: z.RefinementCtx): void {
  if (new Set(values).size !== values.length) {
    context.addIssue({
      code: "custom",
      message: `${field} must not contain duplicate values.`,
    });
  }
}
