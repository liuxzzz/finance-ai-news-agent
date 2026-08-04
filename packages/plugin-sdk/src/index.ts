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
  temperature?: number;
  timeoutMs?: number;
  maxRetries?: number;
}

export interface ModelResponse {
  text: string;
  model: string;
  finishReason?: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
}

export interface ModelProvider {
  readonly manifest: PluginManifest;
  generate(request: ModelRequest): Promise<ModelResponse>;
}

export interface StructuredModelRequest<OUTPUT> extends ModelRequest {
  schema: z.ZodType<OUTPUT>;
  schemaName: string;
  schemaDescription?: string;
}

export interface StructuredModelResponse<OUTPUT> {
  value: OUTPUT;
  model: string;
  finishReason: string;
  usage?: ModelResponse["usage"];
}

/** Optional extension for providers that support schema-constrained JSON output. */
export interface StructuredModelProvider extends ModelProvider {
  generateStructured<OUTPUT>(
    request: StructuredModelRequest<OUTPUT>,
  ): Promise<StructuredModelResponse<OUTPUT>>;
}

/** Indicates that a provider returned empty, truncated, or schema-invalid structured output. */
export class StructuredModelOutputError extends Error {
  override readonly name = "StructuredModelOutputError";

  readonly usage: ModelResponse["usage"] | undefined;

  constructor(message: string, options: { cause?: unknown; usage?: ModelResponse["usage"] } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.usage = options.usage;
  }
}

export interface ToolDescriptor {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolResult {
  content: unknown;
  isError: boolean;
}

export interface ToolExecutionContext {
  runId?: string;
}

/** Framework-neutral boundary for tools the model may choose but never executes itself. */
export interface ToolGateway {
  listTools(): Promise<ToolDescriptor[]>;
  callTool(call: ToolCall, context?: ToolExecutionContext): Promise<ToolResult>;
}

/** @deprecated Use ToolGateway. Kept for optional MCP adapter compatibility. */
export type McpGateway = ToolGateway;

export {
  SourceRunStatusSchema,
  type RawSourceItemInput,
  type RawSourceItemRecord,
  type RecordSourceCollectionInput,
  type SourceAuditStore,
  type SourceRunRecord,
  type SourceRunStatus,
} from "./source-store.js";

export {
  type ContentStore,
  type FindPreviouslySeenContentInput,
  type NormalizedContentItemInput,
  type NormalizedContentItemRecord,
  type PreviouslySeenContentRecord,
} from "./content-store.js";

export interface ToolCallingModelRequest extends ModelRequest {
  tools: ToolDescriptor[];
  toolChoice?: "auto" | "required" | "none";
}

export interface ToolCallingModelResponse extends ModelResponse {
  toolCalls: ToolCall[];
}

/** Optional model extension that returns tool intents without executing them. */
export interface ToolCallingModelProvider extends ModelProvider {
  generateWithTools(request: ToolCallingModelRequest): Promise<ToolCallingModelResponse>;
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
  type CompleteModelCallInput,
  type CompleteRunStageInput,
  type CreateRunInput,
  type CreateRunResult,
  type DeliveryRecord,
  type DeliveryStatus,
  type FailDeliveryInput,
  type FailModelCallInput,
  type FailRunStageInput,
  type FinishRunInput,
  type JsonObject,
  type JsonPrimitive,
  type JsonValue,
  type ModelCallRecord,
  type ModelCallStatus,
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
  type StartModelCallInput,
  type StartModelCallResult,
  type StartRunStageInput,
  type TerminalRunStatus,
  ModelCallStatusSchema,
} from "./runtime-store.js";
