import { describe, expect, it } from "vitest";

import { createAgentGraph, type AgentNodeHandlers } from "./index.js";

describe("agent graph", () => {
  it("routes a rejected draft back to curate and write", async () => {
    const handlers: AgentNodeHandlers = {
      research: () => ({
        plan: ["demo"],
        evidence: [],
        trace: ["research"],
      }),
      curateWrite: (state) => ({
        stories: [],
        draft: state.draft ? "approved draft" : "first draft",
        revisionCount: state.draft ? state.revisionCount + 1 : state.revisionCount,
        trace: ["curate_write"],
      }),
      review: (state) => ({
        approved: state.draft === "approved draft",
        reviewRoute: "revise",
        critique: state.draft === "approved draft" ? "ok" : "revise",
        trace: ["review"],
      }),
    };

    const result = await invokeGraph(handlers, "revision-test", 1);

    expect(result.approved).toBe(true);
    expect(result.revisionCount).toBe(1);
    expect(result.trace).toEqual(["research", "curate_write", "review", "curate_write", "review"]);
  });

  it("routes an evidence gap back through research", async () => {
    const handlers: AgentNodeHandlers = {
      research: (state) => ({
        plan: ["demo"],
        evidence: state.draft
          ? [
              {
                id: "evidence-1",
                title: "Evidence",
                url: "https://example.com/evidence",
                excerpt: "Supporting evidence",
              },
            ]
          : [],
        trace: ["research"],
      }),
      curateWrite: (state) => ({
        stories: [],
        draft: state.evidence.length > 0 ? "supported draft" : "unsupported draft",
        revisionCount: state.draft ? state.revisionCount + 1 : state.revisionCount,
        trace: ["curate_write"],
      }),
      review: (state) => ({
        approved: state.evidence.length > 0,
        reviewRoute: "research",
        critique: state.evidence.length > 0 ? "ok" : "more evidence required",
        trace: ["review"],
      }),
    };

    const result = await invokeGraph(handlers, "research-test", 1);

    expect(result.approved).toBe(true);
    expect(result.evidence).toHaveLength(1);
    expect(result.revisionCount).toBe(1);
    expect(result.trace).toEqual([
      "research",
      "curate_write",
      "review",
      "research",
      "curate_write",
      "review",
    ]);
  });

  it("stops an unapproved run when the revision budget is exhausted", async () => {
    const handlers: AgentNodeHandlers = {
      research: () => ({ trace: ["research"] }),
      curateWrite: () => ({ draft: "rejected draft", trace: ["curate_write"] }),
      review: () => ({
        approved: false,
        reviewRoute: "revise",
        critique: "rejected",
        trace: ["review"],
      }),
    };

    const result = await invokeGraph(handlers, "budget-test", 0);

    expect(result.approved).toBe(false);
    expect(result.revisionCount).toBe(0);
    expect(result.trace).toEqual(["research", "curate_write", "review"]);
  });
});

async function invokeGraph(handlers: AgentNodeHandlers, runId: string, maxRevisions: number) {
  const graph = createAgentGraph(handlers);

  return graph.invoke(
    {
      runId,
      topic: "test",
      maxRevisions,
    },
    {
      configurable: {
        thread_id: runId,
      },
    },
  );
}
