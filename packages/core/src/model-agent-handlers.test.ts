import {
  StructuredModelOutputError,
  type ModelResponse,
  type PluginManifest,
  type StructuredModelProvider,
  type StructuredModelRequest,
  type StructuredModelResponse,
} from "@finance-ai-news-agent/plugin-sdk";
import { describe, expect, it } from "vitest";

import { createAgentGraph } from "./agent-graph.js";
import type { Evidence } from "./agent-state.js";
import { createModelAgentHandlers, renderCuratedDraft } from "./model-agent-handlers.js";
import { ReviewOutputSchema, type ResearchNodeOutput } from "./model-node-output.js";

const evidence = [
  {
    id: "source-1",
    title: "Replay AI source",
    url: "https://example.com/ai",
    excerpt: "A replay item about an AI infrastructure release.",
  },
  {
    id: "source-2",
    title: "Replay finance source",
    url: "https://example.com/finance",
    excerpt: "A replay item about the financing impact of the release.",
  },
];

describe("model-backed agent handlers", () => {
  it("runs a grounded curate and review loop with deterministic source links", async () => {
    const model = new ReplayStructuredModelProvider([curatedOutput(), approvedReview()]);
    const result = await invoke(model, researchOutput(evidence), 1);

    expect(result.approved).toBe(true);
    expect(result.draft).toContain("[Replay AI source](<https://example.com/ai>)");
    expect(result.draft).toContain("[Replay finance source](<https://example.com/finance>)");
    expect(result.modelUsage).toEqual({
      requests: 2,
      inputTokens: 200,
      outputTokens: 80,
      totalTokens: 280,
    });
    expect(result.trace).toEqual(["research", "curate_write", "review"]);
    expect(model.calls.map((call) => call.role)).toEqual(["curate_write", "review"]);
  });

  it("applies review feedback and increments the deterministic revision count", async () => {
    const model = new ReplayStructuredModelProvider([
      curatedOutput("Initial headline"),
      reviseReview(),
      curatedOutput("Revised headline"),
      approvedReview(),
    ]);
    const result = await invoke(model, researchOutput(evidence), 1);

    expect(result.approved).toBe(true);
    expect(result.revisionCount).toBe(1);
    expect(result.draft).toContain("Revised headline");
    expect(model.calls[2]?.prompt).toContain("标题需要更准确");
    expect(result.trace).toEqual(["research", "curate_write", "review", "curate_write", "review"]);
  });

  it("retries schema-invalid evidence references once", async () => {
    const invalid = curatedOutput();
    invalid.stories[0]!.evidenceIds = ["unknown-source"];
    const model = new ReplayStructuredModelProvider([invalid, curatedOutput(), approvedReview()]);
    const result = await invoke(model, researchOutput(evidence), 1);

    expect(result.approved).toBe(true);
    expect(result.modelUsage.requests).toBe(3);
    expect(result.modelUsage.totalTokens).toBe(420);
    expect(model.calls[1]?.prompt).toContain("RECOVERY_INSTRUCTION");
  });

  it("rejects an empty research corpus without calling the model", async () => {
    const model = new ReplayStructuredModelProvider([]);
    const result = await invoke(model, researchOutput([]), 0);

    expect(result.approved).toBe(false);
    expect(result.reviewRoute).toBe("research");
    expect(result.stories).toEqual([]);
    expect(result.modelUsage.requests).toBe(0);
    expect(model.calls).toEqual([]);
  });

  it("never renders non-http evidence links", () => {
    expect(() =>
      renderCuratedDraft("test", curatedOutput(), [
        {
          id: "source-1",
          title: "unsafe",
          url: "javascript:alert(1)",
          excerpt: "unsafe",
        },
        evidence[1]!,
      ]),
    ).toThrow("not a safe HTTP(S) source URL");
  });

  it("rejects duplicate evidence IDs before calling the model", async () => {
    const model = new ReplayStructuredModelProvider([]);

    await expect(
      invoke(
        model,
        researchOutput([evidence[0]!, { ...evidence[0]!, url: "https://example.com/duplicate" }]),
        1,
      ),
    ).rejects.toThrow("evidence IDs must not contain duplicate values");
    expect(model.calls).toEqual([]);
  });

  it("rejects a revise decision that actually asks for more research", () => {
    const contradictory = reviseReview();
    contradictory.issues[0]!.action = "research";

    expect(() => ReviewOutputSchema.parse(contradictory)).toThrow(
      "A revise decision cannot contain research actions",
    );
  });
});

class ReplayStructuredModelProvider implements StructuredModelProvider {
  readonly manifest: PluginManifest = {
    id: "replay-model",
    name: "Replay model",
    version: "1.0.0",
    kind: "model",
    coreCompatibility: ">=0.0.0",
  };

  readonly calls: Array<{ role: string; prompt: string }> = [];

  constructor(private readonly responses: unknown[]) {}

  generate(): Promise<ModelResponse> {
    throw new Error("Text generation is not used by model-backed handlers.");
  }

  async generateStructured<OUTPUT>(
    request: StructuredModelRequest<OUTPUT>,
  ): Promise<StructuredModelResponse<OUTPUT>> {
    this.calls.push({ role: request.role, prompt: request.prompt });
    const response = this.responses.shift();

    if (response === undefined) {
      throw new Error("Replay response queue is empty.");
    }

    if (response instanceof Error) {
      throw response;
    }

    try {
      return {
        value: request.schema.parse(response),
        model: "replay-model",
        finishReason: "stop",
        usage: {
          inputTokens: 100,
          outputTokens: 40,
          totalTokens: 140,
        },
      };
    } catch (error) {
      throw new StructuredModelOutputError("Replay response did not satisfy the schema.", {
        cause: error,
        usage: {
          inputTokens: 100,
          outputTokens: 40,
          totalTokens: 140,
        },
      });
    }
  }
}

function researchOutput(items: Evidence[]): ResearchNodeOutput {
  return {
    schemaVersion: "research.v1",
    plan: ["Review the supplied replay evidence."],
    evidence: items,
  };
}

function curatedOutput(headline = "AI infrastructure financing changes"): {
  schemaVersion: "curate_write.v1";
  stories: Array<{
    id: string;
    category: "ai";
    headline: string;
    summary: string;
    whyItMatters: string;
    evidenceIds: string[];
  }>;
} {
  return {
    schemaVersion: "curate_write.v1",
    stories: [
      {
        id: "story-1",
        category: "ai",
        headline,
        summary:
          "The supplied sources describe an infrastructure release and its financing impact.",
        whyItMatters: "It connects AI infrastructure decisions with capital allocation.",
        evidenceIds: ["source-1", "source-2"],
      },
    ],
  };
}

function approvedReview() {
  return {
    schemaVersion: "review.v1",
    decision: "approve",
    summary: "内容有据可查，可以发布。",
    issues: [],
    missingEvidenceQueries: [],
  };
}

function reviseReview() {
  return {
    schemaVersion: "review.v1",
    decision: "revise",
    summary: "标题需要更准确。",
    issues: [
      {
        id: "issue-1",
        severity: "major",
        code: "misleading_headline",
        action: "revise",
        storyId: "story-1",
        evidenceIds: ["source-1"],
        message: "标题需要更准确。",
        requiredChange: "使用证据能够直接支持的标题。",
      },
    ],
    missingEvidenceQueries: [],
  };
}

async function invoke(
  model: ReplayStructuredModelProvider,
  research: ResearchNodeOutput,
  maxRevisions: number,
) {
  const handlers = createModelAgentHandlers({
    model,
    research: () => research,
  });
  const graph = createAgentGraph(handlers);

  return graph.invoke(
    {
      runId: "model-handler-test",
      topic: "Finance & AI",
      maxRevisions,
    },
    {
      configurable: {
        thread_id: `model-handler-test-${crypto.randomUUID()}`,
      },
    },
  );
}
