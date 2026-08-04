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

export interface DeliveryContext {
  /** Stable key that output plugins should pass to providers supporting idempotency. */
  deliveryKey: string;
}

export interface OutputPlugin {
  readonly manifest: PluginManifest;
  /**
   * Repeating deliver with the same deliveryKey must produce one logical external delivery.
   */
  readonly deliverySemantics: "idempotent-by-key";
  deliver(artifact: RenderedArtifact, context: DeliveryContext): Promise<DeliveryReceipt>;
}

export {
  DeliveryStatusSchema,
  RunStageStatusSchema,
  RunStatusSchema,
  type ArtifactRecord,
  type CompleteDeliveryInput,
  type CompleteRunStageInput,
  type CreateRunInput,
  type CreateRunResult,
  type DeliveryRecord,
  type DeliveryStatus,
  type FailDeliveryInput,
  type FailRunStageInput,
  type FinishRunInput,
  type JsonObject,
  type JsonPrimitive,
  type JsonValue,
  type RunIdentity,
  type RunLock,
  type RunRecord,
  type RunStageRecord,
  type RunStageStatus,
  type RunStatus,
  type RuntimeStore,
  type SaveArtifactInput,
  type SerializedError,
  type SkipRunStageInput,
  type StartDeliveryInput,
  type StartDeliveryResult,
  type StartRunStageInput,
  type TerminalRunStatus,
} from "./runtime-store.js";
