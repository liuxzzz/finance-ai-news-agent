import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { StructuredModelOutputError } from "@finance-ai-news-agent/plugin-sdk";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createDeepSeekModelProvider } from "./index.js";

(globalThis as typeof globalThis & { AI_SDK_LOG_WARNINGS?: boolean }).AI_SDK_LOG_WARNINGS = false;

describe("DeepSeek AI SDK adapter", () => {
  it("refuses to send an API key over remote HTTP", () => {
    expect(() =>
      createDeepSeekModelProvider({
        apiKey: "test-secret",
        baseURL: "http://gateway.example.com/v1",
        model: "deepseek-v4-flash",
      }),
    ).toThrow("must use HTTPS");
  });

  it("uses the API root, bearer key, and DeepSeek JSON-object response format", async () => {
    const capture: CapturedRequest = {};
    const server = await startDeepSeekStub(capture, '{"status":"ok"}');

    try {
      const provider = createDeepSeekModelProvider({
        apiKey: "test-secret",
        baseURL: serverBaseUrl(server),
        model: "deepseek-v4-flash",
      });
      const response = await provider.generateStructured({
        role: "review",
        system: "Return JSON only.",
        prompt: "Review the fixture and return JSON.",
        schema: z.object({ status: z.literal("ok") }).strict(),
        schemaName: "test_schema",
        maxOutputTokens: 100,
        maxRetries: 0,
      });

      expect(response.value).toEqual({ status: "ok" });
      expect(response.usage).toEqual({
        inputTokens: 12,
        outputTokens: 4,
        totalTokens: 16,
      });
      expect(capture.path).toBe("/chat/completions");
      expect(capture.headers?.authorization).toBe("Bearer test-secret");
      expect(capture.body?.model).toBe("deepseek-v4-flash");
      expect(capture.body?.response_format).toEqual({ type: "json_object" });
      expect(capture.body?.thinking).toEqual({ type: "disabled" });
    } finally {
      await closeServer(server);
    }
  });

  it("maps invalid JSON into a retryable structured-output error", async () => {
    const server = await startDeepSeekStub({}, "not-json");

    try {
      const provider = createDeepSeekModelProvider({
        apiKey: "test-secret",
        baseURL: serverBaseUrl(server),
        model: "deepseek-v4-flash",
      });

      await expect(
        provider.generateStructured({
          role: "review",
          system: "Return JSON only.",
          prompt: "Return JSON.",
          schema: z.object({ status: z.literal("ok") }).strict(),
          schemaName: "test_schema",
          maxRetries: 0,
        }),
      ).rejects.toBeInstanceOf(StructuredModelOutputError);
    } finally {
      await closeServer(server);
    }
  });

  it("returns DeepSeek function calls without executing tools inside the provider", async () => {
    const capture: CapturedRequest = {};
    const server = await startDeepSeekStub(capture, {
      finishReason: "tool_calls",
      message: {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call-search-1",
            type: "function",
            function: {
              name: "search_news",
              arguments: JSON.stringify({ query: "AI infrastructure", limit: 5 }),
            },
          },
        ],
      },
    });

    try {
      const provider = createDeepSeekModelProvider({
        apiKey: "test-secret",
        baseURL: serverBaseUrl(server),
        model: "deepseek-v4-flash",
      });
      const response = await provider.generateWithTools({
        role: "research",
        system: "Use the allowed tools.",
        prompt: "Find relevant news.",
        tools: [
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
        ],
        toolChoice: "auto",
        maxRetries: 0,
      });

      expect(response.toolCalls).toEqual([
        {
          id: "call-search-1",
          name: "search_news",
          arguments: { query: "AI infrastructure", limit: 5 },
        },
      ]);
      expect(capture.body?.tools).toEqual([
        {
          type: "function",
          function: {
            name: "search_news",
            description: "Search approved news sources.",
            parameters: {
              type: "object",
              properties: {
                query: { type: "string" },
                limit: { type: "integer", minimum: 1, maximum: 10 },
              },
              required: ["query", "limit"],
              additionalProperties: false,
            },
          },
        },
      ]);
      expect(capture.body?.thinking).toEqual({ type: "disabled" });
    } finally {
      await closeServer(server);
    }
  });
});

interface CapturedRequest {
  path?: string;
  headers?: IncomingHttpHeaders;
  body?: Record<string, unknown>;
}

type StubCompletion =
  | string
  | {
      finishReason: string;
      message: Record<string, unknown>;
    };

async function startDeepSeekStub(
  capture: CapturedRequest,
  completion: StubCompletion,
): Promise<Server> {
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];

    for await (const chunk of request) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }

    capture.path = request.url;
    capture.headers = request.headers;
    capture.body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        id: "stub-response",
        object: "chat.completion",
        created: 1_785_801_600,
        model: "deepseek-v4-flash",
        choices: [
          {
            index: 0,
            message:
              typeof completion === "string"
                ? { role: "assistant", content: completion }
                : completion.message,
            finish_reason: typeof completion === "string" ? "stop" : completion.finishReason,
          },
        ],
        usage: {
          prompt_tokens: 12,
          completion_tokens: 4,
          total_tokens: 16,
          prompt_cache_hit_tokens: 0,
          prompt_cache_miss_tokens: 12,
        },
      }),
    );
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  return server;
}

function serverBaseUrl(server: Server): string {
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}
