import { ReducedValue, StateSchema } from "@langchain/langgraph";
import { z } from "zod";

export const EvidenceSchema = z.object({
  id: z.string(),
  title: z.string(),
  url: z.string(),
  excerpt: z.string(),
});

export type Evidence = z.infer<typeof EvidenceSchema>;

export const StorySchema = z.object({
  id: z.string(),
  headline: z.string(),
  whyItMatters: z.string(),
  evidenceIds: z.array(z.string()),
});

export type Story = z.infer<typeof StorySchema>;

export const ReviewRouteSchema = z.enum(["research", "revise"]);

export type ReviewRoute = z.infer<typeof ReviewRouteSchema>;

export const AgentGraphState = new StateSchema({
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
  trace: new ReducedValue(
    z.array(z.string()).default(() => []),
    {
      reducer: (current, update) => current.concat(update),
    },
  ),
});

export type AgentGraphStateValue = typeof AgentGraphState.State;
export type AgentGraphStateUpdate = typeof AgentGraphState.Update;
