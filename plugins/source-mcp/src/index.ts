import { Client } from "@modelcontextprotocol/sdk/client/index.js";

export interface McpClientOptions {
  name?: string;
  version?: string;
}

export function createMcpClient(options: McpClientOptions = {}): Client {
  return new Client({
    name: options.name ?? "finance-ai-news-agent",
    version: options.version ?? "0.0.0",
  });
}
