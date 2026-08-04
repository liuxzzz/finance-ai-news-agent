import type {
  McpGateway,
  ModelResponse,
  PluginManifest,
  ToolCallingModelProvider,
  ToolCallingModelRequest,
  ToolCallingModelResponse,
  ToolResult,
} from "@finance-ai-news-agent/plugin-sdk";
import { describe, expect, it } from "vitest";

import { AgentGraphStateValueSchema } from "./agent-state.js";
import { InMemoryRuntimeStore } from "./in-memory-runtime-store.js";
import { createToolCallingResearchProvider } from "./tool-calling-research.js";

describe("tool-calling research", () => {
  it("lets the model choose tools while accepting evidence only from structured results", async () => {
    const model = new ReplayToolCallingModel([
      {
        text: "",
        model: "replay-model",
        finishReason: "tool-calls",
        usage: { inputTokens: 50, outputTokens: 10, totalTokens: 60 },
        toolCalls: [
          {
            id: "call-1",
            name: "search_news",
            arguments: { query: "AI infrastructure", limit: 5 },
          },
        ],
      },
      {
        text: "Evidence is sufficient.",
        model: "replay-model",
        finishReason: "stop",
        usage: { inputTokens: 70, outputTokens: 5, totalTokens: 75 },
        toolCalls: [],
      },
    ]);
    const gateway = new ReplayGateway({
      content: {
        items: [
          {
            id: "news-1",
            title: "AI infrastructure pricing update",
            url: "https://example.com/news/ai-infrastructure",
            excerpt: "The source reported a change in inference pricing.",
          },
        ],
      },
      isError: false,
    });
    const ledger = new InMemoryRuntimeStore();
    await prepareLedgerRun(ledger);
    const research = createToolCallingResearchProvider({
      model,
      gateway,
      modelCallLedger: ledger,
      maxModelRequests: 4,
      generateId: sequentialIds(),
      now: sequentialClock(),
    });

    const output = await research(initialState());

    expect(output.evidence).toEqual([
      expect.objectContaining({ id: "news-1", url: "https://example.com/news/ai-infrastructure" }),
    ]);
    expect(output.modelUsage).toEqual({
      requests: 2,
      inputTokens: 120,
      outputTokens: 15,
      totalTokens: 135,
    });
    expect(gateway.calls).toEqual([
      {
        id: "call-1",
        name: "search_news",
        arguments: { query: "AI infrastructure", limit: 5 },
      },
    ]);
    expect((await ledger.listModelCalls("research-run")).map((call) => call.status)).toEqual([
      "succeeded",
      "succeeded",
    ]);
  });

  it("rejects unsafe URLs returned by a tool", async () => {
    const model = new ReplayToolCallingModel([
      {
        text: "",
        model: "replay-model",
        finishReason: "tool-calls",
        toolCalls: [
          {
            id: "call-unsafe",
            name: "search_news",
            arguments: { query: "AI", limit: 1 },
          },
        ],
      },
    ]);
    const gateway = new ReplayGateway({
      content: {
        items: [
          {
            id: "unsafe-1",
            title: "Unsafe result",
            url: "javascript:alert(1)",
            excerpt: "This item must never enter agent state.",
          },
        ],
      },
      isError: false,
    });
    const research = createToolCallingResearchProvider({ model, gateway });

    await expect(research(initialState())).rejects.toThrow("Evidence URLs must be safe HTTP(S)");
  });
});

class ReplayToolCallingModel implements ToolCallingModelProvider {
  readonly manifest: PluginManifest = {
    id: "replay-tool-model",
    name: "Replay tool model",
    version: "1.0.0",
    kind: "model",
    coreCompatibility: ">=0.0.0",
  };

  constructor(private readonly responses: ToolCallingModelResponse[]) {}

  generate(): Promise<ModelResponse> {
    throw new Error("Plain generation is not used in research tests.");
  }

  async generateWithTools(request: ToolCallingModelRequest): Promise<ToolCallingModelResponse> {
    expect(request.tools.map((tool) => tool.name)).toEqual(["search_news"]);
    const response = this.responses.shift();

    if (response === undefined) {
      throw new Error("Replay tool response queue is empty.");
    }

    return response;
  }
}

class ReplayGateway implements McpGateway {
  readonly calls: ToolCallingModelResponse["toolCalls"] = [];

  constructor(private readonly result: ToolResult) {}

  async listTools() {
    return [
      {
        name: "search_news",
        description: "Search approved news sources.",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string" },
            limit: { type: "integer", minimum: 1, maximum: 10 },
          },
          required: ["query", "limit"],
          additionalProperties: false,
        },
      },
    ];
  }

  async callTool(call: ToolCallingModelResponse["toolCalls"][number]) {
    this.calls.push(call);
    return this.result;
  }
}

function initialState() {
  return AgentGraphStateValueSchema.parse({
    runId: "research-run",
    topic: "Finance & AI",
    maxRevisions: 1,
  });
}

async function prepareLedgerRun(ledger: InMemoryRuntimeStore): Promise<void> {
  await ledger.createOrGetRun({
    id: "research-run",
    tenantId: "test",
    reportDate: "2026-08-04",
    edition: "tool-research",
    topic: "Finance & AI",
    maxRevisions: 1,
    inputHash: "tool-research",
    configSnapshot: {},
    promptVersions: {},
    modelSnapshot: {},
    scheduledAt: null,
    createdAt: "2026-08-04T00:00:00.000Z",
  });
}

function sequentialIds(): () => string {
  let value = 0;
  return () => `model-call-${(value += 1)}`;
}

function sequentialClock(): () => Date {
  let value = Date.parse("2026-08-04T00:00:00.000Z");
  return () => new Date((value += 1_000));
}
