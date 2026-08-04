import { describe, expect, it, vi } from "vitest";

import { createAgentGraph, LangGraphAgentWorkflow, type AgentNodeHandlers } from "./index.js";

describe("langgraph agent workflow", () => {
  it("resumes a failed graph from its durable checkpoint instead of rerunning prior nodes", async () => {
    let shouldFail = true;
    const research = vi.fn(() => ({ plan: ["research"], trace: ["research"] }));
    const curateWrite = vi.fn(() => {
      if (shouldFail) {
        shouldFail = false;
        throw new Error("temporary model failure");
      }

      return { draft: "supported draft", trace: ["curate_write"] };
    });
    const review = vi.fn(() => ({
      approved: true,
      critique: "ok",
      trace: ["review"],
    }));
    const handlers: AgentNodeHandlers = { research, curateWrite, review };
    const workflow = new LangGraphAgentWorkflow(createAgentGraph(handlers));
    const input = { runId: "resume-test", topic: "test", maxRevisions: 1 };

    await expect(workflow.start(input)).rejects.toThrow("temporary model failure");
    const recovered = await workflow.resume(input);

    expect(recovered.approved).toBe(true);
    expect(recovered.trace).toEqual(["research", "curate_write", "review"]);
    expect(research).toHaveBeenCalledTimes(1);
    expect(curateWrite).toHaveBeenCalledTimes(2);
    expect(review).toHaveBeenCalledTimes(1);
  });
});
