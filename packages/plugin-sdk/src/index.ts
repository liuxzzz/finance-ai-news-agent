import { z } from "zod";

export const PluginKindSchema = z.enum(["model", "embedding", "source", "storage", "output"]);

export type PluginKind = z.infer<typeof PluginKindSchema>;

export const PluginManifestSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  version: z.string().min(1),
  kind: PluginKindSchema,
  coreCompatibility: z.string().min(1),
});

export type PluginManifest = z.infer<typeof PluginManifestSchema>;

export interface ModelRequest {
  role: string;
  system: string;
  prompt: string;
  maxOutputTokens?: number;
}

export interface ModelResponse {
  text: string;
  model: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
  };
}

export interface ModelProvider {
  readonly manifest: PluginManifest;
  generate(request: ModelRequest): Promise<ModelResponse>;
}

export interface ToolDescriptor {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolResult {
  content: unknown;
  isError: boolean;
}

export interface McpGateway {
  listTools(): Promise<ToolDescriptor[]>;
  callTool(call: ToolCall): Promise<ToolResult>;
}

export interface MemoryRecord {
  id: string;
  type: string;
  content: string;
  sourceRefs: string[];
  confidence: number;
}

export interface MemoryPort {
  search(query: string, limit: number): Promise<MemoryRecord[]>;
  propose(records: MemoryRecord[]): Promise<void>;
}

export interface RenderedArtifact {
  id: string;
  mediaType: string;
  content: string;
}

export interface DeliveryReceipt {
  deliveryId: string;
  target: string;
  deliveredAt: string;
}

export interface OutputPlugin {
  readonly manifest: PluginManifest;
  deliver(artifact: RenderedArtifact): Promise<DeliveryReceipt>;
}
