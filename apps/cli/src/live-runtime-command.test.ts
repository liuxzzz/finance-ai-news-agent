import { describe, expect, it } from "vitest";

import { resolveLiveResearchConfig } from "./live-runtime-command.js";

describe("live MCP research configuration", () => {
  it("normalizes an HTTPS endpoint and unique allowlisted tools", () => {
    expect(
      resolveLiveResearchConfig({
        MCP_SERVER_URL: "https://mcp.example.com/mcp",
        MCP_ALLOWED_TOOLS: "search_news,fetch_article",
        MCP_BEARER_TOKEN: " local-token ",
        MCP_MAX_TOOL_CALLS: "6",
      }),
    ).toEqual({
      serverUrl: "https://mcp.example.com/mcp",
      allowedTools: ["search_news", "fetch_article"],
      bearerToken: "local-token",
      maxToolCalls: 6,
    });
  });

  it("rejects unsafe endpoints, duplicate tools, and invalid budgets", () => {
    expect(() =>
      resolveLiveResearchConfig({
        MCP_SERVER_URL: "http://mcp.example.com/mcp",
        MCP_ALLOWED_TOOLS: "search_news",
      }),
    ).toThrow("must use HTTPS");

    expect(() =>
      resolveLiveResearchConfig({
        MCP_SERVER_URL: "https://mcp.example.com/mcp",
        MCP_ALLOWED_TOOLS: "search_news,search_news",
      }),
    ).toThrow("unique comma-separated");

    expect(() =>
      resolveLiveResearchConfig({
        MCP_SERVER_URL: "https://mcp.example.com/mcp",
        MCP_ALLOWED_TOOLS: "search_news",
        MCP_MAX_TOOL_CALLS: "0",
      }),
    ).toThrow("integer from 1 to 16");
  });
});
