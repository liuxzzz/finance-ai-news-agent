import { describe, expect, it, vi } from "vitest";

import {
  createLazyStreamableHttpMcpGateway,
  McpClientGateway,
  type McpClientOperations,
  validateMcpServerUrl,
} from "./index.js";

describe("MCP client gateway", () => {
  it("exposes only allowlisted tools and validates arguments before execution", async () => {
    const listTools = vi.fn(async () => ({
      tools: [
        {
          name: "search_news",
          description: "Search approved news sources.",
          inputSchema: {
            type: "object" as const,
            properties: {
              query: { type: "string", minLength: 1 },
              limit: { type: "integer", minimum: 1, maximum: 10 },
            },
            required: ["query", "limit"],
            additionalProperties: false,
          },
        },
        {
          name: "delete_everything",
          inputSchema: { type: "object" as const, properties: {} },
        },
      ],
    }));
    const callTool = vi.fn(async () => ({
      content: [{ type: "text" as const, text: "fallback" }],
      structuredContent: {
        items: [{ title: "AI infrastructure update", url: "https://example.com/news/1" }],
      },
      isError: false,
    }));
    const gateway = new McpClientGateway(
      { listTools, callTool } as unknown as McpClientOperations,
      {
        allowedTools: ["search_news"],
        timeoutMs: 2_000,
      },
    );

    await expect(gateway.listTools()).resolves.toEqual([
      expect.objectContaining({ name: "search_news" }),
    ]);
    await expect(
      gateway.callTool({
        id: "invalid-call",
        name: "search_news",
        arguments: { query: "AI", limit: 99 },
      }),
    ).rejects.toThrow("Invalid arguments");
    expect(callTool).not.toHaveBeenCalled();

    await expect(
      gateway.callTool({
        id: "valid-call",
        name: "search_news",
        arguments: { query: "AI", limit: 5 },
      }),
    ).resolves.toEqual({
      content: {
        items: [{ title: "AI infrastructure update", url: "https://example.com/news/1" }],
      },
      isError: false,
    });
    expect(callTool).toHaveBeenCalledWith(
      { name: "search_news", arguments: { query: "AI", limit: 5 } },
      undefined,
      { timeout: 2_000, maxTotalTimeout: 2_000 },
    );
  });

  it("rejects non-allowlisted calls and oversized results", async () => {
    const listTools = vi.fn(async () => ({
      tools: [
        {
          name: "search_news",
          inputSchema: {
            type: "object" as const,
            properties: { query: { type: "string" } },
            required: ["query"],
            additionalProperties: false,
          },
        },
      ],
    }));
    const callTool = vi.fn(async () => ({
      content: [{ type: "text" as const, text: "x".repeat(1_000) }],
      isError: false,
    }));
    const gateway = new McpClientGateway(
      { listTools, callTool } as unknown as McpClientOperations,
      {
        allowedTools: ["search_news"],
        maxResultBytes: 100,
      },
    );

    await expect(
      gateway.callTool({ id: "denied", name: "unknown_tool", arguments: {} }),
    ).rejects.toThrow("not allowed");
    await expect(
      gateway.callTool({
        id: "too-large",
        name: "search_news",
        arguments: { query: "AI" },
      }),
    ).rejects.toThrow("more than 100 bytes");
  });

  it("allows loopback HTTP but rejects remote plaintext and URL credentials", () => {
    expect(validateMcpServerUrl("http://127.0.0.1:3000/mcp").toString()).toBe(
      "http://127.0.0.1:3000/mcp",
    );
    expect(() => validateMcpServerUrl("http://mcp.example.com/mcp")).toThrow("must use HTTPS");
    expect(() => validateMcpServerUrl("https://user:secret@mcp.example.com/mcp")).toThrow(
      "must not contain credentials",
    );
  });

  it("does not connect a lazy HTTP gateway until a tool is actually needed", async () => {
    const lazy = createLazyStreamableHttpMcpGateway({
      serverUrl: "https://unreachable.example.com/mcp",
      allowedTools: ["search_news"],
    });

    await expect(lazy.close()).resolves.toBeUndefined();
  });

  it("refuses tools explicitly marked destructive", async () => {
    const client = {
      listTools: vi.fn(async () => ({
        tools: [
          {
            name: "dangerous_search",
            inputSchema: { type: "object" as const, properties: {} },
            annotations: { destructiveHint: true },
          },
        ],
      })),
      callTool: vi.fn(),
    } as unknown as McpClientOperations;
    const gateway = new McpClientGateway(client, {
      allowedTools: ["dangerous_search"],
    });

    await expect(gateway.listTools()).rejects.toThrow("marked destructive");
  });
});
