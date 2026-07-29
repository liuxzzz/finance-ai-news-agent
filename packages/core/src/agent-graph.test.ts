import { describe, expect, it } from "vitest";

import { createAgentGraph, type AgentRoleHandlers } from "./index.js";

describe("agent graph", () => {
  it("runs the role graph and revises a rejected draft once", async () => {
    const handlers: AgentRoleHandlers = {
      planner: () => ({ plan: ["demo"], trace: ["planner"] }),
      researcher: () => ({ evidence: [], trace: ["researcher"] }),
      curator: () => ({ stories: [], trace: ["curator"] }),
      editor: (state) => ({
        draft: state.draft ? "approved draft" : "first draft",
        revisionCount: state.draft ? state.revisionCount + 1 : state.revisionCount,
        trace: ["editor"],
      }),
      critic: (state) => ({
        approved: state.draft === "approved draft",
        critique: state.draft === "approved draft" ? "ok" : "revise",
        trace: ["critic"],
      }),
      memoryCurator: () => ({
        memoryCandidates: ["demo memory"],
        trace: ["memory_curator"],
      }),
    };

    const graph = createAgentGraph(handlers);
    const result = await graph.invoke(
      {
        runId: "test-run",
        topic: "test",
        maxRevisions: 1,
      },
      {
        configurable: {
          thread_id: "test-run",
        },
      },
    );

    expect(result.approved).toBe(true);
    expect(result.revisionCount).toBe(1);
    expect(result.trace).toEqual([
      "planner",
      "researcher",
      "curator",
      "editor",
      "critic",
      "editor",
      "critic",
      "memory_curator",
    ]);
  });
});
