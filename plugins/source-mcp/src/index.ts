import type {
  ToolCall,
  ToolDescriptor,
  ToolGateway,
  ToolResult,
} from "@finance-ai-news-agent/plugin-sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Ajv, type ValidateFunction } from "ajv";

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

export interface McpClientGatewayOptions {
  /** MCP tools are deny-by-default and must be explicitly allowed. */
  allowedTools: readonly string[];
  timeoutMs?: number;
  maxResultBytes?: number;
  maxListPages?: number;
}

export type McpClientOperations = Pick<Client, "listTools" | "callTool">;

interface CachedTool {
  descriptor: ToolDescriptor;
  validate: ValidateFunction;
}

/**
 * Security boundary around an already connected MCP client.
 * It never exposes tools outside the allowlist and validates arguments locally
 * before a remote MCP server can observe them.
 */
export class McpClientGateway implements ToolGateway {
  private readonly allowedTools: ReadonlySet<string>;
  private readonly timeoutMs: number;
  private readonly maxResultBytes: number;
  private readonly maxListPages: number;
  private readonly ajv = new Ajv({ allErrors: true, strict: false });
  private cachedTools: Map<string, CachedTool> | null = null;

  constructor(
    private readonly client: McpClientOperations,
    options: McpClientGatewayOptions,
  ) {
    this.allowedTools = new Set(options.allowedTools);
    this.timeoutMs = positiveInteger(options.timeoutMs ?? 15_000, "timeoutMs");
    this.maxResultBytes = positiveInteger(options.maxResultBytes ?? 1_000_000, "maxResultBytes");
    this.maxListPages = positiveInteger(options.maxListPages ?? 10, "maxListPages");
  }

  async listTools(): Promise<ToolDescriptor[]> {
    const cached = await this.loadTools();
    return [...cached.values()].map(({ descriptor }) => structuredClone(descriptor));
  }

  async callTool(call: ToolCall): Promise<ToolResult> {
    const cached = await this.loadTools();
    const tool = cached.get(call.name);

    if (tool === undefined) {
      throw new Error(`MCP tool ${call.name} is not allowed or was not advertised by the server.`);
    }

    if (!tool.validate(call.arguments)) {
      const issues = tool.validate.errors?.map((error) => error.instancePath || "/").join(", ");
      throw new Error(
        `Invalid arguments for MCP tool ${call.name}${issues ? ` at ${issues}` : ""}.`,
      );
    }

    const result = await this.client.callTool(
      { name: call.name, arguments: call.arguments },
      undefined,
      { timeout: this.timeoutMs, maxTotalTimeout: this.timeoutMs },
    );
    const content = result.structuredContent ?? result.content;
    const encoded = JSON.stringify(content);

    if (Buffer.byteLength(encoded, "utf8") > this.maxResultBytes) {
      throw new Error(`MCP tool ${call.name} returned more than ${this.maxResultBytes} bytes.`);
    }

    return {
      content,
      isError: result.isError === true,
    };
  }

  clearToolCache(): void {
    this.cachedTools = null;
  }

  private async loadTools(): Promise<Map<string, CachedTool>> {
    if (this.cachedTools !== null) {
      return this.cachedTools;
    }

    const cached = new Map<string, CachedTool>();
    let cursor: string | undefined;

    for (let page = 1; page <= this.maxListPages; page += 1) {
      const result = await this.client.listTools(cursor === undefined ? {} : { cursor }, {
        timeout: this.timeoutMs,
        maxTotalTimeout: this.timeoutMs,
      });

      for (const tool of result.tools) {
        if (!this.allowedTools.has(tool.name)) {
          continue;
        }

        if (tool.annotations?.destructiveHint === true) {
          throw new Error(`MCP tool ${tool.name} is marked destructive and cannot be exposed.`);
        }

        if (cached.has(tool.name)) {
          throw new Error(`MCP server advertised duplicate tool ${tool.name}.`);
        }

        const descriptor: ToolDescriptor = {
          name: tool.name,
          ...(tool.description === undefined ? {} : { description: tool.description }),
          inputSchema: tool.inputSchema,
        };
        cached.set(tool.name, {
          descriptor,
          validate: this.ajv.compile(tool.inputSchema),
        });
      }

      cursor = result.nextCursor;

      if (cursor === undefined) {
        this.cachedTools = cached;
        return cached;
      }
    }

    throw new Error(`MCP tool listing exceeded ${this.maxListPages} pages.`);
  }
}

export interface ConnectStreamableHttpMcpGatewayOptions extends McpClientGatewayOptions {
  serverUrl: string;
  bearerToken?: string;
  clientName?: string;
  clientVersion?: string;
}

export interface ConnectedMcpGateway {
  gateway: ToolGateway;
  close(): Promise<void>;
}

export function createLazyStreamableHttpMcpGateway(
  options: ConnectStreamableHttpMcpGatewayOptions,
): ConnectedMcpGateway {
  let connection: Promise<ConnectedMcpGateway> | undefined;
  const connected = () => {
    connection ??= connectStreamableHttpMcpGateway(options);
    return connection;
  };

  return {
    gateway: {
      listTools: async () => (await connected()).gateway.listTools(),
      callTool: async (call) => (await connected()).gateway.callTool(call),
    },
    close: async () => {
      if (connection === undefined) {
        return;
      }

      const active = await connection.catch(() => null);
      await active?.close();
    },
  };
}

export async function connectStreamableHttpMcpGateway(
  options: ConnectStreamableHttpMcpGatewayOptions,
): Promise<ConnectedMcpGateway> {
  const serverUrl = validateMcpServerUrl(options.serverUrl);
  const token = options.bearerToken?.trim();
  const client = createMcpClient({
    ...(options.clientName === undefined ? {} : { name: options.clientName }),
    ...(options.clientVersion === undefined ? {} : { version: options.clientVersion }),
  });
  const transport = new StreamableHTTPClientTransport(serverUrl, {
    ...(token === undefined || token.length === 0
      ? {}
      : { requestInit: { headers: { authorization: `Bearer ${token}` } } }),
  });

  // SDK 1.30 exposes an exact-optional mismatch between its concrete transport
  // and base Transport declarations; the runtime implementation is compatible.
  await client.connect(transport as Parameters<Client["connect"]>[0]);

  return {
    gateway: new McpClientGateway(client, options),
    close: async () => client.close(),
  };
}

export function validateMcpServerUrl(value: string): URL {
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    throw new Error("MCP server URL must be a valid HTTP(S) URL.");
  }

  const loopback =
    url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";

  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("MCP server URL must use HTTPS except for local loopback development.");
  }

  if (
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.search.length > 0 ||
    url.hash.length > 0
  ) {
    throw new Error("MCP server URL must not contain credentials, query parameters, or fragments.");
  }

  return url;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }

  return value;
}
