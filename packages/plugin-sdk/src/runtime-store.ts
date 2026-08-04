import { z } from "zod";

export type JsonPrimitive = boolean | number | string | null;

export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type JsonObject = { [key: string]: JsonValue };

export const RunStatusSchema = z.enum([
  "pending",
  "running",
  "succeeded",
  "partial",
  "rejected",
  "failed",
]);

export type RunStatus = z.infer<typeof RunStatusSchema>;

export type TerminalRunStatus = Exclude<RunStatus, "pending" | "running">;

export const RunStageStatusSchema = z.enum([
  "pending",
  "running",
  "succeeded",
  "failed",
  "skipped",
]);

export type RunStageStatus = z.infer<typeof RunStageStatusSchema>;

export const DeliveryStatusSchema = z.enum(["running", "succeeded", "failed"]);

export type DeliveryStatus = z.infer<typeof DeliveryStatusSchema>;

export interface SerializedError {
  name: string;
  message: string;
  stack?: string;
}

export interface RunIdentity {
  tenantId: string;
  reportDate: string;
  edition: string;
}

export interface CreateRunInput extends RunIdentity {
  id: string;
  topic: string;
  maxRevisions: number;
  inputHash: string;
  configSnapshot: JsonObject;
  promptVersions: JsonObject;
  modelSnapshot: JsonObject;
  scheduledAt: string | null;
  createdAt: string;
}

export interface RunRecord extends CreateRunInput {
  status: RunStatus;
  attemptCount: number;
  startedAt: string | null;
  finishedAt: string | null;
  error: SerializedError | null;
  updatedAt: string;
}

export interface CreateRunResult {
  run: RunRecord;
  created: boolean;
}

export interface RunStageRecord {
  id: string;
  runId: string;
  stage: string;
  attempt: number;
  status: RunStageStatus;
  inputHash: string;
  output: JsonValue | null;
  outputRefs: JsonObject;
  error: SerializedError | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
}

export interface StartRunStageInput {
  runId: string;
  stage: string;
  inputHash: string;
  startedAt: string;
}

export interface CompleteRunStageInput {
  stageId: string;
  output: JsonValue;
  outputRefs: JsonObject;
  finishedAt: string;
}

export interface FailRunStageInput {
  stageId: string;
  error: SerializedError;
  finishedAt: string;
}

export interface SkipRunStageInput {
  stageId: string;
  output: JsonValue;
  finishedAt: string;
}

export interface FinishRunInput {
  runId: string;
  status: TerminalRunStatus;
  error: SerializedError | null;
  finishedAt: string;
}

export interface ArtifactRecord {
  id: string;
  runId: string;
  kind: string;
  mediaType: string;
  content: string;
  contentHash: string;
  createdAt: string;
}

export type SaveArtifactInput = ArtifactRecord;

export interface DeliveryRecord {
  id: string;
  runId: string;
  artifactId: string;
  deliveryKey: string;
  pluginId: string;
  target: string;
  status: DeliveryStatus;
  attempt: number;
  receipt: JsonValue | null;
  error: SerializedError | null;
  startedAt: string;
  finishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface StartDeliveryInput {
  id: string;
  runId: string;
  artifactId: string;
  deliveryKey: string;
  pluginId: string;
  target: string;
  startedAt: string;
}

export interface StartDeliveryResult {
  delivery: DeliveryRecord;
  shouldDeliver: boolean;
}

export interface CompleteDeliveryInput {
  deliveryId: string;
  receipt: JsonValue;
  finishedAt: string;
}

export interface FailDeliveryInput {
  deliveryId: string;
  error: SerializedError;
  finishedAt: string;
}

export interface RunLock {
  release(): Promise<void>;
}

/**
 * Framework-neutral persistence boundary used by the deterministic runtime.
 * Implementations must make createOrGetRun and startDelivery idempotent.
 */
export interface RuntimeStore {
  createOrGetRun(input: CreateRunInput): Promise<CreateRunResult>;
  getRun(runId: string): Promise<RunRecord | null>;
  findRun(identity: RunIdentity): Promise<RunRecord | null>;
  markRunRunning(runId: string, startedAt: string): Promise<RunRecord>;
  finishRun(input: FinishRunInput): Promise<RunRecord>;
  tryAcquireRunLock(runId: string): Promise<RunLock | null>;

  getLatestStage(runId: string, stage: string): Promise<RunStageRecord | null>;
  listStages(runId: string): Promise<RunStageRecord[]>;
  startStage(input: StartRunStageInput): Promise<RunStageRecord>;
  completeStage(input: CompleteRunStageInput): Promise<RunStageRecord>;
  failStage(input: FailRunStageInput): Promise<RunStageRecord>;
  skipStage(input: SkipRunStageInput): Promise<RunStageRecord>;

  saveArtifact(input: SaveArtifactInput): Promise<ArtifactRecord>;
  getArtifactForRun(runId: string, kind: string): Promise<ArtifactRecord | null>;

  startDelivery(input: StartDeliveryInput): Promise<StartDeliveryResult>;
  getDeliveryByKey(deliveryKey: string): Promise<DeliveryRecord | null>;
  listDeliveries(runId: string): Promise<DeliveryRecord[]>;
  completeDelivery(input: CompleteDeliveryInput): Promise<DeliveryRecord>;
  failDelivery(input: FailDeliveryInput): Promise<DeliveryRecord>;
}
